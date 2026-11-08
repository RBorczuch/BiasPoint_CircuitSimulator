"""Built-in symbols (IEC style, with ANSI and other looks) and default model cards.

Coordinates: internal units of 10 µm, grid ``G`` = 127 (1.27 mm); y points down.
A pin's ``at`` is its connection point; the pin line runs ``length`` units toward the body
(direction opposite to ``orientation``, which is where the pin sticks out).
Text graphics may use ``{ref}``, ``{value}`` and ``{net}`` placeholders.
"""

from collections.abc import Sequence
from functools import cache
from typing import Any

from bpt.document.model import ModelCard, Point, SubcktModel
from bpt.library.categories import builtin_category
from bpt.library.symbols import (
    Arc,
    Circle,
    Graphic,
    Look,
    Orientation,
    Parasitic,
    Pin,
    PinType,
    Polyline,
    Rect,
    SpiceMapping,
    Symbol,
    Text,
    Variant,
)

G = 127


def _orientation(at: Point) -> Orientation:
    x, y = at
    if abs(x) >= abs(y):
        return "right" if x > 0 else "left"
    return "down" if y > 0 else "up"


def _pin(number: str, at: Point, length: int = G, name: str = "", type: PinType = "passive") -> Pin:
    return Pin(number=number, name=name, at=at, length=length, orientation=_orientation(at),
               type=type)  # fmt: skip


def _line(*points: Point) -> Polyline:
    return Polyline(points=list(points))


def _filled(*points: Point) -> Polyline:
    return Polyline(points=[*points, points[0]], fill=True)


def _symbol(id_: str, name: str, prefix: str, category: str, pins: list[Pin],
            graphics: Sequence[Any], element: str | None = None, nodes: list[str] | None = None,
            **kw: Any) -> Symbol:  # fmt: skip
    spice = None
    if element is not None:
        spice = SpiceMapping.model_validate({"element": element,
                                             "nodes": nodes or [p.number for p in pins]})  # fmt: skip
    return Symbol(id=f"bpt:{id_}", name=name, ref_prefix=prefix, category=category, pins=pins,
                  graphics=list(graphics), spice=spice, group=builtin_category(f"bpt:{id_}"),
                  **kw)  # fmt: skip


# -- shapes ---------------------------------------------------------------------------------

_DIODE = [_filled((-127, -102), (127, -102), (0, 102)), _line((-127, 102), (127, 102))]
_DIODE_PINS = [_pin("A", (0, -3 * G), 279, "A"), _pin("K", (0, 3 * G), 279, "K")]
_LED_ARROWS = [
    _line((178, -25), (279, -127)), _filled((279, -127), (229, -114), (267, -76)),
    _line((178, 51), (279, -51)), _filled((279, -51), (229, -38), (267, 0)),
]  # fmt: skip
_ZENER_BAR = [_filled((-127, -102), (127, -102), (0, 102)),
              _line((-178, 140), (-127, 102), (127, 102), (178, 64))]  # fmt: skip
_SCHOTTKY_BAR: list[Graphic] = [
    _filled((-127, -102), (127, -102), (0, 102)),
    _line((-76, 152), (-127, 152), (-127, 102), (127, 102), (127, 51), (76, 51)),
]
_SOURCE_PINS = [_pin("+", (0, -3 * G), 178, "+"), _pin("-", (0, 3 * G), 178, "-")]
_DIAMOND = _line((0, -203), (203, 0), (0, 203), (-203, 0), (0, -203))
_FOUR_PORT_PINS = [
    _pin("out+", (3 * G, -2 * G), G, "out+"), _pin("out-", (3 * G, 2 * G), G, "out-"),
    _pin("in+", (-3 * G, -2 * G), G, "in+", "input"), _pin("in-", (-3 * G, 2 * G), G, "in-", "input"),
]  # fmt: skip
# Controlled sources: the sensing input in a box, the output source (a diamond) in series
# between the output pins, so the drawing shows where the output current flows.
_FOUR_PORT_BODY = [
    # The input in its box; the output source outside it, in series between the output pins
    # (a box edge there would look like a short across the source).
    Rect(start=(-254, -381), end=(0, 381)),
    _line((254, -254), (152, -254), (152, -102)), _line((152, 102), (152, 254), (254, 254)),
    _line((152, -102), (254, 0), (152, 102), (51, 0), (152, -102)),
    Text(at=(-140, -254), text="+", size=102), Text(at=(-140, 254), text="−", size=102),
]  # fmt: skip
_VCVS_MARK = [Text(at=(152, -38), text="+", size=64), Text(at=(152, 38), text="−", size=64)]
_VCCS_MARK = [_line((152, -64), (152, 38)), _filled((152, 70), (127, 25), (178, 25))]
_BJT_PINS = [_pin("C", (0, -3 * G), G, "C"), _pin("B", (-3 * G, 0), 279, "B"),
             _pin("E", (0, 3 * G), G, "E")]  # fmt: skip
# Without the envelope circle (as most schematics draw them): the size of a MOSFET.
_BJT_BODY: list[Graphic] = [_line((-102, -152), (-102, 152)),
                            _line((-102, -76), (0, -178), (0, -254)),
                            _line((-102, 76), (0, 178), (0, 254))]  # fmt: skip
_NPN_ARROW = _filled((0, 178), (-22, 116), (-62, 156))
_PNP_ARROW = _filled((-80, 98), (-18, 120), (-58, 160))
_ENVELOPE = Circle(center=(-38, 0), radius=254)
_FET_PINS = [_pin("D", (0, -3 * G), G, "D"), _pin("G", (-3 * G, 0), 229, "G"),
             _pin("S", (0, 3 * G), G, "S")]  # fmt: skip
_MOS_BODY = [
    _line((-152, -127), (-152, 127)),
    _line((-102, -152), (-102, -76)), _line((-102, -38), (-102, 38)), _line((-102, 76), (-102, 152)),
    _line((-102, -114), (0, -114), (0, -254)), _line((-102, 114), (0, 114), (0, 254)),
    _line((-102, 0), (0, 0), (0, 114)),
]  # fmt: skip
_JFET_PINS = [_pin("D", (0, -3 * G), G, "D"), _pin("G", (-3 * G, 0), 279, "G"),
              _pin("S", (0, 3 * G), G, "S")]  # fmt: skip
_JFET_BODY = [_line((-102, -152), (-102, 152)),
              _line((-102, -114), (0, -114), (0, -254)), _line((-102, 114), (0, 114), (0, 254))]  # fmt: skip
_SEMI_TEXT: dict[str, Any] = {"ref_at": (203, -64), "value_at": (203, 64)}

# -- looks: the same pins drawn another way (FR-SCH-6) -------------------------------------
_ZIGZAG = _line((0, -254), (102, -212), (-102, -127), (102, -42), (-102, 42), (102, 127),
                (-102, 212), (0, 254))  # fmt: skip
