"""Local-only access control.

The backend listens on loopback only, but any web page the user opens could still try
to reach it (CSRF, DNS rebinding). Every request therefore has to:

* carry a loopback ``Host`` header with the backend's port,
* come from an allowed ``Origin`` when the browser sends one,
* present the session token (header or cookie), except for public paths.

The token is written to a per-user session file so local tools (CLI, MCP server,
Vite dev proxy) can read it.
"""

import json
import os
import secrets
import sys
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path

from platformdirs import user_state_path
from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send
from starlette.websockets import WebSocketClose

from bpt import APP_NAME
from bpt.config import ORIGIN_HEADER, TOKEN_COOKIE, TOKEN_HEADER

PUBLIC_PATHS = frozenset({"/api/health"})

# Who sent the current request: "agent" (MCP server) or "user" (the GUI and everything else).
request_origin: ContextVar[str] = ContextVar("request_origin", default="user")


@dataclass(frozen=True)
class Session:
    """Connection details of a running backend."""

    host: str
    port: int
    token: str

    @property
    def base_url(self) -> str:
        return f"http://{self.host}:{self.port}"


def session_file() -> Path:
    """Per-user session file; ``BPT_SESSION_FILE`` overrides it (tests, multiple instances)."""
    override = os.environ.get("BPT_SESSION_FILE")
    if override:
        return Path(override)
    return user_state_path(APP_NAME, appauthor=False) / "session.json"


def create_session(host: str, port: int) -> Session:
    """Generate a fresh token and publish it in the session file."""
    session = Session(host=host, port=port, token=secrets.token_urlsafe(32))
    path = session_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"host": host, "port": port, "token": session.token}))
    if sys.platform != "win32":
        path.chmod(0o600)
    return session


def read_session() -> Session | None:
    """Session of the most recently started backend, if any."""
    try:
        data = json.loads(session_file().read_text())
        return Session(host=data["host"], port=int(data["port"]), token=data["token"])
    except (OSError, ValueError, KeyError):
        return None


class LocalAccessMiddleware:
    """Pure ASGI middleware enforcing the rules in the module docstring (HTTP and WS)."""

    def __init__(self, app: ASGIApp, *, session: Session, allowed_origins: frozenset[str]):
        self.app = app
        self.token = session.token
        self.allowed_hosts = {f"{name}:{session.port}" for name in ("127.0.0.1", "localhost")}
        self.allowed_origins = allowed_origins | {f"http://{h}" for h in self.allowed_hosts}

    def _rejection(self, scope: Scope) -> str | None:
        headers = Headers(scope=scope)
        if headers.get("host", "") not in self.allowed_hosts:
            return "host not allowed"
        origin = headers.get("origin")
        if origin is not None and origin not in self.allowed_origins:
            return "origin not allowed"
        if scope["path"] in PUBLIC_PATHS:
            return None
        presented = headers.get(TOKEN_HEADER) or _cookie(headers, TOKEN_COOKIE) or ""
        if not secrets.compare_digest(presented, self.token):
            return "missing or invalid session token"
        return None

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        reason = self._rejection(scope)
        if reason is None:
            agent = Headers(scope=scope).get(ORIGIN_HEADER) == "agent"
            token = request_origin.set("agent" if agent else "user")
            try:
                await self.app(scope, receive, send)
            finally:
                request_origin.reset(token)
        elif scope["type"] == "http":
            await JSONResponse({"detail": reason}, status_code=403)(scope, receive, send)
        else:
            await WebSocketClose(code=1008, reason=reason)(scope, receive, send)


def _cookie(headers: Headers, name: str) -> str | None:
    for part in headers.get("cookie", "").split(";"):
        key, _, value = part.strip().partition("=")
        if key == name:
            return value
    return None


def attachment(filename: str) -> dict[str, str]:
    """``Content-Disposition`` for a download named ``filename`` (any characters).

    Headers are Latin-1: "Wzmacniacz ł.csv" used to fail with a 500, and a quote or a newline
    in a project name would end the header. ASCII fallback plus the RFC 5987 UTF-8 name.
    """
    from urllib.parse import quote

    plain = "".join(c if 32 <= ord(c) < 127 and c not in '"\\' else "_" for c in filename)
    return {"content-disposition": f"attachment; filename=\"{plain}\"; "
            f"filename*=UTF-8''{quote(filename, safe='')}"}  # fmt: skip
