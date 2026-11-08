"""Import of KiCad symbol libraries (``.kicad_sym`` files and ``.kicad_symdir`` folders).

Graphics and pins only (KiCad libraries carry no simulation model for most parts); the SPICE
mapping comes from the ``Sim.Device`` / ``Sim.Pins`` fields when present, otherwise it is
guessed from the reference prefix and pin names (R, C, L, diodes A/K, BJTs C/B/E, FETs D/G/S,
op-amps +/-/output as the ideal op-amp). Parts that cannot be simulated still import: they are
drawn and the ERC says they are not simulated.

Implemented from the published file format (S-expressions, mm, y axis up), not from KiCad code.
"""

import re
from dataclasses import dataclass, field
from pathlib import Path

from bpt.document.model import Point
from bpt.units import InvalidValueError, parse_value

from .sexpr import SExpr, child, children, head, parse, value
from .symbols import (
    Arc,
    Circle,
    ElementKind,
    Graphic,
    Orientation,
    Pin,
    PinType,
    Polyline,
    Rect,
    SpiceMapping,
    Symbol,
    Text,
)

_PIN_TYPES: dict[str, PinType] = {
    "input": "input",
    "output": "output",
    "bidirectional": "bidirectional",
    "tri_state": "bidirectional",
    "power_in": "power_in",
    "power_out": "power_out",
    "open_collector": "output",
    "open_emitter": "output",
}
# KiCad's pin angle points from the connection point to the body; ours points outwards.
_OUTWARD: dict[int, Orientation] = {0: "left", 90: "down", 180: "right", 270: "up"}
_GROUND = re.compile(r"^(GND|GNDA|GNDD|GNDREF|GNDPWR|Earth|0)$", re.IGNORECASE)
_DEFAULT_VALUE = {"R": "1k", "C": "100n", "L": "1m"}


@dataclass
class Imported:
    symbols: list[Symbol] = field(default_factory=list)
    skipped: list[tuple[str, str]] = field(default_factory=list)  # (name, reason)


def _mm(text: str) -> float:
    try:
        return float(text)
    except ValueError:
        return 0.0


def _pt(x: str, y: str) -> Point:
    """KiCad mm (y up) -> 0.01 mm units (y down)."""
    return round(_mm(x) * 100), round(-_mm(y) * 100)


def _xy(expr: SExpr, name: str) -> Point:
    found = child(expr, name)
    if found is None or len(found) < 3:
        return 0, 0
    return _pt(str(found[1]), str(found[2]))


def _filled(expr: SExpr) -> bool:
    # "outline" fills with the line colour (arrows, dots); "background" would cover the body.
    return value(child(expr, "fill") or [], "type") == "outline"


def _hidden(expr: SExpr | None) -> bool:
    if not isinstance(expr, list):
        return False
    return "hide" in expr or value(expr, "hide") == "yes"


def _font_size(expr: SExpr) -> int:
    font = child(child(expr, "effects") or [], "font")
    return round(_mm(value(font or [], "size", 1, "1.27")) * 100) or 127


def _plain(name: str) -> str:
    """Pin / text markup -> plain text: "~{RESET}" (overbar) -> "RESET", "~" -> ""."""
    return "" if name == "~" else re.sub(r"[~_^]\{([^}]*)\}", r"\1", name)


