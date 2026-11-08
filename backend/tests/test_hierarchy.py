from pathlib import Path

import numpy as np
import pytest

from bpt.document.builder import import_netlist
from bpt.document.model import Instance, Label, Project, Sheet
from bpt.engines.ngspice.engine import NgspiceEngine
from bpt.library.blocks import block_symbol
from bpt.library.symbols import Symbol
from bpt.netlist.connectivity import transform
from bpt.netlist.netlister import netlist_project
from bpt.netlist.ngspice_writer import write_netlist
from bpt.netlist.spice_parser import parse_analysis_card, parse_netlist
from bpt.results.store import ResultStore
from tests.test_golden import pytestmark as ngspice_marks


def _filter_project() -> Project:
    """root: V1 -> X1 (sheet "filter": R1 + C1, ports in / out) -> vout."""
    project = Project(name="h", sheets=[Sheet(name="root"), Sheet(name="filter")])
    import_netlist(project, parse_netlist("* f\nR1 in out 1k\nC1 out 0 159.15n"), "filter").apply(
        project
    )
    for label in project.sheet("filter").labels:
        label.kind = "port"
    import_netlist(project, parse_netlist("* r\nV1 vin 0 DC 0 AC 1"), "root").apply(project)
    symbol = block_symbol(project.sheet("filter"))
    assert symbol is not None
    block = Instance(ref="X1", symbol=symbol.id, at=(5080, 0))
    root = project.sheet("root")
    root.instances.append(block)
    for pin, net in (("in", "vin"), ("out", "vout")):
        root.labels.append(Label(text=net, at=transform(symbol.pin(pin).at, block)))
    return project


def test_block_becomes_a_subcircuit() -> None:
    result = netlist_project(_filter_project())
    assert [i.code for i in result.issues if i.severity == "error"] == []
    lines = write_netlist(result.circuit)
    assert ".subckt sheet_filter in out" in lines
    assert ".ends sheet_filter" in lines
    assert any(line.startswith("X1 vin vout sheet_filter") for line in lines), lines


def test_a_sheet_inside_itself_is_an_error() -> None:
    project = _filter_project()
    symbol = block_symbol(project.sheet("filter"))
    assert symbol is not None
    project.sheet("filter").instances.append(Instance(ref="X9", symbol=symbol.id, at=(9000, 0)))
    codes = [i.code for i in netlist_project(project).issues]
    assert "block-cycle" in codes


@ngspice_marks[0]
@ngspice_marks[1]
def test_hierarchical_filter_matches_the_flat_one(tmp_path: Path) -> None:
    engine = NgspiceEngine()
    try:
        circuit = netlist_project(_filter_project()).circuit
        meta = engine.run(circuit, parse_analysis_card(".ac dec 50 100 10k"), ResultStore(tmp_path))
    finally:
        engine.close()
    assert meta.status == "ok", meta.error
    run = ResultStore(tmp_path).open(meta.run_id)
    f = np.real(np.asarray(run.signal("frequency")))
    gain = 20 * np.log10(np.abs(np.asarray(run.signal("V(vout)"))))
    assert np.interp(1e3, f, gain) == pytest.approx(-3.01, abs=0.05)


