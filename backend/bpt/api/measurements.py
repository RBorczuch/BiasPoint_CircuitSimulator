"""Measurements (phase 6): CSV files read into characteristic points, ``.bptm.json`` files, and
an API for instruments to send measured points to (one upload, or a live stream on
``/ws/instrument``: what arrives is pushed to the program's clients as ``measurement.points``).
"""

import contextlib
import json
from pathlib import Path

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field, ValidationError

from bpt.api.projects import State
from bpt.api.state import AppState
from bpt.document.ids import new_id
from bpt.document.model import Characteristic
from bpt.models.measurements import Measurement, MeasurementError, check, read_csv, to_points

router = APIRouter(prefix="/api/measurements", tags=["measurements"])
stream = APIRouter()


def units_of(kind: str) -> tuple[str, str]:
    """The x and y units of a characteristic's points ("", "" when not one the fits know)."""
    from bpt.models import fit, multiport_fit, semi_fit

    every = {**fit.UNITS, **semi_fit.DIODE_UNITS, **semi_fit.MOSFET_UNITS, **semi_fit.BJT_UNITS,
             **multiport_fit.UNITS}  # fmt: skip
    return every.get(kind, ("", ""))


class CsvText(BaseModel):
    text: str


class CsvColumn(BaseModel):
    name: str
    unit: str
    scale: float


class CsvSummary(BaseModel):
    columns: list[CsvColumn]
    rows: int
    preview: list[list[float]]  # the first rows
    delimiter: str
    decimal_comma: bool
    skipped: int  # lines that were not numbers (headers, comments)


class CsvChoice(BaseModel):
    text: str
    kind: str  # the characteristic the points are for ("|Z|(f)")
    x: int  # columns
    y: int


class CsvPoints(BaseModel):
    points: list[tuple[float, float]]
    x_unit: str
    y_unit: str
    notes: list[str]


def _table(text: str):  # type: ignore[no-untyped-def]
    if len(text) > 20_000_000:
        raise HTTPException(422, "the file is too large")
    try:
        return read_csv(text)
    except MeasurementError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/csv")
def csv_summary(body: CsvText) -> CsvSummary:
    """The columns of a CSV text (their units from the headers) and its first rows."""
    table = _table(body.text)
    return CsvSummary(
        columns=[CsvColumn(name=c.name, unit=c.unit, scale=c.scale) for c in table.columns],
        rows=len(table.rows), preview=table.rows[:8], delimiter=table.delimiter,
        decimal_comma=table.decimal_comma, skipped=table.skipped,
    )  # fmt: skip


@router.post("/csv/points")
def csv_points(body: CsvChoice) -> CsvPoints:
    """Two columns of a CSV text as a characteristic's points, in its units."""
    table = _table(body.text)
    width = len(table.columns)
    if not (0 <= body.x < width and 0 <= body.y < width):
        raise HTTPException(422, f"the file has columns 1 to {width}")
    units = units_of(body.kind)
    points, notes = to_points(table, body.x, body.y, units)
    return CsvPoints(points=points, x_unit=units[0], y_unit=units[1], notes=notes)


class FilePath(BaseModel):
    path: str


class SaveMeasurement(BaseModel):
    path: str
    measurement: Measurement


def _file(text: str) -> Path:
    path = Path(text).expanduser()
    if path.suffix != ".json":
        path = path.with_name(
            path.name + (".bptm.json" if not path.name.endswith(".bptm") else ".json")
        )
    return path


@router.post("/save")
def save_measurement(body: SaveMeasurement) -> FilePath:
    """A measurement written as a ``.bptm.json`` file."""
    path = _file(body.path)
    try:
        path.write_text(body.measurement.model_dump_json(indent=2), encoding="utf-8")
    except OSError as exc:
        raise HTTPException(422, f"cannot write {path}: {exc}") from exc
    return FilePath(path=str(path))


@router.post("/open")
def open_measurement(body: FilePath) -> Measurement:
    path = Path(body.path).expanduser()
    if not path.is_file():
        raise HTTPException(404, f"{path} is not a file")
    try:
        return check(Measurement.model_validate_json(path.read_text(encoding="utf-8")))
    except (ValidationError, MeasurementError) as exc:
        raise HTTPException(422, f"{path.name}: {exc}") from exc


