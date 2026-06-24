from __future__ import annotations

import json
from datetime import datetime

from sqlalchemy.orm import Session as DbSession

from app.database.models import Device, TransferJob, User
from app.database.session import SessionLocal
from app.transfers.files import TransferCancelled, measure_transfer_paths, transfer_file_paths


TERMINAL_STATUSES = {"completed", "failed", "cancelled"}
PROGRESS_COMMIT_BYTES = 16 * 1024 * 1024


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
    if job.status not in TERMINAL_STATUSES:
        raise ValueError("Only completed, failed, or cancelled transfers can be hidden.")
    job.dismissed_at = utc_now()
    db.commit()
    db.refresh(job)
    return job


def _load_target(db: DbSession, owner_id: int, target_type: str, target_id: int):
    if target_type == "share":
        from app.database.models import DeviceShare

        return db.query(DeviceShare).join(Device).filter(DeviceShare.id == target_id, Device.owner_id == owner_id).first()
    return db.query(Device).filter(Device.id == target_id, Device.owner_id == owner_id).first()


def run_transfer_job(job_id: int) -> None:
    db = SessionLocal()
    transferred_since_commit = 0
    last_speed_sample_bytes = 0
    last_speed_sample_at: datetime | None = None
    try:
        job = db.query(TransferJob).filter(TransferJob.id == job_id).first()
        if not job:
            return
        if job.status == "cancelling":
            job.status = "cancelled"
            job.error = "Transfer cancelled."
            job.finished_at = utc_now()
            db.commit()
            return

        source_target = _load_target(db, job.owner_id, job.source_target_type, job.source_device_id)
        destination_target = _load_target(db, job.owner_id, job.destination_target_type, job.destination_device_id)
        if not source_target or not destination_target:
            job.status = "failed"
            job.error = "Source or destination no longer exists."
            job.finished_at = utc_now()
            db.commit()
            return

        source_paths = json.loads(job.source_paths_json)
        job.status = "running"
        job.started_at = utc_now()
        job.last_progress_at = job.started_at
        db.commit()

        total_bytes, total_files = measure_transfer_paths(source_target, source_paths)
        status_value = db.query(TransferJob.status).filter(TransferJob.id == job_id).scalar()
        if status_value == "cancelling":
            raise TransferCancelled("Transfer cancelled.")
        job.total_bytes = total_bytes
        job.total_files = total_files
        db.commit()

        def progress(bytes_written: int) -> None:
            nonlocal last_speed_sample_at, last_speed_sample_bytes, transferred_since_commit
            job.transferred_bytes += bytes_written
            transferred_since_commit += bytes_written
            if transferred_since_commit >= PROGRESS_COMMIT_BYTES:
                now = utc_now()
                if last_speed_sample_at is None:
                    last_speed_sample_at = comparable_datetime(job.started_at) if job.started_at else now
                    last_speed_sample_bytes = job.transferred_bytes - transferred_since_commit
                elapsed = max((now - last_speed_sample_at).total_seconds(), 0.001)
                bytes_delta = max(job.transferred_bytes - last_speed_sample_bytes, 0)
                job.speed_bytes_per_second = int(bytes_delta / elapsed)
                job.last_progress_at = now
                last_speed_sample_at = now
                last_speed_sample_bytes = job.transferred_bytes
                transferred_since_commit = 0
                db.commit()

        def should_cancel() -> bool:
            status_value = db.query(TransferJob.status).filter(TransferJob.id == job_id).scalar()
            return status_value == "cancelling"

        result = transfer_file_paths(
            source_device=source_target,
            destination_device=destination_target,
            source_paths=source_paths,
            destination_path=job.destination_path,
            action=job.action,
            progress=progress,
            should_cancel=should_cancel,
        )
        job.transferred_bytes = max(job.transferred_bytes, job.total_bytes)
        job.speed_bytes_per_second = 0
        job.copied_files = result.get("files_copied", 0)
        job.result_json = json.dumps(result)
        job.status = "completed"
        job.finished_at = utc_now()
        db.commit()
    except TransferCancelled as exc:
        job = db.query(TransferJob).filter(TransferJob.id == job_id).first()
        if job:
            job.status = "cancelled"
            job.speed_bytes_per_second = 0
            job.error = str(exc)
            job.finished_at = utc_now()
            db.commit()
    except Exception as exc:
        job = db.query(TransferJob).filter(TransferJob.id == job_id).first()
        if job:
            job.status = "failed"
            job.speed_bytes_per_second = 0
            job.error = str(exc)
            job.finished_at = utc_now()
            db.commit()
    finally:
        db.close()
