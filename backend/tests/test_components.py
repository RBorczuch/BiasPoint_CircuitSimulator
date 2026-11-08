"""Library components (FR-CMP): save a sheet as a real part, place it, its sheets come along."""

from fastapi.testclient import TestClient

from bpt.library import libraries
from tests.test_api import H


def _capacitor_sheet(client: TestClient) -> str:
    """A project whose sheet "cap" is a capacitor with ESR between ports p and n."""
    pid = client.post("/api/projects", json={"name": "maker"}, headers=H).json()["id"]
    command = {"type": "add_sheet", "sheet": {"name": "cap"}}
    client.post(f"/api/projects/{pid}/commands", json={"command": command}, headers=H)
    text = "\n".join(["C1 p mid 10u", "R1 mid n 50m"])
    r = client.post(f"/api/projects/{pid}/circuit/import", json={"text": text, "sheet": "cap"},
                    headers=H)  # fmt: skip
    assert r.status_code == 200, r.text
    doc = client.get(f"/api/projects/{pid}/document", headers=H).json()["project"]
    cap = next(s for s in doc["sheets"] if s["name"] == "cap")
    ports = [{"kind": "port", "text": lb["text"], "at": lb["at"]} for lb in cap["labels"]
             if lb["text"] in ("p", "n")]  # fmt: skip
    command = {"type": "add_objects", "sheet": "cap", "labels": ports}
    client.post(f"/api/projects/{pid}/commands", json={"command": command}, headers=H)
    return pid


def test_save_place_and_simulate_a_component(client: TestClient) -> None:
    maker = _capacitor_sheet(client)
    body = {"project_id": maker, "sheet": "cap", "library": "Parts", "name": "CAP10U",
            "kind": "capacitor", "metadata": {"manufacturer": "ACME", "technology": "X7R"},
            "ratings": {"voltage": "16"}}  # fmt: skip
    saved = client.post("/api/library/components", json=body, headers=H)
    assert saved.status_code == 200, saved.text
    assert saved.json()["version"] == 1 and saved.json()["id"] == "cmp:Parts/CAP10U"
    symbols = {s["id"]: s for s in client.get("/api/library/symbols", headers=H).json()}
    part = symbols["cmp:Parts/CAP10U"]
    assert part["kind"] == "capacitor" and part["ref_prefix"] == "C"
    assert sorted(p["number"] for p in part["pins"]) == ["n", "p"]

    pid = client.post("/api/projects", json={"name": "user"}, headers=H).json()["id"]
    prep = client.post(f"/api/projects/{pid}/components/prepare", json={"id": "cmp:Parts/CAP10U"},
                       headers=H).json()  # fmt: skip
    assert prep["top"] == "CAP10U" and [s["owner"] for s in prep["sheets"]] == ["cmp:Parts/CAP10U"]
    assert prep["sheets"][0]["component"]["ratings"] == {"voltage": "16"}
    commands = [{"type": "add_sheet", "sheet": s} for s in prep["sheets"]]
    part = {"ref": "C?", "symbol": f"sheet:{prep['top']}", "at": [0, 0]}
    commands.append({"type": "add_objects", "sheet": "root", "instances": [part]})
    command = {"type": "transaction", "commands": commands}
    r = client.post(f"/api/projects/{pid}/commands", json={"command": command}, headers=H)
    assert r.status_code == 200, r.text
    netlist = client.get(f"/api/projects/{pid}/export/netlist", headers=H).text
    assert ".subckt sheet_cap10u" in netlist.lower() and "10u" in netlist and "50m" in netlist

    # Placed again: the same sheets are used.
    again = client.post(f"/api/projects/{pid}/components/prepare", json={"id": "cmp:Parts/CAP10U"},
                        headers=H).json()  # fmt: skip
    assert again == {"top": "CAP10U", "sheets": []}

    # A changed part is a new version of the component.
    body["description"] = "10 uF X7R with ESR"
    assert client.post("/api/library/components", json=body, headers=H).json()["version"] == 2
    assert libraries.all_components()["cmp:Parts/CAP10U"].version == 2


