"""Stress analysis (FR-SIM-7): how much of its ratings each part uses in a simulation run.

Ratings come from the part (an ideal part's ``Instance.ratings``) or from its library
component (``ComponentInfo.ratings``): ``voltage`` (V, peak), ``current`` (A, RMS), ``isat``
(A, peak), ``power`` (W, average), ``tj_max`` (°C) with ``rth`` (K/W). The project's margins
(``Project.stress``) say which part of a rating a design may use: above the margin the part is
marked "no margin", above the rating "overstressed".

Two-terminal parts are measured: the voltage between their pins and the current into pin 1
(of the element itself, or of a library component: the sum of the currents of the elements
inside it on that pin). Operating point: the values; transient: peak voltage, RMS and peak
current, average power.
"""

from typing import Literal
from uuid import UUID

import numpy as np
from pydantic import BaseModel, Field

from bpt.document.model import Instance, Project, StressRules
from bpt.library.blocks import PREFIX
from bpt.netlist.ir import CircuitIR, Device
from bpt.netlist.netlister import netlist_project
from bpt.results.store import RunReader
from bpt.units import InvalidValueError, format_value, parse_value

Status = Literal["ok", "margin", "over"]
Quantity = Literal["voltage", "current", "isat", "power", "temperature"]

_LABEL = {"voltage": "voltage", "current": "RMS current", "isat": "peak current",
          "power": "power", "temperature": "temperature"}  # fmt: skip
_UNIT = {"voltage": "V", "current": "A", "isat": "A", "power": "W", "temperature": "°C"}


class StressItem(BaseModel):
    ref: str
    instance_id: str
    sheet: str
    quantity: Quantity
    value: float
    rating: float
    limit: float  # the rating with the project's margin
    unit: str
    usage: float  # percent of the rating
    status: Status
    message: str


class StressReport(BaseModel):
    items: list[StressItem] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)


def _number(text: str | None) -> float | None:
    try:
        value = parse_value(text or "")
    except InvalidValueError:
        return None
    return value if value > 0 else None


class _Signals:
    def __init__(self, reader: RunReader, circuit: CircuitIR) -> None:
        self.reader = reader
        self.names = {s.name.lower() for s in reader.meta.signals}
        self.user = circuit.net_names
        self.points = max(reader.meta.points, 1)

    def voltage(self, node: str) -> np.ndarray | None:
        if node == "0":
            return np.zeros(self.points)
        name = f"V({self.user.get(node, node)})"
        if name.lower() not in self.names:
            return None
        return np.asarray(self.reader.signal(name)).real.astype(float)

    def current(self, name: str) -> np.ndarray | None:
        signal = f"I({name})"
        if signal.lower() not in self.names:
            return None
        return np.asarray(self.reader.signal(signal)).real.astype(float)


def _port_current(signals: _Signals, circuit: CircuitIR, device: Device) -> np.ndarray | None:
    """Current into pin 1 of a block: the currents of the elements inside on that pin."""
    sub = next((s for s in circuit.subcircuits if s.name == device.model), None)
    if sub is None or not sub.ports:
        return None
    port = sub.ports[0]
    total: np.ndarray | None = None
    for inner in sub.devices:
        if port not in inner.nodes[:2]:
            continue
        if inner.element == "X":
            return None  # a block inside: its pin current is not stored
        current = signals.current(f"{device.ref}.{inner.ref}")
        if current is None:
            return None
        signed = current if inner.nodes[0] == port else -current
        total = signed if total is None else total + signed
    return total


def _measures(
    reader: RunReader, v: np.ndarray, i: np.ndarray | None
) -> dict[str, float]:  # fmt: skip
    """Peak |V|, RMS and peak |I|, average power (time-weighted in a transient)."""
    out = {"voltage": float(np.max(np.abs(v)))}
    if i is None:
        return out
    scale = reader.meta.scale
    if reader.meta.analysis.kind == "tran" and scale and len(v) > 1:
        t = np.asarray(reader.signal(scale)).real.astype(float)
        span = float(t[-1] - t[0]) or 1.0
        out["current"] = float(np.sqrt(np.trapezoid(i * i, t) / span))
        out["power"] = float(abs(np.trapezoid(v * i, t) / span))
    else:
        out["current"] = float(np.max(np.abs(i)))
        out["power"] = float(np.max(np.abs(v * i)))
    out["isat"] = float(np.max(np.abs(i)))
    return out


