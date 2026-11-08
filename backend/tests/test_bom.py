"""Bill of materials (FR-DAT-9)."""

import csv
import io
import zipfile

from fastapi.testclient import TestClient

from bpt.document.model import Instance, Label, ModelRef, Project, Sheet
from bpt.io.bom import bom_csv, bom_rows, bom_xlsx
from bpt.library.components import component_sheets
from bpt.models import templates as tpl
from tests.test_api import H


def _part(ref: str, symbol: str, **params: str) -> Instance:
    return Instance(ref=ref, symbol=symbol, at=(0, 0), model=ModelRef(params=params))


def _project() -> Project:
    block = Sheet(name="stage", instances=[_part("R1", "bpt:resistor", R="10k")],
                  labels=[Label(kind="port", text="in", at=(0, 0))])  # fmt: skip
    project = Project(name="p", sheets=[Sheet(name="root"), block])
    component = tpl.template_component(
        tpl.get("capacitor"), {"Cnom": "10u", "esr": "5m"}, "Parts", "GRM10U",
        metadata={"manufacturer": "Murata", "part_number": "GRM21BR61E106KA73", "package": "0805"},
    )  # fmt: skip
    top, sheets = component_sheets(project, component)
    project.sheets += sheets
    project.sheets[0].instances = [
        _part("R1", "bpt:resistor", R="1k"), _part("R2", "bpt:resistor", R="1k"),
        _part("R10", "bpt:resistor", R="1k"), _part("C1", "bpt:capacitor", C="100n"),
        _part("C2", "bpt:capacitor", C="100n", esr="10m"), _part("V1", "bpt:vsource", dc="5"),
        _part("#GND1", "bpt:gnd"), _part("C3", f"sheet:{top}"), _part("C4", f"sheet:{top}"),
        _part("X1", "sheet:stage"), _part("X2", "sheet:stage"),
    ]  # fmt: skip
    return project


def test_rows_group_parts_and_expand_blocks() -> None:
    rows = {(r.part, r.value, r.status): r.references for r in bom_rows(_project())}
    assert rows[("Resistor", "1k", "to be chosen (ideal)")] == ["R1", "R2", "R10"]
    assert rows[("Resistor", "10k", "to be chosen (ideal)")] == ["X1/R1", "X2/R1"]
    assert rows[("Capacitor", "100n", "to be chosen (ideal)")] == ["C1"]
    assert rows[("Capacitor", "100n", "to be chosen (quick model)")] == ["C2"]
    assert rows[("GRM10U", "10u", "library part")] == ["C3", "C4"]
    assert not any("V1" in refs or "#GND1" in refs for refs in rows.values())


def test_csv_and_xlsx() -> None:
    table = list(csv.reader(io.StringIO(bom_csv(_project()))))
    assert table[0][:3] == ["Quantity", "References", "Value"]
    murata = next(r for r in table if r[3] == "GRM10U")
    assert murata[:3] == ["2", "C3, C4", "10u"]
    assert murata[4:7] == ["Murata", "GRM21BR61E106KA73", "0805"]
    with zipfile.ZipFile(io.BytesIO(bom_xlsx(_project()))) as book:
        sheet = book.read("xl/worksheets/sheet1.xml").decode()
        assert "GRM21BR61E106KA73" in sheet and '<c r="A2"><v>1</v></c>' in sheet  # C1 first
        assert "xl/workbook.xml" in book.namelist()


def test_formulas_neutralized() -> None:
    """A part name like =HYPERLINK(...) is text in the CSV; control characters leave the XLSX."""
    project = _project()
    project.sheets[0].instances[3].model.params["C"] = '=HYPERLINK("http://x")'
    project.sheets[0].instances[4].model.params["C"] = "-12V\x07"
    table = list(csv.reader(io.StringIO(bom_csv(project))))
    values = [r[2] for r in table]
    assert '\'=HYPERLINK("http://x")' in values and "1k" in values
    with zipfile.ZipFile(io.BytesIO(bom_xlsx(project))) as book:
        sheet = book.read("xl/worksheets/sheet1.xml").decode()
        assert "-12V<" in sheet and "\x07" not in sheet


def test_bom_endpoint(client: TestClient) -> None:
    pid = client.post("/api/projects", json={"name": "b"}, headers=H).json()["id"]
    client.post(f"/api/projects/{pid}/circuit/import", json={"text": "R1 a 0 1k\nV1 a 0 1"},
                headers=H)  # fmt: skip
    r = client.get(f"/api/projects/{pid}/export/bom", headers=H)
    assert r.status_code == 200 and "R1" in r.text and "V1" not in r.text
    assert 'filename="b-bom.csv"' in r.headers["content-disposition"]
    x = client.get(f"/api/projects/{pid}/export/bom?format=xlsx", headers=H)
    assert x.content[:2] == b"PK"
