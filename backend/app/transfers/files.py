from __future__ import annotations

import ntpath
import os
import posixpath
import queue
import stat
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from typing import Callable, Iterator

import smbclient

from app.database.models import Device
from app.devices.service import connect_ssh_device
from app.files.sftp import normalize_path
from app.files.smb import delete_smb_tree, register_smb_device, smb_unc_path
from app.transfers.sftp import ensure_directory, remove_tree


def _positive_int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        return default
    return min(max(value, minimum), maximum)


def _bool_env(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


TRANSFER_CHUNK_SIZE = _positive_int_env("TRANSFER_CHUNK_SIZE", 64 * 1024 * 1024, 1024 * 1024, 256 * 1024 * 1024)
TRANSFER_PREFETCH_CHUNKS = _positive_int_env("TRANSFER_PREFETCH_CHUNKS", 16, 1, 16)
TRANSFER_PARALLEL_FILES = _positive_int_env("TRANSFER_PARALLEL_FILES", 2, 1, 16)
TRANSFER_SMB_PARALLEL_FILES = _positive_int_env("TRANSFER_SMB_PARALLEL_FILES", 2, 1, 4)
TRANSFER_FILE_STREAMS = _positive_int_env("TRANSFER_FILE_STREAMS", 16, 1, 16)
TRANSFER_SMB_FILE_STREAMS = _positive_int_env("TRANSFER_SMB_FILE_STREAMS", 1, 1, 16)
TRANSFER_FILE_STREAM_MIN_SIZE = _positive_int_env("TRANSFER_FILE_STREAM_MIN_SIZE", 1024 * 1024 * 1024, 64 * 1024 * 1024, 1024 * 1024 * 1024 * 1024)
TRANSFER_RESUME_BLOCK_SIZE = _positive_int_env("TRANSFER_RESUME_BLOCK_SIZE", 512 * 1024 * 1024, 16 * 1024 * 1024, 8 * 1024 * 1024 * 1024)
TRANSFER_RESUME_REWIND_BYTES = _positive_int_env("TRANSFER_RESUME_REWIND_BYTES", 256 * 1024 * 1024, 0, 2 * 1024 * 1024 * 1024)
TRANSFER_RESUME_REWRITE_FULL = _bool_env("TRANSFER_RESUME_REWRITE_FULL", False)
_QUEUE_DONE = object()
TransferEventCallback = Callable[[str, str, str | None, str | None, dict | None], None]


@dataclass(frozen=True)
class TransferProfile:
    chunk_size: int
    prefetch_chunks: int
    parallel_files: int
    file_streams: int


def transfer_profile_settings(profile: str | None) -> TransferProfile:
    if profile == "safe":
        return TransferProfile(
            chunk_size=min(TRANSFER_CHUNK_SIZE, 8 * 1024 * 1024),
            prefetch_chunks=min(TRANSFER_PREFETCH_CHUNKS, 2),
            parallel_files=1,
            file_streams=1,
        )
    if profile == "balanced":
        return TransferProfile(
            chunk_size=min(TRANSFER_CHUNK_SIZE, 16 * 1024 * 1024),
            prefetch_chunks=min(TRANSFER_PREFETCH_CHUNKS, 4),
            parallel_files=1,
            file_streams=min(TRANSFER_FILE_STREAMS, 4),
        )
    return TransferProfile(
        chunk_size=TRANSFER_CHUNK_SIZE,
        prefetch_chunks=TRANSFER_PREFETCH_CHUNKS,
        parallel_files=TRANSFER_PARALLEL_FILES,
        file_streams=TRANSFER_FILE_STREAMS,
    )


@dataclass
class FileMeta:
    mode: int | None = None
    atime: float | None = None
    mtime: float | None = None
    size: int | None = None


class TransferCancelled(Exception):
    pass


def _file_streams_for_devices(source_device: Device, destination_device: Device, profile: TransferProfile) -> int:
    if source_device.connection_type == "smb" or destination_device.connection_type == "smb":
        return min(profile.file_streams, TRANSFER_SMB_FILE_STREAMS)
    return profile.file_streams


def _uses_smb(source_device: Device, destination_device: Device) -> bool:
    return source_device.connection_type == "smb" or destination_device.connection_type == "smb"


def _same_timestamp(left: float | None, right: float | None) -> bool:
    if left is None or right is None:
        return False
    return abs(float(left) - float(right)) <= 2.0


class TransferStore:
    def __init__(self, device: Device, profile: TransferProfile | None = None):
        self.device = device
        self.profile = profile or transfer_profile_settings("turbo")
        self.ssh_client = None
        self.sftp = None
        self.smb_connection_cache = None
        if device.connection_type == "ssh_sftp":
            self.ssh_client = connect_ssh_device(device)
            self.sftp = self.ssh_client.open_sftp()
        elif device.connection_type == "smb":
            self.smb_connection_cache = {}
            register_smb_device(device, connection_cache=self.smb_connection_cache)
        else:
            raise ValueError(f"{device.connection_type.upper()} file transfers are not available yet.")

    def close(self) -> None:
        if self.smb_connection_cache is not None:
            try:
                smbclient.reset_connection_cache(fail_on_error=False, connection_cache=self.smb_connection_cache)
            finally:
                self.smb_connection_cache = None
        if self.sftp:
            self.sftp.close()
            self.sftp = None
        if self.ssh_client:
            self.ssh_client.close()
            self.ssh_client = None

    def normalize(self, path: str | None) -> str:
        if self.device.connection_type == "smb":
            if not path or path in (".", "/", "\\"):
                return "."
            return path.strip("\\/").replace("\\", "/")
        return normalize_path(path)

    def basename(self, path: str) -> str:
        cleaned = self.normalize(path).rstrip("/\\")
        if self.device.connection_type == "smb":
            return ntpath.basename(cleaned.replace("/", "\\"))
        return posixpath.basename(cleaned)

    def join(self, base: str, name: str) -> str:
        base = self.normalize(base)
        if base in ("", "."):
            return name
        return f"{base.rstrip('/')}/{name}"

    def stat(self, path: str):
        safe_path = self.normalize(path)
        if self.device.connection_type == "smb":
            return smbclient.stat(smb_unc_path(self.device, safe_path), connection_cache=self.smb_connection_cache)
        return self.sftp.stat(safe_path)

    def is_dir(self, path: str) -> bool:
        safe_path = self.normalize(path)
        if self.device.connection_type == "smb":
            return smbclient.path.isdir(smb_unc_path(self.device, safe_path), connection_cache=self.smb_connection_cache)
        return stat.S_ISDIR(self.sftp.stat(safe_path).st_mode)

    def exists(self, path: str) -> bool:
        safe_path = self.normalize(path)
        try:
            if self.device.connection_type == "smb":
                return smbclient.path.exists(smb_unc_path(self.device, safe_path), connection_cache=self.smb_connection_cache)
            self.sftp.stat(safe_path)
            return True
        except OSError:
            return False

    def children(self, path: str) -> list[tuple[str, str]]:
        safe_path = self.normalize(path)
        if self.device.connection_type == "smb":
            children = []
            for entry in smbclient.scandir(smb_unc_path(self.device, safe_path), connection_cache=self.smb_connection_cache):
                children.append((entry.name, self.join(safe_path, entry.name)))
            return children
        return [(attr.filename, self.join(safe_path, attr.filename)) for attr in self.sftp.listdir_attr(safe_path)]

    def meta(self, path: str) -> FileMeta:
        try:
            attrs = self.stat(path)
        except OSError:
            return FileMeta()
        return FileMeta(
            mode=getattr(attrs, "st_mode", None),
            atime=getattr(attrs, "st_atime", None),
            mtime=getattr(attrs, "st_mtime", None),
            size=int(getattr(attrs, "st_size", 0) or 0),
        )

    def prepare_file(self, path: str) -> None:
        safe_path = self.normalize(path)
        self.ensure_dir(posixpath.dirname(safe_path))
        if self.device.connection_type == "smb":
            with smbclient.open_file(smb_unc_path(self.device, safe_path), mode="wb", share_access="rwd", connection_cache=self.smb_connection_cache):
                return
        with self.sftp.open(safe_path, "wb"):
            return

    def truncate_file(self, path: str, size: int) -> None:
        safe_path = self.normalize(path)
        self.ensure_dir(posixpath.dirname(safe_path))
        if self.device.connection_type == "smb":
            with smbclient.open_file(smb_unc_path(self.device, safe_path), mode="r+b", share_access="rwd", connection_cache=self.smb_connection_cache) as destination_file:
                destination_file.truncate(size)
            return
        self.sftp.truncate(safe_path, size)

    def ensure_dir(self, path: str) -> None:
        safe_path = self.normalize(path)
        if safe_path in ("", "."):
            return
        if self.device.connection_type == "smb":
            target = smb_unc_path(self.device, safe_path)
            if not smbclient.path.exists(target, connection_cache=self.smb_connection_cache):
                smbclient.makedirs(target, exist_ok=True, connection_cache=self.smb_connection_cache)
            return
        ensure_directory(self.sftp, safe_path)

    def _read_chunks_direct(self, safe_path: str) -> Iterator[bytes]:
        if self.device.connection_type == "smb":
            with smbclient.open_file(smb_unc_path(self.device, safe_path), mode="rb", share_access="rwd", connection_cache=self.smb_connection_cache) as source_file:
                while True:
                    chunk = source_file.read(self.profile.chunk_size)
                    if not chunk:
                        break
                    yield chunk
            return
        with self.sftp.open(safe_path, "rb") as source_file:
            while True:
                chunk = source_file.read(self.profile.chunk_size)
                if not chunk:
                    break
                yield chunk

    def read_chunks(self, path: str, should_cancel: Callable[[], bool] | None = None) -> Iterator[bytes]:
        safe_path = self.normalize(path)
        stop_event = threading.Event()
        chunk_queue: queue.Queue[bytes | object | BaseException] = queue.Queue(maxsize=max(1, self.profile.prefetch_chunks))

        def put_queue(item: bytes | object | BaseException) -> bool:
            while not stop_event.is_set():
                try:
                    chunk_queue.put(item, timeout=0.2)
                    return True
                except queue.Full:
                    continue
            return False

        def producer() -> None:
            try:
                for chunk in self._read_chunks_direct(safe_path):
                    if stop_event.is_set() or (should_cancel and should_cancel()):
                        break
                    if not put_queue(chunk):
                        break
            except BaseException as exc:
                put_queue(exc)
            finally:
                put_queue(_QUEUE_DONE)

        threading.Thread(target=producer, daemon=True).start()

        try:
            while True:
                if should_cancel and should_cancel():
                    raise TransferCancelled("Transfer cancelled.")
                try:
                    item = chunk_queue.get(timeout=0.2)
                except queue.Empty:
                    continue
                if item is _QUEUE_DONE:
                    break
                if isinstance(item, BaseException):
                    raise item
                yield item
        finally:
            stop_event.set()

    def _read_range_direct(self, safe_path: str, offset: int, length: int, should_cancel: Callable[[], bool] | None = None) -> Iterator[bytes]:
        remaining = length
        if self.device.connection_type == "smb":
            with smbclient.open_file(smb_unc_path(self.device, safe_path), mode="rb", share_access="rwd", connection_cache=self.smb_connection_cache) as source_file:
                source_file.seek(offset)
                while remaining > 0:
                    if should_cancel and should_cancel():
                        raise TransferCancelled("Transfer cancelled.")
                    chunk = source_file.read(min(self.profile.chunk_size, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    yield chunk
            return
        with self.sftp.open(safe_path, "rb") as source_file:
            source_file.seek(offset)
            while remaining > 0:
                if should_cancel and should_cancel():
                    raise TransferCancelled("Transfer cancelled.")
                chunk = source_file.read(min(self.profile.chunk_size, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    def read_range(self, path: str, offset: int, length: int, should_cancel: Callable[[], bool] | None = None) -> Iterator[bytes]:
        safe_path = self.normalize(path)
        yield from self._read_range_direct(safe_path, offset, length, should_cancel)

    def write_range(
        self,
        path: str,
        offset: int,
        chunks: Iterator[bytes],
        progress: Callable[[int], None] | None = None,
        should_cancel: Callable[[], bool] | None = None,
    ) -> None:
        safe_path = self.normalize(path)
        if self.device.connection_type == "smb":
            with smbclient.open_file(smb_unc_path(self.device, safe_path), mode="r+b", share_access="rwd", connection_cache=self.smb_connection_cache) as destination_file:
                destination_file.seek(offset)
                for chunk in chunks:
                    if should_cancel and should_cancel():
                        raise TransferCancelled("Transfer cancelled.")
                    destination_file.write(chunk)
                    if progress:
                        progress(len(chunk))
            return
        with self.sftp.open(safe_path, "r+b") as destination_file:
            destination_file.seek(offset)
            for chunk in chunks:
                if should_cancel and should_cancel():
                    raise TransferCancelled("Transfer cancelled.")
                destination_file.write(chunk)
                if progress:
                    progress(len(chunk))

    def total_size(self, path: str) -> tuple[int, int]:
        safe_path = self.normalize(path)
        if self.is_dir(safe_path):
            total_bytes = 0
            total_files = 0
            for _, child_path in self.children(safe_path):
                child_bytes, child_files = self.total_size(child_path)
                total_bytes += child_bytes
                total_files += child_files
            return total_bytes, total_files
        size = getattr(self.stat(safe_path), "st_size", 0) or 0
        return int(size), 1

    def write_file(
        self,
        path: str,
        chunks: Iterator[bytes],
        source_meta: FileMeta,
        progress: Callable[[int], None] | None = None,
        should_cancel: Callable[[], bool] | None = None,
    ) -> None:
        safe_path = self.normalize(path)
        self.ensure_dir(posixpath.dirname(safe_path))
        if self.device.connection_type == "smb":
            with smbclient.open_file(smb_unc_path(self.device, safe_path), mode="wb", share_access="rwd", connection_cache=self.smb_connection_cache) as destination_file:
                for chunk in chunks:
                    if should_cancel and should_cancel():
                        raise TransferCancelled("Transfer cancelled.")
                    destination_file.write(chunk)
                    if progress:
                        progress(len(chunk))
        else:
            with self.sftp.open(safe_path, "wb") as destination_file:
                for chunk in chunks:
                    if should_cancel and should_cancel():
                        raise TransferCancelled("Transfer cancelled.")
                    destination_file.write(chunk)
                    if progress:
                        progress(len(chunk))
        self.apply_meta(safe_path, source_meta)

    def apply_meta(self, path: str, source_meta: FileMeta) -> None:
        if source_meta.atime is None or source_meta.mtime is None:
            return
        safe_path = self.normalize(path)
        try:
            if self.device.connection_type == "smb":
                smbclient.utime(smb_unc_path(self.device, safe_path), (int(source_meta.atime), int(source_meta.mtime)), connection_cache=self.smb_connection_cache)
            else:
                self.sftp.utime(safe_path, (source_meta.atime, source_meta.mtime))
        except Exception:
            pass
        if self.device.connection_type == "ssh_sftp" and source_meta.mode is not None:
            try:
                self.sftp.chmod(safe_path, source_meta.mode & 0o777)
            except OSError:
                pass

    def delete_tree(self, path: str) -> None:
        safe_path = self.normalize(path)
        if self.device.connection_type == "smb":
            delete_smb_tree(smb_unc_path(self.device, safe_path), self.smb_connection_cache)
            return
        remove_tree(self.sftp, safe_path)


def copy_tree(
    source: TransferStore,
    destination: TransferStore,
    source_path: str,
    destination_path: str,
    progress: Callable[[int], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
    profile: TransferProfile | None = None,
    event_callback: TransferEventCallback | None = None,
) -> int:
    if should_cancel and should_cancel():
        raise TransferCancelled("Transfer cancelled.")
    source_path = source.normalize(source_path)
    destination_path = destination.normalize(destination_path)
    source_meta = source.meta(source_path)
    if source.is_dir(source_path):
        destination.ensure_dir(destination_path)
        copied_files = 0
        for child_name, child_source in source.children(source_path):
            copied_files += copy_tree(source, destination, child_source, destination.join(destination_path, child_name), progress, should_cancel, profile, event_callback)
        destination.apply_meta(destination_path, source_meta)
        return copied_files

    effective_profile = profile or source.profile
    if _uses_smb(source.device, destination.device):
        try:
            copy_file_resumable(
                source.device,
                destination.device,
                source_path,
                destination_path,
                source_meta,
                progress,
                should_cancel,
                effective_profile,
                event_callback,
            )
        except BaseException as exc:
            if event_callback and not isinstance(exc, TransferCancelled):
                event_callback("file_error", f"File transfer failed: {exc}", source_path, destination_path, {"error": str(exc)})
            raise
    else:
        try:
            file_streams = _file_streams_for_devices(source.device, destination.device, effective_profile)
            if source_meta.size and source_meta.size >= TRANSFER_FILE_STREAM_MIN_SIZE and file_streams > 1:
                copy_file_multistream(
                    source.device,
                    destination.device,
                    source_path,
                    destination_path,
                    source_meta,
                    progress,
                    should_cancel,
                    effective_profile,
                )
            else:
                destination.write_file(destination_path, source.read_chunks(source_path, should_cancel), source_meta, progress, should_cancel)
        except BaseException as exc:
            if event_callback and not isinstance(exc, TransferCancelled):
                event_callback("file_error", f"File transfer failed: {exc}", source_path, destination_path, {"error": str(exc)})
            raise
    return 1


def copy_file_resumable(
    source_device: Device,
    destination_device: Device,
    source_path: str,
    destination_path: str,
    source_meta: FileMeta,
    progress: Callable[[int], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
    profile: TransferProfile | None = None,
    event_callback: TransferEventCallback | None = None,
) -> None:
    effective_profile = profile or transfer_profile_settings("turbo")
    size = source_meta.size or 0
    source = TransferStore(source_device, effective_profile)
    destination = TransferStore(destination_device, effective_profile)
    try:
        resume_offset = 0
        if size > 0 and destination.exists(destination_path):
            destination_meta = destination.meta(destination_path)
            destination_size = destination_meta.size or 0
            if destination_size == size:
                if _same_timestamp(destination_meta.mtime, source_meta.mtime):
                    if event_callback:
                        event_callback(
                            "file_skipped",
                            "Destination file is already complete.",
                            source_path,
                            destination_path,
                            {"size": size},
                        )
                    if progress:
                        progress(size)
                    return
            if 0 < destination_size < size:
                if TRANSFER_RESUME_REWRITE_FULL:
                    resume_offset = 0
                else:
                    resume_offset = max(0, destination_size - TRANSFER_RESUME_REWIND_BYTES)
                if event_callback:
                    event_callback(
                        "file_resume",
                        "Resuming partial destination file.",
                        source_path,
                        destination_path,
                        {
                            "source_size": size,
                            "destination_size": destination_size,
                            "resume_offset": resume_offset,
                            "rewind_bytes": destination_size - resume_offset,
                            "rewrite_full": TRANSFER_RESUME_REWRITE_FULL,
                        },
                    )

        if resume_offset <= 0:
            destination.prepare_file(destination_path)
        else:
            destination.truncate_file(destination_path, resume_offset)
            if progress:
                progress(resume_offset)
    finally:
        source.close()
        destination.close()

    if size <= 0:
        source = TransferStore(source_device, effective_profile)
        destination = TransferStore(destination_device, effective_profile)
        try:
            destination.write_file(destination_path, source.read_chunks(source_path, should_cancel), source_meta, progress, should_cancel)
        finally:
            source.close()
            destination.close()
        return

    offset = resume_offset
    while offset < size:
        if should_cancel and should_cancel():
            raise TransferCancelled("Transfer cancelled.")
        length = min(TRANSFER_RESUME_BLOCK_SIZE, size - offset)
        block_source = TransferStore(source_device, effective_profile)
        block_destination = TransferStore(destination_device, effective_profile)
        try:
            block_destination.write_range(
                destination_path,
                offset,
                block_source.read_range(source_path, offset, length, should_cancel),
                progress,
                should_cancel,
            )
        finally:
            block_source.close()
            block_destination.close()
        offset += length

    destination = TransferStore(destination_device, effective_profile)
    try:
        destination.apply_meta(destination_path, source_meta)
    finally:
        destination.close()


def copy_file_multistream(
    source_device: Device,
    destination_device: Device,
    source_path: str,
    destination_path: str,
    source_meta: FileMeta,
    progress: Callable[[int], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
    profile: TransferProfile | None = None,
) -> None:
    effective_profile = profile or transfer_profile_settings("turbo")
    size = source_meta.size or 0
    max_file_streams = _file_streams_for_devices(source_device, destination_device, effective_profile)
    if size <= 0:
        source = TransferStore(source_device, effective_profile)
        destination = TransferStore(destination_device, effective_profile)
        try:
            destination.write_file(destination_path, source.read_chunks(source_path, should_cancel), source_meta, progress, should_cancel)
        finally:
            source.close()
            destination.close()
        return

    streams = min(max_file_streams, max(1, (size + TRANSFER_FILE_STREAM_MIN_SIZE - 1) // TRANSFER_FILE_STREAM_MIN_SIZE))
    if streams <= 1:
        source = TransferStore(source_device, effective_profile)
        destination = TransferStore(destination_device, effective_profile)
        try:
            destination.write_file(destination_path, source.read_chunks(source_path, should_cancel), source_meta, progress, should_cancel)
        finally:
            source.close()
            destination.close()
        return

    destination = TransferStore(destination_device, effective_profile)
    try:
        destination.prepare_file(destination_path)
    finally:
        destination.close()

    cancel_event = threading.Event()
    segment_size = (size + streams - 1) // streams
    segments = [
        (offset, min(segment_size, size - offset))
        for offset in range(0, size, segment_size)
        if size - offset > 0
    ]

    def worker(offset: int, length: int) -> None:
        if cancel_event.is_set() or (should_cancel and should_cancel()):
            raise TransferCancelled("Transfer cancelled.")
        worker_source = TransferStore(source_device, effective_profile)
        worker_destination = TransferStore(destination_device, effective_profile)
        try:
            worker_destination.write_range(
                destination_path,
                offset,
                worker_source.read_range(
                    source_path,
                    offset,
                    length,
                    lambda: cancel_event.is_set() or (should_cancel() if should_cancel else False),
                ),
                progress,
                lambda: cancel_event.is_set() or (should_cancel() if should_cancel else False),
            )
        finally:
            worker_source.close()
            worker_destination.close()

    with ThreadPoolExecutor(max_workers=min(streams, len(segments))) as executor:
        futures = [executor.submit(worker, offset, length) for offset, length in segments]
        for future in as_completed(futures):
            try:
                future.result()
            except BaseException:
                cancel_event.set()
                raise
    destination = TransferStore(destination_device, effective_profile)
    try:
        destination.apply_meta(destination_path, source_meta)
    finally:
        destination.close()


def transfer_file_paths(
    source_device: Device,
    destination_device: Device,
    source_paths: list[str],
    destination_path: str,
    action: str,
    transfer_profile: str = "turbo",
    progress: Callable[[int], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
    event_callback: TransferEventCallback | None = None,
) -> dict:
    profile = transfer_profile_settings(transfer_profile)
    source = TransferStore(source_device, profile)
    destination = TransferStore(destination_device, profile)
    copied_files = 0
    created_destinations: list[str] = []
    try:
        destination_base = destination.normalize(destination_path)
        destination.ensure_dir(destination_base)
        copy_tasks: list[tuple[str, str]] = []
        for raw_source_path in source_paths:
            if should_cancel and should_cancel():
                raise TransferCancelled("Transfer cancelled.")
            source_path = source.normalize(raw_source_path)
            destination_item = destination.join(destination_base, source.basename(source_path))
            if source_device.id == destination_device.id and source_device.__class__ is destination_device.__class__:
                if source_path == destination_item:
                    raise ValueError("Source and destination are the same path.")
                if destination_item.startswith(f"{source_path.rstrip('/')}/"):
                    raise ValueError("Destination cannot be inside the selected source folder.")
            if not destination.exists(destination_item):
                created_destinations.append(destination_item)
            copy_tasks.append((source_path, destination_item))

        parallel_files = min(profile.parallel_files, TRANSFER_SMB_PARALLEL_FILES) if _uses_smb(source_device, destination_device) else profile.parallel_files
        if len(copy_tasks) > 1 and parallel_files > 1:
            cancel_event = threading.Event()

            def worker(source_path: str, destination_item: str) -> int:
                if cancel_event.is_set() or (should_cancel and should_cancel()):
                    raise TransferCancelled("Transfer cancelled.")
                worker_source = TransferStore(source_device, profile)
                worker_destination = TransferStore(destination_device, profile)
                try:
                    return copy_tree(
                        worker_source,
                        worker_destination,
                        source_path,
                        destination_item,
                        progress,
                        lambda: cancel_event.is_set() or (should_cancel() if should_cancel else False),
                        profile,
                        event_callback,
                    )
                finally:
                    worker_source.close()
                    worker_destination.close()

            with ThreadPoolExecutor(max_workers=min(parallel_files, len(copy_tasks))) as executor:
                futures = [executor.submit(worker, source_path, destination_item) for source_path, destination_item in copy_tasks]
                for future in as_completed(futures):
                    try:
                        copied_files += future.result()
                    except BaseException:
                        cancel_event.set()
                        raise
        else:
            for source_path, destination_item in copy_tasks:
                copied_files += copy_tree(source, destination, source_path, destination_item, progress, should_cancel, profile, event_callback)

        if action == "move":
            for raw_source_path in source_paths:
                if should_cancel and should_cancel():
                    raise TransferCancelled("Transfer cancelled.")
                source.delete_tree(raw_source_path)
        return {
            "ok": True,
            "action": action,
            "items": len(source_paths),
            "files_copied": copied_files,
            "metadata_policy": "basic timestamps when possible; SFTP permissions when safe; xattrs and ACLs ignored",
        }
    except TransferCancelled:
        for created_destination in reversed(created_destinations):
            try:
                if destination.exists(created_destination):
                    destination.delete_tree(created_destination)
            except OSError:
                pass
        raise
    finally:
        source.close()
        destination.close()


def measure_transfer_paths(source_device: Device, source_paths: list[str]) -> tuple[int, int]:
    source = TransferStore(source_device)
    try:
        total_bytes = 0
        total_files = 0
        for raw_source_path in source_paths:
            path_bytes, path_files = source.total_size(raw_source_path)
            total_bytes += path_bytes
            total_files += path_files
        return total_bytes, total_files
    finally:
        source.close()
