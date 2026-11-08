"""Node types of analysis graphs (node.md §4, stage N1).

A node type declares typed sockets and parameters (widgets) and a ``run`` function that maps
input values and parameters to output values. Types: ``circuit``, ``params``, ``run``,
``signal``, ``scalar``; ``value`` accepts a signal or a scalar.
"""

import fnmatch
import hashlib
import re
from collections.abc import Callable
from contextvars import ContextVar
from dataclasses import dataclass, field, replace
from typing import Any, Literal, Protocol

import numpy as np
from pydantic import BaseModel

from bpt.analysis.spec import AcAnalysis, AnalysisSpec, DcAnalysis, OpAnalysis, TranAnalysis
from bpt.document.model import Directive, Graph, Project
from bpt.library.blocks import project_symbols
from bpt.netlist.netlister import netlist_project
from bpt.netlist.ngspice_writer import write_netlist
from bpt.results.calculator import ExpressionError, evaluate, evaluate_with, is_plain_signal
from bpt.results.store import RunReader
from bpt.units import (
    InvalidValueError,
    format_value,
    is_expression,
    parse_quantity,
    parse_value,
    to_spice,
)

from . import dsp
from .values import (
    CircuitValue,
    FamilyValue,
    ParamsValue,
    RunValue,
    ScalarValue,
    SignalValue,
    TableValue,
    Value,
    leaf,
)

SocketType = Literal["circuit", "params", "run", "signal", "scalar", "value", "table"]
ParamKind = Literal["text", "quantity", "choice", "choices", "int", "bool", "expr"]


class NodeError(Exception):
    """A node cannot produce its outputs (shown on the node; the rest of the graph runs)."""


class Context(Protocol):
    project: Project

    def simulate(self, project: Project, analysis: AnalysisSpec) -> RunReader: ...

    def open_run(self, run_id: str) -> RunReader: ...


class Socket(BaseModel):
    name: str
    type: SocketType
    label: str = ""
    multi: bool = False  # accepts several edges (plot traces, table rows)
    optional: bool = False


class Param(BaseModel):
    name: str
    kind: ParamKind
    label: str = ""
    default: str | float | bool = ""
    unit: str = ""
    options: list[str] = []
    placeholder: str = ""
    advanced: bool = False  # shown in the inspector only (the card stays short)


class DynamicOutputs(BaseModel):
    """Outputs made from a parameter: one per item of a "choices" parameter (comma-separated),
    named by the item, after the first ``skip`` items (those have static outputs)."""

    param: str
    type: SocketType
    skip: int = 0


class NodeTypeInfo(BaseModel):
    """What the editor needs to draw a node and its widgets."""

    type: str
    title: str
    category: str
    description: str
    inputs: list[Socket]
    outputs: list[Socket]
    params: list[Param]
    view: Literal["", "plot", "value", "table", "histogram", "spec", "equation"] = ""
    version: int = 1  # of its parameters (a new node is made at it)
    dynamic_outputs: DynamicOutputs | None = None


Inputs = dict[str, Any]  # single value, or a list for multi sockets
Params = dict[str, Any]
Runner = Callable[[Context, Inputs, Params], dict[str, Value]]


ParamMigration = Callable[[dict[str, Any]], dict[str, Any]]


@dataclass
class NodeType:
    info: NodeTypeInfo
    run: Runner
    version: int = 1
    families: bool = False  # handles FamilyValue inputs itself (views); others are broadcast
    # From version N to N+1: a node's parameters as the next version names them.
    migrations: dict[int, ParamMigration] = field(default_factory=dict)


def upgrade(graph: Graph) -> list[str]:
    """Nodes made by older versions of their types brought to the current ones (in place);
    notes of what was changed."""
    notes: list[str] = []
    for n in graph.nodes:
        node_type = CATALOG.get(n.type)
        if node_type is None or n.version >= node_type.version:
            continue
        params = dict(n.params)
        for v in range(n.version, node_type.version):
            step = node_type.migrations.get(v)
            if step is not None:
                params = step(params)
        notes.append(f"{n.id}: {n.type} {n.version} -> {node_type.version}")
        n.params = params
        n.version = node_type.version
    return notes


CATALOG: dict[str, NodeType] = {}

# Remarks of the node being run ("rise: no complete edge" while the other measures worked):
# shown with its state. Set by the executor around each run.
NOTES: ContextVar[list[str] | None] = ContextVar("NOTES", default=None)


def note(text: str) -> None:
    notes = NOTES.get()
    if notes is not None and text not in notes:
        notes.append(text)


def choices(text: str) -> list[str]:
    """Items of a "choices" parameter ("avg, max" -> ["avg", "max"])."""
    return [t.strip() for t in str(text).split(",") if t.strip()]


NUMERIC_KINDS = ("quantity", "int", "text")  # parameters a number can set (widget -> input)


def input_sockets(node_type: NodeType, param_inputs: list[str]) -> list[Socket]:
    """A node's inputs: its type's, and its parameters turned into ``scalar`` sockets."""
    sockets = list(node_type.info.inputs)
    taken = {s.name for s in sockets}
    for p in node_type.info.params:
        if p.name in param_inputs and p.kind in NUMERIC_KINDS and p.name not in taken:
            sockets.append(Socket(name=p.name, type="scalar", label=p.label or p.name))
    return sockets


def param_from_input(node_type: NodeType, name: str, value: Any) -> str | int:
    """The parameter text a number from an input stands for ("10 ms" -> "0.01")."""
    if not isinstance(value, ScalarValue):
        raise NodeError(f"{name} takes a number")
    kind = next((p.kind for p in node_type.info.params if p.name == name), "text")
    return round(value.value) if kind == "int" else repr(float(value.value))


def output_sockets(node_type: NodeType, params: dict[str, Any]) -> list[Socket]:
    """A node's outputs: its type's, and those made from its parameters (dynamic outputs)."""
    sockets = list(node_type.info.outputs)
    dynamic = node_type.info.dynamic_outputs
    if dynamic is not None:
        default = next((p.default for p in node_type.info.params if p.name == dynamic.param), "")
        items = choices(str(params.get(dynamic.param, default)))[dynamic.skip :]
        sockets += [Socket(name=item, type=dynamic.type, label=item) for item in items]
    return sockets


def node(
    type_: str,
    title: str,
    category: str,
    description: str,
    inputs: list[Socket] | None = None,
    outputs: list[Socket] | None = None,
    params: list[Param] | None = None,
    view: Literal["", "plot", "value", "table", "histogram", "spec", "equation"] = "",
    version: int = 1,
    migrations: dict[int, ParamMigration] | None = None,
    families: bool | None = None,  # takes families whole (views: yes, unless False)
    dynamic_outputs: DynamicOutputs | None = None,
) -> Callable[[Runner], Runner]:
    def register(run: Runner) -> Runner:
        info = NodeTypeInfo(
            type=type_,
            title=title,
            category=category,
            description=description,
            inputs=inputs or [],
            outputs=outputs or [],
            params=params or [],
            view=view,
            version=version,
            dynamic_outputs=dynamic_outputs,
        )
        whole = bool(view) if families is None else families
        CATALOG[type_] = NodeType(info=info, run=run, families=whole,
                                  version=version,
                                  migrations=dict(migrations or {}))  # fmt: skip
        return run

    return register


def param_values(node_type: NodeType, given: dict[str, Any]) -> Params:
    return {p.name: given.get(p.name, p.default) for p in node_type.info.params}


def _quantity(params: Params, name: str, unit: str) -> str:
    """SPICE text of a quantity widget ("10 ms" -> "10m"); expressions pass through."""
    text = str(params.get(name, "")).strip()
    if not text:
        raise NodeError(f"{name} is empty")
    if is_expression(text):
        return text
    try:
        return to_spice(parse_quantity(text, unit))
    except InvalidValueError as exc:
        raise NodeError(f"{name}: {exc}") from exc


