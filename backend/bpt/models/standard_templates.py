"""Example templates of the standard library (FR-CMP-9): one per kind of part a template can be.

* a real transformer: winding resistances, leakage (k < 1), core loss, interwinding
  capacitance around two coupled windings;
* an NPN transistor with its package: lead inductances and pad capacitances around the model;
* an op-amp macromodel (an IC): input resistance, gain stage with one pole, output resistance,
  output clamped to the supplies, supply current;
* semiconductors from their SPICE model parameters: diode, LED, Zener, NPN, PNP, N- and
  P-channel MOSFET, N- and P-channel JFET (defaults of common parts: 1N4148, red LED, 5V1 Zener,
  2N3904, 2N3906, a logic-level MOSFET, J201, J175). The model is a ``.model`` line on the sheet
  with the fields as parameters, so each part sets its own values; the card shows I-V,
  output and transfer characteristics computed from it.

They are built like any user template (a sheet with ports and parameters), only in code, so
they stay in step with the built-in symbols. The transformer, the packaged NPN and the op-amp are
drawn as schematics (parts wired together, internal nets named where expressions read them);
``CAPTIONS`` says in a few words what a part does when its value is a long expression.
"""

from functools import cache
from itertools import count

from bpt.document.builder import place_component
from bpt.document.model import (
    ComponentKind,
    Directive,
    Instance,
    Junction,
    Label,
    ModelRef,
    Point,
    Rotation,
    Sheet,
    TemplateField,
    TextPlace,
    UserTemplate,
    Wire,
)
from bpt.library.builtin import builtin_symbols
from bpt.models.user_templates import with_symbol_of
from bpt.netlist.connectivity import transform

G = 127
LIBRARY = "Standard templates"


class _Drawing:
    """A sheet drawn on the grid: parts, wires, ports and net labels at cell coordinates."""

    def __init__(self, name: str, ports: list[str], parameters: dict[str, str]) -> None:
        self.sheet = Sheet(name=name, parameters=parameters, port_order=ports)
        self.symbols = builtin_symbols()
        self.grounds = count(1)

    def part(self, ref: str, symbol: str, at: tuple[int, int], params: dict[str, str] | None = None,
             rot: Rotation = 0, flip: bool = False, left: bool = False,
             value_at: tuple[float, float] | None = None) -> dict[str, Point]:  # fmt: skip
        """Place a part; ``flip`` turns it upside down, ``left`` puts its texts on the left
        (mirrored), ``value_at`` moves its value (cells from the part). Returns its pins'
        positions (to check the wiring against)."""
        drawn = self.symbols[symbol]
        texts: dict[str, TextPlace] = {}
        if flip:  # the texts where an upright part has them, reference above the value
            for key, local in (("ref", drawn.ref_at), ("value", drawn.value_at)):
                if local is not None:
                    texts[key] = TextPlace(at=local)
        if value_at is not None:
            texts["value"] = TextPlace(at=(round(value_at[0] * G), round(value_at[1] * G)))
        inst = Instance(ref=ref, symbol=symbol, at=(at[0] * G, at[1] * G),
                        rot=180 if flip else rot, mirror=flip or left, texts=texts,
                        model=ModelRef(params=dict(params or {})))  # fmt: skip
        self.sheet.instances.append(inst)
        return {pin.number: transform(pin.at, inst) for pin in self.symbols[symbol].pins}

    def wire(self, *cells: tuple[int, int]) -> None:
        self.sheet.wires.append(Wire(points=[(x * G, y * G) for x, y in cells]))

    def port(self, name: str, at: tuple[int, int], rot: Rotation = 0) -> None:
        self.sheet.labels.append(Label(kind="port", text=name, at=(at[0] * G, at[1] * G), rot=rot))

    def net(self, name: str, at: tuple[int, int]) -> None:
        self.sheet.labels.append(Label(text=name, at=(at[0] * G, at[1] * G)))

    def ground(self, at: tuple[int, int]) -> None:
        self.sheet.instances.append(Instance(ref=f"#GND{next(self.grounds)}", symbol="bpt:gnd",
                                             at=(at[0] * G, at[1] * G)))  # fmt: skip

    def done(self, symbol: str) -> Sheet:
        """The sheet with junction dots where three wires meet (and the block's symbol)."""
        from bpt.render.svg import junction_dots

        self.sheet.junctions = [
            Junction(at=p) for p in sorted(junction_dots(self.sheet, self.symbols))
        ]
        return with_symbol_of(self.sheet, symbol)


def _at(pins: dict[str, Point], pin: str, cell: tuple[int, int]) -> None:
    """The wiring is drawn by cells: check a pin lands where it is wired to."""
    assert pins[pin] == (cell[0] * G, cell[1] * G), (pin, pins[pin], cell)


def _field(key: str, label: str, unit: str, default: str, description: str,
           required: bool = False) -> TemplateField:  # fmt: skip
    return TemplateField(key=key, label=label, unit=unit, default=default,
                         description=description, required=required)  # fmt: skip


