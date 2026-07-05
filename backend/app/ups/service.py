from __future__ import annotations

import json
import logging
import threading
import time
from datetime import datetime

from sqlalchemy.orm import Session as DbSession

from app.database.models import Device, UpsConfig, User
from app.database.session import SessionLocal
from app.devices.service import run_device_power_action
from app.security.crypto import decrypt_json, encrypt_json
from app.ups.nut import NutClient, NutError, NutStatus


logger = logging.getLogger(__name__)
_monitor_started = False
_monitor_lock = threading.Lock()


def utc_now() -> datetime:
    return datetime.utcnow()


def selected_device_ids(config: UpsConfig | None) -> list[int]:
    if not config:
        return []
    try:
        values = json.loads(config.selected_device_ids_json or "[]")
    except json.JSONDecodeError:
        return []
    return [int(value) for value in values if isinstance(value, int) or str(value).isdigit()]


def get_config(db: DbSession, owner: User) -> UpsConfig | None:
    return db.query(UpsConfig).filter(UpsConfig.owner_id == owner.id).first()


def upsert_config(
    db: DbSession,
    owner: User,
    *,
    enabled: bool,
    host: str,
    port: int,
    ups_name: str,
    username: str,
    password: str | None,
    battery_threshold: int,
    poll_interval_seconds: int,
    selected_ids: list[int],
) -> UpsConfig:
    config = get_config(db, owner)
    if config is None:
        config = UpsConfig(owner_id=owner.id)
        db.add(config)

    config.enabled = enabled
    config.host = host.strip()
    config.port = port
    config.ups_name = ups_name.strip()
    config.username = username.strip()
    if password is not None:
        config.credentials_encrypted = encrypt_json({"password": password}) if password else None
    config.battery_threshold = battery_threshold
    config.poll_interval_seconds = poll_interval_seconds
    config.selected_device_ids_json = json.dumps(selected_ids)
    config.updated_at = utc_now()
    db.commit()
    db.refresh(config)
    return config


def _password(config: UpsConfig) -> str:
    if not config.credentials_encrypted:
        return ""
    return str(decrypt_json(config.credentials_encrypted).get("password", ""))


def read_status(config: UpsConfig) -> NutStatus:
    if not config.host:
        raise NutError("NUT host is not configured.")
    with NutClient(config.host, config.port, config.username, _password(config)) as client:
        ups_name = config.ups_name
        if not ups_name:
            ups_items = client.list_ups()
            if not ups_items:
                raise NutError("No UPS devices were returned by the NUT server.")
            ups_name = ups_items[0][0]
        return client.status(ups_name)


def test_config(config: UpsConfig) -> tuple[bool, str, NutStatus | None]:
    try:
        status = read_status(config)
        label = status.status or "unknown"
        charge = "unknown" if status.charge is None else f"{status.charge}%"
        return True, f"NUT connected. UPS {status.ups_name}: {label}, battery {charge}.", status
    except Exception as exc:
        return False, str(exc), None


def update_last_status(db: DbSession, config: UpsConfig, status: NutStatus | None, error: str | None = None) -> None:
    config.last_status = status.status if status else None
    config.last_charge = status.charge if status else None
    config.last_error = error
    config.last_checked_at = utc_now()
    config.updated_at = utc_now()
    db.commit()


def _should_shutdown(config: UpsConfig, status: NutStatus) -> bool:
    ups_status = (status.status or "").upper().split()
    if status.charge is None:
        return False
    on_battery = "OB" in ups_status or "LB" in ups_status
    if not on_battery:
        return False
    if config.last_triggered_at and status.charge <= config.battery_threshold:
        return False
    return status.charge <= config.battery_threshold


def _reset_trigger_if_recovered(config: UpsConfig, status: NutStatus) -> None:
    ups_status = (status.status or "").upper().split()
    if "OL" in ups_status and status.charge is not None and status.charge >= min(100, config.battery_threshold + 5):
        config.last_triggered_at = None


def _shutdown_selected_devices(db: DbSession, config: UpsConfig) -> None:
    ids = selected_device_ids(config)
    if not ids:
        return
    devices = (
        db.query(Device)
        .filter(Device.owner_id == config.owner_id, Device.id.in_(ids), Device.connection_type == "ssh_sftp", Device.active.is_(True))
        .all()
    )
    for device in devices:
        try:
            ok, message = run_device_power_action(device, "shutdown")
            logger.info("UPS shutdown action for %s: %s %s", device.name, ok, message)
        except Exception:
            logger.exception("UPS shutdown action failed for %s", device.name)


def _monitor_once(db: DbSession) -> None:
    configs = db.query(UpsConfig).filter(UpsConfig.enabled.is_(True)).all()
    for config in configs:
        try:
            status = read_status(config)
            _reset_trigger_if_recovered(config, status)
            update_last_status(db, config, status)
            if _should_shutdown(config, status):
                config.last_triggered_at = utc_now()
                db.commit()
                _shutdown_selected_devices(db, config)
        except Exception as exc:
            logger.warning("UPS monitor failed for config %s: %s", config.id, exc)
            update_last_status(db, config, None, str(exc))


def _monitor_loop() -> None:
    while True:
        sleep_for = 60
        db = SessionLocal()
        try:
            configs = db.query(UpsConfig).filter(UpsConfig.enabled.is_(True)).all()
            if configs:
                sleep_for = min(max(config.poll_interval_seconds, 15) for config in configs)
                for config in configs:
                    try:
                        status = read_status(config)
                        _reset_trigger_if_recovered(config, status)
                        update_last_status(db, config, status)
                        if _should_shutdown(config, status):
                            config.last_triggered_at = utc_now()
                            db.commit()
                            _shutdown_selected_devices(db, config)
                    except Exception as exc:
                        logger.warning("UPS monitor failed for config %s: %s", config.id, exc)
                        update_last_status(db, config, None, str(exc))
        finally:
            db.close()
        time.sleep(sleep_for)


def start_ups_monitor() -> None:
    global _monitor_started
    with _monitor_lock:
        if _monitor_started:
            return
        thread = threading.Thread(target=_monitor_loop, name="ups-monitor", daemon=True)
        thread.start()
        _monitor_started = True
