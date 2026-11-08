"""Components of the standard library built in code: a layered example (FR-CMP-6).

* **LM2596** (IC, behavioural): the 150 kHz buck regulator of the common "LM2596 step-down
  module", modelled from its datasheet (Texas Instruments SNVS124): 1.23 V reference, switch
  saturation about 1.16 V at 3 A, current limit 3.6 A, 5 mA quiescent current, ON/OFF pin
  (off above 1.3 V), undervoltage lockout near 4.5 V. Voltage mode: an integrating error
  amplifier with an internal soft start compares the feedback pin with the reference and sets
  the duty cycle against a 0-1 V ramp. It is our behavioural model, not the manufacturer's;
  the switch is a smooth conductance so ngspice resolves each edge.
* **LM2596 step-down module**: the IC with the parts of the board - 470 uF input and 220 uF
  output electrolytics with their ESR, a 33 uH inductor with its winding resistance, an SS34
  Schottky diode and the feedback divider that sets ``vout`` (the board's trimmer).

The module contains the IC as a component (its sheet keeps the IC's identity), so a project
placing the module has three levels to enter and probe: project, module, IC. Both sheets are
drawn with wires like a person would draw them; net labels name only the nets the behavioural
sources read (on, css, comp, ramp, drv) and the pins.
"""

from functools import cache

from bpt.document.drawing import Drawing
from bpt.document.model import Component, ComponentInfo, Sheet, SheetVariant
from bpt.library.builtin import builtin_symbols
from bpt.models.templates import get as get_template
from bpt.models.templates import template_component
from bpt.models.user_templates import component_from_template

LIBRARY = "Standard examples"
IC_ID = f"cmp:{LIBRARY}/LM2596"
MODULE_ID = f"cmp:{LIBRARY}/LM2596 step-down module"
DATASHEET = "https://www.ti.com/lit/ds/symlink/lm2596.pdf"

# Helper functions of the IC's sources, shown on its sheet:
# soft(x): a smooth 0..1 step; sat(x, m): x until near the limit m, then flat at m
# (x / (1 + (x/m)^8)^(1/8)): with x = V/Ron the switch drops 1.16 V at 2.9 A, as in the
# datasheet, and gives 3.6 A at most.
_FUNCS = [".func soft(x) {0.5+0.5*tanh(x)}",
          ".func sat(x, m) {x/pwr(1+pwr(x*x/(m*m),4),0.125)}"]  # fmt: skip
_ON = "soft(10*(V(VIN,GND)-4.5))*soft(20*(1.3-V(ONOFF,GND)))"  # above UVLO, ON/OFF low
_SOFT_START = "10u*V(on,GND)"  # into Css while on
_REF_CLAMP = "max(V(css,GND)-{vref},0)"  # Css stops at the reference
_ERROR_AMP = "20u*(V(css,GND)-V(FB,GND))"  # transconductance into Cc (and Ro)
_COMP_CLAMP = "1m*(V(comp,GND)-min(max(V(comp,GND),0),1.1))"  # comp within 0..1.1 V
_PWM = "V(on,GND)*soft(200*(V(comp,GND)-V(ramp,GND)))"
_SWITCH = "sat(V(VIN,OUT)*V(drv,GND)/{ron},{ilim})"
_RAMP = "PULSE(0 1 0 {0.97/fsw} {0.02/fsw} {0.01/fsw} {1/fsw})"  # 0-1 V sawtooth at fsw
# Averaged model (no switching): the duty cycle is the error amplifier's output (the ramp goes
# 0..1 V), the switch node carries its average d x (VIN - Ron x I) - (1 - d) x VF (the catch
# diode's drop while the switch is off, fading at no current), the input draws d x I.
_DUTY = "V(on,GND)*min(max(V(comp,GND),0),1)"
_AVERAGE = "V(d,GND)*(V(VIN,GND)-{ron}*I(Vsns))-(1-V(d,GND))*{vf}*tanh(I(Vsns)/0.1)"
_QUIESCENT_AVG = "{iq}+V(d,GND)*I(Vsns)"


