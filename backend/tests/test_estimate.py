"""Run size before a run (Poprawki 20) and runs that save node voltages only (Poprawki 2)."""

import time

from fastapi.testclient import TestClient

from tests.test_api import H
from tests.test_golden import pytestmark as golden_marks

pytestmark = golden_marks


def _project(client: TestClient) -> str:
    pid = client.post("/api/projects", json={"name": "big"}, headers=H).json()["id"]
    text = "V1 a 0 SIN(0 1 1k)\nR1 a b 1k\nC1 b 0 1u"
    client.post(f"/api/projects/{pid}/circuit/import", json={"text": text}, headers=H)
    return str(pid)


def test_estimate_flags_a_huge_transient(client: TestClient) -> None:
    pid = _project(client)
    url = f"/api/projects/{pid}/analyses/estimate"
    big = client.post(url, json={"card": ".tran 10n 100m"}, headers=H).json()
    assert big["points"] == 10_000_001 and big["large"]
    smaller = client.post(url, json={"card": ".tran 10n 100m", "voltages_only": True},
                          headers=H).json()  # fmt: skip
    assert smaller["signals"] < big["signals"]
    assert not client.post(url, json={"card": ".tran 10u 10m"}, headers=H).json()["large"]


def test_voltages_only_run_has_no_device_currents(client: TestClient) -> None:
    pid = _project(client)
    body = {"card": ".tran 10u 2m", "voltages_only": True}
    job = client.post(f"/api/projects/{pid}/analyses/run", json=body, headers=H).json()
    for _ in range(400):
        info = client.get(f"/api/jobs/{job['job_id']}", headers=H).json()
        if info["status"] in ("ok", "error", "cancelled"):
            break
        time.sleep(0.05)
    assert info["status"] == "ok", info
    names = {
        s["name"] for s in client.get(f"/api/runs/{info['run_id']}", headers=H).json()["signals"]
    }
    assert {"V(a)", "V(b)", "I(V1)"} <= names  # node voltages and source currents stay
    assert "I(R1)" not in names and "I(C1)" not in names