# -- circuit and parameters ------------------------------------------------------------------


def circuit_key(project: Project) -> str:
    result = netlist_project(project.model_copy(deep=True))
    lines = write_netlist(result.circuit)[1:]  # without the title (project name)
    return hashlib.sha256("\n".join(lines).encode()).hexdigest()[:16]


@node(
    "core/circuit",
    "Circuit",
    "Input",
    "The project's schematic (all sheets). Moving parts does not trigger a new simulation; "
    "changing values does.",
    outputs=[Socket(name="circuit", type="circuit", label="circuit")],
)
def _circuit(ctx: Context, inputs: Inputs, params: Params) -> dict[str, Value]:
    project = ctx.project.model_copy(deep=True)
    return {"circuit": CircuitValue(project=project, key=circuit_key(project))}


@node(
    "core/param",
    "Parameter",
    "Input",
    "Sets a .param value (e.g. Rload = 2k) or a part's value (C1 = 10n) for the simulations "
    "it feeds. Chain several.",
    inputs=[Socket(name="params", type="params", label="params", optional=True)],
    outputs=[Socket(name="params", type="params", label="params")],
    params=[
        Param(name="name", kind="text", label="Name", default="R", placeholder="Rload"),
        Param(name="value", kind="text", label="Value", default="1k", placeholder="2k"),
    ],
)
def _param(ctx: Context, inputs: Inputs, params: Params) -> dict[str, Value]:
    name = str(params["name"]).strip()
    if not re.fullmatch(r"[A-Za-z_]\w*", name):
        raise NodeError(f"invalid parameter name {name!r}")
    previous: ParamsValue | None = inputs.get("params")
    values = dict(previous.values) if previous else {}
    values[name] = str(params["value"]).strip()
    return {"params": ParamsValue(values=values)}


def sweep_values(text: str) -> list[str]:
    """ "1k 2k 5k", "lin 1k 10k 5" (5 points) or "dec 10 1meg 2" (2 points per decade)."""
    words = text.replace(",", " ").split()
    if not words:
        raise NodeError("values are empty")
    mode = words[0].lower()
    tolerance = re.fullmatch(r"(\S+)\s*(?:±|\+-|\+/-)\s*([\d.]+)\s*%", text.strip())
    if tolerance:  # "1k ±5%": the corners min, nominal, max
        try:
            nominal, pct = parse_quantity(tolerance[1]), float(tolerance[2]) / 100
        except (InvalidValueError, ValueError) as exc:
            raise NodeError(f"tolerance: {exc}") from exc
        return [to_spice(nominal * (1 - pct), 6), tolerance[1], to_spice(nominal * (1 + pct), 6)]
    if mode in ("lin", "dec", "log"):
        if len(words) != 4:
            raise NodeError(f"{mode}: write {mode} <start> <stop> <points>")
        try:
            start, stop = parse_quantity(words[1]), parse_quantity(words[2])
            count = int(words[3])
        except (InvalidValueError, ValueError) as exc:
            raise NodeError(f"{mode}: {exc}") from exc
        if count < 1:
            raise NodeError("the number of points must be at least 1")
        if mode == "lin":
            points = np.linspace(start, stop, count) if count > 1 else np.array([start])
        else:
            if start <= 0 or stop <= 0:
                raise NodeError("a logarithmic sweep needs positive values")
            decades = np.log10(stop / start)
            n = max(2, round(decades * count) + 1) if mode == "dec" else max(2, count)
            points = np.logspace(np.log10(start), np.log10(stop), n)
        values = [to_spice(float(p), 6) for p in points]
    else:
        values = words
    if len(values) > 200:
        raise NodeError(f"{len(values)} points - at most 200 per sweep")
    return values


@node(
    "core/sweep",
    "Sweep",
    "Input",
    "Runs what follows once per value of a .param or of a part (C1, R2): a list (1k 2k 5k), "
    "lin <start> <stop> <points>, "
    "dec <start> <stop> <points per decade>, or corners 1k ±5% (min, nominal, max). The name "
    "temp sweeps the simulation temperature (°C). Plots show one curve per value, tables one row.",
    inputs=[Socket(name="params", type="params", label="params", optional=True)],
    outputs=[Socket(name="params", type="params", label="params")],
    params=[
        Param(name="name", kind="text", label="Parameter", default="R", placeholder="Rload"),
        Param(
            name="values",
            kind="text",
            label="Values",
            default="1k 2k 5k",
            placeholder="1k 2k 5k  |  lin 1 5 5  |  dec 10 1meg 3",
        ),
    ],
)
def _sweep(ctx: Context, inputs: Inputs, params: Params) -> dict[str, Value]:
    name = str(params["name"]).strip()
    if not re.fullmatch(r"[A-Za-z_]\w*", name):
        raise NodeError(f"invalid parameter name {name!r}")
    previous: ParamsValue | None = inputs.get("params")
    base = dict(previous.values) if previous else {}
    values = sweep_values(str(params["values"]))
    items: list[Value] = [ParamsValue(values={**base, name: v}) for v in values]
    return {"params": FamilyValue(param=name, values=values, items=items)}


# -- simulations -----------------------------------------------------------------------------

_SIM_INPUTS = [
    Socket(name="circuit", type="circuit", label="circuit"),
    Socket(name="params", type="params", label="params", optional=True),
]
_SIM_OUTPUTS = [Socket(name="run", type="run", label="run")]


def _uses_param(project: Project, name: str) -> bool:
    """Is ``{name}`` (or name inside an expression) used by a value, directive or parameter?"""
    pattern = re.compile(rf"\{{[^}}]*\b{re.escape(name)}\b[^}}]*\}}", re.IGNORECASE)
    texts = [*project.parameters.values()]
    for sheet in project.sheets:
        texts += [d.text for d in sheet.directives] + list(sheet.parameters.values())
        texts += [v for inst in sheet.instances for v in inst.model.params.values()]
    return (
        name in project.parameters
        or any(pattern.search(t) for t in texts)
        or any(
            re.search(rf"\.param\b.*\b{re.escape(name)}\s*=", d.text, re.IGNORECASE)
            for sheet in project.sheets
            for d in sheet.directives
        )
    )


def apply_overrides(project: Project, values: dict[str, str]) -> None:
    """Parameter values for one simulation: a .param, the temperature or a part's value.

    A name that is a part reference (C1) and no parameter in use sets that part's value, so
    sweeping "C1" changes the capacitor even when its value is not written as {C1}.
    """
    values = dict(values)
    temp = values.pop("temp", None) or values.pop("TEMP", None)
    if temp is not None and project.sheets:
        # "temp" is the simulation temperature (°C), not a .param.
        project.sheets[0].directives.append(Directive(text=f".temp {temp}", at=(0, 0)))
    symbols = project_symbols(project)
    for name, value in values.items():
        if _uses_param(project, name):
            project.parameters[name] = value
            continue
        part = next((i for s in project.sheets for i in s.instances
                     if i.ref.lower() == name.lower()), None)  # fmt: skip
        symbol = symbols.get(part.symbol) if part else None
        if part is not None and symbol is not None and symbol.value_param:
            part.model.params[symbol.value_param] = value
            continue
        raise NodeError(
            f"{name} changes nothing: no part {name} with a value and no {{{name}}} in the "
            "circuit (write a value as {" + name + "} to use it as a parameter)"
        )


def _simulate(ctx: Context, inputs: Inputs, analysis: AnalysisSpec) -> dict[str, Value]:
    circuit: CircuitValue = inputs["circuit"]
    project = circuit.project.model_copy(deep=True)
    overrides: ParamsValue | None = inputs.get("params")
    if overrides:
        apply_overrides(project, overrides.values)
    run = ctx.simulate(project, analysis)
    meta = run.meta
    if meta.status != "ok":
        raise NodeError(meta.error or f"simulation {meta.status}")
    return {
        "run": RunValue(
            run_id=meta.run_id,
            kind=analysis.kind,
            scale=meta.scale,
            signals=[s.name for s in meta.signals if s.name != meta.scale],
        )
    }


