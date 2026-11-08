"""Parts from the plan's paths (docs/projekt-elementy.md §5): variants (Ś11), flattening (K6)."""

from fastapi.testclient import TestClient

from tests.test_api import H


def _command(client: TestClient, pid: str, command: dict[str, object]) -> None:
    r = client.post(f"/api/projects/{pid}/commands", json={"command": command}, headers=H)
    assert r.status_code == 200, r.text


def _sheet_with_ports(client: TestClient, pid: str, name: str, text: str,
                      parameters: dict[str, str] | None = None) -> None:  # fmt: skip
    """A sheet with the circuit ``text`` and a port on each of its nets 1 and 2."""
    sheet = {"name": name, "parameters": parameters or {}}
    _command(client, pid, {"type": "add_sheet", "sheet": sheet})
    r = client.post(f"/api/projects/{pid}/circuit/import", json={"text": text, "sheet": name},
                    headers=H)  # fmt: skip
    assert r.status_code == 200, r.text
    doc = client.get(f"/api/projects/{pid}/document", headers=H).json()["project"]
    sheet = next(s for s in doc["sheets"] if s["name"] == name)
    ports = [{"kind": "port", "text": lb["text"], "at": lb["at"]} for lb in sheet["labels"]
             if lb["text"] in ("1", "2")]  # fmt: skip
    _command(client, pid, {"type": "add_objects", "sheet": name, "labels": ports})


def test_a_variant_added_to_a_part_and_removed(client: TestClient) -> None:
    body = {"template": "electrolytic", "form": {"Cnom": "100u"}, "library": "Parts",
            "name": "E100U"}  # fmt: skip
    assert client.post("/api/components/from-template", json=body, headers=H).status_code == 200
    pid = client.post("/api/projects", json={"name": "v"}, headers=H).json()["id"]
    _sheet_with_ports(client, pid, "ideal", "C1 1 2 100u")
    add = {"id": "cmp:Parts/E100U", "project_id": pid, "sheet": "ideal", "label": "Ideal C",
           "faster": True}  # fmt: skip
    r = client.post("/api/library/components/variants", json=add, headers=H)
    assert r.status_code == 200, r.text
    part = r.json()
    assert [(v["label"], v["faster"]) for v in part["sheets"][0]["variants"]] == [("Ideal C", True)]
    assert part["version"] == 2
    symbols = {s["id"]: s for s in client.get("/api/library/symbols", headers=H).json()}
    offered = [v["label"] for v in symbols["cmp:Parts/E100U"]["variants"]]
    assert offered == ["Full model", "Ideal C"]  # "Simulate as"
    # Pins must match.
    _sheet_with_ports(client, pid, "odd", "R1 1 0 1k")
    bad = client.post("/api/library/components/variants",
                      json={**add, "sheet": "odd"}, headers=H)  # fmt: skip
    assert bad.status_code == 422
    name = part["sheets"][0]["variants"][0]["name"]
    gone = client.delete(f"/api/library/components/variants?id=cmp:Parts/E100U&name={name}",
                         headers=H).json()  # fmt: skip
    assert gone["sheets"][0]["variants"] == [] and len(gone["sheets"]) == 1


def test_flatten_puts_the_blocks_circuit_in_its_place(client: TestClient) -> None:
    pid = client.post("/api/projects", json={"name": "f"}, headers=H).json()["id"]
    _sheet_with_ports(client, pid, "rc", "R1 1 2 {Rx}\nC1 2 0 1n", {"Rx": "2k"})
    block = {"ref": "X1", "symbol": "sheet:rc", "at": [0, 0], "model": {"params": {"Rx": "3k"}}}
    _command(client, pid, {"type": "add_objects", "sheet": "root", "instances": [block]})
    doc = client.get(f"/api/projects/{pid}/document", headers=H).json()["project"]
    bid = next(i["id"] for i in doc["sheets"][0]["instances"] if i["symbol"] == "sheet:rc")
    r = client.post(f"/api/projects/{pid}/flatten", json={"sheet": "root", "id": bid}, headers=H)
    assert r.status_code == 200, r.text
    root = client.get(f"/api/projects/{pid}/document", headers=H).json()["project"]["sheets"][0]
    assert not any(i["symbol"] == "sheet:rc" for i in root["instances"])
    values = {i["symbol"]: i["model"]["params"] for i in root["instances"]}
    assert values["bpt:resistor"]["R"] == "{(3k)}"  # the block's value written in
    texts = {lb["text"] for lb in root["labels"]}
    assert {"X1_1", "X1_2"} <= texts  # the block's pins and its ports on the same nets
    netlist = client.get(f"/api/projects/{pid}/export/netlist", headers=H).text
    assert "sheet_rc" not in netlist.lower().split(".end")[0].split(".subckt")[0]
    client.post(f"/api/projects/{pid}/undo", headers=H)
    root = client.get(f"/api/projects/{pid}/document", headers=H).json()["project"]["sheets"][0]
    assert any(i["symbol"] == "sheet:rc" for i in root["instances"])
