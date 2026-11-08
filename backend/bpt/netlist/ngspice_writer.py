"""IR -> ngspice netlist text."""

import re

from bpt.analysis.spec import AcAnalysis, AnalysisSpec, DcAnalysis, OpAnalysis, TranAnalysis
from bpt.document.model import ModelCard
from bpt.netlist.ir import CircuitIR, Device, Subcircuit
from bpt.units import InvalidValueError, normalize_for_spice

# Primary (positional) parameter of simple elements.
_VALUE_PARAM = {"R": "R", "C": "C", "L": "L"}
_SOURCE_KEYS = ("dc", "ac", "acphase", "tran")
# A value depending on the circuit's own voltages or currents: a nonlinear element.
_BEHAVIOURAL = re.compile(r"\b[vi]\s*\(", re.IGNORECASE)
_BRACES = re.compile(r"\{([^{}]*)\}")
_DEFINITION = re.compile(r"^\s*\.(func|param|csparam)\b", re.IGNORECASE)


def grouped_braces(expression: str) -> str:
    """``{a*b}`` as ``({a*b})`` in a behavioural expression: ngspice puts each parameter in
    parentheses on its own, so ``x/{a*b}`` would be read as ``x/(a)*(b)``."""
    return _BRACES.sub(r"({\1})", expression)


def is_behavioural(value: str) -> bool:
    """``Cnom/(1+(v(1,2)/vh)^2)``: a value written as an ngspice expression element."""
    text = value.strip()
    return bool(_BEHAVIOURAL.search(text)) and not text.startswith("{")


class NetlistError(ValueError):
    """The circuit cannot be written as a netlist."""


def _num(text: str) -> str:
    """Numeric value in SPICE syntax; expressions and unparsable text pass through."""
    try:
        return normalize_for_spice(text)
    except InvalidValueError:
        return text.strip()


def _extra(params: dict[str, str], used: set[str]) -> list[str]:
    return [f"{k}={_num(v)}" for k, v in params.items() if k not in used]


def _source_spec(device: Device) -> list[str]:
    p = device.params
    parts: list[str] = []
    if p.get("dc", "").strip():  # "" = no DC value: ngspice takes the waveform's value at t=0
        parts += ["DC", _num(p["dc"])]
    if "ac" in p:
        parts += ["AC", _num(p["ac"])]
        if "acphase" in p:
            parts.append(_num(p["acphase"]))
    if "tran" in p:
        parts.append(p["tran"].strip())
    if not parts:
        parts = ["DC", "0"]
    return parts + _extra(p, set(_SOURCE_KEYS))


def element_line(device: Device) -> str:
    p, e = device.params, device.element
    head = [device.spice_name, *device.nodes]
    match e:
        case "C" if p.get("Q", "").strip():  # a charge Q(V): a nonlinear capacitor
            tail = [f"Q={grouped_braces(p['Q'].strip())}"]
        case "R" | "C" | "L":
            key = _VALUE_PARAM[e]
            if key not in p:
                raise NetlistError(f"{device.ref}: missing value {key}")
            value = p[key].strip()
            # C(V), L(I): an ngspice expression element.
            head_value = f"{key}='{value}'" if is_behavioural(value) else _num(value)
            tail = [head_value, *_extra(p, {key})]
        case "V" | "I":
            tail = _source_spec(device)
        case "E" | "G":
            tail = [_num(p.get("gain", "1"))]
        case "F" | "H":
            if "source" not in p:
                raise NetlistError(f"{device.ref}: missing controlling source")
            tail = [p["source"], _num(p.get("gain", "1"))]
        case "B":
            kind = "v" if "v" in p else "i"
            if kind not in p:
                raise NetlistError(f"{device.ref}: behavioral source needs v= or i=")
            tail = [f"{kind.upper()}={grouped_braces(p[kind].strip())}"]
        case "D" | "Q" | "M" | "J" | "S":
            if not device.model:
                raise NetlistError(f"{device.ref}: missing model")
            tail = [device.model, *_extra(p, set())]
        case "A":  # an XSPICE code model: its parameters are in its .model card
            if not device.model:
                raise NetlistError(f"{device.ref}: missing code model")
            tail = [device.model]
        case "X":  # block of a hierarchical sheet: X<ref> nodes... <subckt>
            if not device.model:
                raise NetlistError(f"{device.ref}: missing subcircuit")
            tail = [device.model, *_extra(p, set())]  # parameter overrides: R=2k
    return " ".join([*head, *tail])


