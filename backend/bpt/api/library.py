"""Symbol and model library endpoints, example projects."""

from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from bpt.api.projects import ProjectInfo, State, _info
from bpt.document.model import (
    Characteristic,
    Component,
    ComponentKind,
    ModelCard,
    SubcktModel,
    TemplateField,
    UserTemplate,
    rating_problem,
    safe_sheet_name,
)
from bpt.examples import EXAMPLES
from bpt.library.builtin import builtin_models, builtin_symbols
from bpt.library.categories import CategoryInfo, category_infos
from bpt.library.libraries import Library, LibraryInfo
from bpt.library.symbols import Graphic, Look, Symbol, UserLook
from bpt.models.importer import Suggestion
from bpt.models.spicelib import Parsed

router = APIRouter(prefix="/api/library", tags=["library"])


@router.get("/symbols")
def symbols() -> list[Symbol]:
    """Built-in symbols, those of the libraries and one per library component."""
    from bpt.library import libraries
    from bpt.library.blocks import component_symbol
    from bpt.library.categories import element_category

    components = [component_symbol(c) for c in libraries.all_components().values()]
    plain = libraries.with_library_looks({**builtin_symbols(), **libraries.all_symbols()})
    # A symbol that is the inside of a library part (an imported SPICE model) is listed as that
    # part only: in its library, not in the category tree.
    inner = {c.sheets[0].instances[0].symbol for c in libraries.all_components().values()
             if len(c.sheets) == 1 and len(c.sheets[0].instances) == 1
             and c.sheets[0].instances[0].symbol.startswith("part:")}  # fmt: skip
    listed = [
        s.model_copy(update={"group": None}) if s.id in inner
        else s if s.group or s.power_net is not None
        else s.model_copy(update={"group": element_category(s.spice.element if s.spice else None)})
        for s in plain.values()
    ]  # fmt: skip
    return [*listed, *(s for s in components if s is not None)]


@router.get("/categories")
def categories() -> list[CategoryInfo]:
    """The category tree and the data fields of each category (filters, part data)."""
    return category_infos()


@router.get("/components")
def components() -> dict[str, Component]:
    """Library components (real parts) with their equivalent-circuit sheets, by id."""
    from bpt.library import libraries

    return libraries.all_components()


class ComponentSave(BaseModel):
    project_id: str
    sheet: str  # the top sheet of the equivalent circuit (with ports)
    library: str
    name: str
    kind: ComponentKind = "other"
    description: str = ""
    metadata: dict[str, str] = Field(default_factory=dict)
    ratings: dict[str, str] = Field(default_factory=dict)
    characteristics: list[Characteristic] = Field(default_factory=list)  # source points
    changes: str = ""


@router.post("/components")
def save_component(body: ComponentSave, state: State) -> Component:
    """Save a sheet (and the sheets its blocks use) as a component of a user library."""
    from bpt.library import libraries
    from bpt.library.blocks import ports
    from bpt.models.user_templates import collect_sheets

    try:
        project = state.get(body.project_id).session.project
        top = project.sheet(body.sheet)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    if not ports(top):
        raise HTTPException(422, "the sheet has no ports: add port labels for the part's pins")
    name, library_name = body.name.strip(), body.library.strip()
    if not name or not library_name:
        raise HTTPException(422, "a name and a library are required")
    sheets = collect_sheets(project, top.name)
    component = Component(
        id=f"cmp:{library_name}/{name}", name=name, kind=body.kind,
        description=body.description, metadata=body.metadata, ratings=body.ratings,
        changes=body.changes, sheets=sheets, characteristics=body.characteristics,
    )  # fmt: skip
    try:
        library = libraries.load(library_name)
    except OSError:
        library = libraries.Library(name=library_name, source="components")
    library.components = [c for c in library.components if c.id != component.id] + [component]
    libraries.save(library)
    return next(c for c in libraries.load(library_name).components if c.id == component.id)


