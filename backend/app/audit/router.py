from __future__ import annotations

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session as DbSession

from app.audit.service import event_details
from app.auth.service import get_current_user
from app.database.models import AuditEvent, User
from app.database.session import get_db


router = APIRouter(prefix="/api/audit", tags=["audit"])


class AuditEventResponse(BaseModel):
    id: int
    actor_name: str
    action: str
    target_type: str
    target_name: str
    details: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime


def current_user(request: Request, db: DbSession = Depends(get_db)) -> User:
    return get_current_user(request, db)


@router.get("/events", response_model=list[AuditEventResponse])
def list_audit_events(
    limit: int = Query(default=100, ge=1, le=500),
    db: DbSession = Depends(get_db),
    user: User = Depends(current_user),
):
    events = (
        db.query(AuditEvent)
        .filter(AuditEvent.owner_id == user.id)
        .order_by(AuditEvent.created_at.desc(), AuditEvent.id.desc())
        .limit(limit)
        .all()
    )
    return [
        AuditEventResponse(
            id=event.id,
            actor_name=event.actor_name,
            action=event.action,
            target_type=event.target_type,
            target_name=event.target_name,
            details=event_details(event),
            created_at=event.created_at,
        )
        for event in events
    ]
