from __future__ import annotations

import ctypes
import gc
import json
import os
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy.orm import Session as DbSession

from app.database.models import Device, TransferEvent, TransferJob, User
from app.database.session import SessionLocal
from app.transfers.files import TransferCancelled, measure_transfer_paths, transfer_file_paths


TERMINAL_STATUSES = {"completed", "failed", "cancelled"}
DISMISSABLE_STATUSES = TERMINAL_STATUSES | {"cancelling"}


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


TRANSFER_MEMORY_TRIM_BYTES = _positive_int_env("TRANSFER_MEMORY_TRIM_BYTES", 50 * 1024 * 1024 * 1024, 0, 1024 * 1024 * 1024 * 1024)
TRANSFER_MEMORY_TRIM_PAUSE_SECONDS = _positive_float_env("TRANSFER_MEMORY_TRIM_PAUSE_SECONDS", 1.0, 0.0, 30.0)
TRANSFER_MEMORY_DEEP_TRIM_BYTES = _positive_int_env("TRANSFER_MEMORY_DEEP_TRIM_BYTES", 200 * 1024 * 1024 * 1024, 0, 1024 * 1024 * 1024 * 1024)
TRANSFER_MEMORY_DEEP_TRIM_PAUSE_SECONDS = _positive_float_env("TRANSFER_MEMORY_DEEP_TRIM_PAUSE_SECONDS", 5.0, 0.0, 60.0)
TRANSFER_MEMORY_DEEP_TRIM_PASSES = _positive_int_env("TRANSFER_MEMORY_DEEP_TRIM_PASSES", 3, 1, 10)
PROGRESS_COMMIT_BYTES = _positive_int_env("TRANSFER_PROGRESS_COMMIT_BYTES", 256 * 1024 * 1024, 16 * 1024 * 1024, 1024 * 1024 * 1024)
PROGRESS_COMMIT_SECONDS = _positive_float_env("TRANSFER_PROGRESS_COMMIT_SECONDS", 2.0, 0.2, 30.0)
TRANSFER_CANCEL_CHECK_SECONDS = _positive_float_env("TRANSFER_CANCEL_CHECK_SECONDS", 1.0, 0.1, 10.0)
TRANSFER_STALL_TIMEOUT_SECONDS = _positive_float_env("TRANSFER_STALL_TIMEOUT_SECONDS", 300.0, 30.0, 3600.0)
TRANSFER_WORKER_RESTARTS = _positive_int_env("TRANSFER_WORKER_RESTARTS", 5, 0, 20)
_memory_trim_bytes_since_release = 0
_memory_deep_trim_bytes_since_release = 0
_memory_trim_progress_lock = threading.Lock()
_memory_trim_run_lock = threading.Lock()


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
    transfer_profile: str
    status: str


def utc_now() -> datetime:
    return datetime.utcnow()


def _target_display_name(target, target_type: str) -> str:
    if target_type == "share":
        parent = getattr(target, "device", None)
        if parent and getattr(parent, "name", None):
            return f"{parent.name} / {target.name}"
    return target.name


