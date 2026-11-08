"""Equation-defined devices: checked, drawn as a sheet, simulated by ngspice (FR-MOD-9)."""

import math

import pytest
from fastapi.testclient import TestClient

from bpt.models.equations import Branch, problems
from tests.test_api import H


def test_problems_name_what_is_wrong() -> None:
    assert problems([Branch("V1/r")], {"r": "1k"}) == []
    found = problems([Branch("V1/x + V3"), Branch("", "c*V1")], {"c": "1n", "exp": "2"})
    text = " | ".join(found)
    assert "unknown name “x”" in text
    assert "V3: the device has V1..V2" in text
    assert "parameter “exp” is taken" in text
    assert "branch 2 charge: only V2" in text  # a transcapacitance: ngspice ignores it
    assert problems([Branch("")], {}) == ["branch 1: give its current or its charge"]


@pytest.mark.ngspice
def test_a_diode_with_charge_made_of_equations_simulates(client: TestClient) -> None:
    """One branch: I = is*(exp(V1/vt)-1), Q = cj*V1. Placed as a block from a source through
    1 kOhm: the operating point is the diode's, the AC corner the capacitance's."""
    pid = client.post("/api/projects", json={"name": "edd"}, headers=H).json()["id"]
    r = client.post("/api/components/equation-device", headers=H, json={
        "project_id": pid, "name": "My diode",
        "branches": [{"current": "is*(exp(V1/vt)-1)", "charge": "cj*V1"}],
        "parameters": {"is": "1e-14", "vt": "0.025852", "cj": "1n"},
    })  # fmt: skip
    assert r.status_code == 200, r.text
    result = r.json()
    assert result["problems"] == [] and result["sheet"] == "My diode"
    doc = client.get(f"/api/projects/{pid}/document", headers=H).json()["project"]
    sheet = next(s for s in doc["sheets"] if s["name"] == result["sheet"])
    assert sheet["port_order"] == ["P1", "REF"]
    netlist_text = " ".join(i["model"]["params"].get("i", "") for i in sheet["instances"])
    assert "V(P1,REF)" in netlist_text

    bad = client.post("/api/components/equation-device", headers=H, json={
        "project_id": pid, "name": "Bad", "branches": [{"current": "V1/r"}], "parameters": {},
    }).json()  # fmt: skip
    assert bad["problems"] == ["branch 1 current: unknown name “r”"]
    # ngspice reads what the check cannot: a function it does not have.
    worse = client.post("/api/components/equation-device", headers=H, json={
        "project_id": pid, "name": "Worse", "branches": [{"current": "V1*(1+"}],
    }).json()  # fmt: skip
    assert worse["problems"]


@pytest.mark.ngspice
def test_the_device_in_a_circuit(client: TestClient) -> None:
    """The block in a circuit: a linear resistor made of an equation (I = V1/r) halves the
    source through an equal resistor; a charge cj*V1 gives the corner 1/(2π·R/2·cj)."""
    import numpy as np

    from bpt.analysis.spec import AcAnalysis
    from bpt.document.model import Project
    from bpt.engines.ngspice.engine import NgspiceEngine
    from bpt.models import bench
    from bpt.models.equations import device_sheet
    from bpt.netlist.ir import Device

    sheet = device_sheet("eq", [Branch("V1/r", "cj*V1")], {"r": "1k", "cj": "1n"})
    base = Project(name="t", sheets=[sheet])
    engine = NgspiceEngine()
    try:
        run = bench.engine_runner(engine)
        circuit = bench.port_circuit(base, "eq", [({"P1": "x", "REF": "0"}, {})], [
            Device(ref="V1", element="V", nodes=["a", "0"], params={"dc": "1", "ac": "1"}),
            Device(ref="R1", element="R", nodes=["a", "x"], params={"R": "1k"}),
        ])  # fmt: skip
        corner = 1 / (2 * math.pi * 500 * 1e-9)
        f = f"{corner:.6g}"
        reader = run(circuit, AcAnalysis(variation="lin", points=1, fstart=f, fstop=f))
        v = complex(np.asarray(reader.signal("V(x)"))[0])
        assert abs(v) == pytest.approx(0.5 / math.sqrt(2), rel=0.01)  # half, then -3 dB
    finally:
        engine.close()
