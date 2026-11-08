"""Schematic -> SVG (export, and screenshots for agents when no GUI is open).

Draws from the same data as the browser renderer (apps/web/src/editor/renderer.ts): wires,
junction dots, symbol graphics placed with their transform, upright texts, labels and
directives. Colors follow the light or dark canvas palette.
"""

import re
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from xml.sax.saxutils import escape, unescape

from bpt.document.model import Instance, Label, Point, Sheet
from bpt.library.symbols import Arc, Circle, Polyline, Rect, Standard, Symbol, Text
from bpt.netlist.connectivity import segment_index, transform

LINE, WIRE, DOT, TEXT = 16, 18, 32, 110
FONT = "Inter, Segoe UI, Arial, sans-serif"
MONO = "JetBrains Mono, Consolas, monospace"
PALETTES = {
    "dark": {"background": "#111113", "symbol": "#d4d4d8", "wire": "#34d399", "label": "#60a5fa",
             "power": "#f87171", "text": "#a1a1aa", "ref": "#e4e4e7", "directive": "#c084fc",
             "parasitic": "#fb923c"},
    "light": {"background": "#ffffff", "symbol": "#27272a", "wire": "#059669", "label": "#2563eb",
              "power": "#dc2626", "text": "#52525b", "ref": "#18181b", "directive": "#9333ea",
              "parasitic": "#c2410c"},
}  # fmt: skip
ROUND = 'stroke-linecap="round" stroke-linejoin="round"'
_DIRS = {"up": (0, -1), "down": (0, 1), "left": (-1, 0), "right": (1, 0)}


@dataclass
class Box:
    min_x: float
    min_y: float
    max_x: float
    max_y: float

    def grow(self, x: float, y: float, pad: float = 0) -> None:
        self.min_x, self.min_y = min(self.min_x, x - pad), min(self.min_y, y - pad)
        self.max_x, self.max_y = max(self.max_x, x + pad), max(self.max_y, y + pad)

    @property
    def empty(self) -> bool:
        return self.min_x > self.max_x


def _new_box() -> Box:
    inf = float("inf")
    return Box(inf, inf, -inf, -inf)


def symbol_box(symbol: Symbol) -> Box:
    box = _new_box()
    for g in symbol.graphics:
        if isinstance(g, Polyline):
            for p in g.points:
                box.grow(*p)
        elif isinstance(g, Rect):
            box.grow(*g.start)
            box.grow(*g.end)
        elif isinstance(g, Circle):
            box.grow(*g.center, pad=g.radius)
        elif isinstance(g, Arc):
            for p in (g.start, g.mid, g.end):
                box.grow(*p)
        elif isinstance(g, Text):
            box.grow(*g.at, pad=g.size / 2)
    for pin in symbol.pins:
        box.grow(*pin.at)
    if box.empty:
        box.grow(0, 0, pad=64)
    return box


def instance_box(symbol: Symbol, inst: Instance) -> Box:
    local = symbol_box(symbol.with_look(inst.look, params=inst.model.params))
    box = _new_box()
    for corner in ((local.min_x, local.min_y), (local.max_x, local.min_y),
                   (local.min_x, local.max_y), (local.max_x, local.max_y)):  # fmt: skip
        box.grow(*transform((round(corner[0]), round(corner[1])), inst), pad=25)
    return box


def sheet_bounds(
    sheet: Sheet, symbols: dict[str, Symbol], refs: set[str] | None = None
) -> Box | None:
    """Bounds of everything (or only instances with the given refs, lower case)."""
    box = _new_box()
    for inst in sheet.instances:
        if refs is not None and inst.ref.lower() not in refs:
            continue
        symbol = symbols.get(inst.symbol)
        b = instance_box(symbol, inst) if symbol else Box(*inst.at, *inst.at)
        box.grow(b.min_x, b.min_y)
        box.grow(b.max_x, b.max_y)
    if refs is None:
        for wire in sheet.wires:
            for p in wire.points:
                box.grow(*p)
        for label in sheet.labels:
            lb = label_box(label)
            box.grow(lb.min_x, lb.min_y)
            box.grow(lb.max_x, lb.max_y)
        for d in sheet.directives:
            lines = d.text.split("\n")
            box.grow(*d.at, pad=60)
            box.grow(d.at[0] + max(len(line) for line in lines) * 70, d.at[1] + len(lines) * 143)
    return None if box.empty else box


