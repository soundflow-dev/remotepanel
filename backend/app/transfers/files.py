from __future__ import annotations

import ntpath
import posixpath
import stat
from dataclasses import dataclass
from typing import Callable, Iterator

import smbclient

from app.database.models import Device
from app.devices.service import connect_ssh_device
from app.files.sftp import normalize_path
from app.files.smb import register_smb_device, smb_unc_path
from app.transfers.sftp import ensure_directory, remove_tree


@dataclass
class FileMeta:
    mode: int | None = None
    atime: float | None = None
    mtime: float | None = None


class TransferCancelled(Exception):
    pass


class TransferStore:
    def __init__(self, device: Device):
        self.device = device
        self.ssh_client = None
        self.sftp = None
        if device.connection_type == "ssh_sftp":
            self.ssh_client = connect_ssh_device(device)
            self.sftp = self.ssh_client.open_sftp()
        elif device.connection_type == "smb":
            register_smb_device(device)
        else:
            raise ValueError(f"{device.connection_type.upper()} file transfers are not available yet.")

    def close(self) -> None:
        if self.sftp:
            self.sftp.close()
        if self.ssh_client:
            self.ssh_client.close()

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
            return smbclient.stat(smb_unc_path(self.device, safe_path))
        return self.sftp.stat(safe_path)

    def is_dir(self, path: str) -> bool:
        safe_path = self.normalize(path)
        if self.device.connection_type == "smb":
            return smbclient.path.isdir(smb_unc_path(self.device, safe_path))
        return stat.S_ISDIR(self.sftp.stat(safe_path).st_mode)

    def children(self, path: str) -> list[tuple[str, str]]:
        safe_path = self.normalize(path)
        if self.device.connection_type == "smb":
            children = []
            for entry in smbclient.scandir(smb_unc_path(self.device, safe_path)):
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
        )

    def ensure_dir(self, path: str) -> None:
        safe_path = self.normalize(path)
        if safe_path in ("", "."):
            return
        if self.device.connection_type == "smb":
            target = smb_unc_path(self.device, safe_path)
            if not smbclient.path.exists(target):
                smbclient.makedirs(target, exist_ok=True)
            return
        ensure_directory(self.sftp, safe_path)

    def read_chunks(self, path: str) -> Iterator[bytes]:
        safe_path = self.normalize(path)
        if self.device.connection_type == "smb":
            with smbclient.open_file(smb_unc_path(self.device, safe_path), mode="rb") as source_file:
                while True:
                    chunk = source_file.read(1024 * 1024)
                    if not chunk:
                        break
                    yield chunk
            return
        with self.sftp.open(safe_path, "rb") as source_file:
            while True:
                chunk = source_file.read(1024 * 1024)
                if not chunk:
                    break
                yield chunk

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
            with smbclient.open_file(smb_unc_path(self.device, safe_path), mode="wb") as destination_file:
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
                smbclient.utime(smb_unc_path(self.device, safe_path), (int(source_meta.atime), int(source_meta.mtime)))
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
            target = smb_unc_path(self.device, safe_path)
            if smbclient.path.isdir(target):
                for entry in smbclient.scandir(target):
                    self.delete_tree(self.join(safe_path, entry.name))
                smbclient.rmdir(target)
            else:
                smbclient.remove(target)
            return
        remove_tree(self.sftp, safe_path)


def copy_tree(
    source: TransferStore,
    destination: TransferStore,
    source_path: str,
    destination_path: str,
    progress: Callable[[int], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
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
            copied_files += copy_tree(source, destination, child_source, destination.join(destination_path, child_name), progress, should_cancel)
        destination.apply_meta(destination_path, source_meta)
        return copied_files

    destination.write_file(destination_path, source.read_chunks(source_path), source_meta, progress, should_cancel)
    return 1


def transfer_file_paths(
    source_device: Device,
    destination_device: Device,
    source_paths: list[str],
    destination_path: str,
    action: str,
    progress: Callable[[int], None] | None = None,
    should_cancel: Callable[[], bool] | None = None,
) -> dict:
    source = TransferStore(source_device)
    destination = TransferStore(destination_device)
    copied_files = 0
    try:
        destination_base = destination.normalize(destination_path)
        destination.ensure_dir(destination_base)
        for raw_source_path in source_paths:
            if should_cancel and should_cancel():
                raise TransferCancelled("Transfer cancelled.")
            source_path = source.normalize(raw_source_path)
            destination_item = destination.join(destination_base, source.basename(source_path))
            if source_device.id == destination_device.id:
                if source_path == destination_item:
                    raise ValueError("Source and destination are the same path.")
                if destination_item.startswith(f"{source_path.rstrip('/')}/"):
                    raise ValueError("Destination cannot be inside the selected source folder.")
            copied_files += copy_tree(source, destination, source_path, destination_item, progress, should_cancel)
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
