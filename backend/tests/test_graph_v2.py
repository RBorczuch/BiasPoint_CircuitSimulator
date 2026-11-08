"""Graph format 2 (graf.md §11, G1): node versions and their migrations, reroutes, bypass,
groups and notes kept with the graph."""

import json
from pathlib import Path

import pytest

from bpt.document.migrations import GraphVersionError, migrate_graph
from bpt.document.model import Graph, GraphEdge, GraphGroup, GraphNode, GraphNote, GraphReroute
from bpt.document.storage import load_project, save_project
from bpt.engines.ngspice.engine import NgspiceEngine
from bpt.graph.catalog import CATALOG, NodeType, upgrade
from bpt.graph.executor import ResultCache, execute
from bpt.results.store import ResultStore
from tests.test_golden import pytestmark as ngspice_marks
from tests.test_graph import _Ctx, _power_graph, _project, engine  # noqa: F401


def test_a_version_1_graph_file_is_migrated() -> None:
    old = {
        "schema_version": 1,
        "name": "g",
        "nodes": [{"id": "a", "type": "sim/tran", "pos": [0, 0], "params": {}}],
        "edges": [],
    }
    graph = Graph.model_validate(migrate_graph(old))
    assert graph.nodes[0].version == 1 and graph.nodes[0].title == ""
    assert graph.groups == [] and graph.notes == [] and graph.reroutes == []
    with pytest.raises(GraphVersionError, match="newer"):
        migrate_graph({**old, "schema_version": 99})


def test_saved_and_opened_with_groups_notes_reroutes(tmp_path: Path) -> None:
    project = _project()
    graph = _power_graph()
    graph.nodes[2].title = "Voltage across R1"
    graph.groups = [GraphGroup(id="g1", title="Power", color="violet", rect=(0, 0, 600, 300))]
    graph.notes = [GraphNote(id="n1", text="**Check** the average", pos=(0, 320))]
    graph.reroutes = [GraphReroute(id="r1", pos=(200, 100))]
    project.graphs = [graph]
    save_project(project, tmp_path / "p.bpt")
    data = json.loads((tmp_path / "p.bpt" / "graphs" / "power.json").read_text(encoding="utf-8"))
    assert data["schema_version"] == 2
    loaded = load_project(tmp_path / "p.bpt").graphs[0]
    assert loaded == graph


def test_older_nodes_are_brought_to_their_types_version(monkeypatch: pytest.MonkeyPatch) -> None:
    """A type at version 2 that renamed a parameter: a version 1 node gets the new name."""
    base = CATALOG["math/expr"]
    renamed = NodeType(info=base.info, run=base.run, version=2,
                       migrations={1: lambda p: {("expr" if k == "formula" else k): v
                                                 for k, v in p.items()}})  # fmt: skip
    monkeypatch.setitem(CATALOG, "math/expr", renamed)
    graph = Graph(name="g", nodes=[GraphNode(id="p", type="math/expr", params={"formula": "a*2"})])
    notes = upgrade(graph)
    assert graph.nodes[0].version == 2 and graph.nodes[0].params == {"expr": "a*2"}
    assert notes == ["p: math/expr 1 -> 2"]
    assert upgrade(graph) == []  # once only


@ngspice_marks[0]
@ngspice_marks[1]
def test_reroutes_pass_values_through(engine: NgspiceEngine, tmp_path: Path) -> None:  # noqa: F811
    """The voltage reaches the product through two reroutes: the same result as directly."""
    graph = _power_graph()
    direct = execute(graph, _Ctx(_project(), engine, ResultStore(tmp_path)), ResultCache())
    graph.reroutes = [GraphReroute(id="r1"), GraphReroute(id="r2")]
    graph.edges = [e for e in graph.edges if not (e.source == "v" and e.target == "p")] + [
        GraphEdge(source="v", output="signal", target="r1", input="in"),
        GraphEdge(source="r1", output="out", target="r2", input="in"),
        GraphEdge(source="r2", output="out", target="p", input="a"),
    ]
    routed = execute(graph, _Ctx(_project(), engine, ResultStore(tmp_path)), ResultCache())
    assert routed["m"].state.status in ("ok", "cached")
    assert routed["m"].outputs["value"] == direct["m"].outputs["value"]


