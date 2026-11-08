"""The standard library's parts (FR-LIB-3, P7): real parts of named manufacturers, modelled
from their datasheets.

Each part is a component made from a template like a user's would be: the template's equivalent
circuit with the values found for the part. The values come from one manufacturer's datasheet
(named with its revision in the part's metadata): semiconductors and ceramic capacitors were
fitted to points read off the datasheet's typical curves or taken from its tables, kept with
the part as its source points and shown on its card; op-amps fill the macromodel's form with
the datasheet's table; electrolytics turn the catalogue's maxima (tan d, impedance, leakage)
into the template's values. Where a datasheet gives only a maximum or nothing (ESL of an
electrolytic, VAF of a BJT), the description says so. ``tests/test_standard_parts.py`` checks
every part against those values.

These are our models of the parts, not the manufacturers' own SPICE models.
"""

import math
from dataclasses import dataclass, field
from functools import cache

from bpt.document.model import Characteristic, Component
from bpt.library.libraries import all_templates
from bpt.models import templates as tpl
from bpt.models.semi_fit import zener_values
from bpt.models.user_templates import component_from_template

LIBRARY = "Standard parts"
_STD = "tpl:Standard templates/"
_TI = "https://www.ti.com/lit/ds/symlink/"


@dataclass
class Part:
    name: str
    template: str  # a built-in template ("mlcc") or a standard one ("tpl:...")
    form: dict[str, str]
    description: str
    metadata: dict[str, str] = field(default_factory=dict)
    ratings: dict[str, str] = field(default_factory=dict)
    source: list[Characteristic] = field(default_factory=list)  # the datasheet values fitted


def _points(name: str, points: list[tuple[float, float]], source: str = "datasheet table (typical)",
            **at: float) -> Characteristic:  # fmt: skip
    return Characteristic(name=name, points=points, at=at, source=source)


_ZENER = zener_values(5.1, 49e-3, 7)  # 1N4733A: VZ 5.1 V at IZT 49 mA, ZZT 7 ohm (max)

# Points read off the datasheets' typical curves (digitized) or taken from their tables.
_1N4148_VF = [(1e-6, 0.2602), (3e-6, 0.3184), (1e-5, 0.3808), (3e-5, 0.4363), (1e-4, 0.4973),
              (3e-4, 0.5501), (1e-3, 0.6098), (3e-3, 0.6653), (1e-2, 0.729), (3e-2, 0.794),
              (0.1, 0.8794)]  # fmt: skip
_1N4733A_VF = [(1e-6, 0.4797), (1e-5, 0.5542), (1e-4, 0.6219), (1e-3, 0.6953)]
_LED_VF = [(2e-3, 1.706), (5e-3, 1.753), (10e-3, 1.798), (15e-3, 1.823), (20e-3, 1.848),
           (25e-3, 1.874), (30e-3, 1.902)]  # fmt: skip
_2N7002_ID = [(2.5, 0.0234), (3.0, 0.0834), (3.5, 0.145), (4.0, 0.2295), (4.5, 0.384),
              (5.0, 0.499), (5.5, 0.644), (6.0, 0.799)]  # fmt: skip
_IRLZ44N_ID = [(2.3, 1.46), (2.6, 6.43), (2.8, 11.95), (3.2, 25.1), (3.7, 44.7), (4.2, 64.4),
               (4.7, 83.4), (5.2, 102.3), (5.7, 121.7), (6.2, 138), (6.7, 157)]  # fmt: skip
# Samsung characteristics sheets: |Z|(f) up to about ten times the self-resonance, C(V) as the
# DC bias curve (percent change applied to the small-signal capacitance).
_CL21_Z = [
    (1e4, 2.007),
    (2e4, 1.023),
    (5e4, 0.4161),
    (1e5, 0.2099),
    (2e5, 0.1046),
    (5e5, 0.04104),
    (1e6, 0.01814),
    (1.5e6, 0.009194),
    (2e6, 0.004568),
    (2.2e6, 0.003866),
    (2.5e6, 0.004183),
    (3e6, 0.006392),
    (5e6, 0.01469),
    (1e7, 0.0285),
    (2e7, 0.05531),
]
_CL21_DC = [(0.3, 0.55), (2, -4.53), (3, -14.73), (4, -25.94), (5, -35.95), (6, -44.68),
            (8, -57.81), (10, -66.89), (12.5, -74.06), (15, -79.87), (20, -85.84),
            (24.5, -89.32)]  # fmt: skip
