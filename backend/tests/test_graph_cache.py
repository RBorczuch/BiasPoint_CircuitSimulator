"""Graph results kept on disk (graf.md §11, G1): a graph opened again shows its last results
without simulating."""

from pathlib import Path

import numpy as np

from bpt.engines.ngspice.engine import NgspiceEngine
from bpt.graph.diskcache import DiskCache
from bpt.graph.executor import ResultCache, execute
from bpt.graph.values import (
    CircuitValue,
    FamilyValue,
    ParamsValue,
    RunValue,
    ScalarValue,
    SignalValue,
    TableValue,
)
from bpt.results.store import ResultStore
from tests.test_golden import pytestmark as ngspice_marks
from tests.test_graph import _Ctx, _power_graph, _project, engine  # noqa: F401


def test_values_come_back_as_they_were_kept(tmp_path: Path) -> None:
    (tmp_path / "run1").mkdir()
    (tmp_path / "run1" / "meta.json").write_text("{}")
    disk = DiskCache(tmp_path)
    ac = SignalValue("V(out)", np.array([1.0, 10.0]), np.array([1 + 1j, 0.5 - 0.5j]),
                     "frequency", "Hz", "V")  # fmt: skip
    outputs = {
        "signal": ac,
        "value": ScalarValue("gain", 2.5, "dB", phase_deg=-45.0),
        "run": RunValue("run1", "ac", "frequency", ["V(out)"]),
        "params": ParamsValue({"R": "1k"}),
        "table": TableValue("t", ["R", "fc"], ["", "Hz"], [[1e3, 159.2], [2e3, "n/a"]]),
        "family": FamilyValue("R", ["1k", "2k"], [ScalarValue("A", 1.0), ScalarValue("A", 2.0)]),
    }
    assert disk.put("abc123", outputs)
    back = DiskCache(tmp_path).get("abc123")
    assert back is not None
    signal = back.pop("signal")
    assert isinstance(signal, SignalValue) and signal.is_complex
    assert np.array_equal(signal.y, ac.y) and signal.x_unit == "Hz"
    assert back == {k: v for k, v in outputs.items() if k != "signal"}
    assert disk.get("missing") is None


def test_circuits_stay_in_memory_and_gone_runs_count_as_missing(tmp_path: Path) -> None:
    disk = DiskCache(tmp_path)
    assert not disk.put("c1", {"circuit": CircuitValue(_project(), "k")})
    assert disk.put("r1", {"run": RunValue("pruned", "tran", "time", [])})
    assert disk.get("r1") is None  # its run is not in the results folder
    assert not (tmp_path / "graph-cache" / "r1.npz").exists()


def test_the_least_recently_used_go_first(tmp_path: Path) -> None:
    import os

    disk = DiskCache(tmp_path, limit=40_000)
    big = {"s": SignalValue("x", np.zeros(500), np.zeros(500))}  # 8 kB per entry
    for k in range(4):
        assert disk.put(f"k{k}", big)
        os.utime(disk.folder / f"k{k}.npz", (1000 + k, 1000 + k))
    disk.get("k0")  # used again: the newest
    assert disk.put("k4", big)  # 5 x 8 kB > 40 kB: the oldest go, down to 80 %
    left = sorted(p.stem for p in disk.folder.glob("*.npz"))
    assert "k0" in left and "k4" in left and "k1" not in left


@ngspice_marks[0]
@ngspice_marks[1]
def test_a_graph_reopened_shows_its_results_without_simulating(
    engine: NgspiceEngine,  # noqa: F811
    tmp_path: Path,
) -> None:
    store = ResultStore(tmp_path)
    first = execute(_power_graph(), _Ctx(_project(), engine, store), ResultCache(),
                    disk=DiskCache(tmp_path))  # fmt: skip
    # The next session: an empty memory cache, the same results folder.
    ctx = _Ctx(_project(), engine, store)
    again = execute(_power_graph(), ctx, ResultCache(), disk=DiskCache(tmp_path), restore=True)
    assert ctx.simulations == 0
    assert again["t"].state.status == "cached" and again["t"].state.from_disk
    assert again["m"].outputs["value"] == first["m"].outputs["value"]
    assert again["show"].state.status == "ok"  # views are drawn again from their inputs


