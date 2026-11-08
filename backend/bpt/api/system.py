"""System endpoints: health and connectivity checks."""

from functools import cache
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from bpt import APP_NAME, __version__
from bpt.engines.ngspice.probe import probe

router = APIRouter(prefix="/api", tags=["system"])


class ComponentStatus(BaseModel):
    ok: bool
    version: str | None = None
    error: str | None = None
    details: dict[str, Any] = {}


class Health(BaseModel):
    status: str
    app: str
    version: str
    native: ComponentStatus
    ngspice: ComponentStatus


def _native_status() -> ComponentStatus:
    try:
        import bpt_native
    except ImportError as exc:
        return ComponentStatus(ok=False, error=f"bpt_native not importable: {exc}")
    return ComponentStatus(
        ok=True,
        version=bpt_native.version(),
        details={"features": "decimation, svg_to_png"},
    )


@cache
def _ngspice_status() -> ComponentStatus:
    result = probe()
    return ComponentStatus(
        ok=bool(result.get("ok")),
        version=result.get("version"),
        error=result.get("error"),
        details={k: v for k, v in result.items() if k in ("library", "codemodels")},
    )


@router.get("/health")
def health() -> Health:
    """Public: reports whether the backend, the native module and ngspice work."""
    native, ngspice = _native_status(), _ngspice_status()
    return Health(
        status="ok" if native.ok and ngspice.ok else "degraded",
        app=APP_NAME,
        version=__version__,
        native=native,
        ngspice=ngspice,
    )


@router.get("/ping")
def ping() -> dict[str, bool]:
    """Token-protected connectivity check."""
    return {"pong": True}
