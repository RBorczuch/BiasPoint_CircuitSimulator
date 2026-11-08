"""Diode parameters fitted to datasheet points (phase 6): VF(IF) and Cj(VR)."""

from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from bpt.document.model import Characteristic
from bpt.engines.ngspice.engine import NgspiceEngine
from bpt.models.semi_fit import diode_curves, fit_diode, zener_values
from bpt.netlist.spice_parser import parse_analysis_card, parse_netlist
from bpt.results.store import ResultStore, RunReader
from bpt.units import parse_value
from tests.test_api import H
from tests.test_golden import pytestmark as golden_marks

# The widely used D1N4148 model (the defaults of the "Diode (signal)" template).
D1N4148 = {"is": 2.52e-9, "n": 1.752, "rs": 0.568, "cjo": 4e-12, "vj": 0.75, "mj": 0.333}


def _char(
    name: str, xs: np.ndarray, values: dict[str, float], noise: float = 0.0
) -> Characteristic:
    probe = Characteristic(name=name, points=[(float(x), 1.0) for x in xs])
    ys = diode_curves(values, [probe])[0]
    rng = np.random.default_rng(1)
    ys = ys * (1 + noise * rng.standard_normal(len(ys)))
    return Characteristic(
        name=name, points=[(float(x), float(y)) for x, y in zip(xs, ys, strict=True)]
    )


def test_fit_recovers_the_parameters_from_noisy_points() -> None:
    vf = _char("VF(IF)", np.logspace(-4, -0.6, 12), D1N4148, noise=0.003)
    cj = _char("Cj(VR)", np.linspace(0, 20, 8), D1N4148, noise=0.01)
    result = fit_diode({"is": "1e-14", "n": "1", "rs": "0.1"}, ["is", "n", "rs", "cjo", "vj", "mj"],
                       [vf, cj])  # fmt: skip
    assert result.max_error < 3
    assert parse_value(result.values["n"]) == pytest.approx(1.752, rel=0.05)
    assert parse_value(result.values["rs"]) == pytest.approx(0.568, rel=0.15)


def test_1n4148_forward_voltage_within_3_percent() -> None:
    """Todo 6 criterion: VF error below 3 % over the datasheet's range (0.1 mA - 300 mA),
    starting from a generic diode (IS = 10 fA, N = 1)."""
    vf = _char("VF(IF)", np.array([0.1e-3, 0.3e-3, 1e-3, 3e-3, 10e-3, 30e-3, 100e-3, 300e-3]),
               D1N4148)  # fmt: skip
    result = fit_diode({"is": "10f", "n": "1", "rs": "0.1"}, ["is", "n", "rs"], [vf])
    assert result.max_error < 3, result.curves[0].residuals


def test_limits_and_unknown_parameters() -> None:
    vf = _char("VF(IF)", np.logspace(-4, -1, 8), D1N4148)
    held = fit_diode({}, ["is", "n", "rs"], [vf], {"rs": (None, 0.1)})
    assert parse_value(held.values["rs"]) <= 0.1 * 1.0001
    with pytest.raises(ValueError, match="cannot fit tt"):
        fit_diode({}, ["tt"], [vf])


@golden_marks[0]
@golden_marks[1]
def test_the_formula_matches_ngspice(tmp_path: Path) -> None:
    """The fitted parameters go into a SPICE .model: its simulated VF at 10 mA must be the
    formula's (same thermal voltage, series resistance)."""
    p = D1N4148
    text = f"* d\nI1 0 a 10m\nD1 a 0 DMOD\n.model DMOD D(IS={p['is']} N={p['n']} RS={p['rs']})"
    engine = NgspiceEngine()
    try:
        meta = engine.run(
            parse_netlist(text).circuit, parse_analysis_card(".op"), ResultStore(tmp_path)
        )
    finally:
        engine.close()
    assert meta.status == "ok", meta.error
    simulated = float(np.real(ResultStore(tmp_path).open(meta.run_id).signal("V(a)"))[-1])
    formula = diode_curves(p, [Characteristic(name="VF(IF)", points=[(10e-3, 1.0)])])[0][0]
    assert simulated == pytest.approx(formula, rel=1e-3)


