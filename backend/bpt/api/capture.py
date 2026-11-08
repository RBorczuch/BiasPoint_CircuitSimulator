"""Screenshots for AI agents (FR-AI-6).

Agent-initiated: ``POST /api/capture`` publishes a ``ui.capture`` event; the GUI renders the
target off-screen and answers with ``POST /api/capture/{request_id}/result``. Without a GUI the
backend draws the schematic itself (``bpt.render``). User-initiated
captures (``POST /api/captures``) go to an inbox the agent can read. Every capture is stored in
``<project>/.captures/`` as an image plus a JSON description.
"""

import base64
import binascii
import json
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

from bpt.api.projects import State, _project
from bpt.api.state import AppState
from bpt.document.builder import describe
from bpt.document.ids import new_id
from bpt.render import Rendered, RenderError, render_target, svg_to_png

router = APIRouter(prefix="/api", tags=["capture"])

CAPTURES_DIR = ".captures"
_TIMEOUT_S = 15.0
_MIME_EXT = {"image/png": "png", "image/webp": "webp", "image/jpeg": "jpg"}


class CaptureRequest(BaseModel):
    project_id: str | None = None
    target: str = Field(
        default="schematic",
        description="schematic | sheet:<name> | selection | refs:R1,C2 | window | plot "
        "(headless: plot:<run_id>:V(out),V(in)) | graph",
    )
    max_px: int = Field(default=1024, ge=64, le=4096)


class CaptureResult(BaseModel):
    image: str | None = None  # base64, no data: prefix
    mime: str = "image/png"
    meta: dict[str, Any] = Field(default_factory=dict)
    error: str | None = None


class CaptureInfo(BaseModel):
    id: str
    created: datetime
    source: Literal["agent", "user"]
    target: str
    mime: str
    description: str
    comment: str = ""
    read: bool = False


class CaptureResponse(CaptureInfo):
    image: str


class UserCapture(BaseModel):
    project_id: str
    image: str
    mime: str = "image/png"
    comment: str = ""
    meta: dict[str, Any] = Field(default_factory=dict)


class _Pending:
    def __init__(self) -> None:
        self.done = threading.Event()
        self.result: CaptureResult | None = None


_pending: dict[str, _Pending] = {}


def _captures_dir(state: AppState, project_id: str) -> Path:
    project = state.get(project_id)
    return project.results.root.parent / CAPTURES_DIR


def _description(state: AppState, project_id: str, target: str, meta: dict[str, Any]) -> str:
    project = state.get(project_id).session.project
    parts = [f"project {project.name!r}, target {target}"]
    if meta.get("sheet"):
        parts.append(f"sheet {meta['sheet']}")
    if meta.get("width_mm") and meta.get("height_mm"):
        parts.append(f"{meta['width_mm']:.0f} x {meta['height_mm']:.0f} mm")
    lines = ["; ".join(parts)]
    if meta.get("refs"):
        lines.append("visible: " + ", ".join(meta["refs"]))
    lines += [str(line) for line in meta.get("lines", [])]  # plot / graph / window context
    erc = [line for line in describe(project).splitlines() if line.startswith(("ERC", "  "))]
    lines += erc
    return "\n".join(lines)


