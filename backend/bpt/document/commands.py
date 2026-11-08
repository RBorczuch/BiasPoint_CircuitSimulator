"""Document commands: every change to a project is a command with an exact inverse.

``apply(project)`` mutates the project and returns the inverse command; applying the inverse
restores the previous state exactly (lists are kept sorted by id, which with monotonic UUIDv7
equals creation order). GUI, CLI, scripts and AI agents all use these commands.

Object lists in a sheet are always sorted by id.
"""

import re
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from bpt.document.model import (
    ComponentInfo,
    Directive,
    Graph,
    Instance,
    Junction,
    Label,
    LabelKind,
    ModelCard,
    Point,
    PortSide,
    Project,
    Rotation,
    Sheet,
    Simulation,
    StressRules,
    SubcktModel,
    TemplateField,
    TextPlace,
    Wire,
    rating_problem,
    sheet_name_problem,
    simulation_problem,
)
from bpt.library.symbols import Look, Symbol

_KINDS = ("instances", "wires", "junctions", "labels", "directives")


class CommandError(ValueError):
    """The command cannot be applied to the current document."""


class _Command(BaseModel):
    model_config = ConfigDict(extra="forbid")

    def apply(self, project: Project) -> "AnyCommand":
        raise NotImplementedError


def _sheet(project: Project, name: str) -> Sheet:
    try:
        return project.sheet(name)
    except KeyError as exc:
        raise CommandError(str(exc)) from exc


def _edit_sheet(project: Project, name: str) -> Sheet:
    """A sheet whose content may change: not a placed component's (read-only until copied)."""
    sheet = _sheet(project, name)
    if sheet.owner:
        raise CommandError(
            f"sheet {name!r} is the equivalent circuit of {sheet.owner}: make a copy to change it"
        )
    return sheet


def _find(sheet: Sheet, object_id: UUID) -> tuple[str, Any]:
    for kind in _KINDS:
        for item in getattr(sheet, kind):
            if item.id == object_id:
                return kind, item
    raise CommandError(f"no object {object_id} on sheet {sheet.name!r}")


_PARAM_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _check_sheet_name(project: Project, name: str, renaming: str | None = None) -> None:
    """Sheet names: not empty, no "/" (it joins sheet and label in net names), unique
    ignoring case (subcircuit names are case-insensitive in SPICE)."""
    if problem := sheet_name_problem(name):
        raise CommandError(problem)
    if any(s.name.lower() == name.lower() and s.name != renaming for s in project.sheets):
        raise CommandError(f"sheet {name!r} already exists")


def _check_ref(project: Project, instance: Instance, ref: str) -> None:
    """References: not empty, no spaces, unique in the project (a component's own parts
    inside its sheets and power symbols "#..." do not count)."""
    if not ref.strip() or any(ch.isspace() for ch in ref):
        raise CommandError(f"reference {ref!r} must be one word")
    if ref.startswith("#"):
        return
    for sheet in project.sheets:
        if sheet.owner:
            continue
        for other in sheet.instances:
            if other.id != instance.id and other.ref.lower() == ref.lower():
                raise CommandError(f"reference {ref} is already used by another part")


def _find_many(sheet: Sheet, ids: list[UUID]) -> list[tuple[str, Any]]:
    """``_find`` for many ids at once (one pass over the sheet: big selections stay fast)."""
    index = {item.id: (kind, item) for kind in _KINDS for item in getattr(sheet, kind)}
    missing = [object_id for object_id in ids if object_id not in index]
    if missing:
        raise CommandError(f"no object {missing[0]} on sheet {sheet.name!r}")
    return [index[object_id] for object_id in ids]


def _sort(sheet: Sheet) -> None:
    # By the id's integer: comparing UUID objects is ~10x slower on big sheets.
    for kind in _KINDS:
        getattr(sheet, kind).sort(key=lambda item: item.id.int)


def _annotate(project: Project, instances: list[Instance]) -> None:
    """Replace ``R?``-style references with the next free number (like KiCad annotation).

    Done when the command is applied, so concurrent clients (GUI, agent) never collide.
    """
    # A placed component's own parts (inside its sheets) do not take the project's numbers.
    used = {inst.ref.lower() for s in project.sheets if not s.owner for inst in s.instances}
    used |= {inst.ref.lower() for inst in instances if not inst.ref.endswith("?")}
    for inst in instances:
        if not inst.ref.endswith("?"):
            continue
        prefix, n = inst.ref[:-1], 1
        while f"{prefix}{n}".lower() in used:
            n += 1
        inst.ref = f"{prefix}{n}"
        used.add(inst.ref.lower())


