"""Equivalent-circuit templates, fitting and component cards (FR-CMP)."""

import math
from collections.abc import Iterator

import numpy as np
import pytest
from fastapi.testclient import TestClient

from bpt.document.model import Characteristic, Project
from bpt.engines.ngspice.engine import NgspiceEngine
from bpt.library.builtin import builtin_symbols
from bpt.models import bench
from bpt.models import templates as tpl
from bpt.models.fit import fit_sheet, fit_template
from bpt.netlist.netlister import netlist_project
from bpt.netlist.ngspice_writer import write_netlist
from tests.test_api import H

TWO_PI = 2 * math.pi


def _points(name: str, form: dict[str, str], kind: str, xs: np.ndarray) -> Characteristic:
    template = tpl.get(name)
    values = tpl.numbers(template, form)
    if kind == "C(V)":
        ys = tpl.capacitance(template, values, xs)
    elif kind == "L(I)":
        ys = tpl.inductance(template, values, xs)
    else:
        z = tpl.impedance(template, values, xs)
        ys = {"|Z|(f)": np.abs(z), "ESR(f)": z.real}[kind]
    return Characteristic(name=kind, points=list(zip(xs.tolist(), ys.tolist(), strict=True)))


def test_capacitor_impedance_follows_the_formulas() -> None:
    template = tpl.get("capacitor")
    values = tpl.numbers(template, {"Cnom": "10u", "esr": "20m", "esl": "2n"})
    srf = 1 / (TWO_PI * math.sqrt(10e-6 * 2e-9))
    z = tpl.impedance(template, values, np.array([100.0, srf, 1e9]))
    assert abs(z[0]) == pytest.approx(1 / (TWO_PI * 100 * 10e-6), rel=1e-3)
    assert z[1].real == pytest.approx(0.02) and abs(z[1].imag) < 1e-9
    assert abs(z[2]) == pytest.approx(TWO_PI * 1e9 * 2e-9, rel=1e-3)


def test_optional_fields_leave_their_elements_out() -> None:
    sheet = tpl.build_sheet(tpl.get("capacitor"), {"Cnom": "1u"}, "C1U")
    assert [i.symbol for i in sheet.instances] == ["bpt:capacitor"]
    full = tpl.build_sheet(tpl.get("capacitor"), {"Cnom": "1u", "esr": "1", "esl": "1n",
                                              "rleak": "1meg"}, "C1U")  # fmt: skip
    assert sorted(i.ref for i in full.instances) == ["C1", "L1", "R1", "R2"]
    assert full.parameters == {"Cnom": "1u", "esr": "1", "esl": "1n", "rleak": "1meg"}
    assert full.symbol is not None and [p.number for p in full.symbol.pins] == ["1", "2"]
    with pytest.raises(tpl.TemplateError, match="required"):
        tpl.build_sheet(tpl.get("capacitor"), {"esr": "1"}, "x")


def test_srf_sets_the_winding_capacitance() -> None:
    values = tpl.numbers(tpl.get("inductor"), {"Lnom": "10u", "srf": "10meg"})
    assert values["cp"] == pytest.approx(1 / ((TWO_PI * 1e7) ** 2 * 10e-6))


def test_quick_model_keys_are_template_fields() -> None:
    """The parasitic fields of ideal R, C, L are the fields of their templates."""
    for symbol_id, (name, _param, _main) in tpl.QUICK.items():
        keys = {f.key for f in tpl.get(name).fields}
        parasitics = {p.key for p in builtin_symbols()[symbol_id].parasitics}
        assert parasitics <= keys, symbol_id


def test_nonlinear_elements_are_expressions_in_the_netlist() -> None:
    sheet = tpl.build_sheet(tpl.get("mlcc"), tpl.defaults(tpl.get("mlcc")), "MLCC")
    project = Project(name="p", sheets=[sheet])
    lines = write_netlist(netlist_project(project).circuit)
    assert any(line.startswith("C1 ") and "C='Cnom/(1+(v(1,2)/vhalf)^2)'" in line
               for line in lines)  # fmt: skip


