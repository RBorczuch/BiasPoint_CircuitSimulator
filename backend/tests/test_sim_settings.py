"""Simulate settings: circuit temperature, simulator options, DC sweeps of a resistor, of the
temperature and with a second source (a family of curves)."""

import pytest
from fastapi.testclient import TestClient

from bpt.document.model import Simulation, option_lines, simulation_problem
from bpt.netlist.ngspice_writer import analysis_line
from bpt.netlist.spice_parser import SpiceSyntaxError, parse_analysis_card
from tests.test_api import H
from tests.test_golden import pytestmark as golden_marks
from tests.test_stress import _run


def test_dc_card_with_a_second_source() -> None:
    card = ".dc VC 0 10 0.1 IB 0 50u 10u"
    analysis = parse_analysis_card(card)
    assert analysis.source2 == "IB" and analysis.step2 == "10u"  # type: ignore[union-attr]
    assert analysis_line(analysis) == ".dc VC 0 10 100m IB 0 50u 10u"
    with pytest.raises(SpiceSyntaxError, match="second source"):
        parse_analysis_card(".dc VC 0 10 0.1 IB 0")  # not silently cut to the first sweep


def test_temperature_and_options_become_one_options_card() -> None:
    sim = Simulation(temperature="85", options={"reltol": "1e-4", "gmin": "", "itl1": "500"})
    assert option_lines(sim) == [".options temp=85 reltol=1e-4 itl1=500"]
    assert option_lines(Simulation()) == []
    assert simulation_problem(Simulation(temperature="hot")) is not None
    assert simulation_problem(Simulation(options={"reltol": "1e-3\n.control"})) is not None
    assert simulation_problem(Simulation(options={"bad name": "1"})) is not None
    # Even if a file holds one, the card never carries a script or a second card.
    assert option_lines(Simulation(options={"x": "1 .exec"})) == []


def test_a_bad_option_is_refused_by_the_command(client: TestClient) -> None:
    pid = client.post("/api/projects", json={"name": "opt"}, headers=H).json()["id"]
    sim = Simulation(options={"reltol": "1e-3 .control"}).model_dump()
    command = {"type": "set_simulation", "simulation": sim}
    r = client.post(f"/api/projects/{pid}/commands", json={"command": command}, headers=H)
    assert r.status_code == 409 and "without spaces" in r.text


@golden_marks[0]
@golden_marks[1]
def test_temperature_reaches_the_operating_point(client: TestClient) -> None:
    """A diode's forward voltage falls about 2 mV/°C: 85 °C gives a lower V(a) than 27 °C."""
    pid = client.post("/api/projects", json={"name": "temp"}, headers=H).json()["id"]
    text = "I1 0 a 1m\nD1 a 0 DMOD\n.model DMOD D(IS=1e-14)"
    client.post(f"/api/projects/{pid}/circuit/import", json={"text": text}, headers=H)
    cold = client.get(f"/api/runs/{_run(client, pid, '.op')}/values", headers=H).json()
    doc = client.get(f"/api/projects/{pid}/document", headers=H).json()["project"]
    sim = {**doc["simulation"], "temperature": "85"}
    command = {"type": "set_simulation", "simulation": sim}
    r = client.post(f"/api/projects/{pid}/commands", json={"command": command}, headers=H)
    assert r.status_code == 200, r.text
    hot = client.get(f"/api/runs/{_run(client, pid, '.op')}/values", headers=H).json()
    drop = cold["values"]["V(a)"] - hot["values"]["V(a)"]
    assert 0.08 < drop < 0.15, drop  # ~ 58 °C x 1.5-2.5 mV/°C


@golden_marks[0]
@golden_marks[1]
def test_family_of_curves_from_a_second_source(client: TestClient) -> None:
    pid = client.post("/api/projects", json={"name": "family"}, headers=H).json()["id"]
    text = "VC c 0 5\nIB 0 b 10u\nQ1 c b 0 QN\n.model QN npn(IS=1e-14 BF=100 VAF=100)"
    client.post(f"/api/projects/{pid}/circuit/import", json={"text": text}, headers=H)
    run = _run(client, pid, ".dc VC 0 5 0.5 IB 0 30u 10u")
    meta = client.get(f"/api/runs/{run}", headers=H).json()
    assert meta["family"]["name"] == "IB" and meta["family"]["unit"] == "A"
    assert meta["family"]["values"] == [0, 1e-05, 2e-05, 3e-05] and meta["family"]["length"] == 11
    body = {"signals": ["I(VC)"], "pixels": 400}
    result = client.post(f"/api/runs/{run}/query", json=body, headers=H).json()
    members = result["series"]["I(VC)"]["members"]
    assert len(result["x"]) == 11 and len(members) == 4
    # In the active region Ic ~ BF x IB: the curves step by about 1 mA (current into VC < 0).
    ends = [-m["max"][-1] for m in members]
    assert ends[0] < 1e-6 and 0.8e-3 < ends[1] < 1.3e-3 and ends[3] > 2.5 * ends[1]


@golden_marks[0]
@golden_marks[1]
def test_dc_sweep_of_a_resistor_and_of_the_temperature(client: TestClient) -> None:
    pid = client.post("/api/projects", json={"name": "sweeps"}, headers=H).json()["id"]
    text = "V1 a 0 1\nR1 a b 1k\nR2 b 0 1k"
    client.post(f"/api/projects/{pid}/circuit/import", json={"text": text}, headers=H)
    meta = client.get(f"/api/runs/{_run(client, pid, '.dc R2 1k 3k 1k')}", headers=H).json()
    assert next(s for s in meta["signals"] if s["name"] == "sweep")["unit"] == "Ω"
    meta = client.get(f"/api/runs/{_run(client, pid, '.dc TEMP 0 100 50')}", headers=H).json()
    assert next(s for s in meta["signals"] if s["name"] == "sweep")["unit"] == "°C"