def test_fit_through_the_api(client: TestClient) -> None:
    vf = _char("VF(IF)", np.logspace(-4, -1, 8), D1N4148)
    body = {"template": "tpl:Standard templates/Diode (signal)", "form": {},
            "free": ["is", "n", "rs"], "characteristics": [vf.model_dump()]}  # fmt: skip
    r = client.post("/api/components/templates/fit", json=body, headers=H)
    assert r.status_code == 200, r.text
    assert r.json()["max_error"] < 1


def test_zener_from_datasheet_values_and_from_points() -> None:
    """BZX84C5V1-like: VZ = 5.1 V at IZT = 5 mA, ZZT = 40 ohm."""
    values = zener_values(5.1, 5e-3, 40)
    params = {**D1N4148, "n": 1.0, **values}
    probe = Characteristic(name="VZ(IZ)", points=[(5e-3, 1.0), (5.5e-3, 1.0)])
    v5, v55 = diode_curves(params, [probe])[0]
    assert v5 == pytest.approx(5.1, rel=1e-6)
    assert (v55 - v5) / 0.5e-3 == pytest.approx(40, rel=0.05)
    # The knee from points: BV, IBV and RS fitted.
    vz = _char("VZ(IZ)", np.logspace(-4, -1.5, 8), params)
    fitted = fit_diode({"n": "1"}, ["bv", "ibv", "rs"], [vz])
    assert fitted.max_error < 0.5


@golden_marks[0]
@golden_marks[1]
def test_zener_values_simulate_as_the_datasheet_says(tmp_path: Path) -> None:
    z = zener_values(5.1, 5e-3, 40)
    model = f"D(IS=1e-14 N=1 RS={z['rs']} BV={z['bv']} IBV={z['ibv']})"
    engine = NgspiceEngine()
    try:
        volts = []
        for iz in (5e-3, 5.5e-3):
            text = f"* z\nI1 0 k {iz}\nD1 0 k DZ\n.model DZ {model}"
            meta = engine.run(parse_netlist(text).circuit, parse_analysis_card(".op"),
                              ResultStore(tmp_path))  # fmt: skip
            assert meta.status == "ok", meta.error
            run = ResultStore(tmp_path).open(meta.run_id)
            volts.append(float(np.real(run.signal("V(k)"))[-1]))
    finally:
        engine.close()
    assert volts[0] == pytest.approx(5.1, rel=2e-3)
    assert (volts[1] - volts[0]) / 0.5e-3 == pytest.approx(40, rel=0.05)


@golden_marks[0]
@golden_marks[1]
def test_led_from_its_typical_forward_voltage(tmp_path: Path) -> None:
    """The wizard's LED colours set IS so that VF = 2.0 V at 20 mA (red: N = 2, RS = 8)."""
    import math

    from bpt.models.semi_fit import VT

    n, rs, vf, i = 2.0, 8.0, 2.0, 20e-3
    is_ = i / math.expm1((vf - i * rs) / (n * VT))
    text = f"* led\nI1 0 a {i}\nD1 a 0 LED\n.model LED D(IS={is_:.6g} N={n} RS={rs})"
    engine = NgspiceEngine()
    try:
        meta = engine.run(parse_netlist(text).circuit, parse_analysis_card(".op"),
                          ResultStore(tmp_path))  # fmt: skip
    finally:
        engine.close()
    assert meta.status == "ok", meta.error
    run = ResultStore(tmp_path).open(meta.run_id)
    assert float(np.real(run.signal("V(a)"))[-1]) == pytest.approx(vf, rel=1e-3)


# 2N7002 typical datasheet values (approximate): Vth 2.1 V at 250 uA with Vds = Vgs,
# RDS(on) 1.2 ohm at Vgs = 10 V and 1.7 ohm at 4.5 V.
_2N7002 = [Characteristic(name="Id(Vgs)", points=[(2.1, 250e-6)]),
           Characteristic(name="RDS(Vgs)", points=[(4.5, 1.7), (10, 1.2)])]  # fmt: skip