class AddObjects(_Command):
    """Add objects; instance refs ending in ``?`` are numbered automatically."""

    type: Literal["add_objects"] = "add_objects"
    sheet: str = "root"
    instances: list[Instance] = Field(default_factory=list)
    wires: list[Wire] = Field(default_factory=list)
    junctions: list[Junction] = Field(default_factory=list)
    labels: list[Label] = Field(default_factory=list)
    directives: list[Directive] = Field(default_factory=list)

    def apply(self, project: Project) -> "AnyCommand":
        sheet = _edit_sheet(project, self.sheet)
        existing = {item.id for kind in _KINDS for item in getattr(sheet, kind)}
        ids = [item.id for kind in _KINDS for item in getattr(self, kind)]
        clashes = existing.intersection(ids)
        if clashes or len(set(ids)) != len(ids):
            raise CommandError(f"duplicate object ids: {sorted(map(str, clashes)) or ids}")
        copies = {
            kind: [item.model_copy(deep=True) for item in getattr(self, kind)] for kind in _KINDS
        }
        _annotate(project, copies["instances"])
        for kind in _KINDS:
            getattr(sheet, kind).extend(copies[kind])
        _sort(sheet)
        return RemoveObjects(sheet=self.sheet, ids=ids)


class RemoveObjects(_Command):
    type: Literal["remove_objects"] = "remove_objects"
    sheet: str = "root"
    ids: list[UUID]

    def apply(self, project: Project) -> "AnyCommand":
        sheet = _edit_sheet(project, self.sheet)
        if len(set(self.ids)) != len(self.ids):
            raise CommandError("duplicate ids in remove_objects")
        found = _find_many(sheet, self.ids)  # validate before mutating
        removed: dict[str, list[Any]] = {kind: [] for kind in _KINDS}
        for kind, item in found:
            removed[kind].append(item)
        gone = set(self.ids)
        for kind in _KINDS:
            if removed[kind]:
                setattr(sheet, kind, [item for item in getattr(sheet, kind) if item.id not in gone])
        return AddObjects(
            sheet=self.sheet,
            instances=removed["instances"],
            wires=removed["wires"],
            junctions=removed["junctions"],
            labels=removed["labels"],
            directives=removed["directives"],
        )


class MoveObjects(_Command):
    type: Literal["move_objects"] = "move_objects"
    sheet: str = "root"
    ids: list[UUID]
    dx: int
    dy: int

    def apply(self, project: Project) -> "AnyCommand":
        sheet = _edit_sheet(project, self.sheet)
        items = _find_many(sheet, self.ids)
        for kind, item in items:
            if kind == "wires":
                item.points = [(x + self.dx, y + self.dy) for x, y in item.points]
            else:
                item.at = (item.at[0] + self.dx, item.at[1] + self.dy)
        return MoveObjects(sheet=self.sheet, ids=self.ids, dx=-self.dx, dy=-self.dy)


class UpdateInstance(_Command):
    """Set any of ``ref``, ``symbol``, ``at``, ``rot``, ``mirror``, ``look`` ("" = automatic),
    ``ratings`` and ``texts`` (each replaced as a whole; ``texts`` {} = where the symbol puts
    them)."""

    type: Literal["update_instance"] = "update_instance"
    sheet: str = "root"
    id: UUID
    ref: str | None = None
    symbol: str | None = None
    at: Point | None = None
    rot: Rotation | None = None
    mirror: bool | None = None
    look: str | None = None
    ratings: dict[str, str] | None = None
    texts: dict[str, TextPlace] | None = None

    def apply(self, project: Project) -> "AnyCommand":
        kind, instance = _find(_edit_sheet(project, self.sheet), self.id)
        if kind != "instances":
            raise CommandError(f"{self.id} is not an instance")
        old: dict[str, Any] = {}
        if self.ref is not None and self.ref != instance.ref:
            _check_ref(project, instance, self.ref)
        if self.ratings is not None:
            for key, value in self.ratings.items():
                if value.strip() and (problem := rating_problem(key, value.strip())):
                    raise CommandError(problem)
            old["ratings"] = dict(instance.ratings)
            instance.ratings = {k: v for k, v in self.ratings.items() if v.strip()}
        if self.texts is not None:
            if unknown := set(self.texts) - {"ref", "value"}:
                raise CommandError(f"no text {', '.join(sorted(unknown))} (ref, value)")
            old["texts"] = dict(instance.texts)
            instance.texts = dict(self.texts)
        for field in ("ref", "symbol", "at", "rot", "mirror"):
            value = getattr(self, field)
            if value is not None:
                old[field] = getattr(instance, field)
                setattr(instance, field, value)
        if self.look is not None:
            old["look"] = instance.look or ""
            instance.look = self.look or None
        return UpdateInstance(sheet=self.sheet, id=self.id, **old)


