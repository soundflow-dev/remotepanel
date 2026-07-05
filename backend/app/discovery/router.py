from __future__ import annotations

import ipaddress
import fcntl
import os
import re
import socket
import struct
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session as DbSession

from app.audit.service import log_event
from app.auth.service import get_current_user
from app.database.models import Device, User
from app.database.session import get_db


router = APIRouter(prefix="/api/discovery", tags=["discovery"])


class DiscoveryHost(BaseModel):
    ip: str
    hostname: str | None = None
    mac_address: str | None = None
    open_ports: list[int] = Field(default_factory=list)
    suggested_type: str = "machine"
    already_added: bool = False


MAC_ADDRESS_RE = re.compile(r"(?i)(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}")
COMPACT_MAC_RE = re.compile(r"(?i)^[0-9a-f]{12}$")
MAC_TOKEN_RE = re.compile(r"(?i)(?:^|[^0-9a-f])([0-9a-f]{12})(?:[^0-9a-f]|$)")


def _format_mac(value: str | None) -> str | None:
    if not value:
        return None
    compact = re.sub(r"[^0-9a-fA-F]", "", value).lower()
    if not COMPACT_MAC_RE.match(compact) or compact == "0" * 12:
        return None
    return ":".join(compact[index : index + 2] for index in range(0, 12, 2))


def _looks_like_mac(value: str | None) -> bool:
    if not value:
        return False
    stripped = value.strip()
    compact = re.sub(r"[^0-9a-fA-F]", "", stripped)
    return bool(MAC_ADDRESS_RE.search(stripped) or COMPACT_MAC_RE.fullmatch(compact) or MAC_TOKEN_RE.search(stripped))


def _read_arp_file(path: str, ip: str) -> str | None:
    try:
        with open(path, encoding="utf-8") as handle:
            next(handle, None)
            for line in handle:
                parts = line.split()
                if len(parts) >= 4 and parts[0] == ip:
                    return _format_mac(parts[3])
    except OSError:
        return None
    return None


def _interface_ipv4(interface: str) -> str | None:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            request = struct.pack("256s", interface[:15].encode("utf-8"))
            response = fcntl.ioctl(sock.fileno(), 0x8915, request)
            return socket.inet_ntoa(response[20:24])
    except OSError:
        return None


def _local_mac(ip: str) -> str | None:
    for _, interface in socket.if_nameindex():
        if _interface_ipv4(interface) != ip:
            continue
        try:
            with open(f"/sys/class/net/{interface}/address", encoding="utf-8") as handle:
                return _format_mac(handle.read().strip())
        except OSError:
            return None
    return None


def _arp_mac(ip: str) -> str | None:
    local_mac = _local_mac(ip)
    if local_mac:
        return local_mac

    paths = [
        os.environ.get("HOST_ARP_PATH", "/host/proc/net/arp"),
        "/proc/net/arp",
    ]
    for path in dict.fromkeys(paths):
        mac = _read_arp_file(path, ip)
        if mac:
            return mac
    try:
        output = subprocess.run(
            ["ip", "neigh", "show", ip],
            check=False,
            capture_output=True,
            text=True,
            timeout=1,
        ).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    match = MAC_ADDRESS_RE.search(output)
    return _format_mac(match.group(0)) if match else None


def current_user(request: Request, db: DbSession = Depends(get_db)) -> User:
    return get_current_user(request, db)


def _port_open(ip: str, port: int, timeout: float) -> bool:
    try:
        with socket.create_connection((ip, port), timeout=timeout):
            return True
    except OSError:
        return False


def _hostname(ip: str) -> str | None:
    try:
        name, _, _ = socket.gethostbyaddr(ip)
        clean_name = name.rstrip(".").strip()
        if _looks_like_mac(clean_name):
            return None
        return clean_name or None
    except OSError:
        return None


def _scan_ip(ip: str, ports: list[int], timeout: float) -> DiscoveryHost | None:
    open_ports = [port for port in ports if _port_open(ip, port, timeout)]
    if not open_ports:
        return None
    suggested_type = "ssh_sftp" if 22 in open_ports else "machine"
    return DiscoveryHost(ip=ip, hostname=_hostname(ip), mac_address=_arp_mac(ip), open_ports=open_ports, suggested_type=suggested_type)


@router.get("/scan", response_model=list[DiscoveryHost])
def scan_network(
    network: str = Query(..., min_length=3, max_length=64),
    ports: str = Query(default="22,445,3389,80,443"),
    timeout: float = Query(default=0.4, ge=0.1, le=5),
    db: DbSession = Depends(get_db),
    user: User = Depends(current_user),
):
    try:
        parsed = ipaddress.ip_network(network, strict=False)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Network must be a valid CIDR range, for example 10.10.20.0/24.") from exc
    if parsed.version != 4:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only IPv4 discovery is supported for now.")
    hosts = [str(host) for host in parsed.hosts()]
    if len(hosts) > 512:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Discovery is limited to 512 addresses per scan.")
    try:
        port_values = sorted({int(value.strip()) for value in ports.split(",") if value.strip()})
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Ports must be comma-separated numbers.") from exc
    port_values = [port for port in port_values if 1 <= port <= 65535]
    if not port_values:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="At least one valid port is required.")

    existing_hosts = {device.host for device in db.query(Device).filter(Device.owner_id == user.id).all()}
    results: list[DiscoveryHost] = []
    with ThreadPoolExecutor(max_workers=min(64, max(4, len(hosts)))) as pool:
        futures = [pool.submit(_scan_ip, ip, port_values, timeout) for ip in hosts]
        for future in as_completed(futures):
            item = future.result()
            if item:
                item.already_added = item.ip in existing_hosts
                results.append(item)

    for item in results:
        if not item.mac_address:
            item.mac_address = _arp_mac(item.ip)

    results.sort(key=lambda item: tuple(int(part) for part in item.ip.split(".")))
    log_event(db, user, "discovery.scanned", "network", network, {"hosts_found": len(results), "ports": port_values})
    return results
