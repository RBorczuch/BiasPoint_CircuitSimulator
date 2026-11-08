from collections.abc import Iterator
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from bpt.analysis.spec import AnalysisSpec
from bpt.document.builder import import_netlist
from bpt.document.commands import MoveObjects, SetGraph
from bpt.document.model import Graph, GraphEdge, GraphNode, Project, Sheet
from bpt.document.storage import load_project, save_project
from bpt.engines.ngspice.engine import NgspiceEngine
from bpt.graph.catalog import (
    CATALOG,
    NodeError,
    check_condition,
    sweep_values,
    tolerance_rules,
)
from bpt.graph.executor import ResultCache, execute
from bpt.graph.values import FamilyValue, ScalarValue
from bpt.netlist.netlister import netlist_project
from bpt.netlist.spice_parser import parse_netlist
from bpt.results.store import ResultStore, RunReader
from tests.conftest import TOKEN
from tests.test_golden import pytestmark as ngspice_marks

H = {"x-bpt-token": TOKEN}
DIVIDER = "* divider\nV1 in 0 DC 2\nR1 in out 1k\nR2 out 0 1k\n"


def _project() -> Project:
    project = Project(name="g", sheets=[Sheet(name="root")])
    import_netlist(project, parse_netlist(DIVIDER)).apply(project)
    return project


def _power_graph() -> Graph:
    """P(R1) = V(in,out) * I(R1), averaged: the node.md N1 acceptance path."""

    def n(id_: str, type_: str, **params: str) -> GraphNode:  # (as the editor makes it)
        return GraphNode(id=id_, type=type_, params=params, version=CATALOG[type_].version)

    def e(source: str, output: str, target: str, input_: str) -> GraphEdge:
        return GraphEdge(source=source, output=output, target=target, input=input_)

    return Graph(
        name="power",
        nodes=[
            n("c", "core/circuit"),
            n("t", "sim/tran", stop="1 ms", step="10 µs"),
            n("v", "core/signal", expr="V(in,out)"),
            n("i", "core/signal", expr="I(R1)"),
            n("p", "math/expr", expr="a*b", name="P"),
            n("m", "measure/basic", op="avg"),
            n("show", "view/value"),
            n("plot", "view/plot"),
        ],
        edges=[
            e("c", "circuit", "t", "circuit"),
            e("t", "run", "v", "run"),
            e("t", "run", "i", "run"),
            e("v", "signal", "p", "a"),
            e("i", "signal", "p", "b"),
            e("p", "out", "m", "signal"),
            e("m", "value", "show", "value"),
            e("p", "out", "plot", "signals"),
        ],
    )


class _Ctx:
    def __init__(self, project: Project, engine: NgspiceEngine, store: ResultStore) -> None:
        self.project = project
        self.engine = engine
        self.store = store
        self.simulations = 0

    def simulate(self, project: Project, analysis: AnalysisSpec) -> RunReader:
        self.simulations += 1
        meta = self.engine.run(netlist_project(project).circuit, analysis, self.store)
        return self.store.open(meta.run_id)

    def open_run(self, run_id: str) -> RunReader:
        return self.store.open(run_id)


@pytest.fixture
def engine() -> Iterator[NgspiceEngine]:
    engine = NgspiceEngine()
    yield engine
    engine.close()


