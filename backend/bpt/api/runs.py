"""Analysis runs: start, status, cancel, summaries, measurements and plot queries."""

import json
import struct
from collections.abc import Callable
from typing import Any, Literal

import numpy as np
from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

from bpt.analysis.estimate import RunEstimate, estimate
from bpt.analysis.orchestrator import Job, JobStatus
from bpt.analysis.spec import AnalysisSpec
from bpt.analysis.stress import StressReport
from bpt.api.projects import State, _project
from bpt.api.security import attachment
from bpt.api.state import OpenProject
from bpt.document.model import option_lines
from bpt.graph import dsp
from bpt.io.csv_export import export_csv
from bpt.netlist.netlister import netlist_project
from bpt.netlist.spice_parser import SpiceSyntaxError, parse_analysis_card
from bpt.results.calculator import ExpressionError, evaluate, is_plain_signal
from bpt.results.decimate import decimate
from bpt.results.store import RunMeta, RunReader
from bpt.results.summary import summarize

router = APIRouter(prefix="/api", tags=["runs"])


class JobInfo(BaseModel):
    job_id: str
    project_id: str
    status: JobStatus
    run_id: str | None
    progress: str
    error: str | None
    issues: list[dict[str, object]]


def _job_info(job: Job) -> JobInfo:
    return JobInfo(
        job_id=job.job_id,
        project_id=job.project_id,
        status=job.status,
        run_id=job.run_id,
        progress=job.progress,
        error=job.error,
        issues=[{"severity": i.severity, "code": i.code, "message": i.message, "refs": i.refs}
                for i in job.issues],
    )  # fmt: skip


class RunBody(BaseModel):
    analysis: AnalysisSpec | None = None
    card: str | None = Field(default=None, description='SPICE card, e.g. ".tran 10u 5m"')
    voltages_only: bool = False  # no device currents (smaller results for big runs)


def _analysis_of(p: OpenProject, body: RunBody) -> AnalysisSpec:
    """The spec, the card, or the project's active analysis."""
    if body.analysis is not None:
        return body.analysis
    simulation = p.session.project.simulation
    card = body.card or simulation.cards.get(simulation.active, ".op")
    try:
        return parse_analysis_card(card)
    except SpiceSyntaxError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/projects/{project_id}/analyses/run")
def run_analysis(project_id: str, body: RunBody, state: State) -> JobInfo:
    """Start an analysis given as a spec or a SPICE card (default: the project's active one)."""
    p = _project(state, project_id)
    project = p.session.project
    job = state.orchestrator.submit(p.id, project, _analysis_of(p, body), p.results,
                                    voltages_only=body.voltages_only,
                                    options=option_lines(project.simulation))  # fmt: skip
    return _job_info(job)


@router.post("/projects/{project_id}/analyses/estimate")
def estimate_analysis(project_id: str, body: RunBody, state: State) -> RunEstimate:
    """Points, signals and bytes the run would write (asked before a big run)."""
    p = _project(state, project_id)
    circuit = netlist_project(p.session.project).circuit
    circuit.save_currents = not body.voltages_only
    return estimate(circuit, _analysis_of(p, body))


class Values(BaseModel):
    values: dict[str, float]


@router.get("/runs/{run_id}/values")
def run_values(run_id: str, state: State) -> Values:
    """Final (operating point) value of every real signal."""
    run = _run(state, run_id)
    values: dict[str, float] = {}
    for info in run.meta.signals:
        data = run.signal(info.name)
        if not info.complex and len(data) and info.name != run.meta.scale:
            values[info.name] = float(data[-1])
    return Values(values=values)


@router.get("/jobs/{job_id}")
def job_status(job_id: str, state: State) -> JobInfo:
    job = state.orchestrator.jobs.get(job_id)
    if job is None:
        raise HTTPException(404, f"no job {job_id}")
    return _job_info(job)


@router.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: str, state: State) -> JobInfo:
    if job_id not in state.orchestrator.jobs:
        raise HTTPException(404, f"no job {job_id}")
    return _job_info(state.orchestrator.cancel(job_id))


@router.get("/projects/{project_id}/runs")
def list_runs(project_id: str, state: State) -> list[RunMeta]:
    store = _project(state, project_id).results
    metas = [store.open(run_id).meta for run_id in store.list_runs()]
    for meta in metas:
        meta.log = []  # keep listings small
    return metas


def _run(state: State, run_id: str) -> RunReader:
    try:
        return state.open_run(run_id)
    except (KeyError, OSError) as exc:
        raise HTTPException(404, f"no run {run_id}") from exc


