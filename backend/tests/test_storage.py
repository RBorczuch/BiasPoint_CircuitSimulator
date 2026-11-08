import json
from pathlib import Path

import pytest

from bpt.document.migrations import UnsupportedVersionError
from bpt.document.model import ModelCard, Project, Sheet
from bpt.document.storage import load_project, save_project
from tests.test_netlister import rc_project


def test_round_trip_is_lossless_and_deterministic(tmp_path: Path) -> None:
    project = rc_project()
    project.models["D1N4148"] = ModelCard(type="d", params={"is": "2.5n", "n": "1.75"})
    save_project(project, tmp_path / "rc.bpt")
    first = (tmp_path / "rc.bpt" / "sheets" / "root.json").read_bytes()

    loaded = load_project(tmp_path / "rc.bpt")
    assert loaded == project
    save_project(loaded, tmp_path / "rc.bpt")
    assert (tmp_path / "rc.bpt" / "sheets" / "root.json").read_bytes() == first
    assert b"\r\n" not in first


def test_renamed_sheet_removes_stale_file(tmp_path: Path) -> None:
    project = rc_project()
    save_project(project, tmp_path)
    project.sheets[0].name = "main"
    save_project(project, tmp_path)
    assert [p.name for p in (tmp_path / "sheets").iterdir()] == ["main.json"]


def test_newer_schema_is_rejected(tmp_path: Path) -> None:
    save_project(rc_project(), tmp_path)
    meta = json.loads((tmp_path / "project.json").read_text())
    meta["schema_version"] = 999
    (tmp_path / "project.json").write_text(json.dumps(meta))
    with pytest.raises(UnsupportedVersionError):
        load_project(tmp_path)


def test_save_replaces_files_whole(tmp_path: Path) -> None:
    """Saving goes through a temporary file; no ``.tmp`` is left and unchanged files stay."""
    project = Project(name="atomic", sheets=[Sheet(name="root")])
    save_project(project, tmp_path)
    sheet_file = tmp_path / "sheets" / "root.json"
    before = sheet_file.stat().st_mtime_ns
    project.parameters["k"] = "2"
    save_project(project, tmp_path)
    assert sheet_file.stat().st_mtime_ns == before  # the sheet did not change
    assert '"k": "2"' in (tmp_path / "project.json").read_text(encoding="utf-8")
    assert not list(tmp_path.rglob("*.tmp"))
