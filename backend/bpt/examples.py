"""Example projects shipped in ``examples/`` (regenerate with ``bpt examples``).

Each example is drawn like a person would draw it: parts on a grid, real wires, ground
symbols and named nets, with the analyses already set up.
"""

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from bpt.document.drawing import Drawing
from bpt.document.model import (
    Component,
    Graph,
    GraphEdge,
    GraphGroup,
    GraphNode,
    GraphNote,
    ModelCard,
    Project,
    Simulation,
)
from bpt.document.storage import save_project


@dataclass
class Example:
    name: str
    title: str
    description: str
    build: Callable[[], Project]


def _project(name: str, d: Drawing, active: str, **cards: str) -> Project:
    simulation = Simulation(active=active)  # type: ignore[arg-type]
    simulation.cards.update(cards)
    return Project(name=name, sheets=[d.sheet], simulation=simulation)


def rc_lowpass() -> Project:
    d = Drawing()
    d.part("vsource", "V1", (0, 0), dc="0", ac="1", tran="PULSE(0 1 0 1u 1u 5m 10m)")
    d.part("resistor", "R1", (1016, -1016), rot=270, R="1k")
    d.part("capacitor", "C1", (2032, 0), C="1u")
    d.wire(d.pin("V1", "+"), (0, -1016), d.pin("R1", "1"))
    d.wire(d.pin("R1", "2"), (2032, -1016), d.pin("C1", "1"))
    d.wire(d.pin("V1", "-"), (0, 762))
    d.wire(d.pin("C1", "2"), (2032, 762))
    d.gnd((0, 762))
    d.gnd((2032, 762))
    d.label("in", (254, -1016))
    d.label("out", (1778, -1016))
    return _project("rc_lowpass", d, "tran", tran=".tran 10u 20m", ac=".ac dec 20 1 100k",
                    dc=".dc V1 0 1 0.1")  # fmt: skip


def sallen_key() -> Project:
    d = Drawing()
    d.part("vsource", "V1", (0, 0), dc="0", ac="1", tran="SIN(0 1 1k)")
    d.part("resistor", "R1", (1016, -1016), rot=270, R="10k")
    d.part("resistor", "R2", (2540, -1016), rot=270, R="10k")
    d.part("capacitor", "C1", (3302, -1778), rot=270, C="22n")
    d.part("capacitor", "C2", (3302, 0), C="10n")
    d.part("opamp_ideal", "U1", (4064, -889))
    d.wire(d.pin("V1", "+"), (0, -1016), d.pin("R1", "1"))
    d.wire(d.pin("R1", "2"), d.pin("R2", "1"))
    d.wire(d.pin("R2", "2"), d.pin("U1", "+"))
    d.wire((3302, -1016), d.pin("C2", "1"))
    d.wire((1778, -1016), (1778, -1778), d.pin("C1", "1"))
    d.wire(d.pin("C1", "2"), (4826, -1778), (4826, -889))
    d.wire(d.pin("U1", "out"), (5207, -889))
    d.wire(d.pin("U1", "-"), (3556, -762), (3556, -508), (4826, -508), (4826, -889))
    d.wire(d.pin("V1", "-"), (0, 762))
    d.wire(d.pin("C2", "2"), (3302, 762))
    d.gnd((0, 762))
    d.gnd((3302, 762))
    d.label("in", (254, -1016))
    d.label("out", (5080, -889))
    return _project("sallen_key_lowpass", d, "ac", ac=".ac dec 50 10 100k",
                    tran=".tran 5u 5m")  # fmt: skip


# Parts the example makes like a user would in the part editor: an op-amp from its datasheet's
# typical values (Microchip MCP6002: 1 MHz, 0.6 V/us, rail-to-rail) and a class 2 ceramic
# capacitor whose capacitance falls with DC bias (half at 6.3 V, typical of a small X7R).
MCP6002_FORM = {"aol": "400k", "gbw": "1meg", "sr": "600k", "vos": "1m", "ib": "1p",
                "cmrr": "76", "psrr": "86", "vohigh": "25m", "volow": "25m", "iout": "23m",
                "iq": "100u"}  # fmt: skip