@router.get("/libraries")
def library_list() -> list[LibraryInfo]:
    from bpt.library import libraries

    return libraries.infos()


class KicadImport(BaseModel):
    path: str  # a .kicad_sym file or a .kicad_symdir folder
    name: str | None = None  # library name (default: from the file name)


class ImportReport(BaseModel):
    library: str
    imported: int
    simulated: int  # with a SPICE mapping (the rest are drawn only)
    skipped: list[str]  # "name: reason", first 20
    parts: list[str] = []  # real parts made (component ids)


@router.post("/import/kicad")
def import_kicad_library(body: KicadImport) -> ImportReport:
    """Import KiCad symbols into a user library (replaces a library of the same name)."""
    from bpt.library import libraries
    from bpt.library.kicad import import_kicad
    from bpt.library.sexpr import SExprError

    path = Path(body.path).expanduser()
    if not path.exists():
        raise HTTPException(404, f"{path} does not exist")
    try:
        name, result = import_kicad(path)
    except (OSError, UnicodeDecodeError, SExprError, ValueError) as exc:
        raise HTTPException(422, f"cannot read {path.name}: {exc}") from exc
    name = (body.name or name).strip() or name
    if not result.symbols:
        raise HTTPException(422, f"no symbols found in {path.name}")
    symbols = [
        s.model_copy(update={"id": f"kicad:{name}/{s.name}", "category": name})
        for s in result.symbols
    ]
    libraries.save(libraries.Library(name=name, source=str(path), symbols=symbols))
    return ImportReport(
        library=name,
        imported=len(symbols),
        simulated=sum(1 for s in symbols if s.spice is not None or s.power_net is not None),
        skipped=[f"{n}: {why}" for n, why in result.skipped[:20]],
    )


class LibraryNew(BaseModel):
    name: str
    description: str = ""


@router.post("/libraries")
def create_library(body: LibraryNew) -> LibraryInfo:
    from bpt.library import libraries

    lib = libraries.create(body.name, body.description)
    return next(i for i in libraries.infos() if i.name == lib.name)


class LibraryEdit(BaseModel):
    name: str | None = None  # a new name (its items' ids follow)
    description: str | None = None


@router.patch("/libraries/{name}")
def edit_library(name: str, body: LibraryEdit) -> LibraryInfo:
    from bpt.library import libraries

    try:
        lib = libraries.rename(name, body.name or name, body.description)
    except OSError as exc:
        raise HTTPException(404, f"no library {name!r}") from exc
    return next(i for i in libraries.infos() if i.name == lib.name)


class LibraryItem(BaseModel):
    id: str
    name: str
    type: Literal["component", "template", "symbol"]
    category: str


@router.get("/libraries/{name}/items")
def library_items(name: str) -> list[LibraryItem]:
    """What a library holds: its parts, templates and symbols."""
    from bpt.library import libraries
    from bpt.library.blocks import component_symbol
    from bpt.library.categories import component_category

    out: list[LibraryItem] = []
    for c in libraries.all_components().values():
        if c.id.removeprefix("cmp:").split("/")[0] == name:
            symbol = component_symbol(c)
            out.append(LibraryItem(id=c.id, name=c.name, type="component",
                                   category=(symbol.group if symbol else None) or ""))  # fmt: skip
    for t in libraries.all_templates().values():
        if t.id.removeprefix("tpl:").split("/")[0] == name:
            category = t.category or component_category("", t.id, t.kind)
            out.append(LibraryItem(id=t.id, name=t.name, type="template", category=category))
    for lib, _std in libraries._all():
        if lib.name == name:
            out += [LibraryItem(id=s.id, name=s.name, type="symbol", category=s.group or "")
                    for s in lib.symbols]  # fmt: skip
    return out


class ItemsMove(BaseModel):
    ids: list[str]
    to: str
    mode: Literal["move", "copy"] = "move"