def _transformer() -> UserTemplate:
    params = {"lp": "1m", "n": "0.5", "k": "0.995", "rp": "0.2", "rs": "0.05",
              "rcore": "50k", "cw": "20p"}  # fmt: skip
    d = _Drawing("real_transformer", ["P1", "P2", "S1", "S2"], params)
    # Primary: Rp in series, core loss across the winding; secondary: Rs in series; the
    # interwinding capacitance from the primary's top to the secondary's top.
    _at(d.part("R1", "bpt:resistor", (-11, -3), {"R": "{rp}"}, rot=270), "1", (-14, -3))
    _at(d.part("R2", "bpt:resistor", (-6, 0), {"R": "{rcore}"}, left=True), "1", (-6, -3))
    _at(d.part("T1", "bpt:transformer", (0, 0), {"lp": "{lp}", "ls": "{lp*n*n}", "k": "{k}"},
               value_at=(-3, 5)), "P1", (-3, -2))  # fmt: skip
    _at(d.part("R3", "bpt:resistor", (8, -3), {"R": "{rs}"}, rot=270), "1", (5, -3))
    _at(d.part("C1", "bpt:capacitor", (0, -7), {"C": "{cw}"}, rot=270), "1", (-3, -7))
    d.port("P1", (-19, -3), 180)
    d.port("P2", (-19, 3), 180)
    d.port("S1", (16, -3))
    d.port("S2", (16, 3))
    d.wire((-19, -3), (-14, -3))
    d.wire((-8, -3), (-4, -3), (-4, -2), (-3, -2))  # R2's top pin on it
    d.wire((-19, 3), (-4, 3), (-4, 2), (-3, 2))  # R2's bottom pin on it
    d.wire((3, -2), (4, -2), (4, -3), (5, -3))
    d.wire((11, -3), (16, -3))
    d.wire((3, 2), (4, 2), (4, 3), (16, 3))
    d.wire((-16, -3), (-16, -7), (-3, -7))
    d.wire((3, -7), (14, -7), (14, -3))
    fields = [
        _field("lp", "Lp", "H", "1m", "Primary (magnetizing) inductance", required=True),
        _field("n", "Ns/Np", "", "0.5", "Turns ratio, secondary to primary", required=True),
        _field("k", "k", "", "0.995", "Coupling; 1 - k sets the leakage inductance"),
        _field("rp", "Rp", "Ω", "0.2", "Primary winding resistance"),
        _field("rs", "Rs", "Ω", "0.05", "Secondary winding resistance"),
        _field("rcore", "R core", "Ω", "50k", "Core loss, across the primary"),
        _field("cw", "C winding", "F", "20p", "Capacitance between the windings"),
    ]
    return UserTemplate(id=f"tpl:{LIBRARY}/Real transformer", name="Real transformer",
                        kind="transformer", fields=fields,
                        description="Coupled windings with resistances, leakage, core loss and "
                        "interwinding capacitance",
                        sheets=[d.done("bpt:transformer")])  # fmt: skip


def _transistor() -> UserTemplate:
    params = {"lb": "2n", "lc": "1n", "le": "1.5n", "cbe": "0.1p", "cbc": "0.1p"}
    d = _Drawing("npn_package", ["C", "B", "E"], params)
    # Lead inductances in series with the three pins, pad capacitances outside them.
    _at(d.part("L1", "bpt:inductor", (-9, 0), {"L": "{lb}"}, rot=270), "1", (-12, 0))
    _at(d.part("L2", "bpt:inductor", (0, -7), {"L": "{lc}"}), "1", (0, -10))
    _at(d.part("L3", "bpt:inductor", (0, 7), {"L": "{le}"}), "1", (0, 4))
    _at(d.part("Q1", "bpt:npn", (0, 0)), "B", (-3, 0))
    _at(d.part("C1", "bpt:capacitor", (-14, 6), {"C": "{cbe}"}), "1", (-14, 3))
    _at(d.part("C2", "bpt:capacitor", (-14, -6), {"C": "{cbc}"}, flip=True), "1", (-14, -3))
    d.port("B", (-17, 0), 180)
    d.port("C", (0, -13))
    d.port("E", (0, 13))
    d.wire((-17, 0), (-12, 0))
    d.wire((-6, 0), (-3, 0))
    d.wire((0, -13), (0, -10))
    d.wire((0, -4), (0, -3))
    d.wire((0, 3), (0, 4))
    d.wire((0, 10), (0, 13))
    d.wire((-14, 0), (-14, 3))
    d.wire((-14, 9), (-14, 11), (0, 11))
    d.wire((-14, -3), (-14, 0))
    d.wire((-14, -9), (-14, -11), (0, -11))
    fields = [
        _field("lb", "L base", "H", "2n", "Base lead and bond wire inductance"),
        _field("lc", "L collector", "H", "1n", "Collector lead inductance"),
        _field("le", "L emitter", "H", "1.5n", "Emitter lead inductance (feedback at RF)"),
        _field("cbe", "C pads B-E", "F", "0.1p", "Package capacitance base-emitter"),
        _field("cbc", "C pads B-C", "F", "0.1p", "Package capacitance base-collector"),
    ]
    return UserTemplate(id=f"tpl:{LIBRARY}/NPN with package", name="NPN with package",
                        kind="transistor", fields=fields,
                        description="NPN model (choose it inside) with lead inductances and pad "
                        "capacitances of the package",
                        sheets=[d.done("bpt:npn")])  # fmt: skip


