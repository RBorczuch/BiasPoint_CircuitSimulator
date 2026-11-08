"""Golden reference circuits (repo ``tests/golden/<name>/``): netlist + spec.json checks.

Check fields: ``analysis`` (AnalysisSpec), ``signal``, a reduction (``reduce``: value | max |
min | final, or ``at``: x value, interpolated), and an expectation: ``expected`` (+ ``rtol``),
``expected_db`` / ``expected_phase_deg`` (+ ``atol``) or ``range: [lo, hi]`` (magnitude for AC).
"""

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from pydantic import TypeAdapter

from bpt.analysis.spec import AnalysisSpec
from bpt.engines.ngspice.engine import NgspiceEngine
from bpt.engines.ngspice.locate import NgspiceNotFoundError, find_library
from bpt.netlist.spice_parser import parse_netlist
from bpt.results.store import ResultStore, RunReader

GOLDEN = Path(__file__).resolve().parents[2] / "tests" / "golden"
CASES = sorted(p.name for p in GOLDEN.iterdir() if (p / "spec.json").is_file())
_analysis = TypeAdapter(AnalysisSpec)


def _have_ngspice() -> bool:
    try:
        find_library()
    except NgspiceNotFoundError:
        return False
    return True


pytestmark = [
    pytest.mark.ngspice,
    pytest.mark.skipif(not _have_ngspice(), reason="ngspice library not installed"),
]


@pytest.fixture(scope="module")
def engine() -> Iterator[NgspiceEngine]:
    eng = NgspiceEngine()
    yield eng
    eng.close()


def _measure(run: RunReader, check: dict[str, Any]) -> complex:
    y = np.asarray(run.signal(check["signal"]))
    if "at" in check:
        assert run.meta.scale is not None
        x = np.real(np.asarray(run.signal(run.meta.scale)))
        if np.iscomplexobj(y):
            return complex(np.interp(check["at"], x, y.real), np.interp(check["at"], x, y.imag))
        return complex(np.interp(check["at"], x, y))
    reduce = check.get("reduce", "value")
    if reduce == "max":
        return complex(np.max(np.abs(y) if np.iscomplexobj(y) else y))
    if reduce == "min":
        return complex(np.min(np.abs(y) if np.iscomplexobj(y) else y))
    return complex(y[-1])  # value (op) or final


@pytest.mark.parametrize("case", CASES)
def test_golden(case: str, engine: NgspiceEngine, tmp_path: Path) -> None:
    spec = json.loads((GOLDEN / case / "spec.json").read_text(encoding="utf-8"))
    parsed = parse_netlist((GOLDEN / case / "circuit.cir").read_text(encoding="utf-8"))
    store = ResultStore(tmp_path)
    runs: dict[str, RunReader] = {}
    failures = []
    for check in spec["checks"]:
        key = json.dumps(check["analysis"], sort_keys=True)
        if key not in runs:
            meta = engine.run(parsed.circuit, _analysis.validate_python(check["analysis"]), store)
            assert meta.status == "ok", f"{case}: {meta.error}\n" + "\n".join(meta.log)
            runs[key] = store.open(meta.run_id)
        value = _measure(runs[key], check)
        label = f"{check['signal']} {check.get('at', check.get('reduce', ''))}"
        if "expected" in check:
            actual: float = abs(value) if value.imag else value.real
            ok = abs(actual - check["expected"]) <= check.get("rtol", 1e-6) * abs(check["expected"])
        elif "expected_db" in check:
            actual = 20 * np.log10(abs(value))
            ok = abs(actual - check["expected_db"]) <= check.get("atol", 0.01)
        elif "expected_phase_deg" in check:
            actual = float(np.degrees(np.angle(value)))
            ok = abs(actual - check["expected_phase_deg"]) <= check.get("atol", 0.1)
        else:
            lo, hi = check["range"]
            actual = abs(value) if value.imag or "ac" in key else value.real
            ok = lo <= actual <= hi
        if not ok:
            failures.append(f"{label}: got {actual:.6g}, check {check}")
    assert not failures, f"{case}:\n" + "\n".join(failures)
