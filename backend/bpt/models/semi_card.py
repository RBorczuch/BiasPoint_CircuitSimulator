"""Component card of diodes and transistors: their datasheet characteristics by simulation.

* diode (LED, Zener): forward I-V (log current), reverse I-V up to breakdown, junction C(V);
* bipolar transistor: output family Ic(Vce) for steps of the base current, Ic(Vbe), hFE(Ic);
* MOSFET / JFET: output family Id(Vds) for steps of the gate voltage, transfer Id(Vgs).

The part is found by the device inside its sheet (the built-in symbol it uses) or by its port
names (A/K, C/B/E, D/G/S). P-type parts are driven with negative voltages and shown with
signs flipped, like N-type ones. Currents are cut at the rated current (or a default for
the kind), so a forward diode or a fully-on MOSFET does not fill the chart with amperes.
"""

import math
from dataclasses import dataclass
from typing import Literal

import numpy as np

from bpt.analysis.spec import AcAnalysis, TranAnalysis
from bpt.document.model import ModelCard, Project
from bpt.models import bench
from bpt.netlist.ir import Device
from bpt.results.store import RunReader
from bpt.units import format_value, to_spice

Family = Literal["diode", "bjt", "mos", "jfet"]

_DEVICES: dict[str, tuple[Family, int]] = {
    "bpt:diode": ("diode", 1), "bpt:led": ("diode", 1), "bpt:zener": ("diode", 1),
    "bpt:npn": ("bjt", 1), "bpt:pnp": ("bjt", -1),
    "bpt:nmos": ("mos", 1), "bpt:pmos": ("mos", -1),
    "bpt:njfet": ("jfet", 1), "bpt:pjfet": ("jfet", -1),
}  # fmt: skip
_PINS: dict[Family, tuple[str, ...]] = {
    "diode": ("A", "K"), "bjt": ("C", "B", "E"), "mos": ("D", "G", "S"), "jfet": ("D", "G", "S"),
}  # fmt: skip
_IMAX: dict[Family, float] = {"diode": 0.5, "bjt": 0.2, "mos": 2.0, "jfet": 0.05}
STEPS = 5  # curves in an output family


@dataclass
class Curve:
    """One computed curve; ``label`` names a member of a family (``Ib = 20 µA``)."""

    name: str
    x_unit: str
    y_unit: str
    x: np.ndarray
    y: np.ndarray
    label: str = ""


_LINEAR = {"bpt:resistor", "bpt:capacitor", "bpt:inductor", "bpt:vccs", "bpt:vcvs", "bpt:cccs",
           "bpt:ccvs", "bpt:gnd", "bpt:vsource", "bpt:isource"}  # fmt: skip


def device_of(base: Project, top: str, ports: list[str]) -> tuple[Family, int, bool] | None:
    """(family, polarity, LED) of the part: by the device in its sheets, else by port names."""
    for sheet in bench.needed_sheets(base.sheets, top):
        for instance in sheet.instances:
            if instance.symbol in _DEVICES:
                family, sign = _DEVICES[instance.symbol]
                if set(_PINS[family]) <= set(ports):
                    return family, sign, instance.symbol == "bpt:led"
    # By the port names (a manufacturer's subcircuit inside), unless the sheets hold only linear
    # parts: a small-signal model (hybrid-pi) has nothing to bias.
    if all(i.symbol in _LINEAR for sheet in bench.needed_sheets(base.sheets, top)
           for i in sheet.instances):  # fmt: skip
        return None
    for family in ("bjt", "mos", "diode"):
        if set(_PINS[family]) <= set(ports):
            return family, 1, False
    return None


FLOOR = 1e-12  # lowest current of the log charts (1 pA): below it is only numerical noise


def _cut(
    x: np.ndarray, y: np.ndarray, limit: float, log: bool = False
) -> tuple[np.ndarray, np.ndarray]:
    """The curve up to the first point above ``limit`` (that point included); for a log chart
    without the points below ``FLOOR``."""
    over = np.nonzero(y > limit)[0]
    end = int(over[0]) + 1 if over.size else len(x)
    x, y = x[:end], y[:end]
    if log:
        keep = y >= FLOOR
        x, y = x[keep], y[keep]
    return x, y