def _graphics(unit: SExpr) -> list[Graphic]:
    out: list[Graphic] = []
    for item in unit if isinstance(unit, list) else []:
        kind = head(item)
        if kind == "rectangle":
            out.append(Rect(start=_xy(item, "start"), end=_xy(item, "end"), fill=_filled(item)))
        elif kind in ("polyline", "bezier"):
            pts = [_pt(str(p[1]), str(p[2])) for p in children(child(item, "pts") or [], "xy")]
            if kind == "bezier" and len(pts) == 4:
                pts = _bezier(pts)
            if len(pts) >= 2:
                out.append(Polyline(points=pts, fill=_filled(item)))
        elif kind == "circle":
            radius = round(_mm(value(item, "radius")) * 100)
            out.append(Circle(center=_xy(item, "center"), radius=radius, fill=_filled(item)))
        elif kind == "arc":
            if child(item, "mid") is not None:
                out.append(
                    Arc(start=_xy(item, "start"), mid=_xy(item, "mid"), end=_xy(item, "end"))
                )
            else:
                out.append(Polyline(points=[_xy(item, "start"), _xy(item, "end")]))
        elif kind in ("text", "text_box") and len(item) > 1 and isinstance(item[1], str):
            text = _plain(item[1]).strip()
            if not text or _hidden(child(item, "effects")):
                continue
            if child(item, "start") is not None:  # text box: centre of the box
                (x0, y0), (x1, y1) = _xy(item, "start"), _xy(item, "end")
                at: Point = ((x0 + x1) // 2, (y0 + y1) // 2)
            elif kind == "text_box" and child(item, "size") is not None:
                x, y = _xy(item, "at")
                size = child(item, "size") or []
                at = (x + round(_mm(str(size[1])) * 50), y + round(_mm(str(size[2])) * 50))
            else:
                at = _xy(item, "at")
            out.append(Text(at=at, text=text, size=_font_size(item)))
    return out


def _bezier(p: list[Point]) -> list[Point]:
    out = []
    for i in range(9):
        t = i / 8
        a, b, c, d = (1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t**2, t**3
        out.append(
            (
                round(a * p[0][0] + b * p[1][0] + c * p[2][0] + d * p[3][0]),
                round(a * p[0][1] + b * p[1][1] + c * p[2][1] + d * p[3][1]),
            )
        )
    return out


def _pins(unit: SExpr, names_shown: bool, name_offset: int) -> tuple[list[Pin], list[Graphic]]:
    pins: list[Pin] = []
    labels: list[Graphic] = []
    for item in children(unit, "pin"):
        at_expr = child(item, "at") or []
        at = _pt(str(at_expr[1]), str(at_expr[2])) if len(at_expr) >= 3 else (0, 0)
        angle = round(_mm(str(at_expr[3]))) % 360 if len(at_expr) >= 4 else 0
        orientation = _OUTWARD.get(angle, "left")
        length = round(_mm(value(item, "length", 1, "2.54")) * 100)
        hidden = _hidden(item)
        number = value(item, "number", 1, str(len(pins) + 1))
        name_expr = child(item, "name") or []
        name = _plain(str(name_expr[1])) if len(name_expr) > 1 else ""
        kind = str(item[1]) if len(item) > 1 else "passive"
        pin_type = _PIN_TYPES.get(kind, "passive")
        implicit = None
        if hidden and pin_type == "power_in" and name:  # KiCad joins it to the net of its name
            implicit = "0" if _GROUND.match(name) else name
        pins.append(
            Pin(
                number=number,
                name=name,
                at=at,
                length=0 if hidden else length,
                orientation=orientation,
                type=pin_type,
                implicit_net=implicit,
            )
        )
        if names_shown and name and not hidden and name_offset > 0:
            # Inside the body, past the inner end of the pin (texts stay upright).
            dx, dy = {"left": (-1, 0), "right": (1, 0), "up": (0, -1), "down": (0, 1)}[orientation]
            size = _font_size(name_expr)
            reach = length + name_offset + (len(name) * 0.31 * size if dx else size * 0.6)
            labels.append(
                Text(
                    at=(round(at[0] - dx * reach), round(at[1] - dy * reach)), text=name, size=size
                )
            )
    return pins, labels


def _rotated(prop: SExpr | None) -> bool:
    at = child(prop or [], "at") or []
    return len(at) >= 4 and round(_mm(str(at[3]))) % 180 == 90


def _properties(symbol: SExpr) -> dict[str, tuple[str, SExpr]]:
    out: dict[str, tuple[str, SExpr]] = {}
    for prop in children(symbol, "property"):
        if len(prop) >= 3 and isinstance(prop[1], str) and isinstance(prop[2], str):
            out[prop[1]] = (prop[2], prop)
    return out


def _spice(
    name: str, ref: str, props: dict[str, str], pins: list[Pin]
) -> tuple[SpiceMapping, dict[str, str], str | None, str | None] | None:
    """(mapping, default params, default model, value param) or None when not simulated."""
    by_name = {p.name.upper(): p.number for p in pins if p.name}
    numbers = [p.number for p in pins]
    text = f"{name} {props.get('Description', '')} {props.get('ki_keywords', '')}".upper()
    # KiCad 7+: Sim.Device / Sim.Name / Sim.Params; KiCad 5-6: Spice_Primitive / Spice_Model.
    legacy = props.get("Spice_Primitive", "").strip().upper()
    device = (props.get("Sim.Device", "") or _LEGACY_DEVICE.get(legacy, legacy)).upper()
    model_name = props.get("Sim.Name", "").strip() or (
        props.get("Spice_Model", "").strip() if legacy not in ("V", "I", "R", "C", "L") else ""
    )
    sim_pins = dict(
        pair.split("=", 1)[::-1] for pair in props.get("Sim.Pins", "").split() if "=" in pair
    )  # model pin -> symbol pin
    sequence = props.get("Spice_Node_Sequence", "").replace(",", " ").split()

    def mapped(*model_pins: str) -> list[str] | None:
        if sim_pins:
            nodes = [sim_pins.get(m) or sim_pins.get(str(i + 1)) for i, m in enumerate(model_pins)]
            return [n for n in nodes if n] if all(nodes) else None
        nodes = [by_name.get(m) for m in model_pins]
        return [n for n in nodes if n] if all(nodes) else None

    def value_of(element: str) -> str:
        raw = props.get("Value", "").strip()
        try:
            parse_value(raw)
        except InvalidValueError:
            return _DEFAULT_VALUE[element]  # "R", "C_Small", ...: a name, not a value
        return raw

    kind = device or ref.upper()
    nodes: list[str] | None
    if kind == "SUBCKT" and model_name:
        nodes = [sim_pins.get(str(i + 1), n) for i, n in enumerate(sequence or numbers)]
        return SpiceMapping(element="X", nodes=nodes), {}, model_name, None
    if kind in ("R", "C", "L") and len(numbers) == 2:
        nodes = mapped("+", "-") or numbers
        element: ElementKind = kind  # type: ignore[assignment]
        return SpiceMapping(element=element, nodes=nodes), {kind: value_of(kind)}, None, kind
    if kind == "D" or (not device and ref.upper() in ("D", "LED")):
        nodes = mapped("A", "K")
        if nodes:
            model = "LED_RED" if "LED" in text else "DZ5V1" if "ZENER" in text else "D"
            return SpiceMapping(element="D", nodes=nodes), {}, model_name or model, None
    if kind in ("NPN", "PNP") or (
        not device and ref.upper() == "Q" and {"B", "C", "E"} <= set(by_name)
    ):
        nodes = mapped("C", "B", "E")
        if nodes:
            pnp = kind == "PNP" or (not device and "PNP" in text)
            model = model_name or ("PNP" if pnp else "NPN")
            return SpiceMapping(element="Q", nodes=nodes), {}, model, None
    fet = {"D", "G", "S"} <= set(by_name) or device in ("NMOS", "PMOS", "NJFET", "PJFET")
    if fet and (device or ref.upper() in ("Q", "M", "J")):
        nodes = mapped("D", "G", "S")
        if nodes:
            p_type = device in ("PMOS", "PJFET") or (
                not device and re.search(r"P-CH|PMOS|\bP\b", text)
            )
            if device in ("NJFET", "PJFET") or (not device and "JFET" in text):
                model = model_name or ("PJF" if p_type else "NJF")
                return SpiceMapping(element="J", nodes=nodes), {}, model, None
            model = model_name or ("PMOS" if p_type else "NMOS")
            return SpiceMapping(element="M", nodes=[*nodes, nodes[2]]), {}, model, None
    if ref.upper() == "U" and not device:
        plus, minus = by_name.get("+"), by_name.get("-")
        outputs = [p.number for p in pins if p.type == "output"]
        if plus and minus and len(outputs) == 1:  # an op-amp: simulated as the ideal one
            return (
                SpiceMapping(element="E", nodes=[outputs[0], "=0", plus, minus]),
                {"gain": "1meg"},
                None,
                None,
            )
    if kind in ("V", "I") and len(numbers) == 2:
        source: ElementKind = "V" if kind == "V" else "I"
        nodes = mapped("+", "-") or numbers
        return SpiceMapping(element=source, nodes=nodes), _source(props), None, None
    return None


_LEGACY_DEVICE = {"Q": "", "M": "", "J": "", "X": "SUBCKT"}  # BJTs / FETs: guessed as before
_WAVES = {  # KiCad Sim.Type -> SPICE function with its Sim.Params in order
    "PULSE": ("PULSE", ("y1", "y2", "td", "tr", "tf", "tw", "per")),
    "SIN": ("SIN", ("dc", "ampl", "f", "td", "theta", "phase")),
    "EXP": ("EXP", ("y1", "y2", "td1", "tau1", "td2", "tau2")),
}


def _source(props: dict[str, str]) -> dict[str, str]:
    """Source parameters (dc, ac, tran) from KiCad 7+ ``Sim.*`` or KiCad 5-6 ``Spice_Model``."""
    from bpt.netlist.spice_parser import source_params

    legacy = props.get("Spice_Model", "").strip()
    if legacy and not props.get("Sim.Params"):
        try:
            return source_params(legacy) or {"dc": "0"}
        except ValueError:
            return {"dc": "0"}
    params = dict(pair.split("=", 1) for pair in props.get("Sim.Params", "").split() if "=" in pair)
    out = {"dc": params.get("dc", "0")}
    if "ac" in params:
        out["ac"] = params["ac"]
    wave = _WAVES.get(props.get("Sim.Type", "").upper())
    if wave:
        name, keys = wave
        values = [params[k] for k in keys if k in params]
        if values:
            out["tran"] = f"{name}({' '.join(values)})"
    return out


def _units(base: SExpr, base_name: str) -> list[int]:
    found = {int(m.group(1)) for u in children(base, "symbol")
             if (m := re.fullmatch(rf"{re.escape(base_name)}_(\d+)_\d+", str(u[1])))}  # fmt: skip
    return sorted(found - {0}) or [1]


def _convert(name: str, raw: SExpr, parent: SExpr | None, library: str, unit: int = 1) -> Symbol:
    props = {k: v for k, (v, _e) in _properties(raw).items()}
    prop_exprs = {k: e for k, (_v, e) in _properties(raw).items()}
    base = parent if parent is not None else raw
    base_name = str(base[1]) if isinstance(base, list) and len(base) > 1 else name
    names_expr = child(base, "pin_names")
    names_shown = not _hidden(names_expr)
    offset = round(_mm(value(names_expr or [], "offset", 1, "0.508")) * 100)

    graphics: list[Graphic] = []
    pins: list[Pin] = []
    for part in children(base, "symbol"):
        match = re.fullmatch(rf"{re.escape(base_name)}_(\d+)_(\d+)", str(part[1]))
        # Common drawing (unit 0) and this unit; the De Morgan body style (2) is not imported.
        if match is None or int(match.group(1)) not in (0, unit) or int(match.group(2)) > 1:
            continue
        graphics += _graphics(part)
        unit_pins, labels = _pins(part, names_shown, offset)
        pins += unit_pins
        graphics += labels

    ref = props.get("Reference", "U").rstrip("?") or "U"
    power = child(base, "power") is not None
    description = props.get("Description") or props.get("ki_description") or ""
    units = _units(base, base_name)
    letter = chr(ord("A") + unit - 1) if unit <= 26 else str(unit)
    if len(units) > 1:
        description = f"{description} (unit {letter} of {len(units)})".strip()
    # Unit A keeps the plain id (projects made before units were imported refer to it).
    symbol_id = f"kicad:{library}/{name}" if unit == 1 else f"kicad:{library}/{name}:{letter}"
    title = name if len(units) == 1 else f"{name} ({letter})"

    def anchor(key: str) -> Point | None:
        expr = prop_exprs.get(key)
        if expr is None or _hidden(expr) or _hidden(child(expr, "effects")):
            return None
        return _xy(expr, "at")

    def make(**fields: object) -> Symbol:
        return Symbol.model_validate({
            "id": symbol_id, "name": title, "description": description,
            "category": library, "pins": pins, "ref_prefix": ref, "graphics": graphics, **fields,
        })  # fmt: skip

    if power:
        net = props.get("Value", name)
        at = anchor("Value")
        if at is not None:
            graphics.append(Text(at=at, text=net, size=_font_size(prop_exprs["Value"])))
        return make(power_net="0" if _GROUND.match(net) else net, ref_at=None, value_at=None)
    ref_at, value_at = anchor("Reference") or (152, -64), anchor("Value")
    if _rotated(prop_exprs.get("Reference")) or _rotated(prop_exprs.get("Value")):
        # KiCad writes them vertically (often inside a narrow body); texts here stay upright,
        # so they go as two lines beside the part, like the built-in symbols.
        x, y = ref_at
        ref_at, value_at = (x, y - 64), (x, y + 64)
    sim = _spice(name, ref, props, pins)
    spice, params, model, value_param = sim if sim else (None, {}, None, None)
    if spice is None:
        description = f"{description} (not simulated: no SPICE model)".strip()
    return make(
        spice=spice,
        default_params=params,
        default_model=model,
        value_param=value_param,
        ref_at=ref_at,
        value_at=value_at if spice is not None else None,
    )


def _top_symbols(text: str) -> dict[str, SExpr]:
    root = parse(text)
    if head(root) != "kicad_symbol_lib":
        raise ValueError("not a KiCad symbol library (kicad_symbol_lib)")
    return {str(s[1]): s for s in children(root, "symbol") if len(s) > 1}


def import_kicad(path: Path) -> tuple[str, Imported]:
    """(library name, symbols) from a ``.kicad_sym`` file or a ``.kicad_symdir`` folder."""
    if path.is_dir():
        library = path.name.removesuffix(".kicad_symdir")
        raw: dict[str, SExpr] = {}
        for file in sorted(path.glob("*.kicad_sym")):
            raw |= _top_symbols(file.read_text(encoding="utf-8"))
    else:
        library = path.name.removesuffix(".kicad_sym")
        raw = _top_symbols(path.read_text(encoding="utf-8"))
    return library, convert_all(raw, library)


def convert_all(raw: dict[str, SExpr], library: str) -> Imported:
    result = Imported()
    for name, expr in raw.items():
        parent_name = value(expr, "extends")
        parent: SExpr | None = None
        seen = {name}
        while parent_name:  # derived symbol: graphics and pins of the base one
            if parent_name in seen or parent_name not in raw:
                break
            seen.add(parent_name)
            parent = raw[parent_name]
            parent_name = value(parent, "extends")
        if value(expr, "extends") and parent is None:
            result.skipped.append((name, f"base symbol {value(expr, 'extends')} not found"))
            continue
        base = parent if parent is not None else expr
        base_name = str(base[1]) if isinstance(base, list) and len(base) > 1 else name
        for unit in _units(base, base_name):
            try:
                symbol = _convert(name, expr, parent, library, unit)
            except (ValueError, IndexError, KeyError) as exc:
                result.skipped.append((name, str(exc)))
                break
            if not symbol.pins and not symbol.graphics:
                result.skipped.append((symbol.name, "empty symbol"))
                continue
            result.symbols.append(symbol)
    return result