@node(
    "sim/op",
    "Operating point",
    "Simulation",
    "DC operating point (.op).",
    inputs=_SIM_INPUTS,
    outputs=_SIM_OUTPUTS,
)
def _op(ctx: Context, inputs: Inputs, params: Params) -> dict[str, Value]:
    return _simulate(ctx, inputs, OpAnalysis())


@node(
    "sim/dc",
    "DC sweep",
    "Simulation",
    "Sweeps a source (.dc).",
    inputs=_SIM_INPUTS,
    outputs=_SIM_OUTPUTS,
    params=[
        Param(name="source", kind="text", label="Source", default="V1"),
        Param(name="start", kind="quantity", label="Start", default="0"),
        Param(name="stop", kind="quantity", label="Stop", default="5"),
        Param(name="step", kind="quantity", label="Step", default="0.1"),
    ],
)
def _dc(ctx: Context, inputs: Inputs, params: Params) -> dict[str, Value]:
    source = str(params["source"]).strip()
    unit = "A" if source[:1].upper() == "I" else "V"
    spec = DcAnalysis(
        source=source,
        start=_quantity(params, "start", unit),
        stop=_quantity(params, "stop", unit),
        step=_quantity(params, "step", unit),
    )
    return _simulate(ctx, inputs, spec)


@node(
    "sim/ac",
    "AC sweep",
    "Simulation",
    "Small-signal frequency response (.ac); sources need an AC magnitude.",
    inputs=_SIM_INPUTS,
    outputs=_SIM_OUTPUTS,
    params=[
        Param(
            name="variation",
            kind="choice",
            label="Sweep",
            default="dec",
            options=["dec", "oct", "lin"],
        ),
        Param(name="points", kind="int", label="Points", default=20),
        Param(name="start", kind="quantity", label="Start", default="10 Hz", unit="Hz"),
        Param(name="stop", kind="quantity", label="Stop", default="1 MHz", unit="Hz"),
    ],
)
def _ac(ctx: Context, inputs: Inputs, params: Params) -> dict[str, Value]:
    try:
        points = int(params["points"])
    except (TypeError, ValueError) as exc:
        raise NodeError("points must be a whole number") from exc
    spec = AcAnalysis(
        variation=params["variation"],
        points=max(1, points),
        fstart=_quantity(params, "start", "Hz"),
        fstop=_quantity(params, "stop", "Hz"),
    )
    return _simulate(ctx, inputs, spec)


@node(
    "sim/tran",
    "Transient",
    "Simulation",
    "Time-domain simulation (.tran).",
    inputs=_SIM_INPUTS,
    outputs=_SIM_OUTPUTS,
    params=[
        Param(name="stop", kind="quantity", label="Stop time", default="10 ms", unit="s"),
        Param(name="step", kind="quantity", label="Time step", default="10 µs", unit="s"),
        Param(
            name="max_step",
            kind="quantity",
            label="Max step",
            default="",
            unit="s",
            placeholder="auto",
        ),
    ],
)
def _tran(ctx: Context, inputs: Inputs, params: Params) -> dict[str, Value]:
    tmax = _quantity(params, "max_step", "s") if str(params["max_step"]).strip() else None
    spec = TranAnalysis(
        tstep=_quantity(params, "step", "s"), tstop=_quantity(params, "stop", "s"), tmax=tmax
    )
    return _simulate(ctx, inputs, spec)


# -- signals and calculations ----------------------------------------------------------------


def _expr_unit(expr: str) -> str:
    text = expr.strip()
    if re.fullmatch(r"V\([^()]*\)", text, re.IGNORECASE):
        return "V"
    if re.fullmatch(r"I\([^()]*\)", text, re.IGNORECASE):
        return "A"
    if re.match(r"db\(", text, re.IGNORECASE):
        return "dB"
    if re.match(r"ph\(", text, re.IGNORECASE):
        return "°"
    return ""


@node(
    "core/signal",
    "Signal",
    "Signals",
    "Signals of a run by name (V(out), I(R1), V(a,b)) or calculator expressions, several "
    "separated by ';'. Patterns pick many: V(*), I(R*). P(R1) is the power a two-terminal part "
    "takes (V across it times I through it), Z(R1) its impedance V/I; Z(V1) is the impedance the "
    "source V1 drives (AC). Out: the first signal, and all of them as a family.",
    inputs=[Socket(name="run", type="run", label="run")],
    outputs=[
        Socket(name="signal", type="signal", label="signal"),
        Socket(name="signals", type="signal", label="all"),
    ],
    params=[
        Param(
            name="expr", kind="expr", label="Signal", default="V(out)", placeholder="V(out); I(R1)"
        ),
        Param(name="name", kind="text", label="Name", default="", placeholder="as written"),
    ],
)
def _signal(ctx: Context, inputs: Inputs, params: Params) -> dict[str, Value]:
    run_value: RunValue = inputs["run"]
    run = ctx.open_run(run_value.run_id)
    if run.meta.scale is None:
        raise NodeError("an operating point has no waveforms; use a measure on a sweep")
    items = [t.strip() for t in re.split(r"[;\n]", str(params["expr"])) if t.strip()]
    if not items:
        raise NodeError("write a signal: V(out), I(R1), P(R1)…")
    picked: list[tuple[str, str, str]] = []  # (label, expression, unit or "" to infer)
    for item in items:
        try:
            picked += _expand_signal(ctx.project, run, item)
        except NodeError as exc:
            if len(items) == 1:
                raise
            note(f"{item}: {exc}")
    signals: list[SignalValue] = []
    for label, expr, unit in picked:
        try:
            signals.append(_signal_of(run, label, expr, unit))
        except NodeError as exc:
            if len(picked) == 1:
                raise
            note(f"{label}: {exc}")
    if not signals:
        raise NodeError("none of the signals could be read")
    name = str(params.get("name") or "").strip()
    if name:
        for k, sig in enumerate(signals):
            signals[k] = replace(sig, name=name if len(signals) == 1 else f"{name}: {sig.name}")
    family: list[Value] = list(signals)
    return {
        "signal": signals[0],
        "signals": FamilyValue(param="signal", values=[sig.name for sig in signals], items=family),
    }


def _expand_signal(project: Project, run: RunReader, item: str) -> list[tuple[str, str, str]]:
    """One written item as (label, expression, unit): a probe (VP1), a pattern (V(*), I(R*),
    P(R*)), the power or impedance of a part, or the expression itself."""
    from bpt.netlist.probes import probe_signals

    probe = next((p for ref, p in probe_signals(project).items()
                  if ref.lower() == item.lower()), None)  # fmt: skip
    if probe:  # a probe by its name (VP1, IP1) stands for the signal it measures
        return [(probe.ref, probe.signal, "")]
    match = re.fullmatch(r"\s*([VIPZvipz])\s*\(\s*([^(),]+?)\s*\)\s*", item)
    if match is None:
        return [(item, item, "")]
    kind, inner = match[1].upper(), match[2]
    wild = any(c in inner for c in "*?[")
    if kind in "VI":
        if not wild:
            return [(item, item, "")]
        names = [s.name for s in run.meta.signals if s.name != run.meta.scale]
        found = [n for n in names if n.upper().startswith(f"{kind}(") and n.endswith(")")
                 and fnmatch.fnmatchcase(n[2:-1].lower(), inner.lower())]  # fmt: skip
        if not found:
            raise NodeError(f"no signal matches {item}")
        return [(n, n, "") for n in sorted(found, key=_natural)]
    devices = _two_terminal_parts(project)
    refs = sorted(
        (r for r in devices if fnmatch.fnmatchcase(r.lower(), inner.lower())), key=_natural
    )
    if not refs:
        known = next((r for r in _all_parts(project) if r.lower() == inner.lower()), None)
        if known is not None:
            raise NodeError(f"{kind}() needs a part with two terminals, {known} has more")
        raise NodeError(f"no part {inner}")
    out = []
    for ref in refs:
        element, (a, b) = devices[ref]
        across = _across(a, b)
        if kind == "P":
            out.append((f"P({ref})", f"({across})*I({ref})", "W"))
        else:  # Z: V/I of a part; a source drives the rest: its current flows out of it
            sign = "-" if element in ("V", "I") else ""
            out.append((f"Z({ref})", f"{sign}({across})/I({ref})", "Ω"))
    return out


