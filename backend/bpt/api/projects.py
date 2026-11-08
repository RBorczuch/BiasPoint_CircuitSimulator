"""Project endpoints: lifecycle, document, commands, circuit-level helpers."""

from pathlib import Path
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field

from bpt.api.security import attachment
from bpt.api.state import AppState, OpenProject
from bpt.document.builder import (
    BuildError,
    add_component,
    connect_pins,
    describe,
    import_netlist,
    remove_component,
    set_component,
)
from bpt.document.commands import AnyCommand, CommandError, RestoreProject
from bpt.document.model import Instance, Point, Project, Sheet
from bpt.document.snapshots import SnapshotInfo
from bpt.library.symbols import Symbol
from bpt.netlist.netlister import netlist_project
from bpt.netlist.ngspice_writer import write_netlist
from bpt.netlist.spice_parser import SpiceSyntaxError, parse_netlist

router = APIRouter(prefix="/api/projects", tags=["projects"])


def get_state(request: Request) -> AppState:
    state: AppState = request.app.state.bpt
    return state


State = Annotated[AppState, Depends(get_state)]


class ProjectInfo(BaseModel):
    id: str
    name: str
    path: str | None
    revision: int
    dirty: bool
    can_undo: bool
    can_redo: bool


def _info(p: OpenProject) -> ProjectInfo:
    return ProjectInfo(
        id=p.id,
        name=p.session.project.name,
        path=str(p.path) if p.path else None,
        revision=p.session.revision,
        dirty=p.dirty,
        can_undo=p.session.can_undo,
        can_redo=p.session.can_redo,
    )


def _project(state: AppState, project_id: str) -> OpenProject:
    try:
        return state.get(project_id)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc


def _execute(p: OpenProject, command: AnyCommand) -> int:
    try:
        return p.session.execute(command)
    except (CommandError, BuildError, KeyError) as exc:
        raise HTTPException(409, str(exc)) from exc


class NewProject(BaseModel):
    name: str = "untitled"


class PathBody(BaseModel):
    path: str


class SaveBody(BaseModel):
    path: str | None = None


@router.get("")
def list_projects(state: State) -> list[ProjectInfo]:
    return [_info(p) for p in state.projects.values()]


@router.post("")
def new_project(body: NewProject, state: State) -> ProjectInfo:
    return _info(state.new_project(body.name))


def _os_reason(exc: OSError) -> str:
    """Short English reason for a file error (the OS text may be localized, e.g. Polish)."""
    if isinstance(exc, FileNotFoundError):
        return "the folder does not exist"
    if isinstance(exc, PermissionError):
        return "no permission to write there"
    if getattr(exc, "winerror", None) == 123 or exc.errno == 22:
        return "the name or path contains characters that are not allowed"
    return exc.strerror or str(exc)


@router.post("/open")
def open_project(body: PathBody, state: State) -> ProjectInfo:
    try:
        return _info(state.open_project(Path(body.path)))
    except ValueError as exc:
        raise HTTPException(400, f"cannot open {body.path}: {exc}") from exc
    except OSError as exc:
        raise HTTPException(400, f"cannot open {body.path}: {_os_reason(exc)}") from exc


class SchematicImported(BaseModel):
    project: ProjectInfo
    skipped: list[str]  # what was not brought over, and why


@router.post("/import/kicad")
def import_kicad_schematic(body: PathBody, state: State) -> SchematicImported:
    """Open a KiCad schematic (.kicad_sch) and the sheets it uses as a new, unsaved project."""
    from bpt.library.kicad_sch import import_schematic
    from bpt.library.sexpr import SExprError

    path = Path(body.path).expanduser()
    if not path.is_file():
        raise HTTPException(404, f"{path} does not exist")
    try:
        result = import_schematic(path)
    except (OSError, UnicodeDecodeError, SExprError, ValueError) as exc:
        raise HTTPException(422, f"cannot read {path.name}: {exc}") from exc
    opened = state.register(result.project, None)
    opened.saved_revision = -1  # new: nothing saved yet
    return SchematicImported(project=_info(opened), skipped=result.skipped[:50])


@router.post("/{project_id}/save")
def save(project_id: str, body: SaveBody, state: State) -> ProjectInfo:
    _project(state, project_id)
    try:
        return _info(state.save_project(project_id, Path(body.path) if body.path else None))
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except OSError as exc:
        raise HTTPException(400, f"cannot save to {body.path}: {_os_reason(exc)}") from exc


@router.delete("/{project_id}")
def close(project_id: str, state: State) -> None:
    state.close_project(project_id)


class Document(BaseModel):
    revision: int
    project: Project | None  # None when the client is already up to date


