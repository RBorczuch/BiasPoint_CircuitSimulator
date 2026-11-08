"""Manufacturer SPICE libraries: parsing, dialect conversion, subcircuit models in circuits."""

from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from bpt.document.builder import import_netlist
from bpt.document.commands import SetSubcircuit
from bpt.document.model import Project, Sheet
from bpt.engines.ngspice.engine import NgspiceEngine
from bpt.models.spicelib import convert_expression, detect_dialect, parse_library
from bpt.netlist.netlister import netlist_project
from bpt.netlist.ngspice_writer import write_netlist
from bpt.netlist.spice_parser import parse_analysis_card, parse_netlist
from bpt.results.store import ResultStore
from tests.test_golden import pytestmark as ngspice_marks

# Written for these tests in the styles of the three dialects (not copied from a vendor file).
PSPICE = """* test library
.MODEL DTEST D(IS=2.5n RS=0.5 N=1.75 CJO=4p BV=100 IBV=100u
+ TT=5n T_MEASURED=25)
.MODEL DFAST AKO:DTEST D(TT=1n)
.SUBCKT CLAMP IN OUT PARAMS: VMAX=5 GAIN=2
E1 OUT 0 VALUE={LIMIT(GAIN*V(IN), -VMAX, VMAX)}
G2 IN 0 TABLE {V(IN)} = (0,0) (1,1m) (2,4m)
B3 X 0 V={IF(V(IN)>1, 1, 0)}
R1 X 0 1k ; inline comment
.ENDS
.subckt SECRET A B
$CDNENCSTART
abcdef0123
$CDNENCEND
.ends SECRET
"""

LTSPICE = """.model 1N9999 D(Is=2.52n Rs=.568 N=1.752 Cjo=4p M=.4 tt=20n
+ Iave=200m Vpk=75 mfg=Test type=silicon)
.model QX NPN(IS=1E-14 VAF=100 BF=200 Vceo=40 Icrating=200m mfg=Test)
"""


def test_dialects_are_recognized() -> None:
    assert detect_dialect(PSPICE) == "pspice"
    assert detect_dialect(LTSPICE) == "ltspice"
    assert detect_dialect(".model D1 D(IS=1e-14)") == "ngspice"


def test_expressions_become_ngspice() -> None:
    assert convert_expression("IF(V(a)>1, 2, LIMIT(V(b), 5, -5))") == (
        "((V(a)>1) ? (2) : (min(max(V(b),-5),5)))"
    )
    assert convert_expression("TABLE(V(x), 0, 0, 1, 2)") == "pwl(V(x),0,0,1,2)"


def test_pspice_library_is_read_and_converted() -> None:
    parsed = parse_library(PSPICE, source="test.lib")
    by_name = {d.name: d for d in parsed.definitions}
    diode = by_name["DTEST"].model
    assert diode is not None and diode.type == "d" and diode.params["is"] == "2.5n"
    assert "t_measured" not in diode.params  # PSpice-only parameter dropped, with a note
    assert any("t_measured" in n for n in by_name["DTEST"].notes)
    fast = by_name["DFAST"].model  # AKO: the base parameters with its own on top
    assert fast is not None and fast.params["tt"] == "1n" and fast.params["is"] == "2.5n"
    clamp = by_name["CLAMP"].subckt
    assert clamp is not None and clamp.pins == ["IN", "OUT"]
    assert clamp.params == {"vmax": "5", "gain": "2"}
    body = "\n".join(clamp.body)
    assert "B1_E OUT 0 V={min(max(GAIN*V(IN),-VMAX),VMAX)}" in body
    assert "B2_G IN 0 I={pwl(V(IN),0,0,1,1m,2,4m)}" in body
    assert "B3 X 0 V={((V(IN)>1) ? (1) : (0))}" in body
    assert "R1 X 0 1k" in body and ".SUBCKT CLAMP" in clamp.original
    assert by_name["SECRET"].encrypted


def test_ltspice_informational_parameters_are_dropped() -> None:
    parsed = parse_library(LTSPICE)
    diode = next(d for d in parsed.definitions if d.name == "1N9999").model
    assert diode is not None
    assert set(diode.params) == {"is", "rs", "n", "cjo", "m", "tt"}


SUBCKT_DIODE = """.subckt ZENER5 A K
D1 A K DF
D2 K A DR
.model DF D(IS=1e-14)
.model DR D(IS=1e-14 N=0.5)
V1 X 0 0
.ends
"""


@ngspice_marks[0]
@ngspice_marks[1]
def test_a_part_simulates_with_a_subcircuit_model(tmp_path: Path) -> None:
    """A diode symbol whose model is a subcircuit becomes an X element (pins by name)."""
    zener = next(d for d in parse_library(SUBCKT_DIODE).definitions if d.name == "ZENER5")
    assert zener.subckt is not None
    project = Project(name="z", sheets=[Sheet(name="root")])
    import_netlist(
        project, parse_netlist("* z\nV1 in 0 DC 10\nR1 in k 1k\nD1 0 k D"), "root"
    ).apply(project)
    SetSubcircuit(name="ZENER5", subckt=zener.subckt).apply(project)
    diode = next(i for i in project.sheet("root").instances if i.ref == "D1")
    diode.model.model = "ZENER5"
    result = netlist_project(project)
    assert [i.message for i in result.issues if i.severity == "error"] == []
    lines = write_netlist(result.circuit)
    assert ".subckt ZENER5 A K" in lines and any(x.startswith("XD1 0 k ZENER5") for x in lines)
    engine = NgspiceEngine()
    try:
        meta = engine.run(result.circuit, parse_analysis_card(".op"), ResultStore(tmp_path))
    finally:
        engine.close()
    assert meta.status == "ok", meta.error
    v = float(np.real(np.asarray(ResultStore(tmp_path).open(meta.run_id).signal("V(k)"))[0]))
    assert 0.3 < v < 1.0  # breakdown of the reverse diode (N=0.5): well below 10 V