def _natural(name: str) -> list[int | str]:
    """Sort key putting R2 before R10."""
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", name)]


def _across(a: str, b: str) -> str:
    if b == "0":
        return f"V({a})"
    if a == "0":
        return f"-V({b})"
    return f"V({a})-V({b})"


def _two_terminal_parts(project: Project) -> dict[str, tuple[str, tuple[str, str]]]:
    """Ref -> (element letter, its two nets by user name) for the top-level parts."""
    circuit = netlist_project(project.model_copy(deep=True)).circuit
    names = {k.lower(): v for k, v in circuit.net_names.items()}

    def user(node: str) -> str:
        return "0" if node == "0" else names.get(node.lower(), node)

    return {d.ref: (d.element, (user(d.nodes[0]), user(d.nodes[1])))
            for d in circuit.devices if len(d.nodes) == 2}  # fmt: skip


def _all_parts(project: Project) -> list[str]:
    return [d.ref for d in netlist_project(project.model_copy(deep=True)).circuit.devices]


def _signal_of(run: RunReader, label: str, expr: str, unit: str) -> SignalValue:
    assert run.meta.scale is not None
    x = np.real(np.asarray(run.signal(run.meta.scale)))
    scale_unit = run.meta.signal(run.meta.scale).unit
    if is_plain_signal(run, expr):
        y = np.asarray(run.signal(expr))
        unit = unit or run.meta.signal(expr).unit
    else:
        try:
            y = np.asarray(evaluate(run, expr))
        except ExpressionError as exc:
            raise NodeError(str(exc)) from exc
        unit = unit or _expr_unit(expr)
        if y.ndim == 0:
            y = np.full(len(x), y)
    return SignalValue(name=label, x=x, y=y, x_name=run.meta.scale, x_unit=scale_unit, unit=unit)


_VARS = ["a", "b", "c", "d"]


def _infer_unit(expr: str, units: dict[str, str]) -> str:
    text = expr.replace(" ", "")
    if text in units:
        return units[text]
    product = re.fullmatch(r"([a-d])\*([a-d])", text)
    if product and {units.get(product[1]), units.get(product[2])} == {"V", "A"}:
        return "W"
    ratio = re.fullmatch(r"([a-d])/([a-d])", text)
    if ratio and (units.get(ratio[1]), units.get(ratio[2])) == ("V", "A"):
        return "Ω"
    if re.fullmatch(r"(avg|mean|rms|max|min|pp)\(([a-d])\)", text):
        return units.get(text[text.index("(") + 1], "")
    if re.match(r"db\(", text):
        return "dB"
    return ""


@node(
    "math/expr",
    "Expression",
    "Math",
    "Formula over the inputs a, b, c, d (signals or numbers): a*b, (a-b)/1k, db(a/b), "
    "avg(a), rms(a), deriv(a), integ(a), uph(a) (phase without jumps), gd(a) (group delay), "
    "sin, cos, atan, round, pi. Signals are aligned on the x axis of the first one.",
    inputs=[Socket(name=v, type="value", label=v, optional=True) for v in _VARS],
    outputs=[Socket(name="out", type="value", label="result")],
    params=[
        Param(name="expr", kind="text", label="Formula", default="a*b", placeholder="a*b"),
        Param(name="unit", kind="text", label="Unit", default="", placeholder="auto"),
        Param(name="name", kind="text", label="Name", default="", placeholder="P"),
    ],
)
def _expr(ctx: Context, inputs: Inputs, params: Params) -> dict[str, Value]:
    expr = str(params["expr"]).strip()
    given = {v: inputs[v] for v in _VARS if inputs.get(v) is not None}
    signals = [v for v in given.values() if isinstance(v, SignalValue)]
    x = signals[0].x if signals else np.zeros(1)
    variables: dict[str, Any] = {}
    units: dict[str, str] = {}
    for name, value in given.items():
        units[name] = value.unit
        if isinstance(value, SignalValue):
            same = len(value.x) == len(x) and np.allclose(value.x, x)
            if same:
                variables[name] = value.y
            elif value.is_complex:
                variables[name] = dsp.interp(x, value.x, value.y.real) + 1j * np.interp(
                    x, value.x, value.y.imag
                )
            else:
                variables[name] = dsp.interp(x, value.x, value.y)
        else:
            variables[name] = np.asarray(value.value)
    try:
        result = np.asarray(evaluate_with(expr, x, variables))
    except ExpressionError as exc:
        raise NodeError(str(exc)) from exc
    unit = str(params["unit"]).strip() or _infer_unit(expr, units)
    name = str(params["name"]).strip() or expr
    if result.ndim == 0 or not signals:
        value = complex(result.reshape(-1)[0]) if result.size else 0j
        if value.imag:
            return {
                "out": ScalarValue(
                    name=name,
                    value=abs(value),
                    unit=unit,
                    phase_deg=float(np.degrees(np.angle(value))),
                )
            }
        return {"out": ScalarValue(name=name, value=value.real, unit=unit)}
    first = signals[0]
    return {
        "out": SignalValue(
            name=name, x=x, y=result, x_name=first.x_name, x_unit=first.x_unit, unit=unit
        )
    }


_MEASURES = ["max", "min", "pp", "avg", "rms", "final", "at", "f3db", "rise", "fall", "overshoot",
             "settling", "frequency", "duty", "thd", "phase_margin", "gain_margin"]  # fmt: skip


_EDGE_MEASURES = ("rise", "fall")
_PERIOD_MEASURES = ("max", "min", "pp", "avg", "rms", "frequency", "duty")
_PICKS = ["whole signal", "first", "n-th", "last", "all"]


