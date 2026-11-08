"""Symbols of hierarchical sheets: a sheet with port labels can be placed as a block.

The block is a box with one pin per port label. Ports on the left half of the sheet become
pins on the left side, the others on the right; each side is ordered top to bottom, so the
block looks like the sheet. The symbol id is ``sheet:<name>``; the netlister turns the sheet
into a ``.subckt`` and the block into an ``X`` element.
"""

import math

from bpt.document.model import Component, Project, Sheet
from bpt.library.builtin import builtin_symbols
from bpt.netlist.connectivity import bus_members

from .symbols import Graphic, Pin, Rect, SpiceMapping, Symbol, Text, Variant, with_extra_looks

G = 127  # grid
PREFIX = "sheet:"


SIDES = ("left", "right", "top", "bottom")


def ports(sheet: Sheet) -> list[tuple[str, str]]:
    """(port name, side) in pin order: left side, right, top, bottom.

    The side and order chosen for the block (``Sheet.port_sides`` / ``port_order``) win;
    otherwise ports on the left half of the sheet go left, the others right, top to bottom.
    """
    found = [label for label in sheet.labels if label.kind == "port"]
    if not found:
        return []
    middle = (min(lb.at[0] for lb in found) + max(lb.at[0] for lb in found)) / 2
    first: dict[str, tuple[str, tuple[int, int]]] = {}  # name -> (automatic side, position)
    for label in sorted(found, key=lambda lb: (lb.at[1], lb.at[0])):
        side = "left" if label.at[0] <= middle else "right"
        # A bus port (D[0..3]) is one pin per member; members follow each other.
        for k, name in enumerate(bus_members(label.text) or [label.text]):
            if name not in first:  # one pin per port name
                first[name] = (side, (label.at[1], label.at[0] * 1000 + k))
    rank = {name: i for i, name in enumerate(sheet.port_order)}
    out: list[tuple[str, str]] = []
    for side in SIDES:
        names = [n for n, (auto, _at) in first.items() if sheet.port_sides.get(n, auto) == side]
        names.sort(key=lambda n: (rank.get(n, len(rank)), first[n][1]))
        out += [(name, side) for name in names]
    return out


def drawn_symbol_problems(sheet: Sheet) -> tuple[list[str], list[str]]:
    """(ports without a pin, pins that are not ports) of the sheet's drawn block symbol."""
    if sheet.symbol is None:
        return [], []
    names = [name for name, _side in ports(sheet)]
    numbers = [pin.number for pin in sheet.symbol.pins]
    return [n for n in names if n not in numbers], [n for n in numbers if n not in names]


from bpt.library.categories import component_category  # noqa: E402

REF_PREFIX = {"resistor": "R", "capacitor": "C", "inductor": "L", "transformer": "T", "diode": "D",
              "transistor": "Q", "ic": "U", "module": "U"}  # fmt: skip


_VALUED = ("resistor", "capacitor", "inductor")


def block_symbol(sheet: Sheet) -> Symbol | None:
    info = sheet.component
    symbol = _block_symbol(sheet, info.name if info is not None else sheet.name)
    if symbol is not None and sheet.variants and symbol.spice is not None:
        # Other models of the block, offered as "Simulate as" (the netlister swaps the sheet).
        own = Variant(name="full", label=sheet.variant_label or "Full model", spice=symbol.spice)
        others = [Variant(name=v.name, label=v.label, description=v.description,
                          faster=v.faster, spice=symbol.spice) for v in sheet.variants]  # fmt: skip
        symbol = symbol.model_copy(update={"variants": [own, *others]})
    if symbol is None or info is None:
        return symbol
    # A real part: named like one (C1, U2) and described by its component.
    group = component_category(info.category, info.template.name if info.template else None,
                               info.kind)  # fmt: skip
    update: dict[str, object] = {
        "name": info.name, "ref_prefix": REF_PREFIX.get(info.kind, "X"), "category": "Components",
        "description": info.description or f"{info.name} ({info.kind})", "kind": info.kind,
        "group": group, "metadata": dict(info.metadata), "ratings": dict(info.ratings),
    }  # fmt: skip
    if info.template is not None and sheet.parameters and info.kind in _VALUED:
        # Made from a template: its main value (C, L, R) is the part's value, set per part.
        # (A diode's first field is IS: its name tells more than that.)
        main = next(iter(sheet.parameters))
        update |= {"value_param": main, "default_params": {main: sheet.parameters[main]}}
    return symbol.model_copy(update=update)


def component_symbol(component: Component) -> Symbol | None:
    """The library entry of a component: its top sheet's block, under the component id."""
    top = component.sheets[0].model_copy(update={"component": component})
    symbol = block_symbol(top)
    if symbol is None:
        return None
    category = component.id.removeprefix("cmp:").split("/")[0]
    return symbol.model_copy(update={"id": component.id, "category": category})


