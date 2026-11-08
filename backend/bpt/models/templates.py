"""Standard equivalent circuits of passive parts (FR-CMP, ADR 0015).

A template is a form (fields with defaults) and a series/parallel network of R, C and L
built from the filled-in fields: empty optional fields leave their element out. From the
form the template makes

* a component sheet: the network drawn on a schematic between ports ``1`` and ``2``, with the
  field values as sheet parameters (each placed part can override them), and the symbol of
  the ideal part, so a real part fits where the ideal one was;
* the impedance at any frequency and DC bias, computed directly (fitting, quick charts).

Nonlinear elements: a class 2 MLCC loses capacitance with DC bias, ``C(V) = C / (1 + (V /
V½)²)``, and a saturating inductor loses inductance with current, ``L(I) = L / (1 + (I /
I½)²)``. The netlist writes them as ngspice expression elements (``C='...'``), which work in
every analysis including AC around the operating point.

The quick model of an ideal R, C or L (its parasitic fields, FR-CMP-5) uses the same keys as
the resistor / capacitor / inductor templates, so a part with parasitics turns into a
template component with the same values (``QUICK``).
"""

import math
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field, replace
from itertools import count

import numpy as np

from bpt.document.model import (
    Characteristic,
    Component,
    ComponentKind,
    Instance,
    Junction,
    Label,
    ModelRef,
    Point,
    Sheet,
    Template,
    Wire,
    safe_sheet_name,
)
from bpt.library.builtin import builtin_symbols
from bpt.units import InvalidValueError, format_value, parse_value

G = 127
TWO_PI = 2 * math.pi

Values = dict[str, float]


@dataclass(frozen=True)
class FieldDef:
    key: str  # sheet parameter name
    label: str
    unit: str
    default: str = ""  # "" = the element is left out until a value is given
    description: str = ""
    required: bool = False
    group: str = ""  # a heading in the form ("Advanced" is folded)


# -- the network ------------------------------------------------------------------------------


@dataclass
class Elem:
    """One R, C or L. ``spice`` is its value in the netlist, ``value`` the same in Python."""

    letter: str  # R, C, L
    spice: str
    value: Callable[[Values, float, float], float]  # (values, DC volts, DC amps) -> R/C/L


@dataclass
class Ser:
    items: list["Node"]


@dataclass
class Par:
    items: list["Node"]


Node = Elem | Ser | Par


def _param(letter: str, key: str) -> Elem:
    return Elem(letter, f"{{{key}}}", lambda v, _u, _i: v[key])


def R(key: str) -> Elem:  # noqa: N802 - element letters
    return _param("R", key)


def C(key: str) -> Elem:  # noqa: N802
    return _param("C", key)


def L(key: str) -> Elem:  # noqa: N802
    return _param("L", key)


def _impedance(node: Node, w: np.ndarray, v: Values, bias_v: float, bias_i: float) -> np.ndarray:
    match node:
        case Elem(letter="R"):
            return np.full(w.shape, node.value(v, bias_v, bias_i), dtype=complex)
        case Elem(letter="C"):
            return 1 / (1j * w * node.value(v, bias_v, bias_i))
        case Elem():
            return 1j * w * node.value(v, bias_v, bias_i)
        case Ser(items):
            return sum((_impedance(n, w, v, bias_v, bias_i) for n in items),
                       np.zeros(w.shape, complex))  # fmt: skip
        case Par(items):
            y = sum((1 / _impedance(n, w, v, bias_v, bias_i) for n in items),
                    np.zeros(w.shape, complex))  # fmt: skip
            return 1 / y


def _prune(node: Node | None) -> Node | None:
    """Drop empty groups; a group of one is that one."""
    match node:
        case Ser(items) | Par(items):
            kept = [n for n in (_prune(i) for i in items) if n is not None]
            if not kept:
                return None
            return kept[0] if len(kept) == 1 else type(node)(kept)
    return node


# -- templates --------------------------------------------------------------------------------


