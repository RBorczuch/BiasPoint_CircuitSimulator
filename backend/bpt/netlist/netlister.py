"""Project -> CircuitIR, with electrical rules check (ERC)."""

import re
from collections import Counter
from dataclasses import dataclass, field

from bpt.document.model import Instance, ModelCard, Project, Sheet, SubcktModel
from bpt.library.blocks import PREFIX as BLOCK
from bpt.library.blocks import drawn_symbol_problems, project_symbols
from bpt.library.blocks import ports as block_ports
from bpt.library.builtin import builtin_models, builtin_subcircuits
from bpt.library.symbols import Symbol
from bpt.netlist.connectivity import Nets, bus_members, resolve_nets
from bpt.netlist.erc import ErcIssue, check_circuit
from bpt.netlist.ir import CircuitIR, Device, Subcircuit
from bpt.netlist.ngspice_writer import is_behavioural, is_script
from bpt.netlist.probes import PROBE
from bpt.units import InvalidValueError, is_expression, parse_value

_AUTO_NET = re.compile(r"^N\d{3,}$")
_UNSAFE = re.compile(r"[^A-Za-z0-9_.+-]")


@dataclass
class NetlistResult:
    circuit: CircuitIR
    issues: list[ErcIssue] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not any(issue.severity == "error" for issue in self.issues)


def _spice_nodes(net_names: list[str]) -> dict[str, str]:
    """User net name -> unique SPICE node name (ngspice is case-insensitive)."""
    mapping: dict[str, str] = {}
    used: set[str] = set()
    for net in sorted(net_names):
        base = "0" if net == "0" else (_UNSAFE.sub("_", net).lower() or "n")
        node, n = base, 1
        while node in used:
            n += 1
            node = f"{base}_{n}"
        used.add(node)
        mapping[net] = node
    return mapping


def expand_parasitics(device: Device, symbol: Symbol) -> list[Device]:
    """The part plus its non-ideal elements (empty values are absent).

    Series elements form a chain from the first terminal through the part to the second
    one (``A - part - ESR - ESL - B``); parallel ones sit across the outer terminals. The
    part keeps its reference, so ``I(C1)`` is the current of the ideal element itself.
    """
    values = {}
    for parasitic in symbol.parasitics:
        value = device.params.pop(parasitic.key, "").strip()
        if value:
            values[parasitic.key] = value
    if not values:
        return [device]
    first, last = device.nodes[0], device.nodes[1]
    series = [p for p in symbol.parasitics if p.connection == "series" and p.key in values]
    internal = [_UNSAFE.sub("_", f"_{device.ref}_{p.key}").lower() for p in series]
    chain = [first, *internal, last]
    devices = [device.model_copy(update={"nodes": [chain[0], chain[1], *device.nodes[2:]]})]
    for i, parasitic in enumerate(series, start=1):
        devices.append(Device(
            ref=f"{device.ref}_{parasitic.key}", element=parasitic.element,
            nodes=[chain[i], chain[i + 1]], params={parasitic.element: values[parasitic.key]},
            instance_id=device.instance_id,
        ))  # fmt: skip
    for parasitic in symbol.parasitics:
        if parasitic.connection == "parallel" and parasitic.key in values:
            devices.append(Device(
                ref=f"{device.ref}_{parasitic.key}", element=parasitic.element, nodes=[first, last],
                params={parasitic.element: values[parasitic.key]},
                instance_id=device.instance_id,
            ))  # fmt: skip
    return devices


