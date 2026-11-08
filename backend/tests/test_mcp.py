"""MCP tools against a real backend (uvicorn in a thread, private session file)."""

import socket
import threading
import time
from collections.abc import Iterator
from pathlib import Path

import pytest
import uvicorn

from bpt.api.security import create_session
from bpt.app import create_app
from bpt.mcp import server as tools
from tests.test_golden import pytestmark as ngspice_marks

pytestmark = ngspice_marks


@pytest.fixture
def live_backend(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setenv("BPT_SESSION_FILE", str(tmp_path / "session.json"))
    monkeypatch.setenv("BPT_LIBRARY_DIR", str(tmp_path / "libraries"))
    monkeypatch.setenv("BPT_RECOVERY_DIR", str(tmp_path / "recovery"))
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    session = create_session("127.0.0.1", port)
    app = create_app(session, scratch_root=tmp_path / "scratch")
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    while not server.started:
        time.sleep(0.01)
    tools.backend.session, tools.backend.project_id = None, None
    yield
    server.should_exit = True
    thread.join(timeout=10)


def test_agent_builds_and_simulates_rc_filter(live_backend: None, tmp_path: Path) -> None:
    assert "created" in tools.project_new("filter")
    added = tools.circuit_from_netlist("V1 in 0 DC 0 AC 1\nR1 in out 1k\nC1 out 0 159.15n")
    assert added.startswith("added V1, R1, C1") and "ERC: ok" in added

    result = tools.analysis_run(".ac dec 50 10 1meg", signals=["V(out)"])
    run_id = result.splitlines()[0].removeprefix("run_id ")
    assert "V(out): peak" in result

    at_fc = tools.result_measure(run_id, "V(out)", op="at", at=1000, db=True)
    value = float(at_fc.split("=")[1].split()[0])
    assert abs(value + 3.01) < 0.05, at_fc  # fc = 1/(2*pi*R*C) = 1 kHz

    tools.component_set("R1", {"R": "2k"})
    assert "R1 in out 2k" in tools.circuit_describe()
    assert "error" in tools.analysis_run(".tran")  # bad card is reported, not raised

    table = tools.result_waveform(run_id, "V(out)", max_points=10)
    assert table.startswith("x re+im")
    assert "saved" in tools.project_save(str(tmp_path / "filter.bpt"))


def test_agent_builds_and_runs_a_graph(live_backend: None) -> None:
    tools.project_new("graph")
    tools.circuit_from_netlist("V1 in 0 DC 0 AC 1\nR1 in out 1k\nC1 out 0 159.15n")
    assert "sim/ac" in tools.graph_nodes()
    nodes = [
        {"id": "c", "type": "core/circuit"},
        {"id": "ac", "type": "sim/ac", "params": {"points": 50}},
        {"id": "out", "type": "core/signal", "params": {"expr": "V(out)"}},
        {"id": "fc", "type": "measure/basic", "params": {"op": "f3db"}},
        {"id": "show", "type": "view/value"},
    ]
    links = [["c.circuit", "ac.circuit"], ["ac.run", "out.run"], ["out.signal", "fc.signal"],
             ["fc.value", "show.value"]]  # fmt: skip
    assert "saved" in tools.graph_create("filter", nodes, links)
    assert "no output" in tools.graph_create("bad", nodes, [["c.nope", "ac.circuit"]])
    result = tools.graph_run("filter")
    assert "f-3dB(V(out)) = 1kHz" in result, result
    edited = tools.graph_edit("filter", set_params={"fc": {"op": "max"}})
    assert "op='max'" in edited
    assert "filter: 5 nodes" in tools.graph_describe()


def test_agent_makes_a_block_and_probes_inside(live_backend: None) -> None:
    tools.project_new("hier")
    tools.circuit_from_netlist("V1 vin 0 DC 2\nR1 vin mid 1k\nR2 mid out 1k\nR3 out 0 2k")
    made = tools.block_create(["R1", "R2"], "divider")
    assert made.startswith("block X1 = sheet 'divider', ports: vin, out"), made
    assert "ERC: ok" in made
    assert "not on sheet" in tools.block_create(["R9"], "x")
    assert ".subckt sheet_divider vin out" in tools.circuit_describe()
    result = tools.analysis_run(".op", signals=["V(X1.mid)"])
    assert "V(X1.mid)" in result and "1.5" in result, result


def test_agent_sets_ratings_and_reads_the_stress_report(live_backend: None) -> None:
    tools.project_new("stress")
    tools.circuit_from_netlist("V1 b 0 DC 20\nR2 b 0 1k")
    assert "no ratings checked" in tools.stress_report(_op_run())
    tools.component_set("R2", ratings={"power": "0.25"})
    report = tools.stress_report(_op_run())
    assert report.startswith("FAIL: 1 over") and "160 %" in report, report


def _op_run() -> str:
    return tools.analysis_run(".op").splitlines()[0].removeprefix("run_id ")


def test_agent_project_tools(live_backend: None, tmp_path: Path) -> None:
    """redo, snapshots, sheets, parameters, netlist and BOM exports."""
    tools.project_new("tools")
    tools.circuit_from_netlist("V1 a 0 DC 5\nR1 a b {Rx}\nR2 b 0 1k")
    assert "Rx = 2k" in tools.param_set("Rx", "2k")
    shot = tools.snapshot_take("before R3").split()[1]
    tools.component_add("resistor", ["b", "0"], params={"R": "10k"})
    tools.undo()
    assert "redone" in tools.redo()
    assert "before R3" in tools.snapshot_list()
    tools.snapshot_restore(shot)
    assert "R3" not in tools.circuit_describe()
    tools.sheet_add("page2")
    tools.sheet_rename("page2", "power")
    assert "power: 0 parts" in tools.sheet_list()
    netlist = tools.export_netlist()
    assert ".param Rx=2k" in netlist and "{Rx}" in netlist
    assert "3 BOM rows" not in tools.export_bom()  # V1 is not a part: 2 resistors grouped by value
    assert "wrote" in tools.export_bom(str(tmp_path / "bom.csv"))
    assert (tmp_path / "bom.csv").read_text(encoding="utf-8").startswith("Quantity")


def test_agent_makes_fits_and_places_a_component(live_backend: None) -> None:
    """component_fit -> component_create -> component_add (library part) -> component_info."""
    assert "capacitor (capacitor" in tools.template_list()
    f = [1e2, 1e3, 1e4, 1e5]
    points = {"|Z|(f)": [[x, 1 / (2 * 3.14159265 * x * 4.7e-6)] for x in f]}
    fitted = tools.component_fit("capacitor", points, free=["Cnom"], form={"Cnom": "1u"})
    assert "Cnom=4.7u" in fitted, fitted
    saved = tools.component_create("capacitor", "C4U7", form={"Cnom": "4.7u", "esr": "10m"},
                                   library="agent-parts", ratings={"voltage": "25"})  # fmt: skip
    component = saved.split()[1]
    assert component == "cmp:agent-parts/C4U7"
    info = tools.component_info(component)
    assert "ratings: voltage=25" in info and "|Z|(f)" in info, info
    tools.project_new("uses it")
    added = tools.component_add(component, ["a", "0"])
    assert added.startswith("added C1"), added
    tools.circuit_from_netlist("V1 a 0 DC 1 AC 1")
    assert "ok" in tools.analysis_run(".op") or "run_id" in tools.analysis_run(".op")
