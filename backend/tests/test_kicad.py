"""KiCad symbol import, user libraries and the project's copies of library symbols."""

import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from bpt.document.builder import import_netlist
from bpt.document.commands import SetSymbol
from bpt.document.model import Instance, Label, ModelCard, Project, Sheet
from bpt.document.storage import load_project, save_project
from bpt.library.kicad import import_kicad
from bpt.library.sexpr import parse
from bpt.netlist.connectivity import transform
from bpt.netlist.netlister import netlist_project
from bpt.netlist.ngspice_writer import write_netlist
from bpt.netlist.spice_parser import parse_netlist
from tests.test_api import H

# A small library in the KiCad format, written for these tests (not taken from KiCad).
LIBRARY = r"""(kicad_symbol_lib (version 20241209) (generator "test")
  (symbol "RES" (pin_numbers (hide yes)) (pin_names (offset 0))
    (property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27))))
    (property "Value" "4k7" (at 0 0 90) (effects (font (size 1.27 1.27))))
    (property "Description" "Test resistor" (at 0 0 0) (effects (hide yes)))
    (symbol "RES_0_1"
      (rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254)) (fill (type none))))
    (symbol "RES_1_1"
      (pin passive line (at 0 3.81 270) (length 1.27) (name "~") (number "1"))
      (pin passive line (at 0 -3.81 90) (length 1.27) (name "~") (number "2"))))
  (symbol "AMP" (pin_names (offset 0.127))
    (property "Reference" "U" (at 0 5.08 0) (effects (font (size 1.27 1.27))))
    (property "Value" "AMP" (at 0 -5.08 0) (effects (font (size 1.27 1.27))))
    (symbol "AMP_1_1"
      (polyline (pts (xy -5.08 5.08) (xy 5.08 0) (xy -5.08 -5.08) (xy -5.08 5.08))
        (stroke (width 0.254)) (fill (type background)))
      (pin output line (at 7.62 0 180) (length 2.54) (name "~") (number "1"))
      (pin input line (at -7.62 -2.54 0) (length 2.54) (name "-") (number "2"))
      (pin input line (at -7.62 2.54 0) (length 2.54) (name "+") (number "3")))
    (symbol "AMP_2_1"
      (pin power_in line (at -2.54 -7.62 90) (length 3.81) (name "V-") (number "4"))))
  (symbol "AMP2" (extends "AMP")
    (property "Reference" "U" (at 0 5.08 0) (effects (font (size 1.27 1.27))))
    (property "Value" "AMP2" (at 0 -5.08 0) (effects (font (size 1.27 1.27))))
    (property "Description" "Derived \"quoted\" amp" (at 0 0 0) (effects (hide yes))))
  (symbol "GND" (power) (pin_names (offset 0))
    (property "Reference" "#PWR" (at 0 -6.35 0) (effects (hide yes)))
    (property "Value" "GND" (at 0 -3.81 0) (effects (font (size 1.27 1.27))))
    (symbol "GND_0_1"
      (polyline (pts (xy 0 0) (xy 0 -1.27) (xy 1.27 -1.27) (xy 0 -2.54) (xy -1.27 -1.27)
        (xy 0 -1.27)) (stroke (width 0)) (fill (type none))))
    (symbol "GND_1_1"
      (pin power_in line (at 0 0 270) (length 0) (hide yes) (name "GND") (number "1"))))
  (symbol "CHIP"
    (property "Reference" "U" (at 0 0 0) (effects (font (size 1.27 1.27))))
    (symbol "CHIP_1_1"
      (rectangle (start -5.08 5.08) (end 5.08 -5.08) (stroke (width 0)) (fill (type background)))
      (text "~{CS}" (at 0 0 0) (effects (font (size 1.27 1.27))))
      (pin input line (at -7.62 0 0) (length 2.54) (name "~{CS}") (number "1"))
      (pin power_in line (at 0 7.62 270) (length 2.54) (hide yes) (name "VCC") (number "2"))
      (pin power_in line (at 0 -7.62 90) (length 2.54) (hide yes) (name "GND") (number "3")))))
"""


@pytest.fixture
def library_file(tmp_path: Path) -> Path:
    path = tmp_path / "Test.kicad_sym"
    path.write_text(LIBRARY, encoding="utf-8")
    return path


