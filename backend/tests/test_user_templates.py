"""User templates of equivalent circuits (FR-CMP-9) and the standard examples."""

from collections.abc import Iterator
from itertools import count
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from bpt.analysis.spec import AcAnalysis, AnalysisSpec, OpAnalysis, TranAnalysis
from bpt.document.builder import place_component
from bpt.document.model import Project, Sheet
from bpt.engines.ngspice.engine import NgspiceEngine
from bpt.library.blocks import project_symbols
from bpt.library.components import component_sheets
from bpt.models import user_templates as utpl
from bpt.models.standard_templates import standard_templates
from bpt.netlist.netlister import netlist_project
from bpt.results.store import ResultStore
from tests.test_api import H


def _two_c_sheet(client: TestClient) -> str:
    """A project whose sheet "twocap" is two capacitors in parallel ({c1}, {c2}) between ports."""
    pid = client.post("/api/projects", json={"name": "maker"}, headers=H).json()["id"]
    command = {"type": "add_sheet", "sheet": {"name": "twocap",
                                              "parameters": {"c1": "1u", "c2": "10n"}}}  # fmt: skip
    client.post(f"/api/projects/{pid}/commands", json={"command": command}, headers=H)
    text = "C1 1 2 {c1}\nC2 1 2 {c2}"
    r = client.post(f"/api/projects/{pid}/circuit/import", json={"text": text, "sheet": "twocap"},
                    headers=H)  # fmt: skip
    assert r.status_code == 200, r.text
    doc = client.get(f"/api/projects/{pid}/document", headers=H).json()["project"]
    sheet = next(s for s in doc["sheets"] if s["name"] == "twocap")
    ports = [{"kind": "port", "text": lb["text"], "at": lb["at"]} for lb in sheet["labels"]]
    command = {"type": "add_objects", "sheet": "twocap", "labels": ports}
    client.post(f"/api/projects/{pid}/commands", json={"command": command}, headers=H)
    return pid


def test_save_a_sheet_as_template_and_make_components(client: TestClient) -> None:
    pid = _two_c_sheet(client)
    symbols = client.get(f"/api/components/templates/symbols?project_id={pid}&sheet=twocap",
                         headers=H).json()  # fmt: skip
    assert {"bpt:capacitor", "bpt:resistor", "bpt:inductor"} <= set(symbols)
    body = {"project_id": pid, "sheet": "twocap", "library": "Mine", "name": "Two caps",
            "kind": "capacitor", "description": "bulk + HF capacitor", "symbol": "bpt:capacitor",
            "fields": [{"key": "c1", "label": "C bulk", "unit": "F", "required": True},
                       {"key": "c2", "label": "C HF", "unit": "F"}]}  # fmt: skip
    saved = client.post("/api/components/templates", json=body, headers=H)
    assert saved.status_code == 200, saved.text
    template = saved.json()
    assert template["id"] == "tpl:Mine/Two caps" and template["version"] == 1
    assert [(f["key"], f["label"], f["default"]) for f in template["fields"]] == [
        ("c1", "C bulk", "1u"), ("c2", "C HF", "10n")]  # fmt: skip

    listed = {t["name"]: t for t in client.get("/api/components/templates", headers=H).json()}
    assert listed["tpl:Mine/Two caps"]["ports"] == ["1", "2"]
    assert listed["capacitor"]["library"] == ""  # the built-in ones are there too
    assert {"tpl:Standard templates/Real transformer", "tpl:Standard templates/NPN with package",
            "tpl:Standard templates/Op-amp macromodel"} <= set(listed)  # fmt: skip

    drawn = client.post("/api/components/templates/circuit", headers=H, json={
        "template": "tpl:Mine/Two caps", "form": {"c1": "4.7u"}}).json()  # fmt: skip
    assert drawn["parameters"] == {"c1": "4.7u", "c2": "10n"}
    assert "<svg" in drawn["svg"] and "4.7 µF" in drawn["svg"]  # values written into the drawing
    builtin = client.post("/api/components/templates/circuit", headers=H, json={
        "template": "capacitor", "form": {"Cnom": "1u", "esr": "1"}}).json()  # fmt: skip
    assert builtin["ports"] == ["1", "2"] and "<svg" in builtin["svg"]

    made = client.post("/api/components/from-template", headers=H, json={
        "template": "tpl:Mine/Two caps", "form": {"c1": "22u"}, "library": "Parts",
        "name": "C22U_HF"})  # fmt: skip
    assert made.status_code == 200, made.text
    component = made.json()
    assert component["kind"] == "capacitor"
    assert component["template"] == {"name": "tpl:Mine/Two caps", "values": {"c1": "22u"}}
    assert component["sheets"][0]["parameters"] == {"c1": "22u", "c2": "10n"}
    part = {s["id"]: s for s in client.get("/api/library/symbols", headers=H).json()}
    assert {p["number"]: p["at"] for p in part["cmp:Parts/C22U_HF"]["pins"]} == {
        "1": [0, -381], "2": [0, 381]}  # fmt: skip

    missing = client.post(
        "/api/components/from-template",
        headers=H,
        json={
            "template": "tpl:Mine/Two caps",
            "form": {"c1": " "},
            "library": "Parts",
            "name": "x",
        },
    )
    assert missing.status_code == 200  # the default fills an empty field

    # Saving the sheet again with a change is a new version of the template.
    body["description"] = "bulk + HF, v2"
    again = client.post("/api/components/templates", json=body, headers=H).json()
    assert again["version"] == 2


