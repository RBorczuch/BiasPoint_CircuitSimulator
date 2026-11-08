import base64
import xml.etree.ElementTree as ET
from pathlib import Path

from fastapi.testclient import TestClient

from bpt.document.builder import import_netlist
from bpt.document.model import Project, Sheet
from bpt.library.builtin import builtin_symbols
from bpt.netlist.spice_parser import parse_netlist
from bpt.render import render_target, svg_to_png
from bpt.render.svg import _arc_path, render_sheet
from bpt.results.store import ResultStore
from tests.conftest import TOKEN

H = {"x-bpt-token": TOKEN}
PNG = b"\x89PNG\r\n\x1a\n"
CIRCUIT = """* RL
V1 in 0 DC 5
R1 in out 1k
L1 out 0 10m
"""


def _project() -> Project:
    project = Project(name="t", sheets=[Sheet(name="root")])
    import_netlist(project, parse_netlist(CIRCUIT)).apply(project)
    return project


def test_sheet_svg_is_valid_and_complete() -> None:
    svg = render_sheet(_project().sheets[0], builtin_symbols(), "dark")
    root = ET.fromstring(svg)
    texts = {t.text for t in root.iter("{http://www.w3.org/2000/svg}text")}
    assert {"V1", "R1", "L1", "1k", "10m", "DC 5"} <= texts
    assert "#111113" in svg  # dark background
    assert not any(t and t.startswith("≈") for t in texts)  # all parts ideal


def test_non_ideal_parts_are_marked() -> None:
    project = _project()
    inductor = next(i for i in project.sheets[0].instances if i.ref == "L1")
    inductor.model.params["dcr"] = "0.5"
    root = ET.fromstring(render_sheet(project.sheets[0], builtin_symbols(), "light"))
    assert "≈ DCR" in {t.text for t in root.iter("{http://www.w3.org/2000/svg}text")}


def test_arc_through_three_points() -> None:
    # Half circle of radius 64 to the right of the y axis.
    assert _arc_path((0, -64), (64, 0), (0, 64)) == "M0,-64 A64,64 0 0 1 0,64"
    assert _arc_path((0, 0), (5, 0), (10, 0)) == "M0,0 L10,0"


def test_refs_target_frames_parts() -> None:
    project = _project()
    whole = render_target(project)
    part = render_target(project, "refs:r1")
    assert part.meta["refs"] == ["R1"] and set(whole.meta["refs"]) == {"V1", "R1", "L1"}
    assert part.meta["width_mm"] < whole.meta["width_mm"]
    assert svg_to_png(part.svg, 300).startswith(PNG)


def test_headless_capture_and_exports(client: TestClient) -> None:
    pid = client.post("/api/projects", json={"name": "rl"}, headers=H).json()["id"]
    client.post(f"/api/projects/{pid}/circuit/import", json={"text": CIRCUIT}, headers=H)

    shot = client.post("/api/capture", json={"project_id": pid, "max_px": 400}, headers=H)
    assert shot.status_code == 200
    body = shot.json()
    assert base64.b64decode(body["image"]).startswith(PNG)
    assert "headless" in body["description"] and "visible: L1, R1, V1" in body["description"]
    bad = client.post("/api/capture", json={"project_id": pid, "target": "refs:X9"}, headers=H)
    assert bad.status_code == 422

    svg = client.get(f"/api/projects/{pid}/export/schematic", headers=H)
    assert svg.headers["content-type"] == "image/svg+xml"
    assert 'filename="rl.svg"' in svg.headers["content-disposition"]
    png = client.get(f"/api/projects/{pid}/export/schematic?format=png&width=256", headers=H)
    assert png.content.startswith(PNG)
    netlist = client.get(f"/api/projects/{pid}/export/netlist", headers=H).text
    assert "R1 in out 1k" in netlist and netlist.rstrip().endswith(".end")


def _runs(store: ResultStore) -> tuple[str, str]:
    import numpy as np

    from bpt.analysis.spec import AcAnalysis, TranAnalysis

    tran = store.create(TranAnalysis(tstep="1u", tstop="1m"))
    t = np.linspace(0, 1e-3, 50_000)
    tran.add_signal("time", t, "s")
    tran.add_signal("V(out)", np.sin(2 * np.pi * 5e3 * t), "V")
    tran.meta.scale = "time"
    ac = store.create(AcAnalysis(points=10))
    f = np.logspace(1, 6, 51)
    ac.add_signal("frequency", f, "Hz")
    ac.add_signal("V(out)", 1 / (1 + 1j * f / 1e3), "V")
    ac.meta.scale = "frequency"
    return tran.finish().run_id, ac.finish().run_id


def test_plots_render_without_gui(client: TestClient, tmp_path: Path) -> None:
    from bpt.render.plot import nice_ticks, render_plot
    from bpt.results.store import ResultStore

    assert nice_ticks(0, 1) == [0, 0.2, 0.4, 0.6000000000000001, 0.8, 1.0]
    store = ResultStore(tmp_path)
    tran_id, ac_id = _runs(store)
    svg = render_plot(store.open(tran_id))
    root = ET.fromstring(svg)
    assert len(root.findall("{http://www.w3.org/2000/svg}polyline")) == 1
    assert "V(out)" in svg and "time [s]" in svg
    ac_svg = render_plot(store.open(ac_id))
    assert len(ET.fromstring(ac_svg).findall("{http://www.w3.org/2000/svg}polyline")) == 2
    assert svg_to_png(ac_svg, 400).startswith(PNG)

    # Through the agent's capture: the latest run of the project, or a chosen one.
    pid = client.post("/api/projects", json={"name": "plots"}, headers=H).json()["id"]
    state = client.app.state.bpt  # type: ignore[attr-defined]
    tran_id, ac_id = _runs(state.get(pid).results)
    shot = client.post("/api/capture", json={"project_id": pid, "target": "plot"}, headers=H)
    assert shot.status_code == 200, shot.text
    assert f"run {ac_id} (ac)" in shot.json()["description"]
    chosen = client.post("/api/capture", json={"project_id": pid,
                         "target": f"plot:{tran_id}:V(out)"}, headers=H)  # fmt: skip
    assert chosen.status_code == 200 and "(tran)" in chosen.json()["description"]
    bad = client.post("/api/capture", json={"project_id": pid, "target": f"plot:{tran_id}:V(x)"},
                      headers=H)  # fmt: skip
    assert bad.status_code == 422