@router.get("/runs/{run_id}")
def run_meta(run_id: str, state: State) -> RunMeta:
    return _run(state, run_id).meta


class Summary(BaseModel):
    text: str


@router.get("/runs/{run_id}/summary")
def run_summary(run_id: str, state: State, signals: str | None = None) -> Summary:
    names = [s.strip() for s in signals.split(",")] if signals else None
    try:
        return Summary(text=summarize(_run(state, run_id), names))
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc


def _series(run: RunReader, name: str) -> tuple[np.ndarray, str]:
    """A stored signal or a calculator expression over the run; returns (values, unit)."""
    if is_plain_signal(run, name):
        return np.asarray(run.signal(name)), run.meta.signal(name).unit
    try:
        value = evaluate(run, name)
    except ExpressionError as exc:
        raise HTTPException(422, f"{name}: {exc}") from exc
    if value.ndim == 0 and run.meta.scale:
        value = np.full(len(run.signal(run.meta.scale)), value)
    return np.atleast_1d(value), ""


class MeasureBody(BaseModel):
    signal: str
    op: Literal["value", "at", "min", "max", "avg", "rms", "pp", "final"] = "final"
    at: float | None = Field(default=None, description="x value for op='at'")
    db: bool = Field(default=False, description="AC: return magnitude in dB")


class Measurement(BaseModel):
    value: float
    phase_deg: float | None = None
    unit: str


@router.post("/runs/{run_id}/measure")
def measure(run_id: str, body: MeasureBody, state: State) -> Measurement:
    run = _run(state, run_id)
    y, unit = _series(run, body.signal)
    is_complex = bool(np.iscomplexobj(y))
    x = np.real(np.asarray(run.signal(run.meta.scale))) if run.meta.scale else None
    if body.op == "at":
        if x is None or body.at is None:
            raise HTTPException(422, "op 'at' needs a swept analysis and an 'at' value")
        value: complex = complex(
            dsp.interp(body.at, x, y.real) + 1j * dsp.interp(body.at, x, y.imag)
        )
    elif y.size == 0:
        raise HTTPException(422, f"{body.signal} has no points")
    elif body.op in ("value", "final"):
        value = complex(y[-1])
    else:
        mag = np.abs(y) if is_complex else np.real(y)
        if body.op == "avg" and x is not None and len(x) > 1:
            value = complex(np.trapezoid(mag, x) / (x[-1] - x[0]))
        elif body.op == "rms" and x is not None and len(x) > 1:
            value = complex(np.sqrt(np.trapezoid(mag**2, x) / (x[-1] - x[0])))
        else:
            reducers: dict[str, Callable[[np.ndarray], Any]] = {
                "min": np.min,
                "max": np.max,
                "avg": np.mean,
                "pp": np.ptp,
                "rms": lambda v: np.sqrt(np.mean(v**2)),
            }
            value = complex(reducers[body.op](mag))
    if is_complex or body.db:
        magnitude = abs(value)
        return Measurement(
            value=float(20 * np.log10(max(magnitude, 1e-15))) if body.db else magnitude,
            phase_deg=float(np.degrees(np.angle(value))),
            unit="dB" if body.db else unit,
        )
    return Measurement(value=float(value.real), unit=unit)


class QueryBody(BaseModel):
    signals: list[str]
    pixels: int = Field(default=1000, ge=1, le=20000)
    x_min: float | None = None
    x_max: float | None = None
    format: Literal["json", "binary"] = "json"


@router.post("/runs/{run_id}/query", response_model=None)
def query(run_id: str, body: QueryBody, state: State) -> Response | dict[str, object]:
    """Plot data, decimated to ``pixels`` min/max columns.

    JSON: ``{"x": [...], "series": {name: {"min": [...], "max": [...]}}}``; complex signals
    give ``{"re": [...], "im": [...]}`` (not decimated: AC sweeps are small).
    Binary: ``[u32 header length][header JSON][float64 arrays in header order]``.
    """
    run = _run(state, run_id)
    if run.meta.scale is None:
        raise HTTPException(422, "operating point results have no x axis; use /summary")
    x = np.real(np.asarray(run.signal(run.meta.scale)))
    if run.meta.family is not None:
        return _query_family(run, x, body)
    series: dict[str, dict[str, np.ndarray]] = {}
    x_out: np.ndarray | None = None
    for name in body.signals:
        y, _unit = _series(run, name)
        if np.iscomplexobj(y):
            lo = 0 if body.x_min is None else int(np.searchsorted(x, body.x_min))
            hi = len(x) if body.x_max is None else int(np.searchsorted(x, body.x_max, "right"))
            series[name] = {"re": y.real[lo:hi].copy(), "im": y.imag[lo:hi].copy()}
            x_out = x[lo:hi] if x_out is None else x_out
        else:
            dec = decimate(x, np.real(y), body.pixels, body.x_min, body.x_max)
            series[name] = {"min": dec.y_min, "max": dec.y_max}
            x_out = dec.x
    if x_out is None:
        raise HTTPException(422, "no signals to plot")
    if body.format == "json":
        lists = {n: {k: v.tolist() for k, v in s.items()} for n, s in series.items()}
        return {"x": x_out.tolist(), "series": lists}
    arrays = [("x", "", x_out)] + [(n, k, v) for n, s in series.items() for k, v in s.items()]
    header = json.dumps({"arrays": [{"signal": n, "part": k, "length": len(v)}
                                    for n, k, v in arrays]}).encode()  # fmt: skip
    payload = b"".join(np.ascontiguousarray(v, dtype="<f8").tobytes() for _n, _k, v in arrays)
    return Response(struct.pack("<I", len(header)) + header + payload,
                    media_type="application/octet-stream")  # fmt: skip