VT_TEXT = "0.025852"  # thermal voltage at 27 °C, in the circuit's expressions


def _hybrid_pi() -> UserTemplate:
    """The small-signal BJT at its bias point: rx into the inner base, rπ and Cπ to the emitter,
    Cμ to the collector, gm·vπ and ro from collector to emitter (gm = Ic/VT, rπ = β/gm,
    ro = VAF/Ic)."""
    params = {"ic": "1m", "beta": "200", "vaf": "100", "rx": "50", "cpi": "10p", "cmu": "2p"}
    d = _Drawing("hybrid_pi", ["C", "B", "E"], params)
    _at(d.part("Rx", "bpt:resistor", (-10, 0), {"R": "{rx}"}, rot=270), "1", (-13, 0))
    _at(d.part("Rpi", "bpt:resistor", (-4, 4), {"R": f"{{beta*{VT_TEXT}/ic}}"}), "1", (-4, 1))
    _at(d.part("Cpi", "bpt:capacitor", (0, 4), {"C": "{cpi}"}), "1", (0, 1))
    _at(d.part("Cmu", "bpt:capacitor", (4, -6), {"C": "{cmu}"}, rot=270), "1", (1, -6))
    pins = d.part("Gm", "bpt:vccs", (10, 4), {"gain": f"{{ic/{VT_TEXT}}}"})
    _at(pins, "in+", (7, 2))
    _at(pins, "out+", (13, 2))
    _at(d.part("Ro", "bpt:resistor", (17, 4), {"R": "{vaf/ic}"}), "1", (17, 1))
    d.port("B", (-16, 0), 180)
    d.port("C", (13, -10))
    d.port("E", (6, 12))
    d.net("bi", (-4, 0))
    # base: B, rx, the inner base node
    d.wire((-16, 0), (-13, 0))
    d.wire((-7, 0), (-4, 0))
    d.wire((-4, 0), (0, 0))
    d.wire((-4, 0), (-4, 1))
    d.wire((-4, -6), (-4, 0))
    d.wire((-4, -6), (1, -6))
    d.wire((0, 0), (0, 1))
    d.wire((0, 0), (5, 0), (5, 2), (7, 2))
    # collector
    d.wire((13, -10), (13, -6))
    d.wire((7, -6), (13, -6))
    d.wire((13, -6), (17, -6), (17, 1))
    d.wire((13, -6), (13, 2))
    # emitter
    d.wire((-4, 7), (-4, 9))
    d.wire((0, 7), (0, 9))
    d.wire((7, 6), (7, 9))
    d.wire((13, 6), (13, 9))
    d.wire((17, 7), (17, 9))
    d.wire((-4, 9), (0, 9))
    d.wire((0, 9), (6, 9))
    d.wire((6, 9), (7, 9))
    d.wire((7, 9), (13, 9))
    d.wire((13, 9), (17, 9))
    d.wire((6, 9), (6, 12))
    fields = [
        _field("ic", "Ic", "A", "1m", "Collector bias current (sets gm = Ic/VT)", required=True),
        _field("beta", "β", "", "200", "Small-signal current gain at that current", required=True),
        _field("vaf", "VAF", "V", "100", "Early voltage (ro = VAF/Ic)"),
        _field("rx", "rx", "Ω", "50", "Base spreading resistance"),
        _field("cpi", "Cπ", "F", "10p", "Base-emitter capacitance (diffusion and junction)"),
        _field("cmu", "Cμ", "F", "2p", "Base-collector capacitance (Cobo)"),
    ]
    return UserTemplate(id=f"tpl:{LIBRARY}/Hybrid-pi BJT (small signal)",
                        name="Hybrid-pi BJT (small signal)", kind="transistor", fields=fields,
                        description="A bipolar transistor around its bias point for AC analysis: "
                        "the gain falls with frequency to 1 at fT = gm / (2π(Cπ + Cμ))",
                        sheets=[d.done("bpt:npn")])  # fmt: skip


# Op-amp macromodel from datasheet values. The error voltage (offset, common-mode and supply
# terms added) drives a transconductance into an integrator: gm = 2 pi GBW C, its current limited
# to SR C (the slew rate), R = Aol / gm (the DC gain). The output follows the integrator through
# Rout, within the swing from the rails and the current limit, and that current comes from the
# supplies. Pins and supplies are read through 0 V sources: names like "+" or "V+" cannot appear
# in a behavioural expression.
_VD = ("V(inp,inn)+{vos}+(0.5*(V(inp)+V(inn))-V(mid))*pwr(10,-{cmrr}/20)"
       "+V(vcc,vee)*pwr(10,-{psrr}/20)")  # fmt: skip
