"""FastAPI application factory."""

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from bpt import APP_NAME, __version__
from bpt.api import (
    capture,
    components,
    files,
    graphs,
    library,
    measurements,
    projects,
    recovery,
    runs,
    system,
    ws,
)
from bpt.api.security import LocalAccessMiddleware, Session, read_session
from bpt.api.state import AppState
from bpt.config import DEV_ORIGINS
from bpt.engines.base import Engine
from bpt.engines.ngspice.engine import NgspiceEngine
from bpt.engines.pool import EnginePool
from bpt.library.libraries import LibraryRefusedError


def create_app(
    session: Session,
    *,
    dev: bool = False,
    engine: Engine | None = None,
    scratch_root: Path | None = None,
    recovery_root: Path | None = None,
) -> FastAPI:
    state = AppState(engine or EnginePool(NgspiceEngine), scratch_root, recovery_root)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        state.bus.bind(asyncio.get_running_loop())
        if dev:  # a restart while developing keeps the open projects (NFR-8)
            state.restore_all()
        state.clean_scratch()
        state.start_autosave()
        yield
        state.stop_autosave()
        state.graphs.shutdown()
        state.orchestrator.shutdown()

    app = FastAPI(title=APP_NAME, version=__version__, lifespan=lifespan)
    app.state.bpt = state

    @app.exception_handler(LibraryRefusedError)
    async def read_only(_request: Request, exc: LibraryRefusedError) -> JSONResponse:
        return JSONResponse({"detail": str(exc)}, status_code=409)

    for module in (system, projects, recovery, runs, graphs, library, components, capture, files,
                   measurements, ws):  # fmt: skip
        app.include_router(module.router)
    app.include_router(measurements.stream)
    app.add_middleware(
        LocalAccessMiddleware,
        session=session,
        allowed_origins=DEV_ORIGINS if dev else frozenset(),
    )
    return app


def _from_session_file(dev: bool) -> FastAPI:
    session = read_session()
    if session is None:
        raise RuntimeError("no session file; start the server with `bpt serve`")
    return create_app(session, dev=dev)


def dev_app() -> FastAPI:
    """Factory for ``uvicorn --reload`` (dev origins allowed); reads the session file."""
    return _from_session_file(dev=True)


def session_app() -> FastAPI:
    """Factory for ``uvicorn --reload`` without dev origins."""
    return _from_session_file(dev=False)