_PLUS = Text(at=(-140, -127), text="+", size=102)
# Two diodes back to back between bars (triac, diac): one pointing down, one up.
_BIDIR: list[Graphic] = [
    _line((-229, -102), (229, -102)), _line((-229, 102), (229, 102)),
    _filled((-203, -102), (-25, -102), (-114, 102)), _filled((25, 102), (203, 102), (114, -102)),
]  # fmt: skip
# Light falling on a part: two arrows pointing at it from the upper right.
_LIGHT_IN = [
    _line((330, -229), (203, -102)), _filled((178, -76), (190, -127), (229, -89)),
    _line((330, -127), (203, 0)), _filled((178, 25), (190, -25), (229, 13)),
]  # fmt: skip
_WIPER = [_line((254, 0), (152, 0)), _filled((102, 0), (165, -38), (165, 38))]
_CAP_LOOKS = [
    Look(name="polarized", label="Polarized", graphics=[
        _line((-203, -51), (203, -51)), _line((-203, 51), (203, 51)), _PLUS]),
    Look(name="electrolytic-eu", label="Electrolytic (European)", graphics=[
        # The leads end on the plates (pins end at y = -51 and 51): hollow + plate, filled - plate.
        Rect(start=(-203, -51), end=(203, -25)), Rect(start=(-203, 25), end=(203, 51), fill=True),
        _PLUS]),
    Look(name="electrolytic-us", label="Electrolytic (American)", graphics=[
        _line((-203, -51), (203, -51)), Arc(start=(-203, 115), mid=(0, 51), end=(203, 115)), _PLUS]),
]  # fmt: skip
_VSOURCE_ANSI: list[Graphic] = [Circle(center=(0, 0), radius=203), Text(at=(0, -89), text="+", size=127),
                 Text(at=(0, 89), text="−", size=127)]  # fmt: skip
_ISOURCE_EU: list[Graphic] = [Circle(center=(0, 0), radius=203), _line((-203, 0), (203, 0))]
# Pins end at y = -203 and 203. Arrow beside the source: the direction of the current (from the
# + pin through the source to the - pin, as SPICE counts it) or of the voltage (+ to -).
_SIDE_ARROW: list[Graphic] = [
    _line((-292, -114), (-292, 76)),
    _filled((-292, 127), (-330, 51), (-254, 51)),
]  # on the left: the reference and value are on the right
_TWO_CIRCLES: list[Graphic] = [
    Circle(center=(0, -76), radius=127),
    Circle(center=(0, 76), radius=127),
]
_CELL: list[Graphic] = [
    _line((0, -203), (0, -25)), _line((-152, -25), (152, -25)),  # long plate: +
    _filled((-76, 25), (76, 25), (76, 45), (-76, 45)), _line((0, 45), (0, 203)),  # short: -
    Text(at=(-203, -102), text="+", size=102),
]  # fmt: skip
_BATTERY: list[Graphic] = [
    _line((0, -203), (0, -89)),
    _line((-152, -89), (152, -89)), _filled((-76, -51), (76, -51), (76, -32), (-76, -32)),
    _line((-152, 32), (152, 32)), _filled((-76, 70), (76, 70), (76, 89), (-76, 89)),
    _line((0, -28), (0, -18)), _line((0, -5), (0, 5)), _line((0, 18), (0, 28)),  # more cells
    _line((0, 89), (0, 203)), Text(at=(-203, -152), text="+", size=102),
]  # fmt: skip
_SINE = _line(
    *[
        (-110, 0),
        (-88, 41),
        (-66, 67),
        (-44, 67),
        (-22, 41),
        (0, 0),
        (22, -41),
        (44, -67),
        (66, -67),
        (88, -41),
        (110, 0),
    ]
)
_SQUARE = _line(
    (-127, 51), (-64, 51), (-64, -51), (0, -51), (0, 51), (64, 51), (64, -51), (127, -51)
)
_TRIANGLE = _line((-127, 0), (-64, -64), (64, 64), (127, 0))
_SIGNAL_PLUS = Text(at=(0, -140), text="+", size=76)
_VSOURCE_LOOKS = [
    Look(name="ansi", label="+ and − (ANSI)", standard="ansi", graphics=_VSOURCE_ANSI),
    Look(name="arrow", label="Circle with a voltage arrow",
         graphics=[Circle(center=(0, 0), radius=203), _line((0, -203), (0, 203)), *_SIDE_ARROW]),
    Look(name="sine", label="Sine signal", signal="SIN",
         graphics=[Circle(center=(0, 0), radius=203), _SINE, _SIGNAL_PLUS]),
    Look(name="pulse", label="Pulse / square signal", signal="PULSE",
         graphics=[Circle(center=(0, 0), radius=203), _SQUARE, _SIGNAL_PLUS]),
    Look(name="triangle", label="Triangle signal",
         graphics=[Circle(center=(0, 0), radius=203), _TRIANGLE, _SIGNAL_PLUS]),
    Look(name="cell", label="Cell", graphics=_CELL),
    Look(name="battery", label="Battery (several cells)", graphics=_BATTERY),
]  # fmt: skip
_ISOURCE_LOOKS = [
    Look(name="iec-line", label="Line across (European)", graphics=_ISOURCE_EU),
    Look(name="two-circles", label="Two overlapping circles", graphics=_TWO_CIRCLES),
    Look(name="sine", label="Sine signal", signal="SIN",
         graphics=[Circle(center=(0, 0), radius=203), _SINE, *_SIDE_ARROW]),
    Look(name="pulse", label="Pulse / square signal", signal="PULSE",
         graphics=[Circle(center=(0, 0), radius=203), _SQUARE, *_SIDE_ARROW]),
    Look(name="two-circles-arrow", label="Two overlapping circles with an arrow",
         graphics=[*_TWO_CIRCLES, *_SIDE_ARROW]),
]  # fmt: skip


def _p(key: str, label: str, element: str, connection: str, description: str) -> Parasitic:
    unit = {"R": "Ω", "L": "H", "C": "F"}[element]
    return Parasitic.model_validate({"key": key, "label": label, "element": element,
                                     "connection": connection, "unit": unit,
                                     "description": description})  # fmt: skip


_PARASITICS = {
    "resistor": [_p("ls", "Ls", "L", "series", "Series inductance (leads, film spiral)"),
                 _p("cp", "Cp", "C", "parallel", "Parallel capacitance (end caps, pads)")],
    "capacitor": [_p("esr", "ESR", "R", "series", "Equivalent series resistance"),
                  _p("esl", "ESL", "L", "series", "Equivalent series inductance"),
                  _p("rleak", "R leak", "R", "parallel", "Leakage (insulation) resistance")],
    "inductor": [_p("dcr", "DCR", "R", "series", "Winding (DC) resistance"),
                 _p("cp", "Cp", "C", "parallel", "Winding capacitance (sets the self-resonance)"),
                 _p("rp", "Rp", "R", "parallel", "Core loss resistance")],
    "vsource": [_p("rs", "Rs", "R", "series", "Internal (output) resistance")],
    "isource": [_p("rp", "Rp", "R", "parallel", "Output (shunt) resistance"),
                _p("cp", "Cp", "C", "parallel", "Output capacitance")],
}  # fmt: skip