_GM = "{sr*cint}*tanh(6.2832*{gbw*cint}*(" + _VD + ")/{sr*cint})"
_CLAMP = "max(V(n1)-V(vcc)+{vohigh},0)+min(V(n1)-V(vee)-{volow},0)"
_DRIVE = "{iout}*tanh((V(n1)-V(out))/{rout*iout})"


def _opamp() -> UserTemplate:
    params = {"aol": "200k", "gbw": "1meg", "sr": "1meg", "vos": "0", "ib": "0", "cmrr": "100",
              "psrr": "100", "vohigh": "1.5", "volow": "0.1", "iout": "40m", "iq": "1m",
              "rin": "10meg", "rout": "50", "cint": "1n"}  # fmt: skip
    d = _Drawing("opamp_macro", ["+", "-", "V+", "V-", "out"], params)
    # Left: the pins through 0 V sources (named nets inp, inn, vcc, vee), the input resistance
    # and bias currents. Middle: the gain stage between the nets mid and n1. Right: the supply
    # current and the output, sourced from V+ and sunk into V-.
    for ref, port, net, y in (("Vcc", "V+", "vcc", -14), ("Vp", "+", "inp", -4),
                              ("Vn", "-", "inn", 4), ("Vee", "V-", "vee", 14)):  # fmt: skip
        _at(d.part(ref, "bpt:vsource", (-17, y), {"dc": "0"}, rot=270), "+", (-20, y))
        d.port(port, (-22, y), 180)
        d.wire((-22, y), (-20, y))
        d.net(net, (-12, y))
    _at(d.part("Rin", "bpt:resistor", (-9, 0), {"R": "{rin}"}), "1", (-9, -3))
    _at(d.part("Ibp", "bpt:isource", (0, 6), {"dc": "{ib}"}), "+", (0, 3))
    _at(d.part("Ibn", "bpt:isource", (-5, 10), {"dc": "{ib}"}), "+", (-5, 7))
    _at(d.part("Bmid", "bpt:bsource", (8, 0), {"v": "0.5*(V(vcc)+V(vee))"}), "+", (8, -3))
    _at(d.part("Bgm", "bpt:bsource", (15, 0), {"i": _GM}), "+", (15, -3))
    _at(d.part("R1", "bpt:resistor", (22, 0), {"R": "{aol/(6.2832*gbw*cint)}"}, flip=True),
        "1", (22, 3))  # fmt: skip
    _at(d.part("C1", "bpt:capacitor", (29, 0), {"C": "{cint}"}, flip=True), "1", (29, 3))
    _at(d.part("Bcl", "bpt:bsource", (36, 0), {"i": _CLAMP}, flip=True), "+", (36, 3))
    _at(d.part("Iq", "bpt:isource", (45, 0), {"dc": "{iq}"}), "+", (45, -3))
    _at(d.part("Bsrc", "bpt:bsource", (55, -8), {"i": f"max({_DRIVE},0)"}), "+", (55, -11))
    _at(d.part("Bsnk", "bpt:bsource", (55, 8), {"i": f"max(-{_DRIVE},0)"}), "+", (55, 5))
    d.ground((8, 4))
    d.port("out", (61, 0))
    # Supplies (Iq and the output stage hang on them), inputs (Rin and the bias currents).
    d.wire((-14, -14), (55, -14), (55, -11))
    d.wire((-14, 14), (55, 14), (55, 11))
    d.wire((45, -14), (45, -3))
    d.wire((45, 3), (45, 14))
    d.wire((-14, -4), (0, -4), (0, 3))
    d.wire((-14, 4), (-5, 4), (-5, 7))
    d.wire((-9, -4), (-9, -3))
    d.wire((-9, 3), (-9, 4))
    d.wire((0, 9), (0, 14))
    d.wire((-5, 13), (-5, 14))
    # Gain stage: mid above, n1 below.
    d.wire((8, -3), (8, -4), (36, -4), (36, -3))
    for x in (15, 22, 29):
        d.wire((x, -4), (x, -3))
    d.wire((15, 3), (15, 4), (36, 4), (36, 3))
    for x in (22, 29):
        d.wire((x, 4), (x, 3))
    d.wire((8, 3), (8, 4))
    d.net("mid", (10, -4))
    d.net("n1", (17, 4))
    # Output.
    d.wire((55, -5), (55, 5))
    d.wire((55, 0), (61, 0))
    # Pins as on the op-amp symbol (and a fixed order: + - out V+ V-).
    d.sheet.port_sides = {"+": "left", "-": "left", "out": "right", "V+": "top", "V-": "bottom"}
    fields = [
        _field("aol", "Aol", "", "200k", "Open-loop DC gain (V/V; 100 dB = 100k)", required=True),
        _field("gbw", "GBW", "Hz", "1meg", "Gain-bandwidth product", required=True),
        _field("sr", "Slew rate", "V/s", "1meg", "Slew rate (1 V/µs = 1meg)"),
        _field("vos", "Vos", "V", "0", "Input offset voltage"),
        _field("ib", "Ib", "A", "0", "Input bias current (into each input)"),
        _field("cmrr", "CMRR", "dB", "100", "Common-mode rejection"),
        _field("psrr", "PSRR", "dB", "100", "Supply rejection"),
        _field("vohigh", "Swing to V+", "V", "1.5", "How close the output gets to V+"),
        _field("volow", "Swing to V-", "V", "0.1", "How close the output gets to V-"),
        _field("iout", "I out max", "A", "40m", "Output current limit (short circuit)"),
        _field("iq", "I supply", "A", "1m", "Quiescent supply current"),
        _field("rin", "R in", "Ω", "10meg", "Differential input resistance"),
        _field("rout", "R out", "Ω", "50", "Open-loop output resistance"),
    ]
    return UserTemplate(id=f"tpl:{LIBRARY}/Op-amp macromodel", name="Op-amp macromodel",
                        kind="ic", fields=fields,
                        description="Op-amp from its datasheet: gain, bandwidth, slew rate, "
                        "offset, bias current, CMRR, PSRR, output swing and current limit, supply "
                        "current (the output current comes from the supplies)",
                        sheets=[d.done("bpt:opamp")])  # fmt: skip


