from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from bpt.document.builder import import_netlist
from bpt.document.commands import SetParams
from bpt.document.model import Instance, Label, Project, Sheet
from bpt.engines.ngspice.engine import NgspiceEngine
from bpt.library.builtin import builtin_symbols
from bpt.netlist.connectivity import transform
from bpt.netlist.netlister import netlist_project
from bpt.netlist.ngspice_writer import write_netlist
from bpt.netlist.spice_parser import parse_analysis_card, parse_netlist
from bpt.results.store import ResultStore
from tests.test_golden import pytestmark as ngspice_marks


def _amplifier(variant: str | None) -> Project:
    """Non-inverting amplifier, gain 1 + 9k/1k = 10."""
    project = Project(name="amp", sheets=[Sheet(name="root")])
    import_netlist(
        project, parse_netlist("* a\nV1 in 0 DC 0 AC 1\nR1 fb 0 1k\nR2 out fb 9k"), "root"
    ).apply(project)
    symbol = builtin_symbols()["bpt:opamp_ideal"]
    u1 = Instance(ref="U1", symbol=symbol.id, at=(5080, 0))
    u1.model.variant = variant
    sheet = project.sheet("root")
    sheet.instances.append(u1)
    for pin, net in (("+", "in"), ("-", "fb"), ("out", "out")):
        sheet.labels.append(Label(text=net, at=transform(symbol.pin(pin).at, u1)))
    return project


def test_variant_changes_the_element() -> None:
    assert any(line.startswith("EU1 out 0 in fb 1meg") for line in
               write_netlist(netlist_project(_amplifier(None)).circuit))  # fmt: skip
    lines = write_netlist(netlist_project(_amplifier("single-pole")).circuit)
    assert any(line.startswith("XU1 in fb out OPAMP_1P") for line in lines), lines
    assert any(line.startswith(".subckt OPAMP_1P inp inn out") for line in lines)


def test_variant_is_undoable() -> None:
    project = _amplifier(None)
    u1 = next(i for i in project.sheet("root").instances if i.ref == "U1")
    inverse = SetParams(id=u1.id, variant="single-pole").apply(project)
    assert u1.model.variant == "single-pole"
    inverse.apply(project)
    assert u1.model.variant is None


@ngspice_marks[0]
@ngspice_marks[1]
def test_bandwidth_limited_op_amp(tmp_path: Path) -> None:
    engine = NgspiceEngine()
    try:
        circuit = netlist_project(_amplifier("single-pole")).circuit
        card = parse_analysis_card(".ac dec 50 1k 10meg")
        meta = engine.run(circuit, card, ResultStore(tmp_path))
    finally:
        engine.close()
    assert meta.status == "ok", meta.error
    run = ResultStore(tmp_path).open(meta.run_id)
    f = np.real(np.asarray(run.signal("frequency")))
    gain = 20 * np.log10(np.abs(np.asarray(run.signal("V(out)"))))
    assert gain[0] == pytest.approx(20, abs=0.05)  # closed-loop gain 10
    f3db = float(np.interp(-(gain[0] - 3.01), -gain, f))
    assert f3db == pytest.approx(100e3, rel=0.1)  # GBW 1 MHz / 10


def test_looks_change_the_drawing_not_the_pins() -> None:
    from bpt.document.commands import UpdateInstance
    from bpt.document.model import Instance, Project, Sheet

    resistor = builtin_symbols()["bpt:resistor"]
    ansi = resistor.with_look(None, "ansi")
    assert ansi.graphics != resistor.graphics and ansi.pins == resistor.pins
    assert resistor.with_look(None, "iec") is resistor
    capacitor = builtin_symbols()["bpt:capacitor"]
    assert capacitor.with_look(None, "ansi") is capacitor  # its looks are chosen by hand only
    eu = capacitor.with_look("electrolytic-eu")
    assert eu.graphics != capacitor.graphics and eu.pins == capacitor.pins
    assert capacitor.with_look("no-such-look") is capacitor

    part = Instance(ref="C1", symbol="bpt:capacitor", at=(0, 0))
    project = Project(name="p", sheets=[Sheet(name="root", instances=[part])])
    inverse = UpdateInstance(id=part.id, look="electrolytic-us").apply(project)
    assert part.look == "electrolytic-us"
    inverse.apply(project)
    assert part.look is None


def test_a_user_drawing_is_another_look_of_a_built_in_symbol(client: "TestClient") -> None:
    from bpt.document.commands import SetProjectLook
    from bpt.library.blocks import project_symbols
    from bpt.library.symbols import Look
    from bpt.render.svg import render_sheet
    from tests.test_api import H

    drawing = [{"kind": "circle", "center": [0, 0], "radius": 203, "fill": False},
               {"kind": "text", "at": [0, 0], "text": "A", "size": 127}]  # fmt: skip
    r = client.post("/api/library/looks", headers=H, json={
        "library": "Mine", "target": "bpt:isource", "name": "Ammeter-like", "graphics": drawing,
    })  # fmt: skip
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "user:Mine/Ammeter-like"
    symbols = {s["id"]: s for s in client.get("/api/library/symbols", headers=H).json()}
    names = [lk["name"] for lk in symbols["bpt:isource"]["looks"]]
    assert "user:Mine/Ammeter-like" in names and "iec-line" in names
    assert client.post("/api/library/looks", headers=H, json={
        "library": "Mine", "target": "bpt:nothing", "name": "x", "graphics": drawing,
    }).status_code == 404  # fmt: skip

    # A project using it keeps a copy: drawn the same without the library.
    look = Look.model_validate(r.json())
    part = Instance(ref="I1", symbol="bpt:isource", at=(0, 0), look=look.name)
    project = Project(name="p", sheets=[Sheet(name="root", instances=[part])])
    inverse = SetProjectLook(symbol="bpt:isource", name=look.name, look=look).apply(project)
    shown = project_symbols(project)["bpt:isource"].with_look(look.name)
    assert shown.graphics == look.graphics
    assert ">A<" in render_sheet(project.sheets[0], project_symbols(project))
    inverse.apply(project)
    assert project.looks == {}
