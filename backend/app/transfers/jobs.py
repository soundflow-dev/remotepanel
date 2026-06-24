from __future__ import annotations

import json
from datetime import datetime

from sqlalchemy.orm import Session as DbSession

from app.database.models import Device, TransferJob, User
from app.database.session import SessionLocal
from app.transfers.files import TransferCancelled, measure_transfer_paths, transfer_file_paths


TERMINAL_STATUSES = {"completed", "failed", "cancelled"}


def utc_now() -> datetime:
    return datetime.utcnow()


def comparable_datetime(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value
    return value.replace(tzinfo=None)


def create_transfer_job(
    db: DbSession,
    owner: User,
    source_device: Device,
    destination_device: Device,
    source_paths: list[str],
    destination_path: str,
    action: str,
) -> TransferJob:
    job = TransferJob(
        owner_id=owner.id,
        source_device_id=source_device.id,
        destination_device_id=destination_device.id,
        source_device_name=source_device.name,
        destination_device_name=destination_device.name,
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
        .filter(TransferJob.owner_id == owner.id)
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

        source_device = db.query(Device).filter(Device.id == job.source_device_id, Device.owner_id == job.owner_id).first()
        destination_device = db.query(Device).filter(Device.id == job.destination_device_id, Device.owner_id == job.owner_id).first()
        if not source_device or not destination_device:
            job.status = "failed"
            job.error = "Source or destination device no longer exists."
            job.finished_at = utc_now()
            db.commit()
            return

        source_paths = json.loads(job.source_paths_json)
        job.status = "running"
        job.started_at = utc_now()
        job.last_progress_at = job.started_at
        db.commit()

        total_bytes, total_files = measure_transfer_paths(source_device, source_paths)
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
            if transferred_since_commit >= 1024 * 1024:
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
            source_device=source_device,
            destination_device=destination_device,
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
