"""Managing libraries (docs/projekt-elementy.md §4.5): create, rename, move, copy, categories."""

from fastapi.testclient import TestClient

from tests.test_api import H


def test_create_rename_move_copy_and_categorise(client: TestClient) -> None:
    assert client.post("/api/library/libraries", json={"name": "Old"}, headers=H).status_code == 200
    body = {"template": "mlcc", "form": {"Cnom": "1u"}, "library": "Old", "name": "C1U"}
    assert client.post("/api/components/from-template", json=body, headers=H).status_code == 200

    # Renamed: the part's id follows.
    r = client.patch("/api/library/libraries/Old", json={"name": "Parts", "description": "mine"},
                     headers=H)  # fmt: skip
    assert r.status_code == 200, r.text
    items = client.get("/api/library/libraries/Parts/items", headers=H).json()
    assert [(i["id"], i["type"], i["category"]) for i in items] == [
        ("cmp:Parts/C1U", "component", "Capacitors/Ceramic")
    ]
    assert client.get("/api/library/libraries/Old/items", headers=H).json() == []

    # Moved to another library (created), then a standard part copied there.
    moved = client.post("/api/library/items/move", json={"ids": ["cmp:Parts/C1U"], "to": "Other"},
                        headers=H).json()  # fmt: skip
    assert moved == ["cmp:Other/C1U"]
    assert client.get("/api/library/libraries/Parts/items", headers=H).json() == []
    copied = client.post("/api/library/items/move",
                         json={"ids": ["cmp:Standard parts/TL072"], "to": "Other"},
                         headers=H).json()  # fmt: skip
    assert copied == ["cmp:Other/TL072"]
    symbols = {s["id"] for s in client.get("/api/library/symbols", headers=H).json()}
    assert {"cmp:Standard parts/TL072", "cmp:Other/TL072"} <= symbols  # the standard one stays

    # Category of several parts at once.
    r = client.post("/api/library/items/category",
                    json={"ids": ["cmp:Other/C1U", "cmp:Other/TL072"], "category": "Other"},
                    headers=H)  # fmt: skip
    assert r.status_code == 200, r.text
    items = {i["id"]: i for i in client.get("/api/library/libraries/Other/items", headers=H).json()}
    assert items["cmp:Other/C1U"]["category"] == "Other"
    assert items["cmp:Other/TL072"]["category"] == "Other"


def test_the_standard_parts_are_a_read_only_library(client: TestClient) -> None:
    infos = {i["name"]: i for i in client.get("/api/library/libraries", headers=H).json()}
    assert infos["Standard parts"]["standard"] and infos["Standard parts"]["count"] > 5
    items = client.get("/api/library/libraries/Standard parts/items", headers=H).json()
    assert any(i["name"] == "1N4148" for i in items)
    body = {"ids": ["cmp:Standard parts/1N4148"], "category": "Other"}
    r = client.post("/api/library/items/category", json=body, headers=H)
    assert r.status_code >= 400


def test_a_part_duplicated_exported_and_found_where_used(client: TestClient, tmp_path) -> None:
    body = {"template": "mlcc", "form": {"Cnom": "1u"}, "library": "Dup", "name": "C1U"}
    assert client.post("/api/components/from-template", json=body, headers=H).status_code == 200
    r = client.post("/api/library/items/duplicate", json={"id": "cmp:Dup/C1U", "name": "C1U-b"},
                    headers=H)  # fmt: skip
    assert r.json() == "cmp:Dup/C1U-b"
    again = client.post("/api/library/items/duplicate",
                        json={"id": "cmp:Dup/C1U", "name": "C1U-b"}, headers=H)  # fmt: skip
    assert again.status_code >= 400
    std = client.post(
        "/api/library/items/duplicate",
        json={"id": "cmp:Standard parts/1N4148", "name": "1N4148-mine"},
        headers=H,
    )
    assert std.json() == "cmp:My parts/1N4148-mine"
    parts = client.get("/api/library/components", headers=H).json()
    assert parts["cmp:Dup/C1U-b"]["name"] == "C1U-b"

    out = tmp_path / "two.bptlib"
    r = client.post("/api/library/items/export",
                    json={"ids": ["cmp:Dup/C1U", "cmp:My parts/1N4148-mine"], "path": str(out)},
                    headers=H)  # fmt: skip
    assert r.status_code == 200, r.text
    from bpt.library.libraries import read_package

    package = read_package(out)
    assert {c.name for c in package.components} == {"C1U", "1N4148-mine"}

    pid = client.post("/api/projects", json={"name": "uses"}, headers=H).json()["id"]
    place = {"symbol": "cmp:Dup/C1U", "nets": ["a", "0"]}
    r = client.post(f"/api/projects/{pid}/circuit/components", json=place, headers=H)
    assert r.status_code == 200, r.text
    usage = client.get("/api/library/symbols/usage?id=cmp:Dup/C1U", headers=H).json()
    assert [(u["project"], u["parts"]) for u in usage] == [("uses", 1)]
    for name in ("Dup", "My parts"):
        client.delete(f"/api/library/libraries/{name}", headers=H)