@router.post("/items/move")
def move_items(body: ItemsMove) -> list[str]:
    """Move or copy parts, templates and symbols to another user library."""
    from bpt.library import libraries

    try:
        return libraries.move_items(body.ids, body.to.strip(), body.mode == "copy")
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc


class ItemDuplicate(BaseModel):
    id: str
    name: str


@router.post("/items/duplicate")
def duplicate_item(body: ItemDuplicate) -> str:
    """A copy of a part, template or symbol under another name (a standard one: in My parts)."""
    from bpt.library import libraries

    try:
        return libraries.duplicate(body.id, body.name)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc


def part_fields(part: Component) -> list[TemplateField]:
    """The form of a part's circuit: its values as the defaults, labels and units from the
    template it was made from (a parameter it does not know is named by its key)."""
    from bpt.library import libraries
    from bpt.models import templates as tpl

    known: dict[str, TemplateField] = {}
    source = part.template.name if part.template else ""
    if source in libraries.all_templates():
        known = {f.key: f for f in libraries.all_templates()[source].fields}
    elif source:
        try:
            known = {f.key: TemplateField(key=f.key, label=f.label, unit=f.unit,
                                          description=f.description)
                     for f in tpl.get(source).fields}  # fmt: skip
        except KeyError:
            known = {}
    return [known.get(k, TemplateField(key=k, label=k)).model_copy(update={"default": v})
            for k, v in part.sheets[0].parameters.items()]  # fmt: skip


class PartAsTemplate(BaseModel):
    id: str  # the part (cmp:)
    library: str
    name: str


@router.post("/components/as-template")
def part_as_template(body: PartAsTemplate) -> UserTemplate:
    """A template from a part: its circuit, its values as the form's defaults (labels and units
    from the template it was made from)."""
    from bpt.library import libraries

    part = libraries.all_components().get(body.id)
    if part is None:
        raise HTTPException(404, f"no library part {body.id!r}")
    name, library_name = body.name.strip(), body.library.strip()
    if not name or not library_name:
        raise HTTPException(422, "a name and a library are required")
    fields = part_fields(part)
    template = UserTemplate(
        id=f"tpl:{library_name}/{name}", name=name, kind=part.kind, description=part.description,
        category=part.category, fields=fields, sheets=[sh.model_copy(update={"form": []})
                                                       for sh in part.sheets],
    )  # fmt: skip
    try:
        library = libraries.load(library_name)
    except OSError:
        library = Library(name=library_name, source="templates")
    if any(t.id == template.id for t in library.templates):
        raise HTTPException(409, f"{library_name} has a template {name!r} already")
    library.templates.append(template)
    libraries.save(library)
    return template


class ItemsExport(BaseModel):
    ids: list[str]
    path: str  # the .bptlib file to write


@router.post("/items/export")
def export_items(body: ItemsExport) -> None:
    """Some parts, templates or symbols as a .bptlib package (a library of their own)."""
    from bpt.library import libraries

    path = Path(body.path).expanduser()
    if path.suffix.lower() != ".bptlib":
        path = path.with_name(path.name + ".bptlib")
    try:
        libraries.export_package(libraries.subset(body.ids, path.stem), path)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    except OSError as exc:
        raise HTTPException(400, f"cannot write {path}: {exc.strerror or exc}") from exc


class ItemsCategory(BaseModel):
    ids: list[str]
    category: str


@router.post("/items/category")
def set_items_category(body: ItemsCategory) -> None:
    from bpt.library import libraries

    try:
        libraries.set_category(body.ids, body.category)
    except (KeyError, OSError) as exc:
        raise HTTPException(404, str(exc)) from exc


@router.delete("/libraries/{name}")
def delete_library(name: str) -> None:
    from bpt.library import libraries

    try:
        libraries.delete(name)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc


class LibraryModels(BaseModel):
    models: dict[str, ModelCard]  # .model cards
    subcircuits: dict[str, SubcktModel]