@pytest.mark.ngspice
def test_user_template_card_and_fit_by_simulation(client: TestClient) -> None:
    pid = _two_c_sheet(client)
    body = {"project_id": pid, "sheet": "twocap", "library": "Mine", "name": "Two caps",
            "kind": "capacitor"}  # fmt: skip
    assert client.post("/api/components/templates", json=body, headers=H).status_code == 200
    card = client.post("/api/components/templates/card", headers=H, json={
        "template": "tpl:Mine/Two caps", "form": {"c1": "1u"}}).json()  # fmt: skip
    curves = {c["name"] for c in card["curves"]}
    assert {"|Z|(f)", "C(V)"} <= curves
    f = np.logspace(2, 6, 9)
    points = [[x, 1 / (2 * np.pi * x * 2.21e-6)] for x in f]  # 2.2 µF + 10 nF
    fitted = client.post("/api/components/templates/fit", headers=H, json={
        "template": "tpl:Mine/Two caps", "form": {"c1": "1u"}, "free": ["c1"],
        "characteristics": [{"name": "|Z|(f)", "points": points}]}).json()  # fmt: skip
    assert fitted["values"]["c1"] == "2.2u"


# -- standard templates in ngspice ------------------------------------------------------------


@pytest.fixture(scope="module")
def engine() -> Iterator[NgspiceEngine]:
    engine = NgspiceEngine()
    yield engine
    engine.close()


def _simulate(engine: NgspiceEngine, tmp_path: Path, template_name: str,
              parts: list[tuple[str, str, list[str], dict[str, str]]],
              analysis: AnalysisSpec, form: dict[str, str] | None = None
              ) -> dict[str, np.ndarray]:  # fmt: skip
    """Place the template's component as X1 with ``parts`` around it; signals by name."""
    template = next(t for t in standard_templates() if t.name == template_name)
    project = Project(name="t", sheets=[Sheet(name="root")])
    component = utpl.component_from_template(template, form or {}, "Std", "part")
    top, sheets = component_sheets(project, component)
    project.sheets += sheets
    symbols = project_symbols(project)
    grounds = count(1)
    for k, (ref, symbol, nets, params) in enumerate(parts):
        symbol_id = f"sheet:{top}" if symbol == "part" else symbol
        add = place_component(symbols[symbol_id], ref, nets, (3000 * k, 0), params, None, grounds)
        project.sheets[0].instances += add.instances
        project.sheets[0].wires += add.wires
        project.sheets[0].labels += add.labels
    result = netlist_project(project)
    assert not [i for i in result.issues if i.severity == "error"], result.issues
    store = ResultStore(tmp_path)
    meta = engine.run(result.circuit, analysis, store)
    assert meta.status == "ok", meta.error
    reader = store.open(meta.run_id)
    return {s.name: np.asarray(reader.signal(s.name)) for s in meta.signals}