def _steps(lo: float, hi: float) -> list[float]:
    """``STEPS`` values from ``lo`` to ``hi``, rounded to a tenth of the span's decade."""
    span = abs(hi - lo) or abs(hi) or 1.0
    q = 10 ** math.floor(math.log10(span)) / 10
    return sorted({round(round((lo + (hi - lo) * k / (STEPS - 1)) / q) * q, 12)
                   for k in range(STEPS)})  # fmt: skip


def _quantity(value: float, unit: str) -> str:
    """``220 µA``: spaced like the chart's axis labels."""
    text = format_value(value, unit, 3)
    number = text.rstrip(unit).rstrip("afpnµmkMGT")
    return f"{number} {text[len(number) :]}"


def _signal(reader: RunReader, name: str) -> np.ndarray:
    return np.asarray(reader.signal(name)).real.astype(float)


def semiconductor_curves(
    run: bench.Run,
    base: Project,
    top: str,
    device: tuple[Family, int, bool],
    params: dict[str, str],
    limits: tuple[float | None, float | None, float | None],
) -> tuple[list[Curve], list[str]]:
    """Curves and notes; ``limits``: (rated voltage, rated current, breakdown voltage)."""
    family, sign, led = device
    vmax, imax, bv = limits
    imax = imax or (0.1 if led else _IMAX[family])
    notes = [] if sign > 0 else ["P-type: shown mirrored like the N-type part (signs flipped)"]
    if family == "diode":
        return _diode(run, base, top, params, imax, bv or vmax, led), notes
    if family == "bjt":
        return _bjt(run, base, top, params, sign, imax, min(vmax or 10.0, 20.0)), notes
    return _fet(run, base, top, params, family, sign, imax, min(vmax or 10.0, 20.0)), notes


def _diode(run: bench.Run, base: Project, top: str, params: dict[str, str], imax: float,
           breakdown: float | None, led: bool) -> list[Curve]:  # fmt: skip
    copies = [({"A": "a", "K": "0"}, params)]
    circuit = bench.port_circuit(base, top, copies, [bench.source("VA", "a", "0", 0)])
    reader = bench.dc_sweep(run, circuit, "VA", 0, 5.0 if led else 3.0, 301)
    volts, amps = _cut(_signal(reader, "sweep"), -_signal(reader, "I(VA)"), imax, log=True)
    curves = [Curve("I-V forward", "V", "A", volts, amps)]
    # No breakdown in the model (SPICE default BV = infinite, written as a huge number): 100 V.
    breakdown = breakdown if breakdown and breakdown < 1e4 else None
    reverse = 1.2 * breakdown if breakdown else 100.0
    reader = bench.dc_sweep(run, circuit, "VA", 0, -reverse, 401)
    volts, amps = _cut(-_signal(reader, "sweep"), _signal(reader, "I(VA)"), imax, log=True)
    curves.append(Curve("I-V reverse", "V", "A", volts, amps))
    # Junction capacitance below breakdown, small signal at 1 MHz.
    top_v = min(0.8 * breakdown, 50.0) if breakdown else 20.0
    steps = [top_v * (k / 12) ** 2 for k in range(13)]  # dense near 0 V, where C changes most
    freq = 1e6
    copies = [({"A": f"a{k}", "K": "0"}, params) for k in range(len(steps))]
    sources = [Device(ref=f"VS{k}", element="V", nodes=[f"a{k}", "0"],
                      params={"dc": to_spice(-v), "ac": "1"})
               for k, v in enumerate(steps)]  # fmt: skip
    reader = run(bench.port_circuit(base, top, copies, sources),
                 AcAnalysis(variation="lin", points=1, fstart="1meg", fstop="1meg"))  # fmt: skip
    caps = []
    for k in range(len(steps)):
        current = -complex(np.asarray(reader.signal(f"I(VS{k})"))[0])
        caps.append((current.imag / (2 * math.pi * freq)) if current else math.nan)
    curves.append(Curve("C(V)", "V", "F", np.array(steps), np.array(caps)))
    return curves


