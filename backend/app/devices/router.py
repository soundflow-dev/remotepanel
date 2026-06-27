from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response, status
from sqlalchemy.orm import Session as DbSession

from app.auth.service import get_current_user
from app.database.models import User
from app.database.session import get_db
from app.devices.schemas import DeviceCreate, DeviceResponse, DeviceShareCreate, DeviceShareResponse, DeviceShareUpdate, DeviceStatsResponse, DeviceTestResponse, DeviceUpdate
from app.devices.service import (
    create_device,
    create_device_share,
    delete_device,
    delete_device_share,
    get_device,
    get_device_stats,
    get_device_share,
    list_device_shares,
    list_devices,
    run_device_power_action,
    test_device_connection,
    test_smb_device,
    update_device,
    update_device_share,
)


router = APIRouter(prefix="/api/devices", tags=["devices"])


def current_user(request: Request, db: DbSession = Depends(get_db)) -> User:
    return get_current_user(request, db)


@router.get("", response_model=list[DeviceResponse])
def devices(db: DbSession = Depends(get_db), user: User = Depends(current_user)):
    return list_devices(db, user)


@router.post("", response_model=DeviceResponse, status_code=status.HTTP_201_CREATED)
def add_device(payload: DeviceCreate, db: DbSession = Depends(get_db), user: User = Depends(current_user)):
    return create_device(db, user, payload)


@router.patch("/{device_id}", response_model=DeviceResponse)
def patch_device(device_id: int, payload: DeviceUpdate, db: DbSession = Depends(get_db), user: User = Depends(current_user)):
    return update_device(db, user, device_id, payload)


@router.delete("/{device_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_device(device_id: int, db: DbSession = Depends(get_db), user: User = Depends(current_user)):
    delete_device(db, user, device_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{device_id}/test", response_model=DeviceTestResponse)
def test_device(device_id: int, db: DbSession = Depends(get_db), user: User = Depends(current_user)):
    device = get_device(db, user, device_id)
    ok, message = test_device_connection(device)
    return DeviceTestResponse(ok=ok, status=message)


@router.post("/{device_id}/actions/{action}", response_model=DeviceTestResponse)
def run_device_action(device_id: int, action: str, db: DbSession = Depends(get_db), user: User = Depends(current_user)):
    device = get_device(db, user, device_id)
    ok, message = run_device_power_action(device, action)
    return DeviceTestResponse(ok=ok, status=message)


@router.get("/{device_id}/stats", response_model=DeviceStatsResponse)
def device_stats(device_id: int, db: DbSession = Depends(get_db), user: User = Depends(current_user)):
    device = get_device(db, user, device_id)
    return get_device_stats(device)


@router.get("/{device_id}/shares", response_model=list[DeviceShareResponse])
def shares(device_id: int, db: DbSession = Depends(get_db), user: User = Depends(current_user)):
    return list_device_shares(db, user, device_id)


@router.post("/{device_id}/shares", response_model=DeviceShareResponse, status_code=status.HTTP_201_CREATED)
def add_share(device_id: int, payload: DeviceShareCreate, db: DbSession = Depends(get_db), user: User = Depends(current_user)):
    return create_device_share(db, user, device_id, payload)


@router.patch("/shares/{share_id}", response_model=DeviceShareResponse)
def patch_share(share_id: int, payload: DeviceShareUpdate, db: DbSession = Depends(get_db), user: User = Depends(current_user)):
    return update_device_share(db, user, share_id, payload)


@router.delete("/shares/{share_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_share(share_id: int, db: DbSession = Depends(get_db), user: User = Depends(current_user)):
    delete_device_share(db, user, share_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/shares/{share_id}/test", response_model=DeviceTestResponse)
def test_share(share_id: int, db: DbSession = Depends(get_db), user: User = Depends(current_user)):
    share = get_device_share(db, user, share_id)
    if share.connection_type == "smb":
        ok, message = test_smb_device(share)
        return DeviceTestResponse(ok=ok, status=message)
    return DeviceTestResponse(ok=False, status="No test is available for this share.")
