"""Example projects: they load, pass ERC, match the generator and simulate sensibly."""

from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from bpt.document.builder import describe, import_netlist
from bpt.document.model import Project, Sheet
from bpt.document.storage import load_project
from bpt.engines.ngspice.engine import NgspiceEngine
from bpt.examples import EXAMPLES
from bpt.netlist.netlister import netlist_project
from bpt.netlist.ngspice_writer import write_netlist
from bpt.netlist.spice_parser import parse_analysis_card, parse_netlist
from bpt.results.store import ResultStore
from tests.conftest import TOKEN
from tests.test_golden import pytestmark as ngspice_marks

ROOT = Path(__file__).resolve().parents[2] / "examples"
GOLDEN = Path(__file__).resolve().parents[2] / "tests" / "golden"
NAMES = [e.name for e in EXAMPLES]


@pytest.mark.parametrize("name", NAMES)
def test_example_files_match_generator(name: str) -> None:
    built = next(e for e in EXAMPLES if e.name == name).build()
    shipped = load_project(ROOT / f"{name}.bpt")
    assert describe(shipped).endswith("ERC: ok")
    # Ids differ between generations; the circuit must not.
    assert write_netlist(netlist_project(shipped).circuit) == write_netlist(
        netlist_project(built).circuit
    ), "run `uv run bpt examples` to refresh examples/"


def test_open_example_api(client: TestClient) -> None:
    h = {"x-bpt-token": TOKEN}
    listing = client.get("/api/library/examples", headers=h).json()
    assert [e["name"] for e in listing] == NAMES
    info = client.post("/api/library/examples/rc_lowpass/open", headers=h).json()
    assert info["path"] is None and info["name"] == "rc_lowpass"
    assert client.post("/api/library/examples/nope/open", headers=h).status_code == 404


# What each example must show when its active analysis runs: (signal, reduction, lo, hi).
EXPECT = {
    "rc_lowpass": ("V(out)", "max", 0.98, 1.0),  # 5 time constants of charging per pulse
    "sallen_key_lowpass": ("V(out)", "gain_10k_db", -40, -30),  # 2nd order: ~ -40 dB/dec
    "filter_design_check": ("V(out)", "gain_10k_db", -40, -30),  # the same filter
    "ce_amplifier": ("V(out)", "pp", 0.7, 1.0),  # 0.2 Vpp in, gain ~ RC/RE
    "half_wave_rectifier": ("V(out)", "max", 9.0, 9.6),  # 10 V peak minus a diode drop
    "lm2596_module": ("V(out)", "final", 4.9, 5.1),  # 1.23 V * (1 + 3.065k / 1k)
}