def _ic_sheet(averaged: bool = False) -> Sheet:
    """The LM2596 as drawn: switching, or averaged (the same control, no switching)."""
    params = {"fsw": "150k", "vref": "1.23", "ron": "0.39", "ilim": "3.6", "iq": "5m",
              "tss": "1m"}  # fmt: skip
    if averaged:
        params["vf"] = "0.4"  # the catch diode's drop the averaged model assumes
    d = Drawing("lm2596_avg" if averaged else "lm2596", params)
    d.directive("\n".join(_FUNCS), (-5080, -3302))
    # Pins and the power path: VIN -> switch -> OUT, quiescent current, input resistances.
    d.port("VIN", (-5080, -2032))
    d.port("ONOFF", (-5080, -1524))
    d.port("FB", (-5080, -1016))
    d.port("GND", (-5080, 3810))
    d.part("resistor", "Rfb", (-3048, 0), R="10meg")
    d.part("resistor", "Ren", (-2032, 0), R="10meg")
    d.part("bsource", "Bq", (-1016, 0), i=_QUIESCENT_AVG if averaged else "{iq}")
    d.wire((-5080, -1016), (-3048, -1016), d.pin("Rfb", "1"))
    d.wire((-5080, -1524), (-2032, -1524), d.pin("Ren", "1"))
    d.wire((-5080, -2032), (-1016, -2032))
    d.wire(d.pin("Bq", "+"), (-1016, -2032))
    if averaged:
        # The switch node as its average, a 0 V source to read the current through it.
        d.part("bsource", "Bavg", (10160, 0), v=_AVERAGE)
        d.part("vsource", "Vsns", (11176, -2032), rot=270, dc="0")
        d.port("OUT", (12700, -2032))
        d.wire(d.pin("Bavg", "+"), (10160, -2032), d.pin("Vsns", "+"))
        d.wire(d.pin("Vsns", "-"), (12700, -2032))
    else:
        d.part("bsource", "Bsw", (1524, -2032), rot=270, i=_SWITCH)
        d.port("OUT", (5080, -2032))
        d.wire((-1016, -2032), d.pin("Bsw", "+"))
        d.wire(d.pin("Bsw", "-"), (5080, -2032))
    # Enable and soft start: Css charged by 10 uA up to the reference.
    d.part("bsource", "Bon", (0, 0), v=_ON)
    d.part("bsource", "Bss", (4572, 0), rot=180, mirror=True, i=_SOFT_START)
    d.part("capacitor", "Css", (6350, 0), C="{10u*tss/vref}")
    d.part("bsource", "Bref", (8128, 0), i=_REF_CLAMP)
    d.wire(d.pin("Bon", "+"), (0, -762))
    d.label("on", (0, -762))
    d.wire(d.pin("Bss", "-"), d.pin("Css", "1"), d.pin("Bref", "+"))
    d.label("css", (5334, -381))
    row = [("Rfb", "2"), ("Ren", "2"), ("Bq", "-"), ("Bon", "-"), ("Bss", "+"), ("Css", "2"),
           ("Bref", "-"), *([("Bavg", "-")] if averaged else [])]  # fmt: skip
    for ref, pin in row:
        x, y = d.pin(ref, pin)
        d.wire((x, y), (x, 762))
    d.wire(*[(d.pin(ref, pin)[0], 762) for ref, pin in row])
    d.wire((-3048, 762), (-3048, 3810))
    # Error amplifier with its compensation, the ramp and the PWM comparator.
    d.part("bsource", "Bea", (0, 3048), rot=180, mirror=True, i=_ERROR_AMP)
    d.part("resistor", "Ro", (2794, 3048), R="100meg")
    d.part("capacitor", "Cc", (3810, 3048), C="22n")
    d.part("bsource", "Bclamp", (4826, 3048), i=_COMP_CLAMP)
    d.wire(d.pin("Bea", "-"), d.pin("Ro", "1"), d.pin("Cc", "1"), d.pin("Bclamp", "+"))
    d.label("comp", (1397, 2667))
    if averaged:
        d.part("bsource", "Bd", (8636, 3048), v=_DUTY)
        d.wire(d.pin("Bd", "+"), (8636, 2286))
        d.label("d", (8636, 2286))
        last = [("Bd", "-")]
    else:
        d.part("vsource", "Vramp", (8636, 3048), dc="0", tran=_RAMP)
        d.part("bsource", "Bpwm", (13208, 3048), v=_PWM)
        d.wire(d.pin("Vramp", "+"), (8636, 2286))
        d.label("ramp", (8636, 2286))
        d.wire(d.pin("Bpwm", "+"), (13208, 2286))
        d.label("drv", (13208, 2286))
        last = [("Vramp", "-"), ("Bpwm", "-")]
    row = [("Bea", "+"), ("Ro", "2"), ("Cc", "2"), ("Bclamp", "-"), *last]
    for ref, pin in row:
        x, y = d.pin(ref, pin)
        d.wire((x, y), (x, 3810))
    d.wire((-5080, 3810), (-3048, 3810), *[(d.pin(ref, pin)[0], 3810) for ref, pin in row])
    sheet = d.sheet
    sheet.port_order = ["VIN", "ONOFF", "OUT", "FB", "GND"]
    sheet.port_sides = {"VIN": "left", "ONOFF": "left", "OUT": "right", "FB": "right",
                        "GND": "bottom"}  # fmt: skip
    return sheet


