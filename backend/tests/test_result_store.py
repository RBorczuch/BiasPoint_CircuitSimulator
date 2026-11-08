"""Result store: signals packed in one file per run; runs written one file per signal still open."""

from pathlib import Path

import numpy as np

from bpt.analysis.spec import OpAnalysis
from bpt.results.store import ResultStore, SignalInfo


def test_packed_signals_round_trip(tmp_path: Path) -> None:
    store = ResultStore(tmp_path)
    writer = store.create(OpAnalysis())
    writer.add_signal("V(a)", np.array([1.5]), "V")
    writer.add_signal("V(b)", np.array([1 + 2j, 3 - 1j]), "V")
    writer.add_signal("I(R1)", np.zeros(0), "A")
    run_id = writer.finish().run_id
    run = store.open(run_id)
    assert run.signal("V(a)").tolist() == [1.5]
    assert run.signal("v(b)").tolist() == [1 + 2j, 3 - 1j]
    assert run.signal("I(R1)").size == 0
    assert sorted(p.name for p in (tmp_path / run_id / "0").iterdir()) == ["signals.f64"]


def test_runs_with_one_file_per_signal_still_open(tmp_path: Path) -> None:
    store = ResultStore(tmp_path)
    writer = store.create(OpAnalysis())
    meta = writer.finish()
    np.array([2.0, 4.0], dtype="<f8").tofile(tmp_path / meta.run_id / "0" / "s000.f64")
    meta.signals.append(SignalInfo(name="V(x)", unit="V", file="0/s000.f64"))
    (tmp_path / meta.run_id / "meta.json").write_text(meta.model_dump_json(), encoding="utf-8")
    assert store.open(meta.run_id).signal("V(x)").tolist() == [2.0, 4.0]


def test_prune_keeps_the_newest_runs(tmp_path: Path) -> None:
    from bpt.analysis.spec import OpAnalysis
    from bpt.results.store import ResultStore

    store = ResultStore(tmp_path)
    ids = []
    for _ in range(5):
        writer = store.create(OpAnalysis())
        ids.append(writer.finish().run_id)
    assert store.prune(keep=2) == 0  # all young: a graph may still read them
    assert store.prune(keep=2, min_age_s=0) == 3
    assert store.list_runs() == ids[-2:]
