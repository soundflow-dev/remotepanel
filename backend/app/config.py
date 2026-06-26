from __future__ import annotations

import base64
import hashlib
import logging
import os
import secrets
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings


logger = logging.getLogger(__name__)


class Settings(BaseSettings):
    app_name: str = "RemotePanel"
    data_dir: Path = Field(default=Path("/data"), validation_alias="DATA_DIR")
    app_secret_key: str | None = Field(default=None, validation_alias="APP_SECRET_KEY")
    session_cookie_name: str = "remotepanel_session"
    session_ttl_hours: int = 24
    login_max_attempts: int = 5
    login_lockout_minutes: int = 15
    cookie_secure: bool = Field(default=False, validation_alias="COOKIE_SECURE")

    @property
    def database_url(self) -> str:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        return f"sqlite:///{self.data_dir / 'remotepanel.db'}"

    @property
    def has_persistent_secret(self) -> bool:
        return bool(self.app_secret_key)

    @property
    def effective_secret(self) -> str:
        if self.app_secret_key:
            return self.app_secret_key
        warning = (
            "APP_SECRET_KEY is not set. Generated an ephemeral key for this process. "
            "Set APP_SECRET_KEY to a long random value before production use, otherwise "
            "sessions and encrypted device credentials will not survive restarts."
        )
        logger.warning(warning)
        return os.environ.setdefault("REMOTEPANEL_EPHEMERAL_SECRET", secrets.token_urlsafe(48))

    @property
    def fernet_key(self) -> bytes:
        digest = hashlib.sha256(self.effective_secret.encode("utf-8")).digest()
        return base64.urlsafe_b64encode(digest)


settings = Settings()
