from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from sqlalchemy import BigInteger, Boolean, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.session import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    email: Mapped[Optional[str]] = mapped_column(String(255), unique=True, nullable=True)
    password_hash: Mapped[str] = mapped_column(String(512), nullable=False)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    totp_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    totp_secret_encrypted: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    failed_login_attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    locked_until: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    sessions: Mapped[List["Session"]] = relationship(back_populates="user", cascade="all, delete-orphan")
    devices: Mapped[List["Device"]] = relationship(back_populates="owner", cascade="all, delete-orphan")
    transfer_jobs: Mapped[List["TransferJob"]] = relationship(back_populates="owner", cascade="all, delete-orphan")
    ups_config: Mapped[Optional["UpsConfig"]] = relationship(back_populates="owner", cascade="all, delete-orphan", uselist=False)


class Session(Base):
    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    token_hash: Mapped[str] = mapped_column(String(128), unique=True, nullable=False, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    user: Mapped[User] = relationship(back_populates="sessions")


class Device(Base):
    __tablename__ = "devices"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    connection_type: Mapped[str] = mapped_column(String(32), nullable=False)
    connection_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    host: Mapped[str] = mapped_column(String(255), nullable=False)
    mac_address: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)
    port: Mapped[int] = mapped_column(Integer, nullable=False)
    username: Mapped[str] = mapped_column(String(120), nullable=False)
    auth_method: Mapped[str] = mapped_column(String(32), nullable=False)
    credentials_encrypted: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    owner: Mapped[User] = relationship(back_populates="devices")
    shares: Mapped[List["DeviceShare"]] = relationship(back_populates="device", cascade="all, delete-orphan")


class DeviceShare(Base):
    __tablename__ = "device_shares"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    device_id: Mapped[int] = mapped_column(ForeignKey("devices.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    connection_type: Mapped[str] = mapped_column(String(32), nullable=False)
    connection_url: Mapped[str] = mapped_column(Text, nullable=False)
    host: Mapped[str] = mapped_column(String(255), nullable=False)
    port: Mapped[int] = mapped_column(Integer, nullable=False)
    username: Mapped[str] = mapped_column(String(120), default="", nullable=False)
    auth_method: Mapped[str] = mapped_column(String(32), default="none", nullable=False)
    credentials_encrypted: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    device: Mapped[Device] = relationship(back_populates="shares")


class TransferJob(Base):
    __tablename__ = "transfer_jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False, index=True)
    source_device_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    destination_device_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    source_target_type: Mapped[str] = mapped_column(String(16), default="device", nullable=False)
    destination_target_type: Mapped[str] = mapped_column(String(16), default="device", nullable=False)
    source_device_name: Mapped[str] = mapped_column(String(120), nullable=False)
    destination_device_name: Mapped[str] = mapped_column(String(120), nullable=False)
    source_paths_json: Mapped[str] = mapped_column(Text, nullable=False)
    destination_path: Mapped[str] = mapped_column(Text, nullable=False)
    action: Mapped[str] = mapped_column(String(16), nullable=False)
    transfer_profile: Mapped[str] = mapped_column(String(16), default="balanced", nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="pending", nullable=False, index=True)
    total_bytes: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    transferred_bytes: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    total_files: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    copied_files: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    speed_bytes_per_second: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    result_json: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    last_progress_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    dismissed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)

    owner: Mapped[User] = relationship(back_populates="transfer_jobs")


class TransferEvent(Base):
    __tablename__ = "transfer_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    job_id: Mapped[int] = mapped_column(ForeignKey("transfer_jobs.id"), nullable=False, index=True)
    event_type: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    source_path: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    destination_path: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    details_json: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class UpsConfig(Base):
    __tablename__ = "ups_configs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, index=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False, unique=True, index=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    host: Mapped[str] = mapped_column(String(255), default="", nullable=False)
    port: Mapped[int] = mapped_column(Integer, default=3493, nullable=False)
    ups_name: Mapped[str] = mapped_column(String(120), default="", nullable=False)
    username: Mapped[str] = mapped_column(String(120), default="", nullable=False)
    credentials_encrypted: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    battery_threshold: Mapped[int] = mapped_column(Integer, default=25, nullable=False)
    poll_interval_seconds: Mapped[int] = mapped_column(Integer, default=60, nullable=False)
    selected_device_ids_json: Mapped[str] = mapped_column(Text, default="[]", nullable=False)
    last_status: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    last_charge: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    last_error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    last_checked_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    last_triggered_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    owner: Mapped[User] = relationship(back_populates="ups_config")
