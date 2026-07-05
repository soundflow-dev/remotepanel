from __future__ import annotations

import ipaddress
import socket
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
    open_ports: list[int] = Field(default_factory=list)
    suggested_type: str = "machine"
    already_added: bool = False


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
        return name
    except OSError:
        return None


def _scan_ip(ip: str, ports: list[int], timeout: float) -> DiscoveryHost | None:
    open_ports = [port for port in ports if _port_open(ip, port, timeout)]
    if not open_ports:
        return None
    suggested_type = "ssh_sftp" if 22 in open_ports else "machine"
    return DiscoveryHost(ip=ip, hostname=_hostname(ip), open_ports=open_ports, suggested_type=suggested_type)


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

    results.sort(key=lambda item: tuple(int(part) for part in item.ip.split(".")))
    log_event(db, user, "discovery.scanned", "network", network, {"hosts_found": len(results), "ports": port_values})
    return results
