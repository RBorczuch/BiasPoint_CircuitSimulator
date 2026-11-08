"""Runs analysis graphs in the background and keeps their latest results per project."""

import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any

from bpt.analysis.orchestrator import Orchestrator
from bpt.analysis.spec import AnalysisSpec
from bpt.document.model import Graph, Project
from bpt.results.store import ResultStore, RunReader

from .catalog import NodeError, upgrade
from .diskcache import DiskCache
from .executor import CancelledError, NodeResult, NodeState, ResultCache, execute

Publish = Callable[[dict[str, Any]], None]


@dataclass
class GraphRun:
    status: str = "idle"  # idle, running, done
    cancel: threading.Event = field(default_factory=threading.Event)
    results: dict[str, NodeResult] = field(default_factory=dict)


class _Context:
    def __init__(
        self,
        project: Project,
        project_id: str,
        store: ResultStore,
        orchestrator: Orchestrator,
        cancel: threading.Event,
    ) -> None:
        self.project = project
        self._project_id = project_id
        self._store = store
        self._orchestrator = orchestrator
        self._cancel = cancel

    def simulate(self, project: Project, analysis: AnalysisSpec) -> RunReader:
        job = self._orchestrator.submit(
            self._project_id, project, analysis, self._store, origin="graph"
        )
        while not job.done.wait(0.1):
            if self._cancel.is_set():
                self._orchestrator.cancel(job.job_id)
        if job.status == "cancelled":
            raise CancelledError
        if job.run_id is None:
            raise NodeError(job.error or "simulation did not start")
        return self._store.open(job.run_id)

    def open_run(self, run_id: str) -> RunReader:
        try:
            return self._store.open(run_id)
        except (KeyError, OSError) as exc:
            raise NodeError(f"results of run {run_id} are gone; run the graph again") from exc


class GraphService:
    def __init__(self, orchestrator: Orchestrator, publish: Publish) -> None:
        self._orchestrator = orchestrator
        self._publish = publish
        self._runs: dict[tuple[str, str], GraphRun] = {}
        self._caches: dict[str, ResultCache] = {}
        self._executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="bpt-graph")

    def run(
        self,
        project_id: str,
        project: Project,
        graph: Graph,
        store: ResultStore,
        restore: bool = False,
    ) -> GraphRun:
        """Run ``graph`` in the background; ``restore``: only what the caches (memory, disk) have,
        no simulations (a graph opened again)."""
        key = (project_id, graph.name)
        previous = self._runs.get(key)
        if previous is not None and previous.status == "running":
            previous.cancel.set()
        run = GraphRun(status="running", results=dict(previous.results) if previous else {})
        self._runs[key] = run
        cache = self._caches.setdefault(project_id, ResultCache())
        ctx = _Context(
            project.model_copy(deep=True), project_id, store, self._orchestrator, run.cancel
        )
        snapshot = graph.model_copy(deep=True)
        upgrade(snapshot)  # a node sent by an older client: its parameters as its type has them

        def emit(node_id: str, state: NodeState) -> None:
            self._publish({"type": "graph.node", "project_id": project_id, "graph": graph.name,
                           "node": node_id, "state": state.model_dump(mode="json")})  # fmt: skip

        def work() -> None:
            try:
                # Filled node by node (the previous run's results until each is redone).
                execute(snapshot, ctx, cache, emit, run.cancel, run.results,
                        DiskCache(store.root), restore)  # fmt: skip
            finally:
                run.status = "done"
                self._publish(
                    {"type": "graph.finished", "project_id": project_id, "graph": graph.name}
                )

        self._executor.submit(work)
        return run

    def restore(
        self, project_id: str, project: Project, graph: Graph, store: ResultStore
    ) -> GraphRun:
        """The graph's results; the first time in a session, what the caches have of them."""
        run = self._runs.get((project_id, graph.name))
        return run if run is not None else self.run(project_id, project, graph, store, True)

    def get(self, project_id: str, name: str) -> GraphRun:
        return self._runs.get((project_id, name)) or GraphRun()

    def cancel(self, project_id: str, name: str) -> None:
        run = self._runs.get((project_id, name))
        if run is not None:
            run.cancel.set()

    def forget(self, project_id: str) -> None:
        """Drop a closed project's runs and memory cache (stopping what still runs)."""
        for key in [k for k in self._runs if k[0] == project_id]:
            self._runs.pop(key).cancel.set()
        self._caches.pop(project_id, None)

    def shutdown(self) -> None:
        for run in self._runs.values():
            run.cancel.set()
        self._executor.shutdown(wait=False, cancel_futures=True)
