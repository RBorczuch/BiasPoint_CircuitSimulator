"""Size of a run before it starts (Poprawki 20): points x signals x bytes per value.

A ``.tran`` with a 10 ns step over 100 ms is 10 million points; with every device current
saved (``.options savecurrents``) a small circuit writes hundreds of MB and a big one several
GB. The estimate lets the interface ask first and offer to save node voltages only.

ngspice may add points (it writes every internal time step), so a transient estimate is a
lower bound; it is meant to catch runs that are orders of magnitude too big.
"""

import math

from pydantic import BaseModel

from bpt.analysis.spec import AnalysisSpec
from bpt.netlist.ir import CircuitIR
from bpt.units import InvalidValueError, format_value, parse_value

LARGE_BYTES = 500_000_000  # above this the interface asks before running
# Currents saved per device with savecurrents (terminals of three- and four-pin parts).
_CURRENTS = {"Q": 3, "M": 4, "J": 3, "E": 1, "F": 1, "G": 1, "H": 1, "X": 0}


class RunEstimate(BaseModel):
    points: int
    signals: int
    bytes: int
    large: bool
    text: str  # "10.0M points x 52 signals ≈ 4.2 GB"


def _value(text: str | None, default: float = 0.0) -> float:
    try:
        return parse_value(text or "")
    except InvalidValueError:
        return default


def points_of(analysis: AnalysisSpec) -> int:
    if analysis.kind == "op":
        return 1
    if analysis.kind == "dc":
        step = abs(_value(analysis.step))
        span = abs(_value(analysis.stop) - _value(analysis.start))
        return int(span / step) + 1 if step else 1
    if analysis.kind == "ac":
        fstart, fstop = _value(analysis.fstart, 1.0), _value(analysis.fstop, 1.0)
        if analysis.variation == "lin" or fstart <= 0 or fstop <= fstart:
            return analysis.points
        per = (
            math.log10(fstop / fstart) if analysis.variation == "dec" else math.log2(fstop / fstart)
        )
        return int(per * analysis.points) + 1
    stop, start = _value(analysis.tstop), _value(analysis.tstart)
    step = _value(analysis.tstep)
    if analysis.tmax:
        step = min(step, _value(analysis.tmax, step)) if step else _value(analysis.tmax)
    return int((stop - start) / step) + 1 if step > 0 and stop > start else 1


def signals_of(circuit: CircuitIR, save_currents: bool) -> int:
    nodes = {node for d in circuit.devices for node in d.nodes if node != "0"}
    nodes |= {f"{sub.name}.{d.ref}" for sub in circuit.subcircuits for d in sub.devices}
    sources = sum(1 for d in circuit.devices if d.element in ("V", "L"))
    currents = sum(_CURRENTS.get(d.element, 1) for d in circuit.devices) if save_currents else 0
    return 1 + len(nodes) + sources + currents  # 1: the x axis


def estimate(circuit: CircuitIR, analysis: AnalysisSpec) -> RunEstimate:
    points = points_of(analysis)
    signals = signals_of(circuit, circuit.save_currents)
    size = points * signals * (16 if analysis.kind == "ac" else 8)
    text = (f"{format_value(points, '', 3)} points x {signals} signals ≈ "
            f"{format_value(size, 'B', 2)}")  # fmt: skip
    return RunEstimate(points=points, signals=signals, bytes=size, large=size > LARGE_BYTES,
                       text=text)  # fmt: skip
