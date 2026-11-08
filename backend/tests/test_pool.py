import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from bpt.engines.pool import EnginePool


class _Fake:
    name = "fake"
    active = 0
    peak = 0
    lock = threading.Lock()

    def capabilities(self) -> set[str]:
        return {"op"}

    def run(self, *args: Any, **kwargs: Any) -> Any:
        with _Fake.lock:
            _Fake.active += 1
            _Fake.peak = max(_Fake.peak, _Fake.active)
        time.sleep(0.05)
        with _Fake.lock:
            _Fake.active -= 1
        return id(self)


def test_pool_runs_in_parallel_up_to_its_size_and_reuses_engines() -> None:
    created: list[_Fake] = []

    def factory() -> _Fake:
        engine = _Fake()
        created.append(engine)
        return engine

    pool = EnginePool(factory, size=3)  # type: ignore[arg-type]
    with ThreadPoolExecutor(max_workers=8) as threads:
        used = list(threads.map(lambda _: pool.run(None, None, None), range(9)))  # type: ignore[arg-type]
    assert _Fake.peak == 3
    assert len(created) == 3 and len(set(used)) == 3
