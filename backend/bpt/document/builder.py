"""Building schematics from net-level descriptions (netlist import, AI agents).

Placed components are connected with *net labels*, not routed wires: each pin gets a short
wire stub ending in a local label with the net name (or a ground symbol for net ``0``).
The result is always electrically correct; nicer auto-routing can come later.
All functions return commands, so every change is undoable and broadcast.
"""

import re
from collections.abc import Iterator
from itertools import count

from bpt.document.commands import (
    AddObjects,
    AddSheet,
    AnyCommand,
    RemoveObjects,
    SetModel,
    SetParameter,
    SetParams,
    Transaction,
    UpdateInstance,
)
from bpt.document.model import Directive, Instance, Label, ModelRef, Point, Project, Sheet, Wire
from bpt.library.blocks import project_symbols
from bpt.library.builtin import builtin_symbols
from bpt.library.symbols import Pin, Symbol
from bpt.netlist.connectivity import resolve_nets, transform
from bpt.netlist.ir import CircuitIR, Device
from bpt.netlist.netlister import netlist_project
from bpt.netlist.ngspice_writer import element_line, model_line, subckt_line
from bpt.netlist.spice_parser import ParsedNetlist

G = 127
STUB = 2 * G
CELL_X, CELL_Y, PER_ROW = 14 * G, 16 * G, 6

_ELEMENT_SYMBOL = {
    "R": "bpt:resistor", "C": "bpt:capacitor", "L": "bpt:inductor", "V": "bpt:vsource",
    "I": "bpt:isource", "E": "bpt:vcvs", "G": "bpt:vccs", "F": "bpt:cccs", "H": "bpt:ccvs",
    "B": "bpt:bsource", "D": "bpt:diode", "S": "bpt:switch",
}  # fmt: skip
_TYPED_SYMBOL = {"npn": "bpt:npn", "pnp": "bpt:pnp", "nmos": "bpt:nmos", "pmos": "bpt:pmos",
                 "njf": "bpt:njfet", "pjf": "bpt:pjfet"}  # fmt: skip
_AUTO_NET = re.compile(r"^N\d{3,}$")


class BuildError(ValueError):
    """The requested change cannot be built."""


def symbol_for(device: Device, circuit: CircuitIR, project: Project | None = None) -> str:
    if device.element in ("Q", "M", "J"):
        models = {**(project.models if project else {}), **circuit.models}
        card = models.get(device.model or "")
        default = {"Q": "npn", "M": "nmos", "J": "njf"}[device.element]
        return _TYPED_SYMBOL[card.type if card and card.type in _TYPED_SYMBOL else default]
    if device.element not in _ELEMENT_SYMBOL:
        raise BuildError(f"{device.ref}: no symbol for {device.element} elements yet")
    return _ELEMENT_SYMBOL[device.element]


def _direction(pin: Pin) -> tuple[int, int]:
    x, y = pin.at
    if (x, y) == (0, 0):
        return (0, 1)
    if abs(x) >= abs(y):
        return (1 if x > 0 else -1, 0)
    return (0, 1 if y > 0 else -1)


def _bounds_bottom(sheet: Sheet) -> int:
    ys = [inst.at[1] for inst in sheet.instances]
    ys += [y for wire in sheet.wires for _x, y in wire.points]
    ys += [label.at[1] for label in sheet.labels]
    return max(ys) if ys else -CELL_Y