def model_line(name: str, card: ModelCard) -> str:
    params = " ".join(f"{k}={_num(v)}" for k, v in card.params.items())
    return f".model {name} {card.type}({params})"


def analysis_line(analysis: AnalysisSpec) -> str:
    match analysis:
        case OpAnalysis():
            return ".op"
        case DcAnalysis(source=src, start=a, stop=b, step=s) as dc:
            line = f".dc {src} {_num(a)} {_num(b)} {_num(s)}"
            if dc.source2 and dc.start2 and dc.stop2 and dc.step2:
                line += f" {dc.source2} {_num(dc.start2)} {_num(dc.stop2)} {_num(dc.step2)}"
            return line
        case AcAnalysis(variation=var, points=n, fstart=f1, fstop=f2):
            return f".ac {var} {n} {_num(f1)} {_num(f2)}"
        case TranAnalysis() as t:
            parts = [".tran", _num(t.tstep), _num(t.tstop), _num(t.tstart)]
            if t.tmax:
                parts.append(_num(t.tmax))
            if t.uic:
                parts.append("uic")
            return " ".join(parts)


def subckt_line(sub: Subcircuit, ports: list[str] | None = None) -> str:
    params = " ".join(f"{k}={_num(v)}" for k, v in sub.params.items())
    head = f".subckt {sub.name} {' '.join(ports if ports is not None else sub.ports)}"
    return f"{head} params: {params}" if params else head


def write_netlist(
    circuit: CircuitIR, analysis: AnalysisSpec | None = None, save_currents: bool = True
) -> list[str]:
    """Netlist lines (title first, ``.end`` last) ready for ``ngSpice_Circ``.

    ``save_currents`` stores every device current (probes, operating point overlay).
    """
    lines = [f"* {circuit.title}"]
    if save_currents and circuit.save_currents:
        lines.append(".options savecurrents")
    lines += [f".param {k}={_num(v)}" for k, v in circuit.parameters.items()]
    lines += [model_line(name, card) for name, card in sorted(circuit.models.items())]
    if circuit.globals:
        lines.append(".global " + " ".join(circuit.globals))
    # Definitions before the elements using them: ngspice needs a .func before its first use.
    defining = [d for d in circuit.directives if _DEFINITION.match(d)]
    lines += defining
    for name, model in sorted(circuit.subckt_models.items()):
        params = " ".join(f"{k}={_num(v)}" for k, v in model.params.items())
        lines.append(
            f".subckt {name} {' '.join(model.pins)}" + (f" params: {params}" if params else "")
        )
        lines += model.body
        lines.append(f".ends {name}")
    for sub in circuit.subcircuits:
        lines.append(subckt_line(sub))
        lines += sub.directives
        lines += [element_line(device) for device in sub.devices]
        lines.append(f".ends {sub.name}")
    lines += [element_line(device) for device in circuit.devices]
    lines += [d for d in circuit.directives if d not in defining]
    if analysis is not None:
        lines.append(analysis_line(analysis))
    lines.append(".end")
    return without_scripts(lines)


def is_script(line: str) -> bool:
    """``.control`` / ``.exec``: ngspice commands, which include ``shell`` (any OS command)."""
    first = line.strip().split(maxsplit=1)[0].lower() if line.strip() else ""
    return first in (".control", ".exec")


def without_scripts(lines: list[str]) -> list[str]:
    """The netlist without ngspice scripts: an imported netlist or library could otherwise run
    programs on the user's computer. Analyses come from the app, not from scripts."""
    out: list[str] = []
    inside = False
    for item in lines:
        # A directive may hold several lines; ngSpice_Circ takes one line per entry (it would
        # read only the first line of "a\nb").
        for line in item.splitlines() or [""]:
            first = line.strip().split(maxsplit=1)[0].lower() if line.strip() else ""
            if first == ".control":
                inside = True
            elif inside:
                inside = first != ".endc"
            elif first != ".exec":
                out.append(line)
    if out[-1:] != [".end"]:  # an unclosed .control must not swallow the end card
        out.append(".end")
    return out