def netlist_project(
    project: Project,
    symbols: dict[str, Symbol] | None = None,
    models: dict[str, ModelCard] | None = None,
) -> NetlistResult:
    """Project -> circuit IR. Sheets placed as blocks become subcircuits; the rest is the top."""
    symbols = symbols if symbols is not None else project_symbols(project)
    library_models = {**builtin_models(), **(models or {}), **project.models}
    subckt_models = {**builtin_subcircuits(), **project.subcircuits}
    issues: list[ErcIssue] = []
    by_name = {sheet.name: sheet for sheet in project.sheets}
    order, cyclic = _block_order(project)
    for name in cyclic:
        issues.append(ErcIssue.error(
            "block-cycle", f"sheet {name} contains itself (directly or through other blocks)", []
        ))  # fmt: skip
    blocks = set(order) | set(cyclic)
    for name in sorted(blocks):
        missing, extra = drawn_symbol_problems(by_name[name])
        if missing:
            issues.append(ErcIssue.warning("block-symbol", (
                f"the drawn symbol of sheet {name} has no pin for port {', '.join(missing)}; "
                "the block uses the automatic box until the drawing is fixed"), []))  # fmt: skip
        elif extra:
            issues.append(ErcIssue.warning("block-symbol", (
                f"pins {', '.join(extra)} of the drawn symbol of sheet {name} are not ports "
                "and are left out"), []))  # fmt: skip
    # A sheet with ports that no block uses is a block (or template / component) waiting to be
    # placed, not part of the circuit: its open ports would fail the whole project's ERC.
    # Another model of a block (a variant) waits like an unplaced block, without a warning.
    alternatives = {v.sheet for s in project.sheets for v in s.variants}
    unplaced = [
        s for i, s in enumerate(project.sheets)
        if i > 0 and s.name not in blocks and s.name not in alternatives
        and (s.owner or any(lb.kind == "port" for lb in s.labels))
    ]  # fmt: skip
    skipped_alternatives = {name for name in alternatives if name not in blocks}
    for sheet in unplaced:
        issues.append(ErcIssue.warning(
            "unplaced-block", f"sheet {sheet.name} has ports but no block uses it: not simulated",
            [],
        ))  # fmt: skip
    skipped = blocks | {s.name for s in unplaced} | skipped_alternatives
    top_view = project.model_copy(
        update={"sheets": [s for s in project.sheets if s.name not in skipped]}
    )
    circuit = CircuitIR(title=project.name, parameters=dict(project.parameters))
    defaults = {sheet.name: sheet.parameters for sheet in project.sheets}
    scope = _netlist_scope(top_view, symbols, (library_models, subckt_models), circuit, issues,
                           defaults, top=True, sheets_by_name=by_name)  # fmt: skip
    circuit.devices, circuit.net_names = scope.devices, scope.net_names

    shared: set[str] = set()
    for name in order:  # children before the sheets that use them
        sheet = by_name[name]
        inner = _netlist_scope(project.model_copy(update={"sheets": [sheet]}), symbols,
                               (library_models, subckt_models), circuit, issues, defaults,
                               top=False, sheets_by_name=by_name)  # fmt: skip
        port_nodes = []
        for port, _side in block_ports(sheet):
            label = next((lb for lb in sheet.labels if lb.kind == "port" and lb.text == port), None)
            # A member of a bus port (D[0..3] -> D0...) is the net of that name inside.
            net = inner.nets.item_net.get(label.id) if label is not None else port
            port_nodes.append(
                inner.node_of[net] if net in inner.node_of else f"_open_{port.lower()}"
            )
        sub = Subcircuit(
            name=subckt_name(name),
            ports=port_nodes,
            params=dict(sheet.parameters),
            devices=inner.devices,
            directives=inner.directives,
            net_names=inner.net_names,
        )
        circuit.subcircuits.append(sub)
        shared |= inner.global_nodes
    circuit.globals = sorted(shared - {"0"})
    issues += check_circuit(circuit)
    return NetlistResult(circuit=circuit, issues=issues)


_VOLTAGE_REF = re.compile(r"\bv\(\s*([^,()\s]+)\s*(?:,\s*([^,()\s]+)\s*)?\)", re.IGNORECASE)
_MODEL_LINE = re.compile(r"^\s*\.model\s+(\S+)", re.IGNORECASE)
_LOCAL_DIRECTIVE = re.compile(r"^\s*\.(param|func|model|subckt|ends|include|lib)\b", re.IGNORECASE)


def subckt_name(sheet: str) -> str:
    return "sheet_" + (_UNSAFE.sub("_", sheet).lower() or "unnamed")


def block_sheet(inst: Instance, by_name: dict[str, Sheet]) -> str:
    """The sheet a block simulates: its own, or the one of the variant it chose."""
    name = inst.symbol[len(BLOCK) :]
    sheet = by_name.get(name)
    if sheet is not None and inst.model.variant:
        chosen = next((v for v in sheet.variants if v.name == inst.model.variant), None)
        if chosen is not None and chosen.sheet in by_name:
            return chosen.sheet
    return name