X7R_FORM = {"Cnom": "10n", "vhalf": "6.3"}  # ESR and ESL as the template has them


def real_parts() -> list[Component]:
    """The MCP6002 and the 10 nF X7R capacitor of ``filter_design_check`` ("My parts")."""
    from bpt.models import templates as tpl
    from bpt.models.standard_templates import standard_templates
    from bpt.models.user_templates import component_from_template

    opamp = next(t for t in standard_templates() if t.name == "Op-amp macromodel")
    mcp = component_from_template(
        opamp, MCP6002_FORM, "My parts", "MCP6002",
        description="1 MHz rail-to-rail CMOS op-amp, 1.8-6 V (typical datasheet values)",
        metadata={"manufacturer": "Microchip", "part_number": "MCP6002"},
    )  # fmt: skip
    x7r = tpl.template_component(tpl.get("mlcc"), X7R_FORM, "My parts", "10nF X7R 0402")
    return [mcp, x7r]


def filter_design_check() -> Project:
    """The Sallen-Key filter checked by one analysis graph: the design formula against the
    simulation, the spread of a production batch (Monte Carlo with a yield), what C2 does, and
    the same filter built of real parts (an op-amp and an X7R capacitor made from datasheets)."""
    from bpt.graph.catalog import CATALOG
    from bpt.library.components import component_sheets

    d = Drawing()
    d.part("vsource", "V1", (0, 0), dc="2.5", ac="1", tran="SIN(2.5 1 1k)")
    d.part("vsource", "V2", (-1016, 0), dc="5")
    project = Project(name="filter_design_check", sheets=[d.sheet])
    mcp, x7r = real_parts()
    _top, mcp_sheets = component_sheets(project, mcp)
    project.sheets += mcp_sheets
    _top, x7r_sheets = component_sheets(project, x7r)
    real = 3302  # the real filter: the same drawing lower down
    for dy, (r1, r2, c1, c2, u) in ((0, ("R1", "R2", "C1", "C2", "U1")),
                                    (real, ("R3", "R4", "C3", "C4", "U2"))):  # fmt: skip
        d.part("resistor", r1, (1016, -1016 + dy), rot=270, R="10k")
        d.part("resistor", r2, (2540, -1016 + dy), rot=270, R="10k")
        d.part("capacitor", c1, (3302, -1778 + dy), rot=270, C="22n")
        if dy == 0:
            d.part("capacitor", c2, (3302, 0), C="10n")
            d.part("opamp_ideal", u, (4064, -889))
        else:
            d.block(x7r_sheets[0], c2, (3302, dy))
            d.block(mcp_sheets[0], u, (4064, -889 + dy))
        fb = -508 if dy == 0 else 0  # the real op-amp's V- pin is where the ideal one has none
        d.wire(d.pin(r1, "2"), d.pin(r2, "1"))
        d.wire(d.pin(r2, "2"), d.pin(u, "+"))
        d.wire((3302, -1016 + dy), d.pin(c2, "1"))
        d.wire((1778, -1016 + dy), (1778, -1778 + dy), d.pin(c1, "1"))
        d.wire(d.pin(c1, "2"), (4826, -1778 + dy), (4826, -889 + dy))
        d.wire(d.pin(u, "out"), (5207, -889 + dy))
        d.wire(d.pin(u, "-"), (3556, -762 + dy), (3556, fb + dy), (4826, fb + dy),
               (4826, -889 + dy))  # fmt: skip
        d.wire(d.pin(c2, "2"), (3302, 762 + dy))
        d.gnd((3302, 762 + dy))
    d.wire(d.pin("V1", "+"), (0, -1016), d.pin("R1", "1"))
    d.wire(d.pin("R3", "1"), (508, -1016 + real))
    d.wire(d.pin("V1", "-"), (0, 762))
    d.gnd((0, 762))
    d.wire(d.pin("V2", "-"), (-1016, 762))
    d.gnd((-1016, 762))
    d.wire(d.pin("V2", "+"), (-1016, -508))
    d.power("VCC", (-1016, -508))
    d.wire(d.pin("U2", "V+"), (4064, 1778))
    d.power("VCC", (4064, 1778))
    d.wire(d.pin("U2", "V-"), (4064, 3048))
    d.gnd((4064, 3048))
    d.label("in", (254, -1016))
    d.label("in", (508, -1016 + real))
    d.label("out", (5080, -889))
    d.label("out_real", (5080, -889 + real))
    project = _project("filter_design_check", d, "ac", ac=".ac dec 50 10 1meg",
                       tran=".tran 5u 5m")  # fmt: skip
    project.sheets += mcp_sheets + x7r_sheets

    def n(id_: str, type_: str, x: float, y: float, title: str = "", **params: Any) -> GraphNode:
        return GraphNode(id=id_, type=type_, version=CATALOG[type_].version, title=title,
                         pos=(x, y), params=params)  # fmt: skip

    def e(source: str, output: str, target: str, input_: str) -> GraphEdge:
        return GraphEdge(source=source, output=output, target=target, input=input_)

    ac: dict[str, Any] = {"points": 50, "start": "10 Hz", "stop": "100 kHz"}
    nodes = [
        # 1. The design formula against the simulation
        n("circuit", "core/circuit", 0, 140),
        n("ac", "sim/ac", 380, 100, **ac),
        n("vout", "core/signal", 760, 100, expr="V(out)"),
        n("measure", "measure/basic", 1140, 0, "Simulated response", op="f3db, max"),
        n("results", "view/table", 1520, 0, "Simulated"),
        n("bode", "view/plot", 1520, 230, "Bode plot", complex="bode", lines="-3 dB; 0 dB"),
        n("r", "math/number", 0, 420, value="10 kΩ", name="R1 = R2"),
        n("c1", "math/number", 0, 580, value="22 nF", name="C1"),
        n("c2", "math/number", 0, 740, value="10 nF", name="C2"),
        n(
            "f0",
            "view/equation",
            380,
            560,
            "Design formula",
            expr="1/(2*pi*sqrt(a*a*b*c))",
            unit="Hz",
            name="f0",
        ),
        # 2. A production batch: parts within their tolerance
        n(
            "mc",
            "core/montecarlo",
            380,
            1260,
            "Batch of 200 filters",
            tolerances="R* ±1%; C* ±5%",
            runs=200,
        ),
        n("ac_mc", "sim/ac", 760, 1260, **ac),
        n("vout_mc", "core/signal", 1140, 1260, expr="V(out)"),
        n("fc_mc", "measure/basic", 1520, 1260, "f-3dB of each", op="f3db"),
        n("spread", "view/histogram", 1900, 1180, "Spread of f-3dB", bins=16),
        n("spec", "view/spec", 1900, 1520, "Requirement 1.10-1.20 kHz", condition="1.1k..1.2k"),
        n("bode_mc", "view/plot", 1140, 1500, "All 200 responses"),
        # 3. What C2 does
        n("sweep", "core/sweep", 380, 2400, "C2 values", name="C2", values="4.7n 10n 22n 47n"),
        n("ac_sw", "sim/ac", 760, 2300, **ac),
        n("vout_sw", "core/signal", 1140, 2300, expr="V(out)"),
        n("bode_sw", "view/plot", 1520, 2240, "Response for each C2"),
        n("fc_sw", "measure/basic", 1140, 2600, "f-3dB and peak", op="f3db, max"),
        n("make_sw", "table/make", 1900, 2600, name="against C2"),
        n("table_sw", "view/table", 1900, 2780, "f-3dB and peak against C2"),
        # 4. The same filter of real parts
        n("ac_real", "sim/ac", 380, 3360, "AC to 1 MHz", points=50, start="10 Hz", stop="1 MHz"),
        n("both", "core/signal", 760, 3360, "Ideal and real", expr="V(out); V(out_real)"),
        n("bode_real", "view/plot", 1140, 3300, "Ideal against real parts", lines="-3 dB"),
        n("fc_real", "measure/basic", 1520, 3300, "f-3dB, peak, deepest", op="f3db, max, min"),
        n("make_real", "table/make", 1900, 3300, name="ideal / real"),
        n("table_real", "view/table", 1900, 3480, "Ideal against real"),
        n("cnom", "math/number", 380, 3820, value="10 nF", name="C2 (X7R) nominal"),
        n("bias", "math/number", 380, 3980, value="2.5 V", name="DC across C2"),
        n("vhalf", "math/number", 380, 4140, value="6.3 V", name="V½ of the X7R"),
        n(
            "c_bias",
            "view/equation",
            760,
            3900,
            "C2 under bias",
            expr="a/(1+(b/c)^2)",
            unit="F",
            name="C2 at 2.5 V",
        ),
    ]
    edges = [
        e("circuit", "circuit", "ac", "circuit"),
        e("ac", "run", "vout", "run"),
        e("vout", "signal", "measure", "signal"),
        e("measure", "table", "results", "table"),
        e("vout", "signal", "bode", "signals"),
        e("r", "value", "f0", "a"),
        e("c1", "value", "f0", "b"),
        e("c2", "value", "f0", "c"),
        e("circuit", "circuit", "mc", "circuit"),
        e("mc", "circuit", "ac_mc", "circuit"),
        e("ac_mc", "run", "vout_mc", "run"),
        e("vout_mc", "signal", "fc_mc", "signal"),
        e("fc_mc", "value", "spread", "values"),
        e("fc_mc", "value", "spec", "value"),
        e("vout_mc", "signal", "bode_mc", "signals"),
        e("circuit", "circuit", "ac_sw", "circuit"),
        e("sweep", "params", "ac_sw", "params"),
        e("ac_sw", "run", "vout_sw", "run"),
        e("vout_sw", "signal", "bode_sw", "signals"),
        e("vout_sw", "signal", "fc_sw", "signal"),
        e("fc_sw", "value", "make_sw", "values"),
        e("fc_sw", "max", "make_sw", "values"),
        e("make_sw", "table", "table_sw", "table"),
        e("circuit", "circuit", "ac_real", "circuit"),
        e("ac_real", "run", "both", "run"),
        e("both", "signals", "bode_real", "signals"),
        e("both", "signals", "fc_real", "signal"),
        e("fc_real", "value", "make_real", "values"),
        e("fc_real", "max", "make_real", "values"),
        e("fc_real", "min", "make_real", "values"),
        e("make_real", "table", "table_real", "table"),
        e("cnom", "value", "c_bias", "a"),
        e("bias", "value", "c_bias", "b"),
        e("vhalf", "value", "c_bias", "c"),
    ]
    groups = [
        GraphGroup(id="g1", title="1 · Design formula against the simulation", color="violet",
                   rect=(-40, -80, 2000, 1000)),
        GraphGroup(id="g2", title="2 · A production batch: R ±1 %, C ±5 %", color="sky",
                   rect=(340, 1100, 2000, 1000)),
        GraphGroup(id="g3", title="3 · What C2 does", color="emerald",
                   rect=(340, 2160, 2000, 960)),
        GraphGroup(id="g4", title="4 · Real parts: an MCP6002 and an X7R capacitor",
                   color="amber", rect=(340, 3220, 2000, 1160)),
    ]  # fmt: skip
    notes = [
        GraphNote(id="n1", pos=(-40, 960), size=(360, 120), text=(
            "The textbook formula gives f0. The simulation shows the -3 dB frequency is higher: "
            "Q = 0.74, not 0.707, so the response peaks a little before it falls.")),
        GraphNote(id="n2", pos=(0, 1300), size=(320, 140), text=(
            "200 filters with parts drawn within their tolerance. The histogram shows the spread "
            "of f-3dB, the requirement how many of them meet 1.10-1.20 kHz (the yield).")),
        GraphNote(id="n3", pos=(0, 2600), size=(320, 120), text=(
            "C2 swept through four values: one curve each, and a table of f-3dB and the peak. "
            "A smaller C2 raises fc and Q (the response peaks); a larger one flattens it.")),
        GraphNote(id="n4", pos=(0, 3500), size=(320, 220), text=(
            "The same filter of real parts made in the part editor: an MCP6002 op-amp from its "
            "datasheet and a 10 nF X7R capacitor that loses capacitance under DC bias. C2 sees "
            "2.5 V, so f-3dB moves up by about 15 %. Above 70 kHz the op-amp runs out of gain "
            "and the signal leaks through C1: the real filter stops at about -67 dB and rises "
            "again, the ideal one keeps falling.")),
    ]  # fmt: skip
    project.graphs = [Graph(name="Design check", nodes=nodes, edges=edges, groups=groups,
                            notes=notes)]  # fmt: skip
    return project


