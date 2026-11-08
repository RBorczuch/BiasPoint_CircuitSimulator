"""Compact text summaries of runs (CLI output and token-efficient MCP answers)."""

import re

import numpy as np

from bpt.results.store import RunMeta, RunReader
from bpt.units import format_value

_PREFIX = re.compile(r"^warning:\s*", re.IGNORECASE)


def _fmt(value: float, unit: str) -> str:
    return format_value(float(value), unit)


def summarize(run: RunReader, signals: list[str] | None = None) -> str:
    meta = run.meta
    head = f"{meta.analysis.kind} [{meta.status}] {meta.points} pts"
    if meta.status != "ok":
        return "\n".join([head, f"error: {meta.error}", *_warnings(meta)])
    names = signals or [s.name for s in meta.signals if s.name != meta.scale]
    lines = [head]
    x = np.real(np.asarray(run.signal(meta.scale))) if meta.scale else None
    x_unit = meta.signal(meta.scale).unit if meta.scale else ""
    for name in names:
        info = meta.signal(name)
        y = np.asarray(run.signal(name))
        if y.size == 0:
            continue
        if meta.scale is None:  # operating point
            lines.append(f"{name} = {_fmt(y[-1].real, info.unit)}")
        elif info.complex and x is not None:
            mag_db = 20 * np.log10(np.maximum(np.abs(y), 1e-15))
            peak = int(np.argmax(mag_db))
            lines.append(
                f"{name}: peak {mag_db[peak]:.2f} dB @ {_fmt(x[peak], x_unit)}; "
                f"{mag_db[0]:.2f} dB @ {_fmt(x[0], x_unit)}; "
                f"{mag_db[-1]:.2f} dB @ {_fmt(x[-1], x_unit)}"
            )
        else:
            yr = np.real(y)
            lines.append(
                f"{name}: min {_fmt(yr.min(), info.unit)}, max {_fmt(yr.max(), info.unit)}, "
                f"final {_fmt(yr[-1], info.unit)}"
            )
    return "\n".join(lines + _warnings(meta))


def _warnings(meta: RunMeta, limit: int = 3) -> list[str]:
    """Distinct simulator warnings (they often explain odd results)."""
    found = [m for m in meta.messages if m.severity == "warning"]
    lines = [
        f"warning: {_PREFIX.sub('', m.text)}" + (f" (x{m.count})" if m.count > 1 else "")
        for m in found
    ]
    if len(lines) > limit:
        lines = [*lines[:limit], f"... {len(lines) - limit} more warnings"]
    return lines