@ngspice_marks[0]
@ngspice_marks[1]
def test_restoring_with_nothing_kept_leaves_the_nodes_without_results(
    engine: NgspiceEngine,  # noqa: F811
    tmp_path: Path,
) -> None:
    ctx = _Ctx(_project(), engine, ResultStore(tmp_path))
    results = execute(_power_graph(), ctx, ResultCache(), disk=DiskCache(tmp_path), restore=True)
    assert ctx.simulations == 0
    assert results["c"].state.status == "ok"  # the circuit costs nothing
    assert "t" not in results and "m" not in results and "show" not in results


@ngspice_marks[0]
@ngspice_marks[1]
def test_stop_keeps_the_sweep_points_done(engine: NgspiceEngine, tmp_path: Path) -> None:  # noqa: F811
    """Stopped after two of five points: the plot and the measurement show those two, noted,
    and nothing partial is cached as the full result."""
    import threading

    from bpt.analysis.spec import AnalysisSpec
    from bpt.document.builder import import_netlist
    from bpt.document.model import Graph, GraphEdge, GraphNode, Project, Sheet
    from bpt.graph.executor import CancelledError
    from bpt.netlist.spice_parser import parse_netlist
    from bpt.results.store import RunReader

    project = Project(name="lp", sheets=[Sheet(name="root")])
    text = "* lp\nV1 in 0 DC 0 AC 1\nR1 in out {Rv}\nC1 out 0 100n\n"
    import_netlist(project, parse_netlist(text)).apply(project)
    cancel = threading.Event()
    lock = threading.Lock()
    started: list[int] = []

    class Stopping(_Ctx):
        def simulate(self, project: Project, analysis: AnalysisSpec) -> RunReader:
            with lock:
                started.append(1)
                if len(started) > 2:  # Stop pressed: the engine drops the rest
                    cancel.set()
                    raise CancelledError
            return super().simulate(project, analysis)

    def n(id_: str, type_: str, **params: str) -> GraphNode:
        return GraphNode(id=id_, type=type_, params=params)

    def e(source: str, output: str, target: str, input_: str) -> GraphEdge:
        return GraphEdge(source=source, output=output, target=target, input=input_)

    graph = Graph(
        name="sweep",
        nodes=[n("c", "core/circuit"), n("sw", "core/sweep", name="Rv", values="1k 2k 5k 10k 20k"),
               n("ac", "sim/ac", start="10 Hz", stop="100 kHz"),
               n("v", "core/signal", expr="V(out)"), n("fc", "measure/basic", op="f3db"),
               n("plot", "view/plot"), n("table", "view/table")],
        edges=[e("c", "circuit", "ac", "circuit"), e("sw", "params", "ac", "params"),
               e("ac", "run", "v", "run"), e("v", "signal", "fc", "signal"),
               e("v", "signal", "plot", "signals"), e("fc", "value", "table", "values")],
    )  # fmt: skip
    cache = ResultCache()
    disk = DiskCache(tmp_path)
    results = execute(graph, Stopping(project, engine, ResultStore(tmp_path)), cache,
                      cancel=cancel, disk=disk)  # fmt: skip
    ac = results["ac"]
    assert ac.state.status == "ok" and ac.state.error == "stopped: Rv: 2 of 5 points"
    assert len(ac.outputs["run"].items) == 2
    assert results["fc"].state.status == "ok" and len(results["fc"].outputs["value"].items) == 2
    assert results["plot"].state.status == "ok"
    # The next run computes the full sweep: no partial result under the full keys.
    full = execute(graph, _Ctx(project, engine, ResultStore(tmp_path)), cache, disk=disk)
    assert full["ac"].state.status == "ok" and len(full["ac"].outputs["run"].items) == 5
    assert len(full["fc"].outputs["value"].items) == 5