def _on_segment(p: Point, a: Point, b: Point) -> bool:
    if (b[0] - a[0]) * (p[1] - a[1]) != (b[1] - a[1]) * (p[0] - a[0]):
        return False
    return min(a[0], b[0]) <= p[0] <= max(a[0], b[0]) and min(a[1], b[1]) <= p[1] <= max(a[1], b[1])


def junction_dots(sheet: Sheet, symbols: dict[str, Symbol]) -> set[Point]:
    """Explicit junctions, T-connections and points where three or more ends meet."""
    counts: Counter[Point] = Counter()
    for wire in sheet.wires:
        counts[wire.points[0]] += 1
        counts[wire.points[-1]] += 1
    for inst in sheet.instances:
        symbol = symbols.get(inst.symbol)
        if symbol:
            for pin in symbol.pins:
                counts[transform(pin.at, inst)] += 1
    dots = {p for p, n in counts.items() if n >= 3}
    through = segment_index([wire.points for wire in sheet.wires])
    for p in counts:
        for index in through(p):  # a wire passing through (not ending at) the point
            if p not in (sheet.wires[index].points[0], sheet.wires[index].points[-1]):
                dots.add(p)
                break
    dots.update(j.at for j in sheet.junctions)
    return dots


def _fmt(v: float) -> str:
    return f"{v:.1f}".rstrip("0").rstrip(".")


def _graphic(g: object, color: str) -> str:
    stroke = f'stroke="{color}" stroke-width="{LINE}" {ROUND}'
    if isinstance(g, Polyline):
        pts = " ".join(f"{x},{y}" for x, y in g.points)
        if g.fill:
            return f'<polygon points="{pts}" fill="{color}"/>'
        return f'<polyline points="{pts}" fill="none" {stroke}/>'
    if isinstance(g, Rect):
        x, y = min(g.start[0], g.end[0]), min(g.start[1], g.end[1])
        w, h = abs(g.end[0] - g.start[0]), abs(g.end[1] - g.start[1])
        fill = color if g.fill else "none"
        return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{fill}" {stroke}/>'
    if isinstance(g, Circle):
        fill = color if g.fill else "none"
        cx, cy = g.center
        return f'<circle cx="{cx}" cy="{cy}" r="{g.radius}" fill="{fill}" {stroke}/>'
    if isinstance(g, Arc):
        return f'<path d="{_arc_path(g.start, g.mid, g.end)}" fill="none" {stroke}/>'
    return ""


def _arc_path(s: Point, m: Point, e: Point) -> str:
    """SVG path of the circular arc from ``s`` through ``m`` to ``e``."""
    (ax, ay), (bx, by), (ex, ey) = s, m, e
    d = 2 * (ax * (by - ey) + bx * (ey - ay) + ex * (ay - by))
    if d == 0:  # collinear: straight line
        return f"M{ax},{ay} L{ex},{ey}"
    a2, b2, e2 = ax * ax + ay * ay, bx * bx + by * by, ex * ex + ey * ey
    ux = (a2 * (by - ey) + b2 * (ey - ay) + e2 * (ay - by)) / d
    uy = (a2 * (ex - bx) + b2 * (ax - ex) + e2 * (bx - ax)) / d
    r = ((ax - ux) ** 2 + (ay - uy) ** 2) ** 0.5

    def cross(ox: float, oy: float, px: float, py: float, qx: float, qy: float) -> float:
        return (px - ox) * (qy - oy) - (py - oy) * (qx - ox)

    sweep = 1 if cross(ax, ay, bx, by, ex, ey) > 0 else 0
    # Large arc when the centre lies on the same side of the chord as the mid point.
    large = 1 if cross(ax, ay, ex, ey, bx, by) * cross(ax, ay, ex, ey, ux, uy) > 0 else 0
    return f"M{ax},{ay} A{_fmt(r)},{_fmt(r)} 0 {large} {sweep} {ex},{ey}"