def _bjt(run: bench.Run, base: Project, top: str, params: dict[str, str], sign: int,
         imax: float, vce_max: float) -> list[Curve]:  # fmt: skip
    # Transfer: Vbe swept at Vce = 5 V.
    circuit = bench.port_circuit(base, top, [({"C": "c", "B": "b", "E": "0"}, params)], [
        bench.source("VC", "c", "0", sign * min(5.0, vce_max)),
        bench.source("VB", "b", "0", 0),
    ])  # fmt: skip
    reader = bench.dc_sweep(run, circuit, "VB", 0, sign * 1.0, 201)
    vbe = sign * _signal(reader, "sweep")
    ic = -sign * _signal(reader, "I(VC)")
    ib = -sign * _signal(reader, "I(VB)")
    vbe_cut, ic_cut = _cut(vbe, ic, imax, log=True)
    curves = [Curve("Ic(Vbe)", "V", "A", vbe_cut, ic_cut)]
    useful = (ic > 1e-6) & (ic <= imax) & (ib > 0)
    if useful.any():
        curves.append(Curve("hFE(Ic)", "A", "", ic[useful], ic[useful] / ib[useful]))
    # Output family: base current steps up to about half the maximum collector current.
    target = imax / 2
    if useful.any():
        k = int(np.argmin(np.abs(ic[useful] - target)))
        ib_top = ib[useful][k] * target / max(ic[useful][k], 1e-15)
    else:
        ib_top = target / 100
    steps = _steps(ib_top / STEPS, ib_top)
    copies = [({"C": f"c{k}", "B": f"b{k}", "E": "0"}, params) for k in range(len(steps))]
    sources = [bench.source("VCE", "vce", "0", 0)]
    for k, current in enumerate(steps):
        sources.append(bench.source(f"VM{k}", "vce", f"c{k}", 0))  # ammeter
        sources.append(bench.source(f"IB{k}", "0", f"b{k}", sign * current))
    reader = bench.dc_sweep(run, bench.port_circuit(base, top, copies, sources), "VCE", 0,
                            sign * vce_max, 101)  # fmt: skip
    vce = sign * _signal(reader, "sweep")
    for k, current in enumerate(steps):
        curves.append(Curve("Ic(Vce)", "V", "A", vce, sign * _signal(reader, f"I(VM{k})"),
                            label=f"Ib = {_quantity(current, 'A')}"))  # fmt: skip
    return curves


def _fet(run: bench.Run, base: Project, top: str, params: dict[str, str], family: Family,
         sign: int, imax: float, vds_max: float) -> list[Curve]:  # fmt: skip
    circuit = bench.port_circuit(base, top, [({"D": "d", "G": "g", "S": "0"}, params)], [
        bench.source("VD", "d", "0", sign * min(5.0, vds_max)),
        bench.source("VG", "g", "0", 0),
    ])  # fmt: skip
    lo, hi = (-5.0, 0.0) if family == "jfet" else (0.0, 10.0)
    reader = bench.dc_sweep(run, circuit, "VG", sign * lo, sign * hi, 201)
    vgs = sign * _signal(reader, "sweep")
    ids = -sign * _signal(reader, "I(VD)")
    vgs_cut, ids_cut = _cut(vgs, ids, imax)
    curves = [Curve("Id(Vgs)", "V", "A", vgs_cut, ids_cut)]
    # Gate steps from where the part starts to conduct to about half the maximum current.
    top_id = min(imax / 2, float(ids.max())) if ids.size else 0.0
    if top_id <= 0:
        return curves
    v_hi = float(vgs[int(np.nonzero(ids >= top_id)[0][0])])
    v_lo = float(vgs[int(np.nonzero(ids >= top_id / 20)[0][0])])
    steps = _steps(v_lo, v_hi)
    copies = [({"D": f"d{k}", "G": f"g{k}", "S": "0"}, params) for k in range(len(steps))]
    sources = [bench.source("VDS", "vds", "0", 0)]
    for k, volts in enumerate(steps):
        sources.append(bench.source(f"VM{k}", "vds", f"d{k}", 0))
        sources.append(bench.source(f"VG{k}", f"g{k}", "0", sign * volts))
    reader = bench.dc_sweep(run, bench.port_circuit(base, top, copies, sources), "VDS", 0,
                            sign * vds_max, 101)  # fmt: skip
    vds = sign * _signal(reader, "sweep")
    for k, volts in enumerate(steps):
        curves.append(Curve("Id(Vds)", "V", "A", vds, sign * _signal(reader, f"I(VM{k})"),
                            label=f"Vgs = {_quantity(volts, 'V')}"))  # fmt: skip
    if family == "mos":
        curves += _gate_charge(run, base, top, params, sign, top_id, min(vds_max, 10.0))
    return curves


