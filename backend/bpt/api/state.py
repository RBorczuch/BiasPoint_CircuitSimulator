"""Application state: open projects, the analysis orchestrator and the event bus."""

import json
import logging
import shutil
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from platformdirs import user_cache_path

from bpt import APP_NAME
from bpt.analysis.orchestrator import Job, Orchestrator
from bpt.api.events import EventBus
from bpt.api.files import remember
from bpt.api.security import request_origin
from bpt.document.commands import AnyCommand
from bpt.document.ids import safe_id
from bpt.document.model import Project, Sheet
from bpt.document.recovery import Recovery, RecoveryInfo
from bpt.document.session import DocumentSession
from bpt.document.snapshots import Snapshots
from bpt.document.storage import load_project, save_project
from bpt.engines.base import Engine
from bpt.graph.service import GraphService
from bpt.results.store import ResultStore, RunReader

RESULTS_DIR = "results"
AUTOSAVE_SECONDS = 3.0
SCRATCH_DAYS = 7.0  # results of unsaved, unrecoverable projects are deleted after this
AGENT_PAUSE_SECONDS = 120.0  # agent changes closer together than this share one snapshot
OPEN_FILE = "open.json"  # saved projects open at the last autosave (reopened by --dev)

log = logging.getLogger(__name__)


@dataclass
class OpenProject:
    id: str
    session: DocumentSession
    path: Path | None = None
    saved_revision: int = 0
    _scratch: Path = field(default_factory=Path)
    agent_burst: float | None = None  # monotonic time of the agent's last change in a series

    @property
    def results(self) -> ResultStore:
        base = self.path if self.path is not None else self._scratch
        return ResultStore(base / RESULTS_DIR)

    @property
    def dirty(self) -> bool:
        return self.session.revision != self.saved_revision