def ce_amplifier() -> Project:
    d = Drawing()
    d.part("vsource", "VCC", (-2032, 381), dc="12")
    d.part("vsource", "V1", (-1016, 381), dc="0", ac="1", tran="SIN(0 100m 1k)")
    d.part("capacitor", "CIN", (0, 0), rot=270, C="10u")
    d.part("resistor", "R1", (508, -1016), R="47k")
    d.part("resistor", "R2", (508, 1016), R="10k")
    d.part("resistor", "RC", (1270, -1016), R="4.7k")
    d.part("resistor", "RE", (1270, 1016), R="1k")
    d.part("npn", "Q1", (1270, 0), model="Q2N3904")
    # Supply
    d.wire(d.pin("VCC", "+"), (-2032, -254))
    d.power("VCC", (-2032, -254))
    d.wire(d.pin("VCC", "-"), (-2032, 1016))
    d.gnd((-2032, 1016))
    # Input and coupling capacitor
    d.wire(d.pin("V1", "+"), d.pin("CIN", "1"))
    d.wire(d.pin("V1", "-"), (-1016, 1016))
    d.gnd((-1016, 1016))
    d.wire(d.pin("CIN", "2"), (508, 0))
    # Bias divider and base
    d.wire(d.pin("R1", "2"), (508, 0))
    d.wire((508, 0), d.pin("R2", "1"))
    d.wire((508, 0), d.pin("Q1", "B"))
    d.wire(d.pin("R1", "1"), (508, -1651))
    d.power("VCC", (508, -1651))
    d.wire(d.pin("R2", "2"), (508, 1651))
    d.gnd((508, 1651))
    # Collector and emitter
    d.wire(d.pin("RC", "2"), d.pin("Q1", "C"))
    d.wire(d.pin("RC", "1"), (1270, -1651))
    d.power("VCC", (1270, -1651))
    d.wire(d.pin("Q1", "E"), d.pin("RE", "1"))
    d.wire(d.pin("RE", "2"), (1270, 1651))
    d.gnd((1270, 1651))
    d.wire((1270, -508), (2032, -508))
    d.label("in", (-635, 0))
    d.label("out", (1778, -508))
    project = _project("ce_amplifier", d, "tran", tran=".tran 10u 5m", ac=".ac dec 20 10 10meg",
                       dc=".dc VCC 0 15 0.1")  # fmt: skip
    project.models["Q2N3904"] = ModelCard(type="npn", params={
        "IS": "6.734f", "BF": "416.4", "NF": "1", "VAF": "74.03", "IKF": "66.78m",
        "ISE": "6.734f", "NE": "1.259", "BR": "0.7371", "RB": "10", "RC": "1",
        "CJE": "4.493p", "MJE": "0.2593", "VJE": "0.75", "CJC": "3.638p", "MJC": "0.3085",
        "VJC": "0.75", "TF": "301.2p", "TR": "239.5n",
    })  # fmt: skip
    return project


