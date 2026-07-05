from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.auth.router import router as auth_router
from app.config import settings
from app.database.models import Device, DeviceShare, Session, TransferJob, UpsConfig, User  # noqa: F401
from app.database.migrations import run_startup_migrations
from app.database.session import Base, engine
from app.devices.router import router as devices_router
from app.files.router import router as files_router
from app.ssh.router import router as ssh_router
from app.transfers.router import router as transfers_router
from app.ups.router import router as ups_router
from app.ups.service import start_ups_monitor


logging.basicConfig(level=logging.INFO)

Base.metadata.create_all(bind=engine)
run_startup_migrations()

app = FastAPI(title=settings.app_name)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:8080"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router)
app.include_router(devices_router)
app.include_router(files_router)
app.include_router(ssh_router)
app.include_router(transfers_router)
app.include_router(ups_router)


@app.on_event("startup")
def startup() -> None:
    start_ups_monitor()


@app.get("/api/health")
def health():
    return {
        "ok": True,
        "secret_configured": settings.has_persistent_secret,
        "app": settings.app_name,
    }


STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

if STATIC_DIR.exists():
    assets_dir = STATIC_DIR / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def frontend(path: str):
        if path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found.")
        requested = STATIC_DIR / path
        if path and requested.is_file():
            return FileResponse(requested)
        return FileResponse(STATIC_DIR / "index.html")