@pytest.mark.ngspice
def test_opamp_macromodel_follows(engine: NgspiceEngine, tmp_path: Path) -> None:
    out = _simulate(engine, tmp_path, "Op-amp macromodel", [
        ("X1", "part", ["in", "out", "out", "vp", "vn"], {}),  # + - out V+ V- (block order)
        ("V1", "bpt:vsource", ["in", "0"], {"dc": "1.5"}),
        ("V2", "bpt:vsource", ["vp", "0"], {"dc": "5"}),
        ("V3", "bpt:vsource", ["vn", "0"], {"dc": "-5"}),
        ("R1", "bpt:resistor", ["out", "0"], {"R": "10k"}),
    ], OpAnalysis())  # fmt: skip
    assert float(out["V(out)"][0].real) == pytest.approx(1.5, abs=1e-3)  # gain 200k follower
    # The supply gives the quiescent current and the load current (from V+, as in a real part).
    assert float(-out["I(V2)"][0].real) == pytest.approx(1e-3 + 1.5 / 10e3, rel=0.01)


# LM358 typical datasheet values (TI): GBW 0.7 MHz, slew rate 0.3 V/us, Aol 100 dB, Vos 3 mV.
_LM358 = {"aol": "100k", "gbw": "700k", "sr": "300k", "vos": "3m", "ib": "20n", "cmrr": "80",
          "psrr": "100", "vohigh": "1.5", "volow": "5m", "iout": "40m", "iq": "350u"}  # fmt: skip
_FOLLOWER = [
    ("V2", "bpt:vsource", ["vp", "0"], {"dc": "10"}),
    ("V3", "bpt:vsource", ["vn", "0"], {"dc": "-10"}),
    ("X1", "part", ["in", "out", "out", "vp", "vn"], {}),  # + - out V+ V- (block order)
    ("R1", "bpt:resistor", ["out", "0"], {"R": "10k"}),
]


@pytest.mark.ngspice
def test_opamp_from_lm358_datasheet_reproduces_gbw_slew_rate_and_offset(
    engine: NgspiceEngine, tmp_path: Path
) -> None:
    """Todo 6 golden (M2 criterion): the macromodel made from the datasheet's values shows
    them in simulation - the follower's bandwidth is the GBW, a large step slews at SR."""
    source = ("V1", "bpt:vsource", ["in", "0"], {"dc": "0", "ac": "1"})
    ac = _simulate(engine, tmp_path, "Op-amp macromodel", [source, *_FOLLOWER],
                   AcAnalysis(points=100, fstart="1k", fstop="100meg"), _LM358)  # fmt: skip
    f = np.real(ac["frequency"])
    gain_db = 20 * np.log10(np.abs(ac["V(out)"]))
    f3db = float(np.interp(-3, gain_db[::-1], f[::-1]))
    assert f3db == pytest.approx(700e3, rel=0.1)

    step = (
        "V1",
        "bpt:vsource",
        ["in", "0"],
        {"dc": "-3", "tran": "PULSE(-3 3 10u 1n 1n 100u 200u)"},
    )
    tr = _simulate(engine, tmp_path, "Op-amp macromodel", [step, *_FOLLOWER],
                   TranAnalysis(tstep="50n", tstop="60u"), _LM358)  # fmt: skip
    t, v = np.real(tr["time"]), np.real(tr["V(out)"])
    rising = slice(int(np.searchsorted(t, 10e-6)), None)
    t1 = float(np.interp(-2, v[rising], t[rising]))
    t2 = float(np.interp(2, v[rising], t[rising]))
    assert 4 / (t2 - t1) == pytest.approx(0.3e6, rel=0.1)  # V/s

    dc = _simulate(engine, tmp_path, "Op-amp macromodel",
                   [("V1", "bpt:vsource", ["in", "0"], {"dc": "0"}), *_FOLLOWER], OpAnalysis(),
                   _LM358)  # fmt: skip
    assert float(np.real(dc["V(out)"])[0]) == pytest.approx(3e-3, abs=0.5e-3)  # Vos (+ CMRR, PSRR)