@pytest.mark.parametrize("name", NAMES)
@ngspice_marks[0]
@ngspice_marks[1]
def test_example_simulates(name: str, tmp_path: Path) -> None:
    project = next(e for e in EXAMPLES if e.name == name).build()
    card = project.simulation.cards[project.simulation.active]
    engine = NgspiceEngine()
    try:
        meta = engine.run(netlist_project(project).circuit, parse_analysis_card(card),
                          ResultStore(tmp_path))  # fmt: skip
    finally:
        engine.close()
    assert meta.status == "ok", meta.error
    run = ResultStore(tmp_path).open(meta.run_id)
    signal, how, lo, hi = EXPECT[name]
    y = np.asarray(run.signal(signal))
    if how == "gain_10k_db":
        x = np.real(np.asarray(run.signal("frequency")))
        value = 20 * np.log10(np.interp(1e4, x, np.abs(y)))
    elif how == "pp":
        tail = np.real(y)[len(y) // 2 :]
        value = tail.max() - tail.min()
    else:
        value = {"final": y[-1], "max": y.max()}[how].real
    assert lo <= value <= hi, f"{name}: {signal} {how} = {value}"


@ngspice_marks[0]
@ngspice_marks[1]
def test_the_filter_design_check_graph(tmp_path: Path) -> None:
    """The showcase graph: formula f0 = 1.07 kHz, simulated f-3dB 1.12 kHz (Q = 0.74), a batch
    of 200 with most of it within 1.10-1.20 kHz, a table row per C2, and real parts."""
    from bpt.examples import filter_design_check
    from bpt.graph.executor import ResultCache, execute
    from tests.test_graph import _Ctx

    project = filter_design_check()
    engine = NgspiceEngine()
    try:
        results = execute(project.graphs[0], _Ctx(project, engine, ResultStore(tmp_path)),
                          ResultCache())  # fmt: skip
    finally:
        engine.close()
    bad = {k: r.state.error for k, r in results.items() if r.state.status not in ("ok", "cached")}
    assert not bad, bad
    assert results["f0"].outputs["value"].value == pytest.approx(1073, rel=1e-3)
    assert results["measure"].outputs["value"].value == pytest.approx(1122, rel=5e-3)
    assert "PASS" in results["spec"].state.summary[0] or "FAIL" in results["spec"].state.summary[0]
    assert len(results["make_sw"].outputs["table"].rows) == 4
    # Real parts (Murata capacitors fitted to Murata's data): the 16 V X7R keeps its capacitance
    # at 2.5 V, f-3dB stays within 1 %; the op-amp's finite gain lets the signal leak through.
    assert results["c_bias"].outputs["value"].value == pytest.approx(10.09e-9, rel=1e-3)
    ideal, real = results["make_real"].outputs["table"].rows
    assert results["make_real"].outputs["table"].columns == ["signal", "f-3dB", "max", "min"]
    assert real[1] / ideal[1] == pytest.approx(0.99, abs=0.01)
    assert real[3] > 100 * ideal[3]  # deepest attenuation: about -68 dB against -119 dB


@ngspice_marks[0]
@ngspice_marks[1]
def test_capacitor_esl_self_resonance(tmp_path: Path) -> None:
    """1 uF with 1 nH ESL resonates at 1/(2 pi sqrt(LC)) = 5.03 MHz: impedance minimum."""
    from bpt.document.builder import import_netlist
    from bpt.document.model import Project, Sheet
    from bpt.netlist.spice_parser import parse_netlist

    project = Project(name="srf", sheets=[Sheet(name="root")])
    text = "* srf\nV1 in 0 DC 0 AC 1\nR1 in out 1\nC1 out 0 1u\n"
    import_netlist(project, parse_netlist(text)).apply(project)
    c1 = next(i for i in project.sheets[0].instances if i.ref == "C1")
    c1.model.params.update({"esr": "1m", "esl": "1n"})
    engine = NgspiceEngine()
    try:
        card = parse_analysis_card(".ac dec 200 100k 100meg")
        meta = engine.run(netlist_project(project).circuit, card, ResultStore(tmp_path))
    finally:
        engine.close()
    assert meta.status == "ok", meta.error
    run = ResultStore(tmp_path).open(meta.run_id)
    f = np.real(np.asarray(run.signal("frequency")))
    v_out = np.abs(np.asarray(run.signal("V(out)")))
    assert 4.8e6 < f[np.argmin(v_out)] < 5.3e6


@ngspice_marks[0]
@ngspice_marks[1]
def test_ac_currents_of_r_and_c(tmp_path: Path) -> None:
    """ngspice gives no R/C currents in AC; they are derived and equal the loop current."""
    project = Project(name="ac", sheets=[Sheet(name="root")])
    text = "* ac\nV1 in 0 DC 0 AC 1\nR1 in out 1k\nC1 out 0 159.15n\n"
    import_netlist(project, parse_netlist(text)).apply(project)
    engine = NgspiceEngine()
    try:
        card = parse_analysis_card(".ac dec 10 10 100k")
        meta = engine.run(netlist_project(project).circuit, card, ResultStore(tmp_path))
    finally:
        engine.close()
    run = ResultStore(tmp_path).open(meta.run_id)
    i_r, i_c, i_v = (np.asarray(run.signal(s)) for s in ("I(R1)", "I(C1)", "I(V1)"))
    assert np.allclose(i_r, i_c, rtol=1e-6)
    assert np.allclose(i_r, -i_v, rtol=1e-6)  # SPICE: source current flows into its + pin


@ngspice_marks[0]
@ngspice_marks[1]
def test_layered_module_matches_flat_circuit(tmp_path: Path) -> None:
    """FR-CMP-6: project -> module component -> IC component simulates like the same circuit
    written flat by hand (tests/golden/lm2596_module_flat), so parameters reach every level."""
    project = next(e for e in EXAMPLES if e.name == "lm2596_module").build()
    flat = parse_netlist((GOLDEN / "lm2596_module_flat" / "circuit.cir").read_text("utf-8"))
    card = parse_analysis_card(project.simulation.cards["tran"])
    engine = NgspiceEngine()
    store = ResultStore(tmp_path)
    try:
        layered_meta = engine.run(netlist_project(project).circuit, card, store)
        flat_meta = engine.run(flat.circuit, card, store)
    finally:
        engine.close()
    assert layered_meta.status == flat_meta.status == "ok"
    waves = []
    for meta in (layered_meta, flat_meta):
        run = store.open(meta.run_id)
        waves.append((np.real(np.asarray(run.signal("time"))),
                      np.real(np.asarray(run.signal("V(out)")))))  # fmt: skip
    times = np.linspace(0.5e-3, 5e-3, 10)
    layered, flat_v = (np.interp(times, t, v) for t, v in waves)
    assert np.allclose(layered, flat_v, rtol=5e-3, atol=5e-3), (layered, flat_v)
    # Average over the last 75 switching periods (time-weighted: the steps are not even).
    tail = [np.trapezoid(v[t >= 4.5e-3], t[t >= 4.5e-3]) / 0.5e-3 for t, v in waves]
    assert abs(tail[0] - tail[1]) < 2e-3 and abs(tail[0] - 5.0) < 0.03, tail
    # Probing inside: the module's switch node and the IC's error amplifier are results too.
    run = store.open(layered_meta.run_id)
    names = {s.name.lower() for s in run.meta.signals}
    assert {"v(u1.sw)", "v(u1.u1.comp)"} <= names, sorted(names)[:40]


@ngspice_marks[0]
@ngspice_marks[1]
def test_averaged_module_follows_the_switching_one(tmp_path: Path) -> None:
    """FR-CMP-8: the module simulated as its averaged variant (chosen on the block, it picks
    the IC's averaged model inside) gives the same output and input current without ripple,
    many times faster (no small time step needed)."""

    def run(variant: str | None, card: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        project = next(e for e in EXAMPLES if e.name == "lm2596_module").build()
        block = next(i for i in project.sheets[0].instances if i.ref == "U1")
        block.model.variant = variant
        meta = engine.run(netlist_project(project).circuit, parse_analysis_card(card),
                          ResultStore(tmp_path))  # fmt: skip
        assert meta.status == "ok", meta.error
        run = ResultStore(tmp_path).open(meta.run_id)
        return tuple(np.real(np.asarray(run.signal(s))) for s in ("time", "V(out)", "I(V1)"))  # type: ignore[return-value]

    engine = NgspiceEngine()
    try:
        t_full, v_full, i_full = run(None, ".tran 1u 5m 0 50n")
        t_avg, v_avg, i_avg = run("averaged", ".tran 1u 5m")
    finally:
        engine.close()
    times = np.linspace(1e-3, 5e-3, 9)
    assert np.allclose(np.interp(times, t_avg, v_avg), np.interp(times, t_full, v_full), rtol=0.02)

    def mean(t: np.ndarray, y: np.ndarray) -> float:  # last 75 switching periods
        return float(np.trapezoid(y[t >= 4.5e-3], t[t >= 4.5e-3]) / 0.5e-3)

    assert abs(mean(t_avg, v_avg) - mean(t_full, v_full)) < 0.01
    assert abs(mean(t_avg, i_avg) / mean(t_full, i_full) - 1) < 0.03
    assert len(t_avg) < len(t_full) / 10