def test_a_sheet_without_ports_is_not_a_component(client: TestClient) -> None:
    pid = client.post("/api/projects", json={"name": "x"}, headers=H).json()["id"]
    body = {"project_id": pid, "sheet": "root", "library": "Parts", "name": "X"}
    assert client.post("/api/library/components", json=body, headers=H).status_code == 422


def test_make_a_copy_detaches_the_sheets(client: TestClient) -> None:
    from bpt.document.commands import DetachComponent
    from bpt.document.model import ComponentInfo, Project, Sheet

    info = ComponentInfo(id="cmp:L/X", name="X", kind="capacitor")
    project = Project(name="p", sheets=[Sheet(name="root"),
                      Sheet(name="X", owner="cmp:L/X", component=info)])  # fmt: skip
    inverse = DetachComponent(owner="cmp:L/X").apply(project)
    assert project.sheet("X").owner is None and project.sheet("X").component is None
    inverse.apply(project)
    assert project.sheet("X").owner == "cmp:L/X" and project.sheet("X").component == info


def test_a_placed_components_sheets_are_read_only_through_the_api(client: TestClient) -> None:
    """Agents and scripts cannot change a part's equivalent circuit without making a copy."""
    body = {"template": "capacitor", "form": {"Cnom": "1u"}, "library": "Parts", "name": "C1U"}
    assert client.post("/api/components/from-template", json=body, headers=H).status_code == 200
    pid = client.post("/api/projects", json={"name": "ro"}, headers=H).json()["id"]
    prep = client.post(f"/api/projects/{pid}/components/prepare", json={"id": "cmp:Parts/C1U"},
                       headers=H).json()  # fmt: skip
    command = {"type": "transaction", "commands": [{"type": "add_sheet", "sheet": s}
                                                   for s in prep["sheets"]]}  # fmt: skip
    assert client.post(f"/api/projects/{pid}/commands", json={"command": command},
                       headers=H).status_code == 200  # fmt: skip
    edit = {"type": "set_parameter", "sheet": prep["top"], "name": "Cnom", "value": "2u"}
    r = client.post(f"/api/projects/{pid}/commands", json={"command": edit}, headers=H)
    assert r.status_code == 409 and "make a copy" in r.text
    detach = {"type": "detach_component", "owner": "cmp:Parts/C1U"}
    client.post(f"/api/projects/{pid}/commands", json={"command": detach}, headers=H)
    r = client.post(f"/api/projects/{pid}/commands", json={"command": edit}, headers=H)
    assert r.status_code == 200


def test_a_module_keeps_the_ic_inside_it(client: TestClient) -> None:
    """FR-CMP-6: the standard LM2596 module holds the LM2596 IC as a part on every level."""
    from bpt.document.commands import DetachComponent
    from bpt.document.model import Project, Sheet
    from bpt.library.components import component_sheets
    from bpt.models.standard_components import IC_ID, MODULE_ID

    components = libraries.all_components()
    assert {IC_ID, MODULE_ID} <= set(components)
    symbols = {s["id"]: s for s in client.get("/api/library/symbols", headers=H).json()}
    assert symbols[MODULE_ID]["kind"] == "module" and symbols[IC_ID]["ref_prefix"] == "U"

    project = Project(name="p", sheets=[Sheet(name="root")])
    top, sheets = component_sheets(project, components[MODULE_ID])
    project.sheets += sheets
    inner = next(s for s in sheets if s.component is not None and s.component.id == IC_ID)
    assert all(s.owner == MODULE_ID for s in sheets)
    assert inner.component is not None and inner.component.id == IC_ID  # still the IC
    # The IC placed on its own gets its own sheets, not the module's.
    ic_top, ic_sheets = component_sheets(project, components[IC_ID])
    assert ic_sheets and ic_top != inner.name

    # Make a copy of the module: its sheet is editable, the IC inside stays a placed IC.
    inverse = DetachComponent(owner=MODULE_ID).apply(project)
    assert project.sheet(top).owner is None and project.sheet(top).component is None
    assert project.sheet(inner.name).owner == IC_ID
    inverse.apply(project)
    assert project.sheet(inner.name).owner == MODULE_ID
    assert project.sheet(inner.name).component.id == IC_ID  # type: ignore[union-attr]


