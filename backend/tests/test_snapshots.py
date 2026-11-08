"""Snapshots before AI agent changes, taken by hand, and going back to them (one undo step)."""

from fastapi.testclient import TestClient

from tests.conftest import TOKEN

USER = {"X-BPT-Token": TOKEN}
AGENT = {**USER, "X-BPT-Origin": "agent"}


def _refs(client: TestClient, pid: str) -> list[str]:
    doc = client.get(f"/api/projects/{pid}/document", headers=USER).json()["project"]
    return sorted(i["ref"] for i in doc["sheets"][0]["instances"] if not i["ref"].startswith("#"))


def _add(client: TestClient, pid: str, line: str, headers: dict[str, str]) -> None:
    r = client.post(f"/api/projects/{pid}/circuit/import", json={"text": line}, headers=headers)
    assert r.status_code == 200, r.text


def test_one_snapshot_per_series_of_agent_changes(client: TestClient) -> None:
    pid = client.post("/api/projects", json={"name": "s"}, headers=USER).json()["id"]
    _add(client, pid, "R1 a 0 1k", USER)
    assert client.get(f"/api/projects/{pid}/snapshots", headers=USER).json() == []

    _add(client, pid, "R2 a b 1k", AGENT)
    _add(client, pid, "R3 b 0 1k", AGENT)  # same series: no new snapshot
    shots = client.get(f"/api/projects/{pid}/snapshots", headers=USER).json()
    assert [(s["origin"], s["label"]) for s in shots] == [("agent", "Before AI agent changes")]

    _add(client, pid, "R4 b 0 1k", USER)
    _add(client, pid, "R5 b 0 1k", AGENT)  # after the user acted: a new series
    assert len(client.get(f"/api/projects/{pid}/snapshots", headers=USER).json()) == 2

    # Back to before the agent's first change; one undo returns to the current state.
    first = client.get(f"/api/projects/{pid}/snapshots", headers=USER).json()[-1]["id"]
    r = client.post(f"/api/projects/{pid}/snapshots/{first}/restore", headers=USER)
    assert r.status_code == 200, r.text
    assert _refs(client, pid) == ["R1"]
    client.post(f"/api/projects/{pid}/undo", headers=USER)
    assert _refs(client, pid) == ["R1", "R2", "R3", "R4", "R5"]


def test_snapshot_by_hand_and_delete(client: TestClient) -> None:
    pid = client.post("/api/projects", json={"name": "s"}, headers=USER).json()["id"]
    _add(client, pid, "R1 a 0 1k", USER)
    shot = client.post(f"/api/projects/{pid}/snapshots", json={"label": "  before tuning "},
                       headers=USER).json()  # fmt: skip
    assert shot["label"] == "before tuning" and shot["origin"] == "user"
    _add(client, pid, "R2 a 0 1k", USER)
    client.post(f"/api/projects/{pid}/snapshots/{shot['id']}/restore", headers=USER)
    assert _refs(client, pid) == ["R1"]
    client.delete(f"/api/projects/{pid}/snapshots/{shot['id']}", headers=USER)
    assert client.get(f"/api/projects/{pid}/snapshots", headers=USER).json() == []
