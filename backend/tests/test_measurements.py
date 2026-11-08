"""Measurements: CSV columns with units, .bptm.json files, the instrument API (phase 6)."""

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from bpt.models.measurements import header_unit, read_csv
from tests.test_api import H

KEYSIGHT = """# LCR meter export
Frequency [kHz];|Z| [mOhm];Phase [deg]
1,0;15900,5;-89,2
10,0;1590,1;-88,7
100,0;170,3;-80,1
"""


def test_headers_give_units_and_prefixes() -> None:
    assert header_unit("Frequency [kHz]") == ("Hz", 1e3)
    assert header_unit("|Z| (mOhm)") == ("Ω", 1e-3)
    assert header_unit("Phase / deg") == ("°", 1.0)
    assert header_unit("Vce") == ("", 1.0)


def test_a_semicolon_file_with_decimal_commas() -> None:
    table = read_csv(KEYSIGHT)
    assert table.delimiter == ";" and table.decimal_comma
    assert [c.name for c in table.columns] == ["Frequency [kHz]", "|Z| [mOhm]", "Phase [deg]"]
    assert table.rows[0] == [1.0, 15900.5, -89.2]
    assert table.skipped == 2  # the comment and the header


def test_csv_to_points_in_the_characteristics_units(client: TestClient) -> None:
    summary = client.post("/api/measurements/csv", headers=H, json={"text": KEYSIGHT}).json()
    assert summary["rows"] == 3 and summary["columns"][0]["scale"] == 1e3
    got = client.post("/api/measurements/csv/points", headers=H,
                      json={"text": KEYSIGHT, "kind": "|Z|(f)", "x": 0, "y": 1}).json()  # fmt: skip
    assert got["points"][0] == pytest.approx([1e3, 15.9005])
    assert (got["x_unit"], got["y_unit"]) == ("Hz", "Ω")
    assert any("scaled" in n for n in got["notes"])
    # A unit that does not fit the characteristic is taken as it is, and said.
    wrong = client.post(
        "/api/measurements/csv/points",
        headers=H,
        json={"text": KEYSIGHT, "kind": "|Z|(f)", "x": 0, "y": 2},
    ).json()
    assert any("taken as it is" in n for n in wrong["notes"])


def test_a_measurement_file_saved_and_opened(client: TestClient, tmp_path: Path) -> None:
    measurement = {"name": "C1 sample", "part": "CL21A106", "instrument": "LCR",
                   "characteristics": [{"name": "|Z|(f)", "x_unit": "Hz", "y_unit": "Ω",
                                        "points": [[1000, 15.9], [100000, 0.17]],
                                        "source": "measurement"}]}  # fmt: skip
    saved = client.post(
        "/api/measurements/save",
        headers=H,
        json={"path": str(tmp_path / "c1"), "measurement": measurement},
    ).json()
    assert saved["path"].endswith("c1.bptm.json")
    opened = client.post("/api/measurements/open", headers=H, json={"path": saved["path"]}).json()
    assert opened["characteristics"][0]["points"] == [[1000, 15.9], [100000, 0.17]]
    (tmp_path / "other.json").write_text('{"format": "x"}', encoding="utf-8")
    bad = client.post(
        "/api/measurements/open", headers=H, json={"path": str(tmp_path / "other.json")}
    )
    assert bad.status_code == 422 and "not a measurement" in bad.json()["detail"]


def test_instruments_upload_and_stream(client: TestClient) -> None:
    stored = client.post("/api/measurements", headers=H, json={
        "name": "sweep", "instrument": "curve tracer",
        "characteristics": [{"name": "VF(IF)", "points": [[0.001, 0.62]]}],
    }).json()  # fmt: skip
    listed = client.get("/api/measurements", headers=H).json()
    assert listed[0]["id"] == stored["id"] and listed[0]["points"] == 1
    # Streamed batches: over HTTP, then over the instrument's WebSocket.
    client.post(
        "/api/measurements/stream",
        headers=H,
        json={"measurement": stored["id"], "characteristic": "VF(IF)", "points": [[0.01, 0.75]]},
    )
    with client.websocket_connect("ws://127.0.0.1:8765/ws/instrument", headers=H) as ws:
        batch = {"measurement": stored["id"], "characteristic": "VF(IF)", "points": [[0.1, 0.95]]}
        ws.send_text(json.dumps(batch))
        answer = ws.receive_json()
        assert answer == {"type": "ok", "id": stored["id"], "points": 3}
        ws.send_text("{not json")
        assert ws.receive_json()["type"] == "error"
    points = client.get(f"/api/measurements/{stored['id']}", headers=H).json()
    assert points["characteristics"][0]["points"] == [[0.001, 0.62], [0.01, 0.75], [0.1, 0.95]]


def test_measured_points_fit_like_a_datasheets(client: TestClient, tmp_path: Path) -> None:
    """A measurement file's |Z|(f) points (of a capacitor with known values) fitted by the
    template fit: the same pipeline as a datasheet's points."""
    import numpy as np

    from bpt.models import templates as tpl

    template = tpl.get("capacitor")
    truth = tpl.numbers(template, {"Cnom": "4.7u", "esr": "12m", "esl": "800p"})
    freqs = np.logspace(2, 8, 20)
    z = np.abs(tpl.impedance(template, truth, freqs))
    measurement = {"name": "C7", "characteristics": [{
        "name": "|Z|(f)", "x_unit": "Hz", "y_unit": "Ω", "source": "measurement",
        "points": [[float(f), float(v)] for f, v in zip(freqs, z, strict=True)]}]}  # fmt: skip
    path = client.post(
        "/api/measurements/save",
        headers=H,
        json={"path": str(tmp_path / "c7"), "measurement": measurement},
    ).json()["path"]
    opened = client.post("/api/measurements/open", headers=H, json={"path": path}).json()
    r = client.post("/api/components/templates/fit", headers=H, json={
        "template": "capacitor", "form": {"Cnom": "1u", "esr": "1", "esl": "10n"},
        "free": ["Cnom", "esr", "esl"], "characteristics": opened["characteristics"], "bounds": {},
    })  # fmt: skip
    assert r.status_code == 200, r.text
    from bpt.units import parse_value

    values = r.json()["values"]
    assert parse_value(values["Cnom"]) == pytest.approx(4.7e-6, rel=0.01)
    assert parse_value(values["esl"]) == pytest.approx(800e-12, rel=0.01)