@ngspice_marks[0]
@ngspice_marks[1]
def test_power_average_and_cache(engine: NgspiceEngine, tmp_path: Path) -> None:
    project = _project()
    ctx = _Ctx(project, engine, ResultStore(tmp_path))
    cache = ResultCache()
    results = execute(_power_graph(), ctx, cache)
    assert {k: r.state.status for k, r in results.items()} == dict.fromkeys(results, "ok")
    power = results["m"].outputs["value"]
    assert isinstance(power, ScalarValue)
    assert power.unit == "W"
    assert power.value == pytest.approx(1e-3, rel=1e-3)  # 1 V across 1 kΩ
    assert results["show"].state.summary == ["avg(P) = 1mW"]

    # Moving a part does not change the netlist: everything comes from the cache.
    sheet = project.sheets[0]
    everything = [o.id for kind in ("instances", "wires", "labels") for o in getattr(sheet, kind)]
    MoveObjects(ids=everything, dx=1270, dy=-635).apply(project)
    again = execute(_power_graph(), ctx, cache)
    assert again["t"].state.status == "cached"
    assert ctx.simulations == 1

    # A new value re-runs the simulation and what depends on it.
    r2 = next(i for i in project.sheets[0].instances if i.ref == "R2")
    r2.model.params["R"] = "3k"
    changed = execute(_power_graph(), ctx, cache)
    assert changed["t"].state.status == "ok"
    assert ctx.simulations == 2
    value = changed["m"].outputs["value"]
    assert isinstance(value, ScalarValue)
    assert value.value == pytest.approx(0.25e-3, rel=1e-3)  # 0.5 V across 1 kΩ


@ngspice_marks[0]
@ngspice_marks[1]
def test_errors_stay_on_their_node(engine: NgspiceEngine, tmp_path: Path) -> None:
    graph = _power_graph()
    graph.nodes[3].params["expr"] = "I(nothing)"
    results = execute(graph, _Ctx(_project(), engine, ResultStore(tmp_path)), ResultCache())
    assert results["i"].state.status == "error"
    assert "nothing" in (results["i"].state.error or "")
    assert results["p"].state.status == "blocked"
    assert results["v"].state.status == "ok"


def test_unconnected_input_is_reported(tmp_path: Path) -> None:
    nodes = [GraphNode(id="m", type="measure/basic"), GraphNode(id="v", type="view/value")]
    edges = [GraphEdge(source="m", output="value", target="v", input="value")]
    ctx = _Ctx(_project(), None, ResultStore(tmp_path))  # type: ignore[arg-type]
    results = execute(Graph(name="g", nodes=nodes, edges=edges), ctx, ResultCache())
    assert results["m"].state.error == "connect signal"
    assert results["v"].state.status == "blocked"


def test_graphs_are_saved_and_undoable(tmp_path: Path) -> None:
    project = _project()
    inverse = SetGraph(name="power", graph=_power_graph()).apply(project)
    save_project(project, tmp_path / "p.bpt")
    assert (tmp_path / "p.bpt" / "graphs" / "power.json").is_file()
    loaded = load_project(tmp_path / "p.bpt")
    assert loaded.graphs == project.graphs
    inverse.apply(project)
    assert project.graphs == []
    save_project(project, tmp_path / "p.bpt")
    assert not (tmp_path / "p.bpt" / "graphs" / "power.json").exists()


@ngspice_marks[0]
@ngspice_marks[1]
def test_graph_api(client: TestClient) -> None:
    types = client.get("/api/graph/node-types", headers=H).json()
    assert {"core/circuit", "sim/tran", "view/plot"} <= {t["type"] for t in types}
    pid = client.post("/api/projects", json={"name": "g"}, headers=H).json()["id"]
    client.post(f"/api/projects/{pid}/circuit/import", json={"text": DIVIDER}, headers=H)
    command = {
        "type": "set_graph",
        "name": "power",
        "graph": _power_graph().model_dump(mode="json"),
    }
    assert client.post(
        f"/api/projects/{pid}/commands", json={"command": command}, headers=H
    ).is_success
    client.post(f"/api/projects/{pid}/graphs/power/run", headers=H)
    for _ in range(200):
        results = client.get(f"/api/projects/{pid}/graphs/power/results", headers=H).json()
        if results["status"] == "done":
            break
        import time

        time.sleep(0.05)
    assert results["nodes"]["show"]["status"] == "ok", results
    plot = client.post(
        f"/api/projects/{pid}/graphs/power/nodes/plot/plot", json={"pixels": 50}, headers=H
    )
    series = plot.json()
    assert series[0]["name"] == "P" and series[0]["unit"] == "W"
    values = client.get(f"/api/projects/{pid}/graphs/power/nodes/show/values", headers=H).json()
    assert values[0]["value"] == pytest.approx(1e-3, rel=1e-3)