def _ic() -> Component:
    return Component(
        id=IC_ID, name="LM2596", kind="ic", category="Power/Switching regulators",
        description="150 kHz 3 A step-down regulator, adjustable (behavioural model from the "
        "datasheet)",
        metadata={"manufacturer": "Texas Instruments", "part_number": "LM2596S-ADJ",
                  "package": "TO-263-5", "technology": "behavioural model (not the "
                  "manufacturer's)", "datasheet": DATASHEET, "topology": "buck",
                  "vin": "4.5-40", "vout": "1.23-37", "frequency": "150k"},
        ratings={"voltage": "40", "current": "3"},
        sheets=[_with_average(_ic_sheet(), "lm2596_avg"), _ic_sheet(averaged=True)],
    )  # fmt: skip


def _with_average(sheet: Sheet, averaged: str) -> Sheet:
    """``sheet`` offering its averaged model as "Simulate as" (FR-CMP-8)."""
    sheet.variant_label = "Switching (full)"
    sheet.variants = [SheetVariant(
        name="averaged", label="Averaged (no switching)", sheet=averaged, faster=True,
        description="Average of each switching period: the same control loop and start-up, "
        "no ripple, many times faster. Use it for long runs and load steps.",
    )]  # fmt: skip
    return sheet


def _part(component: Component) -> Sheet:
    """A component's (single) sheet as it sits inside another one: it keeps its identity."""
    info = ComponentInfo.model_validate(component.model_dump(exclude={"sheets"}))
    return component.sheets[0].model_copy(update={"component": info})


def _electrolytic(name: str, c: str, esr: str, ratings: dict[str, str]) -> Component:
    form = {"Cnom": c, "esr": esr, "rlf": "", "flf": "", "esl": "15n", "rleak": "100k"}
    component = template_component(get_template("electrolytic"), form, LIBRARY, name)
    return component.model_copy(update={
        "description": f"{c}F aluminium electrolytic, low ESR (typical of the module's board)",
        "metadata": {"technology": "aluminium electrolytic", "package": "radial"},
        "ratings": ratings,
    })  # fmt: skip


def _inductor() -> Component:
    form = {"Lnom": "33u", "dcr": "50m"}
    component = template_component(get_template("inductor"), form, LIBRARY, "33uH power inductor")
    return component.model_copy(update={
        "description": "33 uH toroidal power inductor of the module",
        "metadata": {"technology": "ferrite toroid", "package": "toroid"},
        "ratings": {"current": "3"},
    })  # fmt: skip


def _ss34() -> Component:
    from bpt.models.standard_templates import standard_templates

    diode = next(t for t in standard_templates() if t.name == "Diode (signal)")
    # Fitted to the typical forward voltage of the datasheets: 0.39 V at 1 A, 0.5 V at 3 A;
    # no stored charge (Schottky), 300 pF at 0 V, 40 V reverse.
    form = {"is": "5u", "n": "1.1", "rs": "40m", "bv": "40", "ibv": "1m", "cjo": "300p",
            "vj": "0.4", "mj": "0.5", "tt": "0"}  # fmt: skip
    component = component_from_template(diode, form, LIBRARY, "SS34")
    top = component.sheets[0]
    if top.symbol is not None:  # drawn as a Schottky diode, not a plain one
        looks = builtin_symbols()["bpt:diode"].looks
        schottky = next(lk for lk in looks if lk.name == "schottky")
        top.symbol = top.symbol.model_copy(update={"graphics": schottky.graphics, "looks": []})
    return component.model_copy(update={
        "description": "3 A 40 V Schottky rectifier (model from typical datasheet values)",
        "category": "Diodes/Schottky",
        "metadata": {"part_number": "SS34", "technology": "Schottky", "package": "SMA (DO-214AC)"},
        "ratings": {"voltage": "40", "current": "3"},
    })  # fmt: skip


