"""Analysis graphs: node catalog, running a graph, node results and plot data."""

from typing import Any

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from bpt.api.projects import State, _project
from bpt.document.model import Graph
from bpt.graph.catalog import CATALOG, NodeTypeInfo
from bpt.graph.executor import NodeState
from bpt.graph.values import FamilyValue, ScalarValue, SignalValue, TableValue
from bpt.results.decimate import decimate

router = APIRouter(prefix="/api", tags=["graphs"])


def _flatten(values: list[Any]) -> list[tuple[str, Any]]:
    """Plain values and family members as (sweep label, value)."""
    out: list[tuple[str, Any]] = []
    for value in values:
        out += value.leaves() if isinstance(value, FamilyValue) else [("", value)]
    return out


@router.get("/graph/node-types")
def node_types() -> list[NodeTypeInfo]:
    return [t.info for t in CATALOG.values()]


class GraphResults(BaseModel):
    status: str  # idle, running, done
    nodes: dict[str, NodeState]


def _graph(state: State, project_id: str, name: str) -> tuple[Any, Graph]:
    p = _project(state, project_id)
    for graph in p.session.project.graphs:
        if graph.name == name:
            return p, graph
    raise HTTPException(404, f"no graph {name!r}")


@router.post("/projects/{project_id}/graphs/{name}/run")
def run_graph(project_id: str, name: str, state: State) -> GraphResults:
    """Run the graph in the background; progress arrives as ``graph.node`` events."""
    p, graph = _graph(state, project_id, name)
    run = state.graphs.run(p.id, p.session.project, graph, p.results)
    return GraphResults(status=run.status, nodes={k: v.state for k, v in run.results.items()})


@router.post("/projects/{project_id}/graphs/{name}/cancel")
def cancel_graph(project_id: str, name: str, state: State) -> GraphResults:
    _graph(state, project_id, name)
    state.graphs.cancel(project_id, name)
    run = state.graphs.get(project_id, name)
    return GraphResults(status=run.status, nodes={k: v.state for k, v in run.results.items()})


@router.get("/projects/{project_id}/graphs/{name}/results")
def graph_results(project_id: str, name: str, state: State) -> GraphResults:
    """The latest results; the first time in a session they come from the caches (a graph
    reopened shows its results without simulating, marked ``from_disk``)."""
    p, graph = _graph(state, project_id, name)
    run = state.graphs.restore(p.id, p.session.project, graph, p.results)
    return GraphResults(status=run.status, nodes={k: v.state for k, v in run.results.items()})


def _node_inputs(state: State, project_id: str, name: str, node_id: str) -> dict[str, Any]:
    _graph(state, project_id, name)
    result = state.graphs.get(project_id, name).results.get(node_id)
    if result is None or result.state.status not in ("ok", "cached"):
        raise HTTPException(404, "the node has no results; run the graph")
    return result.inputs


class PlotBody(BaseModel):
    pixels: int = Field(default=600, ge=10, le=20000)


class PlotSeries(BaseModel):
    name: str
    family: str = ""  # sweep point of a family member ("R=2k"), empty otherwise
    x_name: str
    x_unit: str
    unit: str
    x: list[float]
    min: list[float] | None = None  # real signals, decimated (min/max envelope)
    max: list[float] | None = None
    re: list[float] | None = None  # complex signals (AC), not decimated
    im: list[float] | None = None


@router.post("/projects/{project_id}/graphs/{name}/nodes/{node_id}/plot")
def node_plot(
    project_id: str, name: str, node_id: str, body: PlotBody, state: State
) -> list[PlotSeries]:
    """Data of a Plot node's inputs, one series per signal (each with its own x)."""
    signals = _flatten(_node_inputs(state, project_id, name, node_id).get("signals", []))
    out: list[PlotSeries] = []
    for label, signal in signals:
        if not isinstance(signal, SignalValue):
            continue
        base: dict[str, Any] = {
            "name": f"{signal.name} [{label}]" if label else signal.name,
            "family": label,
            "x_name": signal.x_name,
            "x_unit": signal.x_unit,
            "unit": signal.unit,
        }
        if signal.is_complex:
            out.append(
                PlotSeries(
                    **base,
                    x=signal.x.tolist(),
                    re=signal.y.real.tolist(),
                    im=signal.y.imag.tolist(),
                )
            )
            continue
        order = np.argsort(signal.x, kind="stable") if np.any(np.diff(signal.x) < 0) else None
        x = signal.x if order is None else signal.x[order]
        y = np.real(signal.y) if order is None else np.real(signal.y)[order]
        dec = decimate(np.asarray(x, dtype=float), np.asarray(y, dtype=float), body.pixels)
        out.append(
            PlotSeries(**base, x=dec.x.tolist(), min=dec.y_min.tolist(), max=dec.y_max.tolist())
        )
    return out


class ScalarInfo(BaseModel):
    name: str
    family: str = ""  # sweep point ("R=2k") of a family member
    value: float
    unit: str
    phase_deg: float | None = None
    socket: str = ""  # the input it came in by


class TableInfo(BaseModel):
    name: str
    columns: list[str]
    units: list[str]
    rows: list[list[float | str]]


@router.get("/projects/{project_id}/graphs/{name}/nodes/{node_id}/table")
def node_table(project_id: str, name: str, node_id: str, state: State) -> TableInfo | None:
    """The table shown by a Table node (None when it shows plain values)."""
    table = _node_inputs(state, project_id, name, node_id).get("table")
    if not isinstance(table, TableValue):
        return None
    return TableInfo(name=table.name, columns=table.columns, units=table.units, rows=table.rows)


@router.get("/projects/{project_id}/graphs/{name}/nodes/{node_id}/values")
def node_values(project_id: str, name: str, node_id: str, state: State) -> list[ScalarInfo]:
    """Numbers shown by a Value or Table node (its inputs; ``socket`` = the input)."""
    return _scalars(_node_inputs(state, project_id, name, node_id))


@router.get("/projects/{project_id}/graphs/{name}/nodes/{node_id}/outputs")
def node_outputs(project_id: str, name: str, node_id: str, state: State) -> list[ScalarInfo]:
    """Numbers a node gave (``socket`` = the output), e.g. an Equation's result."""
    _node_inputs(state, project_id, name, node_id)  # (checks it has results)
    result = state.graphs.get(project_id, name).results[node_id]
    return _scalars(dict(result.outputs))


def _scalars(values: dict[str, Any]) -> list[ScalarInfo]:
    out: list[ScalarInfo] = []
    for socket, value in values.items():
        for label, item in _flatten(value if isinstance(value, list) else [value]):
            if isinstance(item, ScalarValue):
                out.append(ScalarInfo(name=item.name, value=item.value, unit=item.unit,
                                      phase_deg=item.phase_deg, family=label,
                                      socket=socket))  # fmt: skip
    return out
