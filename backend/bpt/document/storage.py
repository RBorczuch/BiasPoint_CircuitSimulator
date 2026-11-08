"""Reading and writing project directories.

Layout (``<name>.bpt/``)::

    project.json        schema_version, id, name, parameters, models, sheet order
    sheets/<name>.json  one file per sheet
    graphs/<name>.json  analysis graphs (node.md)
    symbols.json        copies of the library symbols used in the project

JSON is written deterministically (fixed key order, lists sorted by id, LF, trailing newline)
so that git diffs stay small and readable.
"""

import json
import time
from pathlib import Path
from typing import Any

from bpt.document.migrations import migrate, migrate_graph
from bpt.document.model import GRAPH_VERSION, Graph, Project, Sheet

PROJECT_FILE = "project.json"
SHEETS_DIR = "sheets"
GRAPHS_DIR = "graphs"
SYMBOLS_FILE = "symbols.json"
_SORTED_LISTS = ("instances", "wires", "junctions", "labels", "directives")


def _dump(data: Any) -> str:
    return json.dumps(data, indent=2, ensure_ascii=False) + "\n"


def _write(path: Path, text: str) -> None:
    """Replace ``path`` in one step (temporary file + rename): a crash mid-write leaves the old
    file, never half of one.

    Unchanged files are not rewritten (git and file watchers see only real changes).
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        if path.read_text(encoding="utf-8") == text:
            return
    except (OSError, UnicodeDecodeError):
        pass
    temp = path.with_name(path.name + ".tmp")
    temp.write_text(text, encoding="utf-8", newline="\n")
    for attempt in range(5):
        try:
            temp.replace(path)
            return
        except PermissionError:  # Windows: a reader (antivirus, editor) holds the file
            if attempt == 4:
                temp.unlink(missing_ok=True)
                raise
            time.sleep(0.05 * (attempt + 1))


def sheet_to_json(sheet: Sheet) -> dict[str, Any]:
    data = sheet.model_dump(mode="json")
    for key in _SORTED_LISTS:
        data[key].sort(key=lambda item: item["id"])
    return data


def save_project(project: Project, directory: Path) -> None:
    """Write ``project`` to ``directory`` (created if needed); stale sheet files are removed.

    Each file is replaced atomically; ``project.json``, which lists the sheets, goes last, so
    an interrupted save never names a sheet file that is not there yet.
    """
    meta = project.model_dump(mode="json", exclude={"sheets", "graphs", "symbols"})
    meta["models"] = dict(sorted(meta["models"].items()))
    meta["sheets"] = [{"id": str(s.id), "name": s.name} for s in project.sheets]

    sheets_dir = directory / SHEETS_DIR
    wanted = {f"{sheet.name}.json" for sheet in project.sheets}
    for sheet in project.sheets:
        _write(sheets_dir / f"{sheet.name}.json", _dump(sheet_to_json(sheet)))
    if sheets_dir.is_dir():
        for stale in sheets_dir.glob("*.json"):
            if stale.name not in wanted:
                stale.unlink()

    symbols_file = directory / SYMBOLS_FILE
    if project.symbols:
        data = {k: v.model_dump(mode="json") for k, v in project.symbols.items()}
        _write(symbols_file, _dump(dict(sorted(data.items()))))
    elif symbols_file.is_file():
        symbols_file.unlink()

    graphs_dir = directory / GRAPHS_DIR
    wanted_graphs = {f"{graph.name}.json" for graph in project.graphs}
    for graph in project.graphs:
        _write(graphs_dir / f"{graph.name}.json", _dump(graph_to_json(graph)))
    if graphs_dir.is_dir():
        for stale in graphs_dir.glob("*.json"):
            if stale.name not in wanted_graphs:
                stale.unlink()
    _write(directory / PROJECT_FILE, _dump(meta))


def graph_to_json(graph: Graph) -> dict[str, Any]:
    return {"schema_version": GRAPH_VERSION, **graph.model_dump(mode="json")}


def load_project(directory: Path) -> Project:
    meta = json.loads((directory / PROJECT_FILE).read_text(encoding="utf-8"))
    sheets = [
        json.loads((directory / SHEETS_DIR / f"{entry['name']}.json").read_text(encoding="utf-8"))
        for entry in meta.pop("sheets", [])
    ]
    meta, sheets = migrate(meta, sheets)
    graphs = []
    graphs_dir = directory / GRAPHS_DIR
    if graphs_dir.is_dir():
        for path in sorted(graphs_dir.glob("*.json")):
            graphs.append(migrate_graph(json.loads(path.read_text(encoding="utf-8"))))
    symbols_file = directory / SYMBOLS_FILE
    symbols = json.loads(symbols_file.read_text(encoding="utf-8")) if symbols_file.is_file() else {}
    project = Project.model_validate({**meta, "sheets": sheets, "graphs": graphs,
                                      "symbols": symbols})  # fmt: skip
    from bpt.graph.catalog import upgrade  # (the catalogue imports the document model)

    for graph in project.graphs:
        upgrade(graph)  # nodes made by older versions of their types
    return project