@ngspice_marks[0]
@ngspice_marks[1]
def test_sweep_gives_families_and_a_table(engine: NgspiceEngine, tmp_path: Path) -> None:
    """node.md N2 criterion: R swept 1k/2k/5k, three curves, a table of f-3dB."""
    project = Project(name="lp", sheets=[Sheet(name="root")])
    text = "* lp\nV1 in 0 DC 0 AC 1\nR1 in out {Rv}\nC1 out 0 100n\n"
    import_netlist(project, parse_netlist(text)).apply(project)

    def n(id_: str, type_: str, **params: str) -> GraphNode:
        return GraphNode(id=id_, type=type_, params=params)

    def e(source: str, output: str, target: str, input_: str) -> GraphEdge:
        return GraphEdge(source=source, output=output, target=target, input=input_)

    graph = Graph(
        name="sweep",
        nodes=[
            n("c", "core/circuit"),
            n("sw", "core/sweep", name="Rv", values="1k 2k 5k"),
            n("ac", "sim/ac", start="10 Hz", stop="100 kHz"),
            n("v", "core/signal", expr="V(out)"),
            n("fc", "measure/basic", op="f3db"),
            n("table", "view/table"),
            n("plot", "view/plot"),
        ],
        edges=[
            e("c", "circuit", "ac", "circuit"),
            e("sw", "params", "ac", "params"),
            e("ac", "run", "v", "run"),
            e("v", "signal", "fc", "signal"),
            e("fc", "value", "table", "values"),
            e("v", "signal", "plot", "signals"),
        ],
    )
    results = execute(graph, _Ctx(project, engine, ResultStore(tmp_path)), ResultCache())
    assert results["table"].state.status == "ok", results["table"].state
    family = results["fc"].outputs["value"]
    assert isinstance(family, FamilyValue)
    leaves = family.leaves()
    assert [label for label, _ in leaves] == ["Rv=1k", "Rv=2k", "Rv=5k"]
    for (_, value), r in zip(leaves, (1e3, 2e3, 5e3), strict=True):
        assert isinstance(value, ScalarValue)
        assert value.value == pytest.approx(1 / (2 * np.pi * r * 100e-9), rel=0.01)
    curves = results["plot"].inputs["signals"][0]
    assert isinstance(curves, FamilyValue) and len(curves.items) == 3


def test_sweep_values() -> None:
    assert sweep_values("1k, 2k 5k") == ["1k", "2k", "5k"]
    assert sweep_values("lin 1 5 5") == ["1", "2", "3", "4", "5"]
    assert sweep_values("dec 10 1k 1") == ["10", "100", "1k"]
    with pytest.raises(NodeError):
        sweep_values("lin 1 5")


def test_tolerance_corners() -> None:
    assert sweep_values("1k ±5%") == ["950", "1k", "1.05k"]
    assert sweep_values("10n +-10%") == ["9n", "10n", "11n"]