def _module_sheet(ic: Sheet, parts: dict[str, Sheet], averaged: bool = False) -> Sheet:
    """The board; ``averaged``: the same board with the IC simulated as its averaged model."""
    d = Drawing("lm2596_module_avg" if averaged else "lm2596_module", {"vout": "5"})
    d.block(ic, "U1", (0, 0))
    if averaged:
        d.sheet.instances[-1].model.variant = "averaged"
    d.block(parts["cin"], "C1", (-2540, 254))
    d.block(parts["diode"], "D1", (1778, 254), rot=180, mirror=True)
    d.block(parts["inductor"], "L1", (2540, -127), rot=270)
    d.part("resistor", "R1", (3556, 254), R="{1k*(vout/1.23-1)}")
    d.part("resistor", "R2", (3556, 1016), R="1k")
    d.block(parts["cout"], "C2", (5588, 254))
    # Input: IN+ -> C1 -> VIN; ON/OFF tied low (always on).
    d.port("IN+", (-4064, -127))
    d.wire((-4064, -127), d.pin("C1", "1"), d.pin("U1", "VIN"))
    d.wire(d.pin("U1", "ONOFF"), (-1524, 127), (-1524, 1778))
    # Switch node -> L1 -> output; the diode catches the inductor current.
    d.wire(d.pin("U1", "OUT"), d.pin("D1", "K"), d.pin("L1", "1"))
    d.label("sw", (1270, -127))
    d.port("OUT+", (6604, -127))
    d.wire(d.pin("L1", "2"), d.pin("R1", "1"), d.pin("C2", "1"), (6604, -127))
    # Feedback: the divider sets vout = 1.23 V * (1 + R1 / R2) (the board's trimmer).
    d.wire(d.pin("U1", "FB"), (1270, 127), (1270, 1270), (3048, 1270), (3048, 635),
           d.pin("R1", "2"))  # fmt: skip
    d.label("fb", (3302, 635))
    # Ground rail.
    drops = [d.pin("C1", "2"), (-1524, 1778), d.pin("U1", "GND"), d.pin("D1", "A"),
             d.pin("R2", "2"), d.pin("C2", "2")]  # fmt: skip
    for x, y in drops:
        if y != 1778:
            d.wire((x, y), (x, 1778))
    d.port("GND", (-4064, 1778))
    d.wire((-4064, 1778), *[(x, 1778) for x, _y in drops])
    sheet = d.sheet
    sheet.port_order = ["IN+", "OUT+", "GND"]
    sheet.port_sides = {"IN+": "left", "OUT+": "right", "GND": "bottom"}
    return sheet


def _module(ic: Component, parts: dict[str, Component]) -> Component:
    inner = _part(ic)
    sheets = {key: _part(c) for key, c in parts.items()}
    board = _with_average(_module_sheet(inner, sheets), "lm2596_module_avg")
    return Component(
        id=MODULE_ID, name="LM2596 step-down module", kind="module",
        description="The common blue DC-DC board: 4.5-40 V in, adjustable out, up to 3 A",
        metadata={"technology": "LM2596S-ADJ, 33 uH, 470 uF / 220 uF electrolytics, SS34",
                  "datasheet": DATASHEET, "topology": "buck", "vin": "4.5-40",
                  "vout": "1.25-35"},
        ratings={"voltage": "35", "current": "3"},
        sheets=[board, _module_sheet(inner, sheets, averaged=True), inner, ic.sheets[1],
                *sheets.values()],
    )  # fmt: skip


@cache
def _built() -> tuple[Component, ...]:
    ic = _ic()
    parts = {
        "cin": _electrolytic("470uF 35V electrolytic", "470u", "80m", {"voltage": "35"}),
        "cout": _electrolytic("220uF 35V electrolytic", "220u", "100m", {"voltage": "35"}),
        "inductor": _inductor(),
        "diode": _ss34(),
    }
    return (ic, *parts.values(), _module(ic, parts))


def standard_components() -> list[Component]:
    return [c.model_copy(deep=True) for c in _built()]
