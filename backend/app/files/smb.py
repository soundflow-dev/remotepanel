from __future__ import annotations

import ntpath
import os
import logging
from datetime import datetime
from urllib.parse import urlparse

import smbclient
from fastapi import HTTPException, status

from app.database.models import Device
from app.security.crypto import decrypt_json


logger = logging.getLogger(__name__)


def _bool_env(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


SMB_REQUIRE_SIGNING = _bool_env("SMB_REQUIRE_SIGNING", True)
SMB_AUTH_PROTOCOL = os.getenv("SMB_AUTH_PROTOCOL", "negotiate").strip().lower() or "negotiate"


def _new_connection_cache() -> dict:
    return {}


def _smb_kwargs(connection_cache=None) -> dict:
    return {"connection_cache": connection_cache} if connection_cache is not None else {}


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
    smbclient.register_session(
        host,
        username=username,
        password=password,
        connection_cache=connection_cache,
        auth_protocol=SMB_AUTH_PROTOCOL,
        require_signing=SMB_REQUIRE_SIGNING,
    )


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
    connection_cache = _new_connection_cache()
    _register_session(device, connection_cache=connection_cache)
    current = _relative(path)
    root = _unc(device, None if current == "." else current)
    entries = []
    try:
        for entry in smbclient.scandir(root, **_smb_kwargs(connection_cache)):
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
        message = str(exc)
        if "STATUS_LOGON_FAILURE" in message or "Logon failure" in message:
            message = f"{message}. Check the SMB username format. Some NAS devices require 'DOMAIN\\\\user', 'WORKGROUP\\\\user', or a local NAS username."
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"SMB list failed: {message}") from exc
    entries.sort(key=lambda item: (item["type"] != "directory", item["name"].lower()))
    parent = "."
    if current != ".":
        parent_path = ntpath.dirname(current.replace("/", "\\")).replace("\\", "/")
        parent = parent_path or "."
    return {"path": current, "parent": parent, "entries": entries}


def make_smb_directory(device: Device, path: str) -> None:
    connection_cache = _new_connection_cache()
    _register_session(device, connection_cache=connection_cache)
    smbclient.mkdir(_unc(device, _relative(path)), **_smb_kwargs(connection_cache))


def delete_smb_path(device: Device, path: str) -> None:
    connection_cache = _new_connection_cache()
    _register_session(device, connection_cache=connection_cache)
    relative = _relative(path)
    if relative == ".":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Refusing to delete the share root.")
    target = _unc(device, relative)
    logger.info("Deleting SMB path %s (%s)", relative, target)
    delete_smb_tree(target, connection_cache)
    if smbclient.path.exists(target, **_smb_kwargs(connection_cache)):
        logger.warning("SMB path still exists after delete: %s (%s)", relative, target)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"SMB delete failed: path still exists after delete: {relative}")


def delete_smb_tree(target: str, connection_cache) -> None:
    if not smbclient.path.isdir(target, **_smb_kwargs(connection_cache)):
        try:
            logger.info("Deleting SMB file %s", target)
            smbclient.remove(target, **_smb_kwargs(connection_cache))
            return
        except OSError as exc:
            logger.exception("SMB file delete failed for %s", target)
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"SMB file delete failed: {exc}") from exc

    try:
        for entry in list(smbclient.scandir(target, **_smb_kwargs(connection_cache))):
            delete_smb_tree(ntpath.join(target, entry.name), connection_cache)
        logger.info("Deleting SMB folder %s", target)
        smbclient.rmdir(target, **_smb_kwargs(connection_cache))
    except OSError as exc:
        logger.exception("SMB folder delete failed for %s", target)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"SMB folder delete failed: {exc}") from exc


def rename_smb_path(device: Device, source: str, destination: str) -> None:
    connection_cache = _new_connection_cache()
    _register_session(device, connection_cache=connection_cache)
    smbclient.rename(_unc(device, _relative(source)), _unc(device, _relative(destination)), **_smb_kwargs(connection_cache))


def read_smb_file(device: Device, path: str) -> tuple[str, bytes]:
    connection_cache = _new_connection_cache()
    _register_session(device, connection_cache=connection_cache)
    relative = _relative(path)
    with smbclient.open_file(_unc(device, relative), mode="rb", **_smb_kwargs(connection_cache)) as remote_file:
        content = remote_file.read()
    return ntpath.basename(relative), content


def write_smb_file(device: Device, path: str, chunks) -> None:
    connection_cache = _new_connection_cache()
    _register_session(device, connection_cache=connection_cache)
    target = _unc(device, _relative(path))
    parent = ntpath.dirname(target)
    if parent and not smbclient.path.exists(parent, **_smb_kwargs(connection_cache)):
        smbclient.makedirs(parent, **_smb_kwargs(connection_cache))
    with smbclient.open_file(target, mode="wb", **_smb_kwargs(connection_cache)) as remote_file:
        for chunk in chunks:
            remote_file.write(chunk)
