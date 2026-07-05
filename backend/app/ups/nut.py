from __future__ import annotations

import re
import socket
from dataclasses import dataclass


class NutError(Exception):
    pass


@dataclass(frozen=True)
class NutStatus:
    ups_name: str
    status: str | None
    charge: int | None
    runtime_seconds: int | None
    model: str | None


def _parse_quoted_value(line: str) -> str | None:
    match = re.search(r'"(.*)"\s*$', line)
    if not match:
        return None
    return match.group(1).replace(r'\"', '"')


class NutClient:
    def __init__(self, host: str, port: int = 3493, username: str = "", password: str = "", timeout: float = 5.0):
        self.host = host
        self.port = port
        self.username = username
        self.password = password
        self.timeout = timeout
        self._file = None
        self._socket = None

    def __enter__(self) -> "NutClient":
        self._socket = socket.create_connection((self.host, self.port), timeout=self.timeout)
        self._socket.settimeout(self.timeout)
        self._file = self._socket.makefile("rwb", buffering=0)
        if self.username:
            self._command(f'USERNAME "{self.username}"', allow_error=True)
        if self.password:
            self._command(f'PASSWORD "{self.password}"', allow_error=True)
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        if self._file:
            try:
                self._file.close()
            finally:
                self._file = None
        if self._socket:
            try:
                self._socket.close()
            finally:
                self._socket = None

    def _read_line(self) -> str:
        if not self._file:
            raise NutError("NUT connection is not open.")
        raw = self._file.readline()
        if not raw:
            raise NutError("NUT server closed the connection.")
        return raw.decode("utf-8", errors="replace").strip()

    def _command(self, command: str, allow_error: bool = False) -> str:
        if not self._file:
            raise NutError("NUT connection is not open.")
        self._file.write(command.encode("utf-8") + b"\n")
        line = self._read_line()
        if line.startswith("ERR ") and not allow_error:
            raise NutError(line[4:] or "NUT command failed.")
        return line

    def list_ups(self) -> list[tuple[str, str]]:
        self._command("LIST UPS")
        items: list[tuple[str, str]] = []
        while True:
            line = self._read_line()
            if line == "END LIST UPS":
                return items
            if line.startswith("UPS "):
                parts = line.split(" ", 2)
                name = parts[1] if len(parts) > 1 else ""
                description = _parse_quoted_value(line) or ""
                if name:
                    items.append((name, description))

    def get_var(self, ups_name: str, variable: str) -> str | None:
        line = self._command(f'GET VAR {ups_name} {variable}')
        if line.startswith("VAR "):
            return _parse_quoted_value(line)
        return None

    def status(self, ups_name: str) -> NutStatus:
        status = self.get_var(ups_name, "ups.status")
        charge_raw = self.get_var(ups_name, "battery.charge")
        runtime_raw = self.get_var(ups_name, "battery.runtime")
        model = self.get_var(ups_name, "ups.model")
        return NutStatus(
            ups_name=ups_name,
            status=status,
            charge=_int_or_none(charge_raw),
            runtime_seconds=_int_or_none(runtime_raw),
            model=model,
        )


def _int_or_none(value: str | None) -> int | None:
    if value is None:
        return None
    try:
        return int(float(value))
    except ValueError:
        return None