@dataclass(frozen=True)
class TemplateDef:
    name: str
    label: str
    kind: ComponentKind
    symbol: str  # the ideal part's symbol (pins 1 and 2)
    description: str
    fields: list[FieldDef]
    network: Callable[[Values], Node | None]  # from the given fields (absent keys: no element)
    main: str  # the field shown as the part's value
    prepare: Callable[[Values], Values] = field(default=lambda v: v)  # derived values
    look: str | None = None  # the ideal symbol's other drawing parts get (a polarized capacitor)

    def field(self, key: str) -> FieldDef:
        return next(f for f in self.fields if f.key == key)


def _has(v: Values, *keys: str) -> bool:
    return all(k in v for k in keys)


def _resistor(v: Values) -> Node | None:
    return Par([Ser([R("Rnom"), *([L("ls")] if _has(v, "ls") else [])]),
                *([C("cp")] if _has(v, "cp") else [])])  # fmt: skip


def _capacitor(v: Values) -> Node | None:
    return Ser([Par([C("Cnom"), *([R("rleak")] if _has(v, "rleak") else [])]),
                *([R("esr")] if _has(v, "esr") else []),
                *([L("esl")] if _has(v, "esl") else [])])  # fmt: skip


def _mlcc(v: Values) -> Node | None:
    if not _has(v, "vhalf"):
        return _capacitor(v)
    # The DC bias of the dielectric is the part's voltage (ports 1-2): no DC current flows
    # through ESR or ESL, the leakage current is negligible.
    cv = Elem("C", "Cnom/(1+(v(1,2)/vhalf)^2)",
              lambda val, u, _i: val["Cnom"] / (1 + (u / val["vhalf"]) ** 2))  # fmt: skip
    return Ser([Par([cv, *([R("rleak")] if _has(v, "rleak") else [])]),
                *([R("esr")] if _has(v, "esr") else []),
                *([L("esl")] if _has(v, "esl") else [])])  # fmt: skip


def _electrolytic(v: Values) -> Node | None:
    # ESR falls with frequency: rlf in parallel with a capacitance that shorts it above flf.
    rise: list[Node] = []
    if _has(v, "rlf", "flf"):
        cd = Elem("C", "{1/(6.283185307*flf*rlf)}",
                  lambda val, _u, _i: 1 / (TWO_PI * val["flf"] * val["rlf"]))  # fmt: skip
        rise = [Par([R("rlf"), cd])]
    return Ser([Par([C("Cnom"), *([R("rleak")] if _has(v, "rleak") else [])]),
                *([R("esr")] if _has(v, "esr") else []), *rise,
                *([L("esl")] if _has(v, "esl") else [])])  # fmt: skip


def _film(v: Values) -> Node | None:
    absorption: list[Node] = [Ser([R("rda"), C("cda")])] if _has(v, "rda", "cda") else []
    return Ser([Par([C("Cnom"), *([R("rins")] if _has(v, "rins") else []), *absorption]),
                *([R("esr")] if _has(v, "esr") else []),
                *([L("esl")] if _has(v, "esl") else [])])  # fmt: skip


def _inductor(v: Values) -> Node | None:
    if _has(v, "isat"):
        coil = Elem("L", "Lnom/(1+(i(L1)/isat)^2)",
                    lambda val, _u, i: val["Lnom"] / (1 + (i / val["isat"]) ** 2))  # fmt: skip
    else:
        coil = L("Lnom")
    # The winding's resistance rises with frequency (skin and proximity effects): rac in
    # parallel with an inductance that shorts it below fac.
    ac: list[Node] = []
    if _has(v, "rac", "fac"):
        lx = Elem("L", "{rac/(6.283185307*fac)}",
                  lambda val, _u, _i: val["rac"] / (TWO_PI * val["fac"]))  # fmt: skip
        ac = [Par([R("rac"), lx])]
    return Par([Ser([coil, *([R("dcr")] if _has(v, "dcr") else []), *ac]),
                *([C("cp")] if _has(v, "cp") else []),
                *([R("rp")] if _has(v, "rp") else [])])  # fmt: skip