@router.get("/{project_id}/document")
def document(project_id: str, state: State, since: int | None = None) -> Document:
    p = _project(state, project_id)
    if since is not None and since == p.session.revision:
        return Document(revision=since, project=None)
    return Document(revision=p.session.revision, project=p.session.project)


class CommandBody(BaseModel):
    command: AnyCommand


class Revision(BaseModel):
    revision: int


@router.post("/{project_id}/commands")
def execute(project_id: str, body: CommandBody, state: State) -> Revision:
    return Revision(revision=_execute(_project(state, project_id), body.command))


@router.post("/{project_id}/undo")
def undo(project_id: str, state: State, to: int | None = None) -> Revision:
    """One step back, or (``to``) back or forward until ``to`` steps are applied."""
    p = _project(state, project_id)
    try:
        return Revision(revision=p.session.undo() if to is None else p.session.go_to(to))
    except CommandError as exc:
        raise HTTPException(409, str(exc)) from exc


class HistoryStep(BaseModel):
    label: str
    origin: str  # "user" | "agent"
    time: float


class History(BaseModel):
    done: list[HistoryStep]  # applied, oldest first
    undone: list[HistoryStep]  # can be redone, next first


@router.get("/{project_id}/history")
def history(project_id: str, state: State) -> History:
    done, undone = _project(state, project_id).session.history()
    return History(
        done=[HistoryStep(label=s.label, origin=s.origin, time=s.time) for s in done],
        undone=[HistoryStep(label=s.label, origin=s.origin, time=s.time) for s in undone],
    )


@router.post("/{project_id}/redo")
def redo(project_id: str, state: State) -> Revision:
    p = _project(state, project_id)
    try:
        return Revision(revision=p.session.redo())
    except CommandError as exc:
        raise HTTPException(409, str(exc)) from exc


# -- library components (FR-CMP) ------------------------------------------------------


class ComponentPlacement(BaseModel):
    top: str  # sheet to place as a block: sheet:<top>
    sheets: list[Sheet]  # to add first (add_sheet), in the same undo step as the part


class ComponentRef(BaseModel):
    id: str


@router.post("/{project_id}/components/prepare")
def prepare_component(project_id: str, body: ComponentRef, state: State) -> ComponentPlacement:
    """What placing a library component needs: its sheets with names free in the project."""
    from bpt.library import libraries
    from bpt.library.components import component_sheets

    component = libraries.all_components().get(body.id)
    if component is None:
        raise HTTPException(404, f"no component {body.id}")
    top, sheets = component_sheets(_project(state, project_id).session.project, component)
    return ComponentPlacement(top=top, sheets=sheets)


# -- probes (FR-SCH-9) ---------------------------------------------------------------


class Probe(BaseModel):
    ref: str
    kind: Literal["v", "vd", "i"]
    signal: str  # expression in the results: V(out), V(a)-V(b), I(IP1)
    sheet: str


@router.get("/{project_id}/probes")
def probes(project_id: str, state: State) -> list[Probe]:
    """Probes on the top-level sheets with the signal each one measures."""
    from bpt.netlist.probes import probe_signals

    found = probe_signals(_project(state, project_id).session.project)
    return [Probe(ref=p.ref, kind=p.kind, signal=p.signal, sheet=p.sheet) for p in found.values()]


# -- library parts: copies of library symbols, their versions and updates (FR-LIB-3) ---


class LibraryPart(BaseModel):
    id: str
    name: str
    library: str
    version: int  # of the project's copy
    library_version: int | None  # None: no longer in any library
    updated: str  # date of the library version
    changes: str  # what changed in the library version
    linked: bool  # follows the library (reference) instead of a plain copy
    used: int  # parts placed in the project


@router.get("/{project_id}/library-parts")
def library_parts(project_id: str, state: State) -> list[LibraryPart]:
    from bpt.library import libraries

    project = _project(state, project_id).session.project
    library = libraries.all_symbols()
    used: dict[str, int] = {}
    for sheet in project.sheets:
        for inst in sheet.instances:
            used[inst.symbol] = used.get(inst.symbol, 0) + 1
    out = []
    for sid, copy in sorted(project.symbols.items()):
        source = library.get(sid)
        out.append(LibraryPart(
            id=sid, name=copy.name, library=copy.category, version=copy.version,
            library_version=source.version if source else None,
            updated=(source or copy).updated, changes=source.changes if source else "",
            linked=sid in project.linked, used=used.get(sid, 0),
        ))  # fmt: skip
    return out


class PartIds(BaseModel):
    ids: list[str]


