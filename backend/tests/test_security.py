import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from tests.conftest import TOKEN


def test_protected_endpoint_requires_token(client: TestClient) -> None:
    assert client.get("/api/ping").status_code == 403
    assert client.get("/api/ping", headers={"x-bpt-token": "wrong"}).status_code == 403


def test_token_via_header_or_cookie(client: TestClient) -> None:
    assert client.get("/api/ping", headers={"x-bpt-token": TOKEN}).json() == {"pong": True}
    client.cookies.set("bpt_token", TOKEN)
    assert client.get("/api/ping").status_code == 200


def test_foreign_host_rejected_even_with_token(client: TestClient) -> None:
    # DNS rebinding: attacker's domain resolves to 127.0.0.1 but keeps its Host header.
    headers = {"x-bpt-token": TOKEN, "host": "evil.example:8765"}
    assert client.get("/api/ping", headers=headers).status_code == 403


def test_origin_allowlist(client: TestClient) -> None:
    ok = {"x-bpt-token": TOKEN, "origin": "http://localhost:5173"}
    bad = {"x-bpt-token": TOKEN, "origin": "https://evil.example"}
    assert client.get("/api/ping", headers=ok).status_code == 200
    assert client.get("/api/ping", headers=bad).status_code == 403


def test_websocket_rejected_without_token(client: TestClient) -> None:
    with pytest.raises(WebSocketDisconnect) as exc, client.websocket_connect("/ws"):
        pass
    assert exc.value.code == 1008
