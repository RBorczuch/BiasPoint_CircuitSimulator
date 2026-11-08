"""Building-block nodes (graf.md §15.1, G1): Number, Complex parts, Calculus, Lookup, Equation."""

import numpy as np
import pytest

from bpt.graph.catalog import CATALOG, NodeError, param_values
from bpt.graph.values import FamilyValue, ScalarValue, SignalValue, TableValue


def run(type_: str, inputs: dict, **params: object) -> dict:
    node = CATALOG[type_]
    return node.run(None, inputs, param_values(node, params))  # type: ignore[arg-type]


def sine(periods: int = 5, f: float = 1e3, amp: float = 2.0) -> SignalValue:
    x = np.linspace(0, periods / f, periods * 400 + 1)
    return SignalValue("V(out)", x, amp * np.sin(2 * np.pi * f * x), "time", "s", "V")


def test_number_keeps_its_unit() -> None:
    out = run("math/number", {}, value="50 Ω", name="Z0")["value"]
    assert out == ScalarValue("Z0", 50.0, "Ω")
    assert run("math/number", {}, value="1 MHz")["value"].value == pytest.approx(1e6)
    with pytest.raises(NodeError, match="value"):
        run("math/number", {}, value="lots")


def test_complex_parts_of_a_low_pass() -> None:
    f = np.array([1e2, 1e3, 1e4])
    h = SignalValue("H", f, 1 / (1 + 1j * f / 1e3), "frequency", "Hz", "")
    out = run("math/complex", {"signal": h})
    assert out["db"].y[1] == pytest.approx(-3.0103, abs=1e-3) and out["db"].unit == "dB"
    assert out["phase"].y[1] == pytest.approx(-45.0)
    assert out["re"].y[1] == pytest.approx(0.5) and out["im"].y[1] == pytest.approx(-0.5)


def test_calculus() -> None:
    x = np.linspace(0, 2, 2001)
    square = SignalValue("x2", x, x**2, "time", "s", "V")
    d = run("math/calculus", {"signal": square}, mode="derivative")["signal"]
    assert d.y[1000] == pytest.approx(2.0, rel=1e-3) and d.unit == "V/s"
    ones = SignalValue("one", x, np.ones_like(x), "time", "s", "A")
    total = run("math/calculus", {"signal": ones}, mode="integral")
    assert total["value"].value == pytest.approx(2.0) and total["value"].unit == "A·s"
    part = run(
        "math/calculus", {"signal": ones}, mode="integral in window", start="0.5", stop="1.5"
    )
    assert part["value"].value == pytest.approx(1.0, rel=1e-3)
    smooth = run("math/calculus", {"signal": sine()}, mode="moving average", width="1 ms")["signal"]
    assert np.max(np.abs(smooth.y[600:-600])) < 0.01  # a whole period averages to nothing
    peaks = run("math/calculus", {"signal": sine()}, mode="peaks")
    assert peaks["value"].value == 5 and isinstance(peaks["table"], TableValue)
    assert peaks["table"].rows[0][1] == pytest.approx(2.0, rel=1e-3)
    x = np.linspace(0, 10e-3, 20001)
    am = SignalValue(
        "am", x, (1 + 0.5 * np.sin(2 * np.pi * 100 * x)) * np.sin(2 * np.pi * 10e3 * x)
    )
    env = run("math/calculus", {"signal": am}, mode="envelope")["signal"]
    assert env.y[5000] == pytest.approx(1.5, abs=0.05)  # at 2.5 ms the 100 Hz term peaks


def test_lookup_in_signals_and_tables() -> None:
    s = sine()
    assert run("math/lookup", {"signal": s}, x="0.25 ms")["value"].value == pytest.approx(2.0)
    first = run("math/lookup", {"signal": s}, mode="x at y", y="1 V")["value"]
    assert first.value == pytest.approx(np.arcsin(0.5) / (2 * np.pi * 1e3), rel=1e-3)
    every = run("math/lookup", {"signal": s}, mode="x at y", y="1 V", which="all")["value"]
    assert isinstance(every, FamilyValue) and len(every.items) == 10  # up and down in 5 periods
    table = TableValue("t", ["R", "fc"], ["Ω", "Hz"], [[1e3, 1000.0], [2e3, 500.0]])
    mid = run("math/lookup", {"table": table}, x="1.5k")["value"]
    assert mid.value == pytest.approx(750.0) and mid.unit == "Hz"
    with pytest.raises(NodeError, match="outside"):
        run("math/lookup", {"signal": s}, x="1 s")


def test_equation_shows_numbers_and_gives_the_result() -> None:
    out = run("view/equation", {"a": ScalarValue("V", 2.0, "V"), "b": ScalarValue("I", 1e-3, "A")},
              expr="a*b", name="P")["value"]  # fmt: skip
    assert out.name == "P" and out.value == pytest.approx(2e-3)
    with pytest.raises(NodeError, match="numbers"):
        run("view/equation", {"a": sine()}, expr="a*2")
