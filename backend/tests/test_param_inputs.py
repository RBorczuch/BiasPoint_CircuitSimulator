"""Widget -> input (graf.md §15 item 8): a parameter turned into a scalar socket takes its value
from another node, once per member of a family."""

from pathlib import Path

import pytest

from bpt.document.model import Graph, GraphEdge, GraphNode
from bpt.graph.catalog import CATALOG, NodeType, NodeTypeInfo, Param, Socket, input_sockets
from bpt.graph.executor import ResultCache, execute
from bpt.graph.text import make_edge
from bpt.graph.values import FamilyValue, ScalarValue
from bpt.results.store import ResultStore
from bpt.units import parse_quantity
from tests.test_graph import _Ctx, _project


@pytest.fixture
def test_nodes(monkeypatch: pytest.MonkeyPatch) -> None:
    def number(ctx, inputs, params):
        values = [float(v) for v in str(params["values"]).split()]
        items = [ScalarValue("n", v, "s") for v in values]
        return {
            "out": items[0]
            if len(items) == 1
            else FamilyValue("k", str(params["values"]).split(), items)
        }

    def twice(ctx, inputs, params):
        return {"out": ScalarValue("2k", 2 * parse_quantity(str(params["k"]), "s"), "s")}

    out = [Socket(name="out", type="scalar")]
    monkeypatch.setitem(
        CATALOG,
        "test/number",
        NodeType(
            NodeTypeInfo(
                type="test/number",
                title="Number",
                category="Input",
                description="",
                inputs=[],
                outputs=out,
                params=[Param(name="values", kind="text", default="1")],
            ),
            number,
        ),
    )
    monkeypatch.setitem(CATALOG, "test/twice", NodeType(
        NodeTypeInfo(type="test/twice", title="Twice", category="Math", description="", inputs=[],
                     outputs=out, params=[Param(name="k", kind="quantity", default="1 ms"),
                                          Param(name="mode", kind="choice", options=["a"])]),
        twice))  # fmt: skip


def graph(values: str, exposed: list[str]) -> Graph:
    nodes = [GraphNode(id="n", type="test/number", params={"values": values}),
             GraphNode(id="t", type="test/twice", param_inputs=exposed),
             GraphNode(id="v", type="view/value")]  # fmt: skip
    edges = [GraphEdge(source="t", output="out", target="v", input="value")]
    if exposed:
        edges.append(GraphEdge(source="n", output="out", target="t", input="k"))
    return Graph(name="g", nodes=nodes, edges=edges)


def run(g: Graph, tmp_path: Path) -> dict:
    return execute(g, _Ctx(_project(), None, ResultStore(tmp_path)), ResultCache())  # type: ignore[arg-type]


def test_a_parameter_set_by_a_number(test_nodes: None, tmp_path: Path) -> None:
    assert run(graph("3", []), tmp_path)["t"].outputs["out"].value == pytest.approx(2e-3)  # 1 ms
    results = run(graph("3", ["k"]), tmp_path)
    assert results["t"].outputs["out"].value == pytest.approx(6.0)
    assert make_edge(graph("3", ["k"]), "n.out", "t.k").input == "k"


def test_a_family_sets_it_once_per_member(test_nodes: None, tmp_path: Path) -> None:
    out = run(graph("1 2 5", ["k"]), tmp_path)["t"].outputs["out"]
    assert isinstance(out, FamilyValue) and [i.value for i in out.items] == [2.0, 4.0, 10.0]


def test_only_numeric_parameters_become_sockets(test_nodes: None) -> None:
    names = [s.name for s in input_sockets(CATALOG["test/twice"], ["k", "mode", "nope"])]
    assert names == ["k"]
    measure = CATALOG["measure/basic"]  # "at" is already an input of its own
    assert [s.name for s in input_sockets(measure, ["at"])] == ["signal", "at", "level"]