@ngspice_marks[0]
@ngspice_marks[1]
def test_signals_inside_a_block_have_user_names(tmp_path: Path) -> None:
    project = Project(name="h2", sheets=[Sheet(name="root"), Sheet(name="filter")])
    import_netlist(
        project, parse_netlist("* f\nR1 in mid 1k\nR2 mid out 1k\nC1 out 0 1u"), "filter"
    ).apply(project)
    for label in project.sheet("filter").labels:
        if label.text in ("in", "out"):
            label.kind = "port"
    import_netlist(project, parse_netlist("* r\nV1 vin 0 DC 2"), "root").apply(project)
    symbol = block_symbol(project.sheet("filter"))
    assert symbol is not None
    block = Instance(ref="X1", symbol=symbol.id, at=(5080, 0))
    project.sheet("root").instances.append(block)
    for pin, net in (("in", "vin"), ("out", "vout")):
        project.sheet("root").labels.append(
            Label(text=net, at=transform(symbol.pin(pin).at, block))
        )
    engine = NgspiceEngine()
    try:
        meta = engine.run(
            netlist_project(project).circuit, parse_analysis_card(".op"), ResultStore(tmp_path)
        )
    finally:
        engine.close()
    names = {s.name for s in meta.signals}
    assert {"V(X1.mid)", "I(X1.R1)", "I(X1.C1)"} <= names, names
    run = ResultStore(tmp_path).open(meta.run_id)
    assert float(np.real(np.asarray(run.signal("V(X1.mid)"))[0])) == pytest.approx(2.0, abs=1e-6)


def test_nets_on_a_block_sheet_are_named_like_the_results() -> None:
    from bpt.api.projects import sheet_net_names

    project = Project(name="h3", sheets=[Sheet(name="root"), Sheet(name="filter")])
    import_netlist(
        project, parse_netlist("* f\nR1 in mid 1k\nR2 mid out 1k\nC1 out 0 1u"), "filter"
    ).apply(project)
    for label in project.sheet("filter").labels:
        if label.text in ("in", "out"):
            label.kind = "port"
    import_netlist(project, parse_netlist("* r\nV1 vin 0 DC 2"), "root").apply(project)
    symbol = block_symbol(project.sheet("filter"))
    assert symbol is not None
    block = Instance(ref="X1", symbol=symbol.id, at=(5080, 0))
    project.sheet("root").instances.append(block)
    for pin, net in (("in", "vin"), ("out", "vout")):
        project.sheet("root").labels.append(
            Label(text=net, at=transform(symbol.pin(pin).at, block))
        )
    items, _pins = sheet_net_names(project, project.sheet("filter"))
    names = set(items.values())
    assert {"X1.mid", "vin", "vout"} <= names, names


def test_renaming_a_sheet_keeps_its_blocks() -> None:
    from bpt.document.commands import RenameSheet

    project = _filter_project()
    inverse = RenameSheet(name="filter", new_name="lowpass").apply(project)
    assert project.sheet("root").instances[-1].symbol == "sheet:lowpass"
    assert ".subckt sheet_lowpass in out" in write_netlist(netlist_project(project).circuit)
    inverse.apply(project)
    assert project.sheet("root").instances[-1].symbol == "sheet:filter"


def _place(project: Project, parent: str, child: str, ref: str, nets: dict[str, str]) -> None:
    symbol = block_symbol(project.sheet(child))
    assert symbol is not None
    block = Instance(ref=ref, symbol=symbol.id, at=(5080, 0))
    project.sheet(parent).instances.append(block)
    for pin, net in nets.items():
        project.sheet(parent).labels.append(
            Label(text=net, at=transform(symbol.pin(pin).at, block))
        )


def _nested_project() -> Project:
    """root: V1 -> X2 (sheet "stage": X1 of sheet "filter" + R3 load) -> vout."""
    project = Project(
        name="n", sheets=[Sheet(name="root"), Sheet(name="stage"), Sheet(name="filter")]
    )
    import_netlist(
        project, parse_netlist("* f\nR1 in mid 1k\nR2 mid out 1k\nC1 out 0 1u"), "filter"
    ).apply(project)
    for label in project.sheet("filter").labels:
        if label.text in ("in", "out"):
            label.kind = "port"
    import_netlist(project, parse_netlist("* s\nR3 b 0 2k"), "stage").apply(project)
    _place(project, "stage", "filter", "X1", {"in": "a", "out": "b"})
    project.sheet("stage").labels += [
        Label(text="a", kind="port", at=(-20000, 0)),
        Label(text="b", kind="port", at=(20000, 0)),
    ]
    import_netlist(project, parse_netlist("* r\nV1 vin 0 DC 3"), "root").apply(project)
    _place(project, "root", "stage", "X2", {"a": "vin", "b": "vout"})
    return project