class SetParams(_Command):
    """Set (string) or delete (None) instance parameters.

    ``model`` (model name), ``pins`` (pin map of a subcircuit model) and ``variant`` change only
    when given explicitly (``None`` clears them).
    """

    type: Literal["set_params"] = "set_params"
    sheet: str = "root"
    id: UUID
    params: dict[str, str | None] = Field(default_factory=dict)
    model: str | None = None
    pins: list[str] | None = None
    variant: str | None = None

    def apply(self, project: Project) -> "AnyCommand":
        kind, instance = _find(_edit_sheet(project, self.sheet), self.id)
        if kind != "instances":
            raise CommandError(f"{self.id} is not an instance")
        current = instance.model.params
        old: dict[str, str | None] = {key: current.get(key) for key in self.params}
        for key, value in self.params.items():
            if value is None:
                current.pop(key, None)
            else:
                current[key] = value
        inverse = SetParams(sheet=self.sheet, id=self.id, params=old)
        if "model" in self.model_fields_set:
            inverse.model = instance.model.model
            instance.model.model = self.model
        if "pins" in self.model_fields_set:
            inverse.pins = instance.model.pins
            instance.model.pins = self.pins
        if "variant" in self.model_fields_set:
            inverse.variant = instance.model.variant
            instance.model.variant = self.variant
        return inverse


class SetWirePoints(_Command):
    type: Literal["set_wire_points"] = "set_wire_points"
    sheet: str = "root"
    id: UUID
    points: Annotated[list[Point], Field(min_length=2)]

    def apply(self, project: Project) -> "AnyCommand":
        kind, wire = _find(_edit_sheet(project, self.sheet), self.id)
        if kind != "wires":
            raise CommandError(f"{self.id} is not a wire")
        old = list(wire.points)
        wire.points = list(self.points)
        return SetWirePoints(sheet=self.sheet, id=self.id, points=old)


class UpdateLabel(_Command):
    type: Literal["update_label"] = "update_label"
    sheet: str = "root"
    id: UUID
    text: str | None = None
    kind: LabelKind | None = None
    at: Point | None = None
    rot: Rotation | None = None

    def apply(self, project: Project) -> "AnyCommand":
        kind, label = _find(_edit_sheet(project, self.sheet), self.id)
        if kind != "labels":
            raise CommandError(f"{self.id} is not a label")
        old: dict[str, Any] = {}
        for field in ("text", "kind", "at", "rot"):
            value = getattr(self, field)
            if value is not None:
                old[field] = getattr(label, field)
                setattr(label, field, value)
        return UpdateLabel(sheet=self.sheet, id=self.id, **old)


class UpdateDirective(_Command):
    type: Literal["update_directive"] = "update_directive"
    sheet: str = "root"
    id: UUID
    text: str | None = None
    at: Point | None = None

    def apply(self, project: Project) -> "AnyCommand":
        kind, directive = _find(_edit_sheet(project, self.sheet), self.id)
        if kind != "directives":
            raise CommandError(f"{self.id} is not a directive")
        old: dict[str, Any] = {}
        for field in ("text", "at"):
            value = getattr(self, field)
            if value is not None:
                old[field] = getattr(directive, field)
                setattr(directive, field, value)
        return UpdateDirective(sheet=self.sheet, id=self.id, **old)


class SetParameter(_Command):
    """Set (or delete with None) a project-wide ``.param``, or a block parameter of ``sheet``."""

    type: Literal["set_parameter"] = "set_parameter"
    name: str
    value: str | None
    sheet: str | None = None

    def apply(self, project: Project) -> "AnyCommand":
        params = (
            project.parameters
            if self.sheet is None
            else _edit_sheet(project, self.sheet).parameters
        )
        old = params.get(self.name)
        if self.value is not None and not _PARAM_NAME.match(self.name):
            raise CommandError(f"parameter name {self.name!r}: a letter, then letters, digits, _")
        if self.value is None:
            params.pop(self.name, None)
        else:
            params[self.name] = self.value
        return SetParameter(name=self.name, value=old, sheet=self.sheet)


