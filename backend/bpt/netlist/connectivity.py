"""Net resolution: which pins are connected, and what each net is called.

Connection rules (KiCad-like):

* items whose connection points coincide are connected (pin-pin, pin-wire end, label, ...);
* a wire end, pin or label touching the *interior* of a wire connects to it (T-junction);
* wires crossing each other connect only where a junction is placed;
* local labels join nets with the same text on one sheet, global labels and power symbols
  across all sheets.

Net names: ground (``0``) > power symbols / global labels > local labels > automatic ``N001``.
Rotation turns the symbol clockwise on screen (y axis points down).
"""

import re
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass, field
from itertools import pairwise
from uuid import UUID

from bpt.document.model import Instance, Point, Project, Sheet
from bpt.library.symbols import Symbol

PinKey = tuple[UUID, str]  # (instance id, pin number)


_RANGE = re.compile(r"^(.*?)\[(\d+)\.\.(\d+)\]$")
_GROUP = re.compile(r"^\w*\{([^{}]+)\}$")


def bus_members(text: str) -> list[str]:
    """Nets of a bus name: ``D[0..3]`` -> D0..D3, ``{SDA SCL}`` -> SDA, SCL; [] for a net."""
    if match := _RANGE.match(text.strip()):
        name, a, b = match.group(1), int(match.group(2)), int(match.group(3))
        step = 1 if b >= a else -1
        return [f"{name}{i}" for i in range(a, b + step, step)][:256]
    if match := _GROUP.match(text.strip()):
        return match.group(1).split()
    return []