def test_nested_blocks_become_nested_subcircuits() -> None:
    result = netlist_project(_nested_project())
    assert [i.message for i in result.issues if i.severity == "error"] == []
    lines = write_netlist(result.circuit)
    # The inner subcircuit is defined before the one that uses it.
    assert lines.index(".subckt sheet_filter in out") < lines.index(".subckt sheet_stage a b")
    assert any(line.startswith("X1 a b sheet_filter") for line in lines), lines
    assert any(line.startswith("X2 vin vout sheet_stage") for line in lines), lines


@ngspice_marks[0]
@ngspice_marks[1]
def test_nested_block_signals(tmp_path: Path) -> None:
    from bpt.api.projects import sheet_net_names

    project = _nested_project()
    engine = NgspiceEngine()
    try:
        meta = engine.run(
            netlist_project(project).circuit, parse_analysis_card(".op"), ResultStore(tmp_path)
        )
    finally:
        engine.close()
    assert meta.status == "ok", meta.error
    names = {s.name for s in meta.signals}
    assert {"V(vout)", "V(X2.X1.mid)", "I(X2.R3)", "I(X2.X1.R1)"} <= names, sorted(names)
    run = ResultStore(tmp_path).open(meta.run_id)
    # 3 V over 1k + 1k + 2k: mid = 2.25 V, out = 1.5 V.
    assert float(np.real(np.asarray(run.signal("V(X2.X1.mid)"))[0])) == pytest.approx(
        2.25, abs=1e-6
    )
    assert float(np.real(np.asarray(run.signal("V(vout)"))[0])) == pytest.approx(1.5, abs=1e-6)
    items, _pins = sheet_net_names(project, project.sheet("filter"))
    assert "X2.X1.mid" in set(items.values())


def test_describe_shows_what_is_inside_blocks() -> None:
    from bpt.document.builder import describe

    text = describe(_nested_project())
    assert ".subckt sheet_filter in out" in text
    assert "  R1 in mid 1k" in text
    assert "X2 vin vout sheet_stage" in text
    assert "ERC: ok" in text


def _parametric_project() -> Project:
    """Sheet "rc" (R1 {R}, C1 {C}, defaults R=1k C=159.15n) used twice: X1 with R=2k, X2 default."""
    project = Project(name="p", sheets=[Sheet(name="root"), Sheet(name="rc")])
    import_netlist(project, parse_netlist("* rc\nR1 in out {R}\nC1 out 0 {C}"), "rc").apply(project)
    rc = project.sheet("rc")
    for label in rc.labels:
        label.kind = "port"
    rc.parameters = {"R": "1k", "C": "159.15n"}
    import_netlist(project, parse_netlist("* r\nV1 vin 0 DC 0 AC 1"), "root").apply(project)
    _place(project, "root", "rc", "X1", {"in": "vin", "out": "o1"})
    project.sheet("root").instances[-1].model.params["R"] = "2k"
    symbol = block_symbol(rc)
    assert symbol is not None
    second = Instance(ref="X2", symbol=symbol.id, at=(5080, 5080))
    project.sheet("root").instances.append(second)
    for pin, net in (("in", "vin"), ("out", "o2")):
        project.sheet("root").labels.append(
            Label(text=net, at=transform(symbol.pin(pin).at, second))
        )
    return project


def test_block_parameters_are_subcircuit_params() -> None:
    result = netlist_project(_parametric_project())
    assert [i.message for i in result.issues if i.severity == "error"] == []
    lines = write_netlist(result.circuit)
    assert ".subckt sheet_rc in out params: R=1k C=159.15n" in lines
    assert any(line.startswith("X1 vin o1 sheet_rc R=2k") for line in lines), lines
    assert any(line.rstrip().endswith("sheet_rc") and line.startswith("X2") for line in lines)