@golden_marks[0]
@golden_marks[1]
def test_2n7002_threshold_and_on_resistance_in_ngspice(tmp_path: Path) -> None:
    """Todo 6 golden: the fitted level-1 model gives the datasheet's Vth and RDS(on) when
    simulated (W = L = 1 as in the template)."""
    from bpt.models.semi_fit import fit_mosfet

    result = fit_mosfet({}, ["vto", "kp", "rs"], _2N7002)
    v = {k: parse_value(result.values[k]) for k in ("vto", "kp", "rs")}
    model = f"NMOS(LEVEL=1 VTO={v['vto']} KP={v['kp']} RS={v['rs']})"
    engine = NgspiceEngine()
    try:

        def drain(vgs: float, vds: float) -> float:
            text = f"* m\nVG g 0 {vgs}\nVD d 0 {vds}\nM1 d g 0 0 NM W=1 L=1\n.model NM {model}"
            meta = engine.run(parse_netlist(text).circuit, parse_analysis_card(".op"),
                              ResultStore(tmp_path))  # fmt: skip
            assert meta.status == "ok", meta.error
            return -float(np.real(ResultStore(tmp_path).open(meta.run_id).signal("I(VD)"))[-1])

        assert drain(2.1, 2.1) == pytest.approx(250e-6, rel=0.03)
        assert 0.05 / drain(10, 0.05) == pytest.approx(1.2, rel=0.03)
        assert 0.05 / drain(4.5, 0.05) == pytest.approx(1.7, rel=0.03)
    finally:
        engine.close()


def test_p_channel_points_are_negative_as_in_the_datasheet() -> None:
    from bpt.models.semi_fit import fit_mosfet

    pmos = [Characteristic(name="Id(Vgs)", points=[(-2.1, -250e-6)]),
            Characteristic(name="RDS(Vgs)", points=[(-4.5, 1.7), (-10, 1.2)])]  # fmt: skip
    result = fit_mosfet({"vto": "-1.6"}, ["vto", "kp", "rs"], pmos, sign=-1)
    assert parse_value(result.values["vto"]) == pytest.approx(-2.07, abs=0.02)
    assert result.max_error < 0.5


def test_mosfet_capacitances_from_ciss_coss_crss() -> None:
    from bpt.models.semi_fit import mosfet_values

    assert mosfet_values(50e-12, 25e-12, 5e-12) == pytest.approx(
        {"cgso": 45e-12, "cgdo": 5e-12, "cbd": 20e-12}
    )


# BC547B typical datasheet values (approximate): hFE 150 at 10 uA, 290 at 2 mA, 180 at 100 mA
# (Vce = 5 V); VCE(sat) 0.09 V at 10 mA and 0.2 V at 100 mA with Ib = Ic / 20; VBE 0.66 V at 2 mA.
_BC547 = [
    Characteristic(name="hFE(Ic)", points=[(10e-6, 150), (2e-3, 290), (100e-3, 180)]),
    Characteristic(name="VCEsat(Ic)", points=[(10e-3, 0.09), (100e-3, 0.2)], at={"beta": 20}),
    Characteristic(name="VBE(Ic)", points=[(2e-3, 0.66)]),
]
_START = {"is": "6.734f", "bf": "416", "ikf": "66m", "ise": "6.7f", "ne": "1.26", "br": "0.74",
          "rb": "10", "rc": "1", "vaf": "74"}  # fmt: skip
_FREE = ["is", "bf", "ikf", "ise", "ne", "rc", "br"]