def _block_symbol(sheet: Sheet, title: str) -> Symbol | None:
    pins_spec = ports(sheet)
    if not pins_spec:
        return None
    names = [name for name, _side in pins_spec]
    missing, _extra = drawn_symbol_problems(sheet)
    if sheet.symbol is not None and not missing:
        return sheet.symbol.model_copy(update={
            "id": f"{PREFIX}{sheet.name}", "ref_prefix": "X", "category": "Sheets",
            "description": sheet.symbol.description or f"Sheet {sheet.name} as a block",
            "pins": [pin for pin in sheet.symbol.pins if pin.number in names],
            "spice": SpiceMapping(element="X", nodes=names), "power_net": None,
            "default_params": {}, "default_model": None, "value_param": None,
            "parasitics": [], "variants": [],
        })  # fmt: skip
    by_side = {side: [name for name, s in pins_spec if s == side] for side in SIDES}
    symbol = box_symbol(f"{PREFIX}{sheet.name}", title, by_side["left"], by_side["right"],
                        top=by_side["top"], bottom=by_side["bottom"], ref_prefix="X",
                        description=f"Sheet {sheet.name} as a block ({len(pins_spec)} ports)",
                        category="Sheets")  # fmt: skip
    nodes = [p.number for p in symbol.pins]
    return symbol.model_copy(update={"spice": SpiceMapping(element="X", nodes=nodes)})


def box_symbol(
    symbol_id: str,
    title: str,
    left: list[str],
    right: list[str],
    *,
    top: list[str] | None = None,
    bottom: list[str] | None = None,
    ref_prefix: str,
    description: str = "",
    category: str = "Misc",
) -> Symbol:
    """A box with named pins on its sides (sheet blocks, generic subcircuits)."""
    top, bottom = top or [], bottom or []
    rows = max(len(left), len(right), 1)
    cols = max(len(top), len(bottom))
    chars = max([len(n) for n in left] or [0]) + max([len(n) for n in right] or [0])
    half_w = G * max(4, math.ceil((chars * 0.62 * G + 4 * G) / (2 * G)), cols + 1)
    extra = G if cols else 0  # room for the names of top / bottom pins
    y0 = -(rows - 1) * G  # side pins every 2 grid steps, centred on the origin
    y1 = y0 + 2 * G * (rows - 1)
    box_top, box_bottom = y0 - G - extra, y1 + G + extra
    pins: list[Pin] = []
    graphics: list[Graphic] = [
        Rect(start=(-half_w, box_top), end=(half_w, box_bottom)),
        Text(at=(0, box_top - 90 - (2 * G if top else 0)), text=title, size=110),
    ]
    for i, name in enumerate(left):
        y = y0 + i * 2 * G
        pins.append(
            Pin(number=name, name=name, at=(-half_w - 2 * G, y), length=2 * G, orientation="left")
        )
        graphics.append(
            Text(at=(-half_w + G // 2 + int(len(name) * 0.31 * 100), y), text=name, size=100)
        )
    for i, name in enumerate(right):
        y = y0 + i * 2 * G
        pins.append(
            Pin(number=name, name=name, at=(half_w + 2 * G, y), length=2 * G, orientation="right")
        )
        graphics.append(
            Text(at=(half_w - G // 2 - int(len(name) * 0.31 * 100), y), text=name, size=100)
        )
    for names, y_pin, y_text, orientation in (
        (top, box_top - 2 * G, box_top + 70, "up"),
        (bottom, box_bottom + 2 * G, box_bottom - 70, "down"),
    ):
        x0 = -(len(names) - 1) * G
        for i, name in enumerate(names):
            x = x0 + i * 2 * G
            pins.append(Pin(number=name, name=name, at=(x, y_pin), length=2 * G,
                            orientation=orientation))  # type: ignore[arg-type]  # fmt: skip
            graphics.append(Text(at=(x, y_text), text=name, size=90))
    return Symbol(
        id=symbol_id,
        name=title,
        description=description,
        category=category,
        ref_prefix=ref_prefix,
        pins=pins,
        graphics=graphics,
        ref_at=(half_w + G, box_top - 90),
        # Below the box; beside the bottom pins when there are some (their wires go down).
        value_at=(half_w + G, box_bottom + 90) if bottom else (0, box_bottom + 90),
    )


def block_symbols(project: Project) -> dict[str, Symbol]:
    out: dict[str, Symbol] = {}
    for sheet in project.sheets:
        symbol = block_symbol(sheet)
        if symbol is not None:
            out[symbol.id] = symbol
    return out


def project_symbols(project: Project) -> dict[str, Symbol]:
    """Built-in symbols, the project's copies of library symbols and its sheet blocks."""
    symbols = {**builtin_symbols(), **project.symbols, **block_symbols(project)}
    for sid, looks in project.looks.items():  # user drawings the project keeps
        if sid in symbols:
            symbols[sid] = with_extra_looks(symbols[sid], looks)
    return symbols
