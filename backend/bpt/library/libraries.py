"""Libraries: symbols and models shared by all projects.

* **Standard libraries** come with the program (``bpt/library/standard/*.json``, read-only;
  ``BPT_STANDARD_LIBRARY_DIR`` overrides the folder). Their symbol ids start with ``std:``.
* **User libraries** are the user's own (KiCad and SPICE imports, the symbol editor): one JSON
  file each in the user's data folder (``BPT_LIBRARY_DIR`` overrides it).

A project keeps a copy of every library symbol it uses (``Project.symbols``), so it opens and
simulates the same on a computer without the library.
"""

import json
import os
import re
import time
from datetime import date
from pathlib import Path
from typing import Any

from platformdirs import user_data_path
from pydantic import BaseModel, ConfigDict, Field

from bpt.document.model import Component, ModelCard, SubcktModel, UserTemplate, VersionNote

from .symbols import Symbol, UserLook, with_extra_looks

_SAFE = re.compile(r"[^\w .-]+")


class Library(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    description: str = ""
    source: str = ""  # where it was imported from
    symbols: list[Symbol] = Field(default_factory=list)
    models: dict[str, ModelCard] = Field(default_factory=dict)  # .model cards
    subcircuits: dict[str, SubcktModel] = Field(default_factory=dict)  # subcircuit models
    components: list[Component] = Field(default_factory=list)  # real parts (FR-CMP)
    looks: list[UserLook] = Field(default_factory=list)  # drawings for other symbols
    templates: list[UserTemplate] = Field(default_factory=list)  # equivalent circuits (FR-CMP-9)


class LibraryInfo(BaseModel):
    name: str
    description: str
    source: str
    count: int
    models: int = 0
    standard: bool = False  # comes with the program: read-only


class LibraryRefusedError(ValueError):
    """A library change that cannot be made (answered with 409, not 500)."""


class ReadOnlyLibraryError(LibraryRefusedError):
    """Standard libraries cannot be changed; save into a user library instead."""


class LibraryNameError(LibraryRefusedError):
    """Another library already uses the file this name maps to ("My/parts" and "My_parts",
    or "Parts" and "parts" on Windows)."""


def standard_dir() -> Path:
    override = os.environ.get("BPT_STANDARD_LIBRARY_DIR")
    return Path(override) if override else Path(__file__).parent / "standard"


def standard() -> list[Library]:
    """The standard libraries (read once per file change, like user libraries)."""
    directory = standard_dir()
    out = []
    for path in sorted(directory.glob("*.json")) if directory.is_dir() else []:
        try:
            out.append(_read(path))
        except (OSError, ValueError):
            continue
    return out


def _built_in() -> set[str]:
    """Names of the standard libraries built in code (standard parts and templates)."""
    from bpt.models.standard_components import standard_components
    from bpt.models.standard_parts import standard_parts
    from bpt.models.standard_templates import standard_templates

    ids = [c.id for c in [*standard_parts(), *standard_components()]]
    ids += [t.id for t in standard_templates()]
    return {_owner(i).lower() for i in ids}


def _check_writable(name: str) -> None:
    if name.lower() in _built_in() or any(lib.name.lower() == name.lower() for lib in standard()):
        raise ReadOnlyLibraryError(f"{name!r} is a standard library (read-only)")


def library_dir() -> Path:
    override = os.environ.get("BPT_LIBRARY_DIR")
    return (
        Path(override) if override else user_data_path("BiasPoint", appauthor=False) / "libraries"
    )


def _path(name: str) -> Path:
    return library_dir() / f"{_SAFE.sub('_', name).strip() or 'library'}.json"


_cache: dict[Path, tuple[float, Library]] = {}


def load(name: str) -> Library:
    return _read(_path(name))


def _read(path: Path) -> Library:
    mtime = path.stat().st_mtime
    cached = _cache.get(path)
    if cached and cached[0] == mtime:
        return cached[1]
    library = Library.model_validate_json(path.read_text(encoding="utf-8"))
    _cache[path] = (mtime, library)
    return library


_META = {"version", "updated", "changes", "category", "history"}


def _content(symbol: Symbol, library: Library) -> Any:
    """What a project copy depends on: the symbol and the model it brings along."""
    model = symbol.default_model or ""
    card = library.models.get(model) or library.subcircuits.get(model)
    return (symbol.model_dump(mode="json", exclude=_META),
            card.model_dump(mode="json") if card else None)  # fmt: skip


def _versioned(library: Library, before: Library | None) -> Library:
    """Bump the version of every symbol whose content changed since the saved library."""
    today = date.today().isoformat()
    old = {s.id: s for s in before.symbols} if before else {}
    symbols = []
    for symbol in library.symbols:
        prev = old.get(symbol.id)
        if prev is None:
            update = {"version": max(symbol.version, 1), "updated": symbol.updated or today}
        elif _content(symbol, library) == _content(prev, before):  # type: ignore[arg-type]
            update = {"version": prev.version, "updated": prev.updated, "changes": prev.changes}
        elif symbol.version > prev.version:  # a newer version from elsewhere (a package)
            update = {}
        else:
            changes = symbol.changes if symbol.changes != prev.changes else ""
            update = {"version": prev.version + 1, "updated": today, "changes": changes}
        symbols.append(symbol.model_copy(update=update))
    components = _bumped(library.components, before.components if before else [], today)
    templates = _bumped(library.templates, before.templates if before else [], today)
    return library.model_copy(update={"symbols": symbols, "components": components,
                                      "templates": templates})  # fmt: skip


def _bumped[T: (Component, UserTemplate)](items: list[T], old: list[T], today: str) -> list[T]:
    """Components / templates with the version bumped where the content changed."""
    before = {item.id: item for item in old}
    out = []
    for item in items:
        prev: T | None = before.get(item.id)
        content = item.model_dump(mode="json", exclude=_META | {"id", "name"})
        update: dict[str, Any]
        if prev is None:
            update = {"version": max(item.version, 1), "updated": item.updated or today}
        elif content == prev.model_dump(mode="json", exclude=_META | {"id", "name"}):
            update = {"version": prev.version, "updated": prev.updated, "changes": prev.changes,
                      "history": prev.history}  # fmt: skip
        elif item.version > prev.version:
            update = {}
        else:
            changes = item.changes if item.changes != prev.changes else ""
            note = VersionNote(version=prev.version, updated=prev.updated, changes=prev.changes)
            history: list[VersionNote] = [note, *(prev.history if prev else [])][:50]
            update = {"version": prev.version + 1, "updated": today, "changes": changes,
                      "history": history}  # fmt: skip
        out.append(item.model_copy(update=update))
    return out


def save(library: Library) -> None:
    _check_writable(library.name)
    path = _path(library.name)
    try:
        # From the file, not the cache: callers edit the cached object before saving it.
        text = path.read_text(encoding="utf-8") if path.is_file() else None
        before = Library.model_validate_json(text) if text else None
    except (OSError, ValueError):
        before = None
    if before is not None and before.name != library.name:
        raise LibraryNameError(
            f"library {library.name!r} would overwrite {before.name!r} (same file name); "
            "choose another name"
        )
    library = _versioned(library, before)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = library.model_dump(mode="json")
    # Written whole or not at all: a request reading the library meanwhile never sees half of it.
    temp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    for attempt in range(20):
        try:
            temp.replace(path)
            break
        except PermissionError:  # Windows: the file is open in another request; wait for it
            if attempt == 19:
                temp.unlink(missing_ok=True)
                raise
            time.sleep(0.05)


def delete(name: str) -> None:
    _check_writable(name)
    path = _path(name)
    if not path.is_file():
        raise KeyError(f"no library {name!r}")
    # On Windows a file being read by another request cannot be removed: wait for it.
    for attempt in range(20):
        try:
            path.unlink()
            break
        except FileNotFoundError:
            break  # another request removed it meanwhile
        except PermissionError:
            if attempt == 19:
                raise
            time.sleep(0.05)
    _cache.pop(path, None)


def names() -> list[str]:
    directory = library_dir()
    if not directory.is_dir():
        return []
    out = []
    for path in sorted(directory.glob("*.json")):
        try:
            out.append(load(path.stem).name)
        except (OSError, ValueError):
            continue  # a broken file does not hide the other libraries
    return out


PACKAGE_FORMAT = 1


def export_package(library: Library, path: Path) -> None:
    """Write ``library`` as a ``.bptlib`` package: a zip with a manifest and the library."""
    import zipfile

    from bpt import __version__

    manifest = {"format": "bptlib", "format_version": PACKAGE_FORMAT, "library": library.name,
                "app_version": __version__, "exported": date.today().isoformat()}  # fmt: skip
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as package:
        package.writestr("manifest.json", json.dumps(manifest, indent=1))
        package.writestr("library.json", library.model_dump_json(indent=1))


def read_package(path: Path) -> Library:
    import zipfile

    try:
        with zipfile.ZipFile(path) as package:
            manifest = json.loads(package.read("manifest.json"))
            if manifest.get("format") != "bptlib":
                raise ValueError("not a BiasPoint library package")
            if int(manifest.get("format_version", 0)) > PACKAGE_FORMAT:
                raise ValueError("the package was made by a newer BiasPoint")
            return Library.model_validate_json(package.read("library.json"))
    except (zipfile.BadZipFile, KeyError) as exc:
        raise ValueError(f"not a library package: {exc}") from exc


def _all() -> list[tuple[Library, bool]]:
    """(library, standard): standard ones first, so a user library may override a model."""
    out = [(lib, True) for lib in standard()]
    for name in names():
        try:
            out.append((load(name), False))
        except FileNotFoundError:
            continue  # removed (or renamed) by another request since it was listed
    return out


def infos() -> list[LibraryInfo]:
    out = [
        LibraryInfo(
            name=lib.name,
            description=lib.description,
            source=lib.source,
            count=len(lib.symbols) + len(lib.components) + len(lib.templates),
            models=len(lib.models) + len(lib.subcircuits),
            standard=std,
        )
        for lib, std in _all()
    ]
    # The standard parts and templates built in code: read-only libraries of their own.
    listed = {i.name for i in out}
    built: dict[str, int] = {}
    for item_id in [*all_components(), *all_templates()]:
        name = _owner(item_id)
        if name.startswith("Standard") and name not in listed:
            built[name] = built.get(name, 0) + 1
    out += [LibraryInfo(name=n, description="Comes with the program", source="builtin", count=c,
                        standard=True) for n, c in sorted(built.items())]  # fmt: skip
    return out


def all_symbols() -> dict[str, Symbol]:
    return {s.id: s for lib, _std in _all() for s in lib.symbols}


def all_looks() -> dict[str, list[UserLook]]:
    """User drawings by the symbol they are for."""
    out: dict[str, list[UserLook]] = {}
    for lib, _std in _all():
        for look in lib.looks:
            out.setdefault(look.target, []).append(look)
    return out


def with_library_looks(symbols: dict[str, Symbol]) -> dict[str, Symbol]:
    """The symbols offering also the drawings the libraries have for them."""
    looks = all_looks()
    return {
        sid: with_extra_looks(s, [u.look for u in looks.get(sid, [])]) for sid, s in symbols.items()
    }


def all_templates() -> dict[str, UserTemplate]:
    """Templates of the libraries and the standard examples (transformer, transistor, IC)."""
    from bpt.models.standard_templates import standard_templates

    out = {t.id: t for t in standard_templates()}
    return out | {t.id: t for lib, _std in _all() for t in lib.templates}


def all_components() -> dict[str, Component]:
    """Components of the libraries, the standard parts and the standard examples."""
    from bpt.models.standard_components import standard_components
    from bpt.models.standard_parts import standard_parts

    out = {c.id: c for c in [*standard_parts(), *standard_components()]}
    return out | {c.id: c for lib, _std in _all() for c in lib.components}


def all_models() -> tuple[dict[str, ModelCard], dict[str, SubcktModel]]:
    cards: dict[str, ModelCard] = {}
    subckts: dict[str, SubcktModel] = {}
    for library, _std in _all():
        cards |= library.models
        subckts |= library.subcircuits
    return cards, subckts


# -- managing libraries (docs/projekt-elementy.md §4.5) -------------------------------------

_PREFIXES = ("user:", "part:", "cmp:", "tpl:")


def _owner(item_id: str) -> str:
    """The library an item id belongs to: "cmp:Parts/C1" -> "Parts"."""
    for prefix in _PREFIXES:
        if item_id.startswith(prefix):
            return item_id[len(prefix) :].split("/", 1)[0]
    raise KeyError(f"{item_id!r} is not a library item")


def _moved(item_id: str, library: str) -> str:
    """The id of an item in another library."""
    for prefix in _PREFIXES:
        if item_id.startswith(prefix):
            return f"{prefix}{library}/{item_id[len(prefix) :].split('/', 1)[1]}"
    raise KeyError(f"{item_id!r} is not a library item")


def _rehome_component(component: Component, mapping: dict[str, str], library: str) -> Component:
    """A component under another library: its id and the library symbols inside it."""
    sheets = [
        sheet.model_copy(update={"instances": [
            inst.model_copy(update={"symbol": mapping.get(inst.symbol, inst.symbol)})
            for inst in sheet.instances
        ]})
        for sheet in component.sheets
    ]  # fmt: skip
    return component.model_copy(update={"id": _moved(component.id, library), "sheets": sheets})


def create(name: str, description: str = "") -> Library:
    name = name.strip()
    if not name:
        raise LibraryRefusedError("a library needs a name")
    _check_writable(name)
    if _path(name).is_file():
        raise LibraryNameError(f"a library {name!r} exists already")
    library = Library(name=name, description=description)
    save(library)
    return load(name)


def rename(old: str, new: str, description: str | None = None) -> Library:
    """Rename a user library (ids of its items follow; projects keep their copies)."""
    _check_writable(old)
    library = load(old)
    new = new.strip() or old
    if new != old:
        _check_writable(new)
        if _path(new).is_file() and _path(new) != _path(old):
            raise LibraryNameError(f"a library {new!r} exists already")
    symbols = {s.id: _moved(s.id, new) for s in library.symbols if s.id.startswith(_PREFIXES)}
    renamed = library.model_copy(update={
        "name": new,
        "description": library.description if description is None else description,
        "symbols": [s.model_copy(update={"id": symbols.get(s.id, s.id), "category": new})
                    for s in library.symbols],
        "components": [_rehome_component(c, symbols, new) for c in library.components],
        "templates": [t.model_copy(update={"id": _moved(t.id, new)}) for t in library.templates],
        "looks": [u.model_copy(update={"look": u.look.model_copy(update={
            "name": _moved(u.look.name, new) if u.look.name.startswith("user:") else u.look.name
        })}) for u in library.looks],
    })  # fmt: skip
    if new != old:
        delete(old)
    save(renamed)
    return load(new)


def _find(item_id: str) -> tuple[Library, str]:
    """The library holding an item (user or standard) and the kind of item."""
    name = _owner(item_id)
    for lib, _std in _all():
        if lib.name != name:
            continue
        if any(c.id == item_id for c in lib.components):
            return lib, "component"
        if any(t.id == item_id for t in lib.templates):
            return lib, "template"
        if any(sym.id == item_id for sym in lib.symbols):
            return lib, "symbol"
    # Standard parts and templates built in code.
    if item_id in all_components():
        return Library(name=name, components=[all_components()[item_id]]), "component"
    if item_id in all_templates():
        return Library(name=name, templates=[all_templates()[item_id]]), "template"
    raise KeyError(f"no library item {item_id!r}")


def move_items(ids: list[str], to: str, copy: bool = False) -> list[str]:
    """Move (or copy) components, templates and symbols to user library ``to`` (created if
    needed); a standard item is always copied. A component brings the library symbols it uses
    (with their models). Returns the new ids."""
    _check_writable(to)
    try:
        target = load(to)
    except OSError:
        target = Library(name=to, source="moved")
    standard_names = {lib.name.lower() for lib in standard()} | _built_in()
    out: list[str] = []
    changed: dict[str, Library] = {}
    for item_id in ids:
        source, kind = _find(item_id)
        if source.name == to:
            out.append(item_id)
            continue
        keep = copy or source.name.lower() in standard_names
        new_id = _moved(item_id, to)
        if kind == "component":
            component = next(c for c in source.components if c.id == item_id)
            used = {i.symbol for sh in component.sheets for i in sh.instances
                    if i.symbol.startswith(("user:", "part:"))
                    and _owner(i.symbol) == source.name}  # fmt: skip
            mapping = {sid: _moved(sid, to) for sid in used}
            for sid in used:
                symbol = next((x for x in source.symbols if x.id == sid), None)
                if symbol is None:
                    continue
                target.symbols = [x for x in target.symbols if x.id != mapping[sid]] + [
                    symbol.model_copy(update={"id": mapping[sid], "category": to})
                ]
                model = symbol.default_model
                if model and model in source.models:
                    target.models[model] = source.models[model]
                if model and model in source.subcircuits:
                    target.subcircuits[model] = source.subcircuits[model]
            moved = _rehome_component(component, mapping, to)
            target.components = [c for c in target.components if c.id != new_id] + [moved]
            if not keep:
                source.components = [c for c in source.components if c.id != item_id]
        elif kind == "template":
            template = next(t for t in source.templates if t.id == item_id)
            target.templates = [t for t in target.templates if t.id != new_id] + [
                template.model_copy(update={"id": new_id})
            ]
            if not keep:
                source.templates = [t for t in source.templates if t.id != item_id]
        else:
            symbol = next(x for x in source.symbols if x.id == item_id)
            target.symbols = [x for x in target.symbols if x.id != new_id] + [
                symbol.model_copy(update={"id": new_id, "category": to})
            ]
            model = symbol.default_model
            if model and model in source.models:
                target.models[model] = source.models[model]
            if model and model in source.subcircuits:
                target.subcircuits[model] = source.subcircuits[model]
            if not keep:
                source.symbols = [x for x in source.symbols if x.id != item_id]
        if not keep:
            changed[source.name] = source
        out.append(new_id)
    save(target)
    for lib in changed.values():
        save(lib)
    return out


def set_category(ids: list[str], category: str) -> None:
    """The category of components and templates of user libraries ("" = automatic)."""
    for item_id in ids:
        library = load(_owner(item_id))
        _check_writable(library.name)
        library.components = [c.model_copy(update={"category": category}) if c.id == item_id
                              else c for c in library.components]  # fmt: skip
        library.templates = [t.model_copy(update={"category": category}) if t.id == item_id
                             else t for t in library.templates]  # fmt: skip
        save(library)


def duplicate(item_id: str, name: str) -> str:
    """A copy of an item named ``name`` in its library (a standard item: in My parts, with the
    library symbols it uses). Returns the new id."""
    name = name.strip()
    if not name:
        raise LibraryRefusedError("the copy needs a name")
    source, _kind = _find(item_id)
    to = source.name
    if to.lower() in {lib.name.lower() for lib in standard()} | _built_in():
        to = "My parts"
        item_id = move_items([item_id], to, copy=True)[0]
    library = load(to)
    prefix = next(pre for pre in _PREFIXES if item_id.startswith(pre))
    new_id = f"{prefix}{to}/{name}"
    taken = [c.id for c in library.components] + [x.id for x in library.templates]
    if new_id in taken + [x.id for x in library.symbols]:
        raise LibraryNameError(f"{to} has a {name!r} already")
    if item := next((c for c in library.components if c.id == item_id), None):
        library.components.append(item.model_copy(update={"id": new_id, "name": name, "version": 1,
                                                          "changes": ""}))  # fmt: skip
    elif tpl := next((x for x in library.templates if x.id == item_id), None):
        library.templates.append(tpl.model_copy(update={"id": new_id, "name": name, "version": 1}))
    else:
        symbol = next(x for x in library.symbols if x.id == item_id)
        library.symbols.append(symbol.model_copy(update={"id": new_id, "name": name}))
    save(library)
    return new_id


def subset(ids: list[str], name: str) -> Library:
    """A library of its own with these items (and the library symbols and models they use)."""
    out = Library(name=name, source="export")
    for item_id in ids:
        source, kind = _find(item_id)
        if kind == "component":
            component = next(c for c in source.components if c.id == item_id)
            out.components.append(component)
            used = {i.symbol for sh in component.sheets for i in sh.instances}
            symbols = [x for x in source.symbols if x.id in used]
        elif kind == "template":
            out.templates.append(next(t for t in source.templates if t.id == item_id))
            symbols = []
        else:
            symbols = [next(x for x in source.symbols if x.id == item_id)]
        for symbol in symbols:
            if all(x.id != symbol.id for x in out.symbols):
                out.symbols.append(symbol)
            model = symbol.default_model
            if model and model in source.models:
                out.models[model] = source.models[model]
            if model and model in source.subcircuits:
                out.subcircuits[model] = source.subcircuits[model]
    return out