@golden_marks[0]
@golden_marks[1]
def test_bc547_gain_and_saturation_in_ngspice(tmp_path: Path) -> None:
    """Todo 6 golden: the fitted Gummel-Poon model gives the datasheet's hFE and VCE(sat)."""
    from bpt.models.semi_fit import fit_bjt

    result = fit_bjt(_START, _FREE, _BC547)
    assert result.max_error < 1
    v = {k: result.values[k] for k in ("is", "bf", "ikf", "ise", "ne", "br", "rb", "rc", "vaf")}
    model = "NPN(" + " ".join(f"{k.upper()}={val}" for k, val in v.items()) + ")"
    engine = NgspiceEngine()
    store = ResultStore(tmp_path)
    try:

        def op(text: str) -> RunReader:
            meta = engine.run(parse_netlist(f"* q\n{text}\n.model QN {model}").circuit,
                              parse_analysis_card(".op"), store)  # fmt: skip
            assert meta.status == "ok", meta.error
            return store.open(meta.run_id)

        for ic, vce_sat in ((10e-3, 0.09), (100e-3, 0.2)):
            run = op(f"IC 0 c {ic}\nIB 0 b {ic / 20}\nQ1 c b 0 QN")
            assert float(np.real(run.signal("V(c)"))[-1]) == pytest.approx(vce_sat, rel=0.03)
        # hFE at 2 mA: a base current source, the collector held at 5 V.
        ib = 2e-3 / 290
        run = op(f"VC c 0 5\nIB 0 b {ib}\nQ1 c b 0 QN")
        ic = -float(np.real(run.signal("I(VC)"))[-1])
        assert ic / ib == pytest.approx(290, rel=0.03)
    finally:
        engine.close()


def test_pnp_points_are_negative_and_capacitances_from_ft() -> None:
    from bpt.models.semi_fit import bjt_values, fit_bjt

    pnp = [c.model_copy(update={"points": [(-x, y if c.name == "hFE(Ic)" else -y)
                                           for x, y in c.points]}) for c in _BC547]  # fmt: skip
    assert fit_bjt(_START, _FREE, pnp, sign=-1).max_error < 1
    values = bjt_values(300e6, 10e-3, 4e-12, 9e-12)
    assert values["cjc"] == 4e-12 and values["cje"] == 9e-12
    assert values["tf"] == pytest.approx(
        1 / (2 * np.pi * 300e6) - 13e-12 * 0.025865 / 10e-3, rel=1e-3
    )


# -- output curves: compared with ngspice, then fitted ---------------------------------------------


