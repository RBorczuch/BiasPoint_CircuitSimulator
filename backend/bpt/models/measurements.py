"""Measurements (phase 6): points measured on a part, kept as ``.bptm.json`` files and fitted
by the same pipeline as a datasheet's points.

A measurement file holds one or more characteristics (the same ``Characteristic`` a part keeps),
with what they were measured on and with. CSV files from instruments and spreadsheets are read
here: the delimiter, a decimal comma and the units in the column headers (``f [kHz]``,
``Impedance (mOhm)``) are found, and the chosen columns scaled to the characteristic's units.
"""

import math
import re
from dataclasses import dataclass, field

from pydantic import BaseModel, Field

from bpt.document.model import Characteristic

FORMAT = "bptm"
VERSION = 1


class Measurement(BaseModel):
    """A ``.bptm.json`` file."""

    format: str = FORMAT
    version: int = VERSION
    name: str = ""
    part: str = ""  # what was measured (a part number, a reference)
    instrument: str = ""  # what it was measured with
    taken: str = ""  # when (ISO 8601)
    notes: str = ""
    characteristics: list[Characteristic] = Field(default_factory=list)


class MeasurementError(ValueError):
    """The file or the text is not a measurement."""


def check(measurement: Measurement) -> Measurement:
    if measurement.format != FORMAT:
        raise MeasurementError(f"not a measurement file (format {measurement.format!r})")
    if measurement.version > VERSION:
        raise MeasurementError(f"made by a newer BiasPoint (version {measurement.version})")
    return measurement


# -- CSV -------------------------------------------------------------------------------------------

# Prefixes in a header's unit, and the units they may stand before.
_PREFIX = {"G": 1e9, "M": 1e6, "k": 1e3, "K": 1e3, "m": 1e-3, "u": 1e-6, "µ": 1e-6, "μ": 1e-6,
           "n": 1e-9, "p": 1e-12, "f": 1e-15}  # fmt: skip
_UNIT_NAMES = {
    "ohm": "Ω",
    "ohms": "Ω",
    "Ω": "Ω",
    "hz": "Hz",
    "v": "V",
    "a": "A",
    "f": "F",
    "h": "H",
    "°": "°",
    "deg": "°",
    "db": "dB",
    "s": "s",
    "w": "W",
    "c": "C",
}
_HEADER_UNIT = re.compile(r"[\[(]\s*([^\])]+?)\s*[\])]\s*$|/\s*(\S+)\s*$")


@dataclass
class Column:
    name: str
    unit: str = ""  # the base unit ("Hz", "Ω"), "" when none is given
    scale: float = 1.0  # what a value in the column is in that unit (kHz: 1000)


@dataclass
class Table:
    columns: list[Column]
    rows: list[list[float]]  # numbers only (rows with text are left out)
    delimiter: str
    decimal_comma: bool
    skipped: int = 0  # lines that were not rows of numbers (headers, comments)
    notes: list[str] = field(default_factory=list)


def header_unit(header: str) -> tuple[str, float]:
    """("Hz", 1000.0) from "f [kHz]", "Frequency (kHz)" or "f / kHz"; ("", 1) when none."""
    m = _HEADER_UNIT.search(header.strip())
    if not m:
        return "", 1.0
    text = (m.group(1) or m.group(2) or "").strip().replace("Ohm", "ohm")
    if text.lower() in _UNIT_NAMES:
        return _UNIT_NAMES[text.lower()], 1.0
    if len(text) > 1 and text[0] in _PREFIX and text[1:].lower() in _UNIT_NAMES:
        return _UNIT_NAMES[text[1:].lower()], _PREFIX[text[0]]
    return text, 1.0


def _comment(line: str) -> bool:
    return line.lstrip().startswith(("#", "*", "%", "//"))


def _delimiter(lines: list[str]) -> str:
    """The separator the data lines share: tab, semicolon, comma, else whitespace (comments and
    headers above the data do not count)."""
    data = [line for line in lines if re.search(r"\d", line) and not _comment(line)][:20]
    for candidate in ("\t", ";", ","):
        counts = [line.count(candidate) for line in data]
        if counts and min(counts) > 0 and len(set(counts)) <= 2:
            return candidate
    return " "


def _number(text: str, decimal_comma: bool) -> float | None:
    t = text.strip().strip('"')
    if decimal_comma:
        t = t.replace(".", "").replace(",", ".") if t.count(",") == 1 else t
    try:
        value = float(t)
    except ValueError:
        return None
    return value if math.isfinite(value) else None


def read_csv(text: str) -> Table:
    """The numbers of a CSV (or TSV, or space-separated) text with its columns' units."""
    lines = [line for line in text.replace("\r\n", "\n").split("\n") if line.strip()]
    if not lines:
        raise MeasurementError("the file is empty")
    delimiter = _delimiter(lines)
    # A decimal comma: a semicolon or tab between columns and commas inside the numbers.
    decimal_comma = delimiter in (";", "\t", " ") and any(
        re.search(r"\d,\d", line) for line in lines
    )

    def cells(line: str) -> list[str]:
        parts = line.split() if delimiter == " " else line.split(delimiter)
        while parts and not parts[-1].strip():  # "1e3,16.8," (Murata SimSurfing ends rows so)
            parts.pop()
        return parts

    rows: list[list[float]] = []
    header: list[str] | None = None
    skipped = 0
    for line in lines:
        parts = cells(line)
        numbers = [_number(p, decimal_comma) for p in parts]
        if parts and all(n is not None for n in numbers):
            rows.append([n for n in numbers if n is not None])
        else:
            skipped += 1
            if not rows and not _comment(line):
                header = [p.strip().strip('"') for p in parts]  # the last text line above the data
    if not rows:
        raise MeasurementError("no rows of numbers in the file")
    width = max(len(r) for r in rows)
    rows = [r for r in rows if len(r) == width]
    names = header if header and len(header) == width else [f"column {k + 1}" for k in range(width)]
    columns = [Column(name, *header_unit(name)) for name in names]
    return Table(columns, rows, delimiter, decimal_comma, skipped)


def to_points(
    table: Table, x: int, y: int, units: tuple[str, str]
) -> tuple[list[tuple[float, float]], list[str]]:
    """Columns x and y as points in the characteristic's units (a header's prefix applied), with
    notes on what was assumed."""
    notes: list[str] = []
    scales = []
    for k, want in ((x, units[0]), (y, units[1])):
        column = table.columns[k]
        if column.unit and want and column.unit != want:
            notes.append(f"“{column.name}” is in {column.unit}, the characteristic in {want}: "
                         "taken as it is")  # fmt: skip
            scales.append(1.0)
        else:
            scales.append(column.scale)
            if column.scale != 1:
                notes.append(f"“{column.name}” scaled by {column.scale:g} to {want or column.unit}")
    points = [(r[x] * scales[0], r[y] * scales[1]) for r in table.rows]
    return points, notes
