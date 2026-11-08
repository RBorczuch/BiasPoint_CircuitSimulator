"""Runs analyses in the background and tracks their state."""

import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Literal

from bpt.analysis.spec import AnalysisSpec
from bpt.document.ids import new_id
from bpt.document.model import Project
from bpt.engines.base import Engine
from bpt.netlist.erc import ErcIssue
from bpt.netlist.ir import CircuitIR
from bpt.netlist.netlister import netlist_project
from bpt.results.store import ResultStore

JobStatus = Literal["queued", "running", "ok", "error", "cancelled"]
JobListener = Callable[["Job"], None]


@dataclass
class Job:
    job_id: str
    project_id: str
    analysis: AnalysisSpec
    store: ResultStore
    status: JobStatus = "queued"
    run_id: str | None = None
    progress: str = ""
    error: str | None = None
    issues: list[ErcIssue] = field(default_factory=list)
    cancel: threading.Event = field(default_factory=threading.Event)
    done: threading.Event = field(default_factory=threading.Event)
    origin: str = "user"  # "graph": started by an analysis graph (the viewer ignores it)


class Orchestrator:
    def __init__(self, engine: Engine, on_change: JobListener | None = None) -> None:
        self.engine = engine
        self.on_change = on_change
        self.jobs: dict[str, Job] = {}
        # As many runs at once as the engine can take (a pool of ngspice workers: several).
        workers = getattr(engine, "size", 1)
        self._executor = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="bpt-sim")

    def _notify(self, job: Job) -> None:
        if job.status in ("ok", "error", "cancelled"):
            job.done.set()
        if self.on_change is not None:
            self.on_change(job)

    def submit(
        self,
        project_id: str,
        project: Project,
        analysis: AnalysisSpec,
        store: ResultStore,
        origin: str = "user",
        voltages_only: bool = False,
        options: list[str] | None = None,
    ) -> Job:
        """Netlist a snapshot of ``project`` now and simulate it in the background.

        ``voltages_only``: no device currents (a run too big to save them all); ``options``:
        directives for the run (``.options temp=50 reltol=1e-4`` from Simulate).
        """
        job = Job(
            job_id=str(new_id()),
            project_id=project_id,
            analysis=analysis,
            store=store,
            origin=origin,
        )
        self.jobs[job.job_id] = job
        try:
            result = netlist_project(project.model_copy(deep=True))
        except Exception as exc:  # a bug in the netlister must not leave the job "queued"
            job.status, job.error = "error", f"cannot make the netlist: {exc}"
            self._notify(job)
            return job
        result.circuit.save_currents = not voltages_only
        result.circuit.directives += options or []
        job.issues = result.issues
        if not result.circuit.devices:
            job.issues = [
                ErcIssue.error(
                    "empty-circuit", "nothing to simulate: the schematic has no parts", []
                )
            ]
        if any(i.severity == "error" for i in job.issues):
            job.status = "error"
            job.error = "; ".join(i.message for i in job.issues if i.severity == "error")
            self._notify(job)
            return job
        self._executor.submit(self._run, job, result.circuit)
        self._notify(job)
        return job

    def _run(self, job: Job, circuit: CircuitIR) -> None:
        if job.cancel.is_set():
            job.status = "cancelled"
            self._notify(job)
            return
        job.status = "running"
        self._notify(job)

        def progress(text: str) -> None:
            job.progress = text
            self._notify(job)

        try:
            meta = self.engine.run(circuit, job.analysis, job.store, progress, job.cancel)
            job.run_id, job.status, job.error = meta.run_id, meta.status, meta.error
        except Exception as exc:  # never lose a job silently
            job.status, job.error = "error", f"{type(exc).__name__}: {exc}"
        self._notify(job)

    def cancel(self, job_id: str) -> Job:
        job = self.jobs[job_id]
        job.cancel.set()
        return job

    def shutdown(self) -> None:
        for job in self.jobs.values():
            job.cancel.set()
        self._executor.shutdown(wait=True, cancel_futures=True)
        close = getattr(self.engine, "close", None)
        if callable(close):
            close()