def _inductor_prepare(v: Values) -> Values:
    """The self-resonance sets the winding capacitance when that is not given."""
    if "cp" not in v and "srf" in v and "Lnom" in v:
        return {**v, "cp": 1 / ((TWO_PI * v["srf"]) ** 2 * v["Lnom"])}
    return v


_ESR = FieldDef("esr", "ESR", "Ω", "10m", "Equivalent series resistance")
_ESL = FieldDef("esl", "ESL", "H", "1n", "Equivalent series inductance (leads, package)")
_LEAK = FieldDef("rleak", "R leak", "Ω", "", "Leakage (insulation) resistance")

TEMPLATES: dict[str, TemplateDef] = {t.name: t for t in [
    TemplateDef(
        "resistor", "Resistor", "resistor", "bpt:resistor",
        "Resistance with series inductance and parallel capacitance",
        [FieldDef("Rnom", "R", "Ω", "1k", "Resistance", required=True),
         FieldDef("ls", "Ls", "H", "", "Series inductance (leads, film spiral)"),
         FieldDef("cp", "Cp", "F", "", "Parallel capacitance (end caps, pads)")],
        _resistor, "Rnom"),
    TemplateDef(
        "capacitor", "Capacitor", "capacitor", "bpt:capacitor",
        "Capacitance with ESR, ESL and leakage",
        [FieldDef("Cnom", "C", "F", "100n", "Capacitance", required=True), _ESR, _ESL, _LEAK],
        _capacitor, "Cnom"),
    TemplateDef(
        "mlcc", "MLCC class 2 (DC bias)", "capacitor", "bpt:capacitor",
        "Ceramic X5R / X7R capacitor: capacitance falls with DC voltage",
        [FieldDef("Cnom", "C", "F", "10u", "Capacitance at 0 V", required=True),
         FieldDef("vhalf", "V½", "V", "6.3", "DC bias at which the capacitance falls to half"),
         FieldDef("esr", "ESR", "Ω", "5m", "Equivalent series resistance"),
         FieldDef("esl", "ESL", "H", "500p", "Equivalent series inductance"), _LEAK],
        _mlcc, "Cnom"),
    TemplateDef(
        "electrolytic", "Electrolytic / tantalum", "capacitor", "bpt:capacitor",
        "Aluminium or tantalum capacitor: ESR higher at low frequency",
        [FieldDef("Cnom", "C", "F", "100u", "Capacitance", required=True),
         FieldDef("esr", "ESR (HF)", "Ω", "50m", "ESR at high frequency"),
         FieldDef("rlf", "ESR rise", "Ω", "200m", "Extra ESR at low frequency"),
         FieldDef("flf", "f rise", "Hz", "1k", "Frequency at which the extra ESR halves"),
         FieldDef("esl", "ESL", "H", "10n", "Equivalent series inductance"),
         FieldDef("rleak", "R leak", "Ω", "1meg", "Leakage resistance")],
        _electrolytic, "Cnom", look="polarized"),
    TemplateDef(
        "film", "Film", "capacitor", "bpt:capacitor",
        "Film capacitor: low ESR, high insulation, dielectric absorption",
        [FieldDef("Cnom", "C", "F", "1u", "Capacitance", required=True),
         FieldDef("esr", "ESR", "Ω", "5m", "Equivalent series resistance"),
         FieldDef("esl", "ESL", "H", "10n", "Equivalent series inductance"),
         FieldDef("rins", "R ins", "Ω", "10G", "Insulation resistance"),
         FieldDef("rda", "R da", "Ω", "", "Dielectric absorption: series resistance"),
         FieldDef("cda", "C da", "F", "", "Dielectric absorption: capacitance")],
        _film, "Cnom"),
    TemplateDef(
        "inductor", "Inductor", "inductor", "bpt:inductor",
        "Inductance with winding resistance and capacitance, core loss and saturation",
        [FieldDef("Lnom", "L", "H", "10u", "Inductance at zero current", required=True),
         FieldDef("dcr", "DCR", "Ω", "50m", "Winding (DC) resistance"),
         FieldDef("cp", "Cp", "F", "", "Winding capacitance (or give the SRF)"),
         FieldDef("srf", "SRF", "Hz", "30meg", "Self-resonant frequency (sets Cp)"),
         FieldDef("rac", "R AC", "Ω", "", "Extra winding resistance at high frequency (ACR)"),
         FieldDef("fac", "f AC", "Hz", "", "Frequency at which that extra resistance is half"),
         FieldDef("rp", "R core", "Ω", "", "Core loss resistance (parallel)"),
         FieldDef("isat", "I½", "A", "", "Current at which the inductance falls to half")],
        _inductor, "Lnom", _inductor_prepare),
]}  # fmt: skip