def _block_order(project: Project) -> tuple[list[str], list[str]]:
    """Sheets used as blocks, inner ones first; plus those in a cycle (a sheet inside itself)."""
    by_name = {s.name: s for s in project.sheets}
    uses = {
        sheet.name: {
            name
            for inst in sheet.instances
            if inst.symbol.startswith(BLOCK)
            for name in {inst.symbol[len(BLOCK) :], block_sheet(inst, by_name)}
        }
        for sheet in project.sheets
    }
    used = set().union(*uses.values()) if uses else set()
    order: list[str] = []
    cyclic: set[str] = set()
    state: dict[str, int] = {}  # 1 = visiting, 2 = done

    def visit(name: str, path: list[str]) -> None:
        if state.get(name) == 2:
            return
        if state.get(name) == 1:
            cyclic.update(path[path.index(name) :])
            return
        state[name] = 1
        for child in sorted(uses.get(name, set())):
            visit(child, [*path, child])
        state[name] = 2
        if name in used and name not in cyclic:
            order.append(name)

    for name in sorted(uses):
        visit(name, [name])
    return [n for n in order if n not in cyclic and n in uses], sorted(
        n for n in cyclic if n in uses
    )


@dataclass
class _Scope:
    devices: list[Device]
    net_names: dict[str, str]
    nets: Nets
    node_of: dict[str, str]
    global_nodes: set[str]
    directives: list[str]  # local to a block sheet (.param, .func, .model)