@pytest.mark.parametrize(("name", "truth", "start", "free", "kinds"), [
    ("capacitor", {"Cnom": "4.7u", "esr": "12m", "esl": "800p"},
     {"Cnom": "1u", "esr": "1", "esl": "10n"}, ["Cnom", "esr", "esl"], ["|Z|(f)"]),
    ("mlcc", {"Cnom": "10u", "vhalf": "4", "esr": "3m", "esl": "400p"},
     {"Cnom": "22u", "vhalf": "10", "esr": "5m", "esl": "1n"}, ["Cnom", "vhalf", "esr", "esl"],
     ["C(V)", "|Z|(f)"]),
    ("inductor", {"Lnom": "22u", "dcr": "30m", "srf": "12meg", "rp": "20k", "isat": "3"},
     {"Lnom": "10u", "dcr": "50m", "srf": "30meg", "rp": "1k", "isat": "1"},
     ["Lnom", "dcr", "srf", "rp", "isat"], ["|Z|(f)", "L(I)"]),
    ("electrolytic", {"Cnom": "220u", "esr": "40m", "rlf": "300m", "flf": "2k", "esl": "15n"},
     {"Cnom": "100u", "esr": "50m", "rlf": "200m", "flf": "1k", "esl": "10n"},
     ["Cnom", "esr", "rlf", "flf", "esl"], ["ESR(f)", "|Z|(f)"]),
])  # fmt: skip
def test_fit_recovers_the_values(
    name: str, truth: dict[str, str], start: dict[str, str], free: list[str], kinds: list[str]
) -> None:
    axes = {"|Z|(f)": np.logspace(1, 9, 40), "ESR(f)": np.logspace(1, 6, 20),
            "C(V)": np.linspace(0, 16, 9), "L(I)": np.linspace(0, 6, 7)}  # fmt: skip
    chars = [_points(name, truth, kind, axes[kind]) for kind in kinds]
    result = fit_template(name, start, free, chars)
    assert result.error < 0.5
    for key in free:
        assert float(tpl.numbers(tpl.get(name), result.values, partial=True)[key]) == pytest.approx(
            tpl.numbers(tpl.get(name), truth, partial=True)[key], rel=0.02
        ), key


def test_fit_respects_bounds_weights_and_reports_the_worst_point() -> None:
    """The common fitting pipeline: a bound holds a value, a zero weight leaves a wrong point
    out of the fit (it is still shown), errors come per point with the worst one."""
    truth = {"Cnom": "4.7u", "esr": "12m", "esl": "800p"}
    start = {"Cnom": "1u", "esr": "1", "esl": "10n"}
    char = _points("capacitor", truth, "|Z|(f)", np.logspace(2, 8, 25))
    # A digitizing slip: one point ten times too high.
    bad = list(char.points)
    bad[5] = (bad[5][0], bad[5][1] * 10)
    weights = [1.0] * len(bad)
    weights[5] = 0.0
    slipped = char.model_copy(update={"points": bad, "weights": weights})
    result = fit_template("capacitor", start, ["Cnom", "esr", "esl"], [slipped])
    assert result.error < 0.5 and result.max_error < 1
    curve = result.curves[0]
    assert len(curve.residuals) == len(bad) and curve.residuals[5] < -80  # shown, not fitted
    # ESR held at no more than 5 mOhm: it stops there, and the fit gets worse.
    bounded = fit_template("capacitor", start, ["Cnom", "esr", "esl"], [char],
                           {"esr": (None, 5e-3)})  # fmt: skip
    assert tpl.numbers(tpl.get("capacitor"), bounded.values, partial=True)["esr"] <= 5e-3 * 1.0001
    assert bounded.max_error > 10


def test_lin_scale_errors_are_relative_to_the_largest_value() -> None:
    char = Characteristic(name="C(V)", points=[(0, 10e-6), (5, 5e-6), (10, 1e-6)], scale="lin")
    result = fit_template("mlcc", {"Cnom": "10u", "vhalf": "5", "esr": "5m", "esl": "1n"},
                          ["Cnom", "vhalf"], [char])  # fmt: skip
    assert result.curves[0].max_error < 50  # percent of 10 uF, not of the 1 uF point


# -- by simulation ----------------------------------------------------------------------------


