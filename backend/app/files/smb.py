from __future__ import annotations

import ntpath
import os
from datetime import datetime
from urllib.parse import urlparse

import smbclient
from fastapi import HTTPException, status

from app.database.models import Device
from app.security.crypto import decrypt_json


def _bool_env(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


SMB_REQUIRE_SIGNING = _bool_env("SMB_REQUIRE_SIGNING", False)


def _parse_smb_url(device: Device) -> tuple[str, str, str]:
    parsed = urlparse(device.connection_url or f"smb://{device.host}")
    host = parsed.hostname or device.host
    parts = [part for part in parsed.path.split("/") if part]
    if not parts:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="SMB share path must include a share name, for example smb://host/share.")
    share = parts[0]
    base = "\\".join(parts[1:])
    return host, share, base


def _credentials(device: Device) -> tuple[str | None, str | None]:
    credentials = decrypt_json(device.credentials_encrypted)
    username = device.username or None
    password = credentials.get("password")
    return username, password


def _register_session(device: Device, connection_cache=None) -> None:
    username, password = _credentials(device)
    host, _, _ = _parse_smb_url(device)
    smbclient.register_session(host, username=username, password=password, connection_cache=connection_cache, require_signing=SMB_REQUIRE_SIGNING)


def _unc(device: Device, relative_path: str | None = None) -> str:
    host, share, base = _parse_smb_url(device)
    parts = [f"\\\\{host}\\{share}"]
    if base:
        parts.append(base.strip("\\/"))
    if relative_path and relative_path not in (".", "/", "\\"):
        parts.append(relative_path.strip("\\/").replace("/", "\\"))
    return "\\".join(parts)


def _relative(path: str | None) -> str:
    if not path or path in (".", "/", "\\"):
        return "."
    return path.strip("\\/").replace("\\", "/")


def smb_unc_path(device: Device, path: str | None = None) -> str:
    return _unc(device, _relative(path))


def register_smb_device(device: Device, connection_cache=None) -> None:
    _register_session(device, connection_cache=connection_cache)


def list_smb_directory(device: Device, path: str | None) -> dict:
    if device.connection_type != "smb":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Not an SMB device.")
    _register_session(device)
    current = _relative(path)
    root = _unc(device, None if current == "." else current)
    entries = []
    try:
        for entry in smbclient.scandir(root):
            stat_result = entry.stat()
            is_dir = entry.is_dir()
            entry_path = entry.name if current == "." else f"{current}/{entry.name}"
            modified = getattr(stat_result, "st_mtime", None)
            entries.append(
                {
                    "name": entry.name,
                    "path": entry_path,
                    "type": "directory" if is_dir else "file",
                    "size": getattr(stat_result, "st_size", None),
                    "modified_at": datetime.fromtimestamp(modified).isoformat() if modified else None,
                    "permissions": "",
                }
            )
    except OSError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"SMB list failed: {exc}") from exc
    entries.sort(key=lambda item: (item["type"] != "directory", item["name"].lower()))
    parent = "."
    if current != ".":
        parent_path = ntpath.dirname(current.replace("/", "\\")).replace("\\", "/")
        parent = parent_path or "."
    return {"path": current, "parent": parent, "entries": entries}


def make_smb_directory(device: Device, path: str) -> None:
    _register_session(device)
    smbclient.mkdir(_unc(device, _relative(path)))


def delete_smb_path(device: Device, path: str) -> None:
    _register_session(device)
    relative = _relative(path)
    if relative == ".":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Refusing to delete the share root.")
    target = _unc(device, relative)
    delete_smb_tree(device, relative, target)


def delete_smb_tree(device: Device, relative_path: str, target: str | None = None) -> None:
    target = target or _unc(device, _relative(relative_path))
    try:
        entries = list(smbclient.scandir(target))
    except OSError as scan_exc:
        try:
            smbclient.remove(target)
            return
        except OSError as remove_exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"SMB delete failed: {remove_exc}; scan failed: {scan_exc}") from remove_exc

    for entry in entries:
        child_relative = entry.name if relative_path == "." else f"{relative_path}/{entry.name}"
        delete_smb_tree(device, child_relative)
    try:
        smbclient.rmdir(target)
        return
    except OSError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"SMB folder delete failed: {exc}") from exc


def rename_smb_path(device: Device, source: str, destination: str) -> None:
    _register_session(device)
    smbclient.rename(_unc(device, _relative(source)), _unc(device, _relative(destination)))


def read_smb_file(device: Device, path: str) -> tuple[str, bytes]:
    _register_session(device)
    relative = _relative(path)
    with smbclient.open_file(_unc(device, relative), mode="rb") as remote_file:
        content = remote_file.read()
    return ntpath.basename(relative), content


def write_smb_file(device: Device, path: str, chunks) -> None:
    _register_session(device)
    target = _unc(device, _relative(path))
    parent = ntpath.dirname(target)
    if parent and not smbclient.path.exists(parent):
        smbclient.makedirs(parent)
    with smbclient.open_file(target, mode="wb") as remote_file:
        for chunk in chunks:
            remote_file.write(chunk)
