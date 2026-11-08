"""Turn a selection into a hierarchical block: its own sheet with ports, a block in its place.

Nets joining the selection to the rest of the sheet become ports. Each port label sits where
the inside met the outside, so both sides stay connected at the same point:

* inside, the new sheet keeps the selected objects where they were, plus the port labels;
* outside, the selection is replaced by the block, and its pins carry labels of the nets
  they belong to (a net without a name gets one, written also where the selection was).

Ground and global nets (power symbols, global labels) are not ports: inside they get a ground
symbol or a global label, which joins them anyway. Everything is one transaction (one undo).
"""

import re
from collections import defaultdict
from dataclasses import dataclass
from itertools import pairwise
from uuid import UUID

from bpt.document.commands import AddObjects, AddSheet, AnyCommand, RemoveObjects, Transaction
from bpt.document.model import Instance, Label, Point, Project, Sheet
from bpt.library.blocks import PREFIX, block_symbol
from bpt.library.symbols import Symbol
from bpt.netlist.connectivity import resolve_nets, transform

G = 127
_AUTO_NET = re.compile(r"^N\d{3,}$")
_SHEET_NAME = re.compile(r"^[\w -]{1,40}$")


class ExtractError(ValueError):
    pass


@dataclass
class Extracted:
    command: Transaction
    ref: str  # the new block, e.g. "X1"
    ports: list[str]


def _on_segment(p: Point, a: Point, b: Point) -> bool:
    (px, py), (ax, ay), (bx, by) = p, a, b
    if (bx - ax) * (py - ay) != (by - ay) * (px - ax):
        return False
    return min(ax, bx) <= px <= max(ax, bx) and min(ay, by) <= py <= max(ay, by)


def _next(used: set[str], prefix: str) -> str:
    numbers = {
        int(m.group(1)) for r in used if (m := re.fullmatch(rf"{re.escape(prefix)}(\d+)", r))
    }
    return f"{prefix}{max(numbers, default=0) + 1}"


def _hanging(sheet: Sheet, ids: set[UUID], symbols: dict[str, Symbol]) -> set[UUID]:
    """Wire stubs hanging only on selected pins, with their labels and power symbols.

    They belong to the selected parts (netlist import and agents draw each pin as a stub with a
    label), so they go with them: leaving them would make a port of every labelled stub.
    """
    selected_pins: set[Point] = set()
    other_pins: set[Point] = set()
    power_at: dict[Point, list[UUID]] = defaultdict(list)
    for inst in sheet.instances:
        symbol = symbols.get(inst.symbol)
        if symbol is None:
            continue
        for pin in symbol.pins:
            at = transform(pin.at, inst)
            if inst.id in ids:
                selected_pins.add(at)
            elif symbol.power_net is not None:
                power_at[at].append(inst.id)
            else:
                other_pins.add(at)
    ends: dict[Point, int] = defaultdict(int)  # wire ends and corners at each point
    for wire in sheet.wires:
        for point in wire.points:
            ends[point] += 1
    found: set[UUID] = set()
    for wire in sheet.wires:
        if wire.id in ids or len(wire.points) != 2:
            continue
        a, b = wire.points
        for near, far in ((a, b), (b, a)):
            # One end on a selected pin, the other free (or a label / power symbol only).
            free = far not in other_pins and far not in selected_pins
            if near in selected_pins and free and ends[near] == 1 and ends[far] == 1:
                found.add(wire.id)
                found |= {lb.id for lb in sheet.labels if lb.at == far}
                found |= set(power_at.get(far, []))
    return found