# Quick model of an ideal part: (template, field holding the part's value parameter).
QUICK: dict[str, tuple[str, str, str]] = {
    "bpt:resistor": ("resistor", "R", "Rnom"),
    "bpt:capacitor": ("capacitor", "C", "Cnom"),
    "bpt:inductor": ("inductor", "L", "Lnom"),
}


# The headings of the forms: what to fill in first, what only some parts need.
_GROUPS: dict[str, dict[str, str]] = {
    "resistor": {"Main": "Rnom", "Parasitics": "ls cp"},
    "capacitor": {"Main": "Cnom", "Loss": "esr rleak", "Parasitics": "esl"},
    "mlcc": {"Main": "Cnom vhalf", "Loss": "esr rleak", "Parasitics": "esl"},
    "electrolytic": {"Main": "Cnom", "Loss": "esr rlf flf rleak", "Parasitics": "esl"},
    "film": {"Main": "Cnom", "Loss": "esr rins", "Parasitics": "esl", "Advanced": "rda cda"},
    "inductor": {"Main": "Lnom isat", "Loss": "dcr rac fac rp", "Parasitics": "cp srf"},
}
TEMPLATES = {
    name: replace(template, fields=[
        replace(f, group=next(g for g, keys in _GROUPS[name].items() if f.key in keys.split()))
        for f in template.fields
    ])
    for name, template in TEMPLATES.items()
}  # fmt: skip


class TemplateError(ValueError):
    """The form cannot make an equivalent circuit."""


def get(name: str) -> TemplateDef:
    try:
        return TEMPLATES[name]
    except KeyError as exc:
        raise TemplateError(f"no template {name!r}") from exc


def numbers(template: TemplateDef, values: dict[str, str], partial: bool = False) -> Values:
    """Form text -> numbers (empty fields absent), with the derived values."""
    out: Values = {}
    for f in template.fields:
        text = values.get(f.key, "").strip()
        if not text:
            if f.required and not partial:
                raise TemplateError(f"{f.label} is required")
            continue
        try:
            out[f.key] = parse_value(text)
        except InvalidValueError as exc:
            raise TemplateError(f"{f.label}: {exc}") from exc
        if out[f.key] <= 0:
            raise TemplateError(f"{f.label} must be positive")
    return template.prepare(out)


def defaults(template: TemplateDef) -> dict[str, str]:
    return {f.key: f.default for f in template.fields if f.default}


def network(template: TemplateDef, values: Values) -> Node:
    node = _prune(template.network(values))
    if node is None:
        raise TemplateError("the form gives no elements")
    return node


def impedance(
    template: TemplateDef,
    values: Values,
    freqs: np.ndarray,
    bias_v: float = 0.0,
    bias_i: float = 0.0,
) -> np.ndarray:
    """Complex impedance between the ports at ``freqs`` around a DC operating point."""
    w = TWO_PI * np.asarray(freqs, dtype=float)
    return _impedance(network(template, values), w, values, bias_v, bias_i)


def capacitance(template: TemplateDef, values: Values, volts: np.ndarray) -> np.ndarray:
    """Small-signal capacitance at DC bias ``volts`` (from the reactance well below SRF)."""
    out = []
    for u in np.asarray(volts, dtype=float):
        f = _low_frequency(template, values)
        z = impedance(template, values, np.array([f]), bias_v=float(u))[0]
        out.append(-1 / (TWO_PI * f * z.imag))
    return np.array(out)