def _netlist_scope(
    project: Project,
    symbols: dict[str, Symbol],
    models: tuple[dict[str, ModelCard], dict[str, SubcktModel]],
    circuit: CircuitIR,
    issues: list[ErcIssue],
    block_defaults: dict[str, dict[str, str]],
    top: bool,
    sheets_by_name: dict[str, Sheet] | None = None,
) -> _Scope:
    """Devices of some sheets (the top, or one block sheet) with their own nets."""
    sheets_by_name = sheets_by_name or {s.name: s for s in project.sheets}
    nets = resolve_nets(project, symbols)
    node_of = _spice_nodes(list(nets.members))
    devices: list[Device] = []
    local: list[str] = []

    for name, candidates in nets.name_conflicts:
        issues.append(ErcIssue.warning(
            "net-name-conflict", f"net has several names {candidates}; using {name!r}", [name]
        ))  # fmt: skip

    for sheet in project.sheets:
        if any(is_script(d.text) for d in sheet.directives):
            issues.append(ErcIssue.warning(
                "script-ignored", f"{sheet.name}: .control / .exec scripts are not run (they can "
                "start programs); set analyses in Simulate or an analysis graph", [],
            ))  # fmt: skip
    instances = [inst for sheet in project.sheets for inst in sheet.instances]
    # SPICE names are case-insensitive: R1 and r1 are the same element for ngspice.
    duplicates = [ref for ref, n in Counter(i.ref.upper() for i in instances).items() if n > 1]
    issues += [
        ErcIssue.error("duplicate-ref", f"reference {ref} is used more than once", [ref])
        for ref in duplicates
    ]
    # Nets reaching a port of this sheet are connected (to whatever the block is wired to).
    port_nets = {
        nets.item_net[label.id]
        for sheet in project.sheets
        for label in sheet.labels
        if label.kind == "port" and label.id in nets.item_net
    } | {
        member  # members of a bus port (D[0..3]): the nets D0..D3
        for sheet in project.sheets
        for label in sheet.labels
        if label.kind == "port"
        for member in bus_members(label.text)
    }
    # Nets read by name in behavioural expressions (B1 b 0 V=V(a)*2) are used, not open.
    expression_nets = {
        name.lower()
        for inst in instances
        for value in inst.model.params.values()
        for pair in _VOLTAGE_REF.findall(value)
        for name in pair
        if name
    }
    global_nodes = {
        node_of[net]
        for sheet in project.sheets
        for label in sheet.labels
        if label.kind == "global" and (net := nets.item_net.get(label.id)) in node_of
    }

    # Models written as .model directives on these sheets (a template's parametrized model,
    # or one typed by the user) exist without being in a library.
    declared = {
        m.group(1).lower()
        for sheet in project.sheets
        for directive in sheet.directives
        if (m := _MODEL_LINE.match(directive.text))
    }
    for sheet in project.sheets:
        for directive in sheet.directives:
            # Inside a block, definitions stay in its .subckt; analyses and options are global.
            is_local = not top and _LOCAL_DIRECTIVE.match(directive.text)
            (local if is_local else circuit.directives).append(directive.text)
        for inst in sheet.instances:
            symbol = symbols.get(inst.symbol)
            if symbol is not None:
                symbol = symbol.with_variant(inst.model.variant)
            if symbol is None:
                issues.append(
                    ErcIssue.error("unknown-symbol", f"{inst.ref}: unknown symbol {inst.symbol}",
                                   [inst.ref])
                )  # fmt: skip
                continue
            if symbol.power_net is not None and symbol.power_net != "0":
                global_nodes |= {
                    node_of[n] for k, n in nets.pin_net.items() if k[0] == inst.id and n in node_of
                }
            if symbol.spice is None:  # power symbols, voltage probes, decorations
                if symbol.power_net is None and symbol.pins and not inst.symbol.startswith(PROBE):
                    issues.append(ErcIssue.warning(
                        "not-simulated", f"{inst.ref}: {symbol.name} has no SPICE model "
                        "(it is drawn but not simulated)", [inst.ref],
                    ))  # fmt: skip
                continue
            library_models, subckt_models = models
            model_name = inst.model.model or symbol.default_model
            sub = subckt_models.get(model_name) if model_name else None
            block = inst.symbol.startswith(BLOCK)
            order = symbol.spice.nodes
            if sub is not None and not block:
                order = inst.model.pins or _pin_order(symbol, sub)
                if len(order) != len(sub.pins):
                    issues.append(ErcIssue.error(
                        "pin-map", f"{inst.ref}: model {model_name} has {len(sub.pins)} pins "
                        f"({' '.join(sub.pins)}), the part maps {len(order)}", [inst.ref],
                    ))  # fmt: skip
                    continue
            nodes = []
            for pin_number in order:
                if pin_number.startswith("="):  # tied to a net: "=0" ground, "=VCC" ...
                    fixed = pin_number[1:]
                    nodes.append(node_of.get(fixed) or _UNSAFE.sub("_", fixed) or "0")
                    continue
                if (inst.id, pin_number) not in nets.pin_net:
                    issues.append(ErcIssue.error(
                        "pin-map", f"{inst.ref}: no pin {pin_number} for the model", [inst.ref]
                    ))  # fmt: skip
                    break
                net = nets.pin_net[(inst.id, pin_number)]
                # A block pin on a labelled net is an output looked at by name: it is connected
                # inside the block, so it is not open.
                labelled_block_pin = symbol.spice.element == "X" and not _AUTO_NET.match(net)
                # Ground, and inside a block a global net, reach parts elsewhere.
                elsewhere = net == "0" or (not top and node_of.get(net) in global_nodes)
                lonely = (
                    len(nets.members[net]) == 1
                    and net not in port_nets
                    and net.lower() not in expression_nets
                )
                if lonely and not labelled_block_pin and not elsewhere:
                    issues.append(ErcIssue.error(
                        "unconnected-pin", f"{inst.ref}: pin {pin_number} is not connected",
                        [inst.ref],
                    ))  # fmt: skip
                nodes.append(node_of[net])
            if len(nodes) != len(order):
                continue
            if sub is not None and model_name is not None and not block:
                circuit.subckt_models[model_name] = sub
                overrides = {k: v for k, v in inst.model.params.items() if k in sub.params}
                devices.append(Device(ref=inst.ref, element="X", nodes=nodes, params=overrides,
                                      model=model_name, instance_id=inst.id))  # fmt: skip
                continue
            if block:
                sheet_name = block_sheet(inst, sheets_by_name)
                known = block_defaults.get(sheet_name, {})
                for key in sorted(set(inst.model.params) - set(known)):
                    message = f"{inst.ref}: sheet {sheet_name} has no parameter {key} (ignored)"
                    issues.append(ErcIssue.warning("unknown-block-param", message, [inst.ref]))
                overrides = {k: v for k, v in inst.model.params.items() if k in known and v.strip()}
                sheet_model = subckt_name(sheet_name)
                devices.append(Device(ref=inst.ref, element="X", nodes=nodes, params=overrides,
                                      model=sheet_model, instance_id=inst.id))  # fmt: skip
                continue
            if symbol.spice.element == "X":  # a subcircuit part without its model
                issues.append(ErcIssue.error(
                    "missing-model", f"{inst.ref}: subcircuit model {model_name} not found",
                    [inst.ref],
                ))  # fmt: skip
                continue
            if model_name is not None and model_name.lower() not in declared:
                if model_name not in library_models:
                    issues.append(ErcIssue.error(
                        "missing-model", f"{inst.ref}: model {model_name} not found", [inst.ref]
                    ))  # fmt: skip
                else:
                    circuit.models[model_name] = library_models[model_name]
            params = {**symbol.default_params, **inst.model.params}
            if symbol.spice.element == "B" and "i" in inst.model.params:
                params.pop("v", None)  # a current source (I=...): the default V=0 is not it
            if symbol.spice.element == "A":  # H(s): its own s_xfer model, from its expression
                from bpt.models.transfer import TransferError, parse_transfer, s_xfer_params

                try:
                    num, den = parse_transfer(params.get("h", ""))
                except TransferError as exc:
                    issues.append(ErcIssue.error("transfer", f"{inst.ref}: {exc}", [inst.ref]))
                    continue
                model_name = f"hs_{inst.id.hex[:12]}"
                circuit.models[model_name] = ModelCard(
                    type="s_xfer", params=s_xfer_params(num, den)
                )
                params = {}
            issues += _value_issues(inst.ref, symbol, params, model_name)
            card = library_models.get(model_name or "")
            if symbol.spice.element == "M" and card is not None and card.type == "vdmos":
                nodes = nodes[:3]  # VDMOS (power MOSFET model) has no bulk terminal
            device = Device(
                ref=inst.ref,
                element=symbol.spice.element,
                nodes=nodes,
                params=params,
                model=model_name,
                instance_id=inst.id,
            )
            devices += expand_parasitics(device, symbol)
    return _Scope(
        devices, {node: net for net, node in node_of.items()}, nets, node_of, global_nodes, local
    )


