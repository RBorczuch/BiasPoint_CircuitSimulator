from pathlib import Path

import pytest

from bpt.document.builder import (
    BuildError,
    add_component,
    connect_pins,
    describe,
    import_netlist,
    remove_component,
)
from bpt.document.model import Project, Sheet
from bpt.netlist.netlister import netlist_project
from bpt.netlist.spice_parser import parse_netlist

GOLDEN = Path(__file__).resolve().parents[2] / "tests" / "golden"


def _empty() -> Project:
    return Project(name="t", sheets=[Sheet(name="root")])


def _canonical(lines: list[str]) -> set[str]:
    return {line.lower() for line in lines}


@pytest.mark.parametrize("case", ["bjt_ce", "rlc_ac", "diode_rectifier"])
def test_imported_schematic_netlists_back_to_the_same_circuit(case: str) -> None:
    parsed = parse_netlist((GOLDEN / case / "circuit.cir").read_text())
    project = _empty()
    import_netlist(project, parsed).apply(project)
    result = netlist_project(project)
    assert result.ok, result.issues
    original = {(d.ref.lower(), tuple(n.lower() for n in d.nodes)) for d in parsed.circuit.devices}
    rebuilt = {(d.ref.lower(), tuple(n.lower() for n in d.nodes)) for d in result.circuit.devices}
    assert rebuilt == original


def test_add_connect_describe_remove() -> None:
    project = _empty()
    for symbol, nets, params in [
        ("vsource", ["in", "0"], {"dc": "1"}),
        ("resistor", ["in", "out"], {"R": "1k"}),
        ("capacitor", ["x", "0"], {"C": "1u"}),
    ]:
        _ref, command = add_component(project, symbol, nets, params=params)
        command.apply(project)
    assert "unconnected-pin" in {i.code for i in netlist_project(project).issues}

    connect_pins(project, "R1.2", "C1.1").apply(project)
    text = describe(project)
    assert "R1 in out 1k" in text and "C1 out 0 1u" in text and "ERC: ok" in text

    remove_component(project, "C1").apply(project)
    sheet = project.sheets[0]
    assert {i.ref for i in sheet.instances} == {"V1", "R1", "#GND1"}
    assert "C1" not in describe(project)


def test_pin_errors_are_explained() -> None:
    project = _empty()
    add_component(project, "npn", ["c", "b", "e"])[1].apply(project)
    with pytest.raises(BuildError, match="pins: C, B, E"):
        connect_pins(project, "Q1.X", "Q1.C")
    with pytest.raises(BuildError, match="needs 3 nets"):
        add_component(project, "npn", ["c", "b"])


def test_bjt_with_builtin_model_and_no_model_card() -> None:
    parsed = parse_netlist("t\nQ1 c b e NPN\nQ2 c b e s NPN\nQ3 c b e NPN 2\n")
    assert [d.nodes for d in parsed.circuit.devices] == [["c", "b", "e"], ["c", "b", "e", "s"],
                                                          ["c", "b", "e"]]  # fmt: skip
    assert [d.model for d in parsed.circuit.devices] == ["NPN", "NPN", "NPN"]