@ngspice_marks[0]
@ngspice_marks[1]
def test_temperature_sweep_runs_in_parallel(engine: NgspiceEngine, tmp_path: Path) -> None:
    """A diode's forward voltage falls with temperature (~ -2 mV/K); temp sets .temp."""
    project = Project(name="d", sheets=[Sheet(name="root")])
    import_netlist(project, parse_netlist("* d\nV1 in 0 DC 1\nR1 in a 1k\nD1 a 0 D\n")).apply(
        project
    )
    graph = Graph(
        name="t",
        nodes=[
            GraphNode(id="c", type="core/circuit"),
            GraphNode(id="sw", type="core/sweep", params={"name": "temp", "values": "-40 25 85"}),
            GraphNode(
                id="op",
                type="sim/dc",
                params={"source": "V1", "start": "1", "stop": "1", "step": "1"},
            ),
            GraphNode(id="v", type="core/signal", params={"expr": "V(a)"}),
            GraphNode(id="m", type="measure/basic", params={"op": "final"}),
            GraphNode(id="t", type="view/table"),
        ],
        edges=[
            GraphEdge(source="c", output="circuit", target="op", input="circuit"),
            GraphEdge(source="sw", output="params", target="op", input="params"),
            GraphEdge(source="op", output="run", target="v", input="run"),
            GraphEdge(source="v", output="signal", target="m", input="signal"),
            GraphEdge(source="m", output="value", target="t", input="values"),
        ],
    )
    results = execute(graph, _Ctx(project, engine, ResultStore(tmp_path)), ResultCache())
    family = results["m"].outputs["value"]
    assert isinstance(family, FamilyValue)
    vf = [v.value for _, v in family.leaves() if isinstance(v, ScalarValue)]
    assert vf[0] > vf[1] > vf[2]
    assert (vf[0] - vf[2]) / 125 == pytest.approx(2e-3, rel=0.35)


@ngspice_marks[0]
@ngspice_marks[1]
def test_rise_time_and_fft_nodes(engine: NgspiceEngine, tmp_path: Path) -> None:
    project = Project(name="rc", sheets=[Sheet(name="root")])
    text = (
        "* rc\nV1 in 0 PULSE(0 1 0 1n 1n 5m 10m)\nR1 in out 1k\nC1 out 0 100n\n"
        "V2 s 0 SIN(0 1 1k)\nR2 s 0 1k\n"
    )
    import_netlist(project, parse_netlist(text)).apply(project)

    def n(id_: str, type_: str, **params: str) -> GraphNode:
        return GraphNode(id=id_, type=type_, params=params)

    def e(source: str, output: str, target: str, input_: str) -> GraphEdge:
        return GraphEdge(source=source, output=output, target=target, input=input_)

    graph = Graph(
        name="dsp",
        nodes=[
            n("c", "core/circuit"),
            n("t", "sim/tran", stop="4 ms", step="1 µs", max_step="1 µs"),
            n("out", "core/signal", expr="V(out)"),
            n("rise", "measure/basic", op="rise"),
            n("s", "core/signal", expr="V(s)"),
            n("fft", "math/fft", window="flattop"),
            n("peak", "measure/basic", op="max"),
            n("table", "view/table"),
        ],
        edges=[
            e("c", "circuit", "t", "circuit"),
            e("t", "run", "out", "run"),
            e("out", "signal", "rise", "signal"),
            e("t", "run", "s", "run"),
            e("s", "signal", "fft", "signal"),
            e("fft", "spectrum", "peak", "signal"),
            e("rise", "value", "table", "values"),
            e("peak", "value", "table", "values"),
        ],
    )
    results = execute(graph, _Ctx(project, engine, ResultStore(tmp_path)), ResultCache())
    rise, peak = results["rise"].outputs["value"], results["peak"].outputs["value"]
    assert isinstance(rise, ScalarValue) and isinstance(peak, ScalarValue)
    assert rise.value == pytest.approx(np.log(9) * 1e3 * 100e-9, rel=0.03)  # 2.2 RC = 220 µs
    assert peak.value == pytest.approx(1.0, rel=0.02)  # 1 V amplitude line


def test_tolerance_rules_and_conditions() -> None:
    assert tolerance_rules("R* ±5%; C1 +-10%") == [("R*", 0.05), ("C1", 0.1)]
    with pytest.raises(NodeError):
        tolerance_rules("R1 5")
    assert check_condition("> 45", "°")(46) and not check_condition("> 45", "°")(44)
    assert check_condition("900..1.1k", "Hz")(1e3) and not check_condition("900..1.1k", "Hz")(1.2e3)
    assert check_condition("<= 1 kHz", "Hz")(999)


