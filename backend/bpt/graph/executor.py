"""Graph execution (node.md §5): topological order, cache by key, errors pinned to nodes.

A node's key hashes its type, version, parameters and the keys of its inputs; the circuit
node's key is the hash of the netlist. So moving a part on the schematic reuses every result,
while changing a value re-runs only the simulations and calculations that depend on it.
"""

import hashlib
import json
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Literal, cast

from pydantic import BaseModel

from bpt.document.model import Graph, GraphEdge, GraphNode

from .catalog import (
    CATALOG,
    NOTES,
    Context,
    NodeError,
    NodeType,
    accepts,
    input_sockets,
    param_from_input,
    param_values,
)
from .diskcache import DiskCache
from .values import (
    CircuitValue,
    FamilyValue,
    ParamsValue,
    RunValue,
    ScalarValue,
    SignalValue,
    TableValue,
    Value,
)

NodeStatus = Literal["running", "ok", "cached", "error", "blocked", "skipped"]


class NodeState(BaseModel):
    status: NodeStatus
    error: str | None = None
    duration_s: float = 0.0
    summary: list[str] = []
    from_disk: bool = False  # results of an earlier session (the disk cache)


@dataclass
class NodeResult:
    state: NodeState
    outputs: dict[str, Value] = field(default_factory=dict)
    inputs: dict[str, Any] = field(default_factory=dict)
    key: str = ""


class CancelledError(Exception):
    pass


class ResultCache:
    """Outputs by node key, least recently used dropped first."""

    def __init__(self, size: int = 256) -> None:
        self.size = size
        self._items: OrderedDict[str, dict[str, Value]] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: str) -> dict[str, Value] | None:
        with self._lock:
            if key not in self._items:
                return None
            self._items.move_to_end(key)
            return self._items[key]

    def put(self, key: str, outputs: dict[str, Value]) -> None:
        with self._lock:
            self._items[key] = outputs
            self._items.move_to_end(key)
            while len(self._items) > self.size:
                self._items.popitem(last=False)


def describe(value: Value) -> str:
    if isinstance(value, FamilyValue):
        leaves = value.leaves()
        if not leaves:
            return f"{value.param}: no values"
        if all(isinstance(v, ScalarValue) for _, v in leaves) and len(leaves) <= 6:
            return "; ".join(f"{label}: {describe(v).split(' = ')[-1]}" for label, v in leaves)
        shown = ", ".join(value.values[:4]) + ("…" if len(value.values) > 4 else "")
        return f"{len(leaves)} x ({value.param} = {shown}): {describe(leaves[0][1])}"
    if isinstance(value, SignalValue | ScalarValue | TableValue):
        return value.describe()
    if isinstance(value, RunValue):
        return f"{value.kind.upper()} run, {len(value.signals)} signals"
    if isinstance(value, ParamsValue):
        return ", ".join(f"{k} = {v}" for k, v in value.values.items())
    return f"netlist #{value.key[:8]}"


def _order(graph: Graph) -> tuple[list[GraphNode], set[str]]:
    """Nodes in dependency order; ids of nodes inside cycles are returned separately."""
    by_id = {n.id: n for n in graph.nodes}
    pending = {n.id: 0 for n in graph.nodes}
    for edge in graph.edges:
        if edge.source in by_id and edge.target in by_id:
            pending[edge.target] += 1
    ready = [n.id for n in graph.nodes if pending[n.id] == 0]
    order: list[GraphNode] = []
    while ready:
        current = ready.pop(0)
        order.append(by_id[current])
        for edge in graph.edges:
            if edge.source == current and edge.target in pending:
                pending[edge.target] -= 1
                if pending[edge.target] == 0:
                    ready.append(edge.target)
    cyclic = set(by_id) - {n.id for n in order}
    return order, cyclic


def _needed(graph: Graph) -> set[str]:
    """Views and everything they depend on; all nodes when the graph has no views yet."""
    views = [n.id for n in graph.nodes if n.type in CATALOG and CATALOG[n.type].info.view]
    if not views:
        return {n.id for n in graph.nodes}
    needed, stack = set(views), list(views)
    while stack:
        current = stack.pop()
        for edge in graph.edges:
            if edge.target == current and edge.source not in needed:
                needed.add(edge.source)
                stack.append(edge.source)
    return needed


def _key(
    node: GraphNode, node_type: NodeType, params: dict[str, Any], input_keys: dict[str, list[str]]
) -> str:
    payload = json.dumps(
        {"type": node.type, "v": node_type.version, "params": params, "inputs": input_keys},
        sort_keys=True,
        default=str,
    )
    return hashlib.sha256(payload.encode()).hexdigest()[:20]