def test_unknown_block_parameter_is_a_warning() -> None:
    project = _parametric_project()
    project.sheet("root").instances[-2].model.params["L"] = "1u"
    issues = netlist_project(project).issues
    assert [i.code for i in issues if i.code == "unknown-block-param"] == ["unknown-block-param"]


@ngspice_marks[0]
@ngspice_marks[1]
def test_parametric_blocks_match_the_flat_circuit(tmp_path: Path) -> None:
    """Golden: the hierarchical circuit gives the same response as the one flattened by hand."""
    flat = parse_netlist(
        "* flat\nV1 vin 0 DC 0 AC 1\nR1 vin o1 2k\nC1 o1 0 159.15n\nR2 vin o2 1k\nC2 o2 0 159.15n"
    )
    flat_project = Project(name="flat", sheets=[Sheet(name="root")])
    import_netlist(flat_project, flat, "root").apply(flat_project)
    card = parse_analysis_card(".ac dec 50 10 100k")
    engine = NgspiceEngine()
    try:
        hier = engine.run(
            netlist_project(_parametric_project()).circuit, card, ResultStore(tmp_path)
        )
        ref = engine.run(netlist_project(flat_project).circuit, card, ResultStore(tmp_path))
    finally:
        engine.close()
    assert hier.status == "ok" and ref.status == "ok", (hier.error, ref.error)
    a, b = ResultStore(tmp_path).open(hier.run_id), ResultStore(tmp_path).open(ref.run_id)
    for net in ("o1", "o2"):
        got, want = np.asarray(a.signal(f"V({net})")), np.asarray(b.signal(f"V({net})"))
        assert np.allclose(got, want, rtol=1e-9, atol=1e-12), net
    f = np.real(np.asarray(a.signal("frequency")))
    gain = 20 * np.log10(np.abs(np.asarray(a.signal("V(o1)"))))
    assert np.interp(500, f, gain) == pytest.approx(-3.01, abs=0.05)  # 1/(2π·2k·159.15n)


def test_a_block_sheet_is_seen_through_the_chosen_instance() -> None:
    from bpt.api.projects import sheet_net_names

    project = _parametric_project()  # sheet "rc" used by X1 (out -> o1) and X2 (out -> o2)
    rc = project.sheet("rc")
    first, _ = sheet_net_names(project, rc)
    second, _ = sheet_net_names(project, rc, ["X2"])
    out_label = next(lb for lb in rc.labels if lb.text == "out")
    assert first[out_label.id] == "o1" and second[out_label.id] == "o2"
    wrong, _ = sheet_net_names(project, rc, ["X9"])  # unknown path: the first use
    assert wrong[out_label.id] == "o1"


def test_port_layout_moves_pins_and_keeps_the_circuit() -> None:
    from bpt.document.commands import SetPortLayout

    project = _parametric_project()
    inverse = SetPortLayout(sheet="rc", sides={"in": "right", "out": "top"}, order=[]).apply(
        project
    )
    symbol = block_symbol(project.sheet("rc"))
    assert symbol is not None
    assert [(p.number, p.orientation) for p in symbol.pins] == [("in", "right"), ("out", "up")]
    lines = write_netlist(netlist_project(project).circuit)
    assert any(line.startswith(".subckt sheet_rc in out") for line in lines), lines
    # The labels on the block pins moved with them: still connected.
    assert any(line.startswith("X1 vin o1 sheet_rc") for line in lines), lines
    inverse.apply(project)
    assert project.sheet("rc").port_sides == {}
    assert any(x.startswith("X1 vin o1") for x in write_netlist(netlist_project(project).circuit))