@node(
    "measure/basic",
    "Measure",
    "Measure",
    "Numbers from a signal, several at once: max, min, peak-to-peak, average and RMS "
    "(time-weighted), final value, value at x, -3 dB frequency (AC); rise/fall time (10-90 % "
    "or your levels), overshoot, settling time (band), frequency, duty cycle, THD; phase and "
    "gain margin of a loop gain (AC). Optionally within an x window, and on one edge or period "
    "(first, n-th, last) or each of them (all: a family over the edges or periods). With no "
    "measure chosen: f-3dB for an AC signal, peak-to-peak otherwise.",
    inputs=[
        Socket(name="signal", type="signal", label="signal"),
        Socket(name="at", type="scalar", label="at x", optional=True),
        Socket(name="level", type="scalar", label="level", optional=True),
    ],
    outputs=[
        Socket(name="value", type="scalar", label="value"),
        Socket(name="table", type="table", label="table"),
    ],
    params=[
        Param(
            name="op",
            kind="choices",
            label="Measure",
            default="",
            options=_MEASURES,
            placeholder="auto",
        ),
        Param(name="start", kind="quantity", label="From x", default="", placeholder="start"),
        Param(name="stop", kind="quantity", label="To x", default="", placeholder="end"),
        Param(
            name="pick",
            kind="choice",
            label="Edge / period",
            default="whole signal",
            options=_PICKS,
        ),
        Param(name="n", kind="int", label="n", default=1),
        Param(
            name="levels", kind="text", label="Levels %", default="10/90", placeholder="rise, fall"
        ),
        Param(name="at", kind="quantity", label="At x", default="", placeholder="for 'at'"),
        Param(name="band", kind="text", label="Band %", default="2", placeholder="settling"),
    ],
    version=2,
    # Version 1 measured one thing, "max" unless chosen; its output "value" is the first.
    migrations={1: lambda p: {"op": "max", **p}},
    dynamic_outputs=DynamicOutputs(param="op", type="scalar", skip=1),
)
def _measure(ctx: Context, inputs: Inputs, params: Params) -> dict[str, Value]:
    signal: SignalValue = inputs["signal"]
    if len(signal.x) == 0:
        raise NodeError("empty signal")
    signal = _measure_window(signal, params)
    ops = choices(str(params.get("op") or "")) or (["f3db"] if signal.is_complex else ["pp"])
    unknown = [op for op in ops if op not in _MEASURES]
    if unknown:
        raise NodeError(
            f"unknown measure {', '.join(unknown)} (choose from {', '.join(_MEASURES)})"
        )
    results: dict[str, Value] = {}
    failed: list[str] = []
    for op in ops:
        try:
            results[op] = _measure_one(signal, op, inputs, params)
        except NodeError as exc:
            if len(ops) == 1:
                raise
            failed.append(f"{op}: {exc}")
    if not results:
        raise NodeError("; ".join(failed))
    for text in failed:
        note(text)
    first = results.get(ops[0])
    outputs: dict[str, Value] = {op: v for op, v in results.items() if op != ops[0]}
    if first is not None:
        outputs["value"] = first
    outputs["table"] = _measure_table(signal.name, results)
    return outputs


def _measure_window(signal: SignalValue, params: Params) -> SignalValue:
    start, stop = str(params.get("start") or "").strip(), str(params.get("stop") or "").strip()
    if not start and not stop:
        return signal
    x = np.asarray(signal.x, dtype=float)
    try:
        lo = parse_quantity(start, signal.x_unit) if start else float(x[0])
        hi = parse_quantity(stop, signal.x_unit) if stop else float(x[-1])
    except InvalidValueError as exc:
        raise NodeError(f"window: {exc}") from exc
    keep = (x >= min(lo, hi)) & (x <= max(lo, hi))
    if keep.sum() < 2:
        raise NodeError("fewer than two points in the window")
    return replace(signal, x=x[keep], y=np.asarray(signal.y)[keep])


def _levels(params: Params) -> tuple[float, float]:
    text = str(params.get("levels") or "10/90")
    try:
        lo, hi = (float(v) / 100 for v in text.replace("%", "").split("/"))
    except ValueError as exc:
        raise NodeError(f'levels: write them like "10/90" (in %), not {text!r}') from exc
    if not 0 <= lo < hi <= 1:
        raise NodeError("levels: the lower one first, both between 0 and 100 %")
    return lo, hi


def _measure_one(signal: SignalValue, op: str, inputs: Inputs, params: Params) -> Value:
    """One measure: a number for the whole signal (or the chosen edge or period), or a family
    over all edges or periods."""
    pick = str(params.get("pick") or "whole signal")
    level_in = inputs.get("level")
    level = float(level_in.value) if isinstance(level_in, ScalarValue) else None
    name = f"{op}({signal.name})"
    if pick == "whole signal" or op not in (*_EDGE_MEASURES, *_PERIOD_MEASURES):
        return _measure_whole(signal, op, inputs, params, level)
    x, y = _time_signal(signal, f"{op} per edge or period")
    try:
        if op in _EDGE_MEASURES:
            lo, hi = _levels(params)
            values = dsp.transition_times(x, y, op == "rise", lo, hi)
            unit, what = signal.x_unit, "edge"
        else:
            spans = dsp.periods(x, y, level)
            mid = level if level is not None else (float(np.max(y)) + float(np.min(y))) / 2
            what = "period"
            if op == "frequency":
                values, unit = [1 / (b - a) for a, b in spans], "Hz"
            elif op == "duty":
                values, unit = [dsp.duty_of(x, y, a, b, mid) for a, b in spans], "%"
            else:
                values, unit = [], signal.unit
                for a, b in spans:
                    keep = (x >= a) & (x <= b)
                    part = replace(signal, x=x[keep], y=y[keep])
                    whole = _measure_whole(part, op, inputs, params, level)
                    assert isinstance(whole, ScalarValue)
                    values.append(whole.value)
    except dsp.DspError as exc:
        raise NodeError(str(exc)) from exc
    if pick == "all":
        items: list[Value] = [ScalarValue(name=name, value=v, unit=unit) for v in values]
        return FamilyValue(param=what, values=[str(k + 1) for k in range(len(values))], items=items)
    k = {"first": 0, "last": len(values) - 1}.get(pick, int(params.get("n") or 1) - 1)
    if not 0 <= k < len(values):
        raise NodeError(f"there are {len(values)} {what}s, not {k + 1}")
    return ScalarValue(name=name, value=values[k], unit=unit)


def _measure_table(signal: str, results: dict[str, Value]) -> TableValue:
    """The measures as a table: one row, or a row per edge or period (numbered first)."""
    columns = [op for op in results]
    leaves = [leaf(v) for v in results.values()]
    units = [item.unit if isinstance(item, ScalarValue) else "" for item in leaves]
    if not any(isinstance(v, FamilyValue) for v in results.values()):
        row: list[float | str] = [
            v.value if isinstance(v, ScalarValue) else "" for v in results.values()
        ]
        return TableValue(name=signal, columns=columns, units=units, rows=[row])
    length = max(len(v.items) if isinstance(v, FamilyValue) else 1 for v in results.values())
    rows: list[list[float | str]] = []
    for k in range(length):
        row = [float(k + 1)]
        for v in results.values():
            item = v.items[k] if isinstance(v, FamilyValue) and k < len(v.items) else None
            if not isinstance(v, FamilyValue):
                item = v if k == 0 else None
            row.append(item.value if isinstance(item, ScalarValue) else "")
        rows.append(row)
    return TableValue(name=signal, columns=["#", *columns], units=["", *units], rows=rows)


def _measure_whole(
    signal: SignalValue, op: str, inputs: Inputs, params: Params, level: float | None
) -> Value:
    x, y = signal.x, signal.y
    if len(x) == 0:
        raise NodeError("empty signal")
    name = f"{op}({signal.name})"
    if op == "f3db":
        if not signal.is_complex:
            raise NodeError("-3 dB frequency needs an AC signal")
        db = 20 * np.log10(np.maximum(np.abs(y), 1e-15))
        drop = db[0] + 10 * np.log10(0.5)  # half power: -3.0103 dB
        below = np.nonzero(db < drop)[0]
        if not below.size:
            raise NodeError("the response never drops 3 dB in this range")
        i = int(below[0])
        f = float(x[0])
        if i:  # interpolate in log f (AC sweeps are usually per decade)
            fx = np.log10(np.maximum(x[i - 1 : i + 1], 1e-30))
            f = float(10 ** np.interp(drop, [db[i], db[i - 1]], [fx[1], fx[0]]))
        return ScalarValue(name=f"f-3dB({signal.name})", value=f, unit=signal.x_unit)
    special = _special_measure(signal, op, params, level)
    if special is not None:
        return special
    if op == "at":
        at_in = inputs.get("at")
        if isinstance(at_in, ScalarValue):
            at = float(at_in.value)
        else:
            try:
                at = parse_quantity(str(params["at"]), signal.x_unit)
            except InvalidValueError as exc:
                raise NodeError(f"at: {exc}") from exc
        if signal.is_complex:
            v = complex(dsp.interp(at, x, y.real) + 1j * dsp.interp(at, x, y.imag))
            return ScalarValue(name=name, value=abs(v), unit=signal.unit,
                               phase_deg=float(np.degrees(np.angle(v))))  # fmt: skip
        return ScalarValue(name=name, value=float(dsp.interp(at, x, y)), unit=signal.unit)
    real = np.abs(y) if signal.is_complex else np.real(y)
    span = float(x[-1] - x[0]) if len(x) > 1 else 0.0
    if op == "avg":
        value = float(np.trapezoid(real, x) / span) if span else float(np.mean(real))
    elif op == "rms":
        value = float(np.sqrt(np.trapezoid(real**2, x) / span)) if span else float(abs(real[-1]))
    elif op == "final":
        value = float(real[-1])
    else:
        reducers: dict[str, Any] = {"max": np.max, "min": np.min, "pp": np.ptp}
        value = float(reducers[op](real))
    return ScalarValue(name=name, value=value, unit=signal.unit)