def test_png_of_a_very_tall_drawing_is_bounded() -> None:
    """A tall schematic at 8192 px once needed 17 GB: the allocation aborted the backend."""
    import struct

    from bpt.render import svg_to_png

    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50000" width="100" '
           'height="50000"><rect width="100" height="50000" fill="red"/></svg>')  # fmt: skip
    png = svg_to_png(svg, 8192)
    width, height = struct.unpack(">II", png[16:24])
    assert height <= 16384 and width * height <= 40_000_000


def test_rotated_labels_and_corrected_symbols() -> None:
    """A label turned 90 / 270 degrees reads along the wire; real parts show their value or
    part name; electrolytics are drawn polarized and the SS34 as a Schottky diode."""
    from bpt.document.model import Instance, Label, Sheet
    from bpt.library.blocks import component_symbol
    from bpt.library.builtin import builtin_symbols
    from bpt.library.libraries import all_components
    from bpt.render.svg import label_box, render_sheet

    up = Label(kind="global", text="VOUT", at=(0, 0), rot=270)
    box = label_box(up)
    assert box.max_y - box.min_y > box.max_x - box.min_x  # tall, not wide
    svg = render_sheet(Sheet(name="s", labels=[up]), builtin_symbols())
    assert 'transform="rotate(-90 ' in svg

    components = all_components()
    symbols = dict(builtin_symbols())
    sheet = Sheet(name="parts")
    for k, (name, value) in enumerate([("Standard parts/UPW1C102MPD 1000uF 16V", "1000u"),
                                       ("Standard parts/1N4148", "1N4148")]):  # fmt: skip
        symbol = component_symbol(components[f"cmp:{name}"])
        assert symbol is not None
        symbols[symbol.id] = symbol
        sheet.instances.append(Instance(ref=f"X{k}", symbol=symbol.id, at=(k * 2540, 0)))
        assert f">{value}<" in render_sheet(sheet, symbols)
    capacitor = component_symbol(components["cmp:Standard parts/UPW1C102MPD 1000uF 16V"])
    assert capacitor is not None and any(getattr(g, "text", "") == "+" for g in capacitor.graphics)
    ss34 = component_symbol(components["cmp:Standard examples/SS34"])
    schottky = next(lk for lk in builtin_symbols()["bpt:diode"].looks if lk.name == "schottky")
    assert ss34 is not None and ss34.graphics == schottky.graphics


def test_sources_drawn_by_their_waveform() -> None:
    """A sine source shows a sine unless a look was chosen; the cell and battery are offered."""
    from bpt.library.builtin import builtin_symbols

    vsource = builtin_symbols()["bpt:vsource"]
    sine = next(lk for lk in vsource.looks if lk.name == "sine")
    assert vsource.with_look(None, params={"tran": "SIN(0 1 1k)"}).graphics == sine.graphics
    assert vsource.with_look(None, params={"dc": "5"}).graphics == vsource.graphics
    assert vsource.with_look("cell", params={"tran": "SIN(0 1 1k)"}).graphics != sine.graphics
    names = {lk.name for lk in vsource.looks} | {
        lk.name for lk in builtin_symbols()["bpt:isource"].looks
    }
    assert {"cell", "battery", "arrow", "pulse", "two-circles", "two-circles-arrow"} <= names


def test_part_texts_put_by_hand() -> None:
    """A reference moved and turned by hand: undoable, exported where and as it was put."""
    from bpt.document.commands import UpdateInstance
    from bpt.document.model import Instance, Project, Sheet, TextPlace
    from bpt.library.builtin import builtin_symbols
    from bpt.render.svg import render_sheet

    r1 = Instance(ref="R1", symbol="bpt:resistor", at=(0, 0))
    project = Project(name="p", sheets=[Sheet(name="root", instances=[r1])])
    undo = UpdateInstance(id=r1.id, texts={"ref": TextPlace(at=(300, -400), rot=90)}).apply(project)
    placed = project.sheets[0].instances[0]
    assert placed.texts["ref"].rot == 90
    svg = render_sheet(project.sheets[0], builtin_symbols())
    assert 'x="300" y="-400"' in svg and "rotate(-90 300 -400)" in svg
    undo.apply(project)
    assert project.sheets[0].instances[0].texts == {}


def test_project_symbol_standard_draws_ansi_resistors() -> None:
    from bpt.document.commands import SetSymbolStandard

    project = _project()
    iec = render_target(project, "schematic").svg
    undo = SetSymbolStandard(standard="ansi").apply(project)
    ansi = render_target(project, "schematic").svg
    assert ansi != iec  # the resistor is a zigzag now
    undo.apply(project)
    assert project.symbol_standard is None and render_target(project, "schematic").svg == iec
