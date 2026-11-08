import struct
import time
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from tests.conftest import TOKEN
from tests.test_golden import pytestmark as ngspice_marks

pytestmark = ngspice_marks
H = {"x-bpt-token": TOKEN}

RC = """V1 in 0 DC 0 AC 1 PULSE(0 1 0 1n 1n 1 2)
R1 in out 1k
C1 out 0 1u
.tran 10u 5m
"""


def _wait(client: TestClient, job_id: str) -> dict[str, Any]:
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        job: dict[str, Any] = client.get(f"/api/jobs/{job_id}", headers=H).json()
        if job["status"] not in ("queued", "running"):
            return job
        time.sleep(0.02)
    raise AssertionError("job did not finish")


def test_project_flow(client: TestClient, tmp_path: Path) -> None:
    with client.websocket_connect("ws://127.0.0.1:8765/ws", headers=H) as ws:
        assert ws.receive_json()["type"] == "hello"
        pid = client.post("/api/projects", json={"name": "rc"}, headers=H).json()["id"]

        imported = client.post(
            f"/api/projects/{pid}/circuit/import", json={"text": RC}, headers=H
        ).json()
        assert imported["refs"] == ["V1", "R1", "C1"]
        assert imported["analyses"][0]["kind"] == "tran"
        assert ws.receive_json()["type"] == "doc.changed"

        text = client.get(f"/api/projects/{pid}/circuit/describe", headers=H).json()["text"]
        assert "R1 in out 1k" in text and "ERC: ok" in text

        job = client.post(
            f"/api/projects/{pid}/analyses/run",
            json={"analysis": imported["analyses"][0]},
            headers=H,
        ).json()
        job = _wait(client, job["job_id"])
        assert job["status"] == "ok", job
        run_id = job["run_id"]

    summary = client.get(f"/api/runs/{run_id}/summary?signals=V(out)", headers=H).json()["text"]
    assert "V(out): min 0V, max" in summary

    at_tau = client.post(f"/api/runs/{run_id}/measure", headers=H,
                         json={"signal": "V(out)", "op": "at", "at": 1e-3}).json()  # fmt: skip
    assert abs(at_tau["value"] - 0.632) < 1e-3

    plot = client.post(f"/api/runs/{run_id}/query", headers=H,
                       json={"signals": ["V(out)"], "pixels": 50}).json()  # fmt: skip
    assert len(plot["x"]) <= 51 and len(plot["series"]["V(out)"]["max"]) == len(plot["x"])

    body = {"signals": ["V(out)"], "pixels": 50, "format": "binary"}
    raw = client.post(f"/api/runs/{run_id}/query", headers=H, json=body).content
    (header_len,) = struct.unpack("<I", raw[:4])
    assert b'"part": "max"' in raw[4 : 4 + header_len]

    saved = client.post(f"/api/projects/{pid}/save", json={"path": str(tmp_path / "rc.bpt")},
                        headers=H).json()  # fmt: skip
    assert not saved["dirty"] and (tmp_path / "rc.bpt" / "sheets" / "root.json").is_file()


def test_erc_errors_fail_the_job_without_simulating(client: TestClient) -> None:
    pid = client.post("/api/projects", json={"name": "bad"}, headers=H).json()["id"]
    client.post(f"/api/projects/{pid}/circuit/components", headers=H,
                json={"symbol": "resistor", "nets": ["a", "b"]})  # fmt: skip
    job = client.post(f"/api/projects/{pid}/analyses/run", json={"analysis": {"kind": "op"}},
                      headers=H).json()  # fmt: skip
    assert job["status"] == "error"
    assert {"no-ground", "unconnected-pin"} <= {i["code"] for i in job["issues"]}


def test_undo_through_api(client: TestClient) -> None:
    pid = client.post("/api/projects", json={"name": "u"}, headers=H).json()["id"]
    client.post(f"/api/projects/{pid}/circuit/components", headers=H,
                json={"symbol": "resistor", "nets": ["a", "0"]})  # fmt: skip
    assert "R1" in client.get(f"/api/projects/{pid}/circuit/describe", headers=H).json()["text"]
    client.post(f"/api/projects/{pid}/undo", headers=H)
    assert "R1" not in client.get(f"/api/projects/{pid}/circuit/describe", headers=H).json()["text"]


def test_active_analysis_nets_and_values(client: TestClient) -> None:
    pid = client.post("/api/projects", json={"name": "op"}, headers=H).json()["id"]
    client.post(f"/api/projects/{pid}/circuit/import", headers=H,
                json={"text": "V1 in 0 DC 10\nR1 in out 1k\nR2 out 0 3k"})  # fmt: skip
    nets = client.get(f"/api/projects/{pid}/circuit/nets", headers=H).json()
    assert set(nets["wires"].values()) == {"in", "out", "0"}
    job = _wait(client, client.post(f"/api/projects/{pid}/analyses/run", json={},
                                    headers=H).json()["job_id"])  # fmt: skip
    values = client.get(f"/api/runs/{job['run_id']}/values", headers=H).json()["values"]
    assert values["V(out)"] == 7.5 and abs(values["I(R1)"] - 2.5e-3) < 1e-12


def test_file_browser_and_recent_projects(client: TestClient, tmp_path: Path) -> None:
    pid = client.post("/api/projects", json={"name": "browse"}, headers=H).json()["id"]
    (tmp_path / "work" / "sub").mkdir(parents=True)
    client.post(
        f"/api/projects/{pid}/save", json={"path": str(tmp_path / "work" / "amp.bpt")}, headers=H
    )
    listing = client.get("/api/fs/list", params={"path": str(tmp_path / "work")}, headers=H).json()
    assert [(e["name"], e["kind"]) for e in listing["entries"]] == [
        ("amp.bpt", "project"),
        ("sub", "dir"),
    ]
    assert listing["parent"] == str(tmp_path)
    recent = client.get("/api/fs/recent", headers=H).json()
    assert recent[0]["name"] == "amp"
