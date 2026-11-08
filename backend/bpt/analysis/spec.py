"""Analysis specifications (what to simulate), independent of the engine."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field


class _Base(BaseModel):
    model_config = ConfigDict(extra="forbid")


class OpAnalysis(_Base):
    """DC operating point."""

    kind: Literal["op"] = "op"


class DcAnalysis(_Base):
    """DC sweep of a source (``source`` is its ref, e.g. ``V1``), a resistor (``R1``) or the
    temperature (``TEMP``); with ``source2`` the sweep repeats for each of its values (a family
    of curves, e.g. Ic(Vce) for several base currents)."""

    kind: Literal["dc"] = "dc"
    source: str
    start: str
    stop: str
    step: str
    source2: str | None = None
    start2: str | None = None
    stop2: str | None = None
    step2: str | None = None


def sweep_unit(name: str) -> str:
    """Unit of what a DC sweep varies: a voltage or current source, a resistor, TEMP."""
    lowered = name.strip().lower()
    if lowered == "temp":
        return "°C"
    return {"v": "V", "i": "A", "r": "Ω"}.get(lowered[:1], "")


class AcAnalysis(_Base):
    """Small-signal AC sweep."""

    kind: Literal["ac"] = "ac"
    variation: Literal["dec", "oct", "lin"] = "dec"
    points: int = Field(default=20, gt=0)
    fstart: str = "1"
    fstop: str = "1meg"


class TranAnalysis(_Base):
    """Transient analysis; ``tmax`` limits the internal time step."""

    kind: Literal["tran"] = "tran"
    tstep: str
    tstop: str
    tstart: str = "0"
    tmax: str | None = None
    uic: bool = False


AnalysisSpec = Annotated[
    OpAnalysis | DcAnalysis | AcAnalysis | TranAnalysis, Field(discriminator="kind")
]
