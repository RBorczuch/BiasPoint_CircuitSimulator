"""Check that ngspice loads, in a child process so a crash cannot take the caller down.

Run as ``python -m bpt.engines.ngspice.probe``; prints one JSON object.
"""

import json
import subprocess
import sys
from typing import Any

PROBE_TIMEOUT_S = 30


def _probe_here() -> dict[str, Any]:
    from bpt.engines.ngspice.ffi import NgSpice
    from bpt.engines.ngspice.locate import NgspiceNotFoundError, find_library

    try:
        library = find_library()
    except NgspiceNotFoundError as exc:
        return {"ok": False, "error": str(exc)}
    spice = NgSpice(library)
    spice.load_circuit(["probe", "V1 a 0 DC 2", "R1 a b 1k", "R2 b 0 1k", ".end"])
    spice.command("op")
    result = " ".join(spice.command("print v(b)"))
    ok = "1.000000e+00" in result
    info: dict[str, Any] = {
        "ok": ok,
        "version": spice.version(),
        "library": str(library),
        "codemodels": len(spice.codemodels),
    }
    if not ok:
        info["error"] = f"unexpected operating point result: {result.strip()}"
    return info


def probe() -> dict[str, Any]:
    """Load ngspice in a subprocess and solve a tiny divider; never raises."""
    try:
        proc = subprocess.run(
            [sys.executable, "-m", "bpt.engines.ngspice.probe"],
            capture_output=True,
            text=True,
            timeout=PROBE_TIMEOUT_S,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"ngspice probe timed out after {PROBE_TIMEOUT_S} s"}
    lines = proc.stdout.strip().splitlines()
    try:
        result: dict[str, Any] = json.loads(lines[-1])
    except (IndexError, json.JSONDecodeError):
        detail = (proc.stderr or proc.stdout).strip()[-500:]
        return {"ok": False, "error": f"ngspice probe failed (exit {proc.returncode}): {detail}"}
    return result


if __name__ == "__main__":
    print(json.dumps(_probe_here()))
