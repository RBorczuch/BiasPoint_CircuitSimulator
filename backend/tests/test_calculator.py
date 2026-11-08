from collections.abc import Iterator
from pathlib import Path

import numpy as np
import pytest

from bpt.analysis.spec import AcAnalysis, TranAnalysis
from bpt.engines.ngspice.engine import NgspiceEngine
from bpt.netlist.spice_parser import parse_netlist
from bpt.results.calculator import ExpressionError, evaluate
from bpt.results.store import ResultStore, RunReader
from tests.test_golden import pytestmark as ngspice_marks

pytestmark = ngspice_marks

RC = "rc\nV1 in 0 DC 0 AC 1 SIN(0 1 1k)\nR1 in out 1k\nC1 out 0 159.15n\n"


@pytest.fixture(scope="module")
def runs(tmp_path_factory: pytest.TempPathFactory) -> Iterator[tuple[RunReader, RunReader]]:
    store = ResultStore(Path(tmp_path_factory.mktemp("calc")))
    engine = NgspiceEngine()
    circuit = parse_netlist(RC).circuit
    tran = engine.run(circuit, TranAnalysis(tstep="1u", tstop="10m", tmax="1u"), store)
    ac = engine.run(circuit, AcAnalysis(variation="lin", points=3, fstart="1k", fstop="3k"), store)
    engine.close()
    yield store.open(tran.run_id), store.open(ac.run_id)


def test_arithmetic_and_differences(runs: tuple[RunReader, RunReader]) -> None:
    tran, _ac = runs
    vin, vout = np.asarray(tran.signal("V(in)")), np.asarray(tran.signal("V(out)"))
    assert np.allclose(evaluate(tran, "V(in,out)"), vin - vout)
    assert np.allclose(
        evaluate(tran, "(V(in)-V(out))/1k"), np.asarray(tran.signal("I(R1)")), atol=1e-9
    )
    assert np.allclose(evaluate(tran, "2*V(out)^2"), 2 * vout**2)


def test_ac_db_and_phase(runs: tuple[RunReader, RunReader]) -> None:
    _tran, ac = runs
    db = evaluate(ac, "db(V(out)/V(in))")
    phase = evaluate(ac, "ph(V(out))")
    assert abs(db[0] + 3.0103) < 0.01  # fc = 1 kHz
    assert abs(phase[0] + 45) < 0.1


def test_calculus_and_reductions(runs: tuple[RunReader, RunReader]) -> None:
    tran, _ac = runs
    # Steady state of the 1 kHz sine through the RC (gain 0.707): last 5 ms.
    vin = np.asarray(tran.signal("V(in)"))
    t = np.asarray(tran.signal("time"))
    assert abs(float(evaluate(tran, "max(V(in))")) - 1) < 1e-3
    assert abs(float(evaluate(tran, "rms(V(in))")) - 1 / np.sqrt(2)) < 0.01
    slope = evaluate(tran, "deriv(V(in))")
    assert abs(slope.max() - 2 * np.pi * 1e3) / (2 * np.pi * 1e3) < 0.01
    area = evaluate(tran, "integ(V(in))")
    assert abs(area[-1] - np.trapezoid(vin, t)) < 1e-9


def test_errors_are_reported(runs: tuple[RunReader, RunReader]) -> None:
    tran, _ac = runs
    for bad in ["V(nope)", "foo(V(in))", "V(in) +", "1 +* 2", ""]:
        with pytest.raises(ExpressionError):
            evaluate(tran, bad)


def test_trig_constants_unwrapped_phase_and_group_delay(runs: tuple[RunReader, RunReader]) -> None:
    tran, ac = runs
    assert float(evaluate(tran, "sin(pi/2) + round(2.6) + sign(-3)")) == pytest.approx(3)
    # First-order RC low-pass: phase -atan(w tau); on this 3-point grid gd is the central
    # difference of it at the middle point.
    f = np.real(np.asarray(ac.signal("frequency")))
    tau = 1e3 * 159.15e-9
    phase = -np.arctan(2 * np.pi * f * tau)
    expected = -(phase[2] - phase[0]) / (2 * np.pi * (f[2] - f[0]))
    gd = evaluate(ac, "gd(V(out))")
    assert gd[1] == pytest.approx(expected, rel=0.01)
    assert np.allclose(evaluate(ac, "uph(V(out))"), evaluate(ac, "ph(V(out))"))  # no wrap here


def test_sign_binds_looser_than_power() -> None:
    """-2^2 is -(2^2) (it was (-2)^2 = 4, and -a^0.5 gave NaN); exponents may be signed."""
    from bpt.results.calculator import evaluate_with

    x = np.zeros(1)
    cases = {"-2^2": -4, "- -3": 3, "+ -5": -5, "2^-1": 0.5, "2^3^2": 512, "-a^0.5": -2, "3*-2": -6}
    for text, expected in cases.items():
        assert float(evaluate_with(text, x, {"a": np.asarray(4.0)})) == expected, text
