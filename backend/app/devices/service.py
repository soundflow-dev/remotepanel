from __future__ import annotations

import io
import socket

import paramiko
from fastapi import HTTPException, status
from sqlalchemy.orm import Session as DbSession

from app.database.models import Device, User
from app.devices.schemas import DeviceCreate, DeviceUpdate
from app.security.crypto import decrypt_json, encrypt_json


def _credential_payload(payload: DeviceCreate | DeviceUpdate) -> dict[str, str]:
    credentials: dict[str, str] = {}
    if payload.password:
        credentials["password"] = payload.password
    if payload.private_key:
        credentials["private_key"] = payload.private_key
    return credentials


def create_device(db: DbSession, owner: User, payload: DeviceCreate) -> Device:
    if payload.connection_type == "smb":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="SMB is reserved for the next milestone.")
    credentials = _credential_payload(payload)
    if payload.auth_method == "password" and not credentials.get("password"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Password is required.")
    if payload.auth_method == "ssh_key" and not credentials.get("private_key"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Private key is required.")
    device = Device(
        owner_id=owner.id,
        name=payload.name,
        connection_type=payload.connection_type,
        host=payload.host,
        port=payload.port,
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
    credentials = decrypt_json(device.credentials_encrypted)
    credentials.update(_credential_payload(payload))
    device.credentials_encrypted = encrypt_json(credentials)
    db.commit()
    db.refresh(device)
    return device


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
    try:
        client = connect_ssh_device(device)
        return True, "SSH connection successful."
    except (paramiko.SSHException, socket.error, ValueError) as exc:
        return False, f"SSH connection failed: {exc}"
    finally:
        client.close()