def test_a_part_saved_as_a_template(client: TestClient) -> None:
    body = {"id": "cmp:Standard parts/CL10B104KB85PNC 100nF 50V X7R 0603", "library": "AsTpl",
            "name": "My MLCC"}  # fmt: skip
    r = client.post("/api/library/components/as-template", json=body, headers=H)
    assert r.status_code == 200, r.text
    fields = {f["key"]: f for f in r.json()["fields"]}
    assert fields["Cnom"]["default"] == "100n" and fields["Cnom"]["unit"] == "F"
    assert r.json()["category"] in ("", "Capacitors/Ceramic")
    templates = {t["name"]: t for t in client.get("/api/components/templates", headers=H).json()}
    made = templates["tpl:AsTpl/My MLCC"]
    part = client.post(
        "/api/components/from-template",
        headers=H,
        json={
            "template": made["name"],
            "form": {"Cnom": "220n"},
            "library": "AsTpl",
            "name": "C220N",
        },
    )
    assert part.status_code == 200, part.text
    assert (
        client.post("/api/library/components/as-template", json=body, headers=H).status_code == 409
    )
    client.delete("/api/library/libraries/AsTpl", headers=H)


def test_a_part_redrawn_as_a_box_or_another_symbol(client: TestClient) -> None:
    body = {"template": "capacitor", "form": {"Cnom": "1u"}, "library": "Draw", "name": "C1U"}
    assert client.post("/api/components/from-template", json=body, headers=H).status_code == 200
    part = client.get("/api/library/components", headers=H).json()["cmp:Draw/C1U"]
    ports = [p["number"] for p in part["sheets"][0]["symbol"]["pins"]]
    box = client.post("/api/library/components/drawing", json={"id": "cmp:Draw/C1U"}, headers=H)
    assert box.status_code == 200, box.text
    assert box.json()["sheets"][0]["symbol"] is None and box.json()["version"] == 2
    symbols = {s["id"]: s for s in client.get("/api/library/symbols", headers=H).json()}
    assert len(symbols["cmp:Draw/C1U"]["pins"]) == 2  # still two pins, drawn as a box
    # A diode drawing: anode on the second port, cathode on the first.
    diode = [p["number"] for p in symbols["bpt:diode"]["pins"]]
    mapping = {diode[0]: ports[1], diode[1]: ports[0]}
    r = client.post(
        "/api/library/components/drawing",
        headers=H,
        json={"id": "cmp:Draw/C1U", "like": "bpt:diode", "pins": mapping},
    )
    assert r.status_code == 200, r.text
    assert [p["number"] for p in r.json()["sheets"][0]["symbol"]["pins"]] == [ports[1], ports[0]]
    bad = client.post(
        "/api/library/components/drawing", headers=H, json={"id": "cmp:Draw/C1U", "like": "bpt:npn"}
    )
    assert bad.status_code == 422
    client.delete("/api/library/libraries/Draw", headers=H)


def test_a_redrawn_part_keeps_its_drawing_when_saved_again(client: TestClient) -> None:
    body = {"template": "capacitor", "form": {"Cnom": "1u"}, "library": "Keep", "name": "C1U"}
    client.post("/api/components/from-template", json=body, headers=H)
    client.post("/api/library/components/drawing", json={"id": "cmp:Keep/C1U"}, headers=H)
    body["form"] = {"Cnom": "2u"}
    again = client.post("/api/components/from-template", json=body, headers=H).json()
    assert again["sheets"][0]["symbol"] is None  # still a box
    body["look"] = ""  # a look chosen in the editor: the template's drawing again
    chosen = client.post("/api/components/from-template", json=body, headers=H).json()
    assert chosen["sheets"][0]["symbol"] is not None
    client.delete("/api/library/libraries/Keep", headers=H)