@ngspice_marks[0]
@ngspice_marks[1]
def test_monte_carlo_spread_and_yield(engine: NgspiceEngine, tmp_path: Path) -> None:
    project = Project(name="mc", sheets=[Sheet(name="root")])
    text = "* mc\nV1 in 0 DC 0 AC 1\nR1 in out 1k\nC1 out 0 159.15n\n"
    import_netlist(project, parse_netlist(text)).apply(project)

    def n(id_: str, type_: str, **params: str) -> GraphNode:
        return GraphNode(id=id_, type=type_, params=params)

    def e(source: str, output: str, target: str, input_: str) -> GraphEdge:
        return GraphEdge(source=source, output=output, target=target, input=input_)

    graph = Graph(
        name="mc",
        nodes=[
            n("c", "core/circuit"),
            n("mc", "core/montecarlo", tolerances="R* ±5%; C* ±10%", runs="40", seed="7"),
            n("ac", "sim/ac", points="40", start="100 Hz", stop="10 kHz"),
            n("v", "core/signal", expr="V(out)"),
            n("fc", "measure/basic", op="f3db"),
            n("spec", "view/spec", condition="900..1.1k"),
            n("hist", "view/histogram"),
        ],
        edges=[
            e("c", "circuit", "mc", "circuit"),
            e("mc", "circuit", "ac", "circuit"),
            e("ac", "run", "v", "run"),
            e("v", "signal", "fc", "signal"),
            e("fc", "value", "spec", "value"),
            e("fc", "value", "hist", "values"),
        ],
    )
    ctx = _Ctx(project, engine, ResultStore(tmp_path))
    results = execute(graph, ctx, ResultCache())
    family = results["fc"].outputs["value"]
    assert isinstance(family, FamilyValue) and len(family.items) == 40
    fc = np.array([v.value for _, v in family.leaves() if isinstance(v, ScalarValue)])
    assert np.mean(fc) == pytest.approx(1000, rel=0.03)
    assert 0.015 < np.std(fc) / np.mean(fc) < 0.07  # ~3.7 % from 5 % / 10 % at 3 sigma
    spec = results["spec"].outputs["yield"]
    assert isinstance(spec, ScalarValue) and 60 <= spec.value <= 100
    assert results["spec"].state.summary[0].startswith(("PASS", "FAIL"))
    again = execute(graph, ctx, ResultCache())["fc"].outputs["value"]  # same seed, same spread
    assert isinstance(again, FamilyValue)
    assert [v.value for _, v in again.leaves()] == pytest.approx(list(fc))  # type: ignore[union-attr]


def _sweep_graph(name: str, values: str) -> Graph:
    def n(id_: str, type_: str, **params: str) -> GraphNode:
        return GraphNode(id=id_, type=type_, params=params)

    def e(source: str, output: str, target: str, input_: str) -> GraphEdge:
        return GraphEdge(source=source, output=output, target=target, input=input_)

    return Graph(
        name="sk",
        nodes=[
            n("c", "core/circuit"),
            n("sw", "core/sweep", name=name, values=values),
            n("ac", "sim/ac", start="10 Hz", stop="1 MHz"),
            n("v", "core/signal", expr="V(out)"),
            n("fc", "measure/basic", op="f3db"),
        ],
        edges=[
            e("c", "circuit", "ac", "circuit"),
            e("sw", "params", "ac", "params"),
            e("ac", "run", "v", "run"),
            e("v", "signal", "fc", "signal"),
        ],
    )


SALLEN_KEY = (
    "* sk\nV1 in 0 DC 0 AC 1\nR1 in a 10k\nR2 a b 10k\nC1 a out 2n\nC2 b 0 1n\n"
    "E1 out 0 b out 1meg\n"
)


