from __future__ import annotations

import ctypes
import gc
import json
import os
import threading
import time
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy.orm import Session as DbSession

from app.database.models import Device, TransferJob, User
from app.database.session import SessionLocal
from app.transfers.files import TransferCancelled, measure_transfer_paths, transfer_file_paths


TERMINAL_STATUSES = {"completed", "failed", "cancelled"}
DISMISSABLE_STATUSES = TERMINAL_STATUSES | {"cancelling"}
PROGRESS_COMMIT_BYTES = 16 * 1024 * 1024


def _positive_int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        return default
    return min(max(value, minimum), maximum)


def _positive_float_env(name: str, default: float, minimum: float, maximum: float) -> float:
    try:
        value = float(os.getenv(name, str(default)))
    except ValueError:
        return default
    return min(max(value, minimum), maximum)


TRANSFER_MEMORY_TRIM_BYTES = _positive_int_env("TRANSFER_MEMORY_TRIM_BYTES", 20 * 1024 * 1024 * 1024, 0, 1024 * 1024 * 1024 * 1024)
TRANSFER_MEMORY_TRIM_PAUSE_SECONDS = _positive_float_env("TRANSFER_MEMORY_TRIM_PAUSE_SECONDS", 1.0, 0.0, 30.0)


@dataclass(frozen=True)
class DeviceTargetSnapshot:
    id: int
    name: str
    connection_type: str
    connection_url: str | None
    host: str
    port: int
    username: str
    auth_method: str
    credentials_encrypted: str | None
    active: bool


@dataclass(frozen=True)
class ShareTargetSnapshot:
    id: int
    name: str
    connection_type: str
    connection_url: str | None
    host: str
    port: int
    username: str
    auth_method: str
    credentials_encrypted: str | None
    active: bool


@dataclass(frozen=True)
class TransferJobContext:
    owner_id: int
    source_target_type: str
    destination_target_type: str
    source_target_id: int
    destination_target_id: int
    source_target: DeviceTargetSnapshot | ShareTargetSnapshot | None
    destination_target: DeviceTargetSnapshot | ShareTargetSnapshot | None
    source_paths: list[str]
    destination_path: str
    action: str
    status: str


def utc_now() -> datetime:
    return datetime.utcnow()


