"""Node outputs kept on disk (graf.md §11, G1): a project opened the next day shows its graph's
last results without running the simulations again.

One ``<key>.npz`` per node key in ``results/graph-cache/``: a JSON description of the values
and their arrays, read without pickle (a project folder can come from someone else). The least
recently used entries go first once the folder outgrows its limit.
"""

import contextlib
import io
import json
import os
from pathlib import Path
from typing import Any

import numpy as np

from .values import (
    FamilyValue,
    ParamsValue,
    RunValue,
    ScalarValue,
    SignalValue,
    TableValue,
    Value,
)

FOLDER = "graph-cache"
LIMIT_BYTES = 256 * 1024 * 1024
FORMAT = 1


class _UnstorableError(Exception):
    """A value kept only in memory (a circuit: recomputed from the project in no time)."""


def _encode(value: Value, arrays: list[np.ndarray]) -> dict[str, Any]:
    def array(a: np.ndarray) -> int:
        arrays.append(np.asarray(a))
        return len(arrays) - 1

    if isinstance(value, ScalarValue):
        return {"t": "scalar", "name": value.name, "value": float(value.value), "unit": value.unit,
                "phase": value.phase_deg}  # fmt: skip
    if isinstance(value, SignalValue):
        return {"t": "signal", "name": value.name, "x": array(value.x), "y": array(value.y),
                "x_name": value.x_name, "x_unit": value.x_unit, "unit": value.unit}  # fmt: skip
    if isinstance(value, RunValue):
        return {"t": "run", "run_id": value.run_id, "kind": value.kind, "scale": value.scale,
                "signals": value.signals}  # fmt: skip
    if isinstance(value, ParamsValue):
        return {"t": "params", "values": value.values}
    if isinstance(value, TableValue):
        rows = [[v if isinstance(v, str) else float(v) for v in row] for row in value.rows]
        return {"t": "table", "name": value.name, "columns": value.columns,
                "units": value.units, "rows": rows}  # fmt: skip
    if isinstance(value, FamilyValue):
        return {"t": "family", "param": value.param, "values": value.values,
                "items": [_encode(v, arrays) for v in value.items]}  # fmt: skip
    raise _UnstorableError  # a circuit


def _decode(data: dict[str, Any], arrays: Any) -> Value:
    kind = data["t"]
    if kind == "scalar":
        return ScalarValue(data["name"], data["value"], data["unit"], data["phase"])
    if kind == "signal":
        x, y = (arrays[f"arr_{data[k] + 1}"] for k in ("x", "y"))  # (arr_0: the description)
        return SignalValue(data["name"], x, y, data["x_name"], data["x_unit"], data["unit"])
    if kind == "run":
        return RunValue(data["run_id"], data["kind"], data["scale"], list(data["signals"]))
    if kind == "params":
        return ParamsValue(dict(data["values"]))
    if kind == "table":
        return TableValue(data["name"], data["columns"], data["units"], data["rows"])
    if kind == "family":
        return FamilyValue(data["param"], list(data["values"]),
                           [_decode(v, arrays) for v in data["items"]])  # fmt: skip
    raise ValueError(f"unknown value {kind!r}")


def _runs(value: Value) -> list[str]:
    if isinstance(value, RunValue):
        return [value.run_id]
    if isinstance(value, FamilyValue):
        return [r for item in value.items for r in _runs(item)]
    return []


class DiskCache:
    """Outputs by node key under ``<results>/graph-cache``; an entry whose simulation run is gone
    from ``<results>`` (pruned, deleted) counts as missing."""

    def __init__(self, results: Path, limit: int = LIMIT_BYTES) -> None:
        self.results = results
        self.folder = results / FOLDER
        self.limit = limit

    def _path(self, key: str) -> Path:
        if not key.isalnum():
            raise ValueError(f"bad cache key {key!r}")
        return self.folder / f"{key}.npz"

    def get(self, key: str) -> dict[str, Value] | None:
        path = self._path(key)
        try:
            with np.load(path, allow_pickle=False) as data:
                meta = json.loads(str(data["arr_0"]))
                if meta.get("format") != FORMAT:
                    return None
                outputs = {name: _decode(v, data) for name, v in meta["outputs"].items()}
        except FileNotFoundError:
            return None
        except Exception:  # damaged or from another version: compute again
            path.unlink(missing_ok=True)
            return None
        runs = [r for v in outputs.values() for r in _runs(v)]
        if any(not (self.results / r / "meta.json").is_file() for r in runs):
            path.unlink(missing_ok=True)
            return None
        with contextlib.suppress(OSError):
            os.utime(path)  # recently used
        return outputs

    def put(self, key: str, outputs: dict[str, Value]) -> bool:
        """Keep ``outputs``; False when they cannot be kept (a circuit) or are too big."""
        arrays: list[np.ndarray] = []
        try:
            encoded = {name: _encode(v, arrays) for name, v in outputs.items()}
        except _UnstorableError:
            return False
        if sum(a.nbytes for a in arrays) > self.limit // 4:
            return False
        buffer = io.BytesIO()
        meta = {"format": FORMAT, "outputs": encoded}
        np.savez(buffer, np.array(json.dumps(meta)), *arrays)  # arr_0, then the arrays
        path = self._path(key)
        try:
            self.folder.mkdir(parents=True, exist_ok=True)
            partial = path.with_suffix(".part")
            partial.write_bytes(buffer.getvalue())
            partial.replace(path)
        except OSError:
            return False
        self._trim()
        return True

    def _trim(self) -> None:
        """Drop the least recently used entries down to 80 % of the limit."""
        entries = []
        for item in os.scandir(self.folder):
            if item.name.endswith(".npz"):
                stat = item.stat()
                entries.append((stat.st_mtime, stat.st_size, Path(item.path)))
        total = sum(size for _, size, _ in entries)
        if total <= self.limit:
            return
        for _, size, path in sorted(entries):
            try:
                path.unlink()
            except OSError:
                continue  # open elsewhere: next time
            total -= size
            if total <= self.limit * 0.8:
                break
