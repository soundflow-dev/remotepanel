from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta

from fastapi import HTTPException, Request, Response, status
from sqlalchemy import func
from sqlalchemy.orm import Session as DbSession

from app.auth.schemas import SetupRequest
from app.config import settings
from app.database.models import Session, User
from app.security.passwords import hash_password, verify_password


def users_exist(db: DbSession) -> bool:
    return db.query(func.count(User.id)).scalar() > 0


def create_initial_admin(db: DbSession, payload: SetupRequest) -> User:
    if users_exist(db):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Initial setup is already locked.")
    if payload.password != payload.confirm_password:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Passwords do not match.")
    user = User(
        name=payload.name,
        email=payload.email.lower() if payload.email else None,
        password_hash=hash_password(payload.password),
        is_admin=True,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_session(db: DbSession, user: User, response: Response) -> None:
    token = secrets.token_urlsafe(48)
    expires = datetime.utcnow() + timedelta(hours=settings.session_ttl_hours)
    db.add(Session(user_id=user.id, token_hash=hash_token(token), expires_at=expires))
    db.commit()
    response.set_cookie(
        key=settings.session_cookie_name,
        value=token,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        max_age=settings.session_ttl_hours * 3600,
        path="/",
    )


def authenticate(db: DbSession, identifier: str, password: str) -> User:
    normalized = identifier.strip().lower()
    if "@" in normalized:
        user = db.query(User).filter(User.email == normalized).first()
    else:
        user = db.query(User).filter(func.lower(User.name) == normalized).first()
    now = datetime.utcnow()
    generic_error = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid email or password.",
    )
    if not user:
        raise generic_error
    if user.locked_until and user.locked_until > now:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many failed login attempts. Try again later.",
        )
    if not verify_password(password, user.password_hash):
        user.failed_login_attempts += 1
        if user.failed_login_attempts >= settings.login_max_attempts:
            user.locked_until = now + timedelta(minutes=settings.login_lockout_minutes)
        db.commit()
        raise generic_error
    user.failed_login_attempts = 0
    user.locked_until = None
    db.commit()
    db.refresh(user)
    return user


def get_current_user(request: Request, db: DbSession) -> User:
    token = request.cookies.get(settings.session_cookie_name)
    return get_current_user_from_token(token, db)


def get_current_user_from_token(token: str | None, db: DbSession) -> User:
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required.")
    session = db.query(Session).filter(Session.token_hash == hash_token(token)).first()
    now = datetime.utcnow()
    if not session or session.expires_at <= now:
        if session:
            db.delete(session)
            db.commit()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Session expired.")
    return session.user


def logout(request: Request, response: Response, db: DbSession) -> None:
    token = request.cookies.get(settings.session_cookie_name)
    if token:
        session = db.query(Session).filter(Session.token_hash == hash_token(token)).first()
        if session:
            db.delete(session)
            db.commit()
    response.delete_cookie(settings.session_cookie_name, path="/")