@cache
def builtin_symbols() -> dict[str, Symbol]:
    two = [_pin("1", (0, -3 * G)), _pin("2", (0, 3 * G))]
    symbols = [
        _symbol("resistor", "Resistor", "R", "Passive", two,
                [Rect(start=(-102, -254), end=(102, 254))], "R",
                default_params={"R": "1k"}, value_param="R", parasitics=_PARASITICS["resistor"],
                looks=[Look(name="ansi", label="Zigzag (ANSI)", standard="ansi",
                            graphics=[_ZIGZAG])]),
        # The wiper W divides the track: R*pos from 1 to W, R*(1-pos) from W to 2.
        _symbol("potentiometer", "Potentiometer", "RV", "Passive",
                [_pin("1", (0, -3 * G)), _pin("2", (0, 3 * G)), _pin("W", (3 * G, 0), G, "W")],
                [Rect(start=(-102, -254), end=(102, 254)), *_WIPER], "X", ["1", "2", "W"],
                default_model="POT", default_params={"r": "10k", "pos": "0.5"}, value_param="r",
                ref_at=(-254, -64), value_at=(-254, 64),
                looks=[Look(name="ansi", label="Zigzag (ANSI)", standard="ansi",
                            graphics=[_ZIGZAG, *_WIPER])],
                description="Resistance R between 1 and 2, the wiper W at pos (0 at pin 1, 1 at "
                "pin 2)"),
        # Melts when the integral of i² reaches its I²t (the melting integral of the datasheet).
        _symbol("fuse", "Fuse", "F", "Passive", two,
                [Rect(start=(-76, -203), end=(76, 203)), _line((0, -254), (0, 254))], "X", ["1", "2"],
                default_model="FUSE", default_params={"r": "10m", "i2t": "1"}, value_param="i2t",
                description="Cold resistance R; opens when ∫i²dt reaches I²t (A²s) and stays open"),
        _symbol("capacitor", "Capacitor", "C", "Passive",
                [_pin("1", (0, -3 * G), 330), _pin("2", (0, 3 * G), 330)],
                [_line((-203, -51), (203, -51)), _line((-203, 51), (203, 51))], "C",
                default_params={"C": "100n"}, value_param="C", ref_at=(279, -64), value_at=(279, 64),
                parasitics=_PARASITICS["capacitor"], looks=_CAP_LOOKS),
        _symbol("inductor", "Inductor", "L", "Passive", two,
                [Arc(start=(0, y), mid=(64, y + 64), end=(0, y + G)) for y in (-254, -127, 0, 127)],
                "L", default_params={"L": "10u"}, value_param="L", parasitics=_PARASITICS["inductor"]),
        _symbol("transformer", "Transformer", "T", "Passive",
                [_pin("P1", (-3 * G, -2 * G), 2 * G), _pin("P2", (-3 * G, 2 * G), 2 * G),
                 _pin("S1", (3 * G, -2 * G), 2 * G), _pin("S2", (3 * G, 2 * G), 2 * G)],
                [*(Arc(start=(-G, y), mid=(-G + 64, y + 64), end=(-G, y + G)) for y in (-254, -127, 0, 127)),
                 *(Arc(start=(G, y), mid=(G - 64, y + 64), end=(G, y + G)) for y in (-254, -127, 0, 127)),
                 _line((-25, -254), (-25, 254)), _line((25, -254), (25, 254)),
                 Circle(center=(-200, -280), radius=22, fill=True),
                 Circle(center=(200, -280), radius=22, fill=True)],
                "X", ["P1", "P2", "S1", "S2"], default_model="XFMR",
                default_params={"lp": "100u", "ls": "100u", "k": "0.999"},
                ref_at=(0, -380), value_at=(0, 380),
                description="Two coupled windings: inductances Lp, Ls and coupling k "
                "(turns ratio = sqrt(Ls/Lp)); dots mark the winding starts"),
        # A diode used for its junction capacitance, reverse biased (the plates beside it).
        _symbol("varicap", "Varicap diode", "D", "Semiconductor", _DIODE_PINS,
                [*_DIODE, _line((-127, 152), (127, 152))], "D", default_model="VARICAP", **_SEMI_TEXT,
                description="Junction capacitance CJO at 0 V falling with reverse voltage (VJ, M)"),
        _symbol("photodiode", "Photodiode", "D", "Optoelectronics", _DIODE_PINS,
                [*_DIODE, *_LIGHT_IN], "X", ["A", "K"], default_model="PHOTODIODE",
                default_params={"iph": "10u", "cj": "10p"}, value_param="iph",
                ref_at=(381, -64), value_at=(381, 64),  # (right of the light's arrows)
                description="Gives the photocurrent IPH (at the light it is used at), cathode to "
                "anode inside; use it reverse biased"),
        # Optocoupler: the LED on the left, the phototransistor on the right, in one package.
        _symbol("optocoupler", "Optocoupler", "U", "Optoelectronics",
                [_pin("A", (-4 * G, -2 * G), G, "A", "input"), _pin("K", (-4 * G, 2 * G), G, "K", "input"),
                 _pin("C", (4 * G, -2 * G), G, "C"), _pin("E", (4 * G, 2 * G), G, "E")],
                [Rect(start=(-381, -381), end=(381, 381)),
                 _line((-381, -254), (-178, -254), (-178, -64)), _line((-178, 64), (-178, 254), (-381, 254)),
                 _filled((-254, -64), (-102, -64), (-178, 64)), _line((-254, 64), (-102, 64)),
                 _line((-51, -51), (51, -51)), _filled((76, -51), (25, -76), (25, -25)),
                 _line((-51, 51), (51, 51)), _filled((76, 51), (25, 26), (25, 76)),
                 _line((127, -152), (127, 152)),
                 _line((127, -64), (254, -178), (254, -254), (381, -254)),
                 _line((127, 64), (254, 178), (254, 254), (381, 254)),
                 _filled((254, 178), (190, 165), (229, 127))], "X", ["A", "K", "C", "E"],
                default_model="OPTO", default_params={"ctr": "1"}, value_param="ctr",
                ref_at=(0, -483), value_at=(0, 483),
                description="LED A-K; collector current C-E = CTR times the LED current"),
        # IGBT: a MOSFET's insulated gate in front of a bipolar transistor's body.
        _symbol("igbt", "IGBT", "Q", "Semiconductor",
                [_pin("C", (0, -3 * G), G, "C"), _pin("G", (-3 * G, 0), 229, "G", "input"),
                 _pin("E", (0, 3 * G), G, "E")],
                [_line((-152, -152), (-152, 152)), *_BJT_BODY], "X", ["C", "G", "E"],
                default_model="IGBT", default_params={"vth": "5"}, **_SEMI_TEXT,
                description="Turned on by the gate voltage above VTH; the collector-emitter "
                "voltage keeps a junction's drop when on"),
        # Voltage-controlled resistor: a resistor whose value the control voltage sets.
        _symbol("vcr", "Voltage-controlled resistor", "R", "Passive",
                [_pin("1", (0, -3 * G)), _pin("2", (0, 3 * G)),
                 _pin("ctrl+", (-3 * G, -G), G, "ctrl+", "input"),
                 _pin("ctrl-", (-3 * G, G), G, "ctrl-", "input")],
                [Rect(start=(-102, -254), end=(102, 254)), _line((-203, 203), (165, -165)),
                 _filled((203, -203), (127, -178), (178, -127)),
                 _line((-254, -127), (-152, -127)), _line((-254, 127), (-152, 127)),
                 Text(at=(-203, -203), text="+", size=76), Text(at=(-203, 203), text="−", size=76)],
                "X", ["1", "2", "ctrl+", "ctrl-"], default_model="VCR",
                default_params={"r0": "10k", "k": "1"}, value_param="r0",
                ref_at=(254, -64), value_at=(254, 64),
                description="R = R0 / (1 + K·Vctrl) between 1 and 2 (never below RMIN)"),
        # Transformer with three windings: the primary on the left, two secondaries on the right.
        _symbol("transformer3", "Transformer, three windings", "T", "Passive",
                [_pin("P1", (-3 * G, -2 * G), 2 * G), _pin("P2", (-3 * G, 2 * G), 2 * G),
                 _pin("S1", (4 * G, -4 * G), 3 * G), _pin("S2", (4 * G, -G), 3 * G),
                 _pin("T1", (4 * G, G), 3 * G), _pin("T2", (4 * G, 4 * G), 3 * G)],
                [*(Arc(start=(-G, y), mid=(-G + 64, y + 64), end=(-G, y + G)) for y in (-254, -127, 0, 127)),
                 _line((G, -508), (G, -381)),
                 *(Arc(start=(G, y), mid=(G - 64, y + 64), end=(G, y + G)) for y in (-381, -254)),
                 *(Arc(start=(G, y), mid=(G - 64, y + 64), end=(G, y + G)) for y in (127, 254)),
                 _line((G, 381), (G, 508)),
                 _line((-25, -508), (-25, 508)), _line((25, -508), (25, 508)),
                 Circle(center=(-200, -280), radius=22, fill=True),
                 Circle(center=(200, -406), radius=22, fill=True),
                 Circle(center=(200, 102), radius=22, fill=True)],
                "X", ["P1", "P2", "S1", "S2", "T1", "T2"], default_model="XFMR3",
                default_params={"lp": "1m", "ns": "1", "nt": "1", "k": "0.999"},
                ref_at=(0, -635), value_at=(0, 635),
                description="Primary inductance Lp, turns ratios Ns and Nt to the two secondaries, "
                "all coupled by k; dots mark the winding starts"),
        # Triac: two thyristors back to back between MT2 (top) and MT1 (bottom), one gate.
        _symbol("triac", "Triac", "Q", "Semiconductor",
                [_pin("MT2", (0, -3 * G), 279, "MT2"), _pin("MT1", (0, 3 * G), 279, "MT1"),
                 _pin("G", (-3 * G, 2 * G), G, "G", "input")],
                _BIDIR + [_line((-254, 254), (-152, 102))], "X", ["MT2", "MT1", "G"],
                default_model="TRIAC", default_params={"rgk": "1k"}, ref_at=(254, -64),
                value_at=(254, 64),
                description="Turned on by a gate current of either sign, it conducts either way "
                "until its current falls to nearly zero (AC switching)"),
        _symbol("diac", "Diac", "D", "Semiconductor",
                [_pin("A1", (0, -3 * G), 279, "A1"), _pin("A2", (0, 3 * G), 279, "A2")],
                _BIDIR, "X", ["A1", "A2"], default_model="DIAC", default_params={"vbo": "32"},
                value_param="vbo", ref_at=(254, -64), value_at=(254, 64),
                description="Blocks both ways until the breakover voltage VBO, then conducts "
                "until the current stops (it fires triacs)"),
        _symbol("phototransistor", "Phototransistor", "Q", "Optoelectronics",
                [_pin("C", (0, -3 * G), G, "C"), _pin("E", (0, 3 * G), G, "E")],
                [*_BJT_BODY, *(g.model_copy(update={"points": [(x - 508, y) for x, y in g.points]})
                               for g in _LIGHT_IN)],
                "X", ["C", "E"], default_model="PHOTOQ", default_params={"iph": "1u"},
                value_param="iph", **_SEMI_TEXT,
                description="Collector current BF times the photocurrent IPH (at the light it is "
                "used at); no base pin"),
        _symbol("motor", "DC motor", "M", "Electromechanical",
                [_pin("+", (0, -3 * G), G, "+"), _pin("-", (0, 3 * G), G, "-"),
                 _pin("W", (4 * G, 0), 2 * G, "W", "output")],
                [Circle(center=(0, 0), radius=254), Text(at=(0, 0), text="M", size=152),
                 _line((254, 0), (254, 0))], "X", ["+", "-", "W"], default_model="MOTOR",
                default_params={"r": "1", "l": "1m", "ke": "10m", "j": "10u", "b": "1u"},
                ref_at=(330, -203), value_at=(330, 203),
                description="Armature R, L; back EMF ke·speed; torque kt·current on the inertia J "
                "with friction B. W: the shaft speed (1 V = 1 rad/s); a current into W is a load "
                "torque"),
        _symbol("speaker", "Loudspeaker", "LS", "Electromechanical",
                [_pin("+", (-3 * G, -G), G, "+"), _pin("-", (-3 * G, G), G, "-"),
                 _pin("V", (4 * G, 0), G, "V", "output")],
                [Rect(start=(-254, -152), end=(-102, 152)),
                 _line((-102, -152), (152, -381), (152, 381), (-102, 152)),
                 _line((152, 0), (381, 0))], "X", ["+", "-", "V"],
                default_model="SPEAKER",
                default_params={"re": "6", "bl": "7", "mms": "20m", "cms": "0.5m", "rms": "2"},
                ref_at=(254, -457), value_at=(254, 457),
                description="Thiele-Small model: voice coil Re, Le; force factor BL; moving mass "
                "Mms, compliance Cms, losses Rms. V: the cone velocity (1 V = 1 m/s)"),
        _symbol("ntc", "NTC thermistor", "TH", "Sensors",
                [_pin("1", (0, -3 * G)), _pin("2", (0, 3 * G)),
                 _pin("T", (-3 * G, 0), G, "T", "input")],
                [Rect(start=(-102, -254), end=(102, 254)), _line((-203, 203), (-127, 203), (127, -203)),
                 Text(at=(203, 254), text="−t°", size=76)], "X", ["1", "2", "T"],
                default_model="NTC", default_params={"r25": "10k", "beta": "3950"},
                value_param="r25", ref_at=(254, -64), value_at=(254, 64),
                description="R25 at 25 °C following the B equation; T: the temperature as a "
                "voltage (1 V = 1 °C)"),
        _symbol("hall", "Hall sensor", "U", "Sensors",
                [_pin("B", (-3 * G, 0), G, "B", "input"), _pin("OUT", (3 * G, 0), G, "OUT", "output"),
                 _pin("GND", (0, 3 * G), G, "GND")],
                [Rect(start=(-254, -254), end=(254, 254)), Text(at=(0, 0), text="H", size=152)],
                "X", ["B", "OUT", "GND"], default_model="HALL",
                default_params={"vq": "2.5", "sens": "25m"}, ref_at=(0, -330), value_at=(330, 330),
                description="Linear output VQ + sensitivity·field within 0..VMAX; B: the field "
                "as a voltage (1 V = 1 mT)"),
        # Thyristor: a diode whose gate, beside the cathode, turns it on; it stays on.
        _symbol("thyristor", "Thyristor (SCR)", "Q", "Semiconductor",
                [*_DIODE_PINS, _pin("G", (-3 * G, 2 * G), G, "G", "input")],
                [*_DIODE, _line((-254, 254), (-102, 102))], "X", ["A", "K", "G"],
                default_model="SCR", default_params={"rgk": "1k"}, **_SEMI_TEXT,
                description="Turned on by a gate current, it conducts until the anode current "
                "falls to nearly zero (RGK sets the trigger current)"),
        # Relay: the coil on the left, a changeover contact on the right (NO above, NC beside).
        _symbol("relay", "Relay", "K", "Switches",
                [_pin("A1", (-3 * G, -4 * G), G, "A1"), _pin("A2", (-3 * G, 4 * G), G, "A2"),
                 _pin("COM", (2 * G, 4 * G), G, "COM"), _pin("NO", (G, -4 * G), G, "NO"),
                 _pin("NC", (3 * G, -4 * G), G, "NC")],
                [Rect(start=(-457, -127), end=(-305, 127)),
                 _line((-381, -381), (-381, -127)), _line((-381, 127), (-381, 381)),
                 _line((254, 381), (254, 254), (356, -178)),  # at rest on NC
                 Circle(center=(254, 254), radius=20, fill=True),
                 _line((381, -381), (381, -178)), _line((127, -381), (127, -178)),
                 _line((-305, 0), (-229, 0)), _line((-178, 0), (-102, 0)), _line((-51, 0), (25, 0)),
                 _line((76, 0), (152, 0))], "X",
                ["A1", "A2", "COM", "NO", "NC"], default_model="RELAY",
                default_params={"rcoil": "400", "lcoil": "200m", "ipull": "20m", "idrop": "6m"},
                ref_at=(508, -64), value_at=(508, 64),
                description="Coil A1-A2 (R, L); the contact COM-NO closes above the pull-in current "
                "and opens below the drop-out current (COM-NC the other way)"),
        _symbol("diode", "Diode", "D", "Semiconductor", _DIODE_PINS, _DIODE, "D",
                default_model="D", **_SEMI_TEXT,
                looks=[Look(name="schottky", label="Schottky", graphics=_SCHOTTKY_BAR)], variants=[
                    Variant(name="model", label="Diode model",
                            description="Shockley diode with series resistance (the model's)",
                            spice=SpiceMapping(element="D", nodes=["A", "K"]), default_model="D"),
                    Variant(name="ideal", label="Nearly ideal",
                            description="Almost no forward drop: for rectifier logic and clamps",
                            spice=SpiceMapping(element="D", nodes=["A", "K"]),
                            default_model="D_IDEAL"),
                ]),
        _symbol("led", "LED", "D", "Semiconductor", _DIODE_PINS, _DIODE + _LED_ARROWS, "D",
                default_model="LED_RED", ref_at=(-178, -64), value_at=(-178, 64)),
        _symbol("zener", "Zener diode", "D", "Semiconductor", _DIODE_PINS, _ZENER_BAR, "D",
                default_model="DZ5V1", **_SEMI_TEXT),
        _symbol("vsource", "Voltage source", "V", "Sources", _SOURCE_PINS,
                [Circle(center=(0, 0), radius=203), _line((0, -203), (0, 203)),
                 Text(at=(102, -127), text="+", size=102)], "V",
                default_params={"dc": "5"}, value_param="dc", ref_at=(254, -64), value_at=(254, 64),
                parasitics=_PARASITICS["vsource"],
                looks=_VSOURCE_LOOKS),
        _symbol("isource", "Current source", "I", "Sources", _SOURCE_PINS,
                [Circle(center=(0, 0), radius=203), _line((0, -127), (0, 127)),
                 _filled((0, 127), (-51, 51), (51, 51))], "I",
                default_params={"dc": "1m"}, value_param="dc", ref_at=(254, -64), value_at=(254, 64),
                parasitics=_PARASITICS["isource"],
                looks=_ISOURCE_LOOKS),
        _symbol("bsource", "Behavioral source", "B", "Sources", _SOURCE_PINS,
                [_DIAMOND, Text(at=(0, 0), text="B", size=127)], "B",
                default_params={"v": "0"}, value_param="v", ref_at=(254, -64), value_at=(254, 64)),
        # A transfer function: the output voltage is H(s) of the input's (XSPICE s_xfer).
        _symbol("hs", "Transfer function H(s)", "A", "Sources",
                [_pin("in", (-4 * G, 0), G, "in", "input"), _pin("out", (4 * G, 0), G, "out", "output")],
                [Rect(start=(-381, -203), end=(381, 203)), Text(at=(0, 0), text="H(s)", size=127)], "A",
                default_params={"h": "1/(1+s/(2*pi*1k))"}, value_param="h",
                ref_at=(0, -305), value_at=(0, 305)),
        _symbol("vcvs", "Voltage-controlled voltage source", "E", "Sources", _FOUR_PORT_PINS,
                _FOUR_PORT_BODY + _VCVS_MARK, "E",
                ["out+", "out-", "in+", "in-"], default_params={"gain": "1"}, value_param="gain",
                ref_at=(0, -457), value_at=(0, 457)),
        _symbol("vccs", "Voltage-controlled current source", "G", "Sources", _FOUR_PORT_PINS,
                _FOUR_PORT_BODY + _VCCS_MARK, "G",
                ["out+", "out-", "in+", "in-"], default_params={"gain": "1m"}, value_param="gain",
                ref_at=(0, -457), value_at=(0, 457)),
        _symbol("cccs", "Current-controlled current source", "F", "Sources", _SOURCE_PINS,
                [_DIAMOND, _line((0, -127), (0, 127)), _filled((0, 127), (-51, 51), (51, 51))], "F",
                default_params={"source": "V1", "gain": "1"}, value_param="gain",
                ref_at=(254, -64), value_at=(254, 64)),
        _symbol("ccvs", "Current-controlled voltage source", "H", "Sources", _SOURCE_PINS,
                [_DIAMOND, Text(at=(0, -89), text="+", size=102), Text(at=(0, 89), text="−", size=102)],
                "H", default_params={"source": "V1", "gain": "1k"}, value_param="gain",
                ref_at=(254, -64), value_at=(254, 64)),
        _symbol("npn", "NPN transistor", "Q", "Semiconductor", _BJT_PINS,
                [*_BJT_BODY, _NPN_ARROW], "Q", ["C", "B", "E"],
                default_model="NPN", ref_at=(254, -64), value_at=(254, 64),
                looks=[Look(name="envelope", label="With envelope circle",
                            graphics=[*_BJT_BODY, _NPN_ARROW, _ENVELOPE])]),
        _symbol("pnp", "PNP transistor", "Q", "Semiconductor", _BJT_PINS,
                [*_BJT_BODY, _PNP_ARROW], "Q", ["C", "B", "E"],
                default_model="PNP", ref_at=(254, -64), value_at=(254, 64),
                looks=[Look(name="envelope", label="With envelope circle",
                            graphics=[*_BJT_BODY, _PNP_ARROW, _ENVELOPE])]),
        _symbol("nmos", "N-channel MOSFET", "M", "Semiconductor", _FET_PINS,
                _MOS_BODY + [_filled((-102, 0), (-51, -25), (-51, 25))], "M", ["D", "G", "S", "S"],
                default_model="NMOS", **_SEMI_TEXT),
        _symbol("pmos", "P-channel MOSFET", "M", "Semiconductor", _FET_PINS,
                _MOS_BODY + [_filled((-25, 0), (-76, -25), (-76, 25))], "M", ["D", "G", "S", "S"],
                default_model="PMOS", **_SEMI_TEXT),
        _symbol("njfet", "N-channel JFET", "J", "Semiconductor", _JFET_PINS,
                _JFET_BODY + [_filled((-102, 0), (-165, -32), (-165, 32))], "J", ["D", "G", "S"],
                default_model="NJF", **_SEMI_TEXT),
        _symbol("pjfet", "P-channel JFET", "J", "Semiconductor", _JFET_PINS,
                _JFET_BODY + [_filled((-216, 0), (-152, -32), (-152, 32))], "J", ["D", "G", "S"],
                default_model="PJF", **_SEMI_TEXT),
        _symbol("switch", "Voltage-controlled switch", "S", "Switches",
                [_pin("1", (0, -3 * G), 254), _pin("2", (0, 3 * G), 254),
                 _pin("ctrl+", (-3 * G, -G), G, "ctrl+", "input"),
                 _pin("ctrl-", (-3 * G, G), G, "ctrl-", "input")],
                [_line((0, 127), (-127, -102)), Circle(center=(0, 127), radius=25, fill=True),
                 Rect(start=(-254, -178), end=(-178, 178)), _line((-178, 0), (-76, 0))], "S",
                ["1", "2", "ctrl+", "ctrl-"], default_model="SW"),
        _symbol("opamp_ideal", "Ideal op-amp", "U", "Amplifiers",
                [_pin("+", (-3 * G, -G), G, "+", "input"), _pin("-", (-3 * G, G), G, "-", "input"),
                 _pin("out", (3 * G, 0), G, "out", "output")],
                [_line((-254, -254), (-254, 254), (254, 0), (-254, -254)),
                 Text(at=(-190, -127), text="+", size=102), Text(at=(-190, 127), text="−", size=102)],
                "E", ["out", "=0", "+", "-"], default_params={"gain": "1meg"},
                ref_at=(0, -330), value_at=None, variants=[
                    Variant(name="ideal", label="Ideal",
                            description="Gain 10^6, no bandwidth or output limit",
                            spice=SpiceMapping(element="E", nodes=["out", "=0", "+", "-"]),
                            default_params={"gain": "1meg"}),
                    Variant(name="single-pole", label="Bandwidth-limited",
                            description="Open-loop gain AOL, gain-bandwidth GBW, output within ±15 V",
                            spice=SpiceMapping(element="X", nodes=["+", "-", "out"]),
                            default_model="OPAMP_1P"),
                ]),
        _symbol("opamp", "Op-amp (with supplies)", "U", "Amplifiers",
                [_pin("+", (-3 * G, -G), G, "+", "input"), _pin("-", (-3 * G, G), G, "-", "input"),
                 _pin("V+", (0, -3 * G), 2 * G, "V+", "power_in"),
                 _pin("V-", (0, 3 * G), 2 * G, "V-", "power_in"),
                 _pin("out", (3 * G, 0), G, "out", "output")],
                [_line((-254, -254), (-254, 254), (254, 0), (-254, -254)),
                 Text(at=(-190, -127), text="+", size=102), Text(at=(-190, 127), text="−", size=102)],
                "X", ["+", "-", "V+", "V-", "out"], default_model="OPAMP", variants=[
                    Variant(name="macro", label="Single-pole, output within the supplies",
                            spice=SpiceMapping(element="X", nodes=["+", "-", "V+", "V-", "out"]),
                            default_model="OPAMP"),
                    Variant(name="ideal", label="Ideal (supplies ignored)",
                            spice=SpiceMapping(element="E", nodes=["out", "=0", "+", "-"]),
                            default_params={"gain": "1meg"}),
                ],
                description="Op-amp model with gain, bandwidth and output limited by the supplies; "
                "choose a manufacturer's model in the inspector",
                ref_at=(178, -254), value_at=(178, 254)),
        # Probes (FR-SCH-9): named measuring points, always plotted after a simulation.
        _symbol("probe_v", "Voltage probe", "VP", "Probes", [_pin("1", (0, 2 * G), G)],
                [Circle(center=(0, 0), radius=127), Text(at=(0, 0), text="V", size=127)],
                description="Voltage of the net to ground: plotted and shown here after a run",
                ref_at=(178, -64), value_at=None),
        _symbol("probe_vd", "Differential voltage probe", "VP", "Probes",
                [_pin("+", (0, -3 * G), 2 * G, "+"), _pin("-", (0, 3 * G), 2 * G, "-")],
                [Circle(center=(0, 0), radius=127), Text(at=(0, 0), text="V", size=127),
                 Text(at=(102, -203), text="+", size=90), Text(at=(102, 203), text="−", size=90)],
                description="Voltage between two nets: plotted and shown here after a run",
                ref_at=(203, -64), value_at=None),
        # Drawn as an ammeter: a circle with A; the arrow beside it is the measured direction.
        _symbol("probe_i", "Current probe (ammeter)", "IP", "Probes",
                [_pin("1", (0, -3 * G), 178), _pin("2", (0, 3 * G), 178)],
                [Circle(center=(0, 0), radius=203), Text(at=(0, 0), text="A", size=165),
                 _line((292, -114), (292, 76)), _filled((292, 127), (254, 51), (330, 51))], "V",
                default_params={"dc": "0"},
                description="Ammeter: current through the branch from pin 1 to pin 2, in series",
                ref_at=(381, -64), value_at=None),
        _symbol("gnd", "Ground", "#GND", "Power", [_pin("1", (0, 0), 0, type="power_in")],
                [_line((0, 0), (0, 76)), _line((-127, 76), (127, 76)), _line((-76, 114), (76, 114)),
                 _line((-25, 152), (25, 152))],
                power_net="0", ref_at=None, value_at=None),
        _symbol("power", "Power net", "#PWR", "Power", [_pin("1", (0, 0), 0, type="power_in")],
                [_line((0, 0), (0, -76)), _line((-102, -76), (102, -76)),
                 Text(at=(0, -140), text="{net}", size=102)],
                power_net="VCC", default_params={"net": "VCC"}, ref_at=None, value_at=None),
    ]  # fmt: skip
    return {symbol.id: symbol for symbol in symbols}


