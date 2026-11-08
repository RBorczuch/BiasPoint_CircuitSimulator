"""Library symbol versions: bumped on change, project copies updated on request or followed."""

from pathlib import Path

from fastapi.testclient import TestClient

from bpt.library import libraries
from bpt.library.builtin import builtin_symbols
from tests.test_api import H


def _save(changes: str = "", r: str = "1k") -> None:
    part = builtin_symbols()["bpt:resistor"].model_copy(update={
        "id": "user:Parts/RX", "name": "RX", "default_params": {"R": r}, "changes": changes,
    })  # fmt: skip
    libraries.save(libraries.Library(name="Parts", symbols=[part]))


def _placed(client: TestClient) -> str:
    pid = client.post("/api/projects", json={"name": "v"}, headers=H).json()["id"]
    symbol = libraries.all_symbols()["user:Parts/RX"].model_dump(mode="json")
    inst = {"ref": "R?", "symbol": "user:Parts/RX", "at": [0, 0]}
    command = {"type": "transaction", "commands": [
        {"type": "set_symbol", "id": "user:Parts/RX", "symbol": symbol},
        {"type": "add_objects", "sheet": "root", "instances": [inst]},
    ]}  # fmt: skip
    assert client.post(f"/api/projects/{pid}/commands", json={"command": command},
                       headers=H).status_code == 200  # fmt: skip
    return pid


def test_versions_bump_only_on_change(client: TestClient) -> None:
    _save()
    assert libraries.load("Parts").symbols[0].version == 1
    _save()  # same content: same version
    assert libraries.load("Parts").symbols[0].version == 1
    _save("default 2k2", "2k2")
    symbol = libraries.load("Parts").symbols[0]
    assert (symbol.version, symbol.changes) == (2, "default 2k2") and symbol.updated


def test_project_copy_is_updated_on_request(client: TestClient) -> None:
    _save()
    pid = _placed(client)
    _save("default 2k2", "2k2")
    [part] = client.get(f"/api/projects/{pid}/library-parts", headers=H).json()
    assert (part["version"], part["library_version"], part["used"]) == (1, 2, 1)
    assert part["changes"] == "default 2k2" and part["linked"] is False
    r = client.post(f"/api/projects/{pid}/library-parts/update", json={"ids": ["user:Parts/RX"]},
                    headers=H)  # fmt: skip
    assert r.status_code == 200, r.text
    [part] = client.get(f"/api/projects/{pid}/library-parts", headers=H).json()
    assert part["version"] == 2
    client.post(f"/api/projects/{pid}/undo", headers=H)  # one step back to version 1
    assert client.get(f"/api/projects/{pid}/library-parts", headers=H).json()[0]["version"] == 1

    client.post(f"/api/projects/{pid}/library-parts/link", json={"id": "user:Parts/RX",
                "linked": True}, headers=H)  # fmt: skip
    assert client.get(f"/api/projects/{pid}/library-parts", headers=H).json()[0]["linked"]
    usage = client.get("/api/library/symbols/usage", params={"id": "user:Parts/RX"},
                       headers=H).json()  # fmt: skip
    assert [(u["project"], u["parts"], u["version"]) for u in usage] == [("v", 1, 1)]


def test_bptlib_package_round_trip(client: TestClient, tmp_path: Path) -> None:
    _save("first")
    target = tmp_path / "shared" / "parts"
    r = client.post("/api/library/export", json={"library": "Parts", "path": str(target)},
                    headers=H)  # fmt: skip
    assert r.status_code == 200, r.text
    package = tmp_path / "shared" / "parts.bptlib"
    assert package.is_file()
    r = client.post("/api/library/import/bptlib", json={"path": str(package), "name": "Shared"},
                    headers=H)  # fmt: skip
    assert r.status_code == 200, r.text
    assert r.json()["imported"] == 1
    shared = libraries.load("Shared")
    assert shared.symbols[0].category == "Shared" and shared.symbols[0].version == 1
    (tmp_path / "junk.bptlib").write_bytes(b"not a zip")
    bad = client.post("/api/library/import/bptlib", json={"path": str(tmp_path / "junk.bptlib")},
                      headers=H)  # fmt: skip
    assert bad.status_code == 422


def test_names_mapping_to_one_file_are_refused(client: TestClient) -> None:
    """ "My/parts" and "My_parts" are both My_parts.json: the second used to overwrite the first."""
    import pytest

    libraries.save(libraries.Library(name="My/parts"))
    with pytest.raises(libraries.LibraryNameError):
        libraries.save(libraries.Library(name="My_parts"))
    assert libraries.load("My/parts").name == "My/parts"
    libraries.delete("My/parts")