def _special_measure(
    signal: SignalValue, op: str, params: Params, level: float | None = None
) -> ScalarValue | None:
    """Time-domain shape measures and loop margins (see bpt.graph.dsp)."""
    x = np.asarray(signal.x, dtype=float)
    name = f"{op}({signal.name})"
    try:
        if op in ("phase_margin", "gain_margin"):
            if not signal.is_complex:
                raise NodeError("margins need a loop gain from an AC analysis")
            pm, gm = dsp.margins(x, np.asarray(signal.y, dtype=complex))
            value = pm if op == "phase_margin" else gm
            if value is None:
                what = (
                    "the loop gain never crosses 0 dB"
                    if op == "phase_margin"
                    else "the phase never reaches -180 deg"
                )
                raise NodeError(what)
            return ScalarValue(name=name, value=value, unit="°" if op == "phase_margin" else "dB")
        if op not in ("rise", "fall", "overshoot", "settling", "frequency", "duty", "thd"):
            return None
        if signal.is_complex:
            raise NodeError(f"{op} needs a time-domain signal (transient)")
        y = np.real(np.asarray(signal.y, dtype=float))
        if op in ("rise", "fall"):
            lo, hi = _levels(params)
            value = dsp.transition_time(x, y, op == "rise", lo, hi)
            return ScalarValue(name=name, value=value, unit=signal.x_unit)
        if op == "overshoot":
            return ScalarValue(name=name, value=dsp.overshoot(y), unit="%")
        if op == "settling":
            band = float(str(params.get("band", "2")).strip() or 2) / 100
            return ScalarValue(name=name, value=dsp.settling_time(x, y, band), unit=signal.x_unit)
        if op == "frequency":
            return ScalarValue(name=name, value=dsp.frequency(x, y, level), unit="Hz")
        if op == "duty":
            return ScalarValue(name=name, value=dsp.duty_cycle(x, y, level), unit="%")
        distortion, _f = dsp.thd(x, y)
        return ScalarValue(name=name, value=distortion, unit="%")
    except dsp.DspError as exc:
        raise NodeError(str(exc)) from exc
    except ValueError as exc:
        raise NodeError(f"band: {exc}") from exc


def _time_signal(signal: SignalValue, what: str) -> tuple[Any, Any]:
    if signal.is_complex:
        raise NodeError(f"{what} needs a time-domain signal (transient), not an AC result")
    return np.asarray(signal.x, dtype=float), np.real(np.asarray(signal.y, dtype=float))


@node(
    "math/window",
    "Time window",
    "Math",
    "Keeps the part of a signal between two x values (e.g. the steady state after start-up).",
    inputs=[Socket(name="signal", type="signal", label="signal")],
    outputs=[Socket(name="signal", type="signal", label="signal")],
    params=[
        Param(name="start", kind="text", label="From", default="", placeholder="e.g. 5 ms"),
        Param(name="stop", kind="text", label="To", default="", placeholder="end"),
    ],
)
def _window(ctx: Context, inputs: Inputs, params: Params) -> dict[str, Value]:
    signal: SignalValue = inputs["signal"]
    x = np.asarray(signal.x, dtype=float)

    def bound(key: str, default: float) -> float:
        text = str(params[key]).strip()
        if not text:
            return default
        try:
            return parse_quantity(text, signal.x_unit)
        except InvalidValueError as exc:
            raise NodeError(f"{key}: {exc}") from exc

    lo, hi = bound("start", float(x[0])), bound("stop", float(x[-1]))
    keep = (x >= lo) & (x <= hi)
    if keep.sum() < 2:
        raise NodeError("fewer than two points in the window")
    name = f"{signal.name} [{params['start'] or 'start'}..{params['stop'] or 'end'}]"
    return {"signal": replace(signal, name=name, x=x[keep], y=np.asarray(signal.y)[keep])}


@node(
    "math/fft",
    "FFT",
    "Math",
    "Spectrum of a transient signal, scaled so a sine of amplitude A shows as A at its frequency. "
    "Flat-top reads amplitudes exactly, Blackman-Harris separates close lines, rect = no window.",
    inputs=[Socket(name="signal", type="signal", label="signal")],
    outputs=[Socket(name="spectrum", type="signal", label="spectrum")],
    params=[
        Param(name="window", kind="choice", label="Window", default="hann", options=dsp.WINDOWS)
    ],
)
def _fft(ctx: Context, inputs: Inputs, params: Params) -> dict[str, Value]:
    signal: SignalValue = inputs["signal"]
    x, y = _time_signal(signal, "FFT")
    try:
        freqs, values = dsp.spectrum(x, y, str(params["window"]))
    except dsp.DspError as exc:
        raise NodeError(str(exc)) from exc
    spectrum = SignalValue(
        name=f"FFT({signal.name})",
        x=freqs,
        y=values,
        x_name="frequency",
        x_unit="Hz",
        unit=signal.unit,
    )
    return {"spectrum": spectrum}


@node(
    "math/filter",
    "Filter",
    "Math",
    "Butterworth low-, high- or band-pass applied without phase shift (for looking at results, "
    "not a circuit). Order sets the steepness (n x 20 dB/decade).",
    inputs=[Socket(name="signal", type="signal", label="signal")],
    outputs=[Socket(name="signal", type="signal", label="signal")],
    params=[
        Param(
            name="kind", kind="choice", label="Type", default="low", options=["low", "high", "band"]
        ),
        Param(name="f1", kind="quantity", label="Cut-off", default="1 kHz", unit="Hz"),
        Param(
            name="f2",
            kind="quantity",
            label="Upper (band)",
            default="",
            unit="Hz",
            placeholder="band only",
        ),
        Param(name="order", kind="int", label="Order", default=2),
    ],
)
def _filter(ctx: Context, inputs: Inputs, params: Params) -> dict[str, Value]:
    signal: SignalValue = inputs["signal"]
    x, y = _time_signal(signal, "a filter")
    try:
        f1 = parse_quantity(str(params["f1"]), "Hz")
        f2 = parse_quantity(str(params["f2"]), "Hz") if str(params["f2"]).strip() else 0.0
        order = max(1, min(10, int(params["order"])))
        t, out = dsp.butterworth(x, y, str(params["kind"]), f1, f2, order)
    except (InvalidValueError, ValueError) as exc:
        raise NodeError(str(exc)) from exc
    return {"signal": replace(signal, name=f"{params['kind']}pass({signal.name})", x=t, y=out)}


_TOLERANCE_RULE = re.compile(r"([A-Za-z_*?][\w*?.]*)\s*(?:±|\+-|\+/-)\s*([\d.]+)\s*%")


def tolerance_rules(text: str) -> list[tuple[str, float]]:
    """ "R* ±5%; C1 ±10%" -> [("R*", 0.05), ("C1", 0.1)]; refs may use * and ? wildcards."""
    rules = [(m[1], float(m[2]) / 100) for m in _TOLERANCE_RULE.finditer(text)]
    if not rules:
        raise NodeError('write tolerances like "R* ±5%; C1 ±10%"')
    return rules