@pytest.mark.ngspice
def test_real_transformer_ratio(engine: NgspiceEngine, tmp_path: Path) -> None:
    out = _simulate(engine, tmp_path, "Real transformer", [
        ("X1", "part", ["in", "0", "sec", "0"], {}),
        ("V1", "bpt:vsource", ["src", "0"], {"dc": "0", "ac": "1"}),
        ("R0", "bpt:resistor", ["src", "in"], {"R": "1"}),
        ("R1", "bpt:resistor", ["sec", "0"], {"R": "100k"}),
    ], AcAnalysis(variation="lin", points=1, fstart="10k", fstop="10k"))  # fmt: skip
    ratio = abs(out["V(sec)"][0]) / abs(out["V(in)"][0])
    assert ratio == pytest.approx(0.5 * 0.995, rel=0.01)  # n = 0.5, k = 0.995


@pytest.mark.ngspice
def test_npn_with_package_amplifies(engine: NgspiceEngine, tmp_path: Path) -> None:
    out = _simulate(engine, tmp_path, "NPN with package", [
        ("X1", "part", ["c", "b", "0"], {}),
        ("V1", "bpt:vsource", ["vcc", "0"], {"dc": "10"}),
        ("R1", "bpt:resistor", ["vcc", "c"], {"R": "1k"}),
        ("R2", "bpt:resistor", ["vcc", "b"], {"R": "470k"}),
    ], OpAnalysis())  # fmt: skip
    vc = float(out["V(c)"][0].real)
    assert 0.2 < vc < 9.5  # base current through 470k: the transistor conducts


@pytest.mark.ngspice
@pytest.mark.parametrize(("name", "nets", "current", "low", "high"), [
    ("Diode (signal)", ["a", "0"], "10m", 0.65, 0.85),  # 1N4148: 0.74 V at 10 mA
    ("LED", ["a", "0"], "20m", 1.7, 2.2),  # red LED
    ("Zener diode", ["0", "a"], "5m", 5.0, 5.2),  # reverse: the Zener voltage
])  # fmt: skip
def test_standard_diodes(engine: NgspiceEngine, tmp_path: Path, name: str, nets: list[str],
                         current: str, low: float, high: float) -> None:  # fmt: skip
    """The model on the sheet (``.model devmodel`` with the fields) netlists and simulates."""
    out = _simulate(engine, tmp_path, name, [
        ("X1", "part", nets, {}),
        ("I1", "bpt:isource", ["0", "a"], {"dc": current}),
    ], OpAnalysis())  # fmt: skip
    assert low < float(out["V(a)"][0].real) < high