def _query_family(run: RunReader, x: np.ndarray, body: QueryBody) -> Response | dict[str, object]:
    """A run of several curves (DC sweep with a second source): each signal's curves decimated
    on the shared x axis of one curve. JSON: ``series[name] = {"members": [{"min", "max"}...]}``
    and ``family`` (name, unit, values); binary parts are ``min.k`` / ``max.k``."""
    family = run.meta.family
    assert family is not None
    n = family.length
    blocks = range(len(x) // n)
    series: dict[str, list[dict[str, np.ndarray]]] = {}
    x_out = x[:n]
    for name in body.signals:
        y = np.real(_series(run, name)[0])
        series[name] = []
        for k in blocks:
            part = slice(k * n, (k + 1) * n)
            dec = decimate(x[part], y[part], body.pixels, body.x_min, body.x_max)
            series[name].append({"min": dec.y_min, "max": dec.y_max})
            x_out = dec.x
    info = family.model_dump()
    if body.format == "json":
        lists = {name: {"members": [{k: v.tolist() for k, v in m.items()} for m in members]}
                 for name, members in series.items()}  # fmt: skip
        return {"x": x_out.tolist(), "series": lists, "family": info}
    arrays = [("x", "", x_out)] + [(name, f"{key}.{k}", values)
                                   for name, members in series.items()
                                   for k, member in enumerate(members)
                                   for key, values in member.items()]  # fmt: skip
    header = json.dumps({"family": info, "arrays": [{"signal": n_, "part": k, "length": len(v)}
                                                    for n_, k, v in arrays]}).encode()  # fmt: skip
    payload = b"".join(np.ascontiguousarray(v, dtype="<f8").tobytes() for _n, _k, v in arrays)
    return Response(struct.pack("<I", len(header)) + header + payload,
                    media_type="application/octet-stream")  # fmt: skip


class ExportBody(BaseModel):
    path: str
    signals: list[str] | None = None


@router.post("/runs/{run_id}/export")
def export(run_id: str, body: ExportBody, state: State) -> Summary:
    from pathlib import Path

    target = Path(body.path).expanduser()
    # Any folder (it is the user's "save as"), but only a table file: not a way to overwrite
    # a program or a configuration file.
    if target.suffix.lower() not in (".csv", ".tsv", ".txt"):
        target = target.with_name(target.name + ".csv")
    try:
        export_csv(_run(state, run_id), target, body.signals)
    except (OSError, KeyError) as exc:
        raise HTTPException(400, str(exc)) from exc
    return Summary(text=f"wrote {target}")


@router.get("/runs/{run_id}/csv")
def download_csv(run_id: str, state: State, signals: str | None = None) -> Response:
    """CSV of a run as a browser download."""
    import tempfile
    from pathlib import Path

    names = [s.strip() for s in signals.split(",")] if signals else None
    with tempfile.TemporaryDirectory() as folder:
        target = Path(folder) / "run.csv"
        try:
            export_csv(_run(state, run_id), target, names)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        data = target.read_bytes()
    return Response(data, media_type="text/csv", headers=attachment(f"{run_id}.csv"))


@router.get("/projects/{project_id}/runs/{run_id}/stress")
def run_stress(project_id: str, run_id: str, state: State) -> StressReport:
    """How much of its ratings each part uses in the run (FR-SIM-7)."""
    from bpt.analysis.stress import stress_report

    project = _project(state, project_id).session.project
    return stress_report(project, _run(state, run_id))