def half_wave_rectifier() -> Project:
    d = Drawing()
    d.part("vsource", "V1", (0, 0), dc="0", tran="SIN(0 10 50)")
    d.part("diode", "D1", (1016, -1016), rot=270)
    d.part("capacitor", "C1", (2032, 0), C="100u")
    d.part("resistor", "RL", (2794, 0), R="1k")
    d.wire(d.pin("V1", "+"), (0, -1016), d.pin("D1", "A"))
    d.wire(d.pin("D1", "K"), (2794, -1016), d.pin("RL", "1"))
    d.wire((2032, -1016), d.pin("C1", "1"))
    for ref, pin in (("V1", "-"), ("C1", "2"), ("RL", "2")):
        x, y = d.pin(ref, pin)
        d.wire((x, y), (x, y + 381))
        d.gnd((x, y + 381))
    d.label("in", (254, -1016))
    d.label("out", (2413, -1016))
    return _project("half_wave_rectifier", d, "tran", tran=".tran 50u 100m")


def lm2596_module() -> Project:
    """A project powered by a module, built of an IC, built of ideal parts (FR-CMP-6)."""
    from bpt.library.components import component_sheets
    from bpt.models.standard_components import MODULE_ID, standard_components

    module = next(c for c in standard_components() if c.id == MODULE_ID)
    d = Drawing()
    _top, sheets = component_sheets(Project(name="x", sheets=[d.sheet]), module)
    d.part("vsource", "V1", (0, 0), dc="0", tran="PWL(0 0 0.2m 12)")  # switched on at t = 0
    d.block(sheets[0], "U1", (2032, -1016), vout="5")
    d.part("resistor", "RL", (4064, 0), R="5")
    d.wire(d.pin("V1", "+"), (0, -1016), d.pin("U1", "IN+"))
    d.wire(d.pin("U1", "OUT+"), (4064, -1016), d.pin("RL", "1"))
    x, y = d.pin("U1", "GND")
    d.wire((x, y), (x, y + 254))
    d.gnd((x, y + 254))
    for ref, pin in (("V1", "-"), ("RL", "2")):
        x, y = d.pin(ref, pin)
        d.wire((x, y), (x, y + 381))
        d.gnd((x, y + 381))
    d.label("in", (508, -1016))
    d.label("out", (3556, -1016))
    project = _project("lm2596_module", d, "tran", tran=".tran 1u 5m 0 50n")
    project.sheets += sheets
    return project