_CL10_Z = [
    (1e3, 1625),
    (1e4, 168.1),
    (1e5, 17.16),
    (1e6, 1.735),
    (3e6, 0.5785),
    (1e7, 0.1493),
    (1.5e7, 0.07671),
    (2e7, 0.03745),
    (2.5e7, 0.03117),
    (3e7, 0.04685),
    (5e7, 0.116),
]
_CL10_DC = [
    (1, 0.94),
    (5, -0.72),
    (10, -8.87),
    (15, -19.41),
    (20, -29.93),
    (25, -40.05),
    (30, -48.74),
    (35, -55.79),
    (40, -61.23),
    (45, -65.88),
    (49.5, -70.21),
]


def _bias(c: float, curve: list[tuple[float, float]]) -> list[tuple[float, float]]:
    return [(v, c * (1 + d / 100)) for v, d in curve]


def _esr_120(tan_delta: float, c: float) -> float:
    """ESR at 120 Hz from the catalogue's loss tangent: tan d / (2 pi 120 C)."""
    return tan_delta / (2 * math.pi * 120 * c)


def _electrolytic(c: float, tan_delta: float, z_100k: float, leak_v: float, leak_i: float,
                  esl: str) -> dict[str, str]:  # fmt: skip
    """Catalogue maxima -> form: the 100 kHz impedance is the high-frequency ESR, the rise
    below 1 kHz makes the 120 Hz ESR of tan d, the leakage after one minute sets R leak."""
    rise = (_esr_120(tan_delta, c) - z_100k) * (1 + (120 / 1e3) ** 2)
    return {
        "Cnom": f"{c * 1e6:g}u",  # as on the can: 1000 µF, not 1 mF
        "esr": tpl.spice_text(z_100k),
        "rlf": f"{rise:.3g}",
        "flf": "1k",
        "esl": esl,
        "rleak": tpl.spice_text(round(leak_v / leak_i, -2)),
    }


_VISHAY = "Vishay"
_NICHICON_UPW = "https://www.nichicon.co.jp/english/series_items/catalog_pdf/e-upw.pdf"

