"""Import of KiCad schematics (``.kicad_sch``, KiCad 6 or newer) as a BiasPoint project.

Brought over: every sheet of the hierarchy (a sub-sheet becomes a sheet placed as a block whose
drawn symbol has the KiCad sheet's size and pins), wires, buses, junctions, local / global /
hierarchical labels, power symbols, parts with the library symbols embedded in the file (all
units), values and simulation fields (``Sim.*`` of KiCad 7+, ``Spice_*`` of KiCad 5-6) and text
lines starting with a dot (``.tran``... become the analysis, the rest directives).
Not brought over: no-connect flags, drawings and notes, fields other than value and simulation.

Coordinates: KiCad schematics are in mm with y down, like ours (0.01 mm units). A placed
symbol's pin lands at ``at + M · R(angle) · pin`` (rotation counter-clockwise, then the mirror);
written from the file format and checked on real schematics (pins land on wire ends).
"""

import re
from dataclasses import dataclass, field
from pathlib import Path

from bpt.document.model import (
    Directive,
    Instance,
    Junction,
    Label,
    LabelKind,
    ModelRef,
    Point,
    Project,
    Sheet,
    Wire,
)
from bpt.library.blocks import PREFIX as BLOCK

from .kicad import _GROUND, _plain, _properties, _spice, convert_all
from .sexpr import SExpr, child, children, head, parse, value
from .symbols import Graphic, Pin, Rect, SpiceMapping, Symbol, Text

_ANALYSES = ("op", "dc", "ac", "tran")
_SAFE_SHEET = re.compile(r"[^\w .-]+")


@dataclass
class SchematicImport:
    project: Project
    skipped: list[str] = field(default_factory=list)  # "what: why", for the report


def _num(text: SExpr) -> float:
    try:
        return float(str(text))
    except ValueError:
        return 0.0


def _at(expr: SExpr) -> tuple[Point, int]:
    """(point, angle) of an ``(at x y [angle])`` child: mm -> 0.01 mm, y down as in KiCad."""
    at = child(expr, "at") or []
    point = (round(_num(at[1]) * 100), round(_num(at[2]) * 100)) if len(at) >= 3 else (0, 0)
    return point, (round(_num(at[3])) % 360 if len(at) >= 4 else 0)


def _points(expr: SExpr) -> list[Point]:
    pts = child(expr, "pts") or []
    return [(round(_num(xy[1]) * 100), round(_num(xy[2]) * 100))
            for xy in children(pts, "xy") if len(xy) >= 3]  # fmt: skip


def placement(angle: int, mirror: str) -> tuple[int, bool]:
    """KiCad (angle counter-clockwise, mirror "x" / "y" / "") -> our (rot clockwise, mirror).

    Ours mirrors x first and then turns clockwise; KiCad turns, then mirrors. Mirroring across
    the y axis then turning back is the same as mirroring first; mirroring across the x axis
    is that plus half a turn.
    """
    if mirror == "y":
        return angle % 360, True
    if mirror == "x":
        return (angle + 180) % 360, True
    return (360 - angle) % 360, False