class SetModel(_Command):
    """Set (or delete with None) a project model card."""

    type: Literal["set_model"] = "set_model"
    name: str
    card: ModelCard | None

    def apply(self, project: Project) -> "AnyCommand":
        old = project.models.get(self.name)
        if self.card is None:
            project.models.pop(self.name, None)
        else:
            project.models[self.name] = self.card.model_copy(deep=True)
        return SetModel(name=self.name, card=old)


class SetSimulation(_Command):
    """Replace the simulation settings (active analysis and its parameters)."""

    type: Literal["set_simulation"] = "set_simulation"
    simulation: Simulation

    def apply(self, project: Project) -> "AnyCommand":
        problem = simulation_problem(self.simulation)
        if problem:
            raise CommandError(problem)
        old = project.simulation
        project.simulation = self.simulation.model_copy(deep=True)
        return SetSimulation(simulation=old)


class SetStressRules(_Command):
    """Replace the stress analysis margins."""

    type: Literal["set_stress_rules"] = "set_stress_rules"
    rules: StressRules

    def apply(self, project: Project) -> "AnyCommand":
        old = project.stress
        project.stress = self.rules.model_copy()
        return SetStressRules(rules=old)


class SetGraph(_Command):
    """Create, replace (``graph``) or delete (``graph=None``) the analysis graph ``name``."""

    type: Literal["set_graph"] = "set_graph"
    name: str
    graph: Graph | None

    def apply(self, project: Project) -> "AnyCommand":
        index = next((i for i, g in enumerate(project.graphs) if g.name == self.name), None)
        old = project.graphs[index] if index is not None else None
        if self.graph is not None and self.graph.name != self.name:
            raise CommandError("set_graph: graph.name must equal name (rename = delete + create)")
        if self.graph is None:
            if index is not None:
                project.graphs.pop(index)
        elif index is None:
            # Saved as graphs/<name>.json, like sheets.
            if problem := sheet_name_problem(self.name):
                raise CommandError(problem.replace("sheet", "graph"))
            if any(g.name.lower() == self.name.lower() for g in project.graphs):
                raise CommandError(f"graph {self.name!r} already exists")
            project.graphs.append(self.graph.model_copy(deep=True))
        else:
            project.graphs[index] = self.graph.model_copy(deep=True)
        return SetGraph(name=self.name, graph=old)


class AddSheet(_Command):
    type: Literal["add_sheet"] = "add_sheet"
    sheet: Sheet
    index: int | None = None

    def apply(self, project: Project) -> "AnyCommand":
        _check_sheet_name(project, self.sheet.name)
        index = len(project.sheets) if self.index is None else self.index
        if not 0 <= index <= len(project.sheets):
            raise CommandError(f"sheet index {index} is outside 0..{len(project.sheets)}")
        project.sheets.insert(index, self.sheet.model_copy(deep=True))
        return RemoveSheet(name=self.sheet.name)


class RemoveSheet(_Command):
    type: Literal["remove_sheet"] = "remove_sheet"
    name: str

    def apply(self, project: Project) -> "AnyCommand":
        sheet = _sheet(project, self.name)
        index = project.sheets.index(sheet)
        project.sheets.remove(sheet)
        return AddSheet(sheet=sheet, index=index)


class RenameSheet(_Command):
    type: Literal["rename_sheet"] = "rename_sheet"
    name: str
    new_name: str

    def apply(self, project: Project) -> "AnyCommand":
        _check_sheet_name(project, self.new_name, renaming=self.name)
        _edit_sheet(project, self.name).name = self.new_name
        # Blocks of this sheet (hierarchy) refer to it by name.
        for sheet in project.sheets:
            for inst in sheet.instances:
                if inst.symbol == f"sheet:{self.name}":
                    inst.symbol = f"sheet:{self.new_name}"
        return RenameSheet(name=self.new_name, new_name=self.name)


class SetPortLayout(_Command):
    """Side and order of the pins of a sheet's block symbol."""

    type: Literal["set_port_layout"] = "set_port_layout"
    sheet: str
    sides: dict[str, PortSide]
    order: list[str]

    def apply(self, project: Project) -> "AnyCommand":
        from bpt.library.blocks import block_symbol

        target = _edit_sheet(project, self.sheet)
        inverse = SetPortLayout(sheet=self.sheet, sides=dict(target.port_sides),
                                order=list(target.port_order))  # fmt: skip
        before = block_symbol(target)
        target.port_sides, target.port_order = dict(self.sides), list(self.order)
        _follow_block_pins(project, self.sheet, before, block_symbol(target))
        return inverse


