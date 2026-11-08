import threading
from pathlib import Path

import pytest

from bpt.analysis.spec import OpAnalysis, TranAnalysis
from bpt.engines.ngspice.engine import NgspiceEngine
from bpt.netlist.spice_parser import parse_netlist
from bpt.results.store import ResultStore
from tests.test_golden import pytestmark as golden_marks

pytestmark = golden_marks

RC = """rc
V1 in 0 PULSE(0 1 0 1n 1n 1 2)
R1 in out 1k
C1 out 0 1u
"""


def test_simulation_error_is_reported_and_engine_recovers(tmp_path: Path) -> None:
    engine = NgspiceEngine()
    store = ResultStore(tmp_path)
    try:
        broken = parse_netlist("broken\nD1 a 0 NOPE\nR1 a 0 1k\nV1 a 0 1\n").circuit
        meta = engine.run(broken, OpAnalysis(), store)
        assert meta.status == "error"
        assert meta.error
        ok = engine.run(parse_netlist(RC).circuit, OpAnalysis(), store)
        assert ok.status == "ok"
    finally:
        engine.close()


def test_cancel_kills_long_run(tmp_path: Path) -> None:
    engine = NgspiceEngine()
    cancel = threading.Event()
    try:
        timer = threading.Timer(0.5, cancel.set)
        timer.start()
        # Billions of time steps, but only the last millisecond is stored.
        long_tran = TranAnalysis(tstep="1u", tstop="10", tstart="9.999", tmax="1n")
        meta = engine.run(
            parse_netlist(RC).circuit, long_tran, ResultStore(tmp_path), cancel=cancel
        )
        assert meta.status == "cancelled"
        assert (
            engine.run(parse_netlist(RC).circuit, OpAnalysis(), ResultStore(tmp_path)).status
            == "ok"
        )
    finally:
        engine.close()


def test_device_currents_are_named_per_terminal(tmp_path: Path) -> None:
    netlist = "t\nV1 a 0 DC 5\nR1 a b 1k\nD1 b c D\nL1 c d 1u\nQ1 d e 0 NPN\nR2 a e 100k\n"
    engine = NgspiceEngine()
    try:
        meta = engine.run(parse_netlist(netlist).circuit, OpAnalysis(), ResultStore(tmp_path))
    finally:
        engine.close()
    names = {s.name for s in meta.signals}
    assert {"I(R1)", "I(D1)", "I(L1)", "I(V1)", "I(Q1.C)", "I(Q1.B)", "I(Q1.E)"} <= names
    assert not any(n.startswith("@") or n.endswith("[is]") for n in names)


def test_missing_library_is_a_failed_run(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Engine.run never raises for a missing ngspice: the run fails with the reason."""
    monkeypatch.setenv("BPT_NGSPICE_LIB", str(tmp_path / "missing.dll"))
    engine = NgspiceEngine()
    meta = engine.run(parse_netlist(RC).circuit, OpAnalysis(), ResultStore(tmp_path))
    engine.close()
    assert meta.status == "error" and "missing" in (meta.error or "")