def test_saving_a_module_keeps_the_identity_of_parts_inside() -> None:
    from bpt.document.model import ComponentInfo, Instance, Label, Project, Sheet
    from bpt.models.user_templates import collect_sheets

    ic = ComponentInfo(id="cmp:L/IC", name="IC", kind="ic")
    module = Sheet(name="mod", instances=[Instance(ref="U1", symbol="sheet:IC", at=(0, 0))],
                   labels=[Label(kind="port", text="a", at=(0, 0))])  # fmt: skip
    project = Project(name="p", sheets=[Sheet(name="root"), module,
                      Sheet(name="IC", owner="cmp:L/IC", component=ic)])  # fmt: skip
    saved = collect_sheets(project, "mod")
    assert [s.name for s in saved] == ["mod", "IC"]
    assert saved[0].component is None and saved[1].owner is None and saved[1].component == ic


def _place(client: TestClient, pid: str, cid: str) -> None:
    prep = client.post(f"/api/projects/{pid}/components/prepare", json={"id": cid},
                       headers=H).json()  # fmt: skip
    commands = [{"type": "add_sheet", "sheet": s} for s in prep["sheets"]]
    part = {"ref": "C?", "symbol": f"sheet:{prep['top']}", "at": [0, 0]}
    commands.append({"type": "add_objects", "sheet": "root", "instances": [part]})
    r = client.post(f"/api/projects/{pid}/commands",
                    json={"command": {"type": "transaction", "commands": commands}},
                    headers=H)  # fmt: skip
    assert r.status_code == 200, r.text


def test_edit_a_part_and_update_the_placed_ones(client: TestClient) -> None:
    """Part editor (docs/projekt-elementy.md §4.2): a new version from the template form, its
    data edited alone, the placed parts updated in one undo step."""
    body = {"template": "electrolytic", "form": {"Cnom": "100u"}, "library": "Parts",
            "name": "E100U", "category": "Capacitors/Polymer",
            "look": "electrolytic-us"}  # fmt: skip
    saved = client.post("/api/components/from-template", json=body, headers=H).json()
    assert saved["category"] == "Capacitors/Polymer"
    us = next(lk for lk in saved["sheets"][0]["symbol"]["looks"] if lk["name"] == "electrolytic-us")
    assert saved["sheets"][0]["symbol"]["graphics"] == us["graphics"]
    pid = client.post("/api/projects", json={"name": "uses"}, headers=H).json()["id"]
    _place(client, pid, "cmp:Parts/E100U")

    body["form"] = {"Cnom": "220u"}
    assert client.post("/api/components/from-template", json=body, headers=H).json()["version"] == 2
    data = {"id": "cmp:Parts/E100U", "metadata": {"manufacturer": "ACME"}, "changes": "maker"}
    edited = client.patch("/api/library/components", json=data, headers=H).json()
    assert edited["version"] == 3 and edited["metadata"] == {"manufacturer": "ACME"}
    assert edited["template"]["values"]["Cnom"] == "220u"  # the circuit as it was
    assert [(h["version"], h["changes"]) for h in edited["history"]] == [(2, ""), (1, "")]

    placed = client.get(f"/api/projects/{pid}/components", headers=H).json()
    assert [(p["version"], p["library_version"], p["used"]) for p in placed] == [(1, 3, 1)]
    r = client.post(f"/api/projects/{pid}/components/update", json={"ids": ["cmp:Parts/E100U"]},
                    headers=H)  # fmt: skip
    assert r.status_code == 200, r.text
    placed = client.get(f"/api/projects/{pid}/components", headers=H).json()
    assert [(p["version"], p["used"]) for p in placed] == [(3, 1)]
    assert "220u" in client.get(f"/api/projects/{pid}/export/netlist", headers=H).text
    client.post(f"/api/projects/{pid}/undo", headers=H)
    placed = client.get(f"/api/projects/{pid}/components", headers=H).json()
    assert [(p["version"], p["used"]) for p in placed] == [(1, 1)]