# What a part with a long expression for its value does, in a few words (the readable
# equivalent circuit); {key} is replaced by the field's value with its unit.
CAPTIONS: dict[str, dict[str, str]] = {
    f"tpl:{LIBRARY}/Real transformer": {"T1": "Lp {lp} · Ns/Np {n} · k {k}"},
    f"tpl:{LIBRARY}/Op-amp macromodel": {
        "Bmid": "V = mid", "Bgm": "I = gm·Vd", "Bcl": "I = clamp",
        "Bsrc": "I = source", "Bsnk": "I = sink",
    },
}  # fmt: skip


# Semiconductors: field key, label, unit, default, description, SPICE model parameter.
_Spec = tuple[str, str, str, str, str, str]


def _semiconductor(name: str, label: str, kind: ComponentKind, symbol: str, model_type: str,
                   specs: list[_Spec], description: str,
                   fixed: str = "") -> UserTemplate:  # fmt: skip
    """One device whose model parameters are the form; ports named like the symbol's pins."""
    ideal = builtin_symbols()[symbol]
    assert ideal.spice is not None
    pins = list(dict.fromkeys(ideal.spice.nodes))
    sheet = Sheet(name=name.lower().replace(" ", "_"),
                  parameters={key: default for key, _l, _u, default, _d, _s in specs})  # fmt: skip
    # Level 1 MOSFETs: W = L = 1 m keeps KP as written and makes CGSO / CGDO (per metre of
    # width) the capacitances themselves (ngspice's default 100 um width cut them 10 000 times).
    device = {"W": "1", "L": "1"} if model_type in ("NMOS", "PMOS") else {}
    add = place_component(ideal, "Q1" if kind == "transistor" else "D1", pins, (0, 0), device,
                          "devmodel")  # fmt: skip
    sheet.instances += add.instances
    sheet.wires += add.wires
    sheet.labels += [Label(kind="port", text=lb.text, at=lb.at, rot=lb.rot) for lb in add.labels]
    model = " ".join([fixed, *(f"{spice}={{{key}}}" for key, *_rest, spice in specs)]).strip()
    # Under the device and its pin labels (not across the lowest pin's name).
    below = max(lb.at[1] for lb in sheet.labels) + 4 * G
    sheet.directives.append(Directive(text=f".model devmodel {model_type}({model})",
                                      at=(-6 * G, max(6 * G, below))))  # fmt: skip
    sheet.port_order = pins
    fields = [_field(key, lbl, unit, default, desc) for key, lbl, unit, default, desc, _s in specs]
    return UserTemplate(id=f"tpl:{LIBRARY}/{label}", name=label, kind=kind, fields=fields,
                        description=description,
                        sheets=[with_symbol_of(sheet, symbol)])  # fmt: skip


_JUNCTION: list[_Spec] = [
    ("cjo", "Cj0", "F", "4p", "Junction capacitance at 0 V", "CJO"),
    ("vj", "Vj", "V", "0.75", "Junction potential", "VJ"),
    ("mj", "M", "", "0.333", "Grading coefficient of the junction capacitance", "M"),
]