def inductance(template: TemplateDef, values: Values, amps: np.ndarray) -> np.ndarray:
    """Small-signal inductance at DC current ``amps``."""
    out = []
    for i in np.asarray(amps, dtype=float):
        f = _low_frequency(template, values)
        z = impedance(template, values, np.array([f]), bias_i=float(i))[0]
        out.append(z.imag / (TWO_PI * f))
    return np.array(out)


def _low_frequency(template: TemplateDef, values: Values) -> float:
    """A frequency where the main reactance dominates (a decade under the resonances)."""
    if template.kind == "inductor":
        lnom, dcr = values["Lnom"], values.get("dcr", 0.0)
        f = 100 * dcr / (TWO_PI * lnom) if dcr else 1e3  # well above the L/R corner
        if "cp" in values:
            f = min(f, 0.01 / (TWO_PI * math.sqrt(lnom * values["cp"])))
        return f
    cnom = values["Cnom"]
    esl = values.get("esl", 0.0)
    return 0.01 / (TWO_PI * math.sqrt(cnom * esl)) if esl else 1e3


# -- the component sheet ----------------------------------------------------------------------

_LEAF_W, _GAP, _RAIL, _ROW = 6 * G, 2 * G, 2 * G, G


@dataclass
class _Drawing:
    instances: list[Instance] = field(default_factory=list)
    wires: list[Wire] = field(default_factory=list)
    labels: list[Label] = field(default_factory=list)
    refs: dict[str, Iterator[int]] = field(default_factory=dict)

    def wire(self, a: Point, b: Point) -> None:
        if a != b:
            self.wires.append(Wire(points=[a, b]))

    def ref(self, letter: str) -> str:
        return f"{letter}{next(self.refs.setdefault(letter, count(1)))}"


def _size(node: Node) -> tuple[int, int, int]:
    """(width, room above the axis, room below)."""
    match node:
        case Elem():
            return _LEAF_W, 2 * G, 2 * G
        case Ser(items):
            sizes = [_size(n) for n in items]
            width = sum(s[0] for s in sizes) + _GAP * (len(items) - 1)
            return width, max(s[1] for s in sizes), max(s[2] for s in sizes)
        case Par(items):
            sizes = [_size(n) for n in items]
            width = max(s[0] for s in sizes) + 2 * _RAIL
            below = sum(s[1] + s[2] + _ROW for s in sizes[1:]) + sizes[0][2]
            return width, sizes[0][1], below


def _draw(node: Node, x: int, y: int, out: _Drawing) -> None:
    """Draw ``node`` with its terminals at (x, y) and (x + width, y)."""
    match node:
        case Elem():
            # Rotated 270°: pin 1 on the left, pin 2 on the right of the horizontal part.
            symbol = {"R": "bpt:resistor", "C": "bpt:capacitor", "L": "bpt:inductor"}
            out.instances.append(Instance(
                ref=out.ref(node.letter), symbol=symbol[node.letter], at=(x + 3 * G, y),
                rot=270, model=ModelRef(params={node.letter: node.spice}),
            ))  # fmt: skip
        case Ser(items):
            for i, child in enumerate(items):
                width = _size(child)[0]
                _draw(child, x, y, out)
                if i < len(items) - 1:
                    out.wire((x + width, y), (x + width + _GAP, y))
                x += width + _GAP
        case Par(items):
            width = _size(node)[0]
            inner = width - 2 * _RAIL
            row_y, last_y = y, y
            for i, child in enumerate(items):
                w, up, down = _size(child)
                if i:
                    row_y += up
                offset = (inner - w) // 2 // G * G
                start, end = x + _RAIL + offset, x + _RAIL + offset + w
                out.wire((x, row_y), (start, row_y))
                out.wire((end, row_y), (x + width, row_y))
                _draw(child, start, row_y, out)
                last_y = row_y
                row_y += down + _ROW
            out.wire((x, y), (x, last_y))
            out.wire((x + width, y), (x + width, last_y))