def _item(inst: Instance, sheet: str, quantity: Quantity, value: float, rating: float,
          margin: float, slack: float = 0.0) -> StressItem:  # fmt: skip
    """``margin``: percent of the rating allowed; ``slack``: an absolute margin instead (K)."""
    limit = rating - slack if slack else rating * margin / 100
    status: Status = "over" if value > rating else "margin" if value > limit else "ok"
    unit = _UNIT[quantity]
    usage = 100 * value / rating
    text = {"over": "overstressed", "margin": "no margin", "ok": "within the margin"}[status]
    message = (f"{inst.ref}: {_LABEL[quantity]} {format_value(value, unit, 3)} of rated "
               f"{format_value(rating, unit, 3)} ({usage:.0f} %, limit "
               f"{format_value(limit, unit, 3)}): {text}")  # fmt: skip
    return StressItem(ref=inst.ref, instance_id=str(inst.id), sheet=sheet, quantity=quantity,
                      value=value, rating=rating, limit=limit, unit=unit, usage=usage,
                      status=status, message=message)  # fmt: skip


def stress_report(project: Project, reader: RunReader) -> StressReport:
    report = StressReport()
    kind = reader.meta.analysis.kind
    if kind not in ("op", "tran"):
        report.notes.append("Stress is checked on an operating point or a transient run.")
        return report
    result = netlist_project(project)
    circuit = result.circuit
    signals = _Signals(reader, circuit)
    # The part itself: its parasitics (ESR, Cp...) share its instance id and come after it.
    by_instance: dict[UUID, Device] = {}
    for each in circuit.devices:
        if each.instance_id is not None:
            by_instance.setdefault(each.instance_id, each)
    sheets = {s.name: s for s in project.sheets}
    rules: StressRules = project.stress
    for sheet in project.sheets:
        for inst in sheet.instances:
            block = (
                sheets.get(inst.symbol[len(PREFIX) :]) if inst.symbol.startswith(PREFIX) else None
            )
            ratings = dict(block.component.ratings) if block and block.component else {}
            ratings |= inst.ratings
            values = {k: v for k in ratings if (v := _number(ratings[k])) is not None}
            if not values:
                continue
            device = by_instance.get(inst.id)
            if device is None or len(device.nodes) < 2:
                continue  # inside a block, or not simulated
            if len(device.nodes) > 2 and device.element != "X":
                report.notes.append(f"{inst.ref}: only two-terminal parts are checked")
                continue
            va, vb = signals.voltage(device.nodes[0]), signals.voltage(device.nodes[1])
            if va is None or vb is None:
                continue
            if device.element == "X":
                current = _port_current(signals, circuit, device)
            else:
                current = signals.current(device.ref)
            measured = _measures(reader, va - vb, current)
            items = []
            if "voltage" in values:
                items.append(_item(inst, sheet.name, "voltage", measured["voltage"],
                                   values["voltage"], rules.voltage))  # fmt: skip
            checks: list[tuple[Quantity, float]] = [
                ("current", rules.current),
                ("isat", rules.current),
                ("power", rules.power),
            ]
            for key, margin in checks:
                if key in values and key in measured:
                    items.append(_item(inst, sheet.name, key, measured[key], values[key], margin))
                elif key in values:
                    report.notes.append(f"{inst.ref}: the current through it is not known")
            if "tj_max" in values and "rth" in values and "power" in measured:
                tj = rules.ambient + measured["power"] * values["rth"]
                items.append(_item(inst, sheet.name, "temperature", tj, values["tj_max"],
                                   100, slack=rules.temperature))  # fmt: skip
            report.items += items
    report.notes = list(dict.fromkeys(report.notes))
    return report