def _text(text: str, at: tuple[float, float], color: str, size: float = TEXT,
          anchor: str = "start", baseline: str = "middle", mono: bool = False,
          rotate: float = 0) -> str:  # fmt: skip
    family = MONO if mono else FONT
    turn = f' transform="rotate({_fmt(rotate)} {_fmt(at[0])} {_fmt(at[1])})"' if rotate else ""
    return (f'<text x="{_fmt(at[0])}" y="{_fmt(at[1])}" fill="{color}" font-size="{size}" '
            f'font-family="{family}" text-anchor="{anchor}" dominant-baseline="{baseline}"{turn}>'
            f"{escape(text)}</text>")  # fmt: skip


def label_map(label: Label) -> tuple[Callable[[float, float], tuple[float, float]], bool, float]:
    """A label drawn in its own frame (pointing right) mapped by its rotation, as the editor
    does: (map, the text grows the other way, text rotation in degrees)."""
    x0, y0 = label.at
    maps = {
        0: lambda x, y: (x0 + x, y0 + y),
        180: lambda x, y: (x0 - x, y0 + y),  # mirrored: the text stays upright
        270: lambda x, y: (x0 + y, y0 - x),
        90: lambda x, y: (x0 + y, y0 + x),
    }
    return (
        maps.get(label.rot, maps[0]),
        label.rot in (90, 180),
        -90.0 if label.rot in (90, 270) else 0.0,
    )


def label_box(label: Label) -> Box:
    move, _flip, _turn = label_map(label)
    w = len(label.text) * 70 + 120
    box = _new_box()
    for x, y in ((-40, -150), (w, -150), (-40, 40), (w, 40)):
        box.grow(*move(x, y))
    return box


def value_text(symbol: Symbol, inst: Instance) -> str:
    params = {**symbol.default_params, **inst.model.params}
    if symbol.power_net is not None:
        return ""
    if symbol.default_model is not None or inst.model.model:
        return inst.model.model or symbol.default_model or ""
    if symbol.spice and symbol.spice.element in ("V", "I"):
        parts = [params["tran"]] if params.get("tran") else []
        if not parts and "dc" in params:
            parts.append(f"DC {params['dc']}")
        if params.get("ac"):
            parts.append(f"AC {params['ac']}")
        return " ".join(parts)
    if symbol.spice and symbol.spice.element == "B":  # current (i) or voltage (v) source
        current = inst.model.params.get("i")
        return f"I={current}" if current else f"V={params.get('v', '')}"
    if symbol.spice and symbol.spice.element == "X" and not symbol.value_param:
        # A block: its parameter overrides; a real part without them: its name (1N4148).
        overrides = " ".join(f"{k}={v}" for k, v in inst.model.params.items() if v.strip())
        return overrides or part_name(symbol)
    return params.get(symbol.value_param, "") if symbol.value_param else ""


def part_name(symbol: Symbol) -> str:
    """A library part's name as its value, unless its drawing already shows it (a titled box)."""
    if symbol.kind is None:
        return ""
    shown = any(getattr(g, "text", None) == symbol.name for g in symbol.graphics)
    return "" if shown else symbol.name


