"""Component card (FR-CMP): characteristics of a part computed by simulation.

|Z|(f) and phase, ESR(f) for capacitors and inductors, C(V) for capacitors, L(I) for
inductors. Ranges follow the part: the frequency span covers its resonance and the source
points, C(V) goes up to the rated voltage, L(I) to twice the current at which the inductance
halves (or the rated current). Diodes and transistors get their datasheet curves
(``semi_card``), transformers and op-amps theirs (``multiport_card``); other two-terminal
diodes an I-V.
"""

import math
from typing import Literal

import numpy as np
from pydantic import BaseModel, Field

from bpt.document.model import Characteristic, ComponentInfo, Project
from bpt.library.blocks import ports
from bpt.models import bench, semi_card
from bpt.models.multiport_card import multiport_curves
from bpt.units import InvalidValueError, format_value, parse_value

_SPAN = {"capacitor": (10.0, 1e9), "inductor": (100.0, 1e9), "resistor": (1e3, 1e10)}


class CardCurve(BaseModel):
    name: str  # "|Z|(f)", "phase(f)", "ESR(f)", "C(V)", "L(I)", "I-V", "Ic(Vce)"...
    x_unit: str
    y_unit: str
    x: list[float]
    y: list[float]
    label: str = ""  # member of a family of curves of one name ("Ib = 20 µA")


class Card(BaseModel):
    curves: list[CardCurve] = Field(default_factory=list)
    sources: list[Characteristic] = Field(default_factory=list)  # the points it was made from
    notes: list[str] = Field(default_factory=list)
    circuit: str = ""  # SVG of the equivalent circuit
    parameters: dict[str, str] = Field(default_factory=dict)  # its values (with overrides)
    labels: dict[str, str] = Field(default_factory=dict)  # parameter -> form label ("Cnom" -> "C")


def _number(text: str | None) -> float | None:
    try:
        value = parse_value(text or "")
    except InvalidValueError:
        return None
    return value if value > 0 else None


def _rating(info: ComponentInfo | None, *keys: str) -> float | None:
    for key in keys:
        if info is not None and (value := _number(info.ratings.get(key))) is not None:
            return value
    return None


def _span(kind: str, sources: list[Characteristic]) -> tuple[float, float]:
    fmin, fmax = _SPAN.get(kind, (10.0, 1e8))
    xs = [x for c in sources if c.name.endswith("(f)") for x, _y in c.points if x > 0]
    if xs:
        fmin, fmax = min(fmin, min(xs) / 2), max(fmax, max(xs) * 2)
    return fmin, fmax


def compute_card(
    run: bench.Run,
    base: Project,
    top: str,
    info: ComponentInfo | None,
    params: dict[str, str] | None = None,
) -> Card:
    """The card of sheet ``top`` of ``base`` (a placed or library component)."""
    sources = list(info.characteristics) if info else []
    card = Card(sources=sources)
    sheet = next((s for s in base.sheets if s.name == top), None)
    if sheet is None:
        raise bench.BenchError(f"no sheet {top}")
    kind = info.kind if info else "other"
    params = dict(params or {})
    template_values = info.template.values if info and info.template else {}
    port_names = [name for name, _side in ports(sheet)]
    device = semi_card.device_of(base, top, port_names) if kind in ("diode", "transistor") else None
    if device is not None:
        breakdown = _number(
            params.get("bv") or template_values.get("bv") or sheet.parameters.get("bv")
        )
        limits = (_rating(info, "voltage"), _rating(info, "current"), breakdown)
        curves, notes = semi_card.semiconductor_curves(run, base, top, device, params, limits)
        card.curves += [
            CardCurve(name=c.name, x_unit=c.x_unit, y_unit=c.y_unit, x=[float(v) for v in c.x],
                      y=[float(v) for v in c.y], label=c.label)
            for c in curves
        ]  # fmt: skip
        card.notes += notes
        return card

    def value(key: str) -> float | None:
        return _number(params.get(key) or template_values.get(key) or sheet.parameters.get(key))

    many = multiport_curves(run, base, top, kind, port_names, params, value)
    if many is not None:
        card.curves += [
            CardCurve(name=c.name, x_unit=c.x_unit, y_unit=c.y_unit, x=[float(v) for v in c.x],
                      y=[float(v) for v in c.y], label=c.label)
            for c in many
        ]  # fmt: skip
        return card
    try:
        bench.two_ports(sheet)
    except bench.BenchError as exc:
        card.notes.append(f"{exc}: only the metadata and the equivalent circuit are shown")
        return card
    if kind in ("diode", "transistor"):
        vmax = _rating(info, "voltage") or 5.0
        sweep, current = bench.iv_curve(run, base, top, -min(vmax, 5.0), 1.0)
        card.curves.append(CardCurve(name="I-V", x_unit="V", y_unit="A", x=sweep.tolist(),
                                     y=current.tolist()))  # fmt: skip
        return card
    drive: Literal["v", "i"] = "i" if kind == "inductor" else "v"
    fmin, fmax = _span(kind, sources)
    freqs, (z,) = bench.impedance_sweep(run, base, top, bench.frequency_grid(fmin, fmax, 20),
                                        [bench.Copy(params, drive)])  # fmt: skip
    f = freqs.tolist()
    card.curves += [
        CardCurve(name="|Z|(f)", x_unit="Hz", y_unit="Ω", x=f, y=np.abs(z).tolist()),
        CardCurve(name="phase(f)", x_unit="Hz", y_unit="°", x=f,
                  y=np.degrees(np.angle(z)).tolist()),
    ]  # fmt: skip
    if kind in ("capacitor", "inductor"):
        card.curves.append(CardCurve(name="ESR(f)", x_unit="Hz", y_unit="Ω", x=f,
                                     y=z.real.tolist()))  # fmt: skip
    # Small-signal C or L well below the self-resonance (the |Z| extremum).
    resonance = int(np.argmin(np.abs(z)) if kind == "capacitor" else np.argmax(np.abs(z)))
    f_meas = max(fmin, freqs[resonance] / 100) if 0 < resonance < len(f) - 1 else 1e3
    if kind == "capacitor":
        sources_v = [x for c in sources if c.name == "C(V)" for x, _y in c.points]
        vmax = _rating(info, "voltage") or (max(sources_v) if sources_v else 25.0)
        volts: list[float] = [vmax * k / 10 for k in range(11)]
        caps = bench.capacitance_curve(run, base, top, volts, f_meas, params)
        card.curves.append(CardCurve(name="C(V)", x_unit="V", y_unit="F", x=volts,
                                     y=caps.tolist()))  # fmt: skip
    elif kind == "inductor":
        half = _number(params.get("isat") or template_values.get("isat"))
        sources_i = [x for c in sources if c.name == "L(I)" for x, _y in c.points]
        imax = (2 * half if half else None) or _rating(info, "current", "isat") or (
            max(sources_i) if sources_i else 1.0)  # fmt: skip
        amps: list[float] = [imax * k / 10 for k in range(11)]
        inductances = bench.inductance_curve(run, base, top, amps, f_meas, params)
        card.curves.append(CardCurve(name="L(I)", x_unit="A", y_unit="H", x=amps,
                                     y=inductances.tolist()))  # fmt: skip
    if math.isfinite(f_meas) and kind in ("capacitor", "inductor"):
        card.notes.append(f"C and L measured at {format_value(f_meas, 'Hz', 3)} (small signal)")
    return card