Emit = Callable[[str, NodeState], None]
NOT_RESTORED = NodeState(status="skipped", error="not restored")  # (never announced)


def through_reroutes(graph: Graph) -> Graph:
    """The graph with each edge that passes reroutes joined into one edge from its real source
    (a reroute's input ``in`` goes out of its output ``out`` unchanged)."""
    if not graph.reroutes:
        return graph
    reroutes = {r.id for r in graph.reroutes}
    into = {e.target: e for e in graph.edges if e.target in reroutes}

    def origin(edge: GraphEdge) -> GraphEdge | None:
        seen: set[str] = set()
        while edge.source in reroutes:
            if edge.source in seen or edge.source not in into:
                return None  # a loop of reroutes, or one with nothing coming in
            seen.add(edge.source)
            edge = into[edge.source]
        return edge

    edges = []
    for e in graph.edges:
        if e.target in reroutes:
            continue
        start = origin(e)
        if start is not None:
            edges.append(GraphEdge(source=start.source, output=start.output, target=e.target,
                                   input=e.input))  # fmt: skip
    return graph.model_copy(update={"edges": edges})


def _bypassed(node_type: NodeType, inputs: dict[str, Any]) -> dict[str, Value] | None:
    """A bypassed node's outputs: each the first input of the same type ("signal" in, "signal"
    out); None when one has no such input (its branch is skipped)."""
    by_type: dict[str, Value] = {}
    for socket in node_type.info.inputs:
        value = inputs.get(socket.name)
        if isinstance(value, list):
            value = value[0] if value else None
        if value is not None:
            by_type.setdefault(socket.type, value)
    outputs: dict[str, Value] = {}
    for socket in node_type.info.outputs:
        if socket.type not in by_type:
            return None
        outputs[socket.name] = by_type[socket.type]
    return outputs


BYPASSED = "bypassed"
CANCELLED = "cancelled"


class NotRestoredError(Exception):
    """A simulation asked for while restoring results: the node shows none until run."""


class _NoSimulation:
    """A context with everything but new simulations (restoring results, or the rest of a
    cancelled run): asking for one raises ``error``."""

    def __init__(self, ctx: Context, error: type[Exception]) -> None:
        self._ctx = ctx
        self._error = error

    def __getattr__(self, name: str) -> Any:
        return getattr(self._ctx, name)

    def simulate(self, project: Any, analysis: Any) -> Any:
        raise self._error