def _instance(inst: Instance, symbol: Symbol, colors: dict[str, str],
              standard: Standard = "iec",
              shown: tuple[str, str] | None = None) -> list[str]:  # fmt: skip
    """``shown``: (name, value) drawn instead of the reference and the netlist's value (a
    readable equivalent circuit)."""
    symbol = symbol.with_look(inst.look, standard, params=inst.model.params)
    color = colors["power"] if symbol.power_net is not None else colors["symbol"]
    scale = -1 if inst.mirror else 1
    parts = []
    for pin in symbol.pins:
        if pin.length <= 0:
            continue
        dx, dy = _DIRS[pin.orientation]
        px, py = pin.at
        parts.append(f'<line x1="{px}" y1="{py}" x2="{px - dx * pin.length}" '
                     f'y2="{py - dy * pin.length}" stroke="{color}" stroke-width="{LINE}" '
                     f'stroke-linecap="round"/>')  # fmt: skip
    parts += [_graphic(g, color) for g in symbol.graphics]
    out = [f'<g transform="translate({inst.at[0]} {inst.at[1]}) rotate({inst.rot}) '
           f'scale({scale} 1)">{"".join(parts)}</g>']  # fmt: skip
    params = {**symbol.default_params, **inst.model.params}
    for g in symbol.graphics:
        if isinstance(g, Text):
            content = g.text.replace("{net}", params.get("net", "")).replace("{ref}", inst.ref)
            out.append(_text(content, transform(g.at, inst), color, g.size, "middle"))

    def place(field: str, local: Point | None) -> tuple[tuple[float, float], str, float] | None:
        """(position, anchor, rotation) of a text: moved by hand or where the symbol puts it."""
        own = inst.texts.get(field)
        if own is not None:
            return (
                (inst.at[0] + own.at[0], inst.at[1] + own.at[1]),
                "start",
                -90.0 if own.rot else 0.0,
            )
        if local is None:
            return None
        world = transform(local, inst.model_copy(update={"at": (0, 0)}))
        return transform(local, inst), "start" if world[0] >= 0 else "end", 0.0

    if (ref := place("ref", symbol.ref_at)) is not None:
        name = inst.ref if shown is None else shown[0]
        out.append(_text(name, ref[0], colors["ref"], anchor=ref[1], rotate=ref[2]))
    value = value_text(symbol, inst) if shown is None else shown[1]
    spot = place("value", symbol.value_at)
    if spot is not None and value:
        out.append(_text(value, spot[0], colors["text"], anchor=spot[1], mono=True, rotate=spot[2]))
    labels = [p.label for p in symbol.parasitics if inst.model.params.get(p.key, "").strip()]
    if (
        spot is not None and labels
    ):  # non-ideal part: "≈ ESR, ESL" under the value, as on the canvas
        (x, y), anchor, turn = spot
        at = (x + TEXT * 1.2, y) if turn else (x, y + TEXT * 1.2)
        out.append(_text(f"≈ {', '.join(labels)}", at, colors["parasitic"], TEXT * 0.8,
                         anchor=anchor, rotate=turn))  # fmt: skip
    return out


