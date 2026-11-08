"""BiasPoint MCP server (stdio): a thin client of the running backend API.

The agent and the GUI therefore share one live project. If no backend is running, one is
started headless. Answers are compact text (netlists, summaries), never raw waveforms,
to keep token use low. Entry point: ``bpt-mcp``.
"""

import base64
import contextlib
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import quote

from mcp.server.mcpserver import Image, MCPServer
from pydantic import ValidationError

from bpt import __version__
from bpt.api.security import Session, read_session
from bpt.config import ORIGIN_HEADER, TOKEN_HEADER
from bpt.document.model import Graph, GraphNode
from bpt.graph.catalog import CATALOG
from bpt.graph.executor import NodeState
from bpt.graph.text import COLUMN, ROW, auto_layout, catalog_text, graph_text, make_edge, parse_link
from bpt.netlist.spice_parser import SpiceSyntaxError, parse_analysis_card

INSTRUCTIONS = """BiasPoint circuit simulator.
Workflow: project_new / project_open -> build the circuit (circuit_from_netlist with SPICE lines,
or component_add + connect) -> circuit_describe to check (includes ERC) -> analysis_run with a
SPICE card (".op", ".tran 10u 5m", ".ac dec 20 10 1meg", ".dc V1 0 5 0.1") -> result_measure /
result_waveform for details. Nets are named by labels; ground is "0". Values accept SPICE
suffixes (k, meg, m=milli, u, n, p) and 4k7-style notation. Signals: V(<net>), I(<source ref>).
For multi-step analyses (sweeps of calculations, power, measurements shown to the user) build
an analysis graph: graph_nodes -> graph_create -> graph_run -> graph_edit; the user sees it in
the Analysis workspace. Real parts: template_list -> component_fit / component_create ->
component_add("cmp:..."); ratings via component_set(ratings=...) and stress_report(run_id).
Before risky edits: snapshot_take (snapshot_restore to go back).
"""

_START_TIMEOUT_S = 30.0
_JOB_TIMEOUT_S = 600.0


class BackendError(RuntimeError):
    pass