def test_sexpr_reads_strings_and_lists() -> None:
    expr = parse(r'(a "x \"y\"" (b 1 2) c)')
    assert expr == ["a", 'x "y"', ["b", "1", "2"], "c"]


def test_kicad_symbols_convert(library_file: Path) -> None:
    name, result = import_kicad(library_file)
    assert name == "Test" and result.skipped == []
    by_name = {s.name: s for s in result.symbols}
    res = by_name["RES"]
    assert res.ref_prefix == "R" and res.spice is not None and res.spice.element == "R"
    assert res.default_params == {"R": "4k7"} and res.value_param == "R"
    pin1 = res.pin("1")
    # mm (y up) -> 0.01 mm (y down); the pin sticks out upwards from the body.
    assert pin1.at == (0, -381) and pin1.orientation == "up" and pin1.length == 127
    amp = by_name["AMP (A)"]
    assert amp.spice is not None and amp.spice.element == "E"
    assert amp.spice.nodes == ["1", "=0", "3", "2"]  # ideal op-amp: out, ground, +, -
    assert {p.number for p in amp.pins} == {"1", "2", "3"}  # unit A
    assert "unit A of 2" in amp.description and amp.id == "kicad:Test/AMP"
    power_unit = by_name["AMP (B)"]  # the supply pins, a symbol of its own
    assert power_unit.id == "kicad:Test/AMP:B" and power_unit.spice is None
    assert [p.number for p in power_unit.pins] == ["4"]
    derived = by_name["AMP2 (A)"]
    assert derived.pins == amp.pins and derived.description.startswith('Derived "quoted" amp')
    gnd = by_name["GND"]
    assert gnd.power_net == "0" and gnd.spice is None
    chip = by_name["CHIP"]
    assert chip.spice is None and "not simulated" in chip.description
    assert any(getattr(g, "text", "") == "CS" for g in chip.graphics)  # overbar markup removed
    # Hidden power pins join their nets by name (KiCad), GND being the ground.
    assert {p.name: p.implicit_net for p in chip.pins if p.implicit_net} == {
        "VCC": "VCC",
        "GND": "0",
    }


def test_imported_symbol_is_kept_in_the_project(library_file: Path, tmp_path: Path) -> None:
    _name, result = import_kicad(library_file)
    res = next(s for s in result.symbols if s.name == "RES")
    project = Project(name="k", sheets=[Sheet(name="root")])
    import_netlist(project, parse_netlist("* k\nV1 a 0 DC 1"), "root").apply(project)
    inverse = SetSymbol(id=res.id, symbol=res).apply(project)
    inst = Instance(ref="R1", symbol=res.id, at=(5080, 0))
    project.sheet("root").instances.append(inst)
    for pin, net in (("1", "a"), ("2", "0")):
        project.sheet("root").labels.append(Label(text=net, at=transform(res.pin(pin).at, inst)))
    assert "R1 a 0 4.7k" in write_netlist(netlist_project(project).circuit)

    save_project(project, tmp_path / "k.bpt")
    assert (tmp_path / "k.bpt" / "symbols.json").is_file()
    again = load_project(tmp_path / "k.bpt")
    assert again.symbols[res.id] == res
    inverse.apply(project)
    assert project.symbols == {}


def test_unsimulated_part_is_an_erc_warning(library_file: Path) -> None:
    _name, result = import_kicad(library_file)
    chip = next(s for s in result.symbols if s.name == "CHIP")
    project = Project(name="c", sheets=[Sheet(name="root")], symbols={chip.id: chip})
    project.sheet("root").instances.append(Instance(ref="U1", symbol=chip.id, at=(0, 0)))
    codes = [i.code for i in netlist_project(project).issues]
    assert "not-simulated" in codes


def test_import_api_makes_a_user_library(client: TestClient, library_file: Path) -> None:
    report = client.post("/api/library/import/kicad", json={"path": str(library_file)}, headers=H)
    assert report.status_code == 200, report.text
    assert report.json()["library"] == "Test" and report.json()["imported"] == 7
    libs = client.get("/api/library/libraries", headers=H).json()
    assert [(lib["name"], lib["count"]) for lib in libs if not lib["standard"]] == [("Test", 7)]
    ids = {s["id"] for s in client.get("/api/library/symbols", headers=H).json()}
    assert "kicad:Test/RES" in ids and "bpt:resistor" in ids
    missing = client.post("/api/library/import/kicad", json={"path": "nope.kicad_sym"}, headers=H)
    assert missing.status_code == 404
    assert client.delete("/api/library/libraries/Test", headers=H).status_code == 200
    assert all(lib["standard"] for lib in client.get("/api/library/libraries", headers=H).json())


