"""Several engines behind one: independent runs (sweep points) simulate in parallel.

ngspice keeps global state per process, so parallel runs need one worker process each. Engines
are created on first use (a pool of 4 costs nothing until a sweep needs it) and reused.
"""

import os
import queue
import threading
from collections.abc import Callable

from bpt.analysis.spec import AnalysisSpec
from bpt.engines.base import Engine, ProgressCallback
from bpt.netlist.ir import CircuitIR
from bpt.results.store import ResultStore, RunMeta


def default_size() -> int:
    """Cores minus one (the UI and the backend need some), at least 1, at most 4."""
    return max(1, min(4, (os.cpu_count() or 2) - 1))


class EnginePool:
    def __init__(self, factory: Callable[[], Engine], size: int | None = None) -> None:
        self.size = size or default_size()
        self._factory = factory
        self._idle: queue.LifoQueue[Engine] = queue.LifoQueue()  # warm engines first
        self._created: list[Engine] = []
        self._lock = threading.Lock()
        self._slots = threading.Semaphore(self.size)
        first = factory()
        self.name = first.name
        self._created.append(first)
        self._idle.put(first)

    def capabilities(self) -> set[str]:
        return self._created[0].capabilities()

    def _acquire(self) -> Engine:
        self._slots.acquire()
        try:
            return self._idle.get_nowait()
        except queue.Empty:
            with self._lock:
                engine = self._factory()
                self._created.append(engine)
                return engine

    def run(
        self,
        circuit: CircuitIR,
        analysis: AnalysisSpec,
        store: ResultStore,
        on_progress: ProgressCallback | None = None,
        cancel: threading.Event | None = None,
    ) -> RunMeta:
        engine = self._acquire()
        try:
            return engine.run(circuit, analysis, store, on_progress, cancel)
        finally:
            self._idle.put(engine)
            self._slots.release()

    def close(self) -> None:
        for engine in self._created:
            close = getattr(engine, "close", None)
            if callable(close):
                close()