class SetSheetForm(_Command):
    """The form of a sheet drawn as a template: labels, units, defaults of its parameters."""

    type: Literal["set_sheet_form"] = "set_sheet_form"
    sheet: str
    form: list[TemplateField]

    def apply(self, project: Project) -> "AnyCommand":
        target = _edit_sheet(project, self.sheet)
        inverse = SetSheetForm(sheet=self.sheet, form=list(target.form))
        target.form = list(self.form)
        return inverse


class SetDefaultLook(_Command):
    """The drawing new parts of ``symbol`` get in this project (None: as the settings ask)."""

    type: Literal["set_default_look"] = "set_default_look"
    symbol: str
    look: str | None

    def apply(self, project: Project) -> "AnyCommand":
        old = project.default_looks.get(self.symbol)
        if self.look:
            project.default_looks[self.symbol] = self.look
        else:
            project.default_looks.pop(self.symbol, None)
        return SetDefaultLook(symbol=self.symbol, look=old)


class SetSymbolStandard(_Command):
    """IEC or ANSI drawings for this project's parts without a look of their own (None: as the
    program's setting)."""

    type: Literal["set_symbol_standard"] = "set_symbol_standard"
    standard: Literal["iec", "ansi"] | None

    def apply(self, project: Project) -> "AnyCommand":
        old = project.symbol_standard
        project.symbol_standard = self.standard
        return SetSymbolStandard(standard=old)


class DetachComponent(_Command):
    """Make a placed component's sheets ordinary, editable block sheets ("Make a copy")."""

    type: Literal["detach_component"] = "detach_component"
    owner: str  # the component id

    def apply(self, project: Project) -> "AnyCommand":
        sheets = [s for s in project.sheets if s.owner == self.owner]
        if not sheets:
            raise CommandError(f"no sheets of component {self.owner}")
        tops = {s.name: s.component for s in sheets if s.component}
        inverse = AttachComponent(owner=self.owner, sheets=[s.name for s in sheets], component=tops)
        for s in sheets:
            if s.component is not None and s.component.id != self.owner:
                s.owner = s.component.id  # a part inside (an IC in a module) stays that part
            else:
                s.owner, s.component = None, None
        return inverse


class AttachComponent(_Command):
    """Undo of ``detach_component``: the sheets belong to the component again."""

    type: Literal["attach_component"] = "attach_component"
    owner: str
    sheets: list[str]
    component: dict[str, ComponentInfo] = Field(default_factory=dict)  # top sheet -> info

    def apply(self, project: Project) -> "AnyCommand":
        for name in self.sheets:
            sheet = _sheet(project, name)
            sheet.owner, sheet.component = self.owner, self.component.get(name)
        return DetachComponent(owner=self.owner)


class SetSheetSymbol(_Command):
    """Draw the block symbol of a sheet (pin numbers = port names) or (None) go automatic."""

    type: Literal["set_sheet_symbol"] = "set_sheet_symbol"
    sheet: str
    symbol: Symbol | None

    def apply(self, project: Project) -> "AnyCommand":
        from bpt.library.blocks import block_symbol

        target = _edit_sheet(project, self.sheet)
        inverse = SetSheetSymbol(sheet=self.sheet, symbol=target.symbol)
        before = block_symbol(target)
        target.symbol = self.symbol
        _follow_block_pins(project, self.sheet, before, block_symbol(target))
        return inverse


def _follow_block_pins(project: Project, name: str, before: Symbol | None,
                       after: Symbol | None) -> None:  # fmt: skip
    """Labels and wire ends on a pin of a placed block follow the pin to its new place."""
    from bpt.library.blocks import PREFIX
    from bpt.netlist.connectivity import transform

    if before is None or after is None:
        return
    moved_to = {p.number: p.at for p in after.pins}
    for sheet in project.sheets:
        for block in (i for i in sheet.instances if i.symbol == f"{PREFIX}{name}"):
            moves = {transform(p.at, block): transform(moved_to[p.number], block)
                     for p in before.pins if p.number in moved_to}  # fmt: skip
            for label in sheet.labels:
                label.at = moves.get(label.at, label.at)
            for wire in sheet.wires:
                ends = [moves.get(wire.points[0], wire.points[0]),
                        moves.get(wire.points[-1], wire.points[-1])]  # fmt: skip
                wire.points = [ends[0], *wire.points[1:-1], ends[1]]