@pytest.mark.ngspice
@pytest.mark.parametrize(("name", "nets", "supply", "bias", "low", "high"), [
    ("NPN transistor", ["b", "c", "0"], "5", "0.72", 1e-3, 50e-3),
    ("PNP transistor", ["b", "c", "0"], "-5", "-0.72", -50e-3, -1e-3),
    ("N-channel MOSFET", ["b", "c", "0"], "5", "3", 0.45, 0.55),  # KP/2·(3-1.6)² = 0.49 A
    ("P-channel MOSFET", ["b", "c", "0"], "-5", "-3", -0.3, -0.2),  # 0.25/2·1.4² = 0.245 A
    ("N-channel JFET", ["b", "c", "0"], "5", "0", 0.8e-3, 0.9e-3),  # Idss = β·Vp² = 0.83 mA
    ("P-channel JFET", ["b", "c", "0"], "-5", "0", -27e-3, -24e-3),  # Idss = 1.6m·16 = 25.6 mA
])  # fmt: skip
def test_standard_transistors(engine: NgspiceEngine, tmp_path: Path, name: str, nets: list[str],
                              supply: str, bias: str, low: float, high: float) -> None:  # fmt: skip
    # Nets in the block's node order: the gate / base port is on the left, so it comes first.
    out = _simulate(engine, tmp_path, name, [
        ("X1", "part", nets, {}),
        ("V1", "bpt:vsource", ["c", "0"], {"dc": supply}),
        ("V2", "bpt:vsource", ["b", "0"], {"dc": bias}),
    ], OpAnalysis())  # fmt: skip
    current = -float(out["I(V1)"][0].real)  # into the collector / drain
    assert low < current < high


@pytest.mark.ngspice
def test_semiconductor_cards(client: TestClient) -> None:
    """Datasheet curves of the standard diode and transistors, with the form's values."""

    def card(template: str, form: dict[str, str]) -> dict[tuple[str, str], dict]:
        body = {"template": f"tpl:Standard templates/{template}", "form": form}
        r = client.post("/api/components/templates/card", headers=H, json=body)
        assert r.status_code == 200, r.text
        return {(c["name"], c["label"]): c for c in r.json()["curves"]}

    diode = card("Diode (signal)", {})
    forward = diode[("I-V forward", "")]
    assert np.interp(10e-3, forward["y"], forward["x"]) == pytest.approx(0.74, abs=0.05)
    reverse = diode[("I-V reverse", "")]
    assert np.interp(1e-3, reverse["y"], reverse["x"]) == pytest.approx(100, abs=2)  # BV
    zener = card("Zener diode", {"bv": "12"})[("I-V reverse", "")]
    assert np.interp(5e-3, zener["y"], zener["x"]) == pytest.approx(12, abs=0.2)

    npn = card("NPN transistor", {"bf": "200", "ise": "0"})  # no low-current leakage
    family = [c for (name, _l), c in npn.items() if name == "Ic(Vce)"]
    assert len(family) == 5 and family[0]["label"].startswith("Ib = ")
    peak = max(npn[("hFE(Ic)", "")]["y"])
    assert peak == pytest.approx(200 * (1 + 5 / 74.03), rel=0.03)  # BF with the Early effect
    nmos = card("N-channel MOSFET", {})
    transfer = nmos[("Id(Vgs)", "")]
    assert np.interp(3.0, transfer["x"], transfer["y"]) == pytest.approx(0.49, rel=0.05)
    pmos = card("P-channel MOSFET", {})  # shown as magnitudes like an N-channel part
    assert max(pmos[("Id(Vgs)", "")]["y"]) > 0.5


