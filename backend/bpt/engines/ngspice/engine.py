"""ngspice engine: runs jobs in a long-lived, restartable worker process."""

import multiprocessing as mp
import threading
import time
from multiprocessing.connection import Connection
from multiprocessing.process import BaseProcess
from pathlib import Path
from typing import cast

from bpt.analysis.spec import AnalysisSpec
from bpt.engines.base import ProgressCallback
from bpt.engines.ngspice.locate import NgspiceNotFoundError, find_library
from bpt.engines.ngspice.worker import worker_main
from bpt.netlist.ir import CircuitIR, Device
from bpt.netlist.ngspice_writer import write_netlist
from bpt.results.derived import add_ac_currents
from bpt.results.store import ResultStore, RunMeta, RunStatus

_POLL_S = 0.05
_START_TIMEOUT_S = 30.0
_MAX_JOBS_PER_WORKER = 200  # restart periodically: ngspice leaks a little per run


class EngineUnavailableError(RuntimeError):
    """The ngspice worker could not be started."""


class NgspiceEngine:
    name = "ngspice"

    def __init__(self, library: Path | None = None, timeout_s: float = 600.0) -> None:
        self.library = library
        self.timeout_s = timeout_s
        self.version = ""
        self._lock = threading.Lock()
        self._process: BaseProcess | None = None
        self._conn: Connection | None = None
        self._jobs = 0

    def capabilities(self) -> set[str]:
        return {"op", "dc", "ac", "tran"}

    def _start(self) -> Connection:
        library = self.library or find_library()
        pipe_parent, child = mp.get_context("spawn").Pipe()
        parent = cast(Connection, pipe_parent)  # PipeConnection on Windows
        process = mp.get_context("spawn").Process(
            target=worker_main, args=(child, str(library)), daemon=True, name="bpt-ngspice"
        )
        process.start()
        child.close()
        if not parent.poll(_START_TIMEOUT_S):
            process.kill()
            raise EngineUnavailableError("ngspice worker did not start")
        kind, payload = parent.recv()
        if kind != "ready":
            process.join()
            raise EngineUnavailableError(payload)
        self.version = payload
        self._process, self._conn, self._jobs = process, parent, 0
        return parent

    def _stop(self, kill: bool = False) -> None:
        if self._process is not None:
            if kill:
                self._process.kill()
            elif self._conn is not None:
                try:
                    self._conn.send(("stop",))
                except OSError:
                    self._process.kill()
            self._process.join(timeout=5)
            if self._process.is_alive():
                self._process.kill()
        self._process = self._conn = None

    def close(self) -> None:
        with self._lock:
            self._stop()

    def run(
        self,
        circuit: CircuitIR,
        analysis: AnalysisSpec,
        store: ResultStore,
        on_progress: ProgressCallback | None = None,
        cancel: threading.Event | None = None,
    ) -> RunMeta:
        writer = store.create(analysis)
        meta = writer.meta
        meta.engine = self.name
        with self._lock:
            if self._process is None or not self._process.is_alive():
                self._stop()
                try:
                    self._start()
                except (EngineUnavailableError, NgspiceNotFoundError, OSError) as exc:
                    # No library or no worker: a failed run, not an exception (Engine.run).
                    return self._failed(writer.directory, meta, "error", str(exc))
            assert self._conn is not None
            meta.engine_version = self.version
            nodes, branches = _hierarchy_names(circuit)
            job = {
                "lines": write_netlist(circuit, analysis),
                "run_dir": str(writer.directory),
                "meta": meta.model_dump_json(),
                "net_names": {**circuit.net_names, **nodes},
                "branches": {**{d.spice_name: d.ref for d in circuit.devices}, **branches},
                "models": _model_users(circuit),
            }
            self._conn.send(("run", job))
            self._jobs += 1
            deadline = time.monotonic() + self.timeout_s
            while True:
                if cancel is not None and cancel.is_set():
                    self._stop(kill=True)
                    return self._failed(writer.directory, meta, "cancelled", "cancelled by user")
                if time.monotonic() > deadline:
                    self._stop(kill=True)
                    return self._failed(
                        writer.directory, meta, "error", f"timed out after {self.timeout_s:g} s"
                    )
                try:
                    if not self._conn.poll(_POLL_S):
                        continue
                    kind, payload, *rest = self._conn.recv()
                except (EOFError, OSError):
                    self._stop(kill=True)
                    return self._failed(writer.directory, meta, "error", "ngspice worker crashed")
                if kind == "progress":
                    if on_progress is not None:
                        on_progress(payload)
                elif kind == "failed":  # an error in the worker itself (it exits)
                    self._stop(kill=True)
                    return self._failed(
                        writer.directory, meta, "error", f"ngspice worker: {payload}"
                    )
                elif kind == "done":
                    exiting = bool(rest and rest[0])
                    if exiting or self._jobs >= _MAX_JOBS_PER_WORKER:
                        self._stop()
                    result = RunMeta.model_validate_json(payload)
                    if result.status == "ok" and analysis.kind == "ac":
                        result = add_ac_currents(writer.directory, circuit, result)
                    return result

    @staticmethod
    def _failed(directory: Path, meta: RunMeta, status: RunStatus, error: str) -> RunMeta:
        meta.status, meta.error = status, error
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "meta.json").write_text(meta.model_dump_json(indent=2), encoding="utf-8")
        return meta


def _model_users(circuit: CircuitIR) -> dict[str, list[str]]:
    """Model name -> refs of the parts using it (links in the simulation log)."""
    users: dict[str, list[str]] = {}
    for device in circuit.devices:
        if device.model:
            users.setdefault(device.model, []).append(device.ref)
    return users


def _hierarchy_names(circuit: CircuitIR) -> tuple[dict[str, str], dict[str, str]]:
    """ngspice names inside blocks -> user names: node ``x1.mid`` -> ``X1.mid``, device
    ``r.x1.r1`` -> ``X1.R1`` (also ``v.x1.v1#branch``), nested blocks as ``x1.x2.…``."""
    subckts = {sub.name: sub for sub in circuit.subcircuits}
    nodes: dict[str, str] = {}
    branches: dict[str, str] = {}

    def walk(devices: list[Device], spice_path: str, user_path: str, depth: int) -> None:
        for device in devices:
            if device.element != "X" or depth > 20:
                continue
            sub = subckts.get(device.model or "")
            if sub is None:
                continue
            path = f"{spice_path}{device.spice_name.lower()}"
            user = f"{user_path}{device.ref}"
            for node, name in sub.net_names.items():
                if node not in sub.ports and node != "0":
                    nodes[f"{path}.{node}"] = f"{user}.{name}"
            for inner in sub.devices:
                branches[f"{inner.element.lower()}.{path}.{inner.spice_name.lower()}"] = (
                    f"{user}.{inner.ref}"
                )
            walk(sub.devices, f"{path}.", f"{user}.", depth + 1)

    walk(circuit.devices, "", "", 0)
    return nodes, branches