EXAMPLES = [
    Example("rc_lowpass", "RC low-pass filter",
            "Step response and Bode plot of a first-order filter (fc = 159 Hz).", rc_lowpass),
    Example("sallen_key_lowpass", "Sallen-Key low-pass",
            "Second-order active filter with an ideal op-amp (fc ~ 1 kHz, Q ~ 0.74).", sallen_key),
    Example("filter_design_check", "Filter design check (analysis graph)",
            "The Sallen-Key filter checked by one graph: the design formula against the "
            "simulation, a Monte Carlo batch with its yield, and a sweep of C2.",
            filter_design_check),
    Example("ce_amplifier", "Common-emitter amplifier",
            "2N3904 stage with a divider bias; gain ~ RC/RE, AC response.", ce_amplifier),
    Example("half_wave_rectifier", "Half-wave rectifier",
            "Diode, reservoir capacitor and load: ripple of a 50 Hz supply.",
            half_wave_rectifier),
    Example("lm2596_module", "LM2596 step-down module",
            "12 V to 5 V at 1 A from a module made of an LM2596 IC and real parts; enter the "
            "module, then the IC, and probe inside.", lm2596_module),
]  # fmt: skip


def write_examples(root: Path) -> list[Path]:
    paths = []
    for example in EXAMPLES:
        path = root / f"{example.name}.bpt"
        save_project(example.build(), path)
        paths.append(path)
    return paths