class AppState:
    def __init__(
        self, engine: Engine, scratch_root: Path | None = None, recovery_root: Path | None = None
    ) -> None:
        self.bus = EventBus()
        self.orchestrator = Orchestrator(engine, on_change=self._job_changed)
        self.graphs = GraphService(self.orchestrator, self.bus.publish)
        self.projects: dict[str, OpenProject] = {}
        self.scratch_root = scratch_root or user_cache_path(APP_NAME, appauthor=False) / "scratch"
        self._lock = threading.Lock()
        self.recovery = Recovery(recovery_root)
        self.snapshots = Snapshots(recovery_root / "snapshots" if recovery_root else None)
        self._autosaved: dict[str, int] = {}  # project id -> revision of its recovery copy
        self._stop = threading.Event()
        self._autosaver: threading.Thread | None = None
        self._open_written = ""

    # -- projects -------------------------------------------------------------------------
    def register(self, project: Project, path: Path | None) -> OpenProject:
        open_project = OpenProject(
            id=str(project.id),
            session=DocumentSession(project),
            path=path,
            _scratch=self.scratch_root / str(project.id),
        )

        def changed(revision: int, command: AnyCommand) -> None:
            self.bus.publish({
                "type": "doc.changed",
                "project_id": open_project.id,
                "revision": revision,
                "command": command.model_dump(mode="json"),
            })  # fmt: skip

        open_project.session.subscribe(changed)
        open_project.session.before_change = lambda: self._before_change(open_project)
        open_project.session.origin = request_origin.get
        with self._lock:
            self.projects[open_project.id] = open_project
        return open_project

    def new_project(self, name: str) -> OpenProject:
        return self.register(Project(name=name, sheets=[Sheet(name="root")]), None)

    def open_project(self, path: Path) -> OpenProject:
        for existing in self.projects.values():
            if existing.path is not None and existing.path.resolve() == path.resolve():
                return existing
        opened = self.register(load_project(path), path)
        remember(path)
        return opened

    def save_project(self, project_id: str, path: Path | None = None) -> OpenProject:
        open_project = self.get(project_id)
        target = path or open_project.path
        if target is None:
            raise ValueError("project has no path yet; pass one")
        save_project(open_project.session.project, target)
        open_project.path = target
        open_project.saved_revision = open_project.session.revision
        remember(target)
        self._forget_copy(project_id)
        return open_project

    def close_project(self, project_id: str) -> None:
        with self._lock:
            self.projects.pop(project_id, None)
        self._forget_copy(project_id)
        self.graphs.forget(project_id)  # its results in memory (those on disk stay)

    def _before_change(self, p: OpenProject) -> None:
        """Snapshot the project before a series of agent changes (one per series)."""
        if request_origin.get() != "agent":
            p.agent_burst = None  # the user acted: the agent's next change starts a new series
            return
        now = time.monotonic()
        if p.agent_burst is None or now - p.agent_burst > AGENT_PAUSE_SECONDS:
            try:  # called under the session lock: the project is consistent
                self.snapshots.take(
                    p.session.project, p.session.revision, "Before AI agent changes", "agent"
                )
            except OSError:
                log.exception("snapshot of %s failed", p.id)
        p.agent_burst = now

    # -- autosave and recovery ------------------------------------------------------------
    def _forget_copy(self, project_id: str) -> None:
        self._autosaved.pop(project_id, None)
        self.recovery.discard(project_id)

    def autosave(self) -> int:
        """Write recovery copies of projects changed since their last copy; returns how many."""
        written = 0
        for p in list(self.projects.values()):
            if not p.dirty:
                if p.id in self._autosaved:  # saved, or undone back to the saved state
                    self._forget_copy(p.id)
                continue
            if self._autosaved.get(p.id) == p.session.revision:
                continue
            revision, copy = p.session.snapshot()
            try:
                self.recovery.write(copy, revision, p.path)
            except OSError:
                log.exception("autosave of %s failed", p.id)
                continue
            if p.id not in self.projects:  # closed while the copy was written
                self.recovery.discard(p.id)
                continue
            self._autosaved[p.id] = revision
            written += 1
        opened = [
            {"id": p.id, "path": str(p.path)}
            for p in self.projects.values()
            if p.path is not None and not p.dirty
        ]
        text = json.dumps(opened)
        if text != self._open_written:
            try:
                self.recovery.root.mkdir(parents=True, exist_ok=True)
                (self.recovery.root / OPEN_FILE).write_text(text, encoding="utf-8")
                self._open_written = text
            except OSError:
                pass
        return written

    def recoverable(self) -> list[RecoveryInfo]:
        """Recovery copies of projects that are not open (left by a crash or a restart)."""
        return [e for e in self.recovery.entries() if e.id not in self.projects]

    def restore(self, project_id: str) -> OpenProject:
        """Open a recovery copy under its old id and path; it stays unsaved until saved."""
        if project_id in self.projects:
            return self.projects[project_id]
        info, project = self.recovery.load(project_id)
        opened = self.register(project, Path(info.path) if info.path else None)
        opened.saved_revision = -1  # dirty until saved
        self._autosaved[project_id] = -1  # the copy on disk is current
        return opened

    def clean_scratch(self, max_age_days: float = SCRATCH_DAYS) -> int:
        """Delete results of unsaved projects nobody can reopen (no recovery copy) and not
        used for ``max_age_days``. Returns how many folders went."""
        if not self.scratch_root.is_dir():
            return 0
        keep = {entry.id for entry in self.recovery.entries()} | set(self.projects)
        cutoff = time.time() - max_age_days * 86400
        removed = 0
        for folder in self.scratch_root.iterdir():
            try:
                stale = (
                    folder.is_dir() and folder.name not in keep and folder.stat().st_mtime < cutoff
                )
            except OSError:
                continue
            if stale:
                shutil.rmtree(folder, ignore_errors=True)
                removed += 1
        return removed

    def restore_all(self) -> list[OpenProject]:
        """Reopen everything the last run had open: recovery copies and saved projects."""
        restored = []
        for entry in self.recoverable():
            try:
                restored.append(self.restore(entry.id))
            except (OSError, ValueError):
                log.exception("cannot restore %s", entry.id)
        try:
            opened = json.loads((self.recovery.root / OPEN_FILE).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            opened = []
        for item in opened:
            if item["id"] in self.projects:
                continue
            try:
                restored.append(self.open_project(Path(item["path"])))
            except (OSError, ValueError):
                continue
        return restored

    def start_autosave(self, interval: float = AUTOSAVE_SECONDS) -> None:
        def loop() -> None:
            while not self._stop.wait(interval):
                try:
                    self.autosave()
                except Exception:  # never let the saver die
                    log.exception("autosave failed")

        self._stop.clear()
        self._autosaver = threading.Thread(target=loop, name="autosave", daemon=True)
        self._autosaver.start()

    def stop_autosave(self) -> None:
        self._stop.set()
        if self._autosaver is not None:
            self._autosaver.join(timeout=5)
            self._autosaver = None
        self.autosave()  # last copy on a clean shutdown

    def get(self, project_id: str) -> OpenProject:
        try:
            return self.projects[project_id]
        except KeyError:
            raise KeyError(f"no open project {project_id}") from None

    # -- runs -----------------------------------------------------------------------------
    def job_for_run(self, run_id: str) -> Job | None:
        for job in self.orchestrator.jobs.values():
            if job.run_id == run_id or job.job_id == run_id:
                return job
        return None

    def open_run(self, run_id: str) -> RunReader:
        safe_id(run_id, "run id")
        job = self.job_for_run(run_id)
        if job is not None and job.run_id is not None:
            return job.store.open(job.run_id)
        for project in self.projects.values():
            if (project.results.root / run_id / "meta.json").is_file():
                return project.results.open(run_id)
        raise KeyError(f"no run {run_id}")

    def _job_changed(self, job: Job) -> None:
        finished = job.status in ("ok", "error", "cancelled")
        if job.status == "ok" and job.origin == "user":  # not in the middle of a graph's runs
            job.store.prune()
        self.bus.publish({
            "type": "run.finished" if finished else "run.progress",
            "job_id": job.job_id,
            "project_id": job.project_id,
            "run_id": job.run_id,
            "status": job.status,
            "progress": job.progress,
            "error": job.error,
            "origin": job.origin,
        })  # fmt: skip