@pytest.fixture(scope="module")
def run() -> Iterator[bench.Run]:
    engine = NgspiceEngine()
    yield bench.engine_runner(engine)
    engine.close()


@pytest.mark.ngspice
@pytest.mark.parametrize(("name", "extra"), [
    ("resistor", {"ls": "5n", "cp": "0.2p"}), ("capacitor", {}), ("mlcc", {}),
    ("electrolytic", {}), ("film", {"rda": "100k", "cda": "10n"}),
    ("inductor", {"isat": "2", "rp": "10k"}),
    ("inductor", {"rac": "0.5", "fac": "100k", "rp": "10k"}),
])  # fmt: skip
def test_simulated_impedance_matches_the_formula(
    run: bench.Run, name: str, extra: dict[str, str]
) -> None:
    template = tpl.get(name)
    form = {**tpl.defaults(template), **extra}
    base = Project(name="b", sheets=[tpl.build_sheet(template, form, "part")])
    drive = "i" if template.kind == "inductor" else "v"
    freqs, (z,) = bench.impedance_sweep(run, base, "part", bench.frequency_grid(10, 1e9, 10),
                                        [bench.Copy(drive=drive)])  # fmt: skip
    expected = tpl.impedance(template, tpl.numbers(template, form), freqs)
    assert np.max(np.abs(np.log(np.abs(z) / np.abs(expected)))) < 1e-3


@pytest.mark.ngspice
def test_real_capacitor_golden(run: bench.Run) -> None:
    """|Z|(f), SRF and ESR of a real capacitor from simulation vs the textbook formulas."""
    c, esr, esl = 1e-6, 0.03, 1.5e-9
    form = {"Cnom": "1u", "esr": "30m", "esl": "1.5n"}
    base = Project(name="b", sheets=[tpl.build_sheet(tpl.get("capacitor"), form, "cap")])
    freqs, (z,) = bench.impedance_sweep(run, base, "cap", bench.frequency_grid(1e3, 1e9, 200),
                                        [bench.Copy()])  # fmt: skip
    w = TWO_PI * freqs
    formula = np.sqrt(esr**2 + (w * esl - 1 / (w * c)) ** 2)
    assert np.max(np.abs(np.abs(z) / formula - 1)) < 1e-6
    srf = freqs[int(np.argmin(np.abs(z)))]
    assert srf == pytest.approx(1 / (TWO_PI * math.sqrt(esl * c)), rel=0.02)  # grid step
    assert np.min(np.abs(z)) == pytest.approx(esr, rel=1e-3)
    assert np.allclose(z.real, esr, rtol=1e-6)


@pytest.mark.ngspice
def test_nonlinear_curves_by_simulation(run: bench.Run) -> None:
    mlcc = Project(name="b", sheets=[tpl.build_sheet(tpl.get("mlcc"), tpl.defaults(tpl.get("mlcc")),
                                                   "m")])  # fmt: skip
    caps = bench.capacitance_curve(run, mlcc, "m", [0, 6.3], 1e3)
    assert caps[1] / caps[0] == pytest.approx(0.5, rel=1e-3)
    form = {"Lnom": "10u", "dcr": "50m", "isat": "2"}
    coil = Project(name="b", sheets=[tpl.build_sheet(tpl.get("inductor"), form, "l")])
    inductances = bench.inductance_curve(run, coil, "l", [0, 2], 1e3)
    assert inductances[1] / inductances[0] == pytest.approx(0.5, rel=1e-3)


@pytest.mark.ngspice
def test_fit_own_equivalent_circuit_by_simulation(run: bench.Run) -> None:
    truth = {"Cnom": "4.7u", "esr": "12m", "esl": "800p"}
    chars = [_points("capacitor", truth, "|Z|(f)", np.logspace(2, 8, 25))]
    start = {"Cnom": "1u", "esr": "100m", "esl": "5n"}
    base = Project(name="b", sheets=[tpl.build_sheet(tpl.get("capacitor"), start, "mine")])
    result = fit_sheet(run, base, "mine", start, chars)
    assert result.error < 0.5
    assert result.values == {"Cnom": "4.7u", "esr": "12m", "esl": "800p"}


# -- API --------------------------------------------------------------------------------------


