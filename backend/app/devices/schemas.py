from __future__ import annotations

from pydantic import BaseModel, Field


class DeviceShareCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    connection_type: str = Field(pattern="^smb$")
    connection_url: str = Field(min_length=1, max_length=4096)
    port: int = Field(default=445, ge=1, le=65535)
    username: str = Field(default="", max_length=120)
    auth_method: str = Field(default="password", pattern="^(none|password)$")
    password: str | None = Field(default=None, max_length=4096)
    active: bool = True


class DeviceShareUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    connection_url: str | None = Field(default=None, min_length=1, max_length=4096)
    port: int | None = Field(default=None, ge=1, le=65535)
    username: str | None = Field(default=None, max_length=120)
    auth_method: str | None = Field(default=None, pattern="^(none|password)$")
    password: str | None = Field(default=None, max_length=4096)
    active: bool | None = None


class DeviceShareResponse(BaseModel):
    id: int
    device_id: int
    name: str
    connection_type: str
    connection_url: str
    host: str
    port: int
    username: str
    auth_method: str
    active: bool

    model_config = {"from_attributes": True}


class DeviceCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    connection_type: str = Field(default="machine", pattern="^(machine|ssh_sftp|smb)$")
    connection_url: str | None = Field(default=None, max_length=4096)
    dashboard_url: str | None = Field(default=None, max_length=4096)
    host: str = Field(default="", max_length=255)
    mac_address: str | None = Field(default=None, max_length=32)
    port: int = Field(ge=1, le=65535)
    username: str = Field(default="", max_length=120)
    auth_method: str = Field(pattern="^(none|password|ssh_key)$")
    password: str | None = Field(default=None, max_length=4096)
    private_key: str | None = Field(default=None, max_length=20000)
    active: bool = True


class DeviceUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    host: str | None = Field(default=None, max_length=255)
    mac_address: str | None = Field(default=None, max_length=32)
    connection_url: str | None = Field(default=None, max_length=4096)
    dashboard_url: str | None = Field(default=None, max_length=4096)
    port: int | None = Field(default=None, ge=1, le=65535)
    username: str | None = Field(default=None, max_length=120)
    auth_method: str | None = Field(default=None, pattern="^(none|password|ssh_key)$")
    password: str | None = Field(default=None, max_length=4096)
    private_key: str | None = Field(default=None, max_length=20000)
    active: bool | None = None


class DeviceResponse(BaseModel):
    id: int
    name: str
    connection_type: str
    connection_url: str | None
    dashboard_url: str | None
    host: str
    mac_address: str | None
    port: int
    username: str
    auth_method: str
    active: bool
    sort_order: int = 0
    shares: list[DeviceShareResponse] = Field(default_factory=list)

    model_config = {"from_attributes": True}


class DeviceReorderRequest(BaseModel):
    device_ids: list[int] = Field(min_length=1)


class DeviceTestResponse(BaseModel):
    ok: bool
    status: str


class DeviceStatsResponse(BaseModel):
    cpu_model: str | None = None
    cpu_cores: int | None = None
    cpu_usage_percent: float | None = None
    cpu_core_usage_percent: list[float] = Field(default_factory=list)
    load_1m: float | None = None
    load_5m: float | None = None
    load_15m: float | None = None
    memory_total: int | None = None
    memory_available: int | None = None
    memory_used: int | None = None
    disk_total: int | None = None
    disk_used: int | None = None
    disk_available: int | None = None
    disk_mount: str | None = None
    uptime_seconds: int | None = None