@router.get("/models")
def models() -> LibraryModels:
    """Built-in models and those of the user's libraries."""
    from bpt.library import libraries
    from bpt.library.builtin import builtin_subcircuits

    cards, subckts = libraries.all_models()
    return LibraryModels(
        models={**builtin_models(), **cards}, subcircuits={**builtin_subcircuits(), **subckts}
    )


class SpiceFile(BaseModel):
    path: str = ""  # a library file, or
    text: str = ""  # the models pasted (the part editor)


class SpicePreview(BaseModel):
    dialect: str
    notes: list[str]
    items: list[Suggestion]


def _read_spice(path_text: str, text: str = "") -> Parsed:
    from bpt.models.spicelib import parse_library

    if text.strip():
        if len(text) > 2_000_000:
            raise HTTPException(422, "the text is too long for a model")
        return parse_library(text, source="pasted")
    path = Path(path_text).expanduser()
    if not path.is_file():
        raise HTTPException(404, f"{path} is not a file")
    if path.stat().st_size > 20_000_000:
        raise HTTPException(422, f"{path.name} is too large for a model library")
    text = path.read_bytes().decode("utf-8", errors="replace")
    return parse_library(text, source=path.name)


@router.post("/import/spice/preview")
def spice_preview(body: SpiceFile) -> SpicePreview:
    """Models in a SPICE library file, each with a suggested symbol and pin mapping."""
    from bpt.models.importer import suggest

    parsed = _read_spice(body.path, body.text)
    return SpicePreview(
        dialect=parsed.dialect,
        notes=parsed.notes,
        items=[suggest(d) for d in parsed.definitions],
    )


class SpiceChoice(BaseModel):
    name: str
    symbol: str  # symbol id, or "generic" (a box with the subcircuit's pins)
    pin_map: list[str] = []  # symbol pins in the order of the subcircuit pins


class SpiceImport(BaseModel):
    path: str = ""
    text: str = ""  # the models pasted, instead of a file
    library: str  # user library to add to (created if needed)
    items: list[SpiceChoice]


@router.post("/import/spice")
def spice_import(body: SpiceImport) -> ImportReport:
    """Add the chosen models (and a ready part for each) to a user library."""
    from bpt.library import libraries
    from bpt.library.components import component_from_symbol
    from bpt.models.importer import part_symbol

    parsed = _read_spice(body.path, body.text)
    found = {d.name: d for d in parsed.definitions}
    name = body.library.strip() or "Models"
    try:
        library = libraries.load(name)
    except OSError:
        library = libraries.Library(name=name, source=body.path or "pasted models")
    symbols = {s.id: s for s in library.symbols}
    components = {c.id: c for c in library.components}
    parts: list[str] = []
    skipped: list[str] = []
    imported = 0
    for choice in body.items:
        definition = found.get(choice.name)
        if definition is None:
            skipped.append(f"{choice.name}: not in the file")
            continue
        if definition.encrypted:
            skipped.append(f"{choice.name}: encrypted")
            continue
        if definition.model is not None:
            library.models[choice.name] = definition.model
        if definition.subckt is not None:
            library.subcircuits[choice.name] = definition.subckt
            if len(choice.pin_map) != len(definition.subckt.pins):
                skipped.append(f"{choice.name}: pin map has {len(choice.pin_map)} pins")
                continue
        part = part_symbol(name, choice.name, choice.symbol, choice.pin_map, definition.subckt)
        symbols[part.id] = part
        # A real part too (card, category, data): the symbol inside its own sheet.
        component = component_from_symbol(name, part, choice.symbol)
        components[component.id] = component
        parts.append(component.id)
        imported += 1
    library.symbols = list(symbols.values())
    library.components = list(components.values())
    libraries.save(library)
    return ImportReport(
        library=name,
        imported=imported,
        simulated=imported,
        skipped=skipped[:20],
        parts=parts,
    )


class ExampleInfo(BaseModel):
    name: str
    title: str
    description: str


