"""Component card of parts with more than two pins by simulation: transformers and op-amps.

* transformer (ports P1 P2 S1 S2, or the first four of a transformer in order): the voltage
  ratio secondary / primary over frequency with the secondary open, and the primary's
  impedance with the secondary open (magnetizing inductance, core loss, winding resonance) and
  shorted (leakage inductance and the winding resistances);
* op-amp (ports + - V+ V- out): the open-loop gain and phase (a follower at DC through a huge
  inductor, the inverting input held at AC ground by a huge capacitor), the DC transfer of a
  follower across the supplies (output swing, offset) and its step response (slew rate,
  settling).
"""

from collections.abc import Callable

import numpy as np

from bpt.analysis.spec import TranAnalysis
from bpt.document.model import Project
from bpt.models import bench
from bpt.models.semi_card import Curve
from bpt.netlist.ir import Device
from bpt.results.store import RunReader
from bpt.units import to_spice

TRANSFORMER = ("P1", "P2", "S1", "S2")
OPAMP = ("+", "-", "V+", "V-", "out")
SUPPLY = 12.0  # ± volts of the op-amp bench
_HUGE_L, _HUGE_C = "1e9", "1"  # the open-loop bench: DC feedback only, AC ground at "-"

Value = Callable[[str], float | None]


HYBRID = ("B", "C", "E")


def family(kind: str, ports: list[str]) -> str | None:
    """ "transformer", "opamp" or "hybrid" (a small-signal transistor, no model to bias: a
    transistor with a model is drawn by ``semi_card`` first) when the card can draw the part."""
    if set(OPAMP) <= set(ports):
        return "opamp"
    if kind == "transistor" and set(ports) == set(HYBRID):
        return "hybrid"
    if set(TRANSFORMER) <= set(ports) or (kind == "transformer" and len(ports) >= 4):
        return "transformer"
    return None


def _signal(reader: RunReader, name: str) -> np.ndarray:
    return np.asarray(reader.signal(name), dtype=complex)


def _element(ref: str, plus: str, minus: str, value: str) -> Device:
    return Device(ref=ref, element=ref[0], nodes=[plus, minus], params={ref[0]: value})  # type: ignore[arg-type]


def multiport_curves(run: bench.Run, base: Project, top: str, kind: str, ports: list[str],
                     params: dict[str, str], value: Value, *, full: bool = True
                     ) -> list[Curve] | None:  # fmt: skip
    """Curves of a transformer or an op-amp; None for other parts. Not ``full``: an op-amp's
    frequency response only (fitting needs no swing or step, each a simulation of its own)."""
    match family(kind, ports):
        case "transformer":
            names = TRANSFORMER if set(TRANSFORMER) <= set(ports) else tuple(ports[:4])
            return _transformer(run, base, top, params, names)
        case "opamp":
            return _opamp(run, base, top, params, value, full)
        case "hybrid":
            return _hybrid(run, base, top, params)
    return None


def _hybrid(run: bench.Run, base: Project, top: str, params: dict[str, str]) -> list[Curve]:
    """The short-circuit current gain h21 = Ic/Ib against frequency (the collector held at AC
    ground): β at low frequency, falling to 1 at fT."""
    circuit = bench.port_circuit(base, top, [({"B": "b", "C": "c", "E": "0"}, params)], [
        Device(ref="IB", element="I", nodes=["0", "b"], params={"dc": "0", "ac": "1"}),
        Device(ref="VC", element="V", nodes=["c", "0"], params={"dc": "0"}),
    ])  # fmt: skip
    reader = run(circuit, bench.frequency_grid(10, 1e10))
    f = _signal(reader, "frequency").real
    return [Curve("h21(f)", "Hz", "", f, np.abs(_signal(reader, "I(VC)")))]