def render_sheet(
    sheet: Sheet,
    symbols: dict[str, Symbol],
    theme: str = "light",
    box: Box | None = None,
    pad: float = 3 * 127,
    standard: Standard = "iec",
    texts: dict[str, tuple[str, str]] | None = None,
    fit_texts: bool = False,
) -> str:
    """SVG document of a sheet; ``box`` limits the visible region (world units); ``standard``:
    IEC or ANSI drawings of parts without a look of their own; ``texts``: (name, value) shown
    instead of a part's reference and netlist value, by its ref; ``fit_texts``: the frame takes
    in every text whole (long values), not only the parts and wires."""
    colors = PALETTES.get(theme, PALETTES["light"])
    out: list[str] = []
    wire = colors["wire"]
    for wr in sheet.wires:
        pts = " ".join(f"{x},{y}" for x, y in wr.points)
        out.append(f'<polyline points="{pts}" fill="none" stroke="{wire}" '
                   f'stroke-width="{WIRE}" {ROUND}/>')  # fmt: skip
    for x, y in sorted(junction_dots(sheet, symbols)):
        out.append(f'<circle cx="{x}" cy="{y}" r="{DOT}" fill="{wire}"/>')
    for inst in sheet.instances:
        symbol = symbols.get(inst.symbol)
        if symbol is not None:
            out += _instance(inst, symbol, colors, standard, (texts or {}).get(inst.ref))
    blue = colors["label"]
    for label in sheet.labels:
        move, flip, turn = label_map(label)
        side = "end" if flip else "start"
        if label.kind in ("global", "port"):
            w = len(label.text) * TEXT * 0.62 + 90
            if label.kind == "port":
                outline = [(0, 0), (50, -70), (w, -70), (w + 50, 0), (w, 70), (50, 70)]
            else:
                outline = [(0, 0), (60, -80), (w, -80), (w, 80), (60, 80)]
            corners = " ".join(f"{_fmt(a)},{_fmt(b)}" for a, b in (move(*q) for q in outline))
            out.append(f'<polygon points="{corners}" fill="none" stroke="{blue}" '
                       f'stroke-width="{LINE}"/>')  # fmt: skip
            at = move(70 if label.kind == "port" else 80, 0)
            out.append(_text(label.text, at, blue, anchor=side, mono=True, rotate=turn))
        else:
            x, y = label.at
            out.append(f'<rect x="{x - 20}" y="{y - 20}" width="40" height="40" fill="{blue}"/>')
            out.append(_text(label.text, move(25, -40), blue, anchor=side, baseline="auto",
                             mono=True, rotate=turn))  # fmt: skip
    for d in sheet.directives:
        for i, line in enumerate(d.text.splitlines()):
            at = (d.at[0], d.at[1] + i * TEXT * 1.3)
            out.append(_text(line, at, colors["directive"], mono=True))
    bounds = box or sheet_bounds(sheet, symbols) or Box(-635, -635, 635, 635)
    if fit_texts and box is None:
        for found in _TEXT.finditer("\n".join(out)):
            text = _text_box(found)
            bounds.grow(text.min_x, text.min_y)
            bounds.grow(text.max_x, text.max_y)
    x0, y0 = bounds.min_x - pad, bounds.min_y - pad
    w, h = bounds.max_x - bounds.min_x + 2 * pad, bounds.max_y - bounds.min_y + 2 * pad
    view = f"{_fmt(x0)} {_fmt(y0)} {_fmt(w)} {_fmt(h)}"
    head = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view}" '
        f'width="{_fmt(w / 10)}" height="{_fmt(h / 10)}">',
        f'<rect x="{_fmt(x0)}" y="{_fmt(y0)}" width="{_fmt(w)}" height="{_fmt(h)}" '
        f'fill="{colors["background"]}"/>',
    ]
    return "\n".join([*head, *out, "</svg>"])


_TEXT = re.compile(r'<text x="([-\d.]+)" y="([-\d.]+)" [^>]*?font-size="([\d.]+)" '
                   r'font-family="([^"]*)" text-anchor="(\w+)"[^>]*?'
                   r'(?: transform="rotate\(([-\d.]+)[^"]*")?>([^<]*)</text>')  # fmt: skip


def _text_box(found: "re.Match[str]") -> Box:
    """The rough extent of a drawn text (character width from the font, mono or not)."""
    x, y, size = float(found[1]), float(found[2]), float(found[3])
    width = len(unescape(found[7])) * size * (0.62 if "Mono" in found[4] else 0.56)
    start = {"start": 0.0, "middle": -width / 2, "end": -width}[found[5]]
    box = _new_box()
    if found[6]:  # turned to read bottom to top: the width runs up the page
        box.grow(x - size / 2, y - start - width)
        box.grow(x + size / 2, y - start)
    else:
        box.grow(x + start, y - size / 2)
        box.grow(x + start + width, y + size / 2)
    return box
