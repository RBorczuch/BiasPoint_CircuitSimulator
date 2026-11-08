from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from bpt.api.security import Session
from bpt.app import create_app

TOKEN = "test-token"


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    # Per-user state (session, recent projects) goes to the test folder, never the real one.
    monkeypatch.setenv("BPT_SESSION_FILE", str(tmp_path / "session.json"))
    monkeypatch.setenv("BPT_LIBRARY_DIR", str(tmp_path / "libraries"))
    monkeypatch.setenv("BPT_RECOVERY_DIR", str(tmp_path / "recovery"))
    session = Session(host="127.0.0.1", port=8765, token=TOKEN)
    app = create_app(session, dev=True, scratch_root=tmp_path / "scratch")
    with TestClient(app, base_url="http://127.0.0.1:8765") as test_client:
        yield test_client