def vary_project(project: Project, rules: list[tuple[str, float]], rng: Any, normal: bool) -> int:
    """Scale the value of every part matching a rule by a random factor; returns how many."""
    symbols = project_symbols(project)
    changed = 0
    for sheet in project.sheets:
        for inst in sheet.instances:
            symbol = symbols.get(inst.symbol)
            key = symbol.value_param if symbol else None
            if not symbol or not key or inst.model.model or symbol.default_model:
                continue
            rule = next(
                (
                    tol
                    for pattern, tol in rules
                    if fnmatch.fnmatchcase(inst.ref.upper(), pattern.upper())
                ),
                None,
            )
            if rule is None:
                continue
            text = inst.model.params.get(key, symbol.default_params.get(key, ""))
            try:
                nominal = parse_value(text)
            except InvalidValueError:
                continue  # {expression}: vary the parameter with a Sweep instead
            factor = 1 + (rng.normal(0, rule / 3) if normal else rng.uniform(-rule, rule))
            inst.model.params[key] = to_spice(nominal * factor, 6)
            changed += 1
    return changed


@node(
    "core/montecarlo",
    "Monte Carlo",
    "Input",
    "Copies of the circuit with part values varied at random within their tolerance "
    '("R* ±5%; C1 ±10%", wildcards * ?). Normal: the tolerance is 3 sigma. Everything after it '
    "runs once per copy; connect a Histogram or a Specification to see the spread.",
    inputs=[Socket(name="circuit", type="circuit", label="circuit")],
    outputs=[Socket(name="circuit", type="circuit", label="circuits")],
    params=[
        Param(name="tolerances", kind="text", label="Tolerances", default="R* ±5%; C* ±10%"),
        Param(name="runs", kind="int", label="Runs", default=50),
        Param(
            name="distribution",
            kind="choice",
            label="Distribution",
            default="normal",
            options=["normal", "uniform"],
        ),
        Param(name="seed", kind="int", label="Seed", default=1),
    ],
)
def _montecarlo(ctx: Context, inputs: Inputs, params: Params) -> dict[str, Value]:
    circuit: CircuitValue = inputs["circuit"]
    rules = tolerance_rules(str(params["tolerances"]))
    try:
        runs, seed = int(params["runs"]), int(params["seed"])
    except (TypeError, ValueError) as exc:
        raise NodeError("runs and seed are whole numbers") from exc
    if not 1 <= runs <= 500:
        raise NodeError("runs must be between 1 and 500")
    rng = np.random.default_rng(seed)
    items: list[Value] = []
    for _ in range(runs):
        project = circuit.project.model_copy(deep=True)
        if vary_project(project, rules, rng, params["distribution"] == "normal") == 0:
            raise NodeError(
                "no part matches the tolerances (values must be numbers, not {expressions})"
            )
        items.append(CircuitValue(project=project, key=circuit_key(project)))
    return {
        "circuit": FamilyValue(param="run", values=[str(i + 1) for i in range(runs)], items=items)
    }


def check_condition(text: str, unit: str) -> Callable[[float], bool]:
    """ "> 45", "<= 1k", "1k..2k" (inclusive range) -> test function; values may carry units."""
    body = (text.replace(unit, "") if unit else text).strip()
    parts = re.split(r"\s*(?:\.\.|\bto\b)\s*", body)
    op_match = re.match(r"^(<=|>=|<|>|=)?\s*(.+)$", parts[0])
    if not op_match or len(parts) > 2 or (len(parts) == 2 and op_match[1]):
        raise NodeError('write a condition like "> 45", "< 1k" or "1k..2k"')
    op, first = op_match[1], op_match[2]
    try:
        a = parse_quantity(first, unit)
        b = parse_quantity(parts[1], unit) if len(parts) == 2 else None
    except InvalidValueError as exc:
        raise NodeError(f"condition: {exc}") from exc
    if b is not None:
        lo, hi = min(a, b), max(a, b)
        return lambda v: lo <= v <= hi
    tests: dict[str, Callable[[float], bool]] = {
        "<": lambda v: v < a, "<=": lambda v: v <= a, ">": lambda v: v > a, ">=": lambda v: v >= a,
        "=": lambda v: abs(v - a) <= 1e-9 * max(1.0, abs(a)),
    }  # fmt: skip
    return tests[op or ">="]


@node(
    "view/spec",
    "Specification",
    "View",
    "Checks a number (or every member of a sweep / Monte Carlo family) against a condition: "
    '"> 45", "<= 1k", "1k..2k". Shows PASS/FAIL and the yield; the yield output feeds tables.',
    inputs=[Socket(name="value", type="scalar", label="value")],
    outputs=[Socket(name="yield", type="scalar", label="yield %")],
    params=[
        Param(name="condition", kind="text", label="Condition", default="> 0", placeholder="> 45")
    ],
    view="spec",
)
def _spec(ctx: Context, inputs: Inputs, params: Params) -> dict[str, Value]:
    value = inputs["value"]
    leaves = value.leaves() if isinstance(value, FamilyValue) else [("", value)]
    scalars = [(label, v) for label, v in leaves if isinstance(v, ScalarValue)]
    if not scalars:
        raise NodeError("connect a number")
    test = check_condition(str(params["condition"]), scalars[0][1].unit)
    failed = [(label, v) for label, v in scalars if not test(v.value)]
    total = len(scalars)
    verdict = "PASS" if not failed else "FAIL"
    detail = f"{total - len(failed)} of {total} within {params['condition']}"
    worst = ", ".join(
        f"{label or v.name}: {format_value(v.value, v.unit)}" for label, v in failed[:3]
    )
    name = f"{verdict} {detail}" + (
        f" (outside: {worst}{'…' if len(failed) > 3 else ''})" if failed else ""
    )
    return {"yield": ScalarValue(name=name, value=100.0 * (total - len(failed)) / total, unit="%")}


@node(
    "measure/stress",
    "Stress",
    "Measure",
    "Checks the parts' ratings (Properties > Ratings, or a library part's) against operating "
    "point or transient runs, with the project's margins. A sweep or Monte Carlo family counts "
    "its worst member. FAIL = a rating exceeded, WARN = within the rating but beyond the margin. "
    "Outputs the worst use of a rating and the use of each (for a table or histogram).",
    inputs=[
        Socket(name="run", type="run", label="runs", multi=True),
        Socket(name="circuit", type="circuit", label="circuit", optional=True),
    ],
    outputs=[
        Socket(name="worst", type="scalar", label="worst %"),
        Socket(name="items", type="scalar", label="each %"),
    ],
    view="spec",
)
def _stress(ctx: Context, inputs: Inputs, params: Params) -> dict[str, Value]:
    from bpt.analysis.stress import StressItem, stress_report

    circuit = inputs.get("circuit")
    project = circuit.project if isinstance(circuit, CircuitValue) else ctx.project
    given = inputs.get("run") or []
    runs: list[RunValue] = []
    for value in given if isinstance(given, list) else [given]:
        leaves = value.leaves() if isinstance(value, FamilyValue) else [("", value)]
        runs += [v for _label, v in leaves if isinstance(v, RunValue)]
    if not runs:
        raise NodeError("connect an operating point or transient run")
    worst: dict[tuple[str, str], StressItem] = {}
    for run in runs:
        if run.kind not in ("op", "tran"):
            raise NodeError(f"stress needs operating point or transient runs, not {run.kind}")
        for item in stress_report(project, ctx.open_run(run.run_id)).items:
            key = (item.ref, item.quantity)
            if key not in worst or item.usage > worst[key].usage:
                worst[key] = item
    if not worst:
        raise NodeError("no part has ratings: set them in Properties > Ratings")
    items = sorted(worst.values(), key=lambda i: -i.usage)
    over = [i for i in items if i.status == "over"]
    margin = [i for i in items if i.status == "margin"]
    verdict = "FAIL" if over else "WARN" if margin else "PASS"
    top = items[0]
    detail = (f"{len(over)} over, {len(margin)} without margin of {len(items)} ratings; "
              f"worst {top.ref} {top.quantity}")  # fmt: skip
    family = FamilyValue(
        param="rating",
        values=[f"{i.ref} {i.quantity}" for i in items],
        items=[ScalarValue(name=f"{i.ref} {i.quantity}", value=i.usage, unit="%") for i in items],
    )
    return {
        "worst": ScalarValue(name=f"{verdict} {detail}", value=top.usage, unit="%"),
        "items": family,
    }