class SetSubcircuit(_Command):
    """Add, replace or (with None) remove a subcircuit model of the project."""

    type: Literal["set_subcircuit"] = "set_subcircuit"
    name: str
    subckt: SubcktModel | None

    def apply(self, project: Project) -> "AnyCommand":
        old = project.subcircuits.get(self.name)
        if self.subckt is None:
            project.subcircuits.pop(self.name, None)
        else:
            project.subcircuits[self.name] = self.subckt
        return SetSubcircuit(name=self.name, subckt=old)


class SetProjectLook(_Command):
    """Keep (or with None drop) a copy of a user drawing for ``symbol`` in the project."""

    type: Literal["set_project_look"] = "set_project_look"
    symbol: str
    name: str
    look: Look | None

    def apply(self, project: Project) -> "AnyCommand":
        looks = project.looks.get(self.symbol, [])
        old = next((lk for lk in looks if lk.name == self.name), None)
        kept = [lk for lk in looks if lk.name != self.name] + ([self.look] if self.look else [])
        if kept:
            project.looks[self.symbol] = kept
        else:
            project.looks.pop(self.symbol, None)
        return SetProjectLook(symbol=self.symbol, name=self.name, look=old)


class SetSymbolLink(_Command):
    """Use a library symbol by reference (follows the library) or as a plain copy."""

    type: Literal["set_symbol_link"] = "set_symbol_link"
    id: str
    linked: bool

    def apply(self, project: Project) -> "AnyCommand":
        was = self.id in project.linked
        project.linked = [i for i in project.linked if i != self.id]
        if self.linked:
            project.linked = sorted([*project.linked, self.id])
        return SetSymbolLink(id=self.id, linked=was)


class SetSymbol(_Command):
    """Add, replace or (with None) remove the project's copy of a library symbol."""

    type: Literal["set_symbol"] = "set_symbol"
    id: str
    symbol: Symbol | None

    def apply(self, project: Project) -> "AnyCommand":
        if self.symbol is not None and self.symbol.id != self.id:
            raise CommandError(f"symbol id {self.symbol.id!r} does not match {self.id!r}")
        old = project.symbols.get(self.id)
        if self.symbol is None:
            project.symbols.pop(self.id, None)
        else:
            project.symbols[self.id] = self.symbol
        return SetSymbol(id=self.id, symbol=old)


class RestoreProject(_Command):
    """Replace the whole content of the project (going back to a snapshot); keeps its id."""

    type: Literal["restore_project"] = "restore_project"
    label: str = ""
    project: Project

    def apply(self, project: Project) -> "AnyCommand":
        old = project.model_copy(deep=True)
        fresh = self.project.model_copy(deep=True)
        for name in Project.model_fields:
            if name != "id":
                setattr(project, name, getattr(fresh, name))
        return RestoreProject(label=self.label, project=old)


class Transaction(_Command):
    """Several commands applied atomically as one undo step."""

    type: Literal["transaction"] = "transaction"
    label: str = ""
    commands: list["AnyCommand"]

    def apply(self, project: Project) -> "AnyCommand":
        inverses: list[AnyCommand] = []
        try:
            for command in self.commands:
                inverses.append(command.apply(project))
        except Exception:  # a refused command or a bug: leave the project as it was
            for inverse in reversed(inverses):
                inverse.apply(project)
            raise
        return Transaction(label=self.label, commands=list(reversed(inverses)))


AnyCommand = Annotated[
    AddObjects
    | RemoveObjects
    | MoveObjects
    | UpdateInstance
    | SetParams
    | SetWirePoints
    | UpdateLabel
    | UpdateDirective
    | SetParameter
    | SetModel
    | SetSimulation
    | SetGraph
    | AddSheet
    | RemoveSheet
    | RenameSheet
    | SetSymbol
    | SetSymbolLink
    | SetProjectLook
    | SetStressRules
    | SetSubcircuit
    | SetPortLayout
    | SetSheetForm
    | SetDefaultLook
    | SetSymbolStandard
    | SetSheetSymbol
    | DetachComponent
    | AttachComponent
    | RestoreProject
    | Transaction,
    Field(discriminator="type"),
]
Transaction.model_rebuild()