@pytest.mark.ngspice
def test_transformer_and_opamp_cards(client: TestClient) -> None:
    """Curves of the four- and five-pin standard templates against their formulas."""

    def card(template: str, form: dict[str, str]) -> dict[tuple[str, str], dict]:
        body = {"template": f"tpl:Standard templates/{template}", "form": form}
        r = client.post("/api/components/templates/card", headers=H, json=body)
        assert r.status_code == 200, r.text
        return {(c["name"], c["label"]): c for c in r.json()["curves"]}

    def at(curve: dict, x: float) -> float:
        return float(np.interp(np.log10(x), np.log10(curve["x"]), curve["y"]))

    # Lp 1 mH, Ns/Np 0.5, k 0.995, Rp 0.2 Ω, Rs 0.05 Ω (the defaults).
    xf = card("Real transformer", {})
    assert at(xf[("Ratio(f)", "")], 10e3) == pytest.approx(0.995 * 0.5, rel=0.01)  # k·n open
    open_z = at(xf[("|Zin|(f)", "secondary open")], 1e3)
    assert open_z == pytest.approx(abs(0.2 + 2j * np.pi * 1e3 * 1e-3), rel=0.02)  # Rp + jωLp
    # Shorted: the leakage Lp(1 - k²) and Rp + Rs/n².
    leak = 1e-3 * (1 - 0.995**2)
    short_z = at(xf[("|Zin|(f)", "secondary shorted")], 10e3)
    assert short_z == pytest.approx(abs(0.2 + 0.05 / 0.25 + 2j * np.pi * 10e3 * leak), rel=0.03)

    amp = card("Op-amp macromodel", {"gbw": "10meg", "sr": "5meg"})
    gain = amp[("Aol(f)", "")]
    assert gain["y"][0] == pytest.approx(20 * np.log10(200e3), abs=0.2)  # Aol at 0.1 Hz
    unity = float(np.interp(0, gain["y"][::-1], gain["x"][::-1]))
    assert unity == pytest.approx(10e6, rel=0.05)  # GBW
    swing = amp[("Vout(Vin)", "")]
    assert max(swing["y"]) == pytest.approx(12 - 1.5, abs=0.05)  # swing to V+
    assert min(swing["y"]) == pytest.approx(-12 + 0.1, abs=0.05)  # swing to V-
    step = amp[("Vout(t)", "output")]
    slope = np.max(np.diff(step["y"]) / np.diff(step["x"]))
    assert slope == pytest.approx(5e6, rel=0.1)  # the slew rate


def test_remove_a_template_and_a_component(client: TestClient) -> None:
    pid = _two_c_sheet(client)
    body = {"project_id": pid, "sheet": "twocap", "library": "Mine", "name": "Two caps"}
    assert client.post("/api/components/templates", json=body, headers=H).status_code == 200
    made = {"template": "tpl:Mine/Two caps", "form": {}, "library": "Mine", "name": "C1U"}
    assert client.post("/api/components/from-template", json=made, headers=H).status_code == 200
    r = client.delete("/api/library/templates?id=tpl:Mine/Two caps", headers=H)
    assert r.status_code == 200, r.text
    names = {t["name"] for t in client.get("/api/components/templates", headers=H).json()}
    assert "tpl:Mine/Two caps" not in names
    assert client.delete("/api/library/components?id=cmp:Mine/C1U", headers=H).status_code == 200
    assert "cmp:Mine/C1U" not in client.get("/api/library/components", headers=H).json()
    assert client.delete("/api/library/components?id=cmp:Mine/C1U", headers=H).status_code == 404
    std = client.delete("/api/library/templates?id=tpl:Standard templates/Real transformer",
                        headers=H)  # fmt: skip
    assert std.status_code == 404


def test_form_order_groups_and_limits() -> None:
    """The form keeps the editor's order and groups; values outside min / max are refused."""
    from bpt.document.builder import import_netlist
    from bpt.document.model import Label, TemplateField
    from bpt.netlist.spice_parser import parse_netlist

    params = {"a": "1", "b": "2"}
    project = Project(name="f", sheets=[Sheet(name="root"), Sheet(name="t", parameters=params)])
    import_netlist(project, parse_netlist("R1 1 2 {a}\nR2 1 2 {b}"), sheet_name="t").apply(project)
    sheet = project.sheet("t")
    for k, text in enumerate(["1", "2"]):
        sheet.labels.append(Label(kind="port", text=text, at=(k * 1270, 0)))
    fields = [TemplateField(key="b", label="B", group="Loss", minimum="1", maximum="10k")]
    template = utpl.make_template(project, "t", "Lib", "T", fields=fields)
    assert [(f.key, f.group) for f in template.fields] == [("b", "Loss"), ("a", "")]
    assert utpl.form_values(template, {"b": "4k7"})["b"] == "4k7"
    for bad in ("0.5", "20k"):
        with pytest.raises(utpl.UserTemplateError, match="B must be"):
            utpl.form_values(template, {"b": bad})
    assert utpl.form_values(template, {"b": "{2*x}"})["b"] == "{2*x}"  # expressions pass
