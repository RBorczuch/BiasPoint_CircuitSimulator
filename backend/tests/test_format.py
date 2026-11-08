"""File format compatibility: projects written by earlier versions open and save unchanged.

``tests/fixtures/format/v<N>/`` holds projects written by schema version N (see the README
there) and ``examples/`` the shipped examples. Saving what was opened must keep every value
of the file; only fields added since (with their defaults) may appear. Older versions go
through the migrations first.
"""

import json
from pathlib import Path
from typing import Any

import pytest

from bpt.document.model import GRAPH_VERSION, SCHEMA_VERSION
from bpt.document.storage import load_project, save_project
from bpt.library.blocks import project_symbols
from bpt.netlist.netlister import netlist_project
from bpt.netlist.ngspice_writer import write_netlist

FIXTURES = Path(__file__).parent / "fixtures" / "format"
PROJECTS = sorted(FIXTURES.glob("v*/*.bpt")) + sorted(
    (Path(__file__).parents[2] / "examples").glob("*.bpt")
)


def _files(folder: Path) -> dict[str, Any]:
    return {
        p.relative_to(folder).as_posix(): json.loads(p.read_text(encoding="utf-8"))
        for p in sorted(folder.rglob("*.json"))
    }


def _kept(old: Any, new: Any, where: str = "") -> list[str]:
    """Places where ``new`` lost or changed a value of ``old`` (new dict keys are fine)."""
    if isinstance(old, dict) and isinstance(new, dict):
        return [
            p for k, v in old.items() for p in _kept(v, new.get(k, "<missing>"), f"{where}.{k}")
        ]
    if isinstance(old, list) and isinstance(new, list) and len(old) == len(new):
        return [
            p
            for i, (a, b) in enumerate(zip(old, new, strict=True))
            for p in _kept(a, b, f"{where}[{i}]")
        ]
    return [] if old == new else [f"{where}: {old!r} -> {new!r}"]


def test_the_current_version_has_a_fixture() -> None:
    # Bumping SCHEMA_VERSION: keep the old fixtures and add v<new>/ written by the new version.
    assert list((FIXTURES / f"v{SCHEMA_VERSION}").glob("*.bpt"))


@pytest.mark.parametrize("folder", PROJECTS, ids=lambda p: f"{p.parent.name}/{p.name}")
def test_project_opens_and_saves_without_losing_anything(folder: Path, tmp_path: Path) -> None:
    project = load_project(folder)
    save_project(project, tmp_path / "out")
    old, new = _files(folder), _files(tmp_path / "out")
    assert sorted(old) == sorted(new)
    version = old["project.json"].get("schema_version", 1)
    if version == SCHEMA_VERSION:
        lost = [p for name in old for p in _kept(old[name], new[name], name)]
        # Graph files have a version of their own: brought up to it on opening (migrated).
        step = f"schema_version: 1 -> {GRAPH_VERSION}"
        upgraded = [p for p in lost if p.startswith("graphs/") and p.endswith(step)]
        assert [p for p in lost if p not in upgraded] == []
    assert load_project(tmp_path / "out") == project
    result = netlist_project(project, project_symbols(project))
    assert result.ok, result.issues
    assert write_netlist(result.circuit)[-1] == ".end"


def test_kept_finds_lost_and_changed_values() -> None:
    old = {"a": 1, "b": [{"c": "x"}]}
    assert _kept(old, {"a": 1, "b": [{"c": "x", "new": 0}], "z": 2}) == []
    assert _kept(old, {"a": 2, "b": [{}]}) == [".a: 1 -> 2", ".b[0].c: 'x' -> '<missing>'"]
