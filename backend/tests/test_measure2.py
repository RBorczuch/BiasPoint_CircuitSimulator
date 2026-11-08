"""Measure 2.0 (graf.md §15 item 1): several measures in one node, an x window, one edge or
period (or each of them), own levels, thresholds from inputs, an output per measure + a table."""

import numpy as np
import pytest

from bpt.document.model import Graph, GraphNode
from bpt.graph.catalog import CATALOG, NOTES, NodeError, output_sockets, param_values, upgrade
from bpt.graph.text import make_edge
from bpt.graph.values import FamilyValue, ScalarValue, SignalValue, TableValue

MEASURE = CATALOG["measure/basic"]


def measure(signal: SignalValue, **params: object) -> dict:
    inputs = {"signal": signal, **{k: params.pop(k) for k in ("at", "level") if k in params
                                   and isinstance(params[k], ScalarValue)}}  # fmt: skip
    return MEASURE.run(None, inputs, param_values(MEASURE, params))  # type: ignore[arg-type]


def square(periods: int = 5, f: float = 1e3, high: float = 0.3) -> SignalValue:
    """0/1 V square wave, ``high`` of each period at 1 V, edges 10 µs long (linear)."""
    x = np.linspace(0, periods / f, periods * 2000 + 1)
    phase = (x * f) % 1
    edge = 0.01  # of a period
    y = np.clip(np.minimum(phase / edge, (high + edge - phase) / edge), 0, 1)
    return SignalValue("V(out)", x, y, "time", "s", "V")


def test_several_measures_each_an_output_and_all_in_a_table() -> None:
    out = measure(square(), op="max, min, frequency")
    assert out["value"].value == pytest.approx(1.0)  # the first measure: the "value" output
    assert out["min"].value == pytest.approx(0.0)
    assert out["frequency"].value == pytest.approx(1e3, rel=1e-3)
    table = out["table"]
    assert isinstance(table, TableValue)
    assert table.columns == ["max", "min", "frequency"] and table.units == ["V", "V", "Hz"]
    names = [s.name for s in output_sockets(MEASURE, {"op": "max, min, frequency"})]
    assert names == ["value", "table", "min", "frequency"]


def test_with_nothing_chosen_the_measure_suits_the_signal() -> None:
    assert measure(square())["value"].name == "pp(V(out))"
    f = np.logspace(1, 5, 41)
    ac = SignalValue("V(out)", f, 1 / (1 + 1j * f / 1e3), "frequency", "Hz", "V")
    assert measure(ac)["value"].value == pytest.approx(1e3, rel=0.02)


def test_a_window_and_one_edge_or_period_or_each() -> None:
    signal = square(periods=5)
    rises = measure(signal, op="rise", pick="all")["value"]
    assert isinstance(rises, FamilyValue) and rises.param == "edge"
    assert len(rises.items) == 5  # the edge at t = 0 starts from the lowest value too
    assert rises.items[0].value == pytest.approx(0.8 * 10e-6, rel=0.02)  # 10-90 % of 10 µs
    third = measure(signal, op="rise", pick="n-th", n=3)["value"]
    assert third.value == pytest.approx(rises.items[2].value)
    with pytest.raises(NodeError, match="there are 5 edges, not 9"):
        measure(signal, op="rise", pick="n-th", n=9)
    wider = measure(signal, op="rise", levels="20/80")["value"]
    assert wider.value == pytest.approx(0.6 * 10e-6, rel=0.02)
    windowed = measure(signal, op="rise", pick="all", start="1.5 ms", stop="3.5 ms")["value"]
    assert len(windowed.items) == 2
    duty = measure(signal, op="duty, avg", pick="all")
    assert len(duty["value"].items) == 4  # whole periods between rising crossings
    assert duty["value"].items[0].value == pytest.approx(31, abs=1)  # 30 % + half the edges
    table = duty["table"]
    assert table.columns == ["#", "duty", "avg"] and len(table.rows) == 4


def test_thresholds_from_inputs() -> None:
    signal = square()
    low = measure(signal, op="duty", level=ScalarValue("ref", 0.05, "V"))["value"]
    high = measure(signal, op="duty", level=ScalarValue("ref", 0.95, "V"))["value"]
    assert low.value > high.value  # a low threshold: the signal is above it longer
    at = measure(signal, op="at", at=ScalarValue("t", 0.1e-3, "s"))["value"]
    assert at.value == pytest.approx(1.0)


def test_a_failed_measure_is_a_note_and_the_others_are_kept() -> None:
    notes: list[str] = []
    token = NOTES.set(notes)
    try:
        out = measure(square(), op="pp, f3db")
    finally:
        NOTES.reset(token)
    assert out["value"].value == pytest.approx(1.0) and "f3db" not in out
    assert notes == ["f3db: -3 dB frequency needs an AC signal"]
    with pytest.raises(NodeError, match="AC signal"):
        measure(square(), op="f3db")  # alone: the node fails


def test_version_1_nodes_keep_their_measure_and_links_reach_new_outputs() -> None:
    graph = Graph(name="g", nodes=[GraphNode(id="m", type="measure/basic"),
                                   GraphNode(id="t", type="view/table")])  # fmt: skip
    upgrade(graph)
    assert graph.nodes[0].version == 2 and graph.nodes[0].params["op"] == "max"
    graph.nodes[0].params["op"] = "max, rms"
    assert make_edge(graph, "m.rms", "t.values").output == "rms"
    with pytest.raises(ValueError, match="no output 'avg'"):
        make_edge(graph, "m.avg", "t.values")
