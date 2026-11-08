"""Signal 2.0 (graf.md §15 item 2): several signals in one node, name patterns, the power and
impedance of a part, a name of its own."""

from pathlib import Path

import pytest

from bpt.document.model import Graph, GraphEdge, GraphNode
from bpt.engines.ngspice.engine import NgspiceEngine
from bpt.graph.catalog import CATALOG
from bpt.graph.executor import ResultCache, execute
from bpt.graph.values import FamilyValue, SignalValue
from bpt.results.store import ResultStore
from tests.test_golden import pytestmark as ngspice_marks
from tests.test_graph import _Ctx, _project, engine  # noqa: F401

pytestmark = ngspice_marks


def run_signal(engine: NgspiceEngine, tmp_path: Path, **params: str):  # noqa: F811
    """The divider (V1 2 V, R1 = R2 = 1k) through a transient and one Signal node."""
    nodes = [GraphNode(id="c", type="core/circuit"),
             GraphNode(id="t", type="sim/tran", params={"stop": "1 ms", "step": "100 µs"}),
             GraphNode(id="s", type="core/signal", params=params,
                       version=CATALOG["core/signal"].version),
             GraphNode(id="plot", type="view/plot")]  # fmt: skip
    edges = [GraphEdge(source="c", output="circuit", target="t", input="circuit"),
             GraphEdge(source="t", output="run", target="s", input="run"),
             GraphEdge(source="s", output="signals", target="plot", input="signals")]  # fmt: skip
    graph = Graph(name="g", nodes=nodes, edges=edges)
    return execute(graph, _Ctx(_project(), engine, ResultStore(tmp_path)), ResultCache())["s"]


def last(signal: SignalValue) -> float:
    return float(signal.y.real[-1])


def test_several_signals_and_patterns(engine: NgspiceEngine, tmp_path: Path) -> None:  # noqa: F811
    result = run_signal(engine, tmp_path, expr="V(out); I(R*)")
    assert result.state.status == "ok", result.state.error
    family = result.outputs["signals"]
    assert isinstance(family, FamilyValue)
    assert family.values == ["V(out)", "I(R1)", "I(R2)"]
    assert last(result.outputs["signal"]) == pytest.approx(1.0)
    assert last(family.items[1]) == pytest.approx(1e-3)  # into R1's first pin: in -> out
    voltages = run_signal(engine, tmp_path, expr="V(*)").outputs["signals"]
    assert set(voltages.values) == {"V(in)", "V(out)"}


def test_power_and_impedance_of_parts(engine: NgspiceEngine, tmp_path: Path) -> None:  # noqa: F811
    result = run_signal(engine, tmp_path, expr="P(R1); P(V1); Z(R2); Z(V1)")
    assert result.state.status == "ok", result.state.error
    p_r1, p_v1, z_r2, z_v1 = result.outputs["signals"].items
    assert last(p_r1) == pytest.approx(1e-3) and p_r1.unit == "W"  # 1 V x 1 mA
    assert last(p_v1) == pytest.approx(-2e-3)  # a source gives power: negative taken
    assert last(z_r2) == pytest.approx(1e3) and z_r2.unit == "Ω"
    assert last(z_v1) == pytest.approx(2e3)  # what V1 drives: R1 + R2


def test_a_name_of_its_own_and_a_bad_item_noted(engine: NgspiceEngine, tmp_path: Path) -> None:  # noqa: F811
    one = run_signal(engine, tmp_path, expr="V(out)*2", name="twice")
    assert one.outputs["signal"].name == "twice"
    some = run_signal(engine, tmp_path, expr="V(out); P(R9)")
    assert some.state.status == "ok" and some.state.error == "P(R9): no part R9"
    assert some.outputs["signals"].values == ["V(out)"]