def _semiconductors() -> list[UserTemplate]:
    return [
        _semiconductor("Diode", "Diode (signal)", "diode", "bpt:diode", "D", [
            ("is", "IS", "A", "2.52n", "Saturation current", "IS"),
            ("n", "N", "", "1.752", "Emission coefficient", "N"),
            ("rs", "RS", "Ω", "0.568", "Series resistance", "RS"),
            ("bv", "BV", "V", "100", "Reverse breakdown voltage", "BV"),
            ("ibv", "IBV", "A", "100u", "Current at the breakdown voltage", "IBV"),
            *_JUNCTION,
            ("tt", "TT", "s", "11.5n", "Transit time (reverse recovery)", "TT"),
        ], "Junction diode from its model parameters (defaults: 1N4148)"),
        _semiconductor("LED", "LED", "diode", "bpt:led", "D", [
            ("is", "IS", "A", "1e-21", "Saturation current (sets the forward voltage)", "IS"),
            ("n", "N", "", "1.6", "Emission coefficient", "N"),
            ("rs", "RS", "Ω", "2", "Series resistance", "RS"),
            ("bv", "BV", "V", "5", "Reverse breakdown voltage", "BV"),
            ("cjo", "Cj0", "F", "40p", "Junction capacitance at 0 V", "CJO"),
        ], "Light-emitting diode (defaults: red, about 1.9 V at 20 mA)", fixed="EG=1.9"),
        _semiconductor("Zener", "Zener diode", "diode", "bpt:zener", "D", [
            ("bv", "Vz", "V", "5.1", "Zener (breakdown) voltage", "BV"),
            ("ibv", "Iz", "A", "5m", "Current at the Zener voltage", "IBV"),
            ("rs", "RS", "Ω", "1", "Series resistance (sets the dynamic resistance)", "RS"),
            ("is", "IS", "A", "1e-14", "Saturation current", "IS"),
            ("n", "N", "", "1", "Emission coefficient", "N"),
            ("cjo", "Cj0", "F", "100p", "Junction capacitance at 0 V", "CJO"),
        ], "Zener diode (defaults: 5.1 V)"),
        _semiconductor("NPN", "NPN transistor", "transistor", "bpt:npn", "NPN", [
            ("is", "IS", "A", "6.734f", "Saturation current", "IS"),
            ("bf", "BF", "", "416.4", "Forward current gain (ideal maximum)", "BF"),
            ("vaf", "VAF", "V", "74.03", "Early voltage (output resistance)", "VAF"),
            ("ikf", "IKF", "A", "66.78m", "Corner of the high-current gain roll-off", "IKF"),
            ("ise", "ISE", "A", "6.734f", "Base-emitter leakage (gain falling at low current)",
             "ISE"),
            ("ne", "NE", "", "1.259", "Emission coefficient of that leakage", "NE"),
            ("br", "BR", "", "0.7371", "Reverse current gain", "BR"),
            ("rb", "RB", "Ω", "10", "Base resistance", "RB"),
            ("rc", "RC", "Ω", "1", "Collector resistance", "RC"),
            ("cje", "Cje", "F", "4.493p", "Base-emitter capacitance at 0 V", "CJE"),
            ("cjc", "Cjc", "F", "3.638p", "Base-collector capacitance at 0 V", "CJC"),
            ("tf", "TF", "s", "301.2p", "Forward transit time (sets fT)", "TF"),
        ], "Bipolar NPN transistor (Gummel-Poon; defaults: 2N3904)"),
        _semiconductor("PNP", "PNP transistor", "transistor", "bpt:pnp", "PNP", [
            ("is", "IS", "A", "1.41f", "Saturation current", "IS"),
            ("bf", "BF", "", "180.7", "Forward current gain (ideal maximum)", "BF"),
            ("vaf", "VAF", "V", "18.7", "Early voltage (output resistance)", "VAF"),
            ("ikf", "IKF", "A", "80m", "Corner of the high-current gain roll-off", "IKF"),
            ("ise", "ISE", "A", "0", "Base-emitter leakage (gain falling at low current)", "ISE"),
            ("ne", "NE", "", "1.5", "Emission coefficient of that leakage", "NE"),
            ("br", "BR", "", "4.977", "Reverse current gain", "BR"),
            ("rb", "RB", "Ω", "10", "Base resistance", "RB"),
            ("rc", "RC", "Ω", "2.5", "Collector resistance", "RC"),
            ("cje", "Cje", "F", "8.063p", "Base-emitter capacitance at 0 V", "CJE"),
            ("cjc", "Cjc", "F", "9.728p", "Base-collector capacitance at 0 V", "CJC"),
            ("tf", "TF", "s", "513.9p", "Forward transit time (sets fT)", "TF"),
        ], "Bipolar PNP transistor (Gummel-Poon; defaults: 2N3906)"),
        # Ebers-Moll: Gummel-Poon without what Ebers and Moll left out (no Early effect, no
        # high-injection roll-off, no leakage: SPICE's defaults for VAF, IKF and ISE).
        _semiconductor("NPNEM", "NPN transistor (Ebers-Moll)", "transistor", "bpt:npn", "NPN", [
            ("is", "IS", "A", "6.734f", "Saturation current", "IS"),
            ("bf", "BF", "", "200", "Forward current gain", "BF"),
            ("br", "BR", "", "5", "Reverse current gain", "BR"),
            ("rb", "RB", "Ω", "10", "Base resistance", "RB"),
            ("rc", "RC", "Ω", "1", "Collector resistance", "RC"),
            ("cje", "Cje", "F", "8p", "Base-emitter capacitance at 0 V", "CJE"),
            ("cjc", "Cjc", "F", "4p", "Base-collector capacitance at 0 V", "CJC"),
            ("tf", "TF", "s", "400p", "Forward transit time (sets fT)", "TF"),
        ], "Bipolar NPN transistor, Ebers-Moll: a constant gain, no Early effect (for hand "
           "calculations and teaching)"),
        _semiconductor("PNPEM", "PNP transistor (Ebers-Moll)", "transistor", "bpt:pnp", "PNP", [
            ("is", "IS", "A", "6.734f", "Saturation current", "IS"),
            ("bf", "BF", "", "200", "Forward current gain", "BF"),
            ("br", "BR", "", "5", "Reverse current gain", "BR"),
            ("rb", "RB", "Ω", "10", "Base resistance", "RB"),
            ("rc", "RC", "Ω", "1", "Collector resistance", "RC"),
            ("cje", "Cje", "F", "8p", "Base-emitter capacitance at 0 V", "CJE"),
            ("cjc", "Cjc", "F", "4p", "Base-collector capacitance at 0 V", "CJC"),
            ("tf", "TF", "s", "400p", "Forward transit time (sets fT)", "TF"),
        ], "Bipolar PNP transistor, Ebers-Moll: a constant gain, no Early effect"),
        _semiconductor("NMOS", "N-channel MOSFET", "transistor", "bpt:nmos", "NMOS", [
            ("vto", "Vth", "V", "1.6", "Threshold voltage", "VTO"),
            ("kp", "KP", "A/V²", "0.5", "Transconductance parameter (Id = KP/2·(Vgs-Vth)²)", "KP"),
            ("lambda", "λ", "1/V", "0.01", "Channel-length modulation (sets Rout)", "LAMBDA"),
            ("rd", "RD", "Ω", "0.05", "Drain resistance", "RD"),
            ("rs", "RS", "Ω", "0.02", "Source resistance", "RS"),
            ("cgso", "Cgs", "F", "200p", "Gate-source capacitance", "CGSO"),
            ("cgdo", "Cgd", "F", "50p", "Gate-drain (Miller) capacitance", "CGDO"),
            ("cbd", "Cds", "F", "100p", "Drain-source capacitance (Coss - Crss)", "CBD"),
        ], "Enhancement N-channel MOSFET, square law (level 1; defaults: logic-level part)",
           fixed="LEVEL=1"),
        _semiconductor("PMOS", "P-channel MOSFET", "transistor", "bpt:pmos", "PMOS", [
            ("vto", "Vth", "V", "-1.6", "Threshold voltage (negative)", "VTO"),
            ("kp", "KP", "A/V²", "0.25", "Transconductance parameter", "KP"),
            ("lambda", "λ", "1/V", "0.01", "Channel-length modulation", "LAMBDA"),
            ("rd", "RD", "Ω", "0.1", "Drain resistance", "RD"),
            ("rs", "RS", "Ω", "0.05", "Source resistance", "RS"),
            ("cgso", "Cgs", "F", "200p", "Gate-source capacitance", "CGSO"),
            ("cgdo", "Cgd", "F", "50p", "Gate-drain (Miller) capacitance", "CGDO"),
            ("cbd", "Cds", "F", "100p", "Drain-source capacitance (Coss - Crss)", "CBD"),
        ], "Enhancement P-channel MOSFET, square law (level 1)", fixed="LEVEL=1"),
        # Level 3 at W = L = 1 m: the square law with the mobility falling with the gate voltage
        # (THETA); its short-channel terms and KAPPA's channel-length modulation vanish there.
        _semiconductor("NMOS3", "N-channel MOSFET (level 3)", "transistor", "bpt:nmos", "NMOS", [
            ("vto", "Vth", "V", "1.6", "Threshold voltage", "VTO"),
            ("kp", "KP", "A/V²", "0.5", "Transconductance parameter at the threshold", "KP"),
            ("theta", "θ", "1/V", "0.1", "Mobility degradation (straightens Id(Vgs))", "THETA"),
            ("rd", "RD", "Ω", "0.05", "Drain resistance", "RD"),
            ("rs", "RS", "Ω", "0.02", "Source resistance", "RS"),
            ("cgso", "Cgs", "F", "200p", "Gate-source capacitance", "CGSO"),
            ("cgdo", "Cgd", "F", "50p", "Gate-drain (Miller) capacitance", "CGDO"),
            ("cbd", "Cds", "F", "100p", "Drain-source capacitance (Coss - Crss)", "CBD"),
        ], "Enhancement N-channel MOSFET with mobility degradation (level 3): for power parts, "
           "whose Id(Vgs) turns straight at high gate voltage", fixed="LEVEL=3"),
        _semiconductor("PMOS3", "P-channel MOSFET (level 3)", "transistor", "bpt:pmos", "PMOS", [
            ("vto", "Vth", "V", "-1.6", "Threshold voltage (negative)", "VTO"),
            ("kp", "KP", "A/V²", "0.25", "Transconductance parameter at the threshold", "KP"),
            ("theta", "θ", "1/V", "0.1", "Mobility degradation (straightens Id(Vgs))", "THETA"),
            ("rd", "RD", "Ω", "0.1", "Drain resistance", "RD"),
            ("rs", "RS", "Ω", "0.05", "Source resistance", "RS"),
            ("cgso", "Cgs", "F", "200p", "Gate-source capacitance", "CGSO"),
            ("cgdo", "Cgd", "F", "50p", "Gate-drain (Miller) capacitance", "CGDO"),
            ("cbd", "Cds", "F", "100p", "Drain-source capacitance (Coss - Crss)", "CBD"),
        ], "Enhancement P-channel MOSFET with mobility degradation (level 3)", fixed="LEVEL=3"),
        _semiconductor("NJFET", "N-channel JFET", "transistor", "bpt:njfet", "NJF", [
            ("vto", "Vp", "V", "-0.8", "Pinch-off voltage", "VTO"),
            ("beta", "β", "A/V²", "1.3m", "Transconductance parameter (Idss = β·Vp²)", "BETA"),
            ("lambda", "λ", "1/V", "2m", "Channel-length modulation", "LAMBDA"),
            ("rd", "RD", "Ω", "1", "Drain resistance", "RD"),
            ("rs", "RS", "Ω", "1", "Source resistance", "RS"),
            ("cgs", "Cgs", "F", "4p", "Gate-source capacitance", "CGS"),
            ("cgd", "Cgd", "F", "4p", "Gate-drain capacitance", "CGD"),
        ], "N-channel junction FET (defaults: J201)"),
        # SPICE gives the pinch-off of a P-channel JFET as a negative VTO too (the model flips
        # the polarities); the gate goes positive to pinch it off.
        _semiconductor("PJFET", "P-channel JFET", "transistor", "bpt:pjfet", "PJF", [
            ("vto", "Vp", "V", "-4", "Pinch-off voltage (SPICE sign: negative)", "VTO"),
            ("beta", "β", "A/V²", "1.6m", "Transconductance parameter (Idss = β·Vp²)", "BETA"),
            ("lambda", "λ", "1/V", "10m", "Channel-length modulation", "LAMBDA"),
            ("rd", "RD", "Ω", "2", "Drain resistance", "RD"),
            ("rs", "RS", "Ω", "2", "Source resistance", "RS"),
            ("cgs", "Cgs", "F", "10p", "Gate-source capacitance", "CGS"),
            ("cgd", "Cgd", "F", "10p", "Gate-drain capacitance", "CGD"),
        ], "P-channel junction FET (defaults: J175-like, Idss about 25 mA)"),
    ]  # fmt: skip