class _Placer:
    """Assigns free grid cells below the existing drawing."""

    def __init__(self, sheet: Sheet) -> None:
        self.top = _bounds_bottom(sheet) + CELL_Y
        self.slots = count()

    def next(self) -> Point:
        slot = next(self.slots)
        return (CELL_X * (slot % PER_ROW), self.top + CELL_Y * (slot // PER_ROW))


def _ground_refs(sheets: list[Sheet]) -> Iterator[int]:
    used = [
        int(m.group(1))
        for sheet in sheets
        for inst in sheet.instances
        if (m := re.match(r"^#GND(\d+)$", inst.ref))
    ]
    return count(max(used, default=0) + 1)


def _terminal(
    at: Point, net: str, gnd_numbers: Iterator[int], leftward: bool = False
) -> tuple[list[Instance], list[Label]]:
    """A ground or a net label at the end of a stub; on a stub going left the label points
    left too (mirrored, its text upright), not back over the stub."""
    if net == "0":
        return [Instance(ref=f"#GND{next(gnd_numbers)}", symbol="bpt:gnd", at=at)], []
    return [], [Label(text=net, at=at, rot=180 if leftward else 0)]


def _assign_nets(symbol: Symbol, ref: str, nets: list[str]) -> dict[str, str]:
    """Pin number -> net. ``nets`` lists one net per distinct pin, or one per SPICE node."""
    if symbol.spice is None:
        raise BuildError(f"{symbol.id} is not a circuit element")
    nodes = symbol.spice.nodes
    pins = list(dict.fromkeys(p for p in nodes if p != "=0"))
    if len(nets) == len(pins):
        return dict(zip(pins, nets, strict=True))
    if len(nets) != len(nodes):
        raise BuildError(f"{ref}: {symbol.name} needs {len(pins)} nets ({', '.join(pins)})")
    assigned: dict[str, str] = {}
    for number, net in zip(nodes, nets, strict=True):
        if number == "=0":
            continue
        if assigned.setdefault(number, net) != net:
            raise BuildError(f"{ref}: pin {number} cannot be on both {assigned[number]} and {net}")
    return assigned


def place_component(
    symbol: Symbol,
    ref: str,
    nets: list[str],
    at: Point,
    params: dict[str, str] | None = None,
    model: str | None = None,
    gnd_numbers: Iterator[int] | None = None,
) -> AddObjects:
    """Instance at ``at`` with a stub + label per pin; ``nets`` follow ``symbol.spice.nodes``."""
    assigned = _assign_nets(symbol, ref, nets)
    instance = Instance(ref=ref, symbol=symbol.id, at=at, model=ModelRef(model=model,
                        params=dict(params or {})))  # fmt: skip
    gnd_numbers = gnd_numbers or count(1)
    command = AddObjects(instances=[instance])
    for pin in symbol.pins:
        net = assigned.get(pin.number)
        if net is None:
            continue
        start = transform(pin.at, instance)
        dx, dy = _direction(pin)
        end = (start[0] + dx * STUB, start[1] + dy * STUB)
        command.wires.append(Wire(points=[start, end]))
        grounds, labels = _terminal(end, net, gnd_numbers, leftward=dx < 0)
        command.instances += grounds
        command.labels += labels
    return command


def import_netlist(
    project: Project, parsed: ParsedNetlist, sheet_name: str = "root"
) -> Transaction:
    """Commands that add every device, model and parameter of ``parsed`` to a sheet."""
    sheet = project.sheet(sheet_name)
    symbols = builtin_symbols()
    existing = {inst.ref.lower() for s in project.sheets for inst in s.instances}
    placer, grounds = _Placer(sheet), _ground_refs(project.sheets)
    circuit = parsed.circuit
    # One command for all parts: adding them one by one re-sorts the sheet each time.
    parts = AddObjects(sheet=sheet_name)
    for device in circuit.devices:
        if device.ref.lower() in existing:
            raise BuildError(f"reference {device.ref} already exists")
        nets = [circuit.net_names.get(node.lower(), node) for node in device.nodes]
        symbol = symbols[symbol_for(device, circuit, project)]
        params = dict(device.params)
        if device.element in ("V", "I") and "dc" not in params:
            params["dc"] = ""  # as in the netlist: no DC value (not the symbol's default)
        add = place_component(
            symbol, device.ref, nets, placer.next(), params, device.model, grounds
        )
        parts.instances += add.instances
        parts.wires += add.wires
        parts.labels += add.labels
    commands: list[AnyCommand] = [parts] if parts.instances else []
    for name, card in circuit.models.items():
        commands.append(SetModel(name=name, card=card))
    for name, value in circuit.parameters.items():
        commands.append(SetParameter(name=name, value=value))
    if circuit.directives:
        at = placer.next()
        directives = [
            Directive(text=text, at=(at[0], at[1] + i * G))
            for i, text in enumerate(circuit.directives)
        ]
        commands.append(AddObjects(sheet=sheet_name, directives=directives))
    return Transaction(label="import netlist", commands=commands)


def _find_instance(project: Project, ref: str) -> tuple[Sheet, Instance]:
    for sheet in project.sheets:
        for inst in sheet.instances:
            if inst.ref.lower() == ref.lower():
                return sheet, inst
    raise BuildError(f"no component {ref}")


def _find_pin(symbol: Symbol, pin: str) -> Pin:
    for candidate in symbol.pins:
        if candidate.number.lower() == pin.lower() or candidate.name.lower() == pin.lower():
            return candidate
    names = ", ".join(p.number for p in symbol.pins)
    raise BuildError(f"{symbol.name} has no pin {pin!r} (pins: {names})")


def add_component(
    project: Project,
    symbol_id: str,
    nets: list[str],
    ref: str | None = None,
    params: dict[str, str] | None = None,
    model: str | None = None,
    sheet_name: str = "root",
) -> tuple[str, AnyCommand]:
    """A part on ``sheet_name`` wired to ``nets``. A library component (``cmp:<lib>/<name>``)
    brings its equivalent-circuit sheets along, in the same undo step (as placing it in the
    interface does)."""
    extra: list[Sheet] = []
    view = project
    if symbol_id.startswith("cmp:"):
        from bpt.library import libraries
        from bpt.library.components import component_sheets

        component = libraries.all_components().get(symbol_id)
        if component is None:
            raise BuildError(f"no library component {symbol_id}")
        top, extra = component_sheets(project, component)
        view = project.model_copy(update={"sheets": [*project.sheets, *extra]})
        symbol_id = f"sheet:{top}"
    symbols = project_symbols(view)
    symbol = symbols.get(symbol_id) or symbols.get(f"bpt:{symbol_id}")
    if symbol is None:
        raise BuildError(f"unknown symbol {symbol_id}")
    refs = {inst.ref.lower() for s in project.sheets for inst in s.instances}
    if ref is None:
        ref = next(f"{symbol.ref_prefix}{n}" for n in count(1)
                   if f"{symbol.ref_prefix}{n}".lower() not in refs)  # fmt: skip
    elif ref.lower() in refs:
        raise BuildError(f"reference {ref} already exists")
    sheet = project.sheet(sheet_name)
    add = place_component(symbol, ref, nets, _Placer(sheet).next(), params, model,
                          _ground_refs(project.sheets))  # fmt: skip
    add.sheet = sheet_name
    if not extra:
        return ref, add
    sheets: list[AnyCommand] = [AddSheet(sheet=s) for s in extra]
    return ref, Transaction(label=f"place {ref}", commands=[*sheets, add])


def set_component(
    project: Project,
    ref: str,
    params: dict[str, str | None],
    model: str | None = None,
    ratings: dict[str, str] | None = None,
) -> AnyCommand:
    """Parameters (None deletes one), model and/or ratings (replaced as a whole) of a part."""
    sheet, inst = _find_instance(project, ref)
    command = SetParams(sheet=sheet.name, id=inst.id, params=params)
    if model is not None:
        command = SetParams(sheet=sheet.name, id=inst.id, params=params, model=model)
    if ratings is None:
        return command
    rate = UpdateInstance(sheet=sheet.name, id=inst.id, ratings=ratings)
    return Transaction(label=f"set {ref}", commands=[command, rate])


def remove_component(project: Project, ref: str) -> RemoveObjects:
    """Remove a component with the stubs, labels and ground symbols hanging off its pins."""
    sheet, inst = _find_instance(project, ref)
    symbol = project_symbols(project).get(inst.symbol)
    ids = [inst.id]
    if symbol is not None:
        pin_points = {transform(pin.at, inst) for pin in symbol.pins}
        for wire in sheet.wires:
            if len(wire.points) != 2:
                continue
            start, end = wire.points
            far = end if start in pin_points else start if end in pin_points else None
            if far is None:
                continue
            others = [w for w in sheet.wires if w is not wire and far in w.points]
            if others:
                continue
            ids.append(wire.id)
            ids += [label.id for label in sheet.labels if label.at == far]
            ids += [g.id for g in sheet.instances if g.symbol == "bpt:gnd" and g.at == far]
    return RemoveObjects(sheet=sheet.name, ids=ids)


def connect_pins(project: Project, pin_a: str, pin_b: str) -> AddObjects:
    """Join two pins (``"R1.2"``, ``"Q1.B"``) by giving them the same net label."""
    symbols = project_symbols(project)
    ends = []
    for spec in (pin_a, pin_b):
        ref, _, pin_name = spec.rpartition(".")
        if not ref:
            raise BuildError(f"pin must look like REF.PIN, got {spec!r}")
        sheet, inst = _find_instance(project, ref)
        pin = _find_pin(symbols[inst.symbol], pin_name)
        ends.append((sheet, inst, pin))
    nets = resolve_nets(project, symbols)
    current = [nets.pin_net[(inst.id, pin.number)] for _s, inst, pin in ends]
    if current[0] == current[1]:
        raise BuildError(f"{pin_a} and {pin_b} are already connected")
    named = [n for n in current if not _AUTO_NET.match(n)]
    target = named[0] if named else f"net_{ends[0][1].ref}_{ends[0][2].number}".lower()
    add = AddObjects(sheet=ends[0][0].name)
    for (sheet, inst, pin), net in zip(ends, current, strict=True):
        if net == target:
            continue
        if sheet.name != add.sheet:
            raise BuildError("connecting pins on different sheets: use a global label")
        start = transform(pin.at, inst)
        if len(nets.members[net]) > 1:  # already wired: label right on the pin
            add.labels.append(Label(text=target, at=start))
            continue
        dx, dy = _direction(pin)
        end = (start[0] + dx * STUB, start[1] + dy * STUB)
        add.wires.append(Wire(points=[start, end]))
        add.labels.append(Label(text=target, at=end))
    return add


def describe(project: Project) -> str:
    """Compact netlist with user refs and net names, followed by ERC findings."""
    result = netlist_project(project)
    circuit = result.circuit
    lines = [f"* {project.name}"]
    lines += [f".param {k}={v}" for k, v in circuit.parameters.items()]

    def device_lines(devices: list[Device], net_names: dict[str, str]) -> list[str]:
        out = []
        for device in devices:
            named = device.model_copy(update={"nodes": [net_names.get(n, n) for n in device.nodes]})
            try:
                text = element_line(named)
            except ValueError as exc:
                text = f"{device.spice_name} ? ({exc})"
            out.append(device.ref + text[len(device.spice_name) :])
        return out

    # Sheets placed as blocks (hierarchy): their contents, with the sheet's own net names.
    for sub in circuit.subcircuits:
        ports = [sub.net_names.get(p, p) for p in sub.ports]
        lines.append(subckt_line(sub, ports))
        lines += [
            "  " + line for line in [*sub.directives, *device_lines(sub.devices, sub.net_names)]
        ]
        lines.append(f".ends {sub.name}")
    lines += device_lines(circuit.devices, circuit.net_names)
    lines += [model_line(name, card) for name, card in sorted(circuit.models.items())]
    lines += circuit.directives
    errors = [i for i in result.issues if i.severity == "error"]
    warnings = [i for i in result.issues if i.severity == "warning"]
    lines.append("ERC: ok" if not errors else f"ERC: {len(errors)} error(s)")
    lines += [f"  error: {i.message}" for i in errors] + [
        f"  warning: {i.message}" for i in warnings
    ]
    return "\n".join(lines)