def test_bus_port_expands_to_member_pins() -> None:
    from bpt.document.model import Wire
    from bpt.netlist.connectivity import bus_members

    assert bus_members("D[0..2]") == ["D0", "D1", "D2"]
    assert bus_members("I2C{SDA SCL}") == ["SDA", "SCL"]
    assert bus_members("D0") == []
    project = Project(name="bus", sheets=[Sheet(name="root"), Sheet(name="dac")])
    import_netlist(
        project, parse_netlist("* d\nR0 D0 out 2k\nR1 D1 out 1k\nR2 out 0 1k"), "dac"
    ).apply(project)
    dac = project.sheet("dac")
    dac.labels += [
        Label(text="D[0..1]", kind="port", at=(-30000, 0)),
        Label(text="out", kind="port", at=(30000, 0)),
        Label(text="D[0..1]", at=(-30000, 2540)),  # a bus label: no net of its own
    ]
    dac.wires.append(Wire(points=[(-30000, 2540), (-20000, 2540)], bus=True))
    symbol = block_symbol(dac)
    assert symbol is not None and [p.number for p in symbol.pins] == ["D0", "D1", "out"]
    import_netlist(project, parse_netlist("* r\nV1 a 0 DC 1\nV2 b 0 DC 0"), "root").apply(project)
    _place(project, "root", "dac", "X1", {"D0": "a", "D1": "b", "out": "y"})
    result = netlist_project(project)
    assert [i.message for i in result.issues if i.severity == "error"] == []
    lines = write_netlist(result.circuit)
    assert ".subckt sheet_dac d0 d1 out" in lines, lines
    assert any(line.startswith("X1 a b y sheet_dac") for line in lines), lines


def test_drawn_block_symbol_replaces_the_box_and_keeps_the_circuit() -> None:
    from bpt.document.commands import SetSheetSymbol
    from bpt.library.symbols import Pin, Polyline

    project = _parametric_project()
    drawn = Symbol(  # a triangle: "in" on the left, "out" at the tip, plus a pin that is no port
        id="draft", name="rc", ref_prefix="U",
        pins=[Pin(number="out", name="out", at=(762, 0), length=254, orientation="right"),
              Pin(number="in", name="in", at=(-762, -254), length=254, orientation="left"),
              Pin(number="x", name="x", at=(0, 762), length=254, orientation="down")],
        graphics=[Polyline(points=[(-508, -508), (508, 0), (-508, 508), (-508, -508)])],
    )  # fmt: skip
    inverse = SetSheetSymbol(sheet="rc", symbol=drawn).apply(project)
    symbol = block_symbol(project.sheet("rc"))
    assert symbol is not None and symbol.id == "sheet:rc" and symbol.ref_prefix == "X"
    assert [p.number for p in symbol.pins] == ["out", "in"]  # pins that are not ports: left out
    assert symbol.spice is not None and symbol.spice.nodes == ["in", "out"]  # port order
    result = netlist_project(project)
    lines = write_netlist(result.circuit)
    assert any(line.startswith(".subckt sheet_rc in out") for line in lines), lines
    assert any(line.startswith("X1 vin o1 sheet_rc") for line in lines), lines  # labels followed
    assert [i.code for i in result.issues if i.code == "block-symbol"] == ["block-symbol"]

    # A drawing without a pin for some port: the automatic box is used (and ERC says why).
    SetSheetSymbol(sheet="rc", symbol=drawn.model_copy(update={"pins": drawn.pins[:1]})).apply(
        project
    )
    assert [p.orientation for p in block_symbol(project.sheet("rc")).pins] == ["left", "right"]  # type: ignore[union-attr]
    assert "no pin for port in" in str(netlist_project(project).issues)
    inverse.apply(project)
    assert project.sheet("rc").symbol is None