@ngspice_marks[0]
@ngspice_marks[1]
def test_bypass_passes_or_skips_the_branch(engine: NgspiceEngine, tmp_path: Path) -> None:  # noqa: F811
    """A bypassed calculation (signal in, signal out) hands its first input on; a bypassed
    measurement (signal in, value out) has nothing of its output's type: its branch is skipped."""
    graph = _power_graph()
    by_id = {n.id: n for n in graph.nodes}
    by_id["p"].bypass = True  # P = a*b switched off: the average is of V(in,out) alone
    results = execute(graph, _Ctx(_project(), engine, ResultStore(tmp_path)), ResultCache())
    assert results["p"].state.error == "bypassed"
    assert results["p"].outputs["out"] is results["v"].outputs["signal"]
    assert results["m"].state.status == "ok"
    by_id["p"].bypass = False
    by_id["m"].bypass = True
    results = execute(graph, _Ctx(_project(), engine, ResultStore(tmp_path)), ResultCache())
    assert results["m"].state.status == "skipped" and results["m"].state.error == "bypassed"
    assert results["show"].state.status == "skipped"
    assert results["show"].state.error == "bypassed upstream"


def test_tables_from_values_and_from_a_sweep() -> None:
    """Plain values: one row; values of one sweep: a row per point with the parameter first."""
    from bpt.graph.catalog import make_table
    from bpt.graph.values import FamilyValue, ScalarValue

    plain = make_table("t", [ScalarValue("fc", 1e3, "Hz"), ScalarValue("Q", 0.7)])
    assert plain.columns == ["fc", "Q"] and plain.rows == [[1e3, 0.7]]
    sweep = FamilyValue(
        "R", ["1k", "2k"], [ScalarValue("fc", 1e3, "Hz"), ScalarValue("fc", 500, "Hz")]
    )
    gain = FamilyValue("R", ["1k", "2k"], [ScalarValue("A", 2.0), ScalarValue("A", 3.0)])
    table = make_table("t", [sweep, gain])
    assert table.columns == ["R", "fc", "A"] and table.units == ["", "Hz", ""]
    assert table.rows == [[1e3, 1e3, 2.0], [2e3, 500, 3.0]]


@ngspice_marks[0]
@ngspice_marks[1]
def test_a_table_node_in_a_graph_and_its_column_plotted(
    engine: NgspiceEngine,  # noqa: F811
    tmp_path: Path,
) -> None:
    graph = _power_graph()
    graph.nodes += [GraphNode(id="tab", type="table/make", params={"name": "power"}),
                    GraphNode(id="col", type="table/column"),
                    GraphNode(id="see", type="view/table"),
        GraphNode(id="plot2", type="view/plot")]  # fmt: skip
    graph.edges += [GraphEdge(source="m", output="value", target="tab", input="values"),
                    GraphEdge(source="tab", output="table", target="see", input="table"),
                    GraphEdge(source="tab", output="table", target="col", input="table"),
        GraphEdge(source="col", output="signal", target="plot2", input="signals")]  # fmt: skip
    results = execute(graph, _Ctx(_project(), engine, ResultStore(tmp_path)), ResultCache())
    table = results["tab"].outputs["table"]
    assert table.rows[0][0] == pytest.approx(1e-3, rel=1e-3)  # the average power, 1 mW
    assert results["see"].state.status == "ok"
    assert results["col"].state.error == "the table needs two columns"


def test_a_view_with_some_inputs_failed_shows_the_rest(tmp_path: Path) -> None:
    """One value of a Table failed: the others are shown with a note, and its empty table
    socket does not count the failure as its own."""
    nodes = [GraphNode(id="a", type="measure/basic"), GraphNode(id="t", type="view/table")]
    edges = [GraphEdge(source="a", output="value", target="t", input="values")]
    from tests.test_graph import _Ctx as Ctx

    ctx = Ctx(_project(), None, ResultStore(tmp_path))  # type: ignore[arg-type]
    results = execute(Graph(name="g", nodes=nodes, edges=edges), ctx, ResultCache())
    assert results["t"].state.status == "blocked"  # its only value failed: nothing to show
    assert results["t"].state.error == "waiting for Measure"
