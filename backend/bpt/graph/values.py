"""Data flowing along graph edges (node.md §3). Units travel with the data."""

from dataclasses import dataclass, field
from typing import Any

import numpy as np
import numpy.typing as npt

from bpt.document.model import Project
from bpt.units import format_value


@dataclass
class CircuitValue:
    project: Project  # snapshot; parameter overrides applied by "Set parameters"
    key: str  # hash of the netlist: moving parts on the schematic does not change it


@dataclass
class ParamsValue:
    values: dict[str, str] = field(default_factory=dict)


@dataclass
class RunValue:
    run_id: str
    kind: str  # op, dc, ac, tran
    scale: str | None
    signals: list[str]


@dataclass
class SignalValue:
    name: str
    x: npt.NDArray[np.float64]
    y: npt.NDArray[Any]  # complex for AC
    x_name: str = "x"  # time, frequency, sweep
    x_unit: str = ""
    unit: str = ""

    @property
    def is_complex(self) -> bool:
        return bool(np.iscomplexobj(self.y))

    def describe(self) -> str:
        n = len(self.x)
        if n == 0:
            return f"{self.name}: empty"
        start, stop = (format_value(float(v), self.x_unit) for v in (self.x[0], self.x[-1]))
        span = f"{start} … {stop}"
        if self.is_complex:
            return f"{self.name}: {n} points, {span} (complex)"
        lo, hi = float(np.min(self.y.real)), float(np.max(self.y.real))
        low, high = format_value(lo, self.unit), format_value(hi, self.unit)
        return f"{self.name}: {n} points, {span}, {low} … {high}"


@dataclass
class ScalarValue:
    name: str
    value: float
    unit: str = ""
    phase_deg: float | None = None

    def describe(self) -> str:
        text = f"{self.name} = {format_value(self.value, self.unit)}"
        return text if self.phase_deg is None else f"{text} ∠ {self.phase_deg:.1f}°"


@dataclass
class TableValue:
    """Named columns with units and rows of numbers (or text): sweep results, measurements,
    a list of values."""

    name: str
    columns: list[str]
    units: list[str]
    rows: list[list[float | str]]

    def describe(self) -> str:
        shown = ", ".join(self.columns[:5]) + ("…" if len(self.columns) > 5 else "")
        return f"{self.name}: {len(self.rows)} rows x {len(self.columns)} columns ({shown})"

    def column(self, name: str) -> list[float | str]:
        if name not in self.columns:
            raise KeyError(name)
        k = self.columns.index(name)
        return [row[k] for row in self.rows]


@dataclass
class FamilyValue:
    """The same kind of value once per sweep point: ``items[i]`` belongs to ``param = values[i]``.

    Nodes that do not handle families themselves run once per member (broadcasting); members can
    be families again (nested sweeps).
    """

    param: str
    values: list[str]
    items: list["Value"]

    def leaves(self, label: str = "") -> list[tuple[str, "Value"]]:
        """(label, value) for every innermost member, label like "R=1k, C=1n"."""
        out: list[tuple[str, Value]] = []
        for point, item in zip(self.values, self.items, strict=True):
            here = f"{label}, {self.param}={point}" if label else f"{self.param}={point}"
            out += item.leaves(here) if isinstance(item, FamilyValue) else [(here, item)]
        return out


Value = CircuitValue | ParamsValue | RunValue | SignalValue | ScalarValue | TableValue | FamilyValue


def leaf(value: Value) -> Value | None:
    """The first innermost member (for type checks); None for an empty family."""
    while isinstance(value, FamilyValue):
        if not value.items:
            return None
        value = value.items[0]
    return value


TYPE_OF: dict[type, str] = {
    CircuitValue: "circuit",
    ParamsValue: "params",
    RunValue: "run",
    SignalValue: "signal",
    ScalarValue: "scalar",
    FamilyValue: "family",
}