@router.post("/{project_id}/library-parts/update")
def update_library_parts(project_id: str, body: PartIds, state: State) -> Revision:
    """Replace the project's copies by the library versions (with their models): one undo step."""
    from bpt.document.commands import SetModel, SetSubcircuit, SetSymbol, Transaction
    from bpt.library import libraries

    p = _project(state, project_id)
    library = libraries.all_symbols()
    cards, subckts = libraries.all_models()
    commands: list[AnyCommand] = []
    for sid in body.ids:
        source = library.get(sid)
        if source is None or sid not in p.session.project.symbols:
            raise HTTPException(404, f"{sid} is not a library part of this project")
        commands.append(SetSymbol(id=sid, symbol=source))
        model = source.default_model
        if model and model in cards:
            commands.append(SetModel(name=model, card=cards[model]))
        if model and model in subckts:
            commands.append(SetSubcircuit(name=model, subckt=subckts[model]))
    label = f"update {len(body.ids)} library part(s)"
    return Revision(revision=_execute(p, Transaction(label=label, commands=commands)))


class PlacedComponent(BaseModel):
    id: str
    name: str
    sheet: str  # its top sheet in the project
    version: int  # of the project's copy
    library_version: int | None  # None: no longer in any library
    changes: str  # what changed in the library version
    used: int  # parts placed in the project


def _placed_components(project: Project) -> list[PlacedComponent]:
    """Library components the project holds a copy of (top sheets), with their use."""
    from bpt.library import libraries
    from bpt.library.blocks import PREFIX

    library = libraries.all_components()
    used: dict[str, int] = {}
    for sheet in project.sheets:
        for inst in sheet.instances:
            if inst.symbol.startswith(PREFIX):
                name = inst.symbol[len(PREFIX) :]
                used[name] = used.get(name, 0) + 1
    out = []
    for sheet in project.sheets:
        info = sheet.component
        if info is None or sheet.owner != info.id:  # not a part inside another one
            continue
        source = library.get(info.id)
        out.append(PlacedComponent(
            id=info.id, name=info.name, sheet=sheet.name, version=info.version,
            library_version=source.version if source else None,
            changes=source.changes if source else "", used=used.get(sheet.name, 0),
        ))  # fmt: skip
    return out


@router.get("/{project_id}/components")
def placed_components(project_id: str, state: State) -> list[PlacedComponent]:
    return _placed_components(_project(state, project_id).session.project)


@router.post("/{project_id}/components/update")
def update_components(project_id: str, body: PartIds, state: State) -> Revision:
    """Put the library version of components in place of the project's copies: their parts
    keep place, reference and values, the old sheets go (one undo step)."""
    from bpt.document.commands import AddSheet, RemoveSheet, Transaction, UpdateInstance
    from bpt.library import libraries
    from bpt.library.blocks import PREFIX
    from bpt.library.components import component_sheets

    p = _project(state, project_id)
    project = p.session.project
    library = libraries.all_components()
    commands: list[AnyCommand] = []
    for cid in body.ids:
        component = library.get(cid)
        if component is None:
            raise HTTPException(404, f"{cid} is not in any library")
        old = [s for s in project.sheets if s.owner == cid]
        tops = {s.name for s in old if s.component is not None and s.component.id == cid}
        if not tops:
            raise HTTPException(404, f"{cid} is not placed in this project")
        # Names as if the old sheets were gone (they are removed first).
        without = project.model_copy(update={"sheets": [s for s in project.sheets
                                                        if s.owner != cid]})  # fmt: skip
        top, sheets = component_sheets(without, component)
        # The old sheets go first: the new ones may take their names.
        commands += [RemoveSheet(name=s.name) for s in old]
        commands += [AddSheet(sheet=s) for s in sheets]
        for sheet in project.sheets:
            if sheet.owner == cid:
                continue
            for inst in sheet.instances:
                if inst.symbol.startswith(PREFIX) and inst.symbol[len(PREFIX) :] in tops:
                    commands.append(UpdateInstance(sheet=sheet.name, id=inst.id,
                                                   symbol=f"{PREFIX}{top}"))  # fmt: skip
    label = f"update {len(body.ids)} library part(s)"
    return Revision(revision=_execute(p, Transaction(label=label, commands=commands)))


class TemplateRef(BaseModel):
    # a built-in template ("mlcc"), "tpl:<library>/<name>" or a part's circuit "cmp:<lib>/<name>"
    template: str
    # A new template based on it (a free name "… (copy)"), not the template itself to change.
    as_new: bool = False
    # Values to start from instead of the defaults (the part editor's form).
    form: dict[str, str] = Field(default_factory=dict)


class OpenedTemplate(BaseModel):
    sheet: str  # the top sheet of the copy
    sheets: list[str] = Field(default_factory=list)  # all the sheets added for the editing
    revision: int
    name: str  # the template's name and library (to save it back)
    library: str
    kind: str
    category: str
    description: str
    editing: str = ""  # the template changed in place ("" = a new one is made)
    version: int = 0  # its version now (the next save is version + 1)
    based_on: str = ""  # what a new one starts from (shown to the user)


