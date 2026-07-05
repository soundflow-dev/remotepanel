from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session as DbSession

from app.auth.service import get_current_user
from app.database.models import User, UpsConfig
from app.database.session import get_db
from app.ups.service import get_config, read_status, selected_device_ids, test_config, update_last_status, upsert_config


router = APIRouter(prefix="/api/ups", tags=["ups"])


class UpsConfigRequest(BaseModel):
    enabled: bool = False
    host: str = Field(default="", max_length=255)
    port: int = Field(default=3493, ge=1, le=65535)
    ups_name: str = Field(default="", max_length=120)
    username: str = Field(default="", max_length=120)
    password: str | None = Field(default=None, max_length=4096)
    battery_threshold: int = Field(default=25, ge=1, le=100)
    poll_interval_seconds: int = Field(default=60, ge=15, le=3600)
    selected_device_ids: list[int] = Field(default_factory=list)


class UpsConfigResponse(BaseModel):
    enabled: bool
    host: str
    port: int
    ups_name: str
    username: str
    has_password: bool
    battery_threshold: int
    poll_interval_seconds: int
    selected_device_ids: list[int]
    last_status: str | None
    last_charge: int | None
    last_error: str | None
    last_checked_at: datetime | None
    last_triggered_at: datetime | None


class UpsStatusResponse(BaseModel):
    ok: bool
    message: str
    ups_name: str | None = None
    status: str | None = None
    charge: int | None = None
    runtime_seconds: int | None = None
    model: str | None = None


def current_user(request: Request, db: DbSession = Depends(get_db)) -> User:
    return get_current_user(request, db)


def default_config() -> UpsConfigResponse:
    return UpsConfigResponse(
        enabled=False,
        host="",
        port=3493,
        ups_name="",
        username="",
        has_password=False,
        battery_threshold=25,
        poll_interval_seconds=60,
        selected_device_ids=[],
        last_status=None,
        last_charge=None,
        last_error=None,
        last_checked_at=None,
        last_triggered_at=None,
    )


def serialize_config(config: UpsConfig | None) -> UpsConfigResponse:
    if config is None:
        return default_config()
    return UpsConfigResponse(
        enabled=config.enabled,
        host=config.host,
        port=config.port,
        ups_name=config.ups_name,
        username=config.username,
        has_password=bool(config.credentials_encrypted),
        battery_threshold=config.battery_threshold,
        poll_interval_seconds=config.poll_interval_seconds,
        selected_device_ids=selected_device_ids(config),
        last_status=config.last_status,
        last_charge=config.last_charge,
        last_error=config.last_error,
        last_checked_at=config.last_checked_at,
        last_triggered_at=config.last_triggered_at,
    )


@router.get("/config", response_model=UpsConfigResponse)
def ups_config(db: DbSession = Depends(get_db), user: User = Depends(current_user)):
    return serialize_config(get_config(db, user))


@router.put("/config", response_model=UpsConfigResponse)
def save_ups_config(payload: UpsConfigRequest, db: DbSession = Depends(get_db), user: User = Depends(current_user)):
    config = upsert_config(
        db,
        user,
        enabled=payload.enabled,
        host=payload.host,
        port=payload.port,
        ups_name=payload.ups_name,
        username=payload.username,
        password=payload.password,
        battery_threshold=payload.battery_threshold,
        poll_interval_seconds=payload.poll_interval_seconds,
        selected_ids=payload.selected_device_ids,
    )
    return serialize_config(config)


@router.post("/test", response_model=UpsStatusResponse)
def test_ups(db: DbSession = Depends(get_db), user: User = Depends(current_user)):
    config = get_config(db, user)
    if config is None:
        return UpsStatusResponse(ok=False, message="NUT is not configured.")
    ok, message, status = test_config(config)
    update_last_status(db, config, status, None if ok else message)
    if status is None:
        return UpsStatusResponse(ok=ok, message=message)
    return UpsStatusResponse(
        ok=ok,
        message=message,
        ups_name=status.ups_name,
        status=status.status,
        charge=status.charge,
        runtime_seconds=status.runtime_seconds,
        model=status.model,
    )


@router.get("/status", response_model=UpsStatusResponse)
def ups_status(db: DbSession = Depends(get_db), user: User = Depends(current_user)):
    config = get_config(db, user)
    if config is None:
        return UpsStatusResponse(ok=False, message="NUT is not configured.")
    try:
        status = read_status(config)
        update_last_status(db, config, status)
        return UpsStatusResponse(
            ok=True,
            message="NUT connected.",
            ups_name=status.ups_name,
            status=status.status,
            charge=status.charge,
            runtime_seconds=status.runtime_seconds,
            model=status.model,
        )
    except Exception as exc:
        message = str(exc)
        update_last_status(db, config, None, message)
        return UpsStatusResponse(ok=False, message=message)
