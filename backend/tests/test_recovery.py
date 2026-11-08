"""Autosave to the recovery folder and restoring unsaved projects after a restart (NFR-8)."""

from pathlib import Path
from typing import cast

from fastapi.testclient import TestClient

from bpt.api.security import Session
from bpt.app import create_app
from tests.conftest import TOKEN

H = {"X-BPT-Token": TOKEN}


def _app(tmp_path: Path, dev: bool = True) -> TestClient:
    session = Session(host="127.0.0.1", port=8765, token=TOKEN)
    app = create_app(
        session, dev=dev, scratch_root=tmp_path / "scratch", recovery_root=tmp_path / "recovery"
    )
    return TestClient(app, base_url="http://127.0.0.1:8765")


def _add_resistor(client: TestClient, project_id: str) -> None:
    r = client.post(f"/api/projects/{project_id}/circuit/import", json={"text": "R1 a 0 1k"},
                    headers=H)  # fmt: skip
    assert r.status_code == 200, r.text


def test_unsaved_project_survives_a_restart(tmp_path: Path) -> None:
    with _app(tmp_path) as client:
        pid = client.post("/api/projects", json={"name": "work"}, headers=H).json()["id"]
        _add_resistor(client, pid)
        state = client.app.state.bpt  # type: ignore[attr-defined]
        assert state.autosave() == 1
        assert state.autosave() == 0  # nothing changed since the copy
        assert client.get("/api/recovery", headers=H).json() == []  # open projects are not listed
    # (a crash would leave the same copy; a clean stop writes one too)

    with _app(tmp_path, dev=False) as client:  # normal mode: offered, not reopened
        entries = client.get("/api/recovery", headers=H).json()
        assert [(e["id"], e["name"]) for e in entries] == [(pid, "work")]
        info = client.post(f"/api/recovery/{pid}/restore", headers=H).json()
        assert info["id"] == pid and info["dirty"] is True
        doc = client.get(f"/api/projects/{pid}/document", headers=H).json()
        assert "R1" in [i["ref"] for i in doc["project"]["sheets"][0]["instances"]]

        # Saving the project removes its recovery copy.
        target = tmp_path / "saved"
        client.post(f"/api/projects/{pid}/save", json={"path": str(target)}, headers=H)
        assert not (tmp_path / "recovery" / pid).exists()


def test_dev_restart_reopens_saved_and_unsaved_projects(tmp_path: Path) -> None:
    with _app(tmp_path) as client:
        saved = client.post("/api/projects", json={"name": "saved"}, headers=H).json()["id"]
        client.post(f"/api/projects/{saved}/save", json={"path": str(tmp_path / "p")}, headers=H)
        unsaved = client.post("/api/projects", json={"name": "unsaved"}, headers=H).json()["id"]
        _add_resistor(client, unsaved)

    with _app(tmp_path) as client:  # --dev: everything comes back under the same ids
        projects = {p["id"]: p for p in client.get("/api/projects", headers=H).json()}
        assert projects[saved]["dirty"] is False and projects[saved]["path"] == str(tmp_path / "p")
        assert projects[unsaved]["dirty"] is True


def test_closing_a_project_drops_its_copy(tmp_path: Path) -> None:
    with _app(tmp_path) as client:
        state = client.app.state.bpt  # type: ignore[attr-defined]
        pid = client.post("/api/projects", json={"name": "x"}, headers=H).json()["id"]
        _add_resistor(client, pid)
        state.autosave()
        assert (tmp_path / "recovery" / pid).is_dir()
        client.delete(f"/api/projects/{pid}", headers=H)
        assert not (tmp_path / "recovery" / pid).exists()


def test_old_scratch_of_lost_projects_is_cleaned(tmp_path: Path) -> None:
    import os
    import time

    from bpt.api.state import AppState
    from bpt.engines.base import Engine

    state = AppState(cast(Engine, None), scratch_root=tmp_path / "scratch",
                     recovery_root=tmp_path / "rec")  # fmt: skip
    old, fresh = tmp_path / "scratch" / "old", tmp_path / "scratch" / "fresh"
    for folder in (old, fresh):
        (folder / "results").mkdir(parents=True)
    week_ago = time.time() - 8 * 86400
    os.utime(old, (week_ago, week_ago))
    assert state.clean_scratch() == 1
    assert not old.exists() and fresh.exists()