@router.post("/{project_id}/templates/open")
def open_template(project_id: str, body: TemplateRef, state: State) -> OpenedTemplate:
    """A template as sheets of the project to edit (template editor): a user template's own
    sheets (changed in place, or with ``as_new`` a new template based on it), a built-in one drawn
    from its formulas or a part's circuit (always a new template). ``form`` values replace the
    defaults. One undo step; the top sheet carries the template's form."""
    from bpt.api.library import part_fields
    from bpt.document.commands import AddSheet, Transaction
    from bpt.document.ids import new_id
    from bpt.document.model import TemplateField, safe_sheet_name
    from bpt.library import libraries
    from bpt.library.categories import component_category, template_category
    from bpt.models import templates as tpl

    p = _project(state, project_id)
    project = p.session.project
    given = {k: v.strip() for k, v in body.form.items() if v.strip()}
    editing, version, copy = "", 0, body.as_new
    if body.template.startswith("tpl:"):
        user = libraries.all_templates().get(body.template)
        if user is None:
            raise HTTPException(404, f"no template {body.template}")
        sheets, fields = [s.model_copy(deep=True) for s in user.sheets], user.fields
        name, kind, description = user.name, user.kind, user.description
        library = user.id.removeprefix("tpl:").split("/")[0]
        category = user.category or component_category("", user.id, user.kind)
        if library.startswith("Standard"):  # read-only: saved as a copy in the user's library
            library, copy = "My templates", True
        if not copy:
            editing, version = user.id, user.version
    elif body.template.startswith("cmp:"):  # a part's circuit: its values as the defaults
        part = libraries.all_components().get(body.template)
        if part is None:
            raise HTTPException(404, f"no library part {body.template}")
        sheets = [s.model_copy(deep=True) for s in part.sheets]
        fields, copy = part_fields(part), True
        name, kind, description = part.name, part.kind, part.description
        library = "My templates"
        category = part.category or component_category("", part.id, part.kind)
    else:
        try:
            builtin = tpl.get(body.template)
        except KeyError as exc:
            raise HTTPException(404, f"no template {body.template}") from exc
        form = {f.key: f.default for f in builtin.fields if f.default} | {
            k: v for k, v in given.items() if any(f.key == k for f in builtin.fields)}  # fmt: skip
        sheets = [tpl.build_sheet(builtin, form, builtin.label)]
        fields = [TemplateField(key=f.key, label=f.label, unit=f.unit, default=f.default,
                                description=f.description, required=f.required, group=f.group)
                  for f in builtin.fields if f.key in sheets[0].parameters]  # fmt: skip
        name, kind, description, copy = builtin.label, builtin.kind, builtin.description, True
        library, category = "My templates", template_category(builtin.name)
    based_on = name if copy else ""
    if copy:  # a free name in the library it goes to
        try:
            in_library = {t.name.lower() for t in libraries.load(library).templates}
        except OSError:
            in_library = set()
        base, n = f"{name} (copy)", 2
        name = base
        while name.lower() in in_library:
            name, n = f"{base[:-1]} {n})", n + 1
    # The form's values on the top sheet (the part editor's, to start from what is typed).
    top = sheets[0]
    sheets[0] = top.model_copy(update={"parameters": top.parameters | {
        k: v for k, v in given.items() if k in top.parameters}})  # fmt: skip
    # Free names for the copy; references between its sheets follow.
    taken = {s.name.lower() for s in project.sheets}
    names: dict[str, str] = {}
    for sheet in sheets:
        base, n = safe_sheet_name(sheet.name)[:40], 2
        new = base
        while new.lower() in taken:
            new, n = f"{base[:36]}~{n}", n + 1
        taken.add(new.lower())
        names[sheet.name] = new
    copies = []
    for i, sheet in enumerate(sheets):
        instances = [
            inst.model_copy(update={"symbol": f"sheet:{names[inst.symbol[6:]]}"})
            if inst.symbol.startswith("sheet:") and inst.symbol[6:] in names else inst
            for inst in sheet.instances
        ]  # fmt: skip
        copies.append(sheet.model_copy(update={
            "id": new_id(), "name": names[sheet.name], "instances": instances,
            "owner": None, "component": None,
            "form": list(fields) if i == 0 else [],
        }))  # fmt: skip
    revision = _execute(p, Transaction(label=f"open template {name}",
                                       commands=[AddSheet(sheet=s) for s in copies]))  # fmt: skip
    return OpenedTemplate(sheet=copies[0].name, sheets=[s.name for s in copies],
                          revision=revision, name=name, library=library,
                          kind=kind, category=category, description=description,
                          editing=editing, version=version, based_on=based_on)  # fmt: skip