@router.get("/examples")
def examples() -> list[ExampleInfo]:
    return [ExampleInfo(name=e.name, title=e.title, description=e.description) for e in EXAMPLES]


@router.post("/examples/{name}/open")
def open_example(name: str, state: State) -> ProjectInfo:
    """Open a fresh copy of an example (unsaved, so the shipped files stay untouched)."""
    example = next((e for e in EXAMPLES if e.name == name), None)
    if example is None:
        raise HTTPException(404, f"no example {name!r}")
    return _info(state.register(example.build(), None))


class PackageExport(BaseModel):
    library: str
    path: str  # the .bptlib file to write


@router.post("/export")
def export_library(body: PackageExport) -> None:
    """Write a library (user or standard) as a .bptlib package to share it."""
    from bpt.library import libraries

    found = {lib.name: lib for lib in libraries.standard()} | {
        name: libraries.load(name) for name in libraries.names()
    }
    if body.library not in found:
        raise HTTPException(404, f"no library {body.library!r}")
    path = Path(body.path).expanduser()
    if path.suffix.lower() != ".bptlib":
        path = path.with_name(path.name + ".bptlib")
    try:
        libraries.export_package(found[body.library], path)
    except OSError as exc:
        raise HTTPException(400, f"cannot write {path}: {exc.strerror or exc}") from exc


class PackageImport(BaseModel):
    path: str
    name: str | None = None  # import under another library name


@router.post("/import/bptlib")
def import_package(body: PackageImport) -> ImportReport:
    """Add a library from a .bptlib package (replaces a user library of the same name)."""
    from bpt.library import libraries

    try:
        library = libraries.read_package(Path(body.path).expanduser())
    except OSError as exc:
        raise HTTPException(404, f"cannot read {body.path}: {exc.strerror or exc}") from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    name = (body.name or library.name).strip() or library.name
    symbols = [s.model_copy(update={"category": name}) for s in library.symbols]
    libraries.save(library.model_copy(update={"name": name, "symbols": symbols}))
    return ImportReport(
        library=name,
        imported=len(symbols),
        simulated=sum(1 for s in symbols if s.spice is not None or s.power_net is not None),
        skipped=[],
    )


class LookSave(BaseModel):
    library: str
    target: str  # the symbol this is another drawing of
    name: str
    graphics: list[Graphic]
    default: bool = False  # new parts of the symbol get it, in every project


@router.post("/looks")
def save_look(body: LookSave) -> Look:
    """Save a drawing from the symbol editor as another look of an existing symbol."""
    from bpt.library import libraries

    known = {**builtin_symbols(), **libraries.all_symbols()}
    if body.target not in known:
        raise HTTPException(404, f"no symbol {body.target}")
    name, library_name = body.name.strip(), body.library.strip()
    if not name or not library_name or not body.graphics:
        raise HTTPException(422, "a name, a library and a drawing are required")
    look = Look(name=f"user:{library_name}/{name}", label=name, graphics=body.graphics,
                default=body.default)  # fmt: skip
    if body.default:  # one default drawing per symbol: the others are no longer it
        for other in libraries.names():
            lib = libraries.load(other)
            if any(u.target == body.target and u.look.default for u in lib.looks):
                lib.looks = [
                    u.model_copy(update={"look": u.look.model_copy(update={"default": False})})
                    if u.target == body.target
                    else u
                    for u in lib.looks
                ]
                libraries.save(lib)
    try:
        library = libraries.load(library_name)
    except OSError:
        library = libraries.Library(name=library_name, source="symbol editor")
    library.looks = [u for u in library.looks if u.look.name != look.name]
    library.looks.append(UserLook(target=body.target, look=look))
    libraries.save(library)
    return look


class Usage(BaseModel):
    project: str
    path: str | None  # None: open and never saved
    parts: int
    version: int  # of the project's copy


