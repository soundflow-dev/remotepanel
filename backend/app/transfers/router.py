from __future__ import annotations

import json
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session as DbSession

from app.auth.service import get_current_user
from app.database.models import TransferJob, User
from app.database.session import get_db
from app.devices.service import get_device, get_device_share
from app.transfers.files import transfer_file_paths
from app.transfers.jobs import cancel_transfer_job, create_transfer_job, dismiss_transfer_job, get_transfer_job, list_transfer_jobs, start_transfer_job_thread


router = APIRouter(prefix="/api/transfers", tags=["transfers"])


class FileTransferRequest(BaseModel):
    source_target_type: str = Field(default="device", pattern="^(device|share)$")
    destination_target_type: str = Field(default="device", pattern="^(device|share)$")
    source_device_id: int
    destination_device_id: int
    source_paths: list[str] = Field(min_length=1, max_length=200)
    destination_path: str = Field(default=".", min_length=1, max_length=4096)
    action: str = Field(pattern="^(copy|move)$")
    transfer_profile: str = Field(default="turbo", pattern="^(safe|balanced|turbo)$")


class TransferJobResponse(BaseModel):
    id: int
    source_device_id: int
    destination_device_id: int
    source_target_type: str
    destination_target_type: str
    source_device_name: str
    destination_device_name: str
    source_paths: list[str]
    destination_path: str
    action: str
    transfer_profile: str
    status: str
    total_bytes: int
    transferred_bytes: int
    total_files: int
    copied_files: int
    speed_bytes_per_second: int
    error: str | None
    result: dict | None
    created_at: datetime | None
    started_at: datetime | None
    last_progress_at: datetime | None
    finished_at: datetime | None
    dismissed_at: datetime | None


def current_user(request: Request, db: DbSession = Depends(get_db)) -> User:
    return get_current_user(request, db)


@router.get("/policy")
def transfer_policy():
    return {
        "name": "Transfers that just work",
        "defaults": [
            "copy file contents",
            "preserve basic timestamps when possible",
            "preserve basic permissions when safe",
            "ignore incompatible xattrs and ACLs",
            "never fail because of Apple metadata streams",
        ],
    }


@router.post("/sftp")
def transfer_sftp(
    payload: FileTransferRequest,
    db: DbSession = Depends(get_db),
    user: User = Depends(current_user),
):
    return transfer_files(payload, db, user)


@router.post("/files")
def transfer_files(
    payload: FileTransferRequest,
    db: DbSession = Depends(get_db),
    user: User = Depends(current_user),
):
    source_device = get_device(db, user, payload.source_device_id)
    destination_device = get_device(db, user, payload.destination_device_id)
    try:
        return transfer_file_paths(
            source_device=source_device,
            destination_device=destination_device,
            source_paths=payload.source_paths,
            destination_path=payload.destination_path,
            action=payload.action,
            transfer_profile=payload.transfer_profile,
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


def serialize_job(job: TransferJob) -> TransferJobResponse:
    return TransferJobResponse(
        id=job.id,
        source_device_id=job.source_device_id,
        destination_device_id=job.destination_device_id,
        source_target_type=job.source_target_type,
        destination_target_type=job.destination_target_type,
        source_device_name=job.source_device_name,
        destination_device_name=job.destination_device_name,
        source_paths=json.loads(job.source_paths_json),
        destination_path=job.destination_path,
        action=job.action,
        transfer_profile=job.transfer_profile,
        status=job.status,
        total_bytes=job.total_bytes,
        transferred_bytes=job.transferred_bytes,
        total_files=job.total_files,
        copied_files=job.copied_files,
        speed_bytes_per_second=job.speed_bytes_per_second,
        error=job.error,
        result=json.loads(job.result_json) if job.result_json else None,
        created_at=job.created_at,
        started_at=job.started_at,
        last_progress_at=job.last_progress_at,
        finished_at=job.finished_at,
        dismissed_at=job.dismissed_at,
    )


@router.post("/jobs", response_model=TransferJobResponse, status_code=status.HTTP_202_ACCEPTED)
def start_transfer_job(
    payload: FileTransferRequest,
    db: DbSession = Depends(get_db),
    user: User = Depends(current_user),
):
    source_target = get_device_share(db, user, payload.source_device_id) if payload.source_target_type == "share" else get_device(db, user, payload.source_device_id)
    destination_target = get_device_share(db, user, payload.destination_device_id) if payload.destination_target_type == "share" else get_device(db, user, payload.destination_device_id)
    job = create_transfer_job(
        db=db,
        owner=user,
        source_target=source_target,
        destination_target=destination_target,
        source_paths=payload.source_paths,
        destination_path=payload.destination_path,
        action=payload.action,
        transfer_profile=payload.transfer_profile,
        source_target_type=payload.source_target_type,
        destination_target_type=payload.destination_target_type,
    )
    start_transfer_job_thread(job.id)
    return serialize_job(job)


@router.get("/jobs", response_model=list[TransferJobResponse])
def transfer_jobs(
    limit: int = Query(default=20, ge=1, le=100),
    db: DbSession = Depends(get_db),
    user: User = Depends(current_user),
):
    return [serialize_job(job) for job in list_transfer_jobs(db, user, limit)]


@router.get("/jobs/{job_id}", response_model=TransferJobResponse)
def transfer_job(
    job_id: int,
    db: DbSession = Depends(get_db),
    user: User = Depends(current_user),
):
    job = get_transfer_job(db, user, job_id)
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transfer job not found.")
    return serialize_job(job)


@router.post("/jobs/{job_id}/cancel", response_model=TransferJobResponse)
def cancel_job(
    job_id: int,
    db: DbSession = Depends(get_db),
    user: User = Depends(current_user),
):
    job = cancel_transfer_job(db, user, job_id)
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transfer job not found.")
    return serialize_job(job)


@router.post("/jobs/{job_id}/dismiss", response_model=TransferJobResponse)
def dismiss_job(
    job_id: int,
    db: DbSession = Depends(get_db),
    user: User = Depends(current_user),
):
    try:
        job = dismiss_transfer_job(db, user, job_id)
        if not job:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transfer job not found.")
        return serialize_job(job)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