def test_templates_api(client: TestClient) -> None:
    listed = {t["name"]: t for t in client.get("/api/components/templates", headers=H).json()}
    assert {"resistor", "capacitor", "mlcc", "electrolytic", "film", "inductor"} <= set(listed)
    assert listed["mlcc"]["kind"] == "capacitor" and listed["mlcc"]["main"] == "Cnom"
    curves = client.post("/api/components/templates/preview", headers=H, json={
        "template": "mlcc", "form": {"Cnom": "10u", "vhalf": "5"}}).json()  # fmt: skip
    assert [c["name"] for c in curves] == ["|Z|(f)", "phase(f)", "ESR(f)", "C(V)"]
    bad = client.post("/api/components/templates/preview", headers=H,
                      json={"template": "mlcc", "form": {"Cnom": "abc"}})  # fmt: skip
    assert bad.status_code == 422


@pytest.mark.ngspice
def test_component_from_template_card_and_placement(client: TestClient) -> None:
    body = {"template": "capacitor", "form": {"Cnom": "2.2u", "esr": "15m", "esl": "1n"},
            "library": "Parts", "name": "C2U2", "ratings": {"voltage": "25"},
            "metadata": {"manufacturer": "ACME"}}  # fmt: skip
    saved = client.post("/api/components/from-template", json=body, headers=H)
    assert saved.status_code == 200, saved.text
    component = saved.json()
    assert component["kind"] == "capacitor" and component["template"]["name"] == "capacitor"
    symbols = {s["id"]: s for s in client.get("/api/library/symbols", headers=H).json()}
    part = symbols["cmp:Parts/C2U2"]
    assert part["value_param"] == "Cnom" and part["default_params"] == {"Cnom": "2.2u"}
    assert {p["number"]: p["at"] for p in part["pins"]} == {"1": [0, -381], "2": [0, 381]}

    card = client.post("/api/components/card", json={"component": "cmp:Parts/C2U2"}, headers=H)
    assert card.status_code == 200, card.text
    curves = {c["name"]: c for c in card.json()["curves"]}
    assert set(curves) == {"|Z|(f)", "phase(f)", "ESR(f)", "C(V)"}
    zmin = min(curves["|Z|(f)"]["y"])
    assert zmin == pytest.approx(0.015, rel=0.05)
    assert curves["C(V)"]["x"][-1] == pytest.approx(25)
    assert curves["C(V)"]["y"][0] == pytest.approx(2.2e-6, rel=1e-3)


def test_a_poor_fit_starts_again_elsewhere() -> None:
    """A double well: one descent stays in the near well (a local minimum), other starts reach
    the far one where the model meets the points."""
    from bpt.models.fit import Problem, levenberg_marquardt

    xs = np.array([0.5, 1.0, 2.0, 3.0])
    char = Characteristic(name="C(V)", points=[(x, math.exp(-0.6 * x)) for x in xs])

    def g(v: float) -> float:
        return (v * v - 4) ** 2 / 4 + 0.3 * v

    def evaluate(vectors: list[np.ndarray]) -> list[list[np.ndarray]]:
        return [[np.exp(g(v[0]) * xs)] for v in vectors]

    problem = Problem([char], evaluate, np.array([2.0]))
    stuck, _ = levenberg_marquardt(problem, restarts=False)
    assert stuck[0] > 0 and g(stuck[0]) > 0.5
    p, _ = levenberg_marquardt(problem)
    assert g(p[0]) == pytest.approx(-0.6, abs=1e-3)


def test_ac_resistance_of_a_winding_rises_to_its_value() -> None:
    """Below fac the winding is its DCR, far above it DCR + rac; half of rac at fac."""
    template = tpl.get("inductor")
    v = tpl.numbers(template, {"Lnom": "10u", "dcr": "50m", "rac": "0.5", "fac": "100k"})
    esr = tpl.impedance(template, v, np.array([10.0, 100e3, 100e6])).real
    assert esr[0] == pytest.approx(0.05, rel=1e-3)
    assert esr[1] == pytest.approx(0.05 + 0.25, rel=1e-3)
    assert esr[2] == pytest.approx(0.55, rel=1e-3)