@router.get("/symbols/usage")
def symbol_usage(id: str, state: State) -> list[Usage]:
    """Where a library symbol or part (cmp:) is used: open projects and recent ones on disk."""
    from bpt.api.files import load_recent
    from bpt.document.model import Project
    from bpt.document.storage import load_project

    seen: set[str] = set()
    found: list[tuple[Project, str | None]] = []
    for p in state.projects.values():
        found.append((p.session.project, str(p.path) if p.path else None))
        if p.path is not None:
            seen.add(str(p.path.resolve()))
    for path in load_recent():
        if path in seen:
            continue
        try:
            found.append((load_project(Path(path)), path))
        except (OSError, ValueError):
            continue
    out = []
    for project, where in found:
        if id.startswith("cmp:"):  # a part: its top sheet in the project and the blocks of it
            tops = [s for s in project.sheets if s.owner == id and s.component is not None
                    and s.component.id == id]  # fmt: skip
            if not tops:
                continue
            names = {f"sheet:{s.name}" for s in tops}
            parts = sum(1 for s in project.sheets for i in s.instances if i.symbol in names)
            version = max(s.component.version for s in tops if s.component is not None)
            out.append(Usage(project=project.name, path=where, parts=parts, version=version))
            continue
        copy = project.symbols.get(id)
        if copy is None:
            continue
        parts = sum(1 for s in project.sheets for i in s.instances if i.symbol == id)
        out.append(Usage(project=project.name, path=where, parts=parts, version=copy.version))
    return out


class SymbolSave(BaseModel):
    library: str  # user library (created if needed)
    symbol: Symbol


@router.post("/symbols")
def save_symbol(body: SymbolSave) -> Symbol:
    """Add or replace a symbol of a user library (the symbol editor saves here)."""
    from bpt.library import libraries

    name = body.library.strip()
    if not name:
        raise HTTPException(422, "a library name is required")
    if body.symbol.id.startswith(("bpt:", "sheet:")):
        raise HTTPException(422, "built-in and sheet symbols cannot be replaced; save a copy")
    if not body.symbol.pins and not body.symbol.graphics:
        raise HTTPException(422, "the symbol is empty")
    try:
        library = libraries.load(name)
    except OSError:
        library = libraries.Library(name=name, source="symbol editor")
    symbol = body.symbol.model_copy(update={"category": name})
    library.symbols = [s for s in library.symbols if s.id != symbol.id] + [symbol]
    libraries.save(library)
    return symbol


@router.delete("/symbols")
def delete_symbol(library: str, id: str) -> None:
    from bpt.library import libraries

    try:
        lib = libraries.load(library)
    except OSError as exc:
        raise HTTPException(404, f"no library {library!r}") from exc
    if not any(s.id == id for s in lib.symbols):
        raise HTTPException(404, f"no symbol {id!r} in {library}")
    lib.symbols = [s for s in lib.symbols if s.id != id]
    libraries.save(lib)


class ComponentData(BaseModel):
    """A component's data edited without its circuit (D15: description, category, metadata)."""

    id: str
    description: str | None = None
    category: str | None = None
    metadata: dict[str, str] | None = None
    ratings: dict[str, str] | None = None
    changes: str = ""


@router.patch("/components")
def edit_component(body: ComponentData) -> Component:
    """Change a component's data in its user library: a new version, the circuit as it was."""
    from bpt.library import libraries

    library_name = body.id.removeprefix("cmp:").split("/")[0]
    try:
        lib = libraries.load(library_name)
    except OSError as exc:
        raise HTTPException(404, f"no library {library_name!r}") from exc
    found = next((c for c in lib.components if c.id == body.id), None)
    if found is None:
        raise HTTPException(404, f"no component {body.id!r} in {library_name}")
    if body.ratings:
        for key, value in body.ratings.items():
            if value.strip() and (problem := rating_problem(key, value.strip())):
                raise HTTPException(422, problem)
    update: dict[str, object] = {"changes": body.changes}
    if body.description is not None:
        update["description"] = body.description
    if body.category is not None:
        update["category"] = body.category.strip()
    if body.metadata is not None:
        update["metadata"] = {k: v for k, v in body.metadata.items() if v.strip()}
    if body.ratings is not None:
        update["ratings"] = {k: v for k, v in body.ratings.items() if v.strip()}
    edited = found.model_copy(update=update)
    lib.components = [edited if c.id == body.id else c for c in lib.components]
    libraries.save(lib)
    return next(c for c in libraries.load(library_name).components if c.id == body.id)


