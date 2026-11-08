"""Probes: named measuring points with the signal each one measures (FR-SCH-9)."""

from pathlib import Path
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient

from bpt.engines.ngspice.engine import NgspiceEngine
from bpt.netlist.netlister import netlist_project
from bpt.netlist.spice_parser import parse_analysis_card
from bpt.results.store import ResultStore
from tests.test_api import H
from tests.test_golden import pytestmark as ngspice_marks


def _ngspice(test: Any) -> Any:
    for mark in ngspice_marks:
        test = mark(test)
    return test


def _probed(client: TestClient) -> tuple[str, dict[str, str]]:
    """V1 5 V -> R1 1k -> mid; current probe mid -> mid2; R2 1k mid2 -> 0; voltage probe on mid."""
    pid = client.post("/api/projects", json={"name": "p"}, headers=H).json()["id"]
    text = "\n".join(["V1 in 0 DC 5", "R1 in mid 1k", "R2 mid2 0 1k"])
    client.post(f"/api/projects/{pid}/circuit/import", json={"text": text}, headers=H)
    x = 30000  # away from the imported parts; labels join the nets by name
    command = {
        "type": "add_objects", "sheet": "root",
        "instances": [{"ref": "IP1", "symbol": "bpt:probe_i", "at": [x, 0]},
                      {"ref": "VP1", "symbol": "bpt:probe_v", "at": [x + 2540, 0]}],
        "labels": [{"text": "mid", "at": [x, -381]}, {"text": "mid2", "at": [x, 381]},
                   {"text": "mid", "at": [x + 2540, 254]}],
    }  # fmt: skip
    r = client.post(f"/api/projects/{pid}/commands", json={"command": command}, headers=H)
    assert r.status_code == 200, r.text
    probes = client.get(f"/api/projects/{pid}/probes", headers=H).json()
    return pid, {p["ref"]: p["signal"] for p in probes}


def test_probes_name_their_signals(client: TestClient) -> None:
    pid, probes = _probed(client)
    assert probes == {"IP1": "I(IP1)", "VP1": "V(mid)"}
    netlist = client.get(f"/api/projects/{pid}/export/netlist", headers=H).text
    assert "VIP1 mid mid2 DC 0" in netlist, netlist
    issues = client.get(f"/api/projects/{pid}/circuit/netlist", headers=H).json()["issues"]
    assert not [i for i in issues if i["code"] == "not-simulated"]


@_ngspice
def test_probes_measure_the_circuit(client: TestClient, tmp_path: Path) -> None:
    pid, probes = _probed(client)
    project = client.app.state.bpt.get(pid).session.project  # type: ignore[attr-defined]
    store = ResultStore(tmp_path)
    engine = NgspiceEngine()
    try:
        meta = engine.run(netlist_project(project).circuit, parse_analysis_card(".op"), store)
    finally:
        engine.close()
    run = store.open(meta.run_id)
    assert float(np.real(run.signal("I(IP1)"))[-1]) == pytest.approx(2.5e-3, rel=1e-3)
    assert float(np.real(run.signal(probes["VP1"]))[-1]) == pytest.approx(2.5, rel=1e-3)


def test_signal_node_takes_a_probe_by_name(client: TestClient, tmp_path: Path) -> None:
    from bpt.analysis.spec import TranAnalysis
    from bpt.graph.catalog import _signal
    from bpt.graph.values import RunValue

    pid, _probes = _probed(client)
    project = client.app.state.bpt.get(pid).session.project  # type: ignore[attr-defined]
    store = ResultStore(tmp_path)
    writer = store.create(TranAnalysis(tstep="1u", tstop="1m"))
    writer.add_signal("time", np.array([0.0, 1e-3]), "s")
    writer.add_signal("I(IP1)", np.array([1e-3, 2e-3]), "A")
    writer.meta.scale = "time"
    run_id = writer.finish().run_id

    class Ctx:
        def __init__(self) -> None:
            self.project = project

        def open_run(self, run: str) -> object:
            return store.open(run)

    run = RunValue(run_id=run_id, kind="tran", scale="time", signals=["I(IP1)"])
    out = _signal(Ctx(), {"run": run}, {"expr": "ip1"})  # type: ignore[arg-type]
    signal = out["signal"]
    assert signal.name == "IP1" and list(signal.y) == [1e-3, 2e-3]  # type: ignore[attr-defined]
