from __future__ import annotations

import io
import socket

import paramiko
from fastapi import HTTPException, status
from sqlalchemy.orm import Session as DbSession

from app.database.models import Device, DeviceShare, User
from app.devices.paths import parse_connection_path
from app.devices.schemas import DeviceCreate, DeviceShareCreate, DeviceShareUpdate, DeviceUpdate
from app.files.smb import list_smb_directory
from app.security.crypto import decrypt_json, encrypt_json


def _credential_payload(payload: DeviceCreate | DeviceUpdate) -> dict[str, str]:
    credentials: dict[str, str] = {}
    if payload.password:
        credentials["password"] = payload.password
    if payload.private_key:
        credentials["private_key"] = payload.private_key
    return credentials


def create_device(db: DbSession, owner: User, payload: DeviceCreate) -> Device:
    credentials = _credential_payload(payload)
    if payload.connection_type == "machine":
        if not payload.host:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Host/IP is required.")
        parsed_path = parse_connection_path("ssh_sftp", None, payload.host, payload.port or 22)
    else:
        parsed_path = parse_connection_path(payload.connection_type, payload.connection_url, payload.host, payload.port)
    if payload.connection_type == "smb" and not (payload.connection_url or payload.host):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Share path is required.")
    if payload.connection_type == "ssh_sftp" and not payload.username:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="User is required for SSH/SFTP.")
    if payload.connection_type == "ssh_sftp" and payload.auth_method == "none":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="SSH/SFTP requires password or SSH key authentication.")
    if payload.auth_method == "password" and not credentials.get("password"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Password is required.")
    if payload.auth_method == "ssh_key" and not credentials.get("private_key"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Private key is required.")
    device = Device(
        owner_id=owner.id,
        name=payload.name,
        connection_type=payload.connection_type,
        connection_url=parsed_path.normalized_url,
        host=parsed_path.host,
        port=parsed_path.port,
        username=payload.username,
        auth_method=payload.auth_method,
        credentials_encrypted=encrypt_json(credentials),
        active=payload.active,
    )
    db.add(device)
    db.commit()
    db.refresh(device)
    return device


def list_devices(db: DbSession, owner: User) -> list[Device]:
    return db.query(Device).filter(Device.owner_id == owner.id).order_by(Device.name.asc()).all()


def get_device(db: DbSession, owner: User, device_id: int) -> Device:
    device = db.query(Device).filter(Device.id == device_id, Device.owner_id == owner.id).first()
    if not device:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Device not found.")
    return device


def update_device(db: DbSession, owner: User, device_id: int, payload: DeviceUpdate) -> Device:
    device = get_device(db, owner, device_id)
    for field in ("name", "host", "port", "username", "auth_method", "active"):
        value = getattr(payload, field)
        if value is not None:
            setattr(device, field, value)
    if payload.connection_url is not None and device.connection_type != "machine":
        parsed_path = parse_connection_path(device.connection_type, payload.connection_url, device.host, device.port)
        device.connection_url = parsed_path.normalized_url
        device.host = parsed_path.host
        device.port = parsed_path.port
    credentials = decrypt_json(device.credentials_encrypted)
    credentials.update(_credential_payload(payload))
    device.credentials_encrypted = encrypt_json(credentials)
    db.commit()
    db.refresh(device)
    return device


def _share_credentials(payload: DeviceShareCreate | DeviceShareUpdate) -> dict[str, str]:
    credentials: dict[str, str] = {}
    if payload.password:
        credentials["password"] = payload.password
    return credentials


def list_device_shares(db: DbSession, owner: User, device_id: int) -> list[DeviceShare]:
    device = get_device(db, owner, device_id)
    return db.query(DeviceShare).filter(DeviceShare.device_id == device.id).order_by(DeviceShare.name.asc()).all()


def get_device_share(db: DbSession, owner: User, share_id: int) -> DeviceShare:
    share = db.query(DeviceShare).join(Device).filter(DeviceShare.id == share_id, Device.owner_id == owner.id).first()
    if not share:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Share not found.")
    return share


def create_device_share(db: DbSession, owner: User, device_id: int, payload: DeviceShareCreate) -> DeviceShare:
    device = get_device(db, owner, device_id)
    parsed_path = parse_connection_path(payload.connection_type, payload.connection_url, device.host, payload.port)
    credentials = _share_credentials(payload)
    if payload.auth_method == "password" and not credentials.get("password"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Password is required.")
    share = DeviceShare(
        device_id=device.id,
        name=payload.name,
        connection_type=payload.connection_type,
        connection_url=parsed_path.normalized_url,
        host=parsed_path.host,
        port=parsed_path.port,
        username=payload.username,
        auth_method=payload.auth_method,
        credentials_encrypted=encrypt_json(credentials),
        active=payload.active,
    )
    db.add(share)
    db.commit()
    db.refresh(share)
    return share


def update_device_share(db: DbSession, owner: User, share_id: int, payload: DeviceShareUpdate) -> DeviceShare:
    share = get_device_share(db, owner, share_id)
    for field in ("name", "port", "username", "auth_method", "active"):
        value = getattr(payload, field)
        if value is not None:
            setattr(share, field, value)
    if payload.connection_url is not None:
        parsed_path = parse_connection_path(share.connection_type, payload.connection_url, share.host, share.port)
        share.connection_url = parsed_path.normalized_url
        share.host = parsed_path.host
        share.port = parsed_path.port
    credentials = decrypt_json(share.credentials_encrypted)
    credentials.update(_share_credentials(payload))
    share.credentials_encrypted = encrypt_json(credentials)
    db.commit()
    db.refresh(share)
    return share


def delete_device_share(db: DbSession, owner: User, share_id: int) -> None:
    share = get_device_share(db, owner, share_id)
    db.delete(share)
    db.commit()


def delete_device(db: DbSession, owner: User, device_id: int) -> None:
    device = get_device(db, owner, device_id)
    db.delete(device)
    db.commit()


def load_private_key(private_key: str) -> paramiko.PKey:
    last_error: Exception | None = None
    for key_class in (paramiko.RSAKey, paramiko.ECDSAKey, paramiko.Ed25519Key, paramiko.DSSKey):
        try:
            return key_class.from_private_key(io.StringIO(private_key))
        except Exception as exc:  # Paramiko raises different parse errors per key type.
            last_error = exc
    raise ValueError(f"Unable to read private key: {last_error}")


def connect_ssh_device(device: Device) -> paramiko.SSHClient:
    if not device.active:
        raise ValueError("Device is inactive.")
    if device.connection_type != "ssh_sftp":
        raise ValueError("Only SSH/SFTP devices can open an SSH terminal.")
    if device.auth_method == "none":
        raise ValueError("SSH/SFTP requires password or SSH key authentication.")
    credentials = decrypt_json(device.credentials_encrypted)
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    kwargs = {
        "hostname": device.host,
        "port": device.port,
        "username": device.username,
        "timeout": 10,
        "banner_timeout": 10,
        "auth_timeout": 10,
        "look_for_keys": False,
        "allow_agent": False,
    }
    if device.auth_method == "password":
        kwargs["password"] = credentials.get("password")
    else:
        kwargs["pkey"] = load_private_key(credentials.get("private_key", ""))
    client.connect(**kwargs)
    return client


def test_ssh_device(device: Device) -> tuple[bool, str]:
    client = None
    try:
        client = connect_ssh_device(device)
        return True, "SSH connection successful."
    except (paramiko.SSHException, socket.error, ValueError) as exc:
        return False, f"SSH connection failed: {exc}"
    finally:
        if client:
            client.close()


def test_smb_device(device: Device) -> tuple[bool, str]:
    try:
        list_smb_directory(device, ".")
        return True, "SMB share connection successful."
    except Exception as exc:
        return False, f"SMB share connection failed: {exc}"


def test_device_connection(device: Device) -> tuple[bool, str]:
    if device.connection_type == "ssh_sftp":
        return test_ssh_device(device)
    if device.connection_type == "smb":
        return test_smb_device(device)
    return False, "No test is available for this machine."


def run_device_power_action(device: Device, action: str) -> tuple[bool, str]:
    if action not in {"reboot", "shutdown"}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unsupported power action.")
    if device.connection_type != "ssh_sftp":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Power actions require SSH/SFTP access.")

    credentials = decrypt_json(device.credentials_encrypted)
    sudo_password = credentials.get("password") if device.auth_method == "password" else None
    sudo_prefix = "sudo -S -p ''" if sudo_password else "sudo -n"
    commands = {
        "reboot": f"{sudo_prefix} /sbin/reboot || {sudo_prefix} reboot || /sbin/reboot || reboot",
        "shutdown": f"{sudo_prefix} /sbin/poweroff || {sudo_prefix} poweroff || {sudo_prefix} shutdown -h now || /sbin/poweroff || poweroff || shutdown -h now",
    }
    labels = {
        "reboot": "Reboot",
        "shutdown": "Shutdown",
    }
    client = None
    try:
        client = connect_ssh_device(device)
        command = f"sh -lc {commands[action]!r}"
        stdin, stdout, stderr = client.exec_command(command, timeout=15)
        if sudo_password:
            stdin.write((sudo_password + "\n") * 4)
            stdin.flush()
        stdin.close()
        code = stdout.channel.recv_exit_status()
        error = stderr.read().decode("utf-8", errors="replace").strip()
        if code != 0:
            hint = " Check that this SSH user can run power commands with sudo."
            if not sudo_password:
                hint = " Configure passwordless sudo for this SSH user, or save the device with password authentication."
            return False, f"{labels[action]} failed: {error or 'command returned a non-zero exit code'}.{hint}"
        return True, f"{labels[action]} command sent."
    except (paramiko.SSHException, socket.error, ValueError) as exc:
        return False, f"{labels[action]} failed: {exc}"
    finally:
        if client:
            client.close()
