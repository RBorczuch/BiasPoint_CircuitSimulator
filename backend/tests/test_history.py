"""History of undo steps: readable labels, who made them, jumping to a step."""

from fastapi.testclient import TestClient

from tests.conftest import TOKEN

H = {"X-BPT-Token": TOKEN}


def _labels(client: TestClient, pid: str) -> tuple[list[str], list[str]]:
    h = client.get(f"/api/projects/{pid}/history", headers=H).json()
    return [s["label"] for s in h["done"]], [s["label"] for s in h["undone"]]


def test_history_labels_and_jumps(client: TestClient) -> None:
    pid = client.post("/api/projects", json={"name": "h"}, headers=H).json()["id"]
    client.post(f"/api/projects/{pid}/circuit/import", json={"text": "R1 a 0 1k"}, headers=H)
    doc = client.get(f"/api/projects/{pid}/document", headers=H).json()["project"]
    r1 = next(i for i in doc["sheets"][0]["instances"] if i["ref"] == "R1")
    cmd = {"type": "set_params", "sheet": "root", "id": r1["id"], "params": {"R": "2k"}}
    client.post(f"/api/projects/{pid}/commands", json={"command": cmd}, headers=H)
    rot = {"type": "update_instance", "sheet": "root", "id": r1["id"], "rot": 90}
    client.post(f"/api/projects/{pid}/commands", json={"command": rot},
                headers={**H, "X-BPT-Origin": "agent"})  # fmt: skip
    done, undone = _labels(client, pid)
    assert done[-2:] == ["Set R1: R=2k", "Rotate R1"] and undone == []
    assert done[0] == "Import netlist"  # the import's own label
    history = client.get(f"/api/projects/{pid}/history", headers=H).json()
    assert [s["origin"] for s in history["done"]][-2:] == ["user", "agent"]

    # Back to just after the import, then forward again by one step.
    n = len(done)
    assert (
        client.post(f"/api/projects/{pid}/undo", params={"to": n - 2}, headers=H).status_code == 200
    )
    assert _labels(client, pid) == (done[:-2], ["Set R1: R=2k", "Rotate R1"])
    client.post(f"/api/projects/{pid}/undo", params={"to": n - 1}, headers=H)
    assert _labels(client, pid) == (done[:-1], ["Rotate R1"])
    bad = client.post(f"/api/projects/{pid}/undo", params={"to": n + 5}, headers=H)
    assert bad.status_code == 409