class FlattenBody(BaseModel):
    sheet: str  # where the block is
    id: str  # the block (an instance of a sheet)


def _substitute(text: str, values: dict[str, str]) -> str:
    """A value with the block's parameters written in: {2*R} with R=1k -> {2*(1k)}."""
    import re

    if not values or "{" not in text:
        return text

    def inner(match: re.Match[str]) -> str:
        expr = match.group(1)
        for name, value in values.items():
            expr = re.sub(rf"\b{re.escape(name)}\b", f"({value})", expr)
        return "{" + expr + "}"

    return re.sub(r"\{([^}]*)\}", inner, text)


@router.post("/{project_id}/flatten")
def flatten_block(project_id: str, body: FlattenBody, state: State) -> Revision:
    """Put a block's circuit in its place (one undo step): its parts, wires and labels copied
    beside where it was, its ports turned into labels that join the nets on the block's pins,
    its parameters written into the values. The sheet stays (other blocks may use it)."""
    from bpt.document.commands import AddObjects, RemoveObjects, Transaction
    from bpt.document.ids import new_id
    from bpt.document.model import Directive, Junction, Label, Wire
    from bpt.library.blocks import PREFIX, project_symbols
    from bpt.netlist.connectivity import transform

    p = _project(state, project_id)
    project = p.session.project
    try:
        parent = project.sheet(body.sheet)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    block = next((i for i in parent.instances if str(i.id) == body.id), None)
    if block is None or not block.symbol.startswith(PREFIX):
        raise HTTPException(422, "choose a block (a part that is a sheet) to flatten")
    inner = project.sheet(block.symbol[len(PREFIX) :])
    symbols = project_symbols(project)
    values = {**inner.parameters, **{k: v for k, v in block.model.params.items() if v.strip()}}
    tag = block.ref.replace("?", "")
    # Where the copy goes: its top left corner just right of the block.
    points = ([i.at for i in inner.instances] + [q for w in inner.wires for q in w.points]
              + [lb.at for lb in inner.labels])  # fmt: skip
    if not points:
        raise HTTPException(422, f"{inner.name} is empty")
    x0, y0 = min(q[0] for q in points), min(q[1] for q in points)
    dx, dy = block.at[0] + 8 * 127 - x0, block.at[1] - y0

    def move(q: Point) -> Point:
        return (q[0] + dx, q[1] + dy)

    instances = []
    for inst in inner.instances:
        symbol = symbols.get(inst.symbol)
        prefix = symbol.ref_prefix if symbol else inst.ref.rstrip("0123456789")
        params = {k: _substitute(v, values) for k, v in inst.model.params.items()}
        model = inst.model.model_copy(update={"params": params})
        ref = prefix if prefix.startswith("#") else f"{prefix}?"
        instances.append(inst.model_copy(update={"id": new_id(), "ref": ref, "at": move(inst.at),
                                                 "model": model}))  # fmt: skip
    labels = []
    for lb in inner.labels:
        if lb.kind == "global":
            labels.append(lb.model_copy(update={"id": new_id(), "at": move(lb.at)}))
        else:  # a port or a local net of the block: local here, named after the block
            labels.append(Label(kind="local", text=f"{tag}_{lb.text}", at=move(lb.at),
                                rot=lb.rot))  # fmt: skip
    # The block's pins: a label each, on the nets the block was wired to.
    block_symbol = symbols.get(block.symbol)
    if block_symbol is not None:
        for pin in block_symbol.pins:
            number, at = pin.number, transform(pin.at, block)
            labels.append(Label(kind="local", text=f"{tag}_{number}", at=at))
    wires = [Wire(points=[move(q) for q in w.points], bus=w.bus) for w in inner.wires]
    junctions = [Junction(at=move(j.at)) for j in inner.junctions]
    directives = [Directive(text=_substitute(d.text, values), at=move(d.at))
                  for d in inner.directives]  # fmt: skip
    commands: list[AnyCommand] = [
        RemoveObjects(sheet=parent.name, ids=[block.id]),
        AddObjects(sheet=parent.name, instances=instances, wires=wires, labels=labels,
                   junctions=junctions, directives=directives),
    ]  # fmt: skip
    label = f"flatten {block.ref}"
    return Revision(revision=_execute(p, Transaction(label=label, commands=commands)))


class LinkBody(BaseModel):
    id: str
    linked: bool


@router.post("/{project_id}/library-parts/link")
def link_library_part(project_id: str, body: LinkBody, state: State) -> Revision:
    from bpt.document.commands import SetSymbolLink

    p = _project(state, project_id)
    if body.id not in p.session.project.symbols:
        raise HTTPException(404, f"{body.id} is not a library part of this project")
    return Revision(revision=_execute(p, SetSymbolLink(id=body.id, linked=body.linked)))


# -- snapshots ------------------------------------------------------------------------


