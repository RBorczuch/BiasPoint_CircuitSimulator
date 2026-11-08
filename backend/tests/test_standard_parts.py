"""The standard library's parts against the datasheet values they were made from (FR-LIB-3)."""

from collections.abc import Iterator
from itertools import count
from pathlib import Path

import numpy as np
import pytest

from bpt.analysis.spec import AcAnalysis, TranAnalysis
from bpt.document.builder import place_component
from bpt.document.model import Project, Sheet
from bpt.engines.ngspice.engine import NgspiceEngine
from bpt.library import libraries
from bpt.library.blocks import project_symbols
from bpt.library.components import component_sheets
from bpt.models import semi_fit
from bpt.models import templates as tpl
from bpt.models.standard_parts import LIBRARY, PARTS, standard_parts
from bpt.netlist.netlister import netlist_project
from bpt.results.store import ResultStore
from bpt.units import parse_value
from tests.test_golden import pytestmark as golden_marks


def _values(form: dict[str, str], defaults: dict[str, float]) -> dict[str, float]:
    return {**defaults, **{k: parse_value(v) for k, v in form.items() if v.strip()}}


def test_every_part_is_in_the_library_with_its_metadata() -> None:
    components = libraries.all_components()
    for part in PARTS:
        component = components[f"cmp:{LIBRARY}/{part.name}"]
        assert component.description == part.description
        assert component.characteristics == part.source
    assert len(standard_parts()) == len(PARTS)


@pytest.mark.parametrize("part", [p for p in PARTS if p.source and p.template.startswith("tpl:")],
                         ids=lambda p: p.name)  # fmt: skip
def test_semiconductor_models_match_their_datasheet_values(part: object) -> None:
    """Each fitted part reproduces the datasheet points it was fitted to: 3 %, level 1 MOSFETs
    (square law, the real parts are not) within the 10 % their descriptions state."""
    from bpt.models.standard_parts import Part

    assert isinstance(part, Part)
    name = part.template
    for char in part.source:
        if "Diode" in name or "Zener" in name or "LED" in name:
            v = _values(part.form, {**semi_fit._DEFAULTS, "is": 2.52e-9, "n": 1.752,
                                    "rs": 0.568})  # fmt: skip
            model = semi_fit.diode_curves(v, [char])[0]
            measured = np.array([p[1] for p in char.points])
        elif "MOSFET" in name:
            v = _values(part.form, semi_fit._MOS_DEFAULTS)
            model = semi_fit.mosfet_curves(v, [char])[0]
            measured = np.array([p[1] for p in char.points])
        else:  # BJT: magnitudes, as the fit sees them
            v = _values(part.form, semi_fit._BJT_DEFAULTS)
            gain = char.name == "hFE(Ic)"
            mag = char.model_copy(update={
                "points": [(abs(x), abs(y)) for x, y in char.points],
                "at": {k: abs(val) for k, val in char.at.items()},
            })  # fmt: skip
            model = semi_fit.bjt_curves(v, [mag])[0]
            measured = np.array([abs(p[1]) if not gain else p[1] for p in char.points])
        limit = 0.10 if "MOSFET" in name else 0.03
        assert np.allclose(model, measured, rtol=limit), (part.name, char.name, model, measured)


def test_capacitors_follow_their_datasheet_curves() -> None:
    """Ceramics: |Z|(f) below half the self-resonance within 15 % (the parts are ±10 %), the
    DC bias curve within 20 %; electrolytics: the catalogue's 120 Hz ESR (tan d) and 100 kHz
    impedance."""
    for part in PARTS:
        template = tpl.get(part.template) if not part.template.startswith("tpl:") else None
        if template is None:
            continue
        values = tpl.numbers(template, part.form, partial=True)
        for char in part.source:
            x = np.array([p[0] for p in char.points])
            y = np.array([p[1] for p in char.points])
            if char.name == "|Z|(f)":
                srf = 1 / (2 * np.pi * np.sqrt(values["Cnom"] * values["esl"]))
                low = x < 0.5 * srf
                z = np.abs(tpl.impedance(template, values, x[low]))
                assert np.allclose(z, y[low], rtol=0.15), (part.name, z, y[low])
            elif char.name == "C(V)":
                c = tpl.capacitance(template, values, x)
                assert np.allclose(c, y, rtol=0.20), (part.name, c, y)
        if part.template == "electrolytic":
            tan_delta = {"UPW1E221MPD": 0.14, "UPW1C102MPD": 0.16}[part.metadata["part_number"]]
            esr_120 = float(np.real(tpl.impedance(template, values, np.array([120.0]))[0]))
            assert esr_120 == pytest.approx(tan_delta / (2 * np.pi * 120 * values["Cnom"]),
                                            rel=0.02)  # fmt: skip
            z_100k = float(np.abs(tpl.impedance(template, values, np.array([1e5]))[0]))
            assert z_100k == pytest.approx(values["esr"], rel=0.15)