# -- instruments ---------------------------------------------------------------------------------


class Stored(BaseModel):
    id: str
    measurement: Measurement


class Summary(BaseModel):
    id: str
    name: str
    instrument: str
    characteristics: list[str]  # names, with the number of points
    points: int


def _registry(state: AppState) -> dict[str, Measurement]:
    if not hasattr(state, "measurements"):
        state.measurements = {}  # type: ignore[attr-defined]
    return state.measurements  # type: ignore[attr-defined, no-any-return]


@router.post("")
def upload(body: Measurement, state: State) -> Stored:
    """A measurement sent by an instrument (or a script): kept while the program runs and
    announced to its clients."""
    try:
        check(body)
    except MeasurementError as exc:
        raise HTTPException(422, str(exc)) from exc
    key = str(new_id())
    _registry(state)[key] = body
    state.bus.publish({"type": "measurement.added", "id": key, "name": body.name})
    return Stored(id=key, measurement=body)


@router.get("")
def listed(state: State) -> list[Summary]:
    return [
        Summary(id=key, name=m.name, instrument=m.instrument,
                characteristics=[f"{c.name} ({len(c.points)})" for c in m.characteristics],
                points=sum(len(c.points) for c in m.characteristics))
        for key, m in _registry(state).items()
    ]  # fmt: skip


@router.get("/{key}")
def one(key: str, state: State) -> Measurement:
    found = _registry(state).get(key)
    if found is None:
        raise HTTPException(404, f"no measurement {key}")
    return found


class Batch(BaseModel):
    """Points streamed by an instrument: appended to a characteristic of a measurement (both
    made when new)."""

    measurement: str  # its id, or a name for a new one
    characteristic: str  # "|Z|(f)", "VF(IF)"...
    points: list[tuple[float, float]] = Field(default_factory=list)
    at: dict[str, float] = Field(default_factory=dict)  # the conditions (Vce, Vgs...)


def add_batch(state: AppState, batch: Batch) -> str:
    registry = _registry(state)
    key = batch.measurement if batch.measurement in registry else ""
    if not key:
        key = str(new_id())
        registry[key] = Measurement(name=batch.measurement, instrument="stream")
    m = registry[key]
    char = next((c for c in m.characteristics if c.name == batch.characteristic), None)
    if char is None:
        x_unit, y_unit = units_of(batch.characteristic)
        char = Characteristic(name=batch.characteristic, x_unit=x_unit, y_unit=y_unit,
                              source="measurement", at=batch.at)  # fmt: skip
        m.characteristics.append(char)
    char.points = [*char.points, *batch.points]
    state.bus.publish({"type": "measurement.points", "id": key, "characteristic": char.name,
                       "points": batch.points, "total": len(char.points)})  # fmt: skip
    return key


@router.post("/stream")
def batch(body: Batch, state: State) -> Stored:
    """One batch of streamed points (the same as a message on ``/ws/instrument``)."""
    key = add_batch(state, body)
    return Stored(id=key, measurement=_registry(state)[key])


@stream.websocket("/ws/instrument")
async def instrument(websocket: WebSocket) -> None:
    """An instrument's live stream: each message a batch (JSON, as ``POST .../stream``); each is
    answered with the measurement's id and its points so far, or with an error."""
    state: AppState = websocket.app.state.bpt
    await websocket.accept()
    try:
        while True:
            text = await websocket.receive_text()
            try:
                key = add_batch(state, Batch.model_validate(json.loads(text)))
            except (ValidationError, ValueError) as exc:
                await websocket.send_json({"type": "error", "error": str(exc)[:500]})
                continue
            total = sum(len(c.points) for c in _registry(state)[key].characteristics)
            await websocket.send_json({"type": "ok", "id": key, "points": total})
    except WebSocketDisconnect:
        pass
    finally:
        with contextlib.suppress(RuntimeError):
            await websocket.close()