class SnapshotBody(BaseModel):
    label: str = "Snapshot"


@router.get("/{project_id}/snapshots")
def snapshots(project_id: str, state: State) -> list[SnapshotInfo]:
    """Newest first; those of origin "agent" were taken before an AI agent changed the project."""
    _project(state, project_id)
    return state.snapshots.list(project_id)


@router.post("/{project_id}/snapshots")
def take_snapshot(project_id: str, body: SnapshotBody, state: State) -> SnapshotInfo:
    p = _project(state, project_id)
    revision, copy = p.session.snapshot()
    return state.snapshots.take(copy, revision, body.label.strip() or "Snapshot", "user")


@router.post("/{project_id}/snapshots/{snapshot_id}/restore")
def restore_snapshot(project_id: str, snapshot_id: str, state: State) -> Revision:
    """Go back to a snapshot (one undo step brings the current state back)."""
    p = _project(state, project_id)
    try:
        project = state.snapshots.load(project_id, snapshot_id)
    except (OSError, ValueError) as exc:
        raise HTTPException(404, f"no snapshot {snapshot_id}") from exc
    label = next((s.label for s in state.snapshots.list(project_id) if s.id == snapshot_id), "")
    return Revision(revision=_execute(p, RestoreProject(label=label, project=project)))


@router.delete("/{project_id}/snapshots/{snapshot_id}")
def delete_snapshot(project_id: str, snapshot_id: str, state: State) -> None:
    _project(state, project_id)
    try:
        state.snapshots.delete(project_id, snapshot_id)
    except ValueError as exc:
        raise HTTPException(404, f"no snapshot {snapshot_id}") from exc


# -- circuit-level helpers (used by MCP and the command line) ---------------------------


class Text(BaseModel):
    text: str


class Netlist(BaseModel):
    lines: list[str]
    issues: list[dict[str, object]]


@router.get("/{project_id}/circuit/describe")
def circuit_describe(project_id: str, state: State) -> Text:
    return Text(text=describe(_project(state, project_id).session.project))


@router.get("/{project_id}/circuit/netlist")
def circuit_netlist(project_id: str, state: State) -> Netlist:
    result = netlist_project(_project(state, project_id).session.project)
    return Netlist(
        lines=write_netlist(result.circuit),
        issues=[{"severity": i.severity, "code": i.code, "message": i.message, "refs": i.refs}
                for i in result.issues],
    )  # fmt: skip


class SheetNets(BaseModel):
    wires: dict[str, str]
    labels: dict[str, str]
    pins: dict[str, str]  # "<instance id>:<pin number>" -> net


@router.get("/{project_id}/circuit/nets")
def circuit_nets(
    project_id: str, state: State, sheet: str = "root", path: str | None = None
) -> SheetNets:
    """Net of every wire, label and pin on a sheet (probes, operating point overlay).

    Names are those of the simulation results: on a sheet used as a block they are seen
    through one of its instances, ``path`` (``X2`` or ``X2.X1``; default: the first use),
    e.g. ``X2.mid``; a net on a port has the name outside (``vin``).
    """
    project = _project(state, project_id).session.project
    try:
        target = project.sheet(sheet)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    item_net, pin_net = sheet_net_names(project, target, path.split(".") if path else None)
    wire_ids = {w.id for w in target.wires}
    label_ids = {lbl.id for lbl in target.labels}
    return SheetNets(
        wires={str(k): v for k, v in item_net.items() if k in wire_ids},
        labels={str(k): v for k, v in item_net.items() if k in label_ids},
        pins={f"{iid}:{pin}": v for (iid, pin), v in pin_net.items()},
    )


