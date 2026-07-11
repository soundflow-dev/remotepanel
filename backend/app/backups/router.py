from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session as DbSession

from app.audit.service import log_event
from app.auth.service import get_current_user
from app.database.models import Device, DeviceShare, UpsConfig, User
from app.database.session import get_db


router = APIRouter(prefix="/api/backups", tags=["backups"])
BACKUP_VERSION = 1


class RestoreRequest(BaseModel):
    backup: dict[str, Any] = Field(default_factory=dict)
    replace_existing: bool = True


def current_user(request: Request, db: DbSession = Depends(get_db)) -> User:
    return get_current_user(request, db)


def _share_payload(share: DeviceShare) -> dict[str, Any]:
    return {
        "name": share.name,
        "connection_type": share.connection_type,
        "connection_url": share.connection_url,
        "host": share.host,
        "port": share.port,
        "username": share.username,
        "auth_method": share.auth_method,
        "credentials_encrypted": share.credentials_encrypted,
        "active": share.active,
    }


def _device_payload(device: Device) -> dict[str, Any]:
    return {
        "id": device.id,
        "name": device.name,
        "connection_type": device.connection_type,
        "connection_url": device.connection_url,
        "dashboard_url": device.dashboard_url,
        "host": device.host,
        "mac_address": device.mac_address,
        "port": device.port,
        "username": device.username,
        "auth_method": device.auth_method,
        "credentials_encrypted": device.credentials_encrypted,
        "active": device.active,
        "sort_order": device.sort_order,
        "shares": [_share_payload(share) for share in device.shares],
    }


def _ups_payload(config: UpsConfig | None) -> dict[str, Any] | None:
    if not config:
        return None
    return {
        "enabled": config.enabled,
        "host": config.host,
        "port": config.port,
        "ups_name": config.ups_name,
        "username": config.username,
        "credentials_encrypted": config.credentials_encrypted,
        "battery_threshold": config.battery_threshold,
        "poll_interval_seconds": config.poll_interval_seconds,
        "selected_device_ids_json": config.selected_device_ids_json,
    }


@router.get("/export")
def export_backup(db: DbSession = Depends(get_db), user: User = Depends(current_user)):
    devices = db.query(Device).filter(Device.owner_id == user.id).order_by(Device.sort_order.asc(), Device.name.asc()).all()
    config = db.query(UpsConfig).filter(UpsConfig.owner_id == user.id).first()
    backup = {
        "app": "RemotePanel",
        "version": BACKUP_VERSION,
        "created_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "requires_same_app_secret_key": True,
        "owner": {"name": user.name, "email": user.email},
        "devices": [_device_payload(device) for device in devices],
        "ups_config": _ups_payload(config),
    }
    log_event(db, user, "backup.exported", "backup", "RemotePanel backup", {"devices": len(devices)})
    filename = f"remotepanel-backup-{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}.json"
    return JSONResponse(
        backup,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/restore")
def restore_backup(payload: RestoreRequest, db: DbSession = Depends(get_db), user: User = Depends(current_user)):
    backup = payload.backup
    if backup.get("app") != "RemotePanel":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="This does not look like a RemotePanel backup.")
    if int(backup.get("version", 0)) > BACKUP_VERSION:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="This backup was created by a newer RemotePanel version.")

    devices_payload = backup.get("devices") or []
    if not isinstance(devices_payload, list):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Backup devices are invalid.")

    if payload.replace_existing:
        device_ids = [row[0] for row in db.query(Device.id).filter(Device.owner_id == user.id).all()]
        if device_ids:
            db.query(DeviceShare).filter(DeviceShare.device_id.in_(device_ids)).delete(synchronize_session=False)
        db.query(Device).filter(Device.owner_id == user.id).delete(synchronize_session=False)
        db.query(UpsConfig).filter(UpsConfig.owner_id == user.id).delete(synchronize_session=False)
        db.flush()

    imported_devices = 0
    imported_shares = 0
    old_to_new_ids: dict[int, int] = {}
    for index, item in enumerate(devices_payload):
        if not isinstance(item, dict):
            continue
        device = Device(
            owner_id=user.id,
            name=str(item.get("name") or f"Imported device {index + 1}")[:120],
            connection_type=str(item.get("connection_type") or "ssh_sftp")[:32],
            connection_url=item.get("connection_url"),
            dashboard_url=item.get("dashboard_url"),
            host=str(item.get("host") or "")[:255],
            mac_address=item.get("mac_address"),
            port=int(item.get("port") or 22),
            username=str(item.get("username") or "")[:120],
            auth_method=str(item.get("auth_method") or "none")[:32],
            credentials_encrypted=item.get("credentials_encrypted"),
            active=bool(item.get("active", True)),
            sort_order=int(item.get("sort_order") or ((index + 1) * 10)),
        )
        db.add(device)
        db.flush()
        if item.get("id"):
            old_to_new_ids[int(item["id"])] = device.id
        imported_devices += 1
        for share_item in item.get("shares") or []:
            if not isinstance(share_item, dict):
                continue
            share = DeviceShare(
                device_id=device.id,
                name=str(share_item.get("name") or "Imported share")[:120],
                connection_type=str(share_item.get("connection_type") or "smb")[:32],
                connection_url=str(share_item.get("connection_url") or ""),
                host=str(share_item.get("host") or device.host)[:255],
                port=int(share_item.get("port") or 445),
                username=str(share_item.get("username") or "")[:120],
                auth_method=str(share_item.get("auth_method") or "password")[:32],
                credentials_encrypted=share_item.get("credentials_encrypted"),
                active=bool(share_item.get("active", True)),
            )
            db.add(share)
            imported_shares += 1

    ups_payload = backup.get("ups_config")
    if isinstance(ups_payload, dict):
        selected_json = ups_payload.get("selected_device_ids_json") or "[]"
        try:
            old_selected = json.loads(selected_json)
            selected_json = json.dumps([old_to_new_ids.get(int(device_id), int(device_id)) for device_id in old_selected])
        except (TypeError, ValueError, json.JSONDecodeError):
            selected_json = "[]"
        config = UpsConfig(
            owner_id=user.id,
            enabled=bool(ups_payload.get("enabled", False)),
            host=str(ups_payload.get("host") or "")[:255],
            port=int(ups_payload.get("port") or 3493),
            ups_name=str(ups_payload.get("ups_name") or "")[:120],
            username=str(ups_payload.get("username") or "")[:120],
            credentials_encrypted=ups_payload.get("credentials_encrypted"),
            battery_threshold=int(ups_payload.get("battery_threshold") or 25),
            poll_interval_seconds=int(ups_payload.get("poll_interval_seconds") or 60),
            selected_device_ids_json=selected_json,
        )
        db.add(config)

    db.commit()
    log_event(
        db,
        user,
        "backup.restored",
        "backup",
        "RemotePanel backup",
        {"devices": imported_devices, "shares": imported_shares, "replace_existing": payload.replace_existing},
    )
    return {"ok": True, "devices": imported_devices, "shares": imported_shares}
