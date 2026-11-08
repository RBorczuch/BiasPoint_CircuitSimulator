"""Stress analysis (FR-SIM-7): ratings against the simulated voltages, currents and power."""

import time

import pytest
from fastapi.testclient import TestClient

from tests.test_api import H
from tests.test_golden import pytestmark as golden_marks

pytestmark = golden_marks


def _run(client: TestClient, pid: str, card: str) -> str:
    job = client.post(f"/api/projects/{pid}/analyses/run", json={"card": card}, headers=H).json()
    for _ in range(400):
        info = client.get(f"/api/jobs/{job['job_id']}", headers=H).json()
        if info["status"] in ("ok", "error", "cancelled"):
            break
        time.sleep(0.05)
    assert info["status"] == "ok", info
    return str(info["run_id"])


def _instance(client: TestClient, pid: str, ref: str) -> dict:  # type: ignore[type-arg]
    doc = client.get(f"/api/projects/{pid}/document", headers=H).json()["project"]
    return next(i for i in doc["sheets"][0]["instances"] if i["ref"] == ref)


def _rate(client: TestClient, pid: str, ref: str, **ratings: str) -> None:
    command = {"type": "update_instance", "sheet": "root", "id": _instance(client, pid, ref)["id"],
               "ratings": ratings}  # fmt: skip
    r = client.post(f"/api/projects/{pid}/commands", json={"command": command}, headers=H)
    assert r.status_code == 200, r.text


def test_capacitor_without_margin_and_overloaded_resistor(client: TestClient) -> None:
    pid = client.post("/api/projects", json={"name": "stress"}, headers=H).json()["id"]
    # 15 V on a 16 V capacitor; 0.4 W in a 0.25 W resistor (20 V across 1 kΩ).
    text = "V1 a 0 DC 15\nC1 a 0 10u\nR1 a 0 1k\nV2 b 0 DC 20\nR2 b 0 1k"
    client.post(f"/api/projects/{pid}/circuit/import", json={"text": text}, headers=H)
    _rate(client, pid, "C1", voltage="16")
    _rate(client, pid, "R1", power="0.25")
    _rate(client, pid, "R2", power="0.25")
    report = client.get(f"/api/projects/{pid}/runs/{_run(client, pid, '.op')}/stress",
                        headers=H).json()  # fmt: skip
    by = {(i["ref"], i["quantity"]): i for i in report["items"]}
    assert by[("C1", "voltage")]["status"] == "margin"  # 94 % of 16 V, the limit is 80 %
    assert by[("C1", "voltage")]["value"] == pytest.approx(15)
    assert by[("R1", "power")]["status"] == "margin"  # 0.225 W: 90 %, the limit is 50 %
    assert by[("R2", "power")]["status"] == "over"
    assert by[("R2", "power")]["value"] == pytest.approx(0.4)
    assert "overstressed" in by[("R2", "power")]["message"]

    # Looser margins: the capacitor passes.
    rules = {"voltage": 95, "current": 80, "power": 50, "temperature": 25, "ambient": 25}
    client.post(f"/api/projects/{pid}/commands", headers=H,
                json={"command": {"type": "set_stress_rules", "rules": rules}})  # fmt: skip
    report = client.get(f"/api/projects/{pid}/runs/{_run(client, pid, '.op')}/stress",
                        headers=H).json()  # fmt: skip
    by = {(i["ref"], i["quantity"]): i for i in report["items"]}
    assert by[("C1", "voltage")]["status"] == "ok"


def test_component_ratings_and_transient_rms(client: TestClient) -> None:
    body = {"template": "resistor", "form": {"Rnom": "100"}, "library": "Parts", "name": "R100",
            "ratings": {"power": "0.125"}}  # fmt: skip
    assert client.post("/api/components/from-template", json=body, headers=H).status_code == 200
    pid = client.post("/api/projects", json={"name": "rms"}, headers=H).json()["id"]
    client.post(f"/api/projects/{pid}/circuit/import", headers=H,
                json={"text": "V1 a 0 SIN(0 5 1k)\nR9 a 0 1meg"})  # fmt: skip
    prep = client.post(f"/api/projects/{pid}/components/prepare", json={"id": "cmp:Parts/R100"},
                       headers=H).json()  # fmt: skip
    commands = [{"type": "add_sheet", "sheet": s} for s in prep["sheets"]]
    r9 = _instance(client, pid, "R9")
    commands.append({"type": "update_instance", "sheet": "root", "id": r9["id"],
                     "symbol": f"sheet:{prep['top']}"})  # fmt: skip
    commands.append({"type": "set_params", "sheet": "root", "id": r9["id"], "params": {"R": None}})
    client.post(f"/api/projects/{pid}/commands", headers=H,
                json={"command": {"type": "transaction", "commands": commands}})  # fmt: skip
    run = _run(client, pid, ".tran 10u 10m")
    report = client.get(f"/api/projects/{pid}/runs/{run}/stress", headers=H).json()
    power = next(i for i in report["items"] if i["quantity"] == "power")
    # 5 V peak sine into 100 Ω: 125 mW on average, 100 % of the rating.
    assert power["value"] == pytest.approx(0.125, rel=0.02)
    assert power["status"] in ("margin", "over")


def test_part_with_parasitics_is_measured_on_itself(client: TestClient) -> None:
    """A resistor with Cp and Ls: the report used the parasitic (the last device of its id), and
    the node between R and Ls had no V(...) name, so nothing was reported."""
    pid = client.post("/api/projects", json={"name": "stress-cp"}, headers=H).json()["id"]
    client.post(f"/api/projects/{pid}/circuit/import", json={"text": "V1 b 0 DC 20\nR1 b 0 1k"},
                headers=H)  # fmt: skip
    r1 = _instance(client, pid, "R1")
    command = {"type": "set_params", "sheet": "root", "id": r1["id"],
               "params": {"cp": "1p", "ls": "1n"}}  # fmt: skip
    assert client.post(f"/api/projects/{pid}/commands", json={"command": command},
                       headers=H).status_code == 200  # fmt: skip
    _rate(client, pid, "R1", power="0.25")
    report = client.get(f"/api/projects/{pid}/runs/{_run(client, pid, '.op')}/stress",
                        headers=H).json()  # fmt: skip
    by = {(i["ref"], i["quantity"]): i for i in report["items"]}
    assert by[("R1", "power")]["value"] == pytest.approx(0.4)


def test_ratings_are_checked_by_the_command(client: TestClient) -> None:
    pid = client.post("/api/projects", json={"name": "stress-bad"}, headers=H).json()["id"]
    client.post(f"/api/projects/{pid}/circuit/import", json={"text": "V1 a 0 1\nR1 a 0 1k"},
                headers=H)  # fmt: skip
    rid = _instance(client, pid, "R1")["id"]
    for ratings in ({"powr": "1"}, {"power": "lots"}, {"power": "-1"}):
        command = {"type": "update_instance", "sheet": "root", "id": rid, "ratings": ratings}
        r = client.post(f"/api/projects/{pid}/commands", json={"command": command}, headers=H)
        assert r.status_code == 409, (ratings, r.text)  # refused like other bad commands
    _rate(client, pid, "R1", power="0.25", voltage="")  # empty = not rated
    assert _instance(client, pid, "R1")["ratings"] == {"power": "0.25"}
