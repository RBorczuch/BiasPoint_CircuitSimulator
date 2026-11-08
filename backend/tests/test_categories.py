"""Categories of parts (docs/projekt-elementy.md §3): assignment and the data of each."""

from bpt.api.components import templates
from bpt.api.library import categories, symbols
from bpt.library.categories import BY_PATH, CATEGORIES, component_category, template_category


def test_every_category_has_its_parent_and_unique_fields() -> None:
    for c in CATEGORIES:
        if "/" in c.path:
            assert c.path.split("/")[0] in BY_PATH, c.path
        keys = [f.key for f in c.fields]
        assert len(keys) == len(set(keys)), c.path


def test_parts_and_templates_land_in_their_categories() -> None:
    by_id = {s.id: s for s in symbols()}
    assert by_id["bpt:resistor"].group == "Resistors"
    assert by_id["bpt:led"].group == "Diodes/LED"
    assert by_id["cmp:Standard parts/BC547B"].group == "Transistors/BJT NPN"
    assert by_id["cmp:Standard parts/LM358"].group == "Analog ICs/Op-amps"
    assert by_id["cmp:Standard examples/SS34"].group == "Diodes/Schottky"  # its own category
    mlcc = by_id["cmp:Standard parts/CL10B104KB85PNC 100nF 50V X7R 0603"]
    assert mlcc.group == "Capacitors/Ceramic" and mlcc.metadata["dielectric"] == "X7R"
    assert mlcc.ratings["voltage"] == "50"
    offered = {t.name: t.category for t in templates()}
    assert offered["mlcc"] == "Capacitors/Ceramic"
    assert offered["tpl:Standard templates/Op-amp macromodel"] == "Analog ICs/Op-amps"
    assert template_category("electrolytic") == "Capacitors/Aluminium electrolytic"
    assert component_category("", None, "transistor") == "Transistors"
    assert component_category("Power/Gate drivers", "mlcc", "ic") == "Power/Gate drivers"


def test_categories_api_lists_the_data_fields() -> None:
    ceramic = next(c for c in categories() if c.path == "Capacitors/Ceramic")
    dielectric = next(f for f in ceramic.fields if f.key == "dielectric")
    assert "C0G/NP0" in dielectric.options
    voltage = next(f for f in ceramic.fields if f.key == "voltage")
    assert voltage.source == "ratings" and voltage.type == "number"