class _Reader:
    def __init__(self, root_path: Path) -> None:
        self.root_path = root_path
        self.library = root_path.stem
        self.project = Project(name=root_path.stem)
        self.symbols: dict[str, Symbol] = {}  # lib_id (+ ":unit") -> converted symbol
        self.lib_props: dict[str, dict[str, str]] = {}
        self.sheets: dict[Path, str] = {}  # file -> sheet name (shared by all its instances)
        self.skipped: list[str] = []
        self.refs: set[str] = set()
        self.variants: dict[tuple[str, str, str | None], Symbol] = {}

    # -- library symbols embedded in each file --------------------------------------------
    def _library(self, root: SExpr) -> None:
        raw: dict[str, SExpr] = {}
        keys: dict[str, str] = {}
        for expr in children(child(root, "lib_symbols") or [], "symbol"):
            lib_id = str(expr[1])
            if lib_id in self.lib_props:
                continue
            short = lib_id.split(":")[-1]
            key = short if short not in keys.values() else lib_id.replace(":", "_")
            keys[lib_id] = key
            # Units inside are named after the short name ("R_0_1"): match them that way.
            raw[key] = [expr[0], short, *expr[2:]]
            self.lib_props[lib_id] = {k: v for k, (v, _e) in _properties(expr).items()}
        result = convert_all(raw, self.library)
        by_id = {s.id: s for s in result.symbols}
        self.skipped += [f"symbol {n}: {why}" for n, why in result.skipped]
        for lib_id, key in keys.items():
            for symbol_id, symbol in by_id.items():
                base = f"kicad:{self.library}/{key}"
                if symbol_id == base:
                    self.symbols[lib_id] = symbol
                elif symbol_id.startswith(f"{base}:"):
                    self.symbols[f"{lib_id}:{symbol_id[len(base) + 1 :]}"] = symbol

    # -- one sheet -------------------------------------------------------------------------
    def sheet(self, path: Path, name: str, chain: tuple[Path, ...] = ()) -> Sheet:
        root = parse(path.read_text(encoding="utf-8"))
        if head(root) != "kicad_sch":
            raise ValueError(f"{path.name} is not a KiCad schematic (kicad_sch)")
        self._library(root)
        sheet = Sheet(name=name)
        self.sheets[path.resolve()] = name
        self.project.sheets.append(sheet)
        for expr in children(root, "wire"):
            if len(pts := _points(expr)) >= 2:
                sheet.wires.append(Wire(points=pts))
        for expr in children(root, "bus"):
            if len(pts := _points(expr)) >= 2:
                sheet.wires.append(Wire(points=pts, bus=True))
        for expr in children(root, "junction"):
            sheet.junctions.append(Junction(at=_at(expr)[0]))
        kinds: dict[str, LabelKind] = {
            "label": "local", "global_label": "global", "hierarchical_label": "port",
        }  # fmt: skip
        for tag, kind in kinds.items():
            for expr in children(root, tag):
                at, angle = _at(expr)
                text = _plain(str(expr[1])) if len(expr) > 1 else ""
                if kind == "global" and _GROUND.match(text):
                    text = "0"  # like KiCad's simulator: a GND net is the 0 V reference
                if text:
                    rot = (360 - angle) % 360
                    sheet.labels.append(Label(kind=kind, text=text, at=at, rot=rot))  # type: ignore[arg-type]
        for expr in children(root, "symbol"):
            self._part(sheet, expr)
        for expr in children(root, "text"):
            self._text(sheet, expr)
        for expr in children(root, "sheet"):
            self._subsheet(sheet, expr, path, (*chain, path.resolve()))
        if children(root, "no_connect"):
            self.skipped.append(f"{name}: {len(children(root, 'no_connect'))} no-connect flags")
        return sheet

    def _part(self, sheet: Sheet, expr: SExpr) -> None:
        # A part edited in the schematic points to its own copy in the file ("BCV61_1").
        lib_id = value(expr, "lib_name") or value(expr, "lib_id")
        unit = int(_num(value(expr, "unit", 1, "1")) or 1)
        letter = chr(ord("A") + unit - 1) if unit <= 26 else str(unit)
        symbol = self.symbols.get(lib_id if unit == 1 else f"{lib_id}:{letter}")
        props = {k: v for k, (v, _e) in _properties(expr).items()}
        ref = props.get("Reference", "?")
        if symbol is None:
            self.skipped.append(f"{ref}: no symbol {lib_id} in the file")
            return
        if lib_id.endswith(":PWR_FLAG") or props.get("Value") == "PWR_FLAG":
            return  # only tells KiCad's ERC that a net is driven
        at, angle = _at(expr)
        rot, mirror = placement(angle, value(expr, "mirror"))
        params: dict[str, str] = {}
        model: str | None = None
        if symbol.power_net is not None:
            net = props.get("Value", symbol.power_net)
            params["net"] = "0" if _GROUND.match(net) else net
            ref = "#PWR?"
        else:
            # The part's own fields override the library's (value, Sim.*, Spice_*).
            merged = {**self.lib_props.get(lib_id, {}), **props}
            sim = _spice(symbol.name, symbol.ref_prefix, merged, symbol.pins)
            if sim is not None:
                mapping, defaults, model_name, _value = sim
                if mapping != symbol.spice:  # simulated another way than its library symbol
                    symbol = self._variant(symbol, mapping, model_name)
                params = {k: v for k, v in defaults.items() if symbol.default_params.get(k) != v}
                model = model_name if model_name != symbol.default_model else None
        sid = symbol.id
        self.project.symbols[sid] = symbol
        part = Instance.model_validate({
            "ref": self._ref(ref, symbol), "symbol": sid, "at": at, "rot": rot, "mirror": mirror,
            "model": ModelRef(model=model, params=params),
        })  # fmt: skip
        sheet.instances.append(part)

    def _variant(self, symbol: Symbol, mapping: SpiceMapping, model: str | None) -> Symbol:
        """The symbol simulated as the part's own fields say (one copy per distinct mapping)."""
        key = (symbol.id, mapping.model_dump_json(), model)
        if key not in self.variants:
            n = sum(1 for k in self.variants if k[0] == symbol.id) + 1
            self.variants[key] = symbol.model_copy(update={
                "id": f"{symbol.id}~{n}", "spice": mapping, "default_model": model,
                "description": symbol.description.replace(" (not simulated: no SPICE model)", ""),
            })  # fmt: skip
        return self.variants[key]

    def _ref(self, ref: str, symbol: Symbol) -> str:
        """Unique references; unannotated "R?" get the next free number."""
        if ref.endswith("?") or ref.lower() in self.refs:
            prefix = re.sub(r"[\d?]+$", "", ref) or symbol.ref_prefix
            n = 1
            while f"{prefix}{n}".lower() in self.refs:
                n += 1
            ref = f"{prefix}{n}"
        self.refs.add(ref.lower())
        return ref

    def _text(self, sheet: Sheet, expr: SExpr) -> None:
        text = str(expr[1]) if len(expr) > 1 else ""
        lines, kept, control = text.replace("\\n", "\n").splitlines(), [], False
        for raw in lines:
            line = raw.strip()
            low = line.lower()
            if low.startswith(".control"):
                control = True
            if control:
                control = not low.startswith(".endc")
                continue
            if not line.startswith("."):
                continue
            kind = low[1:].split()[0] if len(low) > 1 else ""
            if kind in _ANALYSES:
                cards = self.project.simulation.cards
                if all(cards.get(k) == v for k, v in type(self.project.simulation)().cards.items()):
                    self.project.simulation.active = kind  # type: ignore[assignment]
                cards[kind] = line
            elif kind != "end":
                kept.append(line)
        if any(raw.strip().lower().startswith(".control") for raw in lines):
            self.skipped.append(f"{sheet.name}: .control block (ngspice scripts are not run)")
        if kept:
            sheet.directives.append(Directive(text="\n".join(kept), at=_at(expr)[0]))

    def _subsheet(self, sheet: Sheet, expr: SExpr, here: Path, chain: tuple[Path, ...]) -> None:
        props = {k: v for k, (v, _e) in _properties(expr).items()}
        title = props.get("Sheetname") or props.get("Sheet name") or "sheet"
        file = props.get("Sheetfile") or props.get("Sheet file") or ""
        path = (here.parent / file).resolve()
        if path in chain:
            self.skipped.append(f"sheet {title}: contains itself")
            return
        if not path.is_file():
            self.skipped.append(f"sheet {title}: file {file} not found")
            return
        name = self.sheets.get(path)
        if name is None:
            name = self._sheet_name(title)
            self.sheet(path, name, chain)
        target = self.project.sheet(name)
        at, _angle = _at(expr)
        size = child(expr, "size") or []
        w, h = (
            (round(_num(size[1]) * 100), round(_num(size[2]) * 100)) if len(size) >= 3 else (0, 0)
        )
        if target.symbol is None:  # the block looks like the KiCad sheet (first instance)
            target.symbol = self._block_symbol(name, expr, at, w, h)
        ref = self._ref("X?", target.symbol)
        sheet.instances.append(Instance(ref=ref, symbol=f"{BLOCK}{name}", at=at))

    def _sheet_name(self, title: str) -> str:
        base = _SAFE_SHEET.sub("_", title).strip()[:40] or "sheet"
        name, n = base, 2
        while any(s.name.lower() == name.lower() for s in self.project.sheets):
            name, n = f"{base}_{n}", n + 1
        return name

    def _block_symbol(self, name: str, expr: SExpr, at: Point, w: int, h: int) -> Symbol:
        pins: list[Pin] = []
        graphics: list[Graphic] = [Rect(start=(0, 0), end=(w, h)),
                          Text(at=(w // 2, -90), text=name, size=110)]  # fmt: skip
        for pin_expr in children(expr, "pin"):
            port = _plain(str(pin_expr[1])) if len(pin_expr) > 1 else ""
            (px, py), _ = _at(pin_expr)
            x, y = px - at[0], py - at[1]
            side = min((x, "left"), (w - x, "right"), (y, "up"), (h - y, "down"))[1]
            pins.append(Pin(number=port, name=port, at=(x, y), length=0, orientation=side))  # type: ignore[arg-type]
            inward = {"left": (60, 0), "right": (-60, 0), "up": (0, 90), "down": (0, -90)}[side]
            anchor = "start" if side == "left" else "end" if side == "right" else "middle"
            shift = {"start": len(port) * 31, "end": -len(port) * 31, "middle": 0}[anchor]
            graphics.append(Text(at=(x + inward[0] + shift, y + inward[1]), text=port, size=100))
        return Symbol(id=f"{BLOCK}{name}", name=name, ref_prefix="X", pins=pins, graphics=graphics,
                      ref_at=(0, -250), value_at=None, category="Sheets")  # fmt: skip


def import_schematic(path: Path) -> SchematicImport:
    """A project from ``path`` (the root sheet) and the sheets it uses."""
    reader = _Reader(path)
    reader.sheet(path, "root")
    return SchematicImport(project=reader.project, skipped=reader.skipped)
