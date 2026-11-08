"""File browsing for the Open / Save dialogs (the browser cannot read the disk itself).

Lists directories and BiasPoint projects (``*.bpt`` folders with a ``project.json``) and
keeps a short list of recently used projects in the per-user state folder.
"""

import json
import os
import string
import sys
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException
from platformdirs import user_documents_path, user_state_path
from pydantic import BaseModel

from bpt import APP_NAME
from bpt.document.storage import PROJECT_FILE

router = APIRouter(prefix="/api/fs", tags=["files"])

RECENT_LIMIT = 12
SPICE_SUFFIXES = {
    ".lib", ".mod", ".sub", ".cir", ".txt", ".model", ".sp", ".spi", ".inc", ".ckt", ".lb",
    ".mdl", ".subckt", ".net", ".asc_lib",
}  # fmt: skip


class Entry(BaseModel):
    name: str
    path: str
    # symbols: a KiCad library (?kind=kicad); file: a SPICE model file (?kind=spice)
    kind: Literal["dir", "project", "symbols", "file"]


class Listing(BaseModel):
    path: str
    parent: str | None
    entries: list[Entry]
    roots: list[str]


def default_folder() -> Path:
    return user_documents_path() / APP_NAME


def _roots() -> list[str]:
    if sys.platform == "win32":
        return [f"{d}:\\" for d in string.ascii_uppercase if Path(f"{d}:\\").exists()]
    return ["/", str(Path.home())]


def is_project(path: Path) -> bool:
    return path.is_dir() and (path / PROJECT_FILE).is_file()


@router.get("/list")
def list_folder(
    path: str | None = None,
    kind: Literal["project", "kicad", "spice", "bptlib", "kicad_sch"] = "project",
) -> Listing:
    """Subfolders and projects of ``path`` (default: Documents/BiasPoint or home).

    ``kind=kicad`` lists KiCad symbol libraries instead of projects (``*.kicad_sym`` files and
    ``*.kicad_symdir`` folders), ``kind=spice`` SPICE model files (``.lib``, ``.mod``...).
    """
    folder = Path(path).expanduser() if path else default_folder()
    if not path and not folder.is_dir():
        folder = Path.home()
    if is_project(folder):
        folder = folder.parent
    if not folder.is_dir():
        raise HTTPException(404, f"not a folder: {folder}")
    entries: list[Entry] = []
    try:
        children = sorted(folder.iterdir(), key=lambda p: p.name.lower())
    except OSError as exc:
        raise HTTPException(403, f"cannot read {folder}: {exc}") from exc
    for child in children:
        if child.name.startswith("."):
            continue
        try:
            entry_kind: Literal["dir", "project", "symbols", "file"]
            if kind == "kicad":
                library = child.suffix in (".kicad_sym", ".kicad_symdir")
                if not library and not child.is_dir():
                    continue
                entry_kind = "symbols" if library else "dir"
            elif kind in ("bptlib", "kicad_sch"):
                if child.is_dir():
                    entry_kind = "dir"
                elif child.suffix.lower() == f".{kind}":
                    entry_kind = "file"
                else:
                    continue
            elif kind == "spice":
                if child.is_dir():
                    entry_kind = "dir"
                elif child.suffix.lower() in SPICE_SUFFIXES:
                    entry_kind = "file"
                else:
                    continue
            elif not child.is_dir():
                continue
            else:
                entry_kind = "project" if is_project(child) else "dir"
        except OSError:
            continue
        entries.append(Entry(name=child.name, path=str(child), kind=entry_kind))
    entries.sort(key=lambda e: (e.kind == "dir", e.name.lower()))
    parent = str(folder.parent) if folder.parent != folder else None
    return Listing(path=str(folder), parent=parent, entries=entries, roots=_roots())


# -- recent projects ---------------------------------------------------------------------------


def _recent_file() -> Path:
    override = os.environ.get("BPT_SESSION_FILE")  # tests: keep state next to the session
    base = Path(override).parent if override else user_state_path(APP_NAME, appauthor=False)
    return base / "recent.json"


def load_recent() -> list[str]:
    try:
        data = json.loads(_recent_file().read_text(encoding="utf-8"))
        return [p for p in data if isinstance(p, str)]
    except (OSError, ValueError):
        return []


def remember(path: Path) -> None:
    """Put a project at the top of the recent list."""
    entry = str(path.resolve())
    recent = [entry] + [p for p in load_recent() if p != entry]
    target = _recent_file()
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(recent[:RECENT_LIMIT], indent=2), encoding="utf-8")
    except OSError:
        pass  # not being able to remember recent projects is not an error


class Recent(BaseModel):
    name: str
    path: str


@router.get("/recent")
def recent() -> list[Recent]:
    """Recently opened or saved projects that still exist."""
    return [Recent(name=Path(p).stem, path=p) for p in load_recent() if is_project(Path(p))]


class FolderInfo(BaseModel):
    path: str


@router.get("/default")
def default() -> FolderInfo:
    return FolderInfo(path=str(default_folder()))


@router.get("/kicad")
def kicad_symbol_folders() -> list[str]:
    """Symbol folders of installed KiCad versions (newest first), for the import dialog."""
    patterns: list[tuple[Path, str]] = []
    if sys.platform == "win32":
        for folder in {os.environ.get("PROGRAMFILES", r"C:\Program Files"), r"C:\Program Files"}:
            patterns.append((Path(folder) / "KiCad", "*/share/kicad/symbols"))
    elif sys.platform == "darwin":
        patterns.append((Path("/Applications/KiCad"), "KiCad.app/Contents/SharedSupport/symbols"))
    else:
        patterns += [
            (Path("/usr/share/kicad"), "symbols"),
            (Path("/usr/local/share/kicad"), "symbols"),
        ]
    found: list[Path] = []
    for root, pattern in patterns:
        if root.is_dir():
            found += [p for p in root.glob(pattern) if p.is_dir()]
    return [str(p) for p in sorted(set(found), reverse=True)]
