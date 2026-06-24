from __future__ import annotations

import posixpath
import stat

from app.database.models import Device
from app.devices.service import connect_ssh_device
from app.files.sftp import normalize_path


TRANSFER_CHUNK_SIZE = 16 * 1024 * 1024


def ensure_directory(sftp, path: str) -> None:
    normalized = normalize_path(path)
    if normalized in ("", "."):
        return
    parts = [part for part in normalized.split("/") if part]
    current = "/" if normalized.startswith("/") else "."
    for part in parts:
        current = posixpath.join(current, part)
        try:
            sftp.stat(current)
        except OSError:
            sftp.mkdir(current)


def copy_file_contents(source_sftp, destination_sftp, source_path: str, destination_path: str, source_attr) -> None:
    ensure_directory(destination_sftp, posixpath.dirname(destination_path))
    with source_sftp.open(source_path, "rb") as source_file:
        with destination_sftp.open(destination_path, "wb") as destination_file:
            while True:
                chunk = source_file.read(TRANSFER_CHUNK_SIZE)
                if not chunk:
                    break
                destination_file.write(chunk)

    # Best effort basic metadata only. Advanced xattrs/ACLs are intentionally ignored.
    try:
        destination_sftp.utime(destination_path, (source_attr.st_atime, source_attr.st_mtime))
    except OSError:
        pass
    try:
        destination_sftp.chmod(destination_path, source_attr.st_mode & 0o777)
    except OSError:
        pass


def copy_tree(source_sftp, destination_sftp, source_path: str, destination_path: str) -> int:
    source_attr = source_sftp.stat(source_path)
    if stat.S_ISDIR(source_attr.st_mode):
        ensure_directory(destination_sftp, destination_path)
        copied = 0
        for child in source_sftp.listdir_attr(source_path):
            child_source = posixpath.join(source_path, child.filename)
            child_destination = posixpath.join(destination_path, child.filename)
            copied += copy_tree(source_sftp, destination_sftp, child_source, child_destination)
        try:
            destination_sftp.utime(destination_path, (source_attr.st_atime, source_attr.st_mtime))
        except OSError:
            pass
        try:
            destination_sftp.chmod(destination_path, source_attr.st_mode & 0o777)
        except OSError:
            pass
        return copied

    copy_file_contents(source_sftp, destination_sftp, source_path, destination_path, source_attr)
    return 1


def remove_tree(sftp, path: str) -> None:
    attr = sftp.stat(path)
    if stat.S_ISDIR(attr.st_mode):
        for child in sftp.listdir_attr(path):
            remove_tree(sftp, posixpath.join(path, child.filename))
        sftp.rmdir(path)
    else:
        sftp.remove(path)


def transfer_sftp_paths(
    source_device: Device,
    destination_device: Device,
    source_paths: list[str],
    destination_path: str,
    action: str,
) -> dict:
    source_client = connect_ssh_device(source_device)
    destination_client = connect_ssh_device(destination_device)
    source_sftp = source_client.open_sftp()
    destination_sftp = destination_client.open_sftp()
    copied_files = 0
    try:
        destination_base = normalize_path(destination_path)
        ensure_directory(destination_sftp, destination_base)
        for raw_source_path in source_paths:
            source_path = normalize_path(raw_source_path)
            destination = posixpath.join(destination_base, posixpath.basename(source_path.rstrip("/")))
            if source_device.id == destination_device.id:
                if source_path == destination:
                    raise ValueError("Source and destination are the same path.")
                if destination.startswith(f"{source_path.rstrip('/')}/"):
                    raise ValueError("Destination cannot be inside the selected source folder.")
            copied_files += copy_tree(source_sftp, destination_sftp, source_path, destination)
        if action == "move":
            for raw_source_path in source_paths:
                remove_tree(source_sftp, normalize_path(raw_source_path))
        return {
            "ok": True,
            "action": action,
            "items": len(source_paths),
            "files_copied": copied_files,
            "metadata_policy": "basic timestamps and permissions only; xattrs and ACLs ignored",
        }
    finally:
        source_sftp.close()
        destination_sftp.close()
        source_client.close()
        destination_client.close()