@ngspice_marks[0]
@ngspice_marks[1]
def test_sweeping_a_part_reference_changes_that_part(engine: NgspiceEngine, tmp_path: Path) -> None:
    """Sweep "C1" on a Sallen-Key low-pass whose C1 is a plain 2n (not {C1})."""
    project = Project(name="sk", sheets=[Sheet(name="root")])
    import_netlist(project, parse_netlist(SALLEN_KEY)).apply(project)
    results = execute(_sweep_graph("C1", "1n 2n 10n"),
                      _Ctx(project, engine, ResultStore(tmp_path)), ResultCache())  # fmt: skip
    family = results["fc"].outputs["value"]
    assert isinstance(family, FamilyValue)
    got = [v.value for _, v in family.leaves() if isinstance(v, ScalarValue)]

    def f3db(c1: float) -> float:
        # Unity-gain Sallen-Key: w0 = 1/sqrt(R1 R2 C1 C2), Q = sqrt(R1 R2 C1 C2)/(C2 (R1+R2)).
        r, c2 = 10e3, 1e-9
        w0 = 1 / np.sqrt(r * r * c1 * c2)
        q = np.sqrt(r * r * c1 * c2) / (c2 * 2 * r)
        a = 1 / (2 * q * q) - 1
        return float(w0 * np.sqrt(-a + np.sqrt(a * a + 1)) / (2 * np.pi))

    assert got == pytest.approx([f3db(c) for c in (1e-9, 2e-9, 10e-9)], rel=0.02)
    assert got[1] == pytest.approx(11.25e3, rel=0.01)  # the schematic's own value


def test_a_sweep_that_changes_nothing_is_an_error(tmp_path: Path) -> None:
    from bpt.graph.catalog import NodeError, apply_overrides

    project = Project(name="sk", sheets=[Sheet(name="root")])
    import_netlist(project, parse_netlist(SALLEN_KEY)).apply(project)
    with pytest.raises(NodeError, match="changes nothing"):
        apply_overrides(project, {"Cx": "1n"})
    apply_overrides(project, {"c2": "3n"})  # a reference, any case
    c2 = next(i for i in project.sheet("root").instances if i.ref == "C2")
    assert c2.model.params["C"] == "3n"


@ngspice_marks[0]
@ngspice_marks[1]
def test_stress_node_takes_the_worst_member(engine: NgspiceEngine, tmp_path: Path) -> None:
    """FR-SIM-7 in the graph: R2 swept 2k / 1k; at 1k it dissipates 0.4 W of 0.25 W (FAIL)."""
    project = Project(name="st", sheets=[Sheet(name="root")])
    import_netlist(project, parse_netlist("* st\nV1 b 0 DC 20\nR2 b 0 {Rv}\n")).apply(project)
    project.parameters["Rv"] = "2k"
    r2 = next(i for i in project.sheets[0].instances if i.ref == "R2")
    r2.ratings = {"power": "0.25"}

    def n(id_: str, type_: str, **params: str) -> GraphNode:
        return GraphNode(id=id_, type=type_, params=params)

    def e(source: str, output: str, target: str, input_: str) -> GraphEdge:
        return GraphEdge(source=source, output=output, target=target, input=input_)

    graph = Graph(
        name="stress",
        nodes=[n("c", "core/circuit"), n("sw", "core/sweep", name="Rv", values="2k 1k"),
               n("op", "sim/op"), n("st", "measure/stress"), n("table", "view/table")],
        edges=[e("c", "circuit", "op", "circuit"), e("sw", "params", "op", "params"),
               e("op", "run", "st", "run"), e("st", "items", "table", "values")],
    )  # fmt: skip
    results = execute(graph, _Ctx(project, engine, ResultStore(tmp_path)), ResultCache())
    assert results["st"].state.status == "ok", results["st"].state
    worst = results["st"].outputs["worst"]
    assert isinstance(worst, ScalarValue)
    assert worst.value == pytest.approx(160) and worst.name.startswith("FAIL")
    assert results["table"].state.status == "ok", results["table"].state