GATE_CURRENT = 1e-3  # the gate charge bench: the gate fed a constant current, as datasheets do
GATE_TOP = 10.0  # up to Vgs = 10 V


def _gate_charge(run: bench.Run, base: Project, top: str, params: dict[str, str], sign: int,
                 drain_current: float, vdd: float) -> list[Curve]:  # fmt: skip
    """Vgs against the gate charge (Qg = Ig·t), as datasheets measure it: the drain load a
    constant ``drain_current`` clamped to ``vdd`` by a diode (an inductive load), so the gate
    stays at one voltage while the drain falls (the Miller plateau)."""
    pins = {"D": "d", "G": "g", "S": "0"}
    clamp = ModelCard(type="d", params={"is": "1e-14", "n": "0.1"})  # near ideal: 6 mV a decade
    # How long the gate takes to reach the top is not known beforehand (an imported model has no
    # capacitances to read): longer runs until it does.
    tstop = 1e-6
    for _ in range(10):
        start = tstop / 100
        pulse = (f"PULSE(0 {to_spice(sign * GATE_CURRENT)} {to_spice(start)} "
                 f"{to_spice(start / 100)} {to_spice(start / 100)} {to_spice(10 * tstop)} "
                 f"{to_spice(20 * tstop)})")  # fmt: skip
        circuit = bench.port_circuit(base, top, [(pins, params)], [
            bench.source("VDD", "vdd", "0", sign * vdd),
            bench.source("IL", "vdd", "d", sign * drain_current),
            Device(ref="DCL", element="D", nodes=["d", "vdd"] if sign > 0 else ["vdd", "d"],
                   model="DGCLAMP"),
            Device(ref="IG", element="I", nodes=["0", "g"], params={"dc": "", "tran": pulse}),
            Device(ref="RG", element="R", nodes=["g", "0"], params={"R": "1G"}),
        ])  # fmt: skip
        circuit.models["DGCLAMP"] = clamp
        reader = run(circuit, TranAnalysis(tstep=to_spice(tstop / 500), tstop=to_spice(tstop),
                                           tmax=to_spice(tstop / 500)))  # fmt: skip
        reached = float(np.max(sign * _signal(reader, "V(g)").real))
        if reached >= GATE_TOP:
            break
        # Charged at a steady rate: as far again as it is short, with some to spare.
        tstop *= min(max(1.3 * GATE_TOP / max(reached, 1e-3), 2.0), 1e3)
    t = _signal(reader, "time").real
    vgs = sign * _signal(reader, "V(g)").real
    charge = GATE_CURRENT * np.maximum(t - start, 0.0)
    keep = (t >= start) & (vgs <= GATE_TOP)
    if keep.sum() < 3:
        return []
    label = f"VDD = {_quantity(vdd, 'V')}, Id = {_quantity(drain_current, 'A')}"
    return [Curve("Vgs(Qg)", "C", "V", charge[keep], vgs[keep], label=label)]