def sheet_net_names(
    project: Project, sheet: Sheet, path: list[str] | None = None, depth: int = 0
) -> tuple[dict[UUID, str], dict[tuple[UUID, str], str]]:
    """(wire/label id -> net, (instance id, pin) -> net) of one sheet, as results name them."""
    from bpt.library.blocks import PREFIX, ports, project_symbols
    from bpt.netlist.connectivity import resolve_nets

    symbols = project_symbols(project)
    blocks = {
        i.symbol[len(PREFIX) :]
        for s in project.sheets
        for i in s.instances
        if i.symbol.startswith(PREFIX)
    }
    inst_ids = {i.id for i in sheet.instances}
    if sheet.name not in blocks or depth > 10:
        top = project.model_copy(
            update={"sheets": [s for s in project.sheets if s.name not in blocks]}
        )
        nets = resolve_nets(top if sheet.name not in blocks else project, symbols)
        pins = {k: v for k, v in nets.pin_net.items() if k[0] in inst_ids}
        return dict(nets.item_net), pins
    # A block sheet: its own nets, named through the chosen block (or the first one using it).
    chain = _resolve_path(project, path) if path else None
    if chain and chain[-1][1].symbol == f"{PREFIX}{sheet.name}" and path:
        parent, block = chain[-1]
        prefix = ".".join(path)
        _outer_items, outer_pins = sheet_net_names(project, parent, path[:-1] or None, depth + 1)
    else:
        parent, block = next(
            (s, i)
            for s in project.sheets
            for i in s.instances
            if i.symbol == f"{PREFIX}{sheet.name}"
        )
        prefix = _block_path(project, sheet.name, depth)
        _outer_items, outer_pins = sheet_net_names(project, parent, None, depth + 1)
    inner = resolve_nets(project.model_copy(update={"sheets": [sheet]}), symbols)
    port_net = {
        inner.item_net[label.id]: outer_pins.get((block.id, label.text))
        for label in sheet.labels
        if label.kind == "port" and label.id in inner.item_net
    }
    for name, _side in ports(sheet):  # members of bus ports: the nets of their names
        if name in inner.members and name not in port_net:
            port_net[name] = outer_pins.get((block.id, name))

    def outside(net: str) -> str:
        mapped = port_net.get(net)
        return mapped if mapped else ("0" if net == "0" else f"{prefix}.{net}")

    items = {k: outside(v) for k, v in inner.item_net.items()}
    pins = {k: outside(v) for k, v in inner.pin_net.items() if k[0] in inst_ids}
    return items, pins


def _resolve_path(project: Project, path: list[str]) -> list[tuple[Sheet, Instance]] | None:
    """Blocks along an instance path from the top ("X2", "X1"): [(sheet holding it, block)]."""
    from bpt.library.blocks import PREFIX

    used = {i.symbol[len(PREFIX) :] for s in project.sheets for i in s.instances
            if i.symbol.startswith(PREFIX)}  # fmt: skip
    candidates = [s for s in project.sheets if s.name not in used]
    chain: list[tuple[Sheet, Instance]] = []
    for ref in path:
        found = next(((s, i) for s in candidates for i in s.instances
                      if i.ref == ref and i.symbol.startswith(PREFIX)), None)  # fmt: skip
        if found is None:
            return None
        chain.append(found)
        inner = found[1].symbol[len(PREFIX) :]
        candidates = [s for s in project.sheets if s.name == inner]
    return chain


def _block_path(project: Project, name: str, depth: int = 0) -> str:
    """Instance path of a block sheet through first uses: "X1" or "X2.X1" when nested."""
    from bpt.library.blocks import PREFIX

    for sheet in project.sheets:
        for inst in sheet.instances:
            if inst.symbol == f"{PREFIX}{name}":
                used = any(
                    i.symbol == f"{PREFIX}{sheet.name}" for s in project.sheets for i in s.instances
                )
                if used and depth < 10:
                    return f"{_block_path(project, sheet.name, depth + 1)}.{inst.ref}"
                return inst.ref
    return name


class BlockBody(BaseModel):
    sheet: str = "root"
    ids: list[UUID]
    name: str  # of the new sheet


class BlockResult(BaseModel):
    revision: int
    ref: str  # the block placed instead of the selection ("" when it needed no ports)
    ports: list[str]


@router.post("/{project_id}/blocks")
def create_block(project_id: str, body: BlockBody, state: State) -> BlockResult:
    """Move the selected objects to a new sheet and put a block of it in their place."""
    from bpt.document.extract import ExtractError, block_from_selection
    from bpt.library.blocks import project_symbols

    p = _project(state, project_id)
    project = p.session.project
    try:
        result = block_from_selection(
            project, body.sheet, set(body.ids), body.name, project_symbols(project)
        )
    except (ExtractError, KeyError) as exc:
        raise HTTPException(422, str(exc)) from exc
    revision = _execute(p, result.command)
    return BlockResult(revision=revision, ref=result.ref, ports=result.ports)


@router.get("/{project_id}/symbols")
def project_block_symbols(project_id: str, state: State) -> list[Symbol]:
    """Symbols of this project: copies of library symbols and its sheets as blocks."""
    from bpt.library.blocks import block_symbols

    project = _project(state, project_id).session.project
    return [*project.symbols.values(), *block_symbols(project).values()]


class ImportBody(BaseModel):
    text: str = Field(description="SPICE netlist lines")
    has_title: bool = Field(default=False, description="First line is a title (SPICE files)")
    sheet: str = "root"


class ImportResult(BaseModel):
    revision: int
    refs: list[str]
    analyses: list[dict[str, object]]


