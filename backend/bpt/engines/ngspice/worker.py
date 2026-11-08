"""ngspice worker process: loads the library once and runs jobs sent over a pipe.

Protocol (tuples over a ``multiprocessing`` connection):

* worker -> parent: ``("ready", version)`` | ``("failed", error)`` at start-up,
  ``("progress", text)`` while running, ``("done", meta_json)`` per job
* parent -> worker: ``("run", job_dict)`` | ``("stop",)``
"""

import re
import time
from itertools import pairwise
from multiprocessing.connection import Connection
from pathlib import Path
from typing import Any

from bpt.analysis.spec import DcAnalysis, sweep_unit
from bpt.engines.ngspice.ffi import SV_FREQUENCY, SV_TIME, SV_VOLTAGE, NgSpice, Vector
from bpt.results.log import parse_log
from bpt.results.store import RunFamily, RunMeta, RunWriter
from bpt.units import InvalidValueError, parse_value

_SWEEP_SCALE = re.compile(r"^[a-z]+-sweep$")
_PROGRESS_INTERVAL_S = 0.1


_DEVICE_CURRENT = re.compile(r"^@([^\[]+)\[(\w+)\]$")
# savecurrents terminal names -> pin suffix per element letter (None = not shown).
_TERMINALS: dict[str, dict[str, str | None]] = {
    "q": {"ic": ".C", "ib": ".B", "ie": ".E", "is": None},
    "m": {"id": ".D", "ig": ".G", "is": ".S", "ib": ".B"},
    "j": {"id": ".D", "ig": ".G", "is": ".S", "igd": None},
}


def _user_name(
    vector: Vector, net_names: dict[str, str], branches: dict[str, str]
) -> tuple[str, str] | None:
    """Map an ngspice vector name to (user-facing name, unit); None = drop the vector.

    Currents follow SPICE: positive into the (first) terminal. Two-terminal devices give
    ``I(R1)``; transistors give one current per terminal, ``I(Q1.C)``.
    """
    name = vector.name
    lowered = name.lower()
    if vector.type == SV_TIME or lowered == "time":
        return "time", "s"
    if vector.type == SV_FREQUENCY or lowered == "frequency":
        return "frequency", "Hz"
    if _SWEEP_SCALE.match(lowered):
        return "sweep", ""
    if lowered.endswith("#branch"):
        spice = lowered.removesuffix("#branch")
        return f"I({branches.get(spice, spice.upper())})", "A"
    if lowered in net_names:
        return f"V({net_names[lowered]})", "V"
    device = _DEVICE_CURRENT.match(lowered)
    if device:
        spice, terminal = device.groups()
        ref = branches.get(spice, spice.upper())
        terminals = _TERMINALS.get(spice[0])
        if terminals is None:  # R C L D: one current
            return None if spice[0] == "l" else (f"I({ref})", "A")  # L: use l#branch
        suffix = terminals.get(terminal)
        return None if suffix is None else (f"I({ref}{suffix})", "A")
    if vector.type == SV_VOLTAGE and "(" not in name and "#" not in name and "@" not in name:
        # A node without a user name: inside a part (``_r1_ls``) or a block (``x1.out``).
        return f"V({name})", "V"
    return name, ""


def _scale_name(names: list[str]) -> str | None:
    for candidate in ("time", "frequency", "sweep"):
        if candidate in names:
            return candidate
    return None


def _family(analysis: DcAnalysis, sweep: Any) -> RunFamily | None:
    """The curves of a DC sweep with a second source: the first sweep starts again for each
    value of the second one."""
    if not analysis.source2 or not analysis.start2 or not analysis.step2:
        return None
    try:
        start, step = parse_value(analysis.start2), parse_value(analysis.step2)
    except InvalidValueError:
        return None
    x = [float(v.real) for v in sweep]
    if len(x) < 2:
        return None
    restarts = sum(1 for a, b in pairwise(x) if (b - a) * (x[1] - x[0]) < 0)
    members = restarts + 1
    if len(x) % members:
        return None
    values = [float(f"{start + k * step:.12g}") for k in range(members)]  # 1e-05, not 9.99e-06
    return RunFamily(name=analysis.source2, unit=sweep_unit(analysis.source2), values=values,
                     length=len(x) // members)  # fmt: skip


def run_job(spice: NgSpice, job: dict[str, Any]) -> RunMeta:
    meta = RunMeta.model_validate_json(job["meta"])
    writer = RunWriter(Path(job["run_dir"]), meta)
    started = time.perf_counter()
    log = spice.load_circuit(job["lines"])
    log += spice.command("run")
    plot = spice.current_plot()
    meta.log = [line for line in log if line.strip()]
    meta.messages = parse_log(meta.log, job["net_names"], job["branches"], job["models"])
    errors = [m.text for m in meta.messages if m.severity == "error"]
    if any("cannot recover" in line for line in meta.log):
        spice.exit_requested = True  # library must be reloaded: the worker exits after this job

    if errors or not plot or plot == "const" or spice.exit_requested:
        meta.status = "error"
        meta.error = errors[0] if errors else "simulation produced no results"
    else:
        net_names = {k.lower(): v for k, v in job["net_names"].items()}
        branches = {k.lower(): v for k, v in job["branches"].items()}
        names: list[str] = []
        for vector_name in spice.vector_names(plot):
            vector = spice.vector(plot, vector_name)
            mapped = _user_name(vector, net_names, branches)
            if mapped is None or vector.data.size == 0:
                continue
            name, unit = mapped
            if name == "sweep" and isinstance(meta.analysis, DcAnalysis):
                unit = sweep_unit(meta.analysis.source)
                meta.family = _family(meta.analysis, vector.data)
            writer.add_signal(name, vector.data, unit)
            names.append(name)
        meta.scale = _scale_name(names)

    meta.duration_s = time.perf_counter() - started
    spice.command("destroy all")
    spice.command("remcirc")
    return writer.finish()


def worker_main(conn: Connection, library: str) -> None:
    last_progress = 0.0

    def on_status(text: str) -> None:
        nonlocal last_progress
        now = time.monotonic()
        if now - last_progress >= _PROGRESS_INTERVAL_S:
            last_progress = now
            conn.send(("progress", text))

    try:
        spice = NgSpice(Path(library), on_status=on_status)
        conn.send(("ready", spice.version()))
    except Exception as exc:  # report start-up failure instead of dying silently
        conn.send(("failed", f"{type(exc).__name__}: {exc}"))
        return

    while True:
        message = conn.recv()
        if message[0] == "stop":
            return
        try:
            meta = run_job(spice, message[1])
        except Exception as exc:  # the library state is unknown: report and let a new worker go on
            conn.send(("failed", f"{type(exc).__name__}: {exc}"))
            return
        # The third item says this worker exits now (the engine starts a new one).
        conn.send(("done", meta.model_dump_json(), spice.exit_requested))
        if spice.exit_requested:
            return