PARTS: list[Part] = [
    # -- diodes --------------------------------------------------------------------------------
    Part("1N4148", _STD + "Diode (signal)",
         {"is": "5.656n", "n": "1.957", "rs": "343.6m", "bv": "100", "ibv": "100u", "cjo": "4p",
          "tt": "11.5n"},
         "Small-signal switching diode, 100 V, 300 mA. IS, N, RS fitted to the typical forward "
         "curve (Fig. 2, 25 °C, 0.4 % RMS); CD 4 pF and trr 8 ns are the table's maxima "
         "(TT = trr / ln 2)",
         {"manufacturer": _VISHAY, "part_number": "1N4148", "vf": "1", "trr": "4n",
          "technology": "silicon switching diode", "package": "DO-35",
          "datasheet": "https://www.vishay.com/docs/81857/1n4148.pdf (Rev. 1.6, 2024-11-07)"},
         {"voltage": "75", "current": "300m", "power": "500m"},
         [_points("VF(IF)", _1N4148_VF, source="Vishay 1N4148 Fig. 2, Tj = 25 °C")]),
    Part("1N4733A", _STD + "Zener diode",
         {"bv": f"{_ZENER['bv']:.4g}", "ibv": "49m", "rs": f"{_ZENER['rs']:.4g}",
          "is": "128.2f", "n": "1.172"},
         "Zener diode 5.1 V, 1.3 W. BV and RS from VZ 5.1 V at IZT 49 mA and ZZT 7 Ω (max); "
         "forward IS and N fitted to the typical forward curve up to 1 mA (Fig. 2)",
         {"manufacturer": _VISHAY, "part_number": "1N4733A", "technology": "silicon Zener",
          "vz": "5.1", "tolerance": "5",
          "package": "DO-41",
          "datasheet": "https://www.vishay.com/docs/85816/1n4728a.pdf (Rev. 2.7, 2024-11-07)"},
         {"power": "1.3", "current": "178m"},
         [_points("VZ(IZ)", [(49e-3, 5.1)], source="Vishay 1N4728A-1N4761A table: VZ at IZT1"),
          _points("VF(IF)", _1N4733A_VF, source="Vishay 1N4728A-1N4761A Fig. 2, Tj = 25 °C")]),
    Part("WP7113SRD", _STD + "LED",
         {"is": "0.0006148f", "n": "1.838", "rs": "2.292", "bv": "5", "cjo": "45p"},
         "Super-bright red LED (GaAlAs, 660 nm), 1.85 V at 20 mA. IS, N, RS fitted to the "
         "forward current vs voltage curve (0.2 % RMS); C 45 pF from the table",
         {"manufacturer": "Kingbright", "part_number": "WP7113SRD/D", "technology": "LED",
          "vf": "1.85", "wavelength": "640n",
          "package": "5 mm (T-1 3/4)", "color": "red",
          "datasheet": "https://www.kingbrightusa.com/images/catalog/SPEC/WP7113SRD-D.pdf "
                       "(DSAF2433 Rev. V.9A, 2020-08-05)"},
         {"current": "30m", "voltage": "5"},
         [_points("VF(IF)", _LED_VF, source="Kingbright WP7113SRD/D, forward current vs "
                                            "forward voltage, Ta = 25 °C")]),
    # -- bipolar transistors -------------------------------------------------------------------
    Part("BC547B", _STD + "NPN transistor",
         {"is": "16.02f", "bf": "472.3", "vaf": "74", "ikf": "88.33m", "ise": "11.4f",
          "ne": "1.326", "br": "1.949", "rb": "10", "rc": "1.133", "cje": "9p", "cjc": "3.5p",
          "tf": "498.2p"},
         "General-purpose NPN, 45 V, 100 mA, gain group B. Gummel-Poon fitted to the typical "
         "hFE, VCE(sat) and VBE of the table (hFE at 2 mA: middle of the 200-450 range); "
         "capacitances and TF from CCBO, CEBO and fT 300 MHz. VAF is not in the datasheet",
         {"manufacturer": "Diotec", "part_number": "BC547B", "technology": "silicon NPN",
          "hfe": "200-450", "ft": "300meg", "gain_group": "B",
          "package": "TO-92",
          "datasheet": "https://diotec.com/request/datasheet/bc546.pdf (version 2026-03-30)"},
         {"voltage": "45", "current": "100m", "power": "500m"},
         [_points("hFE(Ic)", [(10e-6, 150), (2e-3, 300), (100e-3, 200)], Vce=5),
          _points("VCEsat(Ic)", [(10e-3, 0.08), (100e-3, 0.2)], beta=20),
          _points("VBE(Ic)", [(2e-3, 0.66)], Vce=5)]),
    Part("BC557B", _STD + "PNP transistor",
         {"is": "15.89f", "bf": "457.5", "vaf": "65", "ikf": "89.76m", "ise": "12.54f",
          "ne": "1.336", "br": "2.474", "rb": "10", "rc": "1.692", "cje": "10p", "cjc": "3.5p",
          "tf": "1.026n"},
         "General-purpose PNP, 45 V, 100 mA, gain group B. Gummel-Poon fitted to the typical "
         "hFE, VCE(sat) and VBE of the table (hFE at 2 mA: middle of the 200-450 range); "
         "capacitances and TF from CCBO, CEBO and fT 150 MHz. VAF is not in the datasheet",
         {"manufacturer": "Diotec", "part_number": "BC557B", "technology": "silicon PNP",
          "hfe": "200-450", "ft": "150meg", "gain_group": "B",
          "package": "TO-92",
          "datasheet": "https://diotec.com/request/datasheet/bc556.pdf"},
         {"voltage": "45", "current": "100m", "power": "500m"},
         [_points("hFE(Ic)", [(-10e-6, 150), (-2e-3, 300), (-100e-3, 200)], Vce=-5),
          _points("VCEsat(Ic)", [(-10e-3, -0.08), (-100e-3, -0.25)], beta=20),
          _points("VBE(Ic)", [(-2e-3, -0.66)], Vce=-5)]),
    # -- MOSFETs -------------------------------------------------------------------------------
    Part("2N7002", _STD + "N-channel MOSFET",
         {"vto": "1.882", "kp": "134.7m", "lambda": "0", "rd": "0", "rs": "802.5m",
          "cgso": "20p", "cgdo": "2p", "cbd": "9p"},
         "Small-signal N-channel MOSFET, 60 V, 170 mA. Level 1 fitted to the output curves at "
         "VDS = 5 V (Fig. 1) and the typical RDS(on) (3.2 Ω at 5 V, 1.7 Ω at 10 V): 5 % RMS, "
         "the real curve is less square-law than level 1. Capacitances from Ciss, Coss, Crss",
         {"manufacturer": "Diodes Incorporated", "part_number": "2N7002", "rds_on": "3.2",
          "vgs_th": "1-2.5", "logic_level": "no",
          "technology": "N-channel enhancement MOSFET", "package": "SOT-23",
          "datasheet": "https://www.diodes.com/assets/Datasheets/ds11303.pdf "
                       "(DS11303 Rev. 33-2, 2013-07)"},
         {"voltage": "60", "current": "170m", "power": "370m"},
         [_points("Id(Vgs)", _2N7002_ID, Vds=5),
          _points("RDS(Vgs)", [(5, 3.2), (10, 1.7)])]),
    Part("IRLZ44N", _STD + "N-channel MOSFET",
         {"vto": "2.107", "kp": "100.3", "lambda": "0", "rd": "0", "rs": "16.61m",
          "cgso": "1.55n", "cgdo": "150p", "cbd": "250p"},
         "Logic-level power MOSFET, 55 V, 47 A. Level 1 fitted to the typical transfer curve "
         "(Fig. 3, VDS = 25 V) and RDS(on) read off the output curves (Fig. 1: 23.5 mΩ at 4 V, "
         "17.5 mΩ at 10 V): 5 % RMS. Capacitances from Ciss, Coss, Crss",
         {"manufacturer": "Infineon (International Rectifier)", "part_number": "IRLZ44NPbF",
          "rds_on": "17.5m", "vgs_th": "1-2", "logic_level": "yes",
          "technology": "N-channel power MOSFET", "package": "TO-220AB",
          "datasheet": "https://www.infineon.com/dgdl/irlz44npbf.pdf"
                       "?fileId=5546d462533600a40153567217c32725"},
         {"voltage": "55", "current": "47", "power": "110"},
         [_points("Id(Vgs)", _IRLZ44N_ID, Vds=25),
          _points("RDS(Vgs)", [(4, 0.0235), (10, 0.0175)])]),
    # -- op-amps (macromodel form = the datasheet's table) -----------------------------------
    Part("LM358", _STD + "Op-amp macromodel",
         {"aol": "100k", "gbw": "700k", "sr": "300k", "vos": "3m", "ib": "20n", "cmrr": "80",
          "psrr": "100", "vohigh": "1.5", "volow": "5m", "iout": "40m", "iq": "350u"},
         "Dual general-purpose op-amp, 3-32 V, inputs and output down to the negative rail "
         "(typical values of the LM358 table, §5.7)",
         {"manufacturer": "Texas Instruments", "part_number": "LM358", "channels": "2",
          "gbw": "700k", "sr": "300k", "input": "bipolar", "rail_to_rail": "no",
          "technology": "bipolar op-amp",
          "datasheet": _TI + "lm358.pdf (SLOS068AB, revised 2024-10)"},
         {"voltage": "32"}),
    Part("LMV358", _STD + "Op-amp macromodel",
         {"aol": "100k", "gbw": "1meg", "sr": "1meg", "vos": "1.7m", "ib": "15n", "cmrr": "65",
          "psrr": "60", "vohigh": "10m", "volow": "65m", "iout": "40m", "iq": "105u"},
         "Low-voltage dual op-amp, 2.7-5.5 V, rail-to-rail output (typical values at 5 V, "
         "§6.8; output swing with RL = 10 kΩ, supply current per amplifier)",
         {"manufacturer": "Texas Instruments", "part_number": "LMV358", "channels": "2",
          "gbw": "1meg", "sr": "1meg", "input": "CMOS", "rail_to_rail": "output",
          "technology": "CMOS op-amp",
          "datasheet": _TI + "lmv358.pdf (SLOS263Y, revised 2023-08)"},
         {"voltage": "5.5"}),
    Part("TL072", _STD + "Op-amp macromodel",
         {"aol": "200k", "gbw": "5.25meg", "sr": "20meg", "vos": "3m", "ib": "65p",
          "cmrr": "100", "psrr": "100", "vohigh": "1.5", "volow": "1.5", "iout": "26m",
          "iq": "1.4m"},
         "Low-noise JFET-input dual op-amp, ±18 V (typical values of the TL07xC tables §5.8-5.9 "
         "at ±15 V, SOIC; short-circuit current from the TL07xH table)",
         {"manufacturer": "Texas Instruments", "part_number": "TL072", "channels": "2",
          "gbw": "5.25meg", "sr": "20meg", "input": "JFET", "rail_to_rail": "no",
          "technology": "JFET-input op-amp",
          "datasheet": _TI + "tl072.pdf (SLOS080W, revised 2025-07)"},
         {"voltage": "36"}),
    # -- capacitors ----------------------------------------------------------------------------
    Part("CL21A106KAYNNNG 10uF 25V X5R 0805", "mlcc",
         {"Cnom": "7.813u", "vhalf": "7.635", "esr": "3.3m", "esl": "566.8p", "rleak": ""},
         "Ceramic 10 µF X5R, rated at 1 kHz 1 Vrms; the impedance curve (0.5 Vrms) shows "
         "7.8 µF at small signal, as used here. ESL fitted to |Z|(f), ESR the minimum of the "
         "ESR curve, V½ fitted to the DC bias curve (half the capacitance near 7.6 V)",
         {"manufacturer": "Samsung Electro-Mechanics", "part_number": "CL21A106KAYNNNG",
          "dielectric": "X5R", "tolerance": "10", "series": "CL",
          "technology": "MLCC X5R", "package": "0805",
          "datasheet": "Samsung MLCC characteristics sheet CL21A106KAYNNNG"},
         {"voltage": "25"},
         [_points("|Z|(f)", _CL21_Z, source="Samsung characteristics sheet, impedance"),
          _points("C(V)", _bias(7.813e-6, _CL21_DC),
                  source="Samsung characteristics sheet, DC bias (1 kHz, 1 Vrms)")]),
    Part("CL10B104KB85PNC 100nF 50V X7R 0603", "mlcc",
         {"Cnom": "100n", "vhalf": "31.67", "esr": "20m", "esl": "481.1p", "rleak": ""},
         "Ceramic 100 nF X7R decoupling capacitor. ESL fitted to |Z|(f) up to 50 MHz, ESR the "
         "minimum of the ESR curve, V½ fitted to the DC bias curve (2 % RMS)",
         {"manufacturer": "Samsung Electro-Mechanics", "part_number": "CL10B104KB85PNC",
          "dielectric": "X7R", "tolerance": "10", "series": "CL",
          "technology": "MLCC X7R", "package": "0603",
          "datasheet": "Samsung MLCC characteristics sheet CL10B104KB85PNC"},
         {"voltage": "50"},
         [_points("|Z|(f)", _CL10_Z, source="Samsung characteristics sheet, impedance"),
          _points("C(V)", _bias(100e-9, _CL10_DC),
                  source="Samsung characteristics sheet, DC bias (1 kHz, 1 Vrms)")]),
    Part("UPW1E221MPD 220uF 25V", "electrolytic",
         _electrolytic(220e-6, 0.14, 0.117, 25, 165e-6, "10n"),
         "Low-impedance aluminium electrolytic, 105 °C, 555 mA ripple at 100 kHz. From the "
         "catalogue's maxima: ESR 117 mΩ at 100 kHz, tan δ 0.14 at 120 Hz, leakage 165 µA "
         "after 1 minute; ESL is not in the catalogue (10 nH, typical of an 8 mm can)",
         {"manufacturer": "Nichicon", "part_number": "UPW1E221MPD", "series": "UPW",
          "tolerance": "20", "size": "8 x 11.5", "ripple": "0.555",
          "temperature_range": "-55 to 105",
          "technology": "aluminium electrolytic, low impedance", "package": "radial 8x11.5",
          "datasheet": _NICHICON_UPW + " (CAT.8100N)"},
         {"voltage": "25"}),
    Part("UPW1C102MPD 1000uF 16V", "electrolytic",
         _electrolytic(1000e-6, 0.16, 0.052, 16, 480e-6, "15n"),
         "Low-impedance aluminium electrolytic, 105 °C, 1.22 A ripple at 100 kHz. From the "
         "catalogue's maxima: ESR 52 mΩ at 100 kHz, tan δ 0.16 at 120 Hz, leakage 480 µA after "
         "1 minute; ESL is not in the catalogue (15 nH, typical of a 10 mm can)",
         {"manufacturer": "Nichicon", "part_number": "UPW1C102MPD", "series": "UPW",
          "tolerance": "20", "size": "10 x 20", "ripple": "1.22", "temperature_range": "-55 to 105",
          "technology": "aluminium electrolytic, low impedance", "package": "radial 10x20",
          "datasheet": _NICHICON_UPW + " (CAT.8100N)"},
         {"voltage": "16"}),
]  # fmt: skip


def _component(part: Part) -> Component:
    if part.template.startswith("tpl:"):
        component = component_from_template(all_templates()[part.template], part.form, LIBRARY,
                                            part.name, characteristics=part.source)  # fmt: skip
    else:
        component = tpl.template_component(tpl.get(part.template), part.form, LIBRARY, part.name,
                                           characteristics=part.source)  # fmt: skip
    return component.model_copy(update={
        "description": part.description, "metadata": part.metadata, "ratings": part.ratings,
    })  # fmt: skip


@cache
def _built() -> tuple[Component, ...]:
    return tuple(_component(p) for p in PARTS)


def standard_parts() -> list[Component]:
    return [c.model_copy(deep=True) for c in _built()]
