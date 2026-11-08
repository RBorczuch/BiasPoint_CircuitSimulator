"""Equation-defined devices (FR-MOD-9, Qucs' EDD): N branches, each between its pin Pk and a
common pin REF, with the current into Pk and the charge of the branch written as expressions of
the branch voltages V1..VN and the device's parameters.

A branch is a behavioural current source (I = its current) and, when it has a charge, a
capacitor given by that charge (Q = ...). ngspice simulates a charge only as a function of its
own branch voltage: a charge of Vk depending on another branch's voltage is ignored there (no AC,
nothing in a transient), so it is refused here with the reason. ``ddt()`` in a behavioural
source is not used for the same kind of reason (ngspice drops it in AC).
"""

import re
from dataclasses import dataclass

from bpt.document.model import Sheet

# Functions of ngspice's behavioural expressions (B sources, capacitor charges).
FUNCTIONS = {
    "abs", "acos", "acosh", "asin", "asinh", "atan", "atanh", "cos", "cosh", "exp", "ln", "log",
    "log10", "sin", "sinh", "sqrt", "tan", "tanh", "u", "uramp", "min", "max", "pow", "pwr",
    "pwrs", "sgn", "floor", "ceil", "nint", "if", "limit", "ternary_fcn",
}  # fmt: skip
CONSTANTS = {"pi", "e", "temper", "time", "hertz"}
_NAME = re.compile(r"[A-Za-z_]\w*")
_VOLTAGE = re.compile(r"\bV(\d+)\b", re.IGNORECASE)
MAX_BRANCHES = 8


@dataclass
class Branch:
    current: str  # into its pin Pk, from Pk through the device to REF
    charge: str = ""  # "" = none


class EquationError(ValueError):
    """The equations cannot make a device."""


def problems(branches: list[Branch], parameters: dict[str, str]) -> list[str]:
    """What is wrong with the equations, one line each (empty: they can be simulated)."""
    out: list[str] = []
    if not 1 <= len(branches) <= MAX_BRANCHES:
        return [f"give 1 to {MAX_BRANCHES} branches"]
    names = {p.lower() for p in parameters}
    for bad in sorted(p for p in parameters if not _NAME.fullmatch(p)):
        out.append(f"parameter “{bad}”: a name of letters, digits and _")
    for clash in sorted(p for p in names if p in FUNCTIONS or _VOLTAGE.fullmatch(p)):
        out.append(f"parameter “{clash}” is taken (a function or a voltage)")
    for k, branch in enumerate(branches, start=1):
        if not branch.current.strip() and not branch.charge.strip():
            out.append(f"branch {k}: give its current or its charge")
        for what, text in (("current", branch.current), ("charge", branch.charge)):
            if text.count("(") != text.count(")"):
                out.append(f"branch {k} {what}: the brackets do not match")
            for v in _VOLTAGE.findall(text):
                if not 1 <= int(v) <= len(branches):
                    out.append(f"branch {k} {what}: V{v}: the device has V1..V{len(branches)}")
            for name in _NAME.findall(_VOLTAGE.sub("", text)):
                low = name.lower()
                if low not in FUNCTIONS | CONSTANTS | names and not re.fullmatch(r"e\d*", low):
                    out.append(f"branch {k} {what}: unknown name “{name}”")
        others = {int(v) for v in _VOLTAGE.findall(branch.charge)} - {k}
        if others:
            listed = ", ".join(f"V{o}" for o in sorted(others))
            out.append(f"branch {k} charge: only V{k}: ngspice ignores a charge of another "
                       f"branch's voltage ({listed})")  # fmt: skip
    return out


def _spice(text: str) -> str:
    """V3 -> V(P3,REF): the branch voltages as the sheet's nets."""
    return _VOLTAGE.sub(lambda m: f"V(P{m.group(1)},REF)", text.strip())


def device_sheet(name: str, branches: list[Branch], parameters: dict[str, str]) -> Sheet:
    """The device as a sheet to place as a block: per branch a B source and a charge."""
    from bpt.models.standard_templates import _Drawing

    if errors := problems(branches, parameters):
        raise EquationError("; ".join(errors))
    pins = [f"P{k}" for k in range(1, len(branches) + 1)]
    d = _Drawing(name, [*pins, "REF"], dict(parameters))
    d.port("REF", (-4, 6), 180)
    d.wire((-4, 6), (0, 6))
    for k, branch in enumerate(branches):
        x = 10 * k
        d.port(f"P{k + 1}", (x, -7))
        d.wire((x, -7), (x, -3))
        if branch.current.strip():
            d.part(f"B{k + 1}", "bpt:bsource", (x, 0), {"i": _spice(branch.current)})
        else:  # only a charge: the branch's wire goes on to it
            d.wire((x, -3), (x, 3))
        d.wire((x, 3), (x, 6))
        if branch.charge.strip():
            d.part(f"C{k + 1}", "bpt:capacitor", (x + 4, 0), {"Q": _spice(branch.charge)})
            d.wire((x, -5), (x + 4, -5), (x + 4, -3))
            d.wire((x + 4, 3), (x + 4, 6))
            d.wire((x, 6), (x + 4, 6))
        if k:
            d.wire((x - 6, 6) if branches[k - 1].charge.strip() else (x - 10, 6), (x, 6))
    from bpt.document.model import Junction
    from bpt.render.svg import junction_dots

    d.sheet.junctions = [Junction(at=p) for p in sorted(junction_dots(d.sheet, d.symbols))]
    return d.sheet
