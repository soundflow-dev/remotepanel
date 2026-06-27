from __future__ import annotations

import io
import re
import socket

import paramiko
from fastapi import HTTPException, status
from sqlalchemy.orm import Session as DbSession

from app.database.models import Device, DeviceShare, User
from app.devices.paths import parse_connection_path
from app.devices.schemas import DeviceCreate, DeviceShareCreate, DeviceShareUpdate, DeviceUpdate
from app.files.smb import list_smb_directory
from app.security.crypto import decrypt_json, encrypt_json


MAC_RE = re.compile(r"^[0-9a-f]{12}$")


def _credential_payload(payload: DeviceCreate | DeviceUpdate) -> dict[str, str]:
    credentials: dict[str, str] = {}
    if payload.password:
        credentials["password"] = payload.password
    if payload.private_key:
        credentials["private_key"] = payload.private_key
    return credentials


def normalize_mac_address(value: str | None) -> str | None:
    if value is None:
        return None
    compact = re.sub(r"[^0-9a-fA-F]", "", value).lower()
    if not compact:
        return None
    if not MAC_RE.match(compact):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="MAC address is invalid.")
    return ":".join(compact[index : index + 2] for index in range(0, 12, 2))


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
        mac_address=normalize_mac_address(payload.mac_address),
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
    if "mac_address" in payload.model_fields_set:
        device.mac_address = normalize_mac_address(payload.mac_address)
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


def send_wake_on_lan(device: Device) -> tuple[bool, str]:
    if not device.mac_address:
        return False, "Wake-on-LAN requires a MAC address on this machine."
    compact = device.mac_address.replace(":", "")
    packet = bytes.fromhex("ff" * 6 + compact * 16)
    targets = [("255.255.255.255", 9), ("255.255.255.255", 7)]
    if device.host and device.host.count(".") == 3:
        parts = device.host.split(".")
        targets.extend([(f"{parts[0]}.{parts[1]}.{parts[2]}.255", 9), (f"{parts[0]}.{parts[1]}.{parts[2]}.255", 7)])

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            for target in dict.fromkeys(targets):
                sock.sendto(packet, target)
        return True, "Wake-on-LAN packet sent."
    except OSError as exc:
        return False, f"Wake-on-LAN failed: {exc}"


def _parse_int(value: str | None) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(float(value))
    except ValueError:
        return None


def _parse_float(value: str | None) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except ValueError:
        return None


def get_device_stats(device: Device) -> dict[str, int | float | str | None]:
    if device.connection_type != "ssh_sftp":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Stats require SSH/SFTP access.")

    script = r"""
cpu_model=$(awk -F: '/model name|Hardware|Processor/ {gsub(/^[ \t]+/, "", $2); print $2; exit}' /proc/cpuinfo 2>/dev/null || true)
cpu_cores=$(nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo 2>/dev/null || echo "")
read load_1m load_5m load_15m _ </proc/loadavg 2>/dev/null || true
mem_total=$(awk '/MemTotal/ {print $2 * 1024}' /proc/meminfo 2>/dev/null || true)
mem_available=$(awk '/MemAvailable/ {print $2 * 1024}' /proc/meminfo 2>/dev/null || true)
if [ -z "$mem_available" ]; then
  mem_available=$(awk '/MemFree/ {print $2 * 1024}' /proc/meminfo 2>/dev/null || true)
fi
uptime_seconds=$(awk '{print int($1)}' /proc/uptime 2>/dev/null || true)
printf 'cpu_model=%s\n' "$cpu_model"
printf 'cpu_cores=%s\n' "$cpu_cores"
printf 'load_1m=%s\n' "$load_1m"
printf 'load_5m=%s\n' "$load_5m"
printf 'load_15m=%s\n' "$load_15m"
printf 'memory_total=%s\n' "$mem_total"
printf 'memory_available=%s\n' "$mem_available"
printf 'uptime_seconds=%s\n' "$uptime_seconds"
df -P -B1 / 2>/dev/null | awk 'NR==2 {print "disk_total="$2; print "disk_used="$3; print "disk_available="$4; print "disk_mount="$6}'
"""
    client = None
    try:
        client = connect_ssh_device(device)
        stdin, stdout, stderr = client.exec_command("sh -s", timeout=15)
        stdin.write(script)
        stdin.flush()
        stdin.close()
        code = stdout.channel.recv_exit_status()
        output = stdout.read().decode("utf-8", errors="replace")
        error = stderr.read().decode("utf-8", errors="replace").strip()
        if code != 0:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Stats failed: {error or 'command returned a non-zero exit code'}")
    except HTTPException:
        raise
    except (paramiko.SSHException, socket.error, ValueError) as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Stats failed: {exc}") from exc
    finally:
        if client:
            client.close()

    values: dict[str, str] = {}
    for line in output.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            values[key] = value.strip()

    memory_total = _parse_int(values.get("memory_total"))
    memory_available = _parse_int(values.get("memory_available"))
    memory_used = memory_total - memory_available if memory_total is not None and memory_available is not None else None
    return {
        "cpu_model": values.get("cpu_model") or None,
        "cpu_cores": _parse_int(values.get("cpu_cores")),
        "load_1m": _parse_float(values.get("load_1m")),
        "load_5m": _parse_float(values.get("load_5m")),
        "load_15m": _parse_float(values.get("load_15m")),
        "memory_total": memory_total,
        "memory_available": memory_available,
        "memory_used": memory_used,
        "disk_total": _parse_int(values.get("disk_total")),
        "disk_used": _parse_int(values.get("disk_used")),
        "disk_available": _parse_int(values.get("disk_available")),
        "disk_mount": values.get("disk_mount") or None,
        "uptime_seconds": _parse_int(values.get("uptime_seconds")),
    }


def run_device_power_action(device: Device, action: str) -> tuple[bool, str]:
    if action == "wake":
        return send_wake_on_lan(device)
    if action not in {"reboot", "shutdown"}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unsupported power action.")
    if device.connection_type != "ssh_sftp":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Power actions require SSH/SFTP access.")

    credentials = decrypt_json(device.credentials_encrypted)
    sudo_password = credentials.get("password") if device.auth_method == "password" else None
    sudo_prefix = "sudo -S -p ''" if sudo_password else "sudo -n"
    commands = {
        "reboot": f"(command -v ha >/dev/null 2>&1 && ha host reboot) || {sudo_prefix} /sbin/reboot || {sudo_prefix} reboot || /sbin/reboot || reboot",
        "shutdown": f"(command -v ha >/dev/null 2>&1 && ha host shutdown) || {sudo_prefix} /sbin/poweroff || {sudo_prefix} poweroff || {sudo_prefix} shutdown -h now || /sbin/poweroff || poweroff || shutdown -h now",
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
