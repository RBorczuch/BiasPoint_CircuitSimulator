"""Recovery copies of unsaved projects: list, restore (same id and path) or discard."""

from fastapi import APIRouter, HTTPException

from bpt.api.projects import ProjectInfo, State, _info
from bpt.document.recovery import RecoveryInfo

router = APIRouter(prefix="/api/recovery", tags=["recovery"])


@router.get("")
def recoverable(state: State) -> list[RecoveryInfo]:
    """Unsaved projects left by a crash or a backend restart (open ones are not listed)."""
    return state.recoverable()


@router.post("/{project_id}/restore")
def restore(project_id: str, state: State) -> ProjectInfo:
    try:
        return _info(state.restore(project_id))
    except (OSError, ValueError) as exc:
        raise HTTPException(404, f"no recovery copy {project_id}") from exc


@router.delete("/{project_id}")
def discard(project_id: str, state: State) -> None:
    if project_id in state.projects:
        raise HTTPException(409, "the project is open; close it first")
    try:
        state.recovery.discard(project_id)
    except ValueError as exc:
        raise HTTPException(404, f"no recovery copy {project_id}") from exc