def comparable_datetime(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value
    return value.replace(tzinfo=None)


def create_transfer_job(
    db: DbSession,
    owner: User,
    source_target,
    destination_target,
    source_paths: list[str],
    destination_path: str,
    action: str,
    source_target_type: str = "device",
    destination_target_type: str = "device",
) -> TransferJob:
    job = TransferJob(
        owner_id=owner.id,
        source_device_id=source_target.id,
        destination_device_id=destination_target.id,
        source_target_type=source_target_type,
        destination_target_type=destination_target_type,
        source_device_name=source_target.name,
        destination_device_name=destination_target.name,
        source_paths_json=json.dumps(source_paths),
        destination_path=destination_path,
        action=action,
        status="pending",
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    return job


def list_transfer_jobs(db: DbSession, owner: User, limit: int = 20) -> list[TransferJob]:
    return (
        db.query(TransferJob)
        .filter(TransferJob.owner_id == owner.id, TransferJob.dismissed_at.is_(None))
        .order_by(TransferJob.created_at.desc(), TransferJob.id.desc())
        .limit(limit)
        .all()
    )


def get_transfer_job(db: DbSession, owner: User, job_id: int) -> TransferJob | None:
    return db.query(TransferJob).filter(TransferJob.id == job_id, TransferJob.owner_id == owner.id).first()


def cancel_transfer_job(db: DbSession, owner: User, job_id: int) -> TransferJob | None:
    job = get_transfer_job(db, owner, job_id)
    if not job:
        return None
    if job.status in TERMINAL_STATUSES:
        return job
    job.status = "cancelling"
    job.speed_bytes_per_second = 0
    job.error = "Transfer cancellation requested."
    db.commit()
    db.refresh(job)
    return job


def dismiss_transfer_job(db: DbSession, owner: User, job_id: int) -> TransferJob | None:
    job = get_transfer_job(db, owner, job_id)
    if not job:
        return None
    if job.status not in DISMISSABLE_STATUSES:
        raise ValueError("Only completed, failed, cancelled, or cancelling transfers can be hidden.")
    job.dismissed_at = utc_now()
    db.commit()
    db.refresh(job)
    return job


def _load_target(db: DbSession, owner_id: int, target_type: str, target_id: int):
    if target_type == "share":
        from app.database.models import DeviceShare

        return db.query(DeviceShare).join(Device).filter(DeviceShare.id == target_id, Device.owner_id == owner_id).first()
    return db.query(Device).filter(Device.id == target_id, Device.owner_id == owner_id).first()


def _snapshot_target(target, target_type: str) -> DeviceTargetSnapshot | ShareTargetSnapshot | None:
    if not target:
        return None
    snapshot_class = ShareTargetSnapshot if target_type == "share" else DeviceTargetSnapshot
    return snapshot_class(
        id=target.id,
        name=target.name,
        connection_type=target.connection_type,
        connection_url=target.connection_url,
        host=target.host,
        port=target.port,
        username=target.username,
        auth_method=target.auth_method,
        credentials_encrypted=target.credentials_encrypted,
        active=target.active,
    )


def _load_job_context(job_id: int) -> TransferJobContext | None:
    db = SessionLocal()
    try:
        job = db.query(TransferJob).filter(TransferJob.id == job_id).first()
        if not job:
            return None
        source_target = _load_target(db, job.owner_id, job.source_target_type, job.source_device_id)
        destination_target = _load_target(db, job.owner_id, job.destination_target_type, job.destination_device_id)
        return TransferJobContext(
            owner_id=job.owner_id,
            source_target_type=job.source_target_type,
            destination_target_type=job.destination_target_type,
            source_target_id=job.source_device_id,
            destination_target_id=job.destination_device_id,
            source_target=_snapshot_target(source_target, job.source_target_type),
            destination_target=_snapshot_target(destination_target, job.destination_target_type),
            source_paths=json.loads(job.source_paths_json),
            destination_path=job.destination_path,
            action=job.action,
            status=job.status,
        )
    finally:
        db.close()


def _update_job(job_id: int, **values) -> None:
    db = SessionLocal()
    try:
        job = db.query(TransferJob).filter(TransferJob.id == job_id).first()
        if not job:
            return
        for key, value in values.items():
            setattr(job, key, value)
        db.commit()
    finally:
        db.close()


def _job_status(job_id: int) -> str | None:
    db = SessionLocal()
    try:
        return db.query(TransferJob.status).filter(TransferJob.id == job_id).scalar()
    finally:
        db.close()


def _release_process_memory() -> None:
    gc.collect()
    try:
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except Exception:
        pass


def run_transfer_job(job_id: int) -> None:
    context = _load_job_context(job_id)
    if not context:
        return
    transferred_since_commit = 0
    transferred_bytes = 0
    last_speed_sample_bytes = 0
    last_speed_sample_at: datetime | None = None
    next_memory_trim_at = TRANSFER_MEMORY_TRIM_BYTES
    progress_lock = threading.Lock()
    try:
        if context.status == "cancelling":
            _update_job(job_id, status="cancelled", error="Transfer cancelled.", speed_bytes_per_second=0, finished_at=utc_now())
            return

        if not context.source_target or not context.destination_target:
            _update_job(job_id, status="failed", error="Source or destination no longer exists.", speed_bytes_per_second=0, finished_at=utc_now())
            return

        started_at = utc_now()
        _update_job(job_id, status="running", error=None, speed_bytes_per_second=0, started_at=started_at, last_progress_at=started_at)

        total_bytes, total_files = measure_transfer_paths(context.source_target, context.source_paths)
        if _job_status(job_id) == "cancelling":
            raise TransferCancelled("Transfer cancelled.")
        _update_job(job_id, total_bytes=total_bytes, total_files=total_files)

        def progress(bytes_written: int) -> None:
            nonlocal last_speed_sample_at, last_speed_sample_bytes, next_memory_trim_at, transferred_bytes, transferred_since_commit
            should_release_memory = False
            with progress_lock:
                transferred_bytes += bytes_written
                transferred_since_commit += bytes_written
                if transferred_since_commit >= PROGRESS_COMMIT_BYTES:
                    now = utc_now()
                    if last_speed_sample_at is None:
                        last_speed_sample_at = comparable_datetime(started_at)
                        last_speed_sample_bytes = transferred_bytes - transferred_since_commit
                    elapsed = max((now - last_speed_sample_at).total_seconds(), 0.001)
                    bytes_delta = max(transferred_bytes - last_speed_sample_bytes, 0)
                    speed_bytes_per_second = int(bytes_delta / elapsed)
                    last_speed_sample_at = now
                    last_speed_sample_bytes = transferred_bytes
                    transferred_since_commit = 0
                    _update_job(
                        job_id,
                        transferred_bytes=transferred_bytes,
                        speed_bytes_per_second=speed_bytes_per_second,
                        last_progress_at=now,
                    )
                if TRANSFER_MEMORY_TRIM_BYTES and transferred_bytes >= next_memory_trim_at:
                    while next_memory_trim_at <= transferred_bytes:
                        next_memory_trim_at += TRANSFER_MEMORY_TRIM_BYTES
                    should_release_memory = True
            if should_release_memory:
                _release_process_memory()
                if TRANSFER_MEMORY_TRIM_PAUSE_SECONDS:
                    time.sleep(TRANSFER_MEMORY_TRIM_PAUSE_SECONDS)

        def should_cancel() -> bool:
            return _job_status(job_id) == "cancelling"

        result = transfer_file_paths(
            source_device=context.source_target,
            destination_device=context.destination_target,
            source_paths=context.source_paths,
            destination_path=context.destination_path,
            action=context.action,
            progress=progress,
            should_cancel=should_cancel,
        )
        _update_job(
            job_id,
            transferred_bytes=max(transferred_bytes, total_bytes),
            speed_bytes_per_second=0,
            copied_files=result.get("files_copied", 0),
            result_json=json.dumps(result),
            status="completed",
            finished_at=utc_now(),
        )
    except TransferCancelled as exc:
        _update_job(job_id, status="cancelled", speed_bytes_per_second=0, error=str(exc), finished_at=utc_now())
    except Exception as exc:
        _update_job(job_id, status="failed", speed_bytes_per_second=0, error=str(exc), finished_at=utc_now())
    finally:
        _release_process_memory()
