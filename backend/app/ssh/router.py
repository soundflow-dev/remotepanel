from __future__ import annotations

import socket

import paramiko
from fastapi import APIRouter, WebSocket
from fastapi import status as http_status
from sqlalchemy.orm import Session as DbSession

from app.auth.service import get_current_user_from_token
from app.config import settings
from app.database.session import SessionLocal
from app.devices.service import connect_ssh_device, get_device
from app.ssh.terminal import bridge_ssh_channel


router = APIRouter(prefix="/api/ssh", tags=["ssh"])


@router.get("/capabilities")
def capabilities():
    return {"terminal": "available", "transport": "backend-mediated SSH over WebSocket"}


@router.websocket("/{device_id}/terminal")
async def terminal(websocket: WebSocket, device_id: int):
    await websocket.accept()
    db: DbSession = SessionLocal()
    client = None
    try:
        token = websocket.cookies.get(settings.session_cookie_name)
        user = get_current_user_from_token(token, db)
        device = get_device(db, user, device_id)
        client = connect_ssh_device(device)
        await websocket.send_text(f"\r\nConnected to {device.name} ({device.host}).\r\n")
        await bridge_ssh_channel(websocket, client)
    except (paramiko.SSHException, socket.error, ValueError) as exc:
        await websocket.send_text(f"\r\nSSH terminal failed: {exc}\r\n")
        await websocket.close(code=1011)
    except Exception as exc:
        await websocket.send_text(f"\r\nTerminal session denied or failed: {exc}\r\n")
        await websocket.close(code=http_status.WS_1008_POLICY_VIOLATION)
    finally:
        if client:
            client.close()
        db.close()
