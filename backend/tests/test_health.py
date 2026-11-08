import pytest
from fastapi.testclient import TestClient

from bpt.engines.ngspice.locate import NgspiceNotFoundError, find_library


def _ngspice_available() -> bool:
    try:
        find_library()
    except NgspiceNotFoundError:
        return False
    return True


def test_health_is_public_and_reports_native_module(client: TestClient) -> None:
    body = client.get("/api/health").json()
    assert body["app"] == "BiasPoint"
    assert body["native"]["ok"], body["native"]


@pytest.mark.ngspice
@pytest.mark.skipif(not _ngspice_available(), reason="ngspice library not installed")
def test_health_reports_working_ngspice(client: TestClient) -> None:
    body = client.get("/api/health").json()
    assert body["ngspice"]["ok"], body["ngspice"]
    assert body["ngspice"]["version"].startswith("ngspice-")
    assert body["status"] == "ok"


def test_missing_library_from_env_is_reported(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BPT_NGSPICE_LIB", "Z:/nope/ngspice.dll")
    with pytest.raises(NgspiceNotFoundError, match="missing file"):
        find_library()