def _pin_order(symbol: Symbol, sub: SubcktModel) -> list[str]:
    """Symbol pins in the order of the subcircuit's pins: by name when they all match."""
    by_name = {p.name.lower(): p.number for p in symbol.pins if p.name}
    by_name |= {p.number.lower(): p.number for p in symbol.pins}
    named = [by_name.get(pin.lower()) for pin in sub.pins]
    if all(named):
        return [n for n in named if n]
    assert symbol.spice is not None
    return (
        [n for n in symbol.spice.nodes if n != "=0"]
        if symbol.spice.element != "X"
        else list(symbol.spice.nodes)
    )


def _value_issues(
    ref: str, symbol: Symbol, params: dict[str, str], model: str | None
) -> list[ErcIssue]:
    """Values ngspice cannot read ("abc", "1,5k") as a clear error before simulating."""
    keys = [p.key for p in symbol.parasitics]
    if symbol.value_param and model is None:
        keys.insert(0, symbol.value_param)
    issues = []
    for key in keys:
        raw = params.get(key, "").strip()
        if not raw or is_expression(raw) or is_behavioural(raw):
            continue
        try:
            value = parse_value(raw)
        except InvalidValueError:
            name = key if key != symbol.value_param else "value"
            issues.append(ErcIssue.error(
                "bad-value", f'{ref}: {name} "{raw}" is not a number', [ref]
            ))  # fmt: skip
            continue
        if (
            value == 0
            and key == symbol.value_param
            and symbol.spice
            and symbol.spice.element in "RL"
        ):
            # ngspice turns 0 ohm into 1 pohm: the huge conductance costs accuracy (5 V over 1k
            # gave 4.88 mA), a 0 H inductor is a short in every analysis.
            issues.append(ErcIssue.warning(
                "zero-value", f"{ref} is 0: use a wire, or a small value such as 1m", [ref]
            ))  # fmt: skip
    return issues