def transform(point: Point, instance: Instance) -> Point:
    """Symbol-relative point -> sheet coordinates (mirror around Y, then rotate)."""
    x, y = point
    if instance.mirror:
        x = -x
    for _ in range(instance.rot // 90):
        x, y = -y, x
    return x + instance.at[0], y + instance.at[1]


def segment_index(wires: list[list[Point]]) -> Callable[[Point], set[int]]:
    """``through(point)``: indexes of the wires with a segment through (or ending at) it.

    Horizontal and vertical segments are indexed by their line and, along it, by buckets of
    ``_BUCKET`` units, so lookups stay fast on big sheets (rows of many short wires); slanted
    ones are checked one by one.
    """
    horizontal: dict[tuple[float, int], list[tuple[float, float, int]]] = defaultdict(list)
    vertical: dict[tuple[float, int], list[tuple[float, float, int]]] = defaultdict(list)
    slanted: list[tuple[Point, Point, int]] = []
    for index, wire_points in enumerate(wires):
        for (ax, ay), (bx, by) in pairwise(wire_points):
            if ay == by:
                lo, hi = min(ax, bx), max(ax, bx)
                for k in range(int(lo // _BUCKET), int(hi // _BUCKET) + 1):
                    horizontal[(ay, k)].append((lo, hi, index))
            elif ax == bx:
                lo, hi = min(ay, by), max(ay, by)
                for k in range(int(lo // _BUCKET), int(hi // _BUCKET) + 1):
                    vertical[(ax, k)].append((lo, hi, index))
            else:
                slanted.append(((ax, ay), (bx, by), index))

    def through(point: Point) -> set[int]:
        px, py = point
        row = horizontal.get((py, int(px // _BUCKET)), ())
        column = vertical.get((px, int(py // _BUCKET)), ())
        hits = {i for lo, hi, i in row if lo <= px <= hi}
        hits |= {i for lo, hi, i in column if lo <= py <= hi}
        if slanted:
            hits |= {i for a, b, i in slanted if _on_segment(point, a, b)}
        return hits

    return through


_BUCKET = 2048  # world units (16 grid steps)


def _on_segment(p: Point, a: Point, b: Point) -> bool:
    (px, py), (ax, ay), (bx, by) = p, a, b
    if (bx - ax) * (py - ay) != (by - ay) * (px - ax):
        return False
    return min(ax, bx) <= px <= max(ax, bx) and min(ay, by) <= py <= max(ay, by)


class _UnionFind:
    def __init__(self) -> None:
        self.parent: dict[object, object] = {}

    def find(self, item: object) -> object:
        self.parent.setdefault(item, item)
        while self.parent[item] != item:
            self.parent[item] = self.parent[self.parent[item]]
            item = self.parent[item]
        return item

    def union(self, a: object, b: object) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[rb] = ra


@dataclass
class Nets:
    pin_net: dict[PinKey, str] = field(default_factory=dict)
    members: dict[str, list[PinKey]] = field(default_factory=dict)
    item_net: dict[UUID, str] = field(default_factory=dict)  # wires and labels -> net
    name_conflicts: list[tuple[str, list[str]]] = field(default_factory=list)


_PRIORITY = {
    "ground": 0,
    "global": 1,
    "local": 2,
    "port": 2,
}  # a port names a net like a local label


def resolve_nets(project: Project, symbols: dict[str, Symbol]) -> Nets:
    uf = _UnionFind()
    names: dict[object, set[tuple[int, str]]] = defaultdict(set)  # item -> {(priority, name)}
    pins: list[tuple[PinKey, tuple[int, str, str]]] = []  # key, sort key for auto names
    multi_sheet = len(project.sheets) > 1

    for sheet_index, sheet in enumerate(project.sheets):
        _connect_sheet(sheet, sheet_index, symbols, uf, names, pins, multi_sheet)

    # Join items that carry the same name (labels, power symbols) across the project.
    by_name: dict[str, object] = {}
    for item, item_names in names.items():
        for _priority, name in item_names:
            if name in by_name:
                uf.union(by_name[name], item)
            else:
                by_name[name] = item

    root_names: dict[object, set[tuple[int, str]]] = defaultdict(set)
    for item, item_names in names.items():
        root_names[uf.find(item)] |= item_names

    nets = Nets()
    auto: dict[object, str] = {}
    reported: set[object] = set()
    root_net: dict[object, str] = {}
    for key, _sort in sorted(pins, key=lambda entry: entry[1]):
        root = uf.find(("pin", key))
        candidates = sorted(root_names.get(root, set()))
        if candidates:
            name = candidates[0][1]
            if len(candidates) > 1 and root not in reported:
                nets.name_conflicts.append((name, [n for _p, n in candidates]))
                reported.add(root)
        else:
            name = auto.setdefault(root, f"N{len(auto) + 1:03d}")
        nets.pin_net[key] = name
        nets.members.setdefault(name, []).append(key)
        root_net[root] = name
    for item in list(uf.parent):
        if isinstance(item, tuple) and item[0] in ("wire", "label"):
            root = uf.find(item)
            name_of = (
                root_net.get(root) or next(iter(sorted(root_names.get(root, set()))), (0, ""))[1]
            )
            if name_of:
                nets.item_net[item[1]] = name_of
    return nets


def _connect_sheet(
    sheet: Sheet,
    sheet_index: int,
    symbols: dict[str, Symbol],
    uf: _UnionFind,
    names: dict[object, set[tuple[int, str]]],
    pins: list[tuple[PinKey, tuple[int, str, str]]],
    multi_sheet: bool,
) -> None:
    points: list[tuple[Point, object]] = []  # connection points of non-wire items + wire ends
    # Buses and bus labels are drawings: members connect through their own net labels.
    wires = [(("wire", wire.id), wire.points) for wire in sheet.wires if not wire.bus]

    for instance in sheet.instances:
        symbol = symbols.get(instance.symbol)
        if symbol is None:
            continue
        for pin in symbol.pins:
            key: PinKey = (instance.id, pin.number)
            item: object = ("pin", key)
            uf.find(item)
            points.append((transform(pin.at, instance), item))
            pins.append((key, (sheet_index, instance.ref, pin.number)))
            if pin.implicit_net:  # hidden power pin (KiCad): global net of its name
                ground = pin.implicit_net == "0"
                names[item].add((_PRIORITY["ground" if ground else "global"], pin.implicit_net))
            if symbol.power_net is not None:
                net = instance.model.params.get("net", symbol.power_net)
                names[item].add((_PRIORITY["ground" if net == "0" else "global"], net))

    for label in sheet.labels:
        if bus_members(label.text):
            continue
        label_item: object = ("label", label.id)
        uf.find(label_item)
        points.append((label.at, label_item))
        if label.kind == "global" or not multi_sheet:
            text = label.text
        else:
            text = f"{sheet.name}/{label.text}"
        priority = _PRIORITY["ground"] if text == "0" else _PRIORITY[label.kind]
        names[label_item].add((priority, text))

    for wire_item, wire_points in wires:
        uf.find(wire_item)
        points.append((wire_points[0], wire_item))
        points.append((wire_points[-1], wire_item))

    # Coincident points.
    at_point: dict[Point, object] = {}
    for point, point_item in points:
        if point in at_point:
            uf.union(at_point[point], point_item)
        else:
            at_point[point] = point_item

    # Points touching a wire (ends on interiors = T-junctions) and explicit junctions.
    through = segment_index([wire_points for _item, wire_points in wires])
    touch_points = list(at_point) + [junction.at for junction in sheet.junctions]
    for point in touch_points:
        for index in sorted(through(point)):
            wire_item = wires[index][0]
            if point in at_point:
                uf.union(at_point[point], wire_item)
            else:  # junction on crossing wires: join every wire through it
                at_point[point] = wire_item
