"""Template editor (docs/projekt-elementy.md §4.3): templates opened as sheets, saved back."""

from fastapi.testclient import TestClient

from tests.test_api import H


def test_a_builtin_template_opens_as_a_copy_and_saves_as_a_user_template(
    client: TestClient,
) -> None:
    pid = client.post("/api/projects", json={"name": "tpl"}, headers=H).json()["id"]
    opened = client.post(f"/api/projects/{pid}/templates/open", json={"template": "mlcc"},
                         headers=H)  # fmt: skip
    assert opened.status_code == 200, opened.text
    info = opened.json()
    assert info["library"] == "My templates" and info["category"] == "Capacitors/Ceramic"
    assert info["sheets"] == [info["sheet"]]  # what closing the editing may take away again
    doc = client.get(f"/api/projects/{pid}/document", headers=H).json()["project"]
    sheet = next(s for s in doc["sheets"] if s["name"] == info["sheet"])
    assert {"Cnom", "vhalf"} <= set(sheet["parameters"])
    assert next(f for f in sheet["form"] if f["key"] == "Cnom")["unit"] == "F"
    assert sorted({lb["text"] for lb in sheet["labels"] if lb["kind"] == "port"}) == ["1", "2"]

    # The form is edited on the sheet (one undo step), then the sheet saved as a template.
    form = [{**f, "label": "C at 0 V"} if f["key"] == "Cnom" else f for f in sheet["form"]]
    command = {"type": "set_sheet_form", "sheet": info["sheet"], "form": form}
    assert client.post(f"/api/projects/{pid}/commands", json={"command": command},
                       headers=H).status_code == 200  # fmt: skip
    body = {"project_id": pid, "sheet": info["sheet"], "library": "e2e", "name": "My MLCC",
            "kind": "capacitor", "fields": form, "symbol": "bpt:capacitor",
            "category": "Capacitors/Ceramic"}  # fmt: skip
    saved = client.post("/api/components/templates", json=body, headers=H)
    assert saved.status_code == 200, saved.text
    template = saved.json()
    assert template["category"] == "Capacitors/Ceramic"
    assert next(f for f in template["fields"] if f["key"] == "Cnom")["label"] == "C at 0 V"
    assert all(s["form"] == [] for s in template["sheets"])  # no draft in the library's copy
    offered = {t["name"]: t for t in client.get("/api/components/templates", headers=H).json()}
    assert offered["tpl:e2e/My MLCC"]["category"] == "Capacitors/Ceramic"

    # Opened again for editing: in place (its own library), with its form.
    again = client.post(f"/api/projects/{pid}/templates/open",
                        json={"template": "tpl:e2e/My MLCC"}, headers=H).json()  # fmt: skip
    assert again["library"] == "e2e" and again["name"] == "My MLCC"
    assert again["sheet"] != info["sheet"]  # a free name beside the first copy
    doc = client.get(f"/api/projects/{pid}/document", headers=H).json()["project"]
    ids = [s["id"] for s in doc["sheets"]]
    assert len(set(ids)) == len(ids)  # each copy its own sheet, not the same one twice


