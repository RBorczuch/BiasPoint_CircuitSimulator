from pathlib import Path

import numpy as np
import pytest

from bpt.document.builder import import_netlist
from bpt.document.extract import ExtractError, block_from_selection
from bpt.document.model import Project, Sheet
from bpt.engines.ngspice.engine import NgspiceEngine
from bpt.library.blocks import project_symbols
from bpt.netlist.connectivity import transform
from bpt.netlist.netlister import netlist_project
from bpt.netlist.ngspice_writer import write_netlist
from bpt.netlist.spice_parser import parse_analysis_card, parse_netlist
from bpt.results.store import ResultStore
from tests.test_golden import pytestmark as ngspice_marks

NETLIST = "* x\nV1 vin 0 DC 2\nR1 vin mid 1k\nR2 mid out 1k\nC1 out 0 1u\nR3 out 0 2k"


def _project() -> Project:
    project = Project(name="x", sheets=[Sheet(name="root")])
    import_netlist(project, parse_netlist(NETLIST), "root").apply(project)
    return project


def _selection(project: Project, refs: set[str]) -> set:  # type: ignore[type-arg]
    """The parts plus the wire stubs and labels hanging on their pins (not ground symbols)."""
    sheet, symbols = project.sheet("root"), project_symbols(project)
    parts = [i for i in sheet.instances if i.ref in refs]
    pins = {transform(p.at, i) for i in parts for p in symbols[i.symbol].pins}
    wires = [w for w in sheet.wires if w.points[0] in pins or w.points[-1] in pins]
    ends = {p for w in wires for p in (w.points[0], w.points[-1])}
    labels = [lb for lb in sheet.labels if lb.at in ends]
    return {o.id for o in [*parts, *wires, *labels]}


def test_selection_becomes_a_block() -> None:
    project = _project()
    symbols = project_symbols(project)
    result = block_from_selection(
        project, "root", _selection(project, {"R1", "R2", "C1"}), "rc", symbols
    )
    inverse = result.command.apply(project)
    assert result.ref == "X1"
    assert sorted(result.ports) == ["out", "vin"]
    root_refs = {i.ref for i in project.sheet("root").instances}
    assert {"V1", "R3", "X1"} <= root_refs and "R1" not in root_refs
    inner = project.sheet("rc")
    assert {i.ref for i in inner.instances if not i.ref.startswith("#")} == {"R1", "R2", "C1"}
    assert any(i.symbol == "bpt:gnd" for i in inner.instances)  # C1 to ground, inside
    netlist = netlist_project(project)
    assert [i.message for i in netlist.issues if i.severity == "error"] == []
    lines = write_netlist(netlist.circuit)
    assert any(line.startswith(".subckt sheet_rc") for line in lines), lines
    inverse.apply(project)
    assert [s.name for s in project.sheets] == ["root"]
    assert {i.ref for i in project.sheet("root").instances} >= {"R1", "R2", "C1"}


def test_bad_names_and_empty_selections_are_refused() -> None:
    project = _project()
    symbols = project_symbols(project)
    ids = _selection(project, {"R1"})
    with pytest.raises(ExtractError):
        block_from_selection(project, "root", ids, "root", symbols)
    with pytest.raises(ExtractError):
        block_from_selection(project, "root", ids, "a/b", symbols)
    with pytest.raises(ExtractError):
        block_from_selection(project, "root", set(), "empty", symbols)


@ngspice_marks[0]
@ngspice_marks[1]
def test_the_circuit_works_the_same_after_extraction(tmp_path: Path) -> None:
    project = _project()
    block_from_selection(
        project, "root", _selection(project, {"R1", "R2", "C1"}), "rc", project_symbols(project)
    ).command.apply(project)
    engine = NgspiceEngine()
    try:
        meta = engine.run(
            netlist_project(project).circuit, parse_analysis_card(".op"), ResultStore(tmp_path)
        )
    finally:
        engine.close()
    assert meta.status == "ok", meta.error
    run = ResultStore(tmp_path).open(meta.run_id)
    value = lambda s: float(np.real(np.asarray(run.signal(s))[0]))  # noqa: E731
    assert value("V(out)") == pytest.approx(1.0, abs=1e-6)  # 2 V · 2k / 4k
    assert value("V(X1.mid)") == pytest.approx(1.5, abs=1e-6)


def test_a_wire_to_an_unselected_part_becomes_a_named_port() -> None:
    from bpt.document.model import Instance, ModelRef, Wire
    from bpt.netlist.connectivity import resolve_nets

    project = Project(name="w", sheets=[Sheet(name="root")])
    symbols = project_symbols(project)
    sheet = project.sheet("root")
    r1 = Instance(ref="R1", symbol="bpt:resistor", at=(0, 0), model=ModelRef(params={"R": "1k"}))
    r2 = Instance(ref="R2", symbol="bpt:resistor", at=(2540, 0), model=ModelRef(params={"R": "1k"}))
    sheet.instances += [r1, r2]
    a = transform(symbols["bpt:resistor"].pins[1].at, r1)
    b = transform(symbols["bpt:resistor"].pins[0].at, r2)
    wire = Wire(points=[a, (a[0], a[1] + 254), (b[0], a[1] + 254), b])
    sheet.wires.append(wire)
    result = block_from_selection(project, "root", {r1.id}, "half", symbols)
    result.command.apply(project)
    assert result.ports == ["P1"]
    inner = project.sheet("half")
    assert [(lb.kind, lb.text, lb.at) for lb in inner.labels] == [("port", "P1", a)]
    nets = resolve_nets(
        project.model_copy(update={"sheets": [project.sheet("root")]}), project_symbols(project)
    )
    block = next(i for i in project.sheet("root").instances if i.ref == "X1")
    assert nets.pin_net[(block.id, "P1")] == nets.pin_net[(r2.id, "1")] == "P1"


def test_parts_selected_without_their_wires_stay_connected() -> None:
    """Only R1, R2, C1 selected: their stubs go along, and the net between them stays inside."""
    project = _project()
    symbols = project_symbols(project)
    ids = {i.id for i in project.sheet("root").instances if i.ref in {"R1", "R2", "C1"}}
    block_from_selection(project, "root", ids, "rc", symbols).command.apply(project)
    lines = write_netlist(netlist_project(project).circuit)
    body = lines[lines.index(next(x for x in lines if x.startswith(".subckt"))) :]
    assert ".subckt sheet_rc vin out" in body
    assert "R1 vin mid 1k" in body and "R2 mid out 1k" in body and "C1 out 0 1u" in body, body