class VariantAdd(BaseModel):
    """Another model of a library part (FR-CMP-8): a project sheet with the same ports."""

    id: str  # the component
    project_id: str
    sheet: str  # its top sheet in the project (the sheets its blocks use come along)
    label: str
    description: str = ""
    faster: bool = False  # simplified: offered when a run takes long


def _user_component(cid: str) -> tuple[Library, Component]:
    from bpt.library import libraries

    library_name = cid.removeprefix("cmp:").split("/")[0]
    try:
        lib = libraries.load(library_name)
    except OSError as exc:
        raise HTTPException(404, f"no library {library_name!r}") from exc
    found = next((c for c in lib.components if c.id == cid), None)
    if found is None:
        raise HTTPException(404, f"no component {cid!r} in {library_name}")
    return lib, found


@router.post("/components/variants")
def add_variant(body: VariantAdd, state: State) -> Component:
    """Add a variant to a component of a user library: a new version that offers it as
    "Simulate as"."""
    from bpt.document.model import SheetVariant
    from bpt.library import libraries
    from bpt.library.blocks import ports
    from bpt.models.user_templates import collect_sheets

    lib, component = _user_component(body.id)
    try:
        project = state.get(body.project_id).session.project
        sheets = collect_sheets(project, body.sheet)
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    top = component.sheets[0]
    if sorted(n for n, _ in ports(sheets[0])) != sorted(n for n, _ in ports(top)):
        raise HTTPException(422, f"{body.sheet} does not have the part's pins "
                            f"({', '.join(n for n, _ in ports(top))})")  # fmt: skip
    # Names free in the component; references between the added sheets follow.
    taken = {s.name.lower() for s in component.sheets}
    names: dict[str, str] = {}
    for sheet in sheets:
        base, n = sheet.name[:40], 2
        new = base
        while new.lower() in taken:
            new, n = f"{base[:36]}~{n}", n + 1
        taken.add(new.lower())
        names[sheet.name] = new
    added = []
    for sheet in sheets:
        instances = [
            inst.model_copy(update={"symbol": f"sheet:{names[inst.symbol[6:]]}"})
            if inst.symbol.startswith("sheet:") and inst.symbol[6:] in names else inst
            for inst in sheet.instances
        ]  # fmt: skip
        added.append(sheet.model_copy(update={
            "name": names[sheet.name], "instances": instances, "owner": None, "component": None,
            "variants": [], "form": [],
        }))  # fmt: skip
    key = safe_sheet_name(body.label).lower().replace(" ", "_") or "variant"
    taken_keys = {v.name for v in top.variants}
    name, n = key, 2
    while name in taken_keys:
        name, n = f"{key}{n}", n + 1
    variant = SheetVariant(name=name, label=body.label.strip() or name,
                           description=body.description, sheet=added[0].name,
                           faster=body.faster)  # fmt: skip
    top = top.model_copy(update={"variants": [*top.variants, variant],
                                 "variant_label": top.variant_label or "Full model"})  # fmt: skip
    edited = component.model_copy(update={
        "sheets": [top, *component.sheets[1:], *added],
        "changes": f"variant {variant.label}",
    })  # fmt: skip
    lib.components = [edited if c.id == body.id else c for c in lib.components]
    libraries.save(lib)
    return next(c for c in libraries.load(lib.name).components if c.id == body.id)