def test_pin_map_errors_are_reported() -> None:
    project = Project(name="m", sheets=[Sheet(name="root")])
    import_netlist(
        project, parse_netlist("* m\nV1 in 0 DC 1\nR1 in 0 1k\nD1 in 0 D"), "root"
    ).apply(project)
    zener = next(d for d in parse_library(SUBCKT_DIODE).definitions if d.name == "ZENER5")
    assert zener.subckt is not None
    three = zener.subckt.model_copy(update={"pins": ["A", "K", "X"]})
    SetSubcircuit(name="Z3", subckt=three).apply(project)
    diode = next(i for i in project.sheet("root").instances if i.ref == "D1")
    diode.model.model = "Z3"
    assert "pin-map" in [i.code for i in netlist_project(project).issues]
    diode.model.pins = ["A", "K", "=0"]  # third pin tied to ground
    assert "pin-map" not in [i.code for i in netlist_project(project).issues]


@pytest.mark.parametrize("text", ["", "* only comments\n"])
def test_empty_files_give_nothing(text: str) -> None:
    assert parse_library(text).definitions == []


def test_import_api_makes_parts(client: TestClient, tmp_path: Path) -> None:
    from tests.test_api import H

    path = tmp_path / "vendor.lib"
    path.write_text(PSPICE + SUBCKT_DIODE, encoding="utf-8")
    preview = client.post("/api/library/import/spice/preview", json={"path": str(path)}, headers=H)
    assert preview.status_code == 200, preview.text
    items = {i["name"]: i for i in preview.json()["items"]}
    assert preview.json()["dialect"] == "pspice"
    assert items["DTEST"]["symbol"] == "bpt:diode" and items["SECRET"]["encrypted"]
    assert items["ZENER5"]["symbol"] == "bpt:diode" and items["ZENER5"]["pin_map"] == ["A", "K"]
    assert items["CLAMP"]["symbol"] == "generic"
    chosen = [
        {"name": n, "symbol": items[n]["symbol"], "pin_map": items[n]["pin_map"]}
        for n in ("DTEST", "ZENER5", "CLAMP", "SECRET")
    ]
    report = client.post(
        "/api/library/import/spice",
        json={"path": str(path), "library": "Vendor", "items": chosen},
        headers=H,
    ).json()
    assert report["imported"] == 3 and report["skipped"] == ["SECRET: encrypted"]
    ids = {s["id"]: s for s in client.get("/api/library/symbols", headers=H).json()}
    assert ids["part:Vendor/DTEST"]["default_model"] == "DTEST"
    assert ids["part:Vendor/ZENER5"]["spice"] == {"element": "X", "nodes": ["A", "K"]}
    assert ids["part:Vendor/CLAMP"]["spice"]["nodes"] == ["IN", "OUT"]
    models = client.get("/api/library/models", headers=H).json()
    assert "DTEST" in models["models"] and "ZENER5" in models["subcircuits"]
    assert "OPAMP" in models["subcircuits"]  # built-in
    # Each model is also a real part: in its category, with its symbol inside its sheet.
    assert report["parts"] == ["cmp:Vendor/DTEST", "cmp:Vendor/ZENER5", "cmp:Vendor/CLAMP"]
    assert (
        ids["cmp:Vendor/DTEST"]["group"] == "Diodes" and ids["cmp:Vendor/DTEST"]["kind"] == "diode"
    )
    assert ids["part:Vendor/DTEST"]["group"] is None  # listed as its part only


def test_pin_map_is_undoable() -> None:
    from bpt.document.commands import SetParams

    project = Project(name="u", sheets=[Sheet(name="root")])
    import_netlist(project, parse_netlist("* u\nD1 a 0 D"), "root").apply(project)
    diode = project.sheet("root").instances[0]
    inverse = SetParams(id=diode.id, model="ZENER5", pins=["K", "A"]).apply(project)
    assert diode.model.model == "ZENER5" and diode.model.pins == ["K", "A"]
    inverse.apply(project)
    assert diode.model.model == "D" and diode.model.pins is None


def test_models_pasted_as_text_make_a_part(client: TestClient) -> None:
    from tests.test_api import H

    text = ".SUBCKT PASTEAMP INP INN VCC VEE OUT\nE1 OUT 0 INP INN 1e5\nR1 INP INN 1meg\n.ENDS\n"
    preview = client.post("/api/library/import/spice/preview", json={"text": text}, headers=H)
    assert preview.status_code == 200, preview.text
    item = preview.json()["items"][0]
    assert (item["name"], item["symbol"]) == ("PASTEAMP", "bpt:opamp")
    choice = {"name": "PASTEAMP", "symbol": item["symbol"], "pin_map": item["pin_map"]}
    r = client.post(
        "/api/library/import/spice",
        headers=H,
        json={"text": text, "library": "Pasted", "items": [choice]},
    )
    assert r.status_code == 200, r.text
    assert r.json()["parts"] == ["cmp:Pasted/PASTEAMP"]
    client.delete("/api/library/libraries/Pasted", headers=H)
