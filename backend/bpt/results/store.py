"""Simulation result store.

A run is a directory ``<root>/<run_id>/``::

    meta.json           RunMeta (analysis, engine, status, signals, log)
    <step>/signals.f64  all signals one after another: little-endian float64,
                        complex = interleaved re/im; ``SignalInfo`` gives offset and length
                        (older runs: one ``sNNN.f64`` file per signal)

One file per run instead of one per signal: an operating point has hundreds of one-value
signals, and creating that many files took most of its time on Windows. Signals are
memory-mapped on read, so huge waveforms are never loaded as a whole.
"""

import shutil
import time
from datetime import UTC, datetime
from io import BufferedWriter
from pathlib import Path
from typing import Literal

import numpy as np
import numpy.typing as npt
from pydantic import BaseModel, Field, PrivateAttr

from bpt.analysis.spec import AnalysisSpec
from bpt.document.ids import new_id, safe_id

PACKED = "0/signals.f64"
RUNS_KEPT = 30  # finished runs kept per project
SMALL_FILE = 4 << 20  # bytes: read whole instead of memory-mapped
RunStatus = Literal["ok", "error", "cancelled"]
Severity = Literal["error", "warning", "info"]
Array = npt.NDArray[np.float64] | npt.NDArray[np.complex128]


class SignalInfo(BaseModel):
    name: str  # user-facing: "V(out)", "I(V1)", "time", "frequency", "sweep"
    unit: str = ""
    complex: bool = False
    file: str
    offset: int = 0  # bytes into ``file``
    length: int | None = None  # values; None = the whole file (runs before packing)


def read_signal(directory: Path, info: SignalInfo) -> Array:
    """Memory-mapped values of one signal of the run in ``directory``."""
    dtype = np.dtype("<c16" if info.complex else "<f8")
    path = directory / info.file
    length = info.length if info.length is not None else path.stat().st_size // dtype.itemsize
    if length == 0:
        return np.zeros(0, dtype=dtype)
    return np.memmap(path, dtype=dtype, mode="r", offset=info.offset, shape=(length,))


class LogMessage(BaseModel):
    severity: Severity
    text: str
    refs: list[str] = Field(default_factory=list)  # schematic parts the line mentions
    nets: list[str] = Field(default_factory=list)
    count: int = 1  # identical lines are merged


class RunFamily(BaseModel):
    """A run holding several curves one after another (DC sweep with a second source): each
    signal is ``len(values)`` blocks of ``length`` points, block k at ``name = values[k]``."""

    name: str  # what the second sweep varies: "IB", "R2", "TEMP"
    unit: str = ""
    values: list[float]
    length: int


class RunMeta(BaseModel):
    run_id: str
    created: datetime
    analysis: AnalysisSpec
    engine: str = ""
    engine_version: str = ""
    status: RunStatus = "ok"
    error: str | None = None
    duration_s: float = 0.0
    scale: str | None = None  # name of the x-axis signal (None for .op)
    points: int = 0
    signals: list[SignalInfo] = Field(default_factory=list)
    family: RunFamily | None = None  # several curves in one run
    log: list[str] = Field(default_factory=list)
    messages: list[LogMessage] = Field(default_factory=list)  # log without noise, classified

    # Lower-case name -> signal; rebuilt when signals are added (runs have thousands).
    _index: dict[str, SignalInfo] = PrivateAttr(default_factory=dict)

    def signal(self, name: str) -> SignalInfo:
        if len(self._index) != len(self.signals):
            self._index = {}
            for info in self.signals:
                self._index.setdefault(info.name.lower(), info)  # the first wins, as before
        found = self._index.get(name.lower())
        if found is None:
            raise KeyError(f"no signal {name!r} in run {self.run_id}")
        return found


class RunWriter:
    def __init__(self, directory: Path, meta: RunMeta) -> None:
        self.directory = directory
        self.meta = meta
        (directory / "0").mkdir(parents=True, exist_ok=True)
        self._out: BufferedWriter | None = None

    def add_signal(self, name: str, data: Array, unit: str = "") -> None:
        is_complex = bool(np.iscomplexobj(data))
        raw = np.ascontiguousarray(data, dtype="<c16" if is_complex else "<f8")
        if self._out is None:
            self._out = (self.directory / PACKED).open("ab")  # closed in finish()
        self._out.seek(0, 2)
        offset = self._out.tell()
        self._out.write(raw.tobytes())
        self.meta.signals.append(
            SignalInfo(name=name, unit=unit, complex=is_complex, file=PACKED,
                       offset=offset, length=len(raw))
        )  # fmt: skip
        self.meta.points = max(self.meta.points, len(raw))

    def finish(self) -> RunMeta:
        if self._out is not None:
            self._out.close()
            self._out = None
        (self.directory / "meta.json").write_text(
            self.meta.model_dump_json(indent=2), encoding="utf-8"
        )
        return self.meta


class RunReader:
    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self.meta = RunMeta.model_validate_json((directory / "meta.json").read_text("utf-8"))
        self._files: dict[str, bytes | None] = {}

    def signal(self, name: str) -> Array:
        info = self.meta.signal(name)
        data = self._small_file(info.file)
        if data is None:
            return read_signal(self.directory, info)
        dtype = np.dtype("<c16" if info.complex else "<f8")
        count = -1 if info.length is None else info.length
        return np.frombuffer(data, dtype=dtype, count=count, offset=info.offset)

    def _small_file(self, file: str) -> bytes | None:
        """Small files are read once (one memory map per signal is slow for an OP's hundreds)."""
        if file not in self._files:
            path = self.directory / file
            self._files[file] = path.read_bytes() if path.stat().st_size <= SMALL_FILE else None
        return self._files[file]


class ResultStore:
    def __init__(self, root: Path) -> None:
        self.root = root

    def create(self, analysis: AnalysisSpec) -> RunWriter:
        run_id = str(new_id())
        meta = RunMeta(run_id=run_id, created=datetime.now(UTC), analysis=analysis)
        return RunWriter(self.root / run_id, meta)

    def open(self, run_id: str) -> RunReader:
        return RunReader(self.root / safe_id(run_id, "run id"))

    def list_runs(self) -> list[str]:
        """Finished runs, oldest first (run ids are time-ordered)."""
        if not self.root.is_dir():
            return []
        return sorted(p.name for p in self.root.iterdir() if (p / "meta.json").is_file())

    def prune(self, keep: int = RUNS_KEPT, min_age_s: float = 3600.0) -> int:
        """Delete finished runs beyond the newest ``keep`` that are older than ``min_age_s``.

        A big transient is hundreds of MB and every run (F5, each graph node) adds one. Young
        runs stay whatever their number: a graph (Monte Carlo: 50 runs) reads them at the end.
        Runs still open elsewhere (memory-mapped on Windows) stay until the next time.
        """
        cutoff = time.time() - min_age_s
        removed = 0
        for run_id in self.list_runs()[: -keep or None] if keep > 0 else self.list_runs():
            folder = self.root / run_id
            try:
                if (folder / "meta.json").stat().st_mtime > cutoff:
                    continue
            except OSError:
                continue
            shutil.rmtree(folder, ignore_errors=True)
            removed += 1
        # Runs that never finished (the backend stopped mid-run) have no meta.json and would
        # stay forever; a day later nothing is writing them any more.
        stale = time.time() - 86400
        for folder in self.root.iterdir() if self.root.is_dir() else []:
            try:
                unfinished = folder.is_dir() and not (folder / "meta.json").exists()
                if unfinished and folder.stat().st_mtime < stale:
                    shutil.rmtree(folder, ignore_errors=True)
            except OSError:
                continue
        return removed