@router.delete("/components/variants")
def remove_variant(id: str, name: str) -> Component:
    """Remove a variant (and the sheets only it used) from a component of a user library."""
    from bpt.library import libraries

    lib, component = _user_component(id)
    top = component.sheets[0]
    variant = next((v for v in top.variants if v.name == name), None)
    if variant is None:
        raise HTTPException(404, f"no variant {name!r}")
    top = top.model_copy(update={"variants": [v for v in top.variants if v.name != name]})
    sheets = [top, *(s for s in component.sheets[1:] if s.name != variant.sheet)]
    edited = component.model_copy(update={"sheets": sheets, "changes": f"without {variant.label}"})
    lib.components = [edited if c.id == id else c for c in lib.components]
    libraries.save(lib)
    return next(c for c in libraries.load(lib.name).components if c.id == id)


@router.delete("/components")
def delete_component(id: str) -> None:
    """Remove a component from its user library (projects keep their copies)."""
    from bpt.library import libraries

    library_name = id.removeprefix("cmp:").split("/")[0]
    try:
        lib = libraries.load(library_name)
    except OSError as exc:
        raise HTTPException(404, f"no library {library_name!r}") from exc
    if not any(c.id == id for c in lib.components):
        raise HTTPException(404, f"no component {id!r}")
    lib.components = [c for c in lib.components if c.id != id]
    libraries.save(lib)


@router.delete("/templates")
def delete_template(id: str) -> None:
    """Remove an equivalent-circuit template from its user library."""
    from bpt.library import libraries

    library_name = id.removeprefix("tpl:").split("/")[0]
    try:
        lib = libraries.load(library_name)
    except OSError as exc:
        raise HTTPException(
            404, f"no template {id!r} (the standard ones cannot be removed)"
        ) from exc
    if not any(t.id == id for t in lib.templates):
        raise HTTPException(404, f"no template {id!r}")
    lib.templates = [t for t in lib.templates if t.id != id]
    libraries.save(lib)


class PartDrawing(BaseModel):
    id: str  # a part of a user library
    like: str | None = None  # drawn as this built-in symbol; None: a box with its pins
    pins: dict[str, str] = Field(default_factory=dict)  # the symbol's pin -> the part's port


@router.post("/components/drawing")
def set_part_drawing(body: PartDrawing) -> Component:
    """Draw a part as a box with its pins or as a built-in symbol with as many pins, each pin
    on the port given (a new version of the part)."""
    from bpt.library import libraries
    from bpt.library.blocks import PREFIX, ports

    lib, component = _user_component(body.id)
    top = component.sheets[0]
    names = [name for name, _side in ports(top)]
    symbol = None
    if body.like is not None:
        ideal = builtin_symbols().get(body.like)
        if ideal is None:
            raise HTTPException(404, f"no built-in symbol {body.like!r}")
        if len(ideal.pins) != len(names):
            raise HTTPException(
                422, f"{ideal.name} has {len(ideal.pins)} pins, the part {len(names)}"
            )
        mapping = body.pins or {p.number: p.number for p in ideal.pins}
        if sorted(mapping.get(p.number, "") for p in ideal.pins) != sorted(names):
            raise HTTPException(422, f"give each pin one of the ports {', '.join(names)}, once")
        pins = [p.model_copy(update={"number": mapping[p.number]}) for p in ideal.pins]
        symbol = ideal.model_copy(update={
            "id": f"{PREFIX}{top.name}", "pins": pins, "parasitics": [], "variants": [],
            "default_params": {}, "default_model": None, "value_param": None,
        })  # fmt: skip
    sheets = [top.model_copy(update={"symbol": symbol}), *component.sheets[1:]]
    lib.components = [c.model_copy(update={"sheets": sheets}) if c.id == body.id else c
                      for c in lib.components]  # fmt: skip
    libraries.save(lib)
    return next(c for c in libraries.load(lib.name).components if c.id == body.id)
