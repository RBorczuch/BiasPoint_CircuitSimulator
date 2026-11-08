"""Engine interface shared by ngspice and the native engine."""

import threading
from collections.abc import Callable
from typing import Protocol

from bpt.analysis.spec import AnalysisSpec
from bpt.netlist.ir import CircuitIR
from bpt.results.store import ResultStore, RunMeta

ProgressCallback = Callable[[str], None]


class Engine(Protocol):
    name: str

    def capabilities(self) -> set[str]:
        """Analysis kinds this engine can run (``op``, ``dc``, ``ac``, ``tran``, ...)."""
        ...

    def run(
        self,
        circuit: CircuitIR,
        analysis: AnalysisSpec,
        store: ResultStore,
        on_progress: ProgressCallback | None = None,
        cancel: threading.Event | None = None,
    ) -> RunMeta:
        """Simulate and store results; never raises for simulation failures (see status)."""
        ...