@router.post("/{project_id}/circuit/import")
def circuit_import(project_id: str, body: ImportBody, state: State) -> ImportResult:
    p = _project(state, project_id)
    text = body.text if body.has_title else "imported\n" + body.text
    try:
        parsed = parse_netlist(text)
        command = import_netlist(p.session.project, parsed, body.sheet)
    except (SpiceSyntaxError, BuildError, KeyError) as exc:
        raise HTTPException(422, str(exc)) from exc
    return ImportResult(
        revision=_execute(p, command),
        refs=[d.ref for d in parsed.circuit.devices],
        analyses=[a.model_dump() for a in parsed.analyses],
    )


class ComponentBody(BaseModel):
    symbol: str = Field(description="Symbol id, e.g. resistor, capacitor, npn, vsource")
    nets: list[str] = Field(description="Net per pin in SPICE order; '0' is ground")
    ref: str | None = None
    params: dict[str, str] = Field(default_factory=dict)
    model: str | None = None
    sheet: str = "root"


class ComponentResult(BaseModel):
    revision: int
    ref: str


@router.post("/{project_id}/circuit/components")
def component_add(project_id: str, body: ComponentBody, state: State) -> ComponentResult:
    p = _project(state, project_id)
    try:
        ref, command = add_component(
            p.session.project, body.symbol, body.nets, body.ref, body.params, body.model,
            body.sheet,
        )  # fmt: skip
    except (BuildError, KeyError) as exc:
        raise HTTPException(422, str(exc)) from exc
    return ComponentResult(revision=_execute(p, command), ref=ref)


class ComponentUpdate(BaseModel):
    params: dict[str, str | None] = Field(default_factory=dict)
    model: str | None = None
    ratings: dict[str, str] | None = None  # stress analysis: voltage, current, power, ...


@router.patch("/{project_id}/circuit/components/{ref}")
def component_set(project_id: str, ref: str, body: ComponentUpdate, state: State) -> Revision:
    p = _project(state, project_id)
    try:
        command = set_component(p.session.project, ref, body.params, body.model, body.ratings)
    except BuildError as exc:
        raise HTTPException(404, str(exc)) from exc
    return Revision(revision=_execute(p, command))


@router.delete("/{project_id}/circuit/components/{ref}")
def component_remove(project_id: str, ref: str, state: State) -> Revision:
    p = _project(state, project_id)
    try:
        command = remove_component(p.session.project, ref)
    except BuildError as exc:
        raise HTTPException(404, str(exc)) from exc
    return Revision(revision=_execute(p, command))


class ConnectBody(BaseModel):
    a: str = Field(description="REF.PIN, e.g. R1.2")
    b: str


@router.post("/{project_id}/circuit/connect")
def connect(project_id: str, body: ConnectBody, state: State) -> Revision:
    p = _project(state, project_id)
    try:
        command = connect_pins(p.session.project, body.a, body.b)
    except BuildError as exc:
        raise HTTPException(422, str(exc)) from exc
    return Revision(revision=_execute(p, command))


def _download(content: str | bytes, media_type: str, filename: str) -> Response:
    return Response(content, media_type=media_type, headers=attachment(filename))


@router.get("/{project_id}/export/netlist")
def export_netlist(project_id: str, state: State) -> Response:
    """SPICE netlist as ngspice gets it (.cir download)."""
    project = _project(state, project_id).session.project
    lines = write_netlist(netlist_project(project).circuit)
    return _download("\n".join(lines) + "\n", "text/plain", f"{project.name}.cir")


@router.get("/{project_id}/export/bom")
def export_bom(project_id: str, state: State, format: Literal["csv", "xlsx"] = "csv") -> Response:
    """Bill of materials (FR-DAT-9) as CSV or XLSX."""
    from bpt.io.bom import bom_csv, bom_xlsx

    project = _project(state, project_id).session.project
    if format == "xlsx":
        media = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        return _download(bom_xlsx(project), media, f"{project.name}-bom.xlsx")
    return _download(bom_csv(project), "text/csv", f"{project.name}-bom.csv")


@router.get("/{project_id}/export/schematic")
def export_schematic(
    project_id: str,
    state: State,
    format: Literal["svg", "png"] = "svg",
    sheet: str | None = None,
    theme: Literal["light", "dark"] = "light",
    width: Annotated[int, Query(ge=64, le=8192)] = 2000,
) -> Response:
    """Drawing of a sheet as SVG (vector) or PNG ``width`` pixels wide."""
    from bpt.render import RenderError, render_target, svg_to_png

    project = _project(state, project_id).session.project
    try:
        svg = render_target(project, f"sheet:{sheet}" if sheet else "schematic", theme).svg
    except RenderError as exc:
        raise HTTPException(422, str(exc)) from exc
    name = f"{project.name}-{sheet}" if sheet and len(project.sheets) > 1 else project.name
    if format == "png":
        return _download(svg_to_png(svg, width), "image/png", f"{name}.png")
    return _download(svg, "image/svg+xml", f"{name}.svg")