def _transformer(run: bench.Run, base: Project, top: str, params: dict[str, str],
                 names: tuple[str, ...]) -> list[Curve]:  # fmt: skip
    p1, p2, s1, s2 = names
    copies = [
        ({p1: "pa", p2: "0", s1: "sa", s2: "0"}, params),  # secondary open
        ({p1: "pb", p2: "0", s1: "0", s2: "0"}, params),  # secondary shorted
    ]
    sources = [
        Device(ref="VA", element="V", nodes=["pa", "0"], params={"dc": "0", "ac": "1"}),
        Device(ref="VB", element="V", nodes=["pb", "0"], params={"dc": "0", "ac": "1"}),
    ]
    reader = run(bench.port_circuit(base, top, copies, sources), bench.frequency_grid(10, 1e8))
    f = _signal(reader, "frequency").real
    ratio = np.abs(_signal(reader, "V(sa)"))
    z_open = np.abs(1 / -_signal(reader, "I(VA)"))
    z_short = np.abs(1 / -_signal(reader, "I(VB)"))
    return [
        Curve("Ratio(f)", "Hz", "V/V", f, ratio),
        Curve("|Zin|(f)", "Hz", "Ω", f, z_open, label="secondary open"),
        Curve("|Zin|(f)", "Hz", "Ω", f, z_short, label="secondary shorted"),
    ]


def _opamp(run: bench.Run, base: Project, top: str, params: dict[str, str],
           value: Value, full: bool = True) -> list[Curve]:  # fmt: skip
    pins = {"+": "inp", "-": "inn", "V+": "vcc", "V-": "vee", "out": "out"}
    supplies = [bench.source("VCC", "vcc", "0", SUPPLY), bench.source("VEE", "vee", "0", -SUPPLY)]
    gbw = value("gbw") or 1e6
    slew = value("sr") or 1e6
    # Open loop: a follower at DC (no saturation by the offset), open above a millihertz.
    circuit = bench.port_circuit(base, top, [(pins, params)], [
        *supplies,
        Device(ref="VIN", element="V", nodes=["inp", "0"], params={"dc": "0", "ac": "1"}),
        _element("LFB", "out", "inn", _HUGE_L),
        _element("CFB", "inn", "0", _HUGE_C),
    ])  # fmt: skip
    fmax = min(max(100 * gbw, 1e6), 1e10)
    reader = run(circuit, bench.frequency_grid(0.1, fmax))
    f = _signal(reader, "frequency").real
    gain = _signal(reader, "V(out)")
    curves = [
        Curve("Aol(f)", "Hz", "dB", f, 20 * np.log10(np.maximum(np.abs(gain), 1e-12))),
        Curve("Aol phase(f)", "Hz", "°", f, np.degrees(np.unwrap(np.angle(gain)))),
    ]
    if not full:
        return curves
    # A follower over the supply range: the output swing and the offset.
    follower = {**pins, "-": "out"}
    circuit = bench.port_circuit(base, top, [(follower, params)],
                                 [*supplies, bench.source("VIN", "inp", "0", 0)])  # fmt: skip
    reader = bench.dc_sweep(run, circuit, "VIN", -SUPPLY, SUPPLY, 241)
    curves.append(Curve("Vout(Vin)", "V", "V", _signal(reader, "sweep").real,
                        _signal(reader, "V(out)").real))  # fmt: skip
    # A 10 V step into the follower: the slope is the slew rate, then it settles.
    step = 10.0
    tstop = 3 * (step / slew + 5 / (2 * np.pi * gbw))
    start, rise = tstop / 10, tstop / 2000
    times = " ".join(to_spice(t) for t in (start, rise, rise, tstop, 4 * tstop))
    pulse = f"PULSE({to_spice(-step / 2)} {to_spice(step / 2)} {times})"
    source = Device(ref="VIN", element="V", nodes=["inp", "0"], params={"dc": "", "tran": pulse})
    circuit = bench.port_circuit(base, top, [(follower, params)], [*supplies, source])
    reader = run(circuit, TranAnalysis(tstep=to_spice(tstop / 500), tstop=to_spice(tstop),
                                       tmax=to_spice(tstop / 1000)))  # fmt: skip
    curves.append(Curve("Vout(t)", "s", "V", _signal(reader, "time").real,
                        _signal(reader, "V(out)").real, label="output"))  # fmt: skip
    curves.append(Curve("Vout(t)", "s", "V", _signal(reader, "time").real,
                        _signal(reader, "V(inp)").real, label="input"))  # fmt: skip
    return curves