def _family(client: TestClient, template: str, form: dict[str, str], name: str
            ) -> tuple[float, list[tuple[float, float]]]:  # fmt: skip
    """The highest curve of a card's output family: its step (Vgs or Ib) and points on it."""
    r = client.post("/api/components/templates/card", headers=H,
                    json={"template": template, "form": form})  # fmt: skip
    assert r.status_code == 200, r.text
    family = [c for c in r.json()["curves"] if c["name"] == name]
    top = family[-1]
    step = parse_value(top["label"].split("=")[1].strip().replace(" ", ""))
    pts = [(x, y) for x, y in zip(top["x"], top["y"], strict=True) if 2 <= abs(x) <= 10]
    return step, pts[:: max(1, len(pts) // 8)]


@golden_marks[0]
def test_mosfet_output_curve_matches_ngspice_and_fits_lambda(client: TestClient) -> None:
    template = "tpl:Standard templates/N-channel MOSFET"
    form = {"lambda": "0.05"}
    vgs, pts = _family(client, template, form, "Id(Vds)")
    char = Characteristic(name="Id(Vds)", points=pts, at={"Vgs": vgs})
    r = client.post("/api/components/templates/fit", headers=H, json={
        "template": template, "form": {"lambda": "0.005"}, "free": ["lambda"],
        "characteristics": [char.model_dump()], "bounds": {},
    })  # fmt: skip
    assert r.status_code == 200, r.text
    result = r.json()
    assert result["max_error"] < 3  # the formulas follow ngspice
    assert parse_value(result["values"]["lambda"]) == pytest.approx(0.05, rel=0.1)


@golden_marks[0]
def test_bjt_output_curve_matches_ngspice_and_fits_vaf(client: TestClient) -> None:
    template = "tpl:Standard templates/NPN transistor"
    form = {"vaf": "60"}
    ib, pts = _family(client, template, form, "Ic(Vce)")
    char = Characteristic(name="Ic(Vce)", points=pts, at={"Ib": ib})
    r = client.post("/api/components/templates/fit", headers=H, json={
        "template": template, "form": {"vaf": "300"}, "free": ["vaf"],
        "characteristics": [char.model_dump()], "bounds": {},
    })  # fmt: skip
    assert r.status_code == 200, r.text
    result = r.json()
    assert result["max_error"] < 3
    assert parse_value(result["values"]["vaf"]) == pytest.approx(60, rel=0.1)


def test_output_points_need_their_condition() -> None:
    from bpt.models import fit
    from bpt.models.semi_fit import fit_bjt, fit_mosfet

    pts = [(2.0, 0.1), (5.0, 0.11)]
    with pytest.raises(fit.FitError, match="Vgs"):
        fit_mosfet({}, ["lambda"], [Characteristic(name="Id(Vds)", points=pts)])
    with pytest.raises(fit.FitError, match="Ib"):
        fit_bjt({}, ["vaf"], [Characteristic(name="Ic(Vce)", points=pts)])


def _plateau(curve: dict) -> tuple[float, np.ndarray]:
    """The Miller plateau of a Vgs(Qg) curve: the gate voltage it stays at longest (samples are
    even in charge), and the charges spent there."""
    x, y = np.array(curve["x"]), np.array(curve["y"])
    counts, edges = np.histogram(y[(y > 0.5) & (y < 9.5)], bins=np.arange(0.5, 9.6, 0.1))
    k = int(np.argmax(counts))
    level = float((edges[k] + edges[k + 1]) / 2)
    return level, x[np.abs(y - level) < 0.15]


@golden_marks[0]
def test_gate_charge_values_give_the_datasheet_charge_in_ngspice(client: TestClient) -> None:
    """The card's Vgs(Qg) of a MOSFET with the capacitances from Qgs, Qgd and the plateau: the
    plateau starts near Qgs and ends near Qgs + Qgd."""
    from bpt.models.semi_fit import gate_charge_values

    qgs, qgd = 2e-9, 4e-9
    template = "tpl:Standard templates/N-channel MOSFET"

    def card(form: dict[str, str]) -> dict:
        r = client.post("/api/components/templates/card", headers=H,
                        json={"template": template, "form": form})  # fmt: skip
        assert r.status_code == 200, (form, r.text)
        return next(c for c in r.json()["curves"] if c["name"] == "Vgs(Qg)")

    plain = card({})
    vdd = parse_value(plain["label"].split(",")[0].split("=")[1].replace(" ", ""))
    plateau, _flat = _plateau(plain)  # (where this part's gate stalls at the bench's current)
    values = gate_charge_values(qgs, qgd, plateau, vdd)
    _level, flat = _plateau(card({k: f"{v:.4g}" for k, v in values.items()}))
    assert flat.min() == pytest.approx(qgs, rel=0.1)
    assert flat.max() == pytest.approx(qgs + qgd, rel=0.1)


@golden_marks[0]
def test_level3_mosfet_follows_ngspice_and_fits_theta(client: TestClient) -> None:
    """The level 3 template's transfer curve in ngspice and the formula with THETA agree; THETA
    and KP come back from points of it."""
    template = "tpl:Standard templates/N-channel MOSFET (level 3)"
    r = client.post("/api/components/templates/card", headers=H,
                    json={"template": template, "form": {"theta": "0.3", "kp": "0.8"}})  # fmt: skip
    assert r.status_code == 200, r.text
    transfer = next(c for c in r.json()["curves"] if c["name"] == "Id(Vgs)")
    pts = [(x, y) for x, y in zip(transfer["x"], transfer["y"], strict=True) if y > 1e-3]
    pts = pts[:: max(1, len(pts) // 8)]
    char = Characteristic(name="Id(Vgs)", points=pts, at={"Vds": 5.0})
    r = client.post("/api/components/templates/fit", headers=H, json={
        "template": template, "form": {"theta": "0.05", "kp": "0.5"}, "free": ["theta", "kp"],
        "characteristics": [char.model_dump()], "bounds": {},
    })  # fmt: skip
    assert r.status_code == 200, r.text
    result = r.json()
    assert result["max_error"] < 3
    assert parse_value(result["values"]["theta"]) == pytest.approx(0.3, rel=0.1)
    assert parse_value(result["values"]["kp"]) == pytest.approx(0.8, rel=0.1)