def test_mlcc_halves_at_its_dc_bias() -> None:
    for part in PARTS:
        if part.template == "mlcc":
            template = tpl.get("mlcc")
            values = tpl.numbers(template, part.form, partial=True)
            c = tpl.capacitance(template, values, np.array([0.0, values["vhalf"]]))
            assert c[1] == pytest.approx(c[0] / 2, rel=1e-3)


@pytest.fixture(scope="module")
def engine() -> Iterator[NgspiceEngine]:
    engine = NgspiceEngine()
    yield engine
    engine.close()


def _follower(engine: NgspiceEngine, tmp_path: Path, name: str, source: dict[str, str],
              analysis: AcAnalysis | TranAnalysis) -> dict[str, np.ndarray]:  # fmt: skip
    component = libraries.all_components()[f"cmp:{LIBRARY}/{name}"]
    project = Project(name="t", sheets=[Sheet(name="root")])
    top, sheets = component_sheets(project, component)
    project.sheets += sheets
    symbols = project_symbols(project)
    grounds = count(1)
    supply = "2.5" if name == "LMV358" else "10"
    for k, (ref, symbol, nets, params) in enumerate([
        ("V1", "bpt:vsource", ["in", "0"], source),
        ("V2", "bpt:vsource", ["vp", "0"], {"dc": supply}),
        ("V3", "bpt:vsource", ["vn", "0"], {"dc": f"-{supply}"}),
        ("X1", f"sheet:{top}", ["in", "out", "out", "vp", "vn"], {}),
        ("R1", "bpt:resistor", ["out", "0"], {"R": "10k"}),
    ]):  # fmt: skip
        add = place_component(symbols[symbol], ref, nets, (3000 * k, 0), params, None, grounds)
        project.sheets[0].instances += add.instances
        project.sheets[0].wires += add.wires
        project.sheets[0].labels += add.labels
    store = ResultStore(tmp_path)
    meta = engine.run(netlist_project(project).circuit, analysis, store)
    assert meta.status == "ok", meta.error
    run = store.open(meta.run_id)
    return {s.name: np.asarray(run.signal(s.name)) for s in meta.signals}


@golden_marks[0]
@golden_marks[1]
@pytest.mark.parametrize("name", ["LM358", "LMV358", "TL072"])
def test_op_amps_show_their_gbw_and_slew_rate(engine: NgspiceEngine, tmp_path: Path,
                                              name: str) -> None:  # fmt: skip
    part = next(p for p in PARTS if p.name == name)
    gbw, sr = parse_value(part.form["gbw"]), parse_value(part.form["sr"])
    ac = _follower(engine, tmp_path, name, {"dc": "0", "ac": "1"},
                   AcAnalysis(points=100, fstart="1k", fstop="100meg"))  # fmt: skip
    f = np.real(ac["frequency"])
    gain_db = 20 * np.log10(np.abs(ac["V(out)"]))
    assert float(np.interp(-3, gain_db[::-1], f[::-1])) == pytest.approx(gbw, rel=0.15)
    # A step well above SR / (2 pi GBW), else the bandwidth limits the edge, not the slew rate.
    step = min(max(1.0, 5 * sr / (2 * np.pi * gbw)), 5.0)
    t_edge = 4 * step / sr  # the ramp takes 2 step / sr; look over twice that
    pulse = f"PULSE(-{step} {step} 1u 1n 1n 1 2)"
    analysis = TranAnalysis(tstep=f"{t_edge / 400:.3g}", tstop=f"{1e-6 + t_edge:.3g}")
    tr = _follower(engine, tmp_path, name, {"dc": f"-{step}", "tran": pulse}, analysis)
    t, v = np.real(tr["time"]), np.real(tr["V(out)"])
    rising = slice(int(np.searchsorted(t, 1e-6)), None)
    t1 = float(np.interp(-0.5 * step, v[rising], t[rising]))
    t2 = float(np.interp(0.5 * step, v[rising], t[rising]))
    assert step / (t2 - t1) == pytest.approx(sr, rel=0.15)
