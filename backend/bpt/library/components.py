"""Placing library components (FR-CMP): their equivalent-circuit sheets join the project.

The sheets keep the component id in ``Sheet.owner`` (hidden from the sheet tabs, read-only
until copied) and the top one carries the component's metadata in ``Sheet.component``. A
component inside it (an IC in a module) keeps its own ``Sheet.component`` on its sheet, owned
by the outer one. Names are made unique in the project and the blocks inside point to the
renamed sheets. A component already placed in the same version reuses its sheets.
"""

from bpt.document.model import (
    Component,
    ComponentInfo,
    ComponentKind,
    PortSide,
    Project,
    Sheet,
    safe_sheet_name,
)
from bpt.library.blocks import PREFIX
from bpt.library.symbols import Symbol


def component_sheets(project: Project, component: Component) -> tuple[str, list[Sheet]]:
    """(name of the top sheet, sheets to add: none when the project has this version)."""
    for sheet in project.sheets:
        info = sheet.component
        if (
            info is not None
            and sheet.owner == component.id  # not the same IC inside a module
            and info.id == component.id
            and info.version == component.version
        ):
            return sheet.name, []
    taken = {s.name.lower() for s in project.sheets}
    names: dict[str, str] = {}
    for sheet in component.sheets:
        base = safe_sheet_name(sheet.name if len(component.sheets) > 1 else component.name)
        name, n = base[:40], 2
        while name.lower() in taken:
            name, n = f"{base[:36]}~{n}", n + 1
        taken.add(name.lower())
        names[sheet.name] = name
    info = ComponentInfo.model_validate(component.model_dump(exclude={"sheets"}))
    out = []
    for i, sheet in enumerate(component.sheets):
        instances = [
            inst.model_copy(update={"symbol": f"{PREFIX}{names[inst.symbol[len(PREFIX) :]]}"})
            if inst.symbol.startswith(PREFIX) and inst.symbol[len(PREFIX) :] in names
            else inst
            for inst in sheet.instances
        ]
        variants = [v.model_copy(update={"sheet": names.get(v.sheet, v.sheet)})
                    for v in sheet.variants]  # fmt: skip
        out.append(sheet.model_copy(update={
            "name": names[sheet.name], "instances": instances, "owner": component.id,
            "component": info if i == 0 else sheet.component, "variants": variants,
        }, deep=True))  # fmt: skip
    return names[component.sheets[0].name], out


# Kind of a part drawn like a built-in symbol (a SPICE model imported as a part).
_KIND_OF_SYMBOL: dict[str, ComponentKind] = {
    "bpt:opamp": "ic", "bpt:opamp_ideal": "ic", "bpt:npn": "transistor", "bpt:pnp": "transistor",
    "bpt:nmos": "transistor", "bpt:pmos": "transistor", "bpt:njfet": "transistor",
    "bpt:pjfet": "transistor", "bpt:diode": "diode", "bpt:zener": "diode", "bpt:led": "diode",
    "bpt:resistor": "resistor", "bpt:capacitor": "capacitor", "bpt:inductor": "inductor",
    "bpt:transformer": "transformer",
}  # fmt: skip
_SIDE: dict[str, PortSide] = {"left": "left", "right": "right", "up": "top", "down": "bottom"}


def component_from_symbol(
    library: str, symbol: Symbol, like: str, description: str = ""
) -> Component:
    """A real part made of one library symbol (an imported SPICE model): its sheet holds the
    symbol with a port on each pin, the part looks like the symbol. ``like``: the built-in
    symbol it was drawn as ("generic": a box); its kind and category come from it."""
    from bpt.document.model import Instance, Label
    from bpt.library.categories import builtin_category

    name = symbol.name
    sheet_name = safe_sheet_name(name)
    prefix = symbol.ref_prefix.lstrip("#") or "X"
    sheet = Sheet(
        name=sheet_name,
        instances=[Instance(ref=f"{prefix}1", symbol=symbol.id, at=(0, 0))],
        labels=[Label(kind="port", text=pin.number, at=pin.at) for pin in symbol.pins],
        port_sides={pin.number: _SIDE.get(pin.orientation, "left") for pin in symbol.pins},
        port_order=[pin.number for pin in symbol.pins],
        symbol=symbol.model_copy(update={"id": f"sheet:{sheet_name}"}),
    )
    subcircuit = symbol.spice is not None and symbol.spice.element == "X"
    kind: ComponentKind = _KIND_OF_SYMBOL.get(like, "ic" if subcircuit else "other")
    category = builtin_category(like) or ("Analog ICs" if kind == "ic" else "")
    return Component(
        id=f"cmp:{library}/{name}",
        name=name,
        kind=kind,
        category=category,
        description=description or symbol.description or f"{name} (SPICE model)",
        metadata={"technology": "SPICE model (the manufacturer's)"},
        sheets=[sheet],
    )
