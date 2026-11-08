"""Recovery copies of open projects with unsaved changes (autosave, NFR-8).

Each project gets ``<recovery dir>/<project id>/`` holding the project in the normal file
format (``project/``) and ``recovery.json`` (name, original path, time). A copy is written
whenever the project changed since the last copy and removed once the project is saved or
closed, so whatever is left after a crash or a backend restart is unsaved work.
``BPT_RECOVERY_DIR`` overrides the folder (tests).
"""

import json
import os
import shutil
import time
from pathlib import Path

from platformdirs import user_data_path
from pydantic import BaseModel

from bpt import APP_NAME
from bpt.document.ids import safe_id
from bpt.document.model import Project
from bpt.document.storage import load_project, save_project

MANIFEST = "recovery.json"
PROJECT_DIR = "project"


class RecoveryInfo(BaseModel):
    id: str  # the project id (restored projects keep it, so open pages carry on)
    name: str
    path: str | None  # where the project was saved before, if anywhere
    saved_at: float  # unix time of the copy
    revision: int


def recovery_dir() -> Path:
    override = os.environ.get("BPT_RECOVERY_DIR")
    return Path(override) if override else user_data_path(APP_NAME, appauthor=False) / "recovery"


class Recovery:
    def __init__(self, root: Path | None = None) -> None:
        self.root = root or recovery_dir()

    def write(self, project: Project, revision: int, path: Path | None) -> None:
        """Replace the copy of ``project`` (written aside first, so a crash keeps the old one)."""
        target = self.root / str(project.id)
        fresh = self.root / f"{project.id}.new"
        shutil.rmtree(fresh, ignore_errors=True)
        save_project(project, fresh / PROJECT_DIR)
        info = RecoveryInfo(
            id=str(project.id),
            name=project.name,
            path=str(path) if path else None,
            saved_at=time.time(),
            revision=revision,
        )
        (fresh / MANIFEST).write_text(info.model_dump_json(indent=2), encoding="utf-8")
        # On Windows a just-written file can be held for a moment (antivirus, an indexer).
        for attempt in range(5):
            shutil.rmtree(target, ignore_errors=True)
            try:
                fresh.rename(target)
                return
            except OSError:
                if attempt == 4:
                    raise
                time.sleep(0.05 * (attempt + 1))

    def discard(self, project_id: str) -> None:
        shutil.rmtree(self.root / safe_id(project_id, "project id"), ignore_errors=True)

    def entries(self) -> list[RecoveryInfo]:
        found = []
        if self.root.is_dir():
            for manifest in self.root.glob(f"*/{MANIFEST}"):
                try:
                    found.append(RecoveryInfo.model_validate_json(manifest.read_text("utf-8")))
                except (OSError, ValueError):
                    continue
        return sorted(found, key=lambda e: e.saved_at, reverse=True)

    def load(self, project_id: str) -> tuple[RecoveryInfo, Project]:
        folder = self.root / safe_id(project_id, "project id")
        info = RecoveryInfo.model_validate(json.loads((folder / MANIFEST).read_text("utf-8")))
        return info, load_project(folder / PROJECT_DIR)