@cache
def builtin_models() -> dict[str, ModelCard]:
    """Generic default models; real parts come from libraries and the model wizards."""
    return {
        "D": ModelCard(type="d", params={"is": "1e-14", "n": "1", "rs": "0.1"}),
        "D_IDEAL": ModelCard(type="d", params={"is": "1e-15", "n": "0.05", "rs": "0.01"}),
        # A tuning varicap: 40 pF at 0 V, about 4:1 over 0-10 V (abrupt junction, M = 0.5).
        "VARICAP": ModelCard(
            type="d",
            params={
                "is": "1e-15",
                "n": "1",
                "rs": "0.5",
                "cjo": "40p",
                "vj": "0.7",
                "m": "0.5",
                "bv": "30",
                "ibv": "10u",
            },
        ),
        "LED_RED": ModelCard(type="d", params={"is": "1e-21", "n": "1.6", "rs": "2", "eg": "1.9"}),
        "DZ5V1": ModelCard(
            type="d", params={"is": "1e-14", "rs": "1", "bv": "5.1", "ibv": "5m", "cjo": "100p"}
        ),
        "NPN": ModelCard(type="npn", params={"is": "1e-14", "bf": "200", "vaf": "100"}),
        "PNP": ModelCard(type="pnp", params={"is": "1e-14", "bf": "200", "vaf": "100"}),
        "NMOS": ModelCard(type="nmos", params={"level": "1", "vto": "1.5", "kp": "0.5"}),
        "PMOS": ModelCard(type="pmos", params={"level": "1", "vto": "-1.5", "kp": "0.25"}),
        "NJF": ModelCard(type="njf", params={"vto": "-2", "beta": "1m"}),
        "PJF": ModelCard(type="pjf", params={"vto": "2", "beta": "1m"}),
        "SW": ModelCard(type="sw", params={"vt": "0.5", "vh": "0.1", "ron": "1", "roff": "1meg"}),
    }