class Backend:
    def __init__(self) -> None:
        self.session: Session | None = None
        self.project_id: str | None = None

    def _request(self, method: str, path: str, body: Any = None) -> Any:
        assert self.session is not None
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(  # noqa: S310 - loopback URL from our session file
            self.session.base_url + path,
            data=data,
            method=method,
            headers={
                TOKEN_HEADER: self.session.token,
                ORIGIN_HEADER: "agent",  # the backend snapshots the project before agent changes
                "content-type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:  # noqa: S310
                raw = response.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")
            with contextlib.suppress(ValueError):
                detail = json.loads(detail).get("detail", detail)
            raise BackendError(f"{exc.code}: {detail}") from exc
        if raw and response.headers.get_content_type() != "application/json":
            return raw.decode("utf-8", errors="replace")  # downloads: netlist, CSV
        return json.loads(raw) if raw else None

    def _alive(self) -> bool:
        if self.session is None:
            return False
        try:
            self._request("GET", "/api/ping")
        except (OSError, BackendError):
            return False
        return True

    def ensure(self) -> None:
        if self._alive():
            return
        self.session = read_session()
        if self._alive():
            return
        subprocess.Popen(
            [sys.executable, "-m", "bpt.cli", "serve"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        deadline = time.monotonic() + _START_TIMEOUT_S
        while time.monotonic() < deadline:
            time.sleep(0.25)
            self.session = read_session()
            if self._alive():
                return
        raise BackendError("could not start the BiasPoint backend")

    def call(self, method: str, path: str, body: Any = None) -> Any:
        self.ensure()
        return self._request(method, path, body)

    def project(self) -> str:
        """Current project id; falls back to the only open project."""
        if self.project_id is not None:
            return self.project_id
        projects = self.call("GET", "/api/projects")
        if len(projects) == 1:
            self.project_id = projects[0]["id"]
            return self.project_id
        raise BackendError("no current project: call project_new or project_open first")


backend = Backend()
mcp = MCPServer(name="biaspoint", version=__version__, instructions=INSTRUCTIONS)


def _p(path: str) -> str:
    return f"/api/projects/{backend.project()}{path}"


def _erc_line() -> str:
    text: str = backend.call("GET", _p("/circuit/describe"))["text"]
    return "\n".join(line for line in text.splitlines() if line.startswith(("ERC", "  ")))


@mcp.tool()
def project_new(name: str = "untitled") -> str:
    """Create a new empty project and make it current."""
    info = backend.call("POST", "/api/projects", {"name": name})
    backend.project_id = info["id"]
    return f"project {name!r} created (id {info['id']})"


@mcp.tool()
def project_open(path: str) -> str:
    """Open a project directory (*.bpt) and make it current."""
    info = backend.call("POST", "/api/projects/open", {"path": path})
    backend.project_id = info["id"]
    return f"opened {info['name']!r} (rev {info['revision']})"


@mcp.tool()
def project_save(path: str | None = None) -> str:
    """Save the current project (path required the first time, e.g. C:/work/amp.bpt)."""
    info = backend.call("POST", _p("/save"), {"path": path})
    return f"saved to {info['path']}"


@mcp.tool()
def project_list() -> str:
    """List open projects; the current one is marked with *."""
    projects = backend.call("GET", "/api/projects")
    if not projects:
        return "no open projects"
    return "\n".join(
        f"{'*' if p['id'] == backend.project_id else ' '} {p['name']} id={p['id']} "
        f"rev={p['revision']}{' unsaved' if p['dirty'] else ''} {p['path'] or ''}"
        for p in projects
    )


@mcp.tool()
def circuit_describe() -> str:
    """Current circuit as a compact netlist (refs, nets, values, models) plus ERC results."""
    text: str = backend.call("GET", _p("/circuit/describe"))["text"]
    return text


@mcp.tool()
def circuit_from_netlist(netlist: str, has_title: bool = False) -> str:
    """Add components from SPICE lines, e.g. "V1 in 0 DC 5\\nR1 in out 1k\\nC1 out 0 1u".

    Supports R C L V I E F G H B D Q M J S and .model/.param; analysis cards are reported
    back (run them with analysis_run). Components are placed automatically and joined by
    net labels.
    """
    result = backend.call("POST", _p("/circuit/import"), {"text": netlist, "has_title": has_title})
    analyses = ", ".join(a["kind"] for a in result["analyses"]) or "none"
    return f"added {', '.join(result['refs'])}; analyses in netlist: {analyses}\n{_erc_line()}"


@mcp.tool()
def component_add(
    symbol: str,
    nets: list[str],
    ref: str | None = None,
    params: dict[str, str] | None = None,
    model: str | None = None,
) -> str:
    """Add one component connected to the given nets ("0" = ground).

    symbol: resistor, capacitor, inductor, diode, led, zener, vsource, isource, bsource,
    vcvs, vccs, cccs, ccvs, npn, pnp, nmos, pmos, njfet, pjfet, switch, opamp_ideal.
    nets follow the pin order: two-terminals (1/+/A, 2/-/K), npn/pnp (C, B, E),
    mos/jfet (D, G, S), vcvs/vccs (out+, out-, in+, in-), switch (1, 2, ctrl+, ctrl-),
    opamp_ideal (+, -, out).
    params: resistor {"R": "10k"}, capacitor {"C": "100n"}, inductor {"L": "1m"},
    sources {"dc": "5", "ac": "1", "tran": "SIN(0 1 1k)"}, vcvs {"gain": "10"},
    bsource {"v": "V(a)*2"}.
    """
    body = {"symbol": symbol, "nets": nets, "ref": ref, "params": params or {}, "model": model}
    result = backend.call("POST", _p("/circuit/components"), body)
    return f"added {result['ref']}\n{_erc_line()}"


@mcp.tool()
def component_set(
    ref: str,
    params: dict[str, str | None] | None = None,
    model: str | None = None,
    ratings: dict[str, str] | None = None,
) -> str:
    """Change parameters (None deletes one), the model and/or the ratings of a component.

    ``ratings`` (stress analysis, replaced as a whole): voltage (V), current (A RMS), power (W),
    isat (A), tj_max (°C), rth (K/W), e.g. {"power": "0.25"}; check with stress_report.
    """
    body = {"params": params or {}, "model": model, "ratings": ratings}
    backend.call("PATCH", _p(f"/circuit/components/{ref}"), body)
    return f"updated {ref}"


@mcp.tool()
def component_remove(ref: str) -> str:
    """Remove a component together with its wire stubs and labels."""
    backend.call("DELETE", _p(f"/circuit/components/{ref}"))
    return f"removed {ref}\n{_erc_line()}"


@mcp.tool()
def block_create(refs: list[str], name: str, sheet: str = "root") -> str:
    """Move parts (by ref) to a new sheet and put a block of it in their place (hierarchy).

    Nets joining them to the rest become ports; signals inside are then named V(X1.<net>).
    Block parameters: component_set on the block with params defined on its sheet.
    """
    document = backend.call("GET", _p("/document"))
    try:
        parts = next(s for s in document["project"]["sheets"] if s["name"] == sheet)["instances"]
    except StopIteration:
        return f"no sheet {sheet!r}"
    ids = [i["id"] for i in parts if i["ref"] in set(refs)]
    missing = sorted(set(refs) - {i["ref"] for i in parts})
    if missing:
        return f"not on sheet {sheet}: {', '.join(missing)}"
    result = backend.call("POST", _p("/blocks"), {"sheet": sheet, "ids": ids, "name": name})
    ports = ", ".join(result["ports"]) or "none"
    return f"block {result['ref']} = sheet {name!r}, ports: {ports}\n{_erc_line()}"


@mcp.tool()
def connect(a: str, b: str) -> str:
    """Connect two pins given as REF.PIN, e.g. connect("R1.2", "C1.1") or ("Q1.B", "R2.1")."""
    backend.call("POST", _p("/circuit/connect"), {"a": a, "b": b})
    return f"connected {a} - {b}\n{_erc_line()}"


@mcp.tool()
def erc_run() -> str:
    """Electrical rules check of the current circuit."""
    return _erc_line()


@mcp.tool()
def undo() -> str:
    """Undo the last change to the current project."""
    info = backend.call("POST", _p("/undo"))
    return f"undone (rev {info['revision']})"


@mcp.tool()
def redo() -> str:
    """Redo the last undone change of the current project."""
    info = backend.call("POST", _p("/redo"))
    return f"redone (rev {info['revision']})"


def _command(command: dict[str, Any]) -> int:
    revision: int = backend.call("POST", _p("/commands"), {"command": command})["revision"]
    return revision


@mcp.tool()
def snapshot_list() -> str:
    """Snapshots of the current project (one is taken before each change set of an agent)."""
    import datetime as dt

    shots = backend.call("GET", _p("/snapshots"))
    if not shots:
        return "no snapshots"
    return "\n".join(
        f"{s['id']}  {dt.datetime.fromtimestamp(s['created']).strftime('%Y-%m-%d %H:%M:%S')}  "
        f"rev {s['revision']}  {s['origin']}: {s['label']}"
        for s in shots[:30]
    )


@mcp.tool()
def snapshot_take(label: str = "") -> str:
    """Save a snapshot of the current project (to come back to with snapshot_restore)."""
    info = backend.call("POST", _p("/snapshots"), {"label": label})
    return f"snapshot {info['id']} ({info['label']})"


@mcp.tool()
def snapshot_restore(snapshot_id: str) -> str:
    """Go back to a snapshot; one undo brings the state before it back."""
    info = backend.call("POST", _p(f"/snapshots/{snapshot_id}/restore"))
    return f"restored (rev {info['revision']}); undo returns to the state before"


def _document() -> dict[str, Any]:
    project: dict[str, Any] = backend.call("GET", _p("/document"))["project"]
    return project


@mcp.tool()
def sheet_list() -> str:
    """Sheets of the current project with their parts count, ports and parameters."""
    lines = []
    for sheet in _document()["sheets"]:
        if sheet.get("owner"):
            continue  # inside a library component: read-only, shown with the component
        ports = [lb["text"] for lb in sheet["labels"] if lb["kind"] == "port"]
        params = ", ".join(f"{k}={v}" for k, v in sheet.get("parameters", {}).items())
        lines.append(f"{sheet['name']}: {len(sheet['instances'])} parts"
                     + (f", ports {' '.join(ports)}" if ports else "")
                     + (f", parameters {params}" if params else ""))  # fmt: skip
    return "\n".join(lines)


@mcp.tool()
def sheet_add(name: str, parameters: dict[str, str] | None = None) -> str:
    """Add an empty sheet (a page, or a block once it has port labels)."""
    rev = _command({"type": "add_sheet", "sheet": {"name": name, "parameters": parameters or {}}})
    return f"sheet {name} added (rev {rev})"


@mcp.tool()
def sheet_rename(name: str, new_name: str) -> str:
    """Rename a sheet; blocks placed from it follow."""
    rev = _command({"type": "rename_sheet", "name": name, "new_name": new_name})
    return f"sheet {name} is now {new_name} (rev {rev})"


@mcp.tool()
def param_set(name: str, value: str | None) -> str:
    """Set a project parameter (.param, used in values as {name}); None removes it."""
    rev = _command({"type": "set_parameter", "name": name, "value": value})
    return f"{name} = {value} (rev {rev})" if value is not None else f"{name} removed (rev {rev})"


@mcp.tool()
def export_netlist(path: str | None = None, max_lines: int = 80) -> str:
    """The SPICE netlist ngspice gets; written to ``path`` when given, else returned (cut
    after ``max_lines``)."""
    text: str = backend.call("GET", _p("/export/netlist"))
    if path:
        Path(path).expanduser().write_text(text, encoding="utf-8")
        return f"wrote {path} ({len(text.splitlines())} lines)"
    lines = text.splitlines()
    more = f"\n… {len(lines) - max_lines} more lines" if len(lines) > max_lines else ""
    return "\n".join(lines[:max_lines]) + more


@mcp.tool()
def export_bom(path: str | None = None) -> str:
    """Bill of materials: quantity, references, value, part, manufacturer, part number. CSV
    written to ``path`` when given; the summary is returned either way."""
    text: str = backend.call("GET", _p("/export/bom"))
    if path:
        Path(path).expanduser().write_text(text, encoding="utf-8")
    rows = text.splitlines()[1:]
    head = "\n".join(rows[:40]) + (f"\n… {len(rows) - 40} more rows" if len(rows) > 40 else "")
    return (f"wrote {path}\n" if path else "") + f"{len(rows)} BOM rows\n{head}"


@mcp.tool()
def template_list() -> str:
    """Equivalent-circuit templates a component can be made from (built-in passives, the
    standard library's diodes / transistors / ICs, user templates) with their fields."""
    lines = []
    for t in backend.call("GET", "/api/components/templates"):
        fields = ", ".join(f"{f['key']}" + (f" [{f['unit']}]" if f["unit"] else "")
                           for f in t["fields"])  # fmt: skip
        lines.append(f"{t['name']} ({t['kind']}, pins {' '.join(t['ports'])}): {fields}")
    return "\n".join(lines)


@mcp.tool()
def component_create(
    template: str,
    name: str,
    form: dict[str, str] | None = None,
    library: str = "My parts",
    description: str = "",
    metadata: dict[str, str] | None = None,
    ratings: dict[str, str] | None = None,
) -> str:
    """Save a library component made from a template (see template_list) with the form's
    values; place it with component_add(symbol=<returned id>)."""
    body = {"template": template, "form": form or {}, "library": library, "name": name,
            "description": description, "metadata": metadata or {},
            "ratings": ratings or {}}  # fmt: skip
    component = backend.call("POST", "/api/components/from-template", body)
    return f"saved {component['id']} ({component['kind']}); place it with component_add"


def _curve_line(curve: dict[str, Any]) -> str:
    from bpt.units import format_value

    x, y = curve["x"], curve["y"]
    if not x:
        return f"{curve['name']}: empty"
    lo, hi = min(y), max(y)
    i_lo = y.index(lo)
    label = f" {curve['label']}" if curve.get("label") else ""
    return (f"{curve['name']}{label}: x {format_value(x[0], curve['x_unit'], 3)} … "
            f"{format_value(x[-1], curve['x_unit'], 3)}, y {format_value(lo, curve['y_unit'], 3)}"
            f" (at {format_value(x[i_lo], curve['x_unit'], 3)}) … "
            f"{format_value(hi, curve['y_unit'], 3)}")  # fmt: skip


@mcp.tool()
def component_info(component: str) -> str:
    """A library component (id "cmp:<library>/<name>"): kind, metadata, ratings, the
    equivalent circuit's values and its characteristics in short (computed by simulation)."""
    info = backend.call("GET", "/api/library/components").get(component)
    if info is None:
        return f"no component {component}"
    card = backend.call("POST", "/api/components/card", {"component": component})
    lines = [f"{info['name']} ({info['kind']}) {info.get('description', '')}".rstrip()]
    for key in ("metadata", "ratings"):
        if info.get(key):
            lines.append(f"{key}: " + ", ".join(f"{k}={v}" for k, v in info[key].items()))
    if card.get("parameters"):
        labels = card.get("labels", {})
        lines.append("values: " + ", ".join(f"{labels.get(k, k)}={v}"
                                            for k, v in card["parameters"].items()))  # fmt: skip
    lines += [_curve_line(c) for c in card["curves"]]
    lines += [f"note: {n}" for n in card["notes"]]
    return "\n".join(lines)


@mcp.tool()
def component_fit(
    template: str,
    points: dict[str, list[list[float]]],
    free: list[str],
    form: dict[str, str] | None = None,
    bounds: dict[str, list[str]] | None = None,
) -> str:
    """Fit template fields ``free`` to characteristic points, e.g. points={"|Z|(f)": [[1e3,
    15.9], [1e5, 0.2]]}; names: |Z|(f), phase(f), ESR(f), C(V), L(I). A third number in a point
    is its weight (0 = ignore it). ``bounds``: field -> [min, max] ("" = open), e.g.
    {"esr": ["", "20m"]}. Returns the fitted values (pass them as ``form`` to
    component_create), the RMS error and the worst point."""
    chars = []
    for name, pts in points.items():
        weights = [pt[2] if len(pt) > 2 else 1.0 for pt in pts]
        chars.append({"name": name, "points": [pt[:2] for pt in pts],
                      "weights": weights if any(len(pt) > 2 for pt in pts) else []})  # fmt: skip
    limits = {k: [v[0], v[1]] for k, v in (bounds or {}).items()}
    body = {"template": template, "form": form or {}, "free": free, "characteristics": chars,
            "bounds": limits}  # fmt: skip
    result = backend.call("POST", "/api/components/templates/fit", body)
    values = ", ".join(f"{k}={v}" for k, v in result["values"].items())
    return (f"{values}\nRMS error {result['error']:.2f} %, worst point "
            f"{result['max_error']:.1f} %, after {result['iterations']} steps")  # fmt: skip


@mcp.tool()
def analysis_run(card: str, signals: list[str] | None = None) -> str:
    """Run an analysis given as a SPICE card and wait for it; returns a compact summary.

    Examples: ".op", ".tran 10u 5m", ".ac dec 20 10 1meg", ".dc V1 0 5 0.1".
    signals limits the summary, e.g. ["V(out)", "I(V1)"].
    """
    try:
        analysis = parse_analysis_card(card)
    except SpiceSyntaxError as exc:
        return f"error: {exc}"
    job = backend.call("POST", _p("/analyses/run"), {"analysis": analysis.model_dump()})
    deadline = time.monotonic() + _JOB_TIMEOUT_S
    while job["status"] in ("queued", "running") and time.monotonic() < deadline:
        time.sleep(0.05)
        job = backend.call("GET", f"/api/jobs/{job['job_id']}")
    if job["status"] != "ok":
        issues = "\n".join(f"  {i['severity']}: {i['message']}" for i in job["issues"])
        return f"{job['status']}: {job['error']}\n{issues}".rstrip()
    query = _signals_query(signals)
    summary = backend.call("GET", f"/api/runs/{job['run_id']}/summary{query}")["text"]
    return f"run_id {job['run_id']}\n{summary}"


def _signals_query(signals: list[str] | None) -> str:
    """``?signals=...`` with the names encoded: ``V(V+)`` sent raw arrived as ``V(V )``."""
    from urllib.parse import quote

    return f"?signals={quote(','.join(signals), safe=',()')}" if signals else ""


@mcp.tool()
def stress_report(run_id: str) -> str:
    """Parts' ratings checked against an operating point or transient run (FR-SIM-7): each
    rating's use in percent of the rating; "over" = exceeded, "margin" = beyond the project's
    safety margin. Set ratings with component_set(..., ratings) or in Properties."""
    report = backend.call("GET", _p(f"/runs/{run_id}/stress"))
    items = sorted(report["items"], key=lambda i: -i["usage"])
    if not items:
        notes = "; ".join(report["notes"]) or "no part has ratings"
        return f"no ratings checked ({notes})"
    over = sum(i["status"] == "over" for i in items)
    margin = sum(i["status"] == "margin" for i in items)
    verdict = "FAIL" if over else "WARN" if margin else "PASS"
    lines = [f"{verdict}: {over} over, {margin} without margin, {len(items)} ratings checked"]
    lines += [f"  {i['status']:6} {i['message']}" for i in items[:20]]
    return "\n".join(lines + [f"  note: {n}" for n in report["notes"][:5]])


@mcp.tool()
def result_summary(run_id: str, signals: list[str] | None = None) -> str:
    """Summary of a finished run (min/max/final, AC peaks in dB, operating point values)."""
    query = _signals_query(signals)
    text: str = backend.call("GET", f"/api/runs/{run_id}/summary{query}")["text"]
    return text


@mcp.tool()
def result_measure(
    run_id: str, signal: str, op: str = "final", at: float | None = None, db: bool = False
) -> str:
    """One number from a run. op: value | final | at (needs at=x) | min | max | avg | rms | pp.

    AC signals return magnitude (or dB with db=True) and phase.
    """
    m = backend.call("POST", f"/api/runs/{run_id}/measure",
                     {"signal": signal, "op": op, "at": at, "db": db})  # fmt: skip
    phase = f", phase {m['phase_deg']:.3g} deg" if m["phase_deg"] is not None else ""
    return f"{signal} {op}{'' if at is None else f'@{at:g}'} = {m['value']:.6g} {m['unit']}{phase}"


@mcp.tool()
def result_waveform(
    run_id: str,
    signal: str,
    max_points: int = 100,
    x_min: float | None = None,
    x_max: float | None = None,
) -> str:
    """A signal as a small text table (decimated: min/max per bucket); keep max_points low."""
    data = backend.call("POST", f"/api/runs/{run_id}/query", {
        "signals": [signal], "pixels": max(1, max_points // 2), "x_min": x_min, "x_max": x_max,
    })  # fmt: skip
    series, xs = data["series"][signal], data["x"]
    if "re" in series:
        rows = [f"{x:.6g} {complex(r, i):.4g}" for x, r, i in
                zip(xs, series["re"], series["im"], strict=True)][:max_points]  # fmt: skip
        return "x re+im\n" + "\n".join(rows)
    rows = [
        f"{x:.6g} {lo:.6g}" if lo == hi else f"{x:.6g} {lo:.6g}..{hi:.6g}"
        for x, lo, hi in zip(xs, series["min"], series["max"], strict=True)
    ]
    return "x value(min..max)\n" + "\n".join(rows)


@mcp.tool()
def result_export(run_id: str, path: str, signals: list[str] | None = None) -> str:
    """Export a run to CSV (AC as dB + degrees)."""
    result = backend.call("POST", f"/api/runs/{run_id}/export", {"path": path, "signals": signals})
    text: str = result["text"]
    return text


def _image(response: dict[str, Any]) -> Image:
    fmt = response["mime"].split("/")[-1]
    return Image(data=base64.b64decode(response["image"]), format=fmt)


@mcp.tool()
def capture_view(target: str = "schematic", max_px: int = 1024) -> list[Image | str]:
    """Picture of the circuit plus a short text description.

    With the GUI open it is drawn exactly as the user sees it; otherwise the backend renders it.
    target: schematic (whole sheet) | sheet:<name> | selection | refs:R1,C2 (frame around parts)
    | plot (the waveform viewer; without the GUI the latest run, or plot:<run_id>:V(out),V(in))
    | graph (the analysis graph, GUI only) | window (everything the user sees).
    Use it to judge layout, readability or what the user is looking at; read the circuit
    structure with circuit_describe instead (cheaper). Keep max_px small (512-1024).
    """
    response = backend.call(
        "POST",
        "/api/capture",
        {"project_id": backend.project(), "target": target, "max_px": max_px},
    )
    return [_image(response), response["description"]]


@mcp.tool()
def capture_inbox() -> str:
    """Screenshots the user sent to the agent that were not read yet (id, comment)."""
    items = backend.call("GET", _p("/captures?unread=true"))
    if not items:
        return "inbox empty"
    return "\n".join(f"{c['id']} {c['created'][:19]} {c['comment']!r}" for c in items)


@mcp.tool()
def capture_get(capture_id: str) -> list[Image | str]:
    """One stored capture (image + description + the user's comment)."""
    response = backend.call("GET", _p(f"/captures/{capture_id}"))
    comment = f"\nuser comment: {response['comment']}" if response["comment"] else ""
    text = response["description"] + comment
    return [_image(response), text]


# -- analysis graphs (node.md) ---------------------------------------------------------------


def _graphs() -> list[Graph]:
    document = backend.call("GET", _p("/document"))
    return [Graph.model_validate(g) for g in document["project"].get("graphs", [])]


def _graph(name: str) -> Graph:
    for graph in _graphs():
        if graph.name == name:
            return graph
    raise BackendError(f"no graph {name!r}; graph_describe lists them")


def _save_graph(graph: Graph) -> None:
    command = {"type": "set_graph", "name": graph.name, "graph": graph.model_dump(mode="json")}
    backend.call("POST", _p("/commands"), {"command": command})


def _states(name: str) -> dict[str, NodeState]:
    results = backend.call("GET", _p(f"/graphs/{quote(name)}/results"))
    return {k: NodeState.model_validate(v) for k, v in results["nodes"].items()}


@mcp.tool()
def graph_nodes() -> str:
    """Catalog of analysis-graph node types: sockets (name:type), parameters and defaults."""
    return catalog_text()


@mcp.tool()
def graph_describe(name: str | None = None) -> str:
    """List the project's analysis graphs, or describe one (nodes, params, links, last results)."""
    if name is None:
        graphs = _graphs()
        return "\n".join(f"{g.name}: {len(g.nodes)} nodes" for g in graphs) or "no graphs yet"
    return graph_text(_graph(name), _states(name))


@mcp.tool()
def graph_create(
    name: str, nodes: list[dict[str, Any]], links: list[list[str]], replace: bool = False
) -> str:
    """Create (or with replace=True overwrite) an analysis graph; nodes are placed automatically.

    nodes: [{"id": "tran", "type": "sim/tran", "params": {"stop": "5 ms", "step": "1 µs"}}, ...]
    links: [["circuit.circuit", "tran.circuit"], ["tran.run", "sig.run"], ...] (output -> input)
    See graph_nodes for types. Typical chain: core/circuit -> sim/* -> core/signal ->
    math/expr / measure/basic -> view/plot / view/value / view/table. Then call graph_run.
    """
    if not replace and any(g.name == name for g in _graphs()):
        return f"error: graph {name!r} exists; pass replace=True or use graph_edit"
    try:
        graph = Graph(name=name, nodes=[GraphNode.model_validate(n) for n in nodes])
        unknown = [n.type for n in graph.nodes if n.type not in CATALOG]
        if unknown:
            return f"error: unknown node types {unknown}; see graph_nodes"
        graph.edges = [make_edge(graph, a, b) for a, b in links]
    except (ValueError, ValidationError) as exc:
        return f"error: {exc}"
    _save_graph(auto_layout(graph))
    size = f"{len(graph.nodes)} nodes, {len(graph.edges)} links"
    return f"graph {name!r} saved ({size}); run it with graph_run"


@mcp.tool()
def graph_edit(
    name: str,
    set_params: dict[str, dict[str, Any]] | None = None,
    add_nodes: list[dict[str, Any]] | None = None,
    remove_nodes: list[str] | None = None,
    add_links: list[list[str]] | None = None,
    remove_links: list[list[str]] | None = None,
) -> str:
    """Change a graph in one undo step.

    set_params: {"tran": {"stop": "20 ms"}}; add_nodes like graph_create; links as
    ["node.output", "node.input"]. A single input keeps only its newest link.
    """
    graph = _graph(name)
    try:
        for node_id, params in (set_params or {}).items():
            node = next((n for n in graph.nodes if n.id == node_id), None)
            if node is None:
                return f"error: no node {node_id!r}"
            node.params = {**node.params, **params}
        removed = set(remove_nodes or [])
        graph.nodes = [n for n in graph.nodes if n.id not in removed]
        graph.edges = [
            e for e in graph.edges if e.source not in removed and e.target not in removed
        ]
        new_nodes = [GraphNode.model_validate(n) for n in add_nodes or []]
        right = max((n.pos[0] for n in graph.nodes), default=0.0)
        for i, node in enumerate(new_nodes):
            if node.type not in CATALOG:
                return f"error: unknown node type {node.type!r}"
            node.pos = (right + COLUMN, i * ROW)
        graph.nodes += new_nodes
        drop = {tuple(parse_link(a) + parse_link(b)) for a, b in remove_links or []}
        graph.edges = [
            e for e in graph.edges if (e.source, e.output, e.target, e.input) not in drop
        ]
        for a, b in add_links or []:
            edge = make_edge(graph, a, b)
            multi = any(s.name == edge.input and s.multi
                        for n in graph.nodes if n.id == edge.target
                        for s in CATALOG[n.type].info.inputs)  # fmt: skip
            if not multi:
                graph.edges = [
                    e for e in graph.edges if (e.target, e.input) != (edge.target, edge.input)
                ]
            graph.edges.append(edge)
    except (ValueError, ValidationError) as exc:
        return f"error: {exc}"
    _save_graph(graph)
    return graph_text(graph)


@mcp.tool()
def graph_run(name: str) -> str:
    """Run a graph and wait; returns each node's state and result summary (numbers, ranges).

    Unchanged parts come from the cache, so re-running after a small edit is cheap.
    """
    backend.call("POST", _p(f"/graphs/{quote(name)}/run"))
    deadline = time.monotonic() + _JOB_TIMEOUT_S
    while time.monotonic() < deadline:
        time.sleep(0.1)
        if backend.call("GET", _p(f"/graphs/{quote(name)}/results"))["status"] != "running":
            break
    return graph_text(_graph(name), _states(name))


def main() -> None:
    mcp.run("stdio")


if __name__ == "__main__":
    main()