def block_from_selection(
    project: Project, sheet_name: str, ids: set[UUID], name: str, symbols: dict[str, Symbol]
) -> Extracted:
    sheet = project.sheet(sheet_name)
    name = name.strip()
    if not _SHEET_NAME.fullmatch(name):
        raise ExtractError("use letters, digits, spaces, _ or - for the sheet name (up to 40)")
    if any(s.name.lower() == name.lower() for s in project.sheets):
        raise ExtractError(f"a sheet named {name!r} already exists")
    parts = [i for i in sheet.instances if i.id in ids]
    if not any(symbols.get(i.symbol) and symbols[i.symbol].spice for i in parts):
        raise ExtractError("select at least one part (not only wires, labels or power symbols)")
    ids = ids | _hanging(sheet, ids, symbols)
    parts = [i for i in sheet.instances if i.id in ids]

    nets = resolve_nets(project.model_copy(update={"sheets": [sheet]}), symbols)
    inside: dict[str, set[Point]] = defaultdict(set)
    outside: dict[str, set[Point]] = defaultdict(set)
    outside_wires: dict[str, list[list[Point]]] = defaultdict(list)
    inside_wires: dict[str, list[list[Point]]] = defaultdict(list)
    global_names = {"0"}
    for inst in sheet.instances:
        symbol = symbols.get(inst.symbol)
        if symbol is None:
            continue
        if symbol.power_net is not None:
            global_names.add(inst.model.params.get("net", symbol.power_net))
        for pin in symbol.pins:
            if net := nets.pin_net.get((inst.id, pin.number)):
                (inside if inst.id in ids else outside)[net].add(transform(pin.at, inst))
    for wire in sheet.wires:
        if net := nets.item_net.get(wire.id):
            (inside if wire.id in ids else outside)[net] |= {wire.points[0], wire.points[-1]}
            (inside_wires if wire.id in ids else outside_wires)[net].append(wire.points)
    for label in sheet.labels:
        if label.kind == "global":
            global_names.add(label.text)
        if net := nets.item_net.get(label.id):
            (inside if label.id in ids else outside)[net].add(label.at)
    named_outside = {
        nets.item_net[lb.id]
        for lb in sheet.labels
        if lb.id not in ids and lb.id in nets.item_net and nets.item_net[lb.id] == lb.text
    }

    def _named_inside(net: str) -> bool:
        power = any(
            (s := symbols.get(i.symbol)) is not None
            and s.power_net is not None
            and i.model.params.get("net", s.power_net) == net
            for i in parts
        )
        return power or any(
            lb.id in ids and lb.kind == "global" and lb.text == net for lb in sheet.labels
        )

    def on_wires(point: Point, wires: list[list[Point]]) -> bool:
        return any(_on_segment(point, a, b) for pts in wires for a, b in pairwise(pts))

    def contacts(net: str) -> tuple[list[Point], bool]:
        """Every point where the selection meets the rest: (points, geometric contact).

        Each one gets a label: the selected parts may touch the net in several separate places
        (a part on each side of a labelled net), and each piece must stay on the net.
        """
        touching = (inside[net] & outside[net]) | {
            p for p in inside[net] if on_wires(p, outside_wires[net])
        }
        touching |= {p for p in outside[net] if on_wires(p, inside_wires[net])}
        if touching:
            return sorted(touching), True
        # Joined only by a label of the same name: the port takes the place of that label.
        own = sorted(
            lb.at for lb in sheet.labels if lb.id in ids and nets.item_net.get(lb.id) == net
        )
        return (own or sorted(inside[net]))[:1], False

    all_refs = {i.ref for s in project.sheets for i in s.instances}
    ref = _next(all_refs, "X")
    taken_names = {lb.text for lb in sheet.labels} | set(nets.members)
    new_labels = [lb.model_copy(deep=True) for lb in sheet.labels if lb.id in ids]
    added: list[Instance] = []
    outer_labels: list[Label] = []
    port_net: dict[str, str] = {}  # port -> outside net name
    boundary = sorted((n for n in inside if n in outside), key=lambda n: min(inside[n]))
    port_count = 0
    for net in boundary:
        points, touches = contacts(net)
        if not touches and net in global_names and _named_inside(net):
            continue  # a ground / power symbol or global label inside already joins it
        if net == "0":
            for at in points:
                added.append(Instance(ref=_next(all_refs, "#GND"), symbol="bpt:gnd", at=at))
                all_refs.add(added[-1].ref)
            continue
        if net in global_names:
            new_labels += [Label(text=net, kind="global", at=at) for at in points]
            continue
        if _AUTO_NET.match(net):
            port_count += 1
            port = f"P{port_count}"
        else:
            port = net
        outer = net
        if net not in named_outside:  # the outside needs a name for this net
            outer = port if port not in taken_names or port == net else f"{ref}_{port}"
            taken_names.add(outer)
            if touches:
                outer_labels += [Label(text=outer, at=at) for at in points]
        port_net[port] = outer
        for at in points:
            # A selected label already naming this net becomes the port; otherwise add one.
            own = next((lb for lb in new_labels if lb.kind == "local" and lb.at == at), None)
            if own is not None:
                own.kind, own.text = "port", port
            else:
                new_labels.append(Label(text=port, kind="port", at=at))

    inner = Sheet(
        name=name,
        instances=[i.model_copy(deep=True) for i in parts] + added,
        wires=[w.model_copy(deep=True) for w in sheet.wires if w.id in ids],
        junctions=[j.model_copy(deep=True) for j in sheet.junctions if j.id in ids],
        labels=new_labels,
        directives=[d.model_copy(deep=True) for d in sheet.directives if d.id in ids],
    )
    symbol = block_symbol(inner)
    removed = [o.id for kind in ("instances", "wires", "junctions", "labels", "directives")
               for o in getattr(sheet, kind) if o.id in ids]  # fmt: skip
    commands: list[AnyCommand] = [
        RemoveObjects(sheet=sheet_name, ids=removed),
        AddSheet(sheet=inner),
    ]
    if symbol is not None:  # no ports: the sheet only joins the rest through global nets
        xs = [i.at[0] for i in parts]
        ys = [i.at[1] for i in parts]
        centre = (round((min(xs) + max(xs)) / 2 / G) * G, round((min(ys) + max(ys)) / 2 / G) * G)
        block = Instance(ref=ref, symbol=f"{PREFIX}{name}", at=centre)
        pin_labels = [
            Label(text=port_net[pin.number], at=transform(pin.at, block)) for pin in symbol.pins
        ]
        commands.append(
            AddObjects(sheet=sheet_name, instances=[block], labels=outer_labels + pin_labels)
        )
    return Extracted(
        command=Transaction(label=f"create block {name}", commands=commands),
        ref=ref if symbol is not None else "",
        ports=list(port_net),
    )