# -- views -----------------------------------------------------------------------------------


@node(
    "view/plot",
    "Plot",
    "View",
    "Plots the connected signals. Double-click the preview for the full-screen viewer. "
    'Panels: one, a panel per unit, per signal, or your groups ("V(*); I(*)": panels '
    "separated by ';', names in one by '|'). Right axis: traces drawn against a second Y "
    'axis. Lines: reference lines ("3.3 V; x = 2 ms"); numbers connected to limits are drawn '
    "as lines too.",
    inputs=[
        Socket(name="signals", type="signal", label="signals", multi=True),
        Socket(name="limits", type="scalar", label="limits", multi=True, optional=True),
    ],
    params=[
        Param(name="title", kind="text", label="Title", default=""),
        Param(
            name="kind",
            kind="choice",
            label="Chart",
            default="line",
            options=["line", "step", "points"],
        ),
        Param(
            name="x_log",
            kind="choice",
            label="X axis",
            default="auto",
            options=["auto", "lin", "log"],
        ),
        Param(name="y_log", kind="bool", label="Log Y", default=False),
        Param(
            name="complex",
            kind="choice",
            label="AC as",
            default="db",
            options=["db", "mag", "phase", "bode", "nyquist"],
        ),
        Param(
            name="panels",
            kind="choice",
            label="Panels",
            default="one",
            options=["one", "per unit", "per signal", "custom"],
        ),
        Param(
            name="groups",
            kind="text",
            label="Groups",
            default="",
            placeholder="V(*); I(*)",
            advanced=True,
        ),
        Param(
            name="right",
            kind="text",
            label="Right axis",
            default="",
            placeholder="I(*)",
            advanced=True,
        ),
        Param(
            name="lines",
            kind="text",
            label="Lines",
            default="",
            placeholder="3.3 V; x = 2 ms",
            advanced=True,
        ),
    ],
    view="plot",
)
def _plot(ctx: Context, inputs: Inputs, params: Params) -> dict[str, Value]:
    if not inputs.get("signals"):
        raise NodeError("connect one or more signals")
    return {}


@node(
    "view/value",
    "Value",
    "View",
    "Shows a number with its unit.",
    inputs=[Socket(name="value", type="scalar", label="value")],
    view="value",
)
def _value(ctx: Context, inputs: Inputs, params: Params) -> dict[str, Value]:
    return {}


@node(
    "view/table",
    "Table",
    "View",
    "Lists the connected numbers, or shows a table.",
    inputs=[
        Socket(name="values", type="scalar", label="values", multi=True, optional=True),
        Socket(name="table", type="table", label="table", optional=True),
    ],
    view="table",
)
def _table(ctx: Context, inputs: Inputs, params: Params) -> dict[str, Value]:
    if not inputs.get("values") and inputs.get("table") is None:
        raise NodeError("connect values or a table")
    return {}


def make_table(name: str, values: list[Value]) -> TableValue:
    """Scalars as a table: one row of them; families of the same sweep as one row per point
    (the sweep's parameter in the first column), a column per value."""
    families = [v for v in values if isinstance(v, FamilyValue)]
    if families and len(families) == len(values):
        first = families[0]
        if all(f.param == first.param and f.values == first.values for f in families):
            columns, units = [first.param], [""]
            for f in families:
                member = leaf(f)
                columns.append(member.name if isinstance(member, ScalarValue) else f.param)
                units.append(member.unit if isinstance(member, ScalarValue) else "")
            rows: list[list[float | str]] = []
            for k, point in enumerate(first.values):
                row: list[float | str] = [_number_or_text(point)]
                for f in families:
                    item = f.items[k]
                    row.append(item.value if isinstance(item, ScalarValue) else str(item))
                rows.append(row)
            return TableValue(name=name, columns=columns, units=units, rows=rows)
    scalars = [v for v in values if isinstance(v, ScalarValue)]
    if len(scalars) != len(values):
        raise NodeError("values of one sweep each (or plain numbers) make a table")
    return TableValue(name=name, columns=[v.name for v in scalars], units=[v.unit for v in scalars],
                      rows=[[v.value for v in scalars]])  # fmt: skip


def _number_or_text(text: str) -> float | str:
    try:
        return parse_value(text)
    except InvalidValueError:
        return text


@node(
    "table/make",
    "Make table",
    "Data",
    "Values as a table: a column each; values of a sweep give a row per sweep point.",
    inputs=[Socket(name="values", type="scalar", label="values", multi=True)],
    outputs=[Socket(name="table", type="table", label="table")],
    params=[Param(name="name", kind="text", label="name", default="table")],
    families=True,
)
def _make_table(ctx: Context, inputs: Inputs, params: Params) -> dict[str, Value]:
    values = inputs.get("values") or []
    if not values:
        raise NodeError("connect one or more values")
    return {"table": make_table(str(params.get("name") or "table"), values)}


@node(
    "table/column",
    "Table column",
    "Data",
    "A column of a table as a signal against another (the first, by default): to plot it.",
    inputs=[Socket(name="table", type="table", label="table")],
    outputs=[Socket(name="signal", type="signal", label="signal")],
    params=[
        Param(name="column", kind="text", label="column", default=""),
        Param(name="against", kind="text", label="against", default=""),
    ],
)
def _table_column(ctx: Context, inputs: Inputs, params: Params) -> dict[str, Value]:
    table = inputs["table"]
    assert isinstance(table, TableValue)
    if len(table.columns) < 2:
        raise NodeError("the table needs two columns")
    y_name = str(params.get("column") or table.columns[-1])
    x_name = str(params.get("against") or table.columns[0])
    for wanted in (x_name, y_name):
        if wanted not in table.columns:
            raise NodeError(f"no column {wanted!r} (columns: {', '.join(table.columns)})")
    try:
        x = np.array([float(v) for v in table.column(x_name)])
        y = np.array([float(v) for v in table.column(y_name)])
    except ValueError as exc:
        raise NodeError(f"the columns must be numbers: {exc}") from exc
    order = np.argsort(x)
    return {"signal": SignalValue(name=y_name, x=x[order], y=y[order], x_name=x_name,
                                  x_unit=table.units[table.columns.index(x_name)],
                                  unit=table.units[table.columns.index(y_name)])}  # fmt: skip


_ACCEPTS: dict[str, tuple[type, ...]] = {
    "circuit": (CircuitValue,),
    "params": (ParamsValue,),
    "run": (RunValue,),
    "signal": (SignalValue,),
    "scalar": (ScalarValue,),
    "value": (SignalValue, ScalarValue),
    "table": (TableValue,),
}


def accepts(socket: SocketType, value: Value) -> bool:
    """Type check of a link; a family is checked by its members (they get broadcast)."""
    member = leaf(value)
    return member is None or isinstance(member, _ACCEPTS[socket])


@node(
    "view/histogram",
    "Histogram",
    "View",
    "Distribution of the connected numbers (a sweep or Monte Carlo family): how many fall into "
    "each bin.",
    inputs=[Socket(name="values", type="scalar", label="values", multi=True)],
    params=[Param(name="bins", kind="int", label="Bins", default=10)],
    view="histogram",
)
def _histogram(ctx: Context, inputs: Inputs, params: Params) -> dict[str, Value]:
    if not inputs.get("values"):
        raise NodeError("connect one or more values")
    return {}


from . import nodes_math  # noqa: E402, F401  (registers the building-block nodes)