def _store(
    state: AppState,
    project_id: str,
    data: bytes,
    mime: str,
    info: CaptureInfo,
    meta: dict[str, Any],
) -> CaptureInfo:
    folder = _captures_dir(state, project_id)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{info.id}.{_MIME_EXT.get(mime, 'png')}").write_bytes(data)
    record = {**info.model_dump(mode="json"), "meta": meta}
    (folder / f"{info.id}.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
    return info


def _decode(image: str) -> bytes:
    try:
        return base64.b64decode(image.split(",", 1)[-1], validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(422, "image must be base64") from exc


@router.post("/capture")
def capture(body: CaptureRequest, state: State) -> CaptureResponse:
    """Ask the open GUI for a picture of ``target``; waits for it (agent-initiated)."""
    project_id = body.project_id or next(iter(state.projects), None)
    if project_id is None:
        raise HTTPException(404, "no open project")
    _project(state, project_id)
    if state.bus.clients == 0:
        return _headless(state, project_id, body)
    request_id = str(new_id())
    pending = _pending[request_id] = _Pending()
    state.bus.publish({
        "type": "ui.capture",
        "request_id": request_id,
        "project_id": project_id,
        "target": body.target,
        "max_px": body.max_px,
    })  # fmt: skip
    try:
        if not pending.done.wait(_TIMEOUT_S) or pending.result is None:
            raise HTTPException(504, "the GUI did not answer the capture request")
    finally:
        _pending.pop(request_id, None)
    result = pending.result
    if result.error or not result.image:
        raise HTTPException(422, result.error or "capture failed")
    data = _decode(result.image)
    info = CaptureInfo(
        id=request_id,
        created=datetime.now(UTC),
        source="agent",
        target=body.target,
        mime=result.mime,
        description=_description(state, project_id, body.target, result.meta),
        read=True,
    )
    _store(state, project_id, data, result.mime, info, result.meta)
    return CaptureResponse(**info.model_dump(), image=base64.b64encode(data).decode())


def _headless_plot(state: AppState, project_id: str, target: str) -> Rendered:
    """``plot`` (latest run with an x axis) or ``plot:<run_id>[:V(out),V(in)]``."""
    from bpt.render.plot import PlotError, render_plot

    _kind, _, rest = target.partition(":")
    run_id, _, wanted = rest.partition(":")
    results = state.get(project_id).results
    try:
        if run_id:
            run = state.open_run(run_id)
        else:
            runs = [results.open(r) for r in reversed(results.list_runs())]
            run = next(r for r in runs if r.meta.status == "ok" and r.meta.scale is not None)
    except (KeyError, OSError, StopIteration) as exc:
        raise RenderError("no simulation with a plot yet: run a .tran, .ac or .dc first") from exc
    signals = [s.strip() for s in wanted.split(",") if s.strip()] or None
    try:
        svg = render_plot(run, signals)
    except (PlotError, KeyError) as exc:
        raise RenderError(str(exc)) from exc
    shown = signals or [s.name for s in run.meta.signals if s.name != run.meta.scale][:4]
    lines = [f"run {run.meta.run_id} ({run.meta.analysis.kind}), signals: {', '.join(shown)}"]
    return Rendered(svg, {"headless": True, "lines": lines})


def _headless(state: AppState, project_id: str, body: CaptureRequest) -> CaptureResponse:
    """No GUI open: draw the schematic or a plot in the backend (SVG -> PNG)."""
    project = state.get(project_id).session.project
    try:
        if body.target.split(":")[0] == "plot":
            rendered = _headless_plot(state, project_id, body.target)
        elif body.target.startswith("graph"):
            raise RenderError("graph views need the GUI open; graph_describe summarises a graph")
        else:
            rendered = render_target(project, body.target)
    except RenderError as exc:
        raise HTTPException(422, str(exc)) from exc
    data = svg_to_png(rendered.svg, body.max_px)
    info = CaptureInfo(
        id=str(new_id()),
        created=datetime.now(UTC),
        source="agent",
        target=body.target,
        mime="image/png",
        description=_description(state, project_id, body.target, rendered.meta)
        + "\n(rendered headless: no GUI open)",
        read=True,
    )
    _store(state, project_id, data, "image/png", info, rendered.meta)
    return CaptureResponse(**info.model_dump(), image=base64.b64encode(data).decode())


@router.post("/capture/{request_id}/result")
def capture_result(request_id: str, body: CaptureResult) -> None:
    """The GUI's answer to a ``ui.capture`` event."""
    pending = _pending.get(request_id)
    if pending is None:
        raise HTTPException(404, "unknown or expired capture request")
    pending.result = body
    pending.done.set()


@router.post("/captures")
def user_capture(body: UserCapture, state: State) -> CaptureInfo:
    """A screenshot the user sends to the agent (inbox)."""
    _project(state, body.project_id)
    target = str(body.meta.get("target", "selection"))
    info = CaptureInfo(
        id=str(new_id()),
        created=datetime.now(UTC),
        source="user",
        target=target,
        mime=body.mime,
        description=_description(state, body.project_id, target, body.meta),
        comment=body.comment,
    )
    return _store(state, body.project_id, _decode(body.image), body.mime, info, body.meta)


def _records(state: AppState, project_id: str) -> list[tuple[Path, CaptureInfo]]:
    folder = _captures_dir(state, project_id)
    if not folder.is_dir():
        return []
    records = []
    for meta_file in sorted(folder.glob("*.json")):
        data = json.loads(meta_file.read_text(encoding="utf-8"))
        data.pop("meta", None)
        records.append((meta_file, CaptureInfo.model_validate(data)))
    return records


@router.get("/projects/{project_id}/captures")
def list_captures(project_id: str, state: State, unread: bool = False) -> list[CaptureInfo]:
    _project(state, project_id)
    infos = [info for _p, info in _records(state, project_id)]
    return [i for i in infos if not i.read] if unread else infos


@router.get("/projects/{project_id}/captures/{capture_id}")
def get_capture(project_id: str, capture_id: str, state: State) -> CaptureResponse:
    _project(state, project_id)
    for meta_file, info in _records(state, project_id):
        if info.id == capture_id:
            image = meta_file.with_suffix(f".{_MIME_EXT.get(info.mime, 'png')}").read_bytes()
            if not info.read:  # mark as read for the inbox
                data = json.loads(meta_file.read_text(encoding="utf-8"))
                data["read"] = True
                meta_file.write_text(json.dumps(data, indent=2), encoding="utf-8")
            return CaptureResponse(**info.model_dump(), image=base64.b64encode(image).decode())
    raise HTTPException(404, f"no capture {capture_id}")


@router.get("/projects/{project_id}/captures/{capture_id}/image")
def capture_image(project_id: str, capture_id: str, state: State) -> Response:
    response = get_capture(project_id, capture_id, state)
    return Response(base64.b64decode(response.image), media_type=response.mime)