def _junctions(drawing: _Drawing) -> list[Junction]:
    """Dots where three or more wire ends meet (or a wire end meets a wire's interior)."""
    ends: dict[Point, int] = {}
    for wire in drawing.wires:
        for p in (wire.points[0], wire.points[-1]):
            ends[p] = ends.get(p, 0) + 1
    out = []
    for p, n in ends.items():
        through = sum(
            1 for w in drawing.wires
            if p not in (w.points[0], w.points[-1]) and _inside(p, w.points[0], w.points[-1])
        )  # fmt: skip
        if n + 2 * through >= 3:
            out.append(Junction(at=p))
    return out


def _inside(p: Point, a: Point, b: Point) -> bool:
    return (a[0] == b[0] == p[0] and min(a[1], b[1]) < p[1] < max(a[1], b[1])) or (
        a[1] == b[1] == p[1] and min(a[0], b[0]) < p[0] < max(a[0], b[0])
    )


def spice_text(value: float) -> str:
    """A field value as the sheet parameter text (4 significant digits, SPICE suffixes)."""
    text = format_value(value, "", 4)
    return text.replace("µ", "u").replace("M", "meg")


def build_sheet(template: TemplateDef, form: dict[str, str], name: str) -> Sheet:
    """The equivalent-circuit sheet for the filled-in ``form`` (ports 1 and 2)."""
    values = numbers(template, form)
    node = network(template, values)
    drawing = _Drawing()
    width = _size(node)[0]
    x0 = 4 * G
    _draw(node, x0, 0, drawing)
    drawing.wire((0, 0), (x0, 0))
    drawing.wire((x0 + width, 0), (x0 + width + 4 * G, 0))
    drawing.labels += [Label(kind="port", text="1", at=(0, 0)),
                       Label(kind="port", text="2", at=(x0 + width + 4 * G, 0))]  # fmt: skip
    ideal = builtin_symbols()[template.symbol]
    look = next((lk for lk in ideal.looks if lk.name == template.look), None)
    symbol = ideal.model_copy(update={
        "id": f"sheet:{name}", "description": template.description,
        "parasitics": [], "variants": [],
        # A polarized part is drawn as one (pin 1 is +), its other drawings stay to choose.
        "graphics": look.graphics if look else ideal.graphics,
        "looks": [lk for lk in ideal.looks if lk.name.startswith("electrolytic")] if look else [],
    })  # fmt: skip
    # Parameters: the form as given plus derived values the network uses (Cp from the SRF).
    used = {key: spice_text(v) for key, v in values.items()}
    # A field as typed stays as typed (1000u on the can, not 1m).
    used |= {k: t.strip() for k, t in form.items() if k in used and t.strip()}
    parameters = {f.key: used[f.key] for f in template.fields if f.key in used}
    parameters |= {k: v for k, v in used.items() if k not in parameters}
    return Sheet(
        name=name, instances=drawing.instances, wires=drawing.wires, labels=drawing.labels,
        junctions=_junctions(drawing), parameters=parameters, symbol=symbol,
        port_sides={"1": "left", "2": "right"}, port_order=["1", "2"],
    )  # fmt: skip


def template_component(
    template: TemplateDef,
    form: dict[str, str],
    library: str,
    name: str,
    *,
    description: str = "",
    metadata: dict[str, str] | None = None,
    ratings: dict[str, str] | None = None,
    characteristics: list[Characteristic] | None = None,
) -> Component:
    """A library component made from the filled-in template form."""
    filled = {k: v.strip() for k, v in form.items() if v.strip()}
    return Component(
        id=f"cmp:{library}/{name}", name=name, kind=template.kind,
        description=description or template.description, metadata=dict(metadata or {}),
        ratings=dict(ratings or {}), template=Template(name=template.name, values=filled),
        characteristics=list(characteristics or []),
        sheets=[build_sheet(template, filled, safe_sheet_name(name))],
    )  # fmt: skip
