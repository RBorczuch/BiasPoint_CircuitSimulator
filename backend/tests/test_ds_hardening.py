"""Hardening tests added after the DS audit (id/path validation and documented edge cases).

Pure Python — no ngspice needed. Run: ``cd backend && uv run pytest tests/test_ds_hardening.py``.

See ``DS_Testy.md``. The two defects it marked ``xfail`` were checked: tabs in values are
fixed; the "lost first line" is the SPICE title rule, now tested as such.
"""

from pathlib import Path

import pytest

from bpt.document.ids import UnsafeIdError, new_id, safe_id
from bpt.document.recovery import Recovery
from bpt.document.snapshots import Snapshots
from bpt.netlist.erc import _milli_mega
from bpt.netlist.spice_parser import parse_netlist
from bpt.units import parse_value

# -- id / path validation ---------------------------------------------------------------


def test_safe_id_accepts_generated_ids_and_safe_names() -> None:
    ident = str(new_id())
    assert safe_id(ident) == ident
    assert safe_id(ident, "snapshot") == ident
    assert safe_id("a_valid-name_01") == "a_valid-name_01"


@pytest.mark.parametrize(
    "bad",
    ["..", ".", "a/b", "a\\b", "../x", "x/..", "", "a:b", "a" * 100, " leading", "trailing "],
)
def test_safe_id_rejects_traversal_and_bad_names(bad: str) -> None:
    with pytest.raises(UnsafeIdError):
        safe_id(bad)


def test_snapshot_paths_are_validated(tmp_path: Path) -> None:
    snap = Snapshots(root=tmp_path / "snapshots")
    with pytest.raises(UnsafeIdError):
        snap.delete("..", "anything")
    with pytest.raises(UnsafeIdError):
        snap.load("..", "anything")
    with pytest.raises(UnsafeIdError):
        snap._dir("a/b")


def test_recovery_paths_are_validated(tmp_path: Path) -> None:
    recovery = Recovery(root=tmp_path / "recovery")
    with pytest.raises(UnsafeIdError):
        recovery.discard("..")
    with pytest.raises(UnsafeIdError):
        recovery.load("..")


# -- ERC: milli vs mega ------------------------------------------------------------------


def _erc_messages(text: str) -> list[str]:
    circuit = parse_netlist(text).circuit
    return [i.message for i in _milli_mega(circuit) if i.code == "milli-not-mega"]


def test_milli_mega_warns_on_bare_m_suffix() -> None:
    messages = _erc_messages("t\nR1 1 0 1M\nR2 1 0 2.2M\n")
    assert any("1M" in m for m in messages)
    assert any("2.2M" in m for m in messages)


def test_milli_mega_does_not_warn_on_explicit_milli() -> None:
    # 'mA'/'mV'/'mW' use a lower-case m (milli), so the M=milli heuristic must stay silent.
    messages = _erc_messages("t\nR1 1 0 1mA\nR2 1 0 1mV\nR3 1 0 1mW\n")
    assert messages == []


# -- units whitespace --------------------------------------------------------------------


def test_parse_value_accepts_tabs() -> None:
    assert parse_value("10\tk") == pytest.approx(10e3)
    assert parse_value("4k7\t") == pytest.approx(4.7e3)


# -- SPICE parser: comments, continuation and the title line -----------------------------


def test_spice_inline_comment_with_space_is_stripped() -> None:
    circuit = parse_netlist("t\nR1 1 0 10k ; a load\nR2 1 0 5k $ another\n.end\n").circuit
    r1 = next(d for d in circuit.devices if d.ref == "R1")
    r2 = next(d for d in circuit.devices if d.ref == "R2")
    assert r1.params["R"] == "10k"
    assert r2.params["R"] == "5k"


def test_spice_continuation_line_is_joined() -> None:
    circuit = parse_netlist("t\nV1 a 0 SIN(0 1\n+ 1k)\n.end\n").circuit
    v1 = next(d for d in circuit.devices if d.ref == "V1")
    assert v1.params["tran"] == "SIN(0 1 1k)"


def test_first_line_is_always_the_title() -> None:
    """SPICE rule (ngspice, LTspice, PSpice): line 1 is the title whatever it says, so a title
    like "RC filter" is not read as an element "RC". Pasted fragments without a title go
    through ``/circuit/import`` with ``has_title: false``, which adds one."""
    circuit = parse_netlist("RC filter\nR1 1 0 10k\nR2 1 0 5k\n.end\n").circuit
    assert {d.ref for d in circuit.devices} == {"R1", "R2"}
    assert circuit.title == "RC filter"


# -- downloads, interpolation, unfinished runs, MCP queries ------------------------------


def test_download_header_takes_any_project_name() -> None:
    from bpt.api.security import attachment

    header = attachment('Wzmacniacz ł "v2"\r\n.csv')["content-disposition"]
    header.encode("latin-1")  # a header must be Latin-1 (ł used to give a 500)
    assert "\r" not in header and "\n" not in header
    assert "filename*=UTF-8''Wzmacniacz%20%C5%82" in header


def test_interp_on_a_downward_sweep() -> None:
    import numpy as np

    from bpt.graph.dsp import interp

    x = np.array([5.0, 4.0, 3.0, 2.0, 1.0, 0.0])  # .dc V1 5 0 -1
    assert float(interp(1.5, x, 2 * x)) == pytest.approx(3.0)


def test_unfinished_runs_are_pruned_after_a_day(tmp_path: Path) -> None:
    import os
    import time

    from bpt.results.store import ResultStore

    store = ResultStore(tmp_path)
    old, fresh = tmp_path / str(new_id()), tmp_path / str(new_id())
    for folder in (old, fresh):
        folder.mkdir()
        (folder / "signals.bin").write_bytes(b"0")
    os.utime(old, (time.time() - 2 * 86400,) * 2)
    store.prune()
    assert not old.exists() and fresh.exists()


def test_mcp_signal_names_are_url_encoded() -> None:
    from bpt.mcp.server import _signals_query

    assert _signals_query(["V(V+)", "I(R1)"]) == "?signals=V(V%2B),I(R1)"
    assert _signals_query(None) == ""


def test_reductions_of_a_constant() -> None:
    import numpy as np

    from bpt.results.calculator import evaluate_with

    x = np.zeros(1)  # an operating point: one point
    for text, expected in {"rms(-5)": 5, "avg(3)": 3, "max(2)": 2, "pp(2)": 0}.items():
        assert float(evaluate_with(text, x, {})) == expected, text