def test_a_sheet_with_ports_not_placed_is_not_simulated() -> None:
    """A block / template sheet waiting to be placed must not fail the project's ERC."""
    from bpt.document.builder import import_netlist
    from bpt.document.model import Label, Project, Sheet
    from bpt.document.session import DocumentSession
    from bpt.netlist.netlister import netlist_project
    from bpt.netlist.spice_parser import parse_netlist

    session = DocumentSession(Project(name="p", sheets=[Sheet(name="root"), Sheet(name="caps")]))
    session.execute(import_netlist(session.project, parse_netlist("t\nV1 a 0 1\nR1 a 0 1k\n")))
    session.execute(import_netlist(session.project, parse_netlist("t\nC1 1 2 1u\n"), "caps"))
    caps = session.project.sheet("caps")
    caps.labels = [Label(kind="port", text=lb.text, at=lb.at) for lb in caps.labels]
    result = netlist_project(session.project)
    assert not [i for i in result.issues if i.severity == "error"]
    assert [i.code for i in result.issues] == ["unplaced-block"]
    assert [d.ref for d in result.circuit.devices] == ["V1", "R1"]


@ngspice_marks[0]
@ngspice_marks[1]
def test_a_parameter_product_divides_as_a_whole_in_a_block(tmp_path: Path) -> None:
    """B1 out 0 V=6/{a*b} in a block with a=2, b=3 gives 1 V (ngspice alone would give 9)."""
    project = Project(name="b", sheets=[Sheet(name="root"),
                      Sheet(name="blk", parameters={"a": "2", "b": "3"})])  # fmt: skip
    import_netlist(project, parse_netlist("* b\nB1 out 0 V=6/{a*b}\nR1 out 0 1k"), "blk").apply(
        project
    )
    for label in project.sheet("blk").labels:
        label.kind = "port"
    symbol = block_symbol(project.sheet("blk"))
    assert symbol is not None
    block = Instance(ref="X1", symbol=symbol.id, at=(5080, 0))
    project.sheet("root").instances.append(block)
    project.sheet("root").labels.append(Label(text="vout", at=transform(symbol.pin("out").at,
                                                                        block)))  # fmt: skip
    engine = NgspiceEngine()
    try:
        meta = engine.run(netlist_project(project).circuit, parse_analysis_card(".op"),
                          ResultStore(tmp_path))  # fmt: skip
    finally:
        engine.close()
    assert meta.status == "ok", meta.error
    value = np.real(np.asarray(ResultStore(tmp_path).open(meta.run_id).signal("V(vout)")))[-1]
    assert value == pytest.approx(1.0, rel=1e-6)


def test_a_block_simulates_as_the_variant_it_chose() -> None:
    """FR-CMP-8: a sheet's other model (same ports) replaces it when the block chooses it."""
    from bpt.document.model import SheetVariant
    from bpt.library.components import component_sheets
    from bpt.models.user_templates import collect_sheets

    project = _filter_project()
    fast = project.sheet("filter").model_copy(update={"name": "filter_fast"}, deep=True)
    fast.instances = [i for i in fast.instances if i.ref != "C1"]  # a resistor only
    project.sheets.append(fast)
    variant = SheetVariant(name="fast", label="Fast", sheet="filter_fast")
    project.sheet("filter").variants = [variant]
    symbol = block_symbol(project.sheet("filter"))
    assert symbol is not None and [v.name for v in symbol.variants] == ["full", "fast"]

    result = netlist_project(project)
    assert [i.code for i in result.issues] == []  # the waiting variant is not "unplaced"
    assert "X1 vin vout sheet_filter" in write_netlist(result.circuit)
    block = next(i for i in project.sheet("root").instances if i.ref == "X1")
    block.model.variant = "fast"
    lines = write_netlist(netlist_project(project).circuit)
    assert any(line.startswith("X1 vin vout sheet_filter_fast") for line in lines), lines

    # Saved as a component the variant comes along; placed, its sheet name follows the renaming.
    saved = collect_sheets(project, "filter")
    assert [s.name for s in saved] == ["filter", "filter_fast"]
    from bpt.document.model import Component

    part = Component(id="cmp:L/F", name="F", sheets=saved)
    _top, sheets = component_sheets(Project(name="p", sheets=[Sheet(name="root"), fast]), part)
    renamed = {s.name for s in sheets}
    assert sheets[0].variants[0].sheet in renamed and sheets[0].variants[0].sheet != "filter_fast"