REFERENCE = Path(__file__).parents[2] / "Referencje" / "kicad-symbols"


@pytest.mark.skipif(not REFERENCE.is_dir(), reason="KiCad symbol libraries not available")
@pytest.mark.parametrize("library", ["Device", "Transistor_BJT", "Amplifier_Operational", "power"])
def test_kicad_reference_libraries_import(library: str) -> None:
    if os.environ.get("BPT_SKIP_SLOW"):
        pytest.skip("slow")
    _name, result = import_kicad(REFERENCE / f"{library}.kicad_symdir")
    assert result.skipped == [] and len(result.symbols) > 50


def test_hidden_power_pins_join_nets_by_name(library_file: Path) -> None:
    from bpt.netlist.connectivity import resolve_nets

    _name, result = import_kicad(library_file)
    chip = next(s for s in result.symbols if s.name == "CHIP")
    project = Project(name="h", sheets=[Sheet(name="root")], symbols={chip.id: chip})
    u1 = Instance(ref="U1", symbol=chip.id, at=(0, 0))
    project.sheet("root").instances.append(u1)
    project.sheet("root").labels.append(Label(text="VCC", kind="global", at=(9000, 0)))
    nets = resolve_nets(project, {chip.id: chip})
    assert nets.pin_net[(u1.id, "2")] == "VCC" and nets.pin_net[(u1.id, "3")] == "0"


def test_symbol_editor_saves_into_a_library(client: TestClient) -> None:
    from bpt.library.builtin import builtin_symbols

    copy = builtin_symbols()["bpt:resistor"].model_copy(
        update={"id": "user:Mine/RES2", "name": "RES2", "description": "edited"}
    )
    saved = client.post("/api/library/symbols", json={"library": "Mine",
                        "symbol": copy.model_dump(mode="json")}, headers=H)  # fmt: skip
    assert saved.status_code == 200, saved.text
    assert saved.json()["category"] == "Mine"
    ids = {s["id"] for s in client.get("/api/library/symbols", headers=H).json()}
    assert "user:Mine/RES2" in ids
    builtin = builtin_symbols()["bpt:resistor"].model_dump(mode="json")
    refused = client.post("/api/library/symbols", json={"library": "Mine", "symbol": builtin},
                          headers=H)  # fmt: skip
    assert refused.status_code == 422
    gone = client.delete("/api/library/symbols", params={"library": "Mine", "id": "user:Mine/RES2"},
                         headers=H)  # fmt: skip
    assert gone.status_code == 200


def test_standard_libraries_are_listed_and_read_only(
    client: TestClient, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from bpt.library import libraries
    from bpt.library.builtin import builtin_symbols

    folder = tmp_path / "standard"
    folder.mkdir()
    part = builtin_symbols()["bpt:diode"].model_copy(
        update={"id": "std:Diodes/1N4148", "name": "1N4148", "category": "Diodes"}
    )
    card = ModelCard(type="d", params={"IS": "2.5n"})
    std = libraries.Library(name="Diodes", symbols=[part], models={"D1N4148": card})
    (folder / "diodes.json").write_text(std.model_dump_json(), encoding="utf-8")
    monkeypatch.setenv("BPT_STANDARD_LIBRARY_DIR", str(folder))

    infos = {i["name"]: i for i in client.get("/api/library/libraries", headers=H).json()}
    assert infos["Diodes"]["standard"] is True and infos["Diodes"]["count"] == 1
    ids = {s["id"] for s in client.get("/api/library/symbols", headers=H).json()}
    assert "std:Diodes/1N4148" in ids
    assert "D1N4148" in client.get("/api/library/models", headers=H).json()["models"]
    assert client.delete("/api/library/libraries/Diodes", headers=H).status_code == 409
    mine = part.model_copy(update={"id": "user:Diodes/X"})
    saved = client.post("/api/library/symbols", json={"library": "Diodes",
                        "symbol": mine.model_dump(mode="json")}, headers=H)  # fmt: skip
    assert saved.status_code == 409
