"""CSV export of a run: scale column first; complex signals as magnitude (dB) + phase (deg)."""

import csv
from pathlib import Path

import numpy as np

from bpt.results.store import RunReader


def export_csv(run: RunReader, path: Path, signals: list[str] | None = None) -> None:
    meta = run.meta
    names = signals or [s.name for s in meta.signals if s.name != meta.scale]
    columns: list[tuple[str, np.ndarray]] = []
    if meta.scale:
        scale = meta.signal(meta.scale)
        columns.append(
            (f"{scale.name} [{scale.unit}]", np.real(np.asarray(run.signal(scale.name))))
        )
    for name in names:
        info = meta.signal(name)
        data = np.asarray(run.signal(name))
        if info.complex:
            columns.append((f"{name} [dB]", 20 * np.log10(np.maximum(np.abs(data), 1e-15))))
            columns.append((f"{name} [deg]", np.degrees(np.angle(data))))
        else:
            columns.append((f"{name} [{info.unit}]" if info.unit else name, data))
    rows = max(len(c) for _h, c in columns)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow([header for header, _c in columns])
        for i in range(rows):
            writer.writerow([repr(float(c[i])) if i < len(c) else "" for _h, c in columns])
