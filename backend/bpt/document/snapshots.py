"""Named copies of a project to go back to (taken before an AI agent changes it, or by hand).

Stored per project in ``<recovery dir>/snapshots/<project id>/<snapshot id>/`` in the normal
project format plus ``snapshot.json``; the newest ``LIMIT`` are kept. Going back is a
``restore_project`` command, so it can be undone like any other change.
"""

import shutil
import time
from pathlib import Path
from typing import Literal

from pydantic import BaseModel

from bpt.document.ids import new_id, safe_id
from bpt.document.model import Project
from bpt.document.recovery import recovery_dir
from bpt.document.storage import load_project, save_project

LIMIT = 30
META = "snapshot.json"
PROJECT_DIR = "project"

Origin = Literal["agent", "user"]


class SnapshotInfo(BaseModel):
    id: str
    label: str
    origin: Origin  # "agent": taken automatically before an agent's changes
    created: float  # unix time
    revision: int  # revision of the project when the snapshot was taken


class Snapshots:
    def __init__(self, root: Path | None = None) -> None:
        self.root = root or recovery_dir() / "snapshots"

    def _dir(self, project_id: str) -> Path:
        return self.root / safe_id(project_id, "project id")

    def take(self, project: Project, revision: int, label: str, origin: Origin) -> SnapshotInfo:
        info = SnapshotInfo(
            id=str(new_id()), label=label, origin=origin, created=time.time(), revision=revision
        )
        folder = self._dir(str(project.id)) / info.id
        save_project(project, folder / PROJECT_DIR)
        (folder / META).write_text(info.model_dump_json(indent=2), encoding="utf-8")
        for old in self.list(str(project.id))[LIMIT:]:
            self.delete(str(project.id), old.id)
        return info

    def list(self, project_id: str) -> list[SnapshotInfo]:
        found = []
        for meta in self._dir(project_id).glob(f"*/{META}"):
            try:
                found.append(SnapshotInfo.model_validate_json(meta.read_text("utf-8")))
            except (OSError, ValueError):
                continue
        return sorted(found, key=lambda s: s.created, reverse=True)

    def load(self, project_id: str, snapshot_id: str) -> Project:
        return load_project(self._dir(project_id) / safe_id(snapshot_id, "snapshot") / PROJECT_DIR)

    def delete(self, project_id: str, snapshot_id: str) -> None:
        shutil.rmtree(self._dir(project_id) / safe_id(snapshot_id, "snapshot"), ignore_errors=True)