def create_transfer_job(
    db: DbSession,
    owner: User,
    source_target,
    destination_target,
    source_paths: list[str],
    destination_path: str,
    action: str,
    transfer_profile: str = "turbo",
    source_target_type: str = "device",
    destination_target_type: str = "device",
) -> TransferJob:
    job = TransferJob(
        owner_id=owner.id,
        source_device_id=source_target.id,
        destination_device_id=destination_target.id,
        source_target_type=source_target_type,
        destination_target_type=destination_target_type,
        source_device_name=_target_display_name(source_target, source_target_type),
        destination_device_name=_target_display_name(destination_target, destination_target_type),
        source_paths_json=json.dumps(source_paths),
        destination_path=destination_path,
        action=action,
        transfer_profile=transfer_profile,
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
            transfer_profile=job.transfer_profile,
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


def record_transfer_event(
    job_id: int,
    event_type: str,
    message: str,
    source_path: str | None = None,
    destination_path: str | None = None,
    details: dict | None = None,
) -> None:
    db = SessionLocal()
    try:
        db.add(
            TransferEvent(
                job_id=job_id,
                event_type=event_type,
                message=message,
                source_path=source_path,
                destination_path=destination_path,
                details_json=json.dumps(details or {}),
            )
        )
        db.commit()
    finally:
        db.close()


def list_transfer_events(db: DbSession, owner: User, job_id: int) -> list[TransferEvent] | None:
    job = get_transfer_job(db, owner, job_id)
    if not job:
        return None
    return (
        db.query(TransferEvent)
        .filter(TransferEvent.job_id == job_id)
        .order_by(TransferEvent.created_at.asc(), TransferEvent.id.asc())
        .all()
    )


def _job_status(job_id: int) -> str | None:
    db = SessionLocal()
    try:
        return db.query(TransferJob.status).filter(TransferJob.id == job_id).scalar()
    finally:
        db.close()


def _job_error(job_id: int) -> str | None:
    db = SessionLocal()
    try:
        return db.query(TransferJob.error).filter(TransferJob.id == job_id).scalar()
    finally:
        db.close()


def _release_process_memory() -> None:
    gc.collect()
    try:
        ctypes.CDLL("libc.so.6").malloc_trim(0)
    except Exception:
        pass


def _next_memory_release_kind(bytes_written: int) -> str | None:
    global _memory_deep_trim_bytes_since_release, _memory_trim_bytes_since_release
    with _memory_trim_progress_lock:
        release_kind = None
        if TRANSFER_MEMORY_TRIM_BYTES:
            _memory_trim_bytes_since_release += bytes_written
            if _memory_trim_bytes_since_release >= TRANSFER_MEMORY_TRIM_BYTES:
                _memory_trim_bytes_since_release %= TRANSFER_MEMORY_TRIM_BYTES
                release_kind = "regular"
        if TRANSFER_MEMORY_DEEP_TRIM_BYTES:
            _memory_deep_trim_bytes_since_release += bytes_written
            if _memory_deep_trim_bytes_since_release >= TRANSFER_MEMORY_DEEP_TRIM_BYTES:
                _memory_deep_trim_bytes_since_release %= TRANSFER_MEMORY_DEEP_TRIM_BYTES
                release_kind = "deep"
        return release_kind


def _release_process_memory_with_pause(release_kind: str) -> None:
    passes = TRANSFER_MEMORY_DEEP_TRIM_PASSES if release_kind == "deep" else 1
    pause_seconds = TRANSFER_MEMORY_DEEP_TRIM_PAUSE_SECONDS if release_kind == "deep" else TRANSFER_MEMORY_TRIM_PAUSE_SECONDS
    with _memory_trim_run_lock:
        for _ in range(passes):
            _release_process_memory()
        if pause_seconds:
            time.sleep(pause_seconds)


def start_transfer_job_worker(job_id: int) -> None:
    def supervise() -> None:
        attempts = 0
        while True:
            try:
                process = subprocess.Popen([sys.executable, "-m", "app.transfers.worker", str(job_id)])
                return_code = process.wait()
            except Exception as exc:
                record_transfer_event(job_id, "worker_error", f"Failed to start transfer worker: {exc}")
                _update_job(job_id, status="failed", error=f"Failed to start transfer worker: {exc}", speed_bytes_per_second=0, finished_at=utc_now())
                return

            if return_code not in (2, 3):
                return

            attempts += 1
            status = _job_status(job_id)
            error = _job_error(job_id) or ""
            if status == "cancelling":
                _update_job(job_id, status="cancelled", error="Transfer cancelled.", speed_bytes_per_second=0, finished_at=utc_now())
                return
            if attempts > TRANSFER_WORKER_RESTARTS:
                record_transfer_event(job_id, "restart_exhausted", f"Transfer worker restart limit reached after {TRANSFER_WORKER_RESTARTS} retries.")
                return

            record_transfer_event(
                job_id,
                "restart",
                f"Restarting transfer worker ({attempts}/{TRANSFER_WORKER_RESTARTS}).",
                details={"return_code": return_code, "previous_error": error},
            )
            _update_job(
                job_id,
                status="pending",
                error=f"{error} Restarting transfer worker ({attempts}/{TRANSFER_WORKER_RESTARTS})...",
                speed_bytes_per_second=0,
                finished_at=None,
            )
            time.sleep(2)

    try:
        threading.Thread(target=supervise, name=f"transfer-worker-supervisor-{job_id}", daemon=True).start()
    except Exception as exc:
        record_transfer_event(job_id, "worker_error", f"Failed to start transfer worker: {exc}")
        _update_job(job_id, status="failed", error=f"Failed to start transfer worker: {exc}", speed_bytes_per_second=0, finished_at=utc_now())


def run_transfer_job(job_id: int, *, exit_on_stall: bool = False) -> str:
    context = _load_job_context(job_id)
    if not context:
        return "missing"
    transferred_bytes = 0
    last_speed_sample_bytes = 0
    last_speed_sample_at = time.monotonic()
    last_progress_commit_at = last_speed_sample_at
    transferred_since_commit = 0
    last_cancel_check_at = 0.0
    cancel_requested = False
    transfer_started = False
    last_activity_at = time.monotonic()
    done_event = threading.Event()
    progress_lock = threading.Lock()

    def watchdog() -> None:
        nonlocal last_activity_at
        while not done_event.wait(5):
            if not transfer_started:
                continue
            idle_seconds = time.monotonic() - last_activity_at
            if idle_seconds < TRANSFER_STALL_TIMEOUT_SECONDS:
                continue
            error = f"Transfer stalled: no progress for {int(idle_seconds)} seconds."
            record_transfer_event(job_id, "stall", error, details={"idle_seconds": int(idle_seconds)})
            _update_job(job_id, status="failed", error=error, speed_bytes_per_second=0, finished_at=utc_now())
            _release_process_memory()
            if exit_on_stall:
                os._exit(2)
            return

    if TRANSFER_STALL_TIMEOUT_SECONDS:
        threading.Thread(target=watchdog, name=f"transfer-watchdog-{job_id}", daemon=True).start()

    def flush_progress(force: bool = False) -> None:
        nonlocal last_progress_commit_at, last_speed_sample_at, last_speed_sample_bytes, transferred_since_commit
        now_monotonic = time.monotonic()
        if not force and transferred_since_commit < PROGRESS_COMMIT_BYTES and now_monotonic - last_progress_commit_at < PROGRESS_COMMIT_SECONDS:
            return
        now = utc_now()
        elapsed = max(now_monotonic - last_speed_sample_at, 0.001)
        bytes_delta = max(transferred_bytes - last_speed_sample_bytes, 0)
        speed_bytes_per_second = int(bytes_delta / elapsed)
        last_speed_sample_at = now_monotonic
        last_speed_sample_bytes = transferred_bytes
        last_progress_commit_at = now_monotonic
        transferred_since_commit = 0
        _update_job(
            job_id,
            transferred_bytes=transferred_bytes,
            speed_bytes_per_second=speed_bytes_per_second,
            last_progress_at=now,
        )

    try:
        if context.status == "cancelling":
            _update_job(job_id, status="cancelled", error="Transfer cancelled.", speed_bytes_per_second=0, finished_at=utc_now())
            return "cancelled"

        if not context.source_target or not context.destination_target:
            _update_job(job_id, status="failed", error="Source or destination no longer exists.", speed_bytes_per_second=0, finished_at=utc_now())
            return "failed"

        started_at = utc_now()
        record_transfer_event(job_id, "started", "Transfer started.", details={"profile": context.transfer_profile})
        _update_job(job_id, status="running", error=None, speed_bytes_per_second=0, started_at=started_at, last_progress_at=started_at)

        total_bytes, total_files = measure_transfer_paths(context.source_target, context.source_paths)
        if _job_status(job_id) == "cancelling":
            raise TransferCancelled("Transfer cancelled.")
        _update_job(job_id, total_bytes=total_bytes, total_files=total_files)

        def progress(bytes_written: int) -> None:
            nonlocal last_activity_at, transferred_bytes, transferred_since_commit
            with progress_lock:
                last_activity_at = time.monotonic()
                transferred_bytes += bytes_written
                transferred_since_commit += bytes_written
                flush_progress()
            release_kind = _next_memory_release_kind(bytes_written)
            if release_kind:
                _release_process_memory_with_pause(release_kind)

        def should_cancel() -> bool:
            nonlocal last_cancel_check_at, cancel_requested
            if cancel_requested:
                return True
            now = time.monotonic()
            if now - last_cancel_check_at < TRANSFER_CANCEL_CHECK_SECONDS:
                return False
            last_cancel_check_at = now
            cancel_requested = _job_status(job_id) == "cancelling"
            return cancel_requested

        transfer_started = True
        last_activity_at = time.monotonic()
        result = transfer_file_paths(
            source_device=context.source_target,
            destination_device=context.destination_target,
            source_paths=context.source_paths,
            destination_path=context.destination_path,
            action=context.action,
            transfer_profile=context.transfer_profile,
            progress=progress,
            should_cancel=should_cancel,
            event_callback=lambda event_type, message, source_path=None, destination_path=None, details=None: record_transfer_event(
                job_id,
                event_type,
                message,
                source_path,
                destination_path,
                details,
            ),
        )
        with progress_lock:
            flush_progress(force=True)
        _update_job(
            job_id,
            transferred_bytes=max(transferred_bytes, total_bytes),
            speed_bytes_per_second=0,
            copied_files=result.get("files_copied", 0),
            result_json=json.dumps(result),
            status="completed",
            finished_at=utc_now(),
        )
        record_transfer_event(job_id, "completed", "Transfer completed.", details={"files_copied": result.get("files_copied", 0)})
        return "completed"
    except TransferCancelled as exc:
        with progress_lock:
            flush_progress(force=True)
        record_transfer_event(job_id, "cancelled", str(exc))
        _update_job(job_id, status="cancelled", speed_bytes_per_second=0, error=str(exc), finished_at=utc_now())
        return "cancelled"
    except Exception as exc:
        with progress_lock:
            flush_progress(force=True)
        record_transfer_event(job_id, "failed", str(exc))
        _update_job(job_id, status="failed", speed_bytes_per_second=0, error=str(exc), finished_at=utc_now())
        return "failed"
    finally:
        done_event.set()
        _release_process_memory()
