from __future__ import annotations

import json
from typing import Any

from sqlalchemy.orm import Session as DbSession

from app.database.models import AuditEvent, User


def log_event(
    db: DbSession,
    owner: User,
    action: str,
    target_type: str,
    target_name: str = "",
    details: dict[str, Any] | None = None,
) -> AuditEvent:
    event = AuditEvent(
        owner_id=owner.id,
        actor_name=owner.name,
        action=action,
        target_type=target_type,
        target_name=target_name,
        details_json=json.dumps(details or {}, separators=(",", ":"), sort_keys=True),
    )
    db.add(event)
    db.commit()
    db.refresh(event)
    return event


def event_details(event: AuditEvent) -> dict[str, Any]:
    if not event.details_json:
        return {}
    try:
        return json.loads(event.details_json)
    except json.JSONDecodeError:
        return {}
