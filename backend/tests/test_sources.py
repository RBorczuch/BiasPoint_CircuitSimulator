"""Source kinds (FR-SIM-10): every waveform the inspector writes simulates as expected."""

from pathlib import Path

import numpy as np
import pytest

from bpt.analysis.spec import TranAnalysis
from bpt.engines.ngspice.engine import NgspiceEngine
from bpt.netlist.ir import CircuitIR, Device
from bpt.results.store import ResultStore
from tests.test_golden import pytestmark as golden_marks

pytestmark = golden_marks


def _run(tmp_path: Path, wave: str, tstop: str = "2m", tstep: str = "1u") -> np.ndarray:
    circuit = CircuitIR(title="source", net_names={"out": "out"}, devices=[
        Device(ref="V1", element="V", nodes=["out", "0"], params={"tran": wave}),
        Device(ref="R1", element="R", nodes=["out", "0"], params={"R": "1k"}),
    ])  # fmt: skip
    engine = NgspiceEngine()
    try:
        store = ResultStore(tmp_path)
        meta = engine.run(circuit, TranAnalysis(tstep=tstep, tstop=tstop, tmax=tstep), store)
        assert meta.status == "ok", meta.error
        return np.asarray(store.open(meta.run_id).signal("V(out)")).real
    finally:
        engine.close()


@pytest.mark.parametrize(("wave", "check"), [
    ("EXP(0 1 0 100u 1 100u)", lambda v: v.max() == pytest.approx(1, abs=1e-3)),
    ("PWL(0 0 0.5m 1 1m 0) r=0", lambda v: abs(v.max() - 1) < 0.01 and v.min() > -1e-6),
    # Carrier 1 V modulated by 0.5 V: the envelope reaches 1.5 V.
    ("AM(0 1 0.5 1k 100k)", lambda v: v.max() == pytest.approx(1.5, rel=0.02)),
    ("SFFM(0 1 100k 5 1k)", lambda v: v.max() == pytest.approx(1, rel=1e-3)),
    ("TRNOISE(10m 1u)", lambda v: np.std(v) == pytest.approx(0.01, rel=0.2)),
    ("TRRANDOM(1 10u 0 1 0)", lambda v: v.min() >= -1.001 and v.max() <= 1.001 and np.std(v) > 0.3),
])  # fmt: skip
def test_source_kinds_simulate(tmp_path: Path, wave: str, check: object) -> None:
    values = _run(tmp_path, wave)
    assert callable(check) and check(values), (wave, values.min(), values.max(), np.std(values))


def test_netlist_import_keeps_every_waveform_whole() -> None:
    from bpt.netlist.spice_parser import source_params

    assert source_params("TRNOISE(1m 1u)") == {"tran": "TRNOISE(1m 1u)"}
    assert source_params("PWL(0 0 1m 1) r=0") == {"tran": "PWL(0 0 1m 1) r=0"}
    assert source_params("DC 1 AM(0 1 0.5 1k 100k)") == {"dc": "1", "tran": "AM(0 1 0.5 1k 100k)"}


def test_imported_source_without_dc_keeps_no_dc_value() -> None:
    """``I1 0 a PULSE(...)`` has no DC value: not the symbol's default 1 mA (OP would differ)."""
    from bpt.document.builder import import_netlist
    from bpt.document.model import Project, Sheet
    from bpt.document.session import DocumentSession
    from bpt.netlist.netlister import netlist_project
    from bpt.netlist.ngspice_writer import write_netlist
    from bpt.netlist.spice_parser import parse_netlist

    session = DocumentSession(Project(name="p", sheets=[Sheet(name="root")]))
    text = "t\nI1 0 a PULSE(0 1m 0 1n 1n 1u 2u)\nR1 a 0 1k\nE1 b 0 VALUE={V(a)*3}\nR2 b 0 1k\n"
    session.execute(import_netlist(session.project, parse_netlist(text)))
    lines = write_netlist(netlist_project(session.project).circuit)
    assert "I1 0 a PULSE(0 1m 0 1n 1n 1u 2u)" in lines  # no "DC 1m"
    assert any(line.startswith("BE1 b 0 V=V(a)*3") for line in lines)  # PSpice VALUE -> B


def test_unsupported_controlled_source_forms_are_refused() -> None:
    from bpt.netlist.spice_parser import SpiceSyntaxError, parse_netlist

    with pytest.raises(SpiceSyntaxError, match="TABLE sources are not supported"):
        parse_netlist("t\nE1 b 0 TABLE {V(a)} = (0,0) (1,2)\n")
