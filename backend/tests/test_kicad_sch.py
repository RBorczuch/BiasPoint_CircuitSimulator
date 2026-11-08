"""KiCad schematic import: geometry (pins land on wires), hierarchy, values, simulation."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from bpt.library.blocks import project_symbols
from bpt.library.kicad_sch import import_schematic, placement
from bpt.netlist.connectivity import resolve_nets, transform
from bpt.netlist.netlister import netlist_project
from bpt.netlist.ngspice_writer import write_netlist
from tests.test_api import H

FIXTURES = Path(__file__).parent / "fixtures" / "kicad"


def _kicad(point: tuple[int, int], angle: int, mirror: str) -> tuple[int, int]:
    """KiCad's own placement: turn counter-clockwise (y down), then mirror."""
    x, y = point
    for _ in range(angle // 90):
        x, y = y, -x
    if mirror == "x":
        y = -y
    if mirror == "y":
        x = -x
    return x, y


@pytest.mark.parametrize("angle", [0, 90, 180, 270])
@pytest.mark.parametrize("mirror", ["", "x", "y"])
def test_placement_matches_kicad(angle: int, mirror: str) -> None:
    from bpt.document.model import Instance

    rot, flip = placement(angle, mirror)
    part = Instance(ref="R1", symbol="x", at=(0, 0), rot=rot, mirror=flip)  # type: ignore[arg-type]
    for point in [(127, -381), (-254, 127), (0, 508)]:
        assert transform(point, part) == _kicad(point, angle, mirror)


def test_real_schematic_pins_land_on_wires() -> None:
    result = import_schematic(FIXTURES / "ECL-OR.kicad_sch")
    project = result.project
    sheet = project.sheets[0]
    assert len(sheet.instances) == 22 and len(sheet.wires) == 78
    assert (
        project.simulation.active == "tran"
        and project.simulation.cards["tran"] == ".tran 0.1n 100u"
    )
    symbols = project_symbols(project)
    nets = resolve_nets(project, symbols)
    lonely = sorted(
        f"{inst.ref}.{pin}"
        for (iid, pin), net in nets.pin_net.items()
        for inst in sheet.instances
        if inst.id == iid and len(nets.members[net]) == 1
        and not any(n == net for n in nets.item_net.values())
    )  # fmt: skip
    # Only the substrate pins of two transistors are left open in the drawing itself.
    assert lonely == ["Q1.4", "Q3.4"]
    result_netlist = netlist_project(project, symbols)
    lines = write_netlist(result_netlist.circuit)
    assert any(line.startswith("V2 in1 0 DC -1.75 pulse(") for line in lines), lines
    # The transistors are subcircuits (Spice_Primitive X): their model is not in the file.
    missing = sorted(i.refs[0] for i in result_netlist.issues if i.code == "missing-model")
    assert missing == ["Q1", "Q2", "Q3", "Q4", "Q5"] and "hicumL0V1p1_c_sbt" in str(
        result_netlist.issues
    )


def test_hierarchy_values_and_directives() -> None:
    result = import_schematic(FIXTURES / "hier" / "top.kicad_sch")
    project = result.project
    assert [s.name for s in project.sheets] == ["root", "divider"]
    block = project.sheet("divider").symbol
    assert block is not None and [p.number for p in block.pins] == ["IN"]
    lines = write_netlist(netlist_project(project, project_symbols(project)).circuit)
    text = "\n".join(lines)
    assert "V1 n001 0 DC 5" in text, text
    assert "R1 n001 n002 1k" in text, text
    assert ".subckt sheet_divider in" in text and "X1 n002 sheet_divider" in text, text
    assert "R2 0 in 2.2k" in text, text  # "R?" numbered after R1; the GND label is the 0 node
    assert ".param K=2" in text and project.simulation.cards["tran"] == ".tran 1u 1m"


def test_import_endpoint_opens_a_project(client: TestClient) -> None:
    top = str(FIXTURES / "hier" / "top.kicad_sch")
    r = client.post("/api/projects/import/kicad", json={"path": top}, headers=H)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["project"]["name"] == "top" and body["project"]["dirty"] is True
    bad = client.post("/api/projects/import/kicad", json={"path": str(FIXTURES / "nope.kicad_sch")},
                      headers=H)  # fmt: skip
    assert bad.status_code == 404


def test_a_pin_on_ground_or_a_global_net_in_a_block_is_connected() -> None:
    project = import_schematic(FIXTURES / "hier" / "top.kicad_sch").project
    issues = netlist_project(project, project_symbols(project)).issues
    assert [i.code for i in issues if i.severity == "error"] == []