@cache
def builtin_subcircuits() -> dict[str, SubcktModel]:
    """Generic subcircuit models (behavioural variants of built-in parts)."""
    return {
        # Single-pole op-amp: open-loop gain AOL, gain-bandwidth GBW, output between the rails
        # (minus SWING), output resistance ROUT. Pins: + - V+ V- out.
        # The same without supply pins: output within VMIN..VMAX.
        # Coupled windings: dots at P1 and S1; k < 1 leaves leakage inductance.
        # Potentiometer: the track divided at the wiper (a sliver kept at the ends: no 0 Ω).
        "POT": SubcktModel(
            pins=["1", "2", "w"],
            params={"r": "10k", "pos": "0.5"},
            body=["R1 1 w {r*max(pos, 1e-6)}", "R2 w 2 {r*max(1-pos, 1e-6)}"],
            source="BiasPoint",
        ),
        # Fuse: a switch of resistance R opened when the integral of i² (on C1, 1 F) reaches
        # I²t (0.1 % hysteresis latches it: no current, no more heating, and it stays open).
        # Heating from t > 0 only: in the operating
        # point the integrator would charge without end (no current flows in a capacitor at DC).
        "FUSE": SubcktModel(
            pins=["1", "2"],
            params={"r": "10m", "i2t": "1"},
            body=[
                "Vsense 1 a 0",
                "S1 a 2 ctl 0 FUSESW",
                "Bheat 0 acc I={time > 0 ? I(Vsense)*I(Vsense) : 0}",
                "C1 acc 0 1",
                "Rleak acc 0 1e15",
                "Bctl ctl 0 V={1 - V(acc)/i2t}",
                ".model FUSESW sw(vt=0 vh=1m ron={r} roff=1e9)",
            ],
            source="BiasPoint",
        ),
        # Thyristor (SCR): the two-transistor model. A gate current turns the NPN on, its
        # collector current the PNP, whose collector current feeds the gate: it latches until the
        # anode current falls below what keeps the loop going. RGK sets the trigger current. OFF: the operating point
        # starts blocking (the loop has two solutions; ngspice would find the conducting one).
        "SCR": SubcktModel(
            pins=["a", "k", "g"],
            params={"rgk": "1k"},
            body=[
                "Q1 n1 g k SCRN OFF",
                "Q2 g n1 a SCRP OFF",
                "Rgk g k {rgk}",
                ".model SCRN npn(is=1e-14 bf=100 br=1 cjc=20p cje=50p tf=100n)",
                ".model SCRP pnp(is=1e-14 bf=1 br=1 cjc=20p cje=50p tf=1u)",
            ],
            source="BiasPoint",
        ),
        # Relay: the coil (R, L) and a changeover contact moved by the coil current, with the
        # pull-in and drop-out currents of the datasheet (the hysteresis between them).
        "RELAY": SubcktModel(
            pins=["a1", "a2", "com", "no", "nc"],
            params={"rcoil": "400", "lcoil": "200m", "ipull": "20m", "idrop": "6m", "ron": "50m"},
            body=[
                "Vsense a1 c1 0",
                "Rc c1 c2 {rcoil}",
                "Lc c2 a2 {lcoil}",
                "Bctl ctl 0 V={abs(I(Vsense))}",
                "S1 com no ctl 0 RLNO",
                "S2 com nc ctl 0 RLNC",
                ".model RLNO sw(vt={(ipull+idrop)/2} vh={(ipull-idrop)/2} ron={ron} roff=1e9)",
                ".model RLNC sw(vt={(ipull+idrop)/2} vh={(ipull-idrop)/2} ron=1e9 roff={ron})",
            ],
            source="BiasPoint",
        ),
        # Photodiode: a junction with the photocurrent IPH (at the light it is used at) flowing
        # from the cathode to the anode inside: out of the anode into the circuit.
        "PHOTODIODE": SubcktModel(
            pins=["a", "k"],
            params={"iph": "10u", "cj": "10p", "is": "1n"},
            body=["D1 a k PDJ", "Iph k a {iph}", ".model PDJ d(is={is} n=1 rs=10 cjo={cj})"],
            source="BiasPoint",
        ),
        # Optocoupler: an LED whose current, times the current transfer ratio CTR, is the
        # collector current of the phototransistor (its base fed CTR/BF of the LED current).
        "OPTO": SubcktModel(
            pins=["a", "k", "c", "e"],
            params={"ctr": "1", "bf": "200"},
            body=[
                "D1 a n1 OPTOLED",
                "Vsense n1 k 0",
                "F1 e b Vsense {ctr/bf}",
                "Q1 c b e OPTOQ",
                "Rbe b e 10meg",
                ".model OPTOLED d(is=1e-21 n=1.6 rs=2 cjo=20p)",
                ".model OPTOQ npn(is=1e-14 bf={bf} vaf=100 cjc=10p cje=20p tf=2u)",
            ],
            source="BiasPoint",
        ),
        # IGBT: a MOSFET feeding the base of a PNP (the collector its emitter): turned on by the
        # gate voltage, with the PNP's junction in the saturation voltage.
        "IGBT": SubcktModel(
            pins=["c", "g", "e"],
            params={"vth": "5", "kp": "5", "bf": "5"},
            body=[
                "M1 b g e e IGBTM W=1 L=1",
                "Q1 e b c IGBTQ",
                ".model IGBTM nmos(level=1 vto={vth} kp={kp} cgso=1n cgdo=200p)",
                ".model IGBTQ pnp(is=1e-14 bf={bf} rc=10m)",
            ],
            source="BiasPoint",
        ),
        # Voltage-controlled resistor: R = R0 / (1 + K * Vctrl), never below RMIN.
        "VCR": SubcktModel(
            pins=["1", "2", "cp", "cn"],
            params={"r0": "10k", "k": "1", "rmin": "1"},
            body=["B1 1 2 I={V(1,2)/max(r0/(1+k*V(cp,cn)), rmin)}", "Rc cp cn 1G"],
            source="BiasPoint",
        ),
        # Transformer with three windings: inductances by the turns ratios, all coupled by k.
        "XFMR3": SubcktModel(
            pins=["p1", "p2", "s1", "s2", "t1", "t2"],
            params={"lp": "1m", "ns": "1", "nt": "1", "k": "0.999"},
            body=[
                "Lp p1 p2 {lp}",
                "Ls s1 s2 {lp*ns*ns}",
                "Lt t1 t2 {lp*nt*nt}",
                "K1 Lp Ls Lt {k}",
            ],
            source="BiasPoint",
        ),
        # Triac: two thyristors back to back (inline: a subcircuit cannot call another here).
        # The gate is a junction pair to MT1; its current, either way, drives both thyristors'
        # gates (|Ig| each): it turns on with either polarity of gate and of MT2 (four quadrants).
        "TRIAC": SubcktModel(
            pins=["mt2", "mt1", "g"],
            params={"rgk": "1k"},
            body=[
                "Vsg g gx 0",
                "Dg1 gx mt1 TRG",
                "Dg2 mt1 gx TRG",
                "Bg1 mt1 g1 I={abs(I(Vsg))}",
                "Bg2 mt2 g2 I={abs(I(Vsg))}",
                "Q1a n1 g1 mt1 TRN OFF",
                "Q2a g1 n1 mt2 TRP OFF",
                "R1 g1 mt1 {rgk}",
                "Q1b n2 g2 mt2 TRN OFF",
                "Q2b g2 n2 mt1 TRP OFF",
                "R2 g2 mt2 {rgk}",
                ".model TRG d(is=1e-14 n=1)",
                ".model TRN npn(is=1e-14 bf=100 br=1 cjc=20p cje=50p tf=100n)",
                ".model TRP pnp(is=1e-14 bf=1 br=1 cjc=20p cje=50p tf=1u)",
            ],
            source="BiasPoint",
        ),
        # Diac: two thyristors back to back, each fired by a Zener from its anode when the
        # voltage reaches the breakover VBO; it then conducts until the current stops. The
        # diode in series keeps the other direction's Zener from conducting forward (a bypass).
        "DIAC": SubcktModel(
            pins=["a1", "a2"],
            params={"vbo": "32"},
            body=[
                "Dz1 m1 a1 DZB",
                "Db1 m1 g1 DB",
                "Q1a n1 g1 a2 TRN OFF",
                "Q2a g1 n1 a1 TRP OFF",
                "R1 g1 a2 100k",  # fires at about 6 uA (a diac: microamperes)
                "Dz2 m2 a2 DZB",
                "Db2 m2 g2 DB",
                "Q1b n2 g2 a1 TRN OFF",
                "Q2b g2 n2 a2 TRP OFF",
                "R2 g2 a1 100k",
                ".model DZB d(is=1e-14 bv={vbo-1.3} ibv=10u rs=10)",
                ".model DB d(is=1e-14 n=1)",
                ".model TRN npn(is=1e-14 bf=100 br=1 cjc=5p cje=10p tf=100n)",
                ".model TRP pnp(is=1e-14 bf=1 br=1 cjc=5p cje=10p tf=1u)",
            ],
            source="BiasPoint",
        ),
        # Phototransistor: an NPN whose base current is the photocurrent IPH (no base pin).
        "PHOTOQ": SubcktModel(
            pins=["c", "e"],
            params={"iph": "1u", "bf": "300"},
            body=[
                "Q1 c b e PHQ",
                "Iph c b {iph}",
                "Rbe b e 10meg",
                ".model PHQ npn(is=1e-14 bf={bf} vaf=100 cjc=10p cje=20p tf=2u)",
            ],
            source="BiasPoint",
        ),
        # Electromechanical parts in the force-current analogy: a mechanical node's voltage is
        # its speed (1 V = 1 rad/s, or 1 m/s), a current into it a torque (or force); an inertia
        # (mass) is a capacitor of that value, a friction b a resistor of 1/b.
        # DC motor: armature R, L and the back EMF ke*speed; the torque kt*current drives the
        # inertia J against the friction B. W is the shaft: its speed, a load torque into it.
        "MOTOR": SubcktModel(
            pins=["p", "n", "w"],
            params={"r": "1", "l": "1m", "ke": "10m", "kt": "10m", "j": "10u", "b": "1u"},
            body=[
                "Vsense p n1 0",
                "Ra n1 n2 {r}",
                "La n2 n3 {l}",
                "Bemf n3 n V={ke*V(w)}",
                "Bt 0 w I={kt*I(Vsense)}",
                "Cj w 0 {j}",
                "Rb w 0 {1/b}",
            ],
            source="BiasPoint",
        ),
        # Loudspeaker (Thiele-Small): voice coil Re, Le; the force BL*i drives the moving mass
        # Mms on the suspension's compliance Cms with its losses Rms; the cone's velocity makes
        # the back EMF BL*v. V: the cone velocity (1 V = 1 m/s).
        "SPEAKER": SubcktModel(
            pins=["p", "n", "v"],
            params={"re": "6", "le": "0.5m", "bl": "7", "mms": "20m", "cms": "0.5m", "rms": "2"},
            body=[
                "Vsense p n1 0",
                "Re n1 n2 {re}",
                "Le n2 n3 {le}",
                "Bemf n3 n V={bl*V(v)}",
                "Bf 0 v I={bl*I(Vsense)}",
                "Cm v 0 {mms}",
                "Lc v 0 {cms}",
                "Rm v 0 {1/rms}",
            ],
            source="BiasPoint",
        ),
        # NTC thermistor: R25 at 25 °C, following the B equation with the temperature given as
        # the voltage of T (1 V = 1 °C, against ground): a thermal circuit can drive it.
        "NTC": SubcktModel(
            pins=["1", "2", "t"],
            params={"r25": "10k", "beta": "3950"},
            body=[
                "B1 1 2 I={V(1,2)/(r25*exp(beta*(1/(V(t)+273.15)-1/298.15)))}",
                "Rt t 0 1G",
            ],
            source="BiasPoint",
        ),
        # Hall sensor (linear): the output at VQ (no field) plus the sensitivity times the field,
        # the field as the voltage of B (1 V = 1 mT), within the supply's 0..VMAX.
        "HALL": SubcktModel(
            pins=["b", "out", "gnd"],
            params={"vq": "2.5", "sens": "25m", "vmax": "5", "rout": "100"},
            body=[
                "B1 n1 gnd V={min(max(vq + sens*V(b, gnd), 0), vmax)}",
                "Ro n1 out {rout}",
                "Rb b gnd 1G",
            ],
            source="BiasPoint",
        ),
        "XFMR": SubcktModel(
            pins=["p1", "p2", "s1", "s2"],
            params={"lp": "100u", "ls": "100u", "k": "0.999"},
            body=["Lp p1 p2 {lp}", "Ls s1 s2 {ls}", "Kps Lp Ls {k}"],
            source="BiasPoint",
        ),
        "OPAMP_1P": SubcktModel(
            pins=["inp", "inn", "out"],
            params={"aol": "100k", "gbw": "1meg", "vmax": "15", "vmin": "-15", "rout": "50"},
            body=[
                "Rin inp inn 10meg",
                "G1 0 n1 inp inn {aol/1k}",
                "R1 n1 0 1k",
                "C1 n1 0 {aol/(6.2832*gbw*1k)}",
                "B1 n2 0 V={min(max(V(n1), vmin), vmax)}",
                "Rout n2 out {rout}",
            ],
            source="BiasPoint",
        ),
        "OPAMP": SubcktModel(
            pins=["inp", "inn", "vp", "vn", "out"],
            params={"aol": "100k", "gbw": "1meg", "swing": "0.1", "rout": "50"},
            body=[
                "Rin inp inn 10meg",
                "G1 0 n1 inp inn {aol/1k}",
                "R1 n1 0 1k",
                "C1 n1 0 {aol/(6.2832*gbw*1k)}",
                "B1 n2 0 V={min(max(V(n1), V(vn)+swing), V(vp)-swing)}",
                "Rout n2 out {rout}",
            ],
            source="BiasPoint",
        ),
    }
