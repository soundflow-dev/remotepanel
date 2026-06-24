from __future__ import annotations

import asyncio
import threading
import time

import paramiko
from fastapi import WebSocket
from starlette.websockets import WebSocketDisconnect


async def bridge_ssh_channel(websocket: WebSocket, client: paramiko.SSHClient) -> None:
    channel = client.invoke_shell(term="xterm-256color", width=120, height=32)
    output_queue: asyncio.Queue[str | None] = asyncio.Queue()
    loop = asyncio.get_running_loop()
    stop = threading.Event()

    def read_from_ssh() -> None:
        try:
            while not stop.is_set():
                if channel.recv_ready():
                    data = channel.recv(8192)
                    if not data:
                        break
                    loop.call_soon_threadsafe(output_queue.put_nowait, data.decode("utf-8", errors="replace"))
                elif channel.closed or channel.exit_status_ready():
                    break
                else:
                    time.sleep(0.02)
        finally:
            loop.call_soon_threadsafe(output_queue.put_nowait, None)

    reader = threading.Thread(target=read_from_ssh, daemon=True)
    reader.start()

    async def send_to_browser() -> None:
        while True:
            output = await output_queue.get()
            if output is None:
                break
            await websocket.send_text(output)

    async def receive_from_browser() -> None:
        while True:
            data = await websocket.receive_text()
            if data:
                channel.send(data)

    sender = asyncio.create_task(send_to_browser())
    receiver = asyncio.create_task(receive_from_browser())
    done, pending = await asyncio.wait({sender, receiver}, return_when=asyncio.FIRST_COMPLETED)
    for task in pending:
        task.cancel()
    for task in done:
        try:
            task.result()
        except WebSocketDisconnect:
            pass
    stop.set()
    channel.close()
    client.close()
