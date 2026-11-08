"""WebSocket ``/ws``: pushes events (``doc.changed``, ``run.progress``, ``run.finished``)."""

import contextlib

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from bpt.api.state import AppState

router = APIRouter()


@router.websocket("/ws")
async def events(websocket: WebSocket) -> None:
    state: AppState = websocket.app.state.bpt
    await websocket.accept()
    queue = state.bus.subscribe()
    try:
        await websocket.send_json({"type": "hello"})
        while True:
            await websocket.send_json(await queue.get())
    except WebSocketDisconnect:
        pass
    finally:
        state.bus.unsubscribe(queue)
        with contextlib.suppress(RuntimeError):
            await websocket.close()