def execute(
    graph: Graph,
    ctx: Context,
    cache: ResultCache,
    emit: Emit | None = None,
    cancel: threading.Event | None = None,
    results: dict[str, NodeResult] | None = None,
    disk: DiskCache | None = None,
    restore: bool = False,
) -> dict[str, NodeResult]:
    """Run ``graph``; never raises for node failures (they are in the results). ``results``: a
    dict filled as each node finishes, before it is announced (``emit``), so what a client asks
    for when told a node is done is there. ``disk``: outputs kept between sessions.
    ``restore``: show what the caches have without simulating; a node that would need a new
    simulation (and all after it) is left without results."""
    graph = through_reroutes(graph)
    if restore:
        ctx = cast(Context, _NoSimulation(ctx, NotRestoredError))
    if results is None:
        results = {}
    order, cyclic = _order(graph)
    needed = _needed(graph)
    by_id = {n.id: n for n in graph.nodes}

    def finish(node_id: str, result: NodeResult) -> None:
        results[node_id] = result
        if emit is not None:
            emit(node_id, result.state)

    for node_id in cyclic:
        finish(node_id, NodeResult(NodeState(status="error", error="part of a cycle")))

    stopped = False
    for node in order:
        if cancel is not None and cancel.is_set() and not stopped:
            # Stop: no new simulations; what was done (sweep points too) goes on through the
            # rest of the graph, so the plots show it.
            ctx = cast(Context, _NoSimulation(ctx, CancelledError))
            stopped = True
        if node.id not in needed:
            finish(node.id, NodeResult(NodeState(status="skipped")))
            continue
        node_type = CATALOG.get(node.type)
        if node_type is None:
            finish(
                node.id,
                NodeResult(NodeState(status="error", error=f"unknown node type {node.type}")),
            )
            continue
        params = param_values(node_type, node.params)

        # Gather inputs; a failed source blocks this node.
        inputs: dict[str, Any] = {}
        input_keys: dict[str, list[str]] = {}
        problem: NodeState | None = None
        missing: list[str] = []
        sockets = input_sockets(node_type, node.param_inputs)
        as_params = {s.name for s in sockets[len(node_type.info.inputs) :]}
        for socket in sockets:
            values: list[Value] = []
            keys: list[str] = []
            gone = len(missing)  # (what this socket misses: missing[gone:])
            for edge in graph.edges:
                if edge.target != node.id or edge.input != socket.name:
                    continue
                source = results.get(edge.source)
                if source is None or edge.source not in by_id:
                    if restore and edge.source in by_id:
                        problem = NOT_RESTORED
                        break
                    continue
                if source.state.status == "skipped" and source.state.error in (
                    BYPASSED,
                    f"{BYPASSED} upstream",
                ):
                    problem = NodeState(status="skipped", error=f"{BYPASSED} upstream")
                    break
                if source.state.status == "skipped" and source.state.error == CANCELLED:
                    problem = NodeState(status="skipped", error=CANCELLED)
                    break
                if source.state.status not in ("ok", "cached"):
                    title = (
                        CATALOG[by_id[edge.source].type].info.title
                        if by_id[edge.source].type in CATALOG
                        else edge.source
                    )
                    if node_type.info.view and socket.multi:
                        missing.append(title)  # a view shows what it has; one bad input is a note
                        continue
                    problem = NodeState(status="blocked", error=f"waiting for {title}")
                    break
                value = source.outputs.get(edge.output)
                if value is None:
                    problem = NodeState(
                        status="error", error=f"{edge.source} has no output {edge.output}"
                    )
                    break
                if not accepts(socket.type, value):
                    got = type(value).__name__.removesuffix("Value").lower()
                    problem = NodeState(
                        status="error",
                        error=f"{socket.label or socket.name} expects {socket.type}, got {got}",
                    )
                    break
                values.append(value)
                keys.append(source.key + ":" + edge.output)
            if problem is not None:
                break
            if not values and missing[gone:]:  # this socket's own: another's are only a note
                problem = NodeState(
                    status="blocked", error=f"waiting for {', '.join(missing[gone:])}"
                )
                break
            if not values and not socket.optional and not socket.multi:
                problem = NodeState(status="error", error=f"connect {socket.label or socket.name}")
                break
            input_keys[socket.name] = keys
            if socket.multi:
                inputs[socket.name] = values
            elif values:
                inputs[socket.name] = values[0]
        if problem is NOT_RESTORED:
            continue
        if problem is not None:
            finish(node.id, NodeResult(problem))
            continue
        if node.bypass:
            passed = _bypassed(node_type, inputs)
            if passed is None:
                finish(node.id, NodeResult(NodeState(status="skipped", error=BYPASSED)))
            else:
                state = NodeState(status="ok", error=BYPASSED,
                                  summary=[describe(v) for v in passed.values()])  # fmt: skip
                key = hashlib.sha256(("bypass:" + json.dumps(input_keys, sort_keys=True))
                                     .encode()).hexdigest()[:20]  # fmt: skip
                finish(node.id, NodeResult(state, passed, inputs, key))
            continue

        key = _key(node, node_type, params, input_keys)
        is_view = bool(node_type.info.view)
        cached = None if node.type == "core/circuit" or is_view else cache.get(key)
        from_disk = False
        if cached is None and disk is not None and node.type != "core/circuit" and not is_view:
            cached = disk.get(key)
            if cached is not None:
                cache.put(key, cached)
                from_disk = True
        if cached is not None:
            state = NodeState(status="cached", summary=_summary(cached),
                              from_disk=from_disk)  # fmt: skip
            finish(node.id, NodeResult(state, cached, inputs, key))
            continue
        if emit is not None:
            emit(node.id, NodeState(status="running"))
        started = time.perf_counter()
        partial: list[str] = []  # sweeps stopped before all their points were done
        remarks: list[str] = []
        token = NOTES.set(remarks)
        try:
            outputs = (
                node_type.run(ctx, *_params_from_inputs(node_type, inputs, params, as_params))
                if node_type.families
                else broadcast(node_type, ctx, inputs, params, cancel, partial, as_params)
            )
        except NodeError as exc:
            took = time.perf_counter() - started
            finish(node.id, NodeResult(NodeState(status="error", error=str(exc), duration_s=took)))
            continue
        except CancelledError:
            finish(node.id, NodeResult(NodeState(status="skipped", error=CANCELLED)))
            continue
        except NotRestoredError:
            continue
        except Exception as exc:  # a bug in a node must not stop the graph
            finish(
                node.id, NodeResult(NodeState(status="error", error=f"{type(exc).__name__}: {exc}"))
            )
            continue
        finally:
            NOTES.reset(token)
        if node.type == "core/circuit":
            circuit = outputs["circuit"]
            assert isinstance(circuit, CircuitValue)
            key = "circuit-" + circuit.key
        elif partial:
            # Not the node's full result: a key of its own (nothing after it is cached as the
            # full one) and kept nowhere.
            key = hashlib.sha256(f"{key}:partial:{partial}".encode()).hexdigest()[:20]
        else:
            cache.put(key, outputs)
            if disk is not None:
                disk.put(key, outputs)
        summary = _summary(outputs) or _view_summary(inputs)
        notes = [f"stopped: {', '.join(partial)}"] if partial else []
        notes += remarks
        notes += [f"not shown (failed): {', '.join(missing)}"] if missing else []
        note = "; ".join(notes) or None
        took = time.perf_counter() - started
        state = NodeState(status="ok", error=note, duration_s=took, summary=summary)
        finish(node.id, NodeResult(state, outputs, inputs, key))
    return results