def test_templates_changed_in_place_or_as_new_ones_based_on_them(client: TestClient) -> None:
    """Open a model to change it (a new version) or to start a new one from it (a free name);
    standard, built-in and part circuits always open as new templates."""
    pid = client.post("/api/projects", json={"name": "models"}, headers=H).json()["id"]

    def open_(template: str, **extra: object) -> dict:
        r = client.post(f"/api/projects/{pid}/templates/open", headers=H,
                        json={"template": template, **extra})  # fmt: skip
        assert r.status_code == 200, r.text
        return dict(r.json())

    def save(sheet: str, name: str, **extra: object) -> object:
        body = {"project_id": pid, "sheet": sheet, "library": "e2e-models", "name": name,
                "kind": "capacitor", **extra}  # fmt: skip
        return client.post("/api/components/templates", json=body, headers=H)

    def parameters(sheet: str) -> dict:
        doc = client.get(f"/api/projects/{pid}/document", headers=H).json()["project"]
        return dict(next(s for s in doc["sheets"] if s["name"] == sheet)["parameters"])

    # A built-in one from the part editor's form: the typed values are the defaults.
    copy = open_("mlcc", form={"Cnom": "22u", "nothing": "1"})
    assert copy["editing"] == "" and copy["based_on"] == "MLCC class 2 (DC bias)"
    assert copy["name"] == "MLCC class 2 (DC bias) (copy)"
    assert parameters(copy["sheet"])["Cnom"] == "22u"
    assert save(copy["sheet"], "Bias MLCC", replace=False).json()["version"] == 1

    # Changed in place: the next save is a new version, with what changed.
    own = open_("tpl:e2e-models/Bias MLCC")
    assert (own["editing"], own["version"], own["based_on"]) == ("tpl:e2e-models/Bias MLCC", 1, "")
    command = {"type": "set_parameter", "sheet": own["sheet"], "name": "vhalf", "value": "4"}
    assert client.post(f"/api/projects/{pid}/commands", json={"command": command},
                       headers=H).status_code == 200  # fmt: skip
    again = save(own["sheet"], "Bias MLCC", changes="V½ from the 6.3 V curve").json()
    assert again["version"] == 2 and again["changes"] == "V½ from the 6.3 V curve"
    # A new one never overwrites a template of the same name.
    refused = save(own["sheet"], "Bias MLCC", replace=False)
    assert refused.status_code == 409, refused.text

    # Based on it: a free name, nothing edited in place.
    based = open_("tpl:e2e-models/Bias MLCC", as_new=True)
    assert (based["name"], based["editing"]) == ("Bias MLCC (copy)", "")
    assert parameters(based["sheet"])["vhalf"] == "4"
    # A standard template is read-only: a new one in the user's library.
    standard = open_("tpl:Standard templates/Real transformer")
    assert (standard["library"], standard["name"]) == ("My templates", "Real transformer (copy)")
    assert standard["editing"] == ""

    # A part's circuit: a new template, its values the form's defaults.
    made = client.post("/api/components/from-template", headers=H, json={
        "template": "tpl:e2e-models/Bias MLCC", "form": {"Cnom": "4.7u"}, "library": "e2e-models",
        "name": "GRM4U7"})  # fmt: skip
    assert made.status_code == 200, made.text
    part = open_("cmp:e2e-models/GRM4U7")
    assert (part["name"], part["editing"], part["based_on"]) == ("GRM4U7 (copy)", "", "GRM4U7")
    assert parameters(part["sheet"])["Cnom"] == "4.7u"
    client.delete("/api/library/libraries/e2e-models", headers=H)


def test_default_drawings_per_project_and_for_new_parts_everywhere(client: TestClient) -> None:
    """Symbol editor (§4.4): a project's drawing of a symbol (undoable); one user drawing per
    symbol that new parts get in every project."""
    from bpt.document.commands import SetDefaultLook
    from bpt.document.model import Project, Sheet

    project = Project(name="p", sheets=[Sheet(name="root")])
    undo = SetDefaultLook(symbol="bpt:resistor", look="project:Slim").apply(project)
    assert project.default_looks == {"bpt:resistor": "project:Slim"}
    undo.apply(project)
    assert project.default_looks == {}

    graphics = [{"kind": "rect", "start": [-50, -254], "end": [50, 254]}]
    for name in ("Slim", "Wide"):
        body = {"library": "e2e-looks", "target": "bpt:resistor", "name": name,
                "graphics": graphics, "default": True}  # fmt: skip
        assert client.post("/api/library/looks", json=body, headers=H).status_code == 200
    symbols = {s["id"]: s for s in client.get("/api/library/symbols", headers=H).json()}
    defaults = [lk["label"] for lk in symbols["bpt:resistor"]["looks"] if lk.get("default")]
    assert defaults == ["Wide"]  # the later one; the first is no longer the default


def test_every_field_of_the_built_in_forms_has_a_heading() -> None:
    """Forms read by group (docs/projekt-kreator.md §4.1): nothing falls out of its template's
    table, and the first heading is always what to fill in first."""
    from bpt.models import templates as tpl
    from bpt.models.standard_templates import standard_templates

    forms = {t.name: t.fields for t in tpl.TEMPLATES.values()}
    forms |= {t.name: t.fields for t in standard_templates()}
    assert len(forms) == 23
    for name, fields in forms.items():
        groups = [f.group for f in fields]
        assert all(groups), name
        assert groups[0] in ("Main", "Parasitics"), name  # (a package: parasitics are all it has)
    assert {f.key for f in forms["film"] if f.group == "Advanced"} == {"rda", "cda"}
