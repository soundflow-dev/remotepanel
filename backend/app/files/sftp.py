from __future__ import annotations

import io
import posixpath
import shlex
import stat
from datetime import datetime
from urllib.parse import urlparse

import paramiko
from fastapi import HTTPException, status

from app.database.models import Device
from app.devices.service import connect_ssh_device


def normalize_path(path: str | None) -> str:
    if not path:
        return "."
    normalized = posixpath.normpath(path)
    return "." if normalized in ("", ".") else normalized


def parent_path(path: str) -> str:
    if path in ("", ".", "/"):
        return "."
    parent = posixpath.dirname(path.rstrip("/"))
    return parent or "."


def configured_start_path(device: Device) -> str | None:
    if not device.connection_url:
        return None
    parsed = urlparse(device.connection_url)
    if parsed.scheme not in ("sftp", "ssh"):
        return None
    if not parsed.path or parsed.path == "/":
        return None
    return normalize_path(parsed.path)


def initial_path_candidates(device: Device, sftp) -> list[str]:
    candidates: list[str] = []
    configured = configured_start_path(device)
    if configured:
        candidates.append(configured)
    candidates.append(".")
    try:
        current = sftp.getcwd()
        if current:
            candidates.append(normalize_path(current))
    except OSError:
        pass
    candidates.extend(["/", "/config", "/homeassistant"])
    return list(dict.fromkeys(candidates))


def initial_exec_path_candidates(device: Device) -> list[str]:
    candidates: list[str] = []
    configured = configured_start_path(device)
    if configured:
        candidates.append(configured)
    candidates.extend(["/config", "/homeassistant", "/", "."])
    return list(dict.fromkeys(candidates))


def sftp_for_device(device: Device):
    if device.connection_type != "ssh_sftp":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="File explorer is currently available for SFTP devices.")
    client = connect_ssh_device(device)
    try:
        return client, client.open_sftp()
    except Exception:
        client.close()
        raise


def run_ssh_command(client, command: str) -> tuple[int, str, str]:
    stdin, stdout, stderr = client.exec_command(command, timeout=20)
    stdin.close()
    code = stdout.channel.recv_exit_status()
    return code, stdout.read().decode("utf-8", errors="replace"), stderr.read().decode("utf-8", errors="replace")


def entry_from_attr(path: str, attr) -> dict:
    is_dir = stat.S_ISDIR(attr.st_mode)
    return {
        "name": attr.filename,
        "path": posixpath.join(path, attr.filename) if path not in ("", ".") else attr.filename,
        "type": "directory" if is_dir else "file",
        "size": attr.st_size,
        "modified_at": datetime.fromtimestamp(attr.st_mtime).isoformat() if attr.st_mtime else None,
        "permissions": stat.filemode(attr.st_mode),
    }


def entry_from_ls_line(path: str, line: str) -> dict | None:
    parts = line.split()
    if len(parts) < 9:
        return None
    permissions = parts[0]
    name = " ".join(parts[8:])
    if name in (".", ".."):
        return None
    if permissions.startswith("l") and " -> " in name:
        name = name.split(" -> ", 1)[0]
    try:
        size = int(parts[4])
    except ValueError:
        size = 0
    is_dir = permissions.startswith("d")
    return {
        "name": name,
        "path": posixpath.join(path, name) if path not in ("", ".") else name,
        "type": "directory" if is_dir else "file",
        "size": size,
        "modified_at": None,
        "permissions": permissions,
    }


def list_sftp_directory_via_exec(device: Device, path: str | None) -> dict:
    requested_path = normalize_path(path)
    is_initial_listing = requested_path == "."
    candidates = [requested_path] if not is_initial_listing else initial_exec_path_candidates(device)
    client = connect_ssh_device(device)
    try:
        errors: list[str] = []
        empty_result: dict | None = None
        for candidate in candidates:
            command = f"LC_ALL=C ls -la {shlex.quote(candidate)}"
            code, output, error = run_ssh_command(client, command)
            if code != 0:
                errors.append(f"{candidate}: {error.strip() or output.strip() or f'exit {code}'}")
                continue
            entries = []
            for line in output.splitlines()[1:]:
                entry = entry_from_ls_line(candidate, line)
                if entry:
                    entries.append(entry)
            entries.sort(key=lambda item: (item["type"] != "directory", item["name"].lower()))
            result = {"path": candidate, "parent": parent_path(candidate), "entries": entries}
            if entries or not is_initial_listing:
                return result
            if empty_result is None:
                empty_result = result
        if empty_result is not None:
            return empty_result
        detail = "SFTP is not available and SSH file listing failed."
        if errors:
            detail += " Tried " + "; ".join(errors)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)
    finally:
        client.close()


def list_sftp_directory(device: Device, path: str | None) -> dict:
    safe_path = normalize_path(path)
    try:
        client, sftp = sftp_for_device(device)
    except (paramiko.SSHException, EOFError, OSError):
        return list_sftp_directory_via_exec(device, path)
    try:
        if safe_path == ".":
            entries = None
            errors: list[str] = []
            for candidate in initial_path_candidates(device, sftp):
                try:
                    entries = [entry_from_attr(candidate, attr) for attr in sftp.listdir_attr(candidate)]
                    safe_path = candidate
                    break
                except OSError as exc:
                    errors.append(f"{candidate}: {exc}")
            if entries is None:
                detail = "SFTP initial directory is not available."
                if errors:
                    detail += " Tried " + "; ".join(errors)
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)
        else:
            entries = [entry_from_attr(safe_path, attr) for attr in sftp.listdir_attr(safe_path)]
        entries.sort(key=lambda item: (item["type"] != "directory", item["name"].lower()))
        return {"path": safe_path, "parent": parent_path(safe_path), "entries": entries}
    finally:
        sftp.close()
        client.close()


def make_sftp_directory(device: Device, path: str) -> None:
    client, sftp = sftp_for_device(device)
    try:
        sftp.mkdir(normalize_path(path))
    finally:
        sftp.close()
        client.close()


def delete_sftp_path(device: Device, path: str) -> None:
    safe_path = normalize_path(path)
    if safe_path in ("", ".", "/"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Refusing to delete the root folder.")
    client, sftp = sftp_for_device(device)
    try:
        delete_sftp_tree(sftp, safe_path)
    finally:
        sftp.close()
        client.close()


def delete_sftp_tree(sftp, path: str) -> None:
    attr = sftp.stat(path)
    if stat.S_ISDIR(attr.st_mode):
        for child in sftp.listdir_attr(path):
            delete_sftp_tree(sftp, posixpath.join(path, child.filename))
        sftp.rmdir(path)
        return
    sftp.remove(path)


def rename_sftp_path(device: Device, source: str, destination: str) -> None:
    client, sftp = sftp_for_device(device)
    try:
        sftp.rename(normalize_path(source), normalize_path(destination))
    finally:
        sftp.close()
        client.close()


def read_sftp_file(device: Device, path: str) -> tuple[str, io.BytesIO]:
    safe_path = normalize_path(path)
    client, sftp = sftp_for_device(device)
    try:
        with sftp.open(safe_path, "rb") as remote_file:
            content = remote_file.read()
        return posixpath.basename(safe_path), io.BytesIO(content)
    finally:
        sftp.close()
        client.close()