def broadcast(
    node_type: NodeType,
    ctx: Context,
    inputs: dict[str, Any],
    params: dict[str, Any],
    cancel: threading.Event | None = None,
    partial: list[str] | None = None,
    as_params: set[str] | None = None,
) -> dict[str, Value]:
    """Run a node once per member of a family input; outputs become families of the results.

    Families over the same parameter are walked together (zip); a family over another parameter
    inside a member is handled by the recursive call (nested sweep, outer product). Stopped
    (``cancel``) part way: with ``partial`` given, the family of the points done, noted there
    ("R: 3 of 10 points"); without it, or with no point done, ``CancelledError``.
    """
    found = next(((k, v) for k, v in inputs.items() if isinstance(v, FamilyValue)), None)
    if found is None:
        return node_type.run(ctx, *_params_from_inputs(node_type, inputs, params, as_params))
    key, family = found

    def member_inputs(i: int) -> dict[str, Any]:
        sub = dict(inputs)
        sub[key] = family.items[i]
        for other, value in inputs.items():
            if other != key and isinstance(value, FamilyValue) and value.param == family.param:
                if len(value.items) != len(family.items):
                    raise NodeError(f"sweeps of {family.param} differ in length")
                sub[other] = value.items[i]
        return sub

    simulates = node_type.info.category == "Simulation"

    def one(i: int) -> dict[str, Value] | None:
        if simulates and cancel is not None and cancel.is_set():
            return None  # (other nodes go on: they work on what was simulated)
        try:
            return broadcast(node_type, ctx, member_inputs(i), params, cancel, partial, as_params)
        except CancelledError:
            return None

    count = len(family.items)
    if simulates and count > 1:
        # Sweep points are independent simulations: the engine pool runs them side by side.
        with ThreadPoolExecutor(max_workers=min(count, 8), thread_name_prefix="bpt-sweep") as pool:
            results = list(pool.map(one, range(count)))
    else:
        results = [one(i) for i in range(count)]
    done = [i for i, r in enumerate(results) if r is not None]
    if len(done) < count:
        if not done or partial is None:
            raise CancelledError
        partial.append(f"{family.param}: {len(done)} of {count} points")
    first = results[done[0]] if done else None
    names = list(first) if first is not None else [s.name for s in node_type.info.outputs]
    return {
        name: FamilyValue(
            param=family.param,
            values=[family.values[i] for i in done],
            items=[r[name] for r in results if r is not None],
        )
        for name in names
    }


def _params_from_inputs(
    node_type: NodeType, inputs: dict[str, Any], params: dict[str, Any], names: set[str] | None
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Numbers on parameter sockets (widget -> input) moved into the parameters."""
    if not names:
        return inputs, params
    rest = {k: v for k, v in inputs.items() if k not in names}
    given = {k: param_from_input(node_type, k, v) for k, v in inputs.items() if k in names}
    return rest, {**params, **given}


def _summary(outputs: dict[str, Value]) -> list[str]:
    """A line per output; a family of one value that is also an output on its own (Signal's
    "all" with one signal) is not told twice."""
    alone = [v for v in outputs.values() if not isinstance(v, FamilyValue)]
    return [describe(v) for v in outputs.values()
            if not (isinstance(v, FamilyValue) and len(v.items) == 1
                    and any(v.items[0] is a for a in alone))]  # fmt: skip


def _view_summary(inputs: dict[str, Any]) -> list[str]:
    out: list[str] = []
    for value in inputs.values():
        for item in value if isinstance(value, list) else [value]:
            out.append(describe(item))
    return out