_BJT_GROUPS = {"Main": "is bf vaf ikf", "Loss": "rb rc", "Parasitics": "cje cjc tf",
               "Advanced": "ise ne br"}  # fmt: skip
_EM_GROUPS = {"Main": "is bf br", "Loss": "rb rc", "Parasitics": "cje cjc tf"}
_MOS_GROUPS = {"Main": "vto kp lambda theta", "Loss": "rd rs", "Parasitics": "cgso cgdo cbd"}
_JFET_GROUPS = {"Main": "vto beta lambda", "Loss": "rd rs", "Parasitics": "cgs cgd"}
# The headings of the forms: what to fill in first, what only some parts need.
_GROUPS: dict[str, dict[str, str]] = {
    "Real transformer": {"Main": "lp n k", "Loss": "rp rs rcore", "Parasitics": "cw"},
    "NPN with package": {"Parasitics": "lb lc le cbe cbc"},
    "Hybrid-pi BJT (small signal)": {"Main": "ic beta vaf", "Loss": "rx", "Parasitics": "cpi cmu"},
    "NPN transistor (Ebers-Moll)": _EM_GROUPS,
    "PNP transistor (Ebers-Moll)": _EM_GROUPS,
    "Op-amp macromodel": {
        "Main": "aol gbw sr vos ib",
        "Output": "vohigh volow iout",
        "Advanced": "cmrr psrr iq rin rout",
    },
    "Diode (signal)": {"Main": "is n rs bv ibv", "Advanced": "cjo vj mj tt"},
    "LED": {"Main": "is n rs", "Advanced": "bv cjo"},
    "Zener diode": {"Main": "bv ibv rs", "Advanced": "is n cjo"},
    "NPN transistor": _BJT_GROUPS,
    "PNP transistor": _BJT_GROUPS,
    "N-channel MOSFET": _MOS_GROUPS,
    "P-channel MOSFET": _MOS_GROUPS,
    "N-channel MOSFET (level 3)": _MOS_GROUPS,
    "P-channel MOSFET (level 3)": _MOS_GROUPS,
    "N-channel JFET": _JFET_GROUPS,
    "P-channel JFET": _JFET_GROUPS,
}


def _grouped(template: UserTemplate) -> UserTemplate:
    groups = _GROUPS[template.name]
    return template.model_copy(update={"fields": [
        f.model_copy(update={"group": next(g for g, keys in groups.items()
                                           if f.key in keys.split())})
        for f in template.fields
    ]})  # fmt: skip


@cache
def _built() -> tuple[UserTemplate, ...]:
    built = (_transformer(), _transistor(), _hybrid_pi(), _opamp(), *_semiconductors())
    return tuple(_grouped(t) for t in built)


def standard_templates() -> list[UserTemplate]:
    return [t.model_copy(deep=True) for t in _built()]
