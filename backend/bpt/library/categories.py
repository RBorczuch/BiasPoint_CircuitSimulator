"""Categories of parts (docs/projekt-elementy.md §3): where the library lists a part, and the
data a part of that category is described by (dielectric of a capacitor, VCEO of a transistor).

A category is a path "Capacitors/Ceramic"; a part without one of its own gets it from its
template, symbol or kind. The data fields are keys of the part's ``metadata`` (texts such as the
dielectric or package) or ``ratings`` (rated voltage, current, power); the library filters and
the hover card use them.
"""

from dataclasses import dataclass, field
from typing import Literal

from pydantic import BaseModel

FieldType = Literal["text", "enum", "number"]


@dataclass(frozen=True)
class DataField:
    key: str
    label: str
    type: FieldType = "text"
    unit: str = ""
    options: tuple[str, ...] = ()  # an enum's usual values (others may be typed)
    source: Literal["metadata", "ratings"] = "metadata"


@dataclass(frozen=True)
class Category:
    path: str
    fields: tuple[DataField, ...] = field(default_factory=tuple)
    description: str = ""


# -- common fields ------------------------------------------------------------------------------
MANUFACTURER = DataField("manufacturer", "Manufacturer")
PART_NUMBER = DataField("part_number", "Part number")
PACKAGE = DataField("package", "Package")
SERIES = DataField("series", "Series")
TOLERANCE = DataField("tolerance", "Tolerance", "enum", "%",
                      ("0.1", "0.5", "1", "2", "5", "10", "20"))  # fmt: skip
VOLTAGE = DataField("voltage", "Rated voltage", "number", "V", source="ratings")
CURRENT = DataField("current", "Rated current", "number", "A", source="ratings")
POWER = DataField("power", "Rated power", "number", "W", source="ratings")
TEMP_RANGE = DataField("temperature_range", "Temperature range", unit="°C")
SMD_PACKAGES = ("0201", "0402", "0603", "0805", "1206", "1210", "1812", "2512")

_RESISTOR = (MANUFACTURER, PART_NUMBER, PACKAGE, TOLERANCE, POWER, VOLTAGE,
             DataField("tcr", "TCR", "number", "ppm/K"),
             DataField("technology", "Technology", "enum",
                       options=("thick film", "thin film", "metal film", "carbon film",
                                "wirewound", "metal foil")))  # fmt: skip
_CAPACITOR = (MANUFACTURER, PART_NUMBER, SERIES, PACKAGE, VOLTAGE, TOLERANCE, TEMP_RANGE)
_INDUCTOR = (MANUFACTURER, PART_NUMBER, SERIES, PACKAGE, CURRENT,
             DataField("isat", "Saturation current", "number", "A", source="ratings"),
             DataField("shielded", "Shielded", "enum", options=("yes", "no", "semi")),
             DataField("core", "Core", "enum", options=("ferrite", "iron powder", "air",
                                                        "metal composite")))  # fmt: skip
_DIODE = (MANUFACTURER, PART_NUMBER, PACKAGE,
          DataField("voltage", "Reverse voltage VRRM", "number", "V", source="ratings"),
          DataField("current", "Forward current IF", "number", "A", source="ratings"),
          DataField("vf", "Forward voltage VF", "number", "V"),
          DataField("trr", "Reverse recovery trr", "number", "s"), POWER)  # fmt: skip
_BJT = (MANUFACTURER, PART_NUMBER, PACKAGE,
        DataField("voltage", "VCEO", "number", "V", source="ratings"),
        DataField("current", "IC max", "number", "A", source="ratings"), POWER,
        DataField("hfe", "hFE", "number"), DataField("ft", "fT", "number", "Hz"),
        DataField("gain_group", "Gain group", "enum", options=("A", "B", "C")))  # fmt: skip
_MOSFET = (MANUFACTURER, PART_NUMBER, PACKAGE,
           DataField("voltage", "VDS", "number", "V", source="ratings"),
           DataField("current", "ID max", "number", "A", source="ratings"), POWER,
           DataField("rds_on", "RDS(on)", "number", "Ω"),
           DataField("vgs_th", "VGS(th)", "number", "V"),
           DataField("logic_level", "Logic level", "enum", options=("yes", "no")))  # fmt: skip
_OPAMP = (MANUFACTURER, PART_NUMBER, PACKAGE,
          DataField("channels", "Channels", "enum", options=("1", "2", "4")),
          DataField("voltage", "Max. supply", "number", "V", source="ratings"),
          DataField("gbw", "GBW", "number", "Hz"), DataField("sr", "Slew rate", "number", "V/s"),
          DataField("input", "Input", "enum", options=("bipolar", "JFET", "CMOS")),
          DataField("rail_to_rail", "Rail to rail", "enum",
                    options=("no", "input", "output", "input and output")))  # fmt: skip
_REGULATOR = (MANUFACTURER, PART_NUMBER, PACKAGE,
              DataField("vin", "Input voltage", unit="V"), DataField("vout", "Output voltage",
                                                                     unit="V"),
              CURRENT, DataField("topology", "Topology", "enum",
                                 options=("buck", "boost", "buck-boost", "flyback", "LDO",
                                          "linear")),
              DataField("frequency", "Switching frequency", "number", "Hz"))  # fmt: skip
_GENERIC = (MANUFACTURER, PART_NUMBER, PACKAGE)

CATEGORIES: tuple[Category, ...] = (
    Category("Resistors", _RESISTOR),
    Category("Resistors/Fixed", _RESISTOR),
    Category("Resistors/Current sense", _RESISTOR),
    Category("Resistors/Potentiometers & trimmers", _RESISTOR),
    Category("Resistors/Thermistors", (*_RESISTOR, DataField("type", "Type", "enum",
                                                             options=("NTC", "PTC")),
                                       DataField("b_value", "B value", "number", "K"))),
    Category("Resistors/Varistors", _RESISTOR),
    Category("Resistors/Arrays & networks", _RESISTOR),
    Category("Capacitors", _CAPACITOR),
    Category("Capacitors/Ceramic", (*_CAPACITOR,
                                    DataField("dielectric", "Dielectric", "enum",
                                              options=("C0G/NP0", "X7R", "X5R", "X6S", "X7S",
                                                       "X8R", "Y5V", "Z5U")))),
    Category("Capacitors/Aluminium electrolytic", (*_CAPACITOR,
                                                   DataField("lifetime", "Lifetime", unit="h"),
                                                   DataField("size", "Size D x L", unit="mm"),
                                                   DataField("ripple", "Ripple current",
                                                             "number", "A"))),
    Category("Capacitors/Polymer", _CAPACITOR),
    Category("Capacitors/Tantalum", _CAPACITOR),
    Category("Capacitors/Film", (*_CAPACITOR,
                                 DataField("dielectric", "Dielectric", "enum",
                                           options=("PP", "PET", "PPS", "PEN")))),
    Category("Capacitors/Supercapacitors", _CAPACITOR),
    Category("Capacitors/Trimmers & variable", _CAPACITOR),
    Category("Inductors & transformers", _INDUCTOR),
    Category("Inductors & transformers/Inductors", _INDUCTOR),
    Category("Inductors & transformers/Power inductors", _INDUCTOR),
    Category("Inductors & transformers/Common-mode chokes", _INDUCTOR),
    Category("Inductors & transformers/Ferrite beads", (*_INDUCTOR,
                                                        DataField("z100", "Z at 100 MHz",
                                                                  "number", "Ω"))),
    Category("Inductors & transformers/Transformers", (*_INDUCTOR,
                                                       DataField("ratio", "Turns ratio"))),
    Category("Inductors & transformers/Coupled inductors", _INDUCTOR),
    Category("Crystals & resonators", _GENERIC),
    Category("Crystals & resonators/Crystals", (*_GENERIC,
                                                DataField("frequency", "Frequency", "number",
                                                          "Hz"),
                                                DataField("load_c", "Load capacitance",
                                                          "number", "F"))),
    Category("Crystals & resonators/Ceramic resonators", _GENERIC),
    Category("Crystals & resonators/Oscillators", _GENERIC),
    Category("Diodes", _DIODE),
    Category("Diodes/Rectifier", _DIODE),
    Category("Diodes/Signal & switching", _DIODE),
    Category("Diodes/Schottky", _DIODE),
    Category("Diodes/Zener", (MANUFACTURER, PART_NUMBER, PACKAGE,
                              DataField("vz", "Zener voltage VZ", "number", "V"), POWER,
                              DataField("tolerance", "Tolerance", "enum", "%",
                                        ("1", "2", "5", "10")))),
    Category("Diodes/TVS", (*_DIODE, DataField("vbr", "Breakdown voltage", "number", "V"))),
    Category("Diodes/LED", (MANUFACTURER, PART_NUMBER, PACKAGE,
                            DataField("color", "Colour", "enum",
                                      options=("red", "orange", "yellow", "green", "blue",
                                               "white", "infrared", "ultraviolet")),
                            DataField("wavelength", "Wavelength", "number", "m"),
                            DataField("vf", "Forward voltage VF", "number", "V"),
                            DataField("current", "Rated current", "number", "A",
                                      source="ratings"))),
    Category("Diodes/Photodiodes", _DIODE),
    Category("Diodes/Varactors", _DIODE),
    Category("Diodes/Bridge rectifiers", _DIODE),
    Category("Transistors", _BJT),
    Category("Transistors/BJT NPN", _BJT),
    Category("Transistors/BJT PNP", _BJT),
    Category("Transistors/Darlington", _BJT),
    Category("Transistors/MOSFET N", _MOSFET),
    Category("Transistors/MOSFET P", _MOSFET),
    Category("Transistors/JFET N", _GENERIC),
    Category("Transistors/JFET P", _GENERIC),
    Category("Transistors/IGBT", _MOSFET),
    Category("Thyristors", _GENERIC),
    Category("Thyristors/SCR", _GENERIC),
    Category("Thyristors/TRIAC", _GENERIC),
    Category("Thyristors/DIAC", _GENERIC),
    Category("Optoelectronics", _GENERIC),
    Category("Optoelectronics/Optocouplers", (*_GENERIC,
                                              DataField("ctr", "CTR", "number", "%"))),
    Category("Optoelectronics/Phototransistors", _GENERIC),
    Category("Analog ICs", _OPAMP),
    Category("Analog ICs/Op-amps", _OPAMP),
    Category("Analog ICs/Comparators", _OPAMP),
    Category("Analog ICs/Instrumentation amplifiers", _OPAMP),
    Category("Analog ICs/Voltage references", (*_GENERIC,
                                               DataField("vref", "Reference voltage",
                                                         "number", "V"))),
    Category("Analog ICs/Analog switches & multiplexers", _GENERIC),
    Category("Analog ICs/Timers", _GENERIC),
    Category("Power", _REGULATOR),
    Category("Power/Linear regulators", _REGULATOR),
    Category("Power/Switching regulators", _REGULATOR),
    Category("Power/DC-DC modules", _REGULATOR),
    Category("Power/Gate drivers", _GENERIC),
    Category("Power/Load switches", _GENERIC),
    Category("Power/Battery management", _GENERIC),
    Category("Sources"),
    Category("Sources/Voltage"),
    Category("Sources/Current"),
    Category("Sources/Controlled"),
    Category("Sources/Behavioral"),
    Category("Sources/Signals"),
    Category("Switches & relays", _GENERIC),
    Category("Switches & relays/Controlled switches", _GENERIC),
    Category("Switches & relays/Relays", _GENERIC),
    Category("Switches & relays/Fuses", (*_GENERIC, CURRENT)),
    Category("Digital", _GENERIC),
    Category("Digital/Gates", _GENERIC),
    Category("Digital/Flip-flops & latches", _GENERIC),
    Category("Digital/74xx", _GENERIC),
    Category("Digital/4000", _GENERIC),
    Category("Digital/Counters", _GENERIC),
    Category("Digital/ADC & DAC", _GENERIC),
    Category("Digital/HDL blocks", _GENERIC),
    Category("RF & transmission lines", _GENERIC),
    Category("RF & transmission lines/Transmission lines", _GENERIC),
    Category("RF & transmission lines/Distributed elements", _GENERIC),
    Category("RF & transmission lines/Ports", _GENERIC),
    Category("Sensors", _GENERIC),
    Category("Electromechanical", _GENERIC),
    Category("Electromechanical/Motors", _GENERIC),
    Category("Electromechanical/Speakers & buzzers", _GENERIC),
    Category("Probes & instruments"),
    Category("Power symbols"),
    Category("Other", _GENERIC),
)  # fmt: skip
BY_PATH = {c.path: c for c in CATEGORIES}
OTHER = "Other"

# -- automatic categories ---------------------------------------------------------------------
_BUILTIN: dict[str, str] = {
    "bpt:resistor": "Resistors", "bpt:capacitor": "Capacitors",
    "bpt:potentiometer": "Resistors/Potentiometers", "bpt:fuse": "Protection/Fuses",
    "bpt:varicap": "Diodes/Varicap", "bpt:thyristor": "Thyristors & triacs/Thyristors",
    "bpt:relay": "Switches & relays/Relays", "bpt:photodiode": "Optoelectronics/Photodiodes",
    "bpt:optocoupler": "Optoelectronics/Optocouplers", "bpt:igbt": "Transistors/IGBT",
    "bpt:vcr": "Resistors/Controlled", "bpt:triac": "Thyristors & triacs/Triacs",
    "bpt:diac": "Thyristors & triacs/Diacs", "bpt:motor": "Electromechanical/Motors",
    "bpt:speaker": "Electromechanical/Loudspeakers", "bpt:ntc": "Sensors/Temperature",
    "bpt:hall": "Sensors/Magnetic",
    "bpt:phototransistor": "Optoelectronics/Phototransistors",
    "bpt:transformer3": "Inductors & transformers/Transformers",
    "bpt:inductor": "Inductors & transformers",
    "bpt:transformer": "Inductors & transformers/Transformers",
    "bpt:diode": "Diodes", "bpt:led": "Diodes/LED", "bpt:zener": "Diodes/Zener",
    "bpt:vsource": "Sources/Voltage", "bpt:isource": "Sources/Current",
    "bpt:bsource": "Sources/Behavioral", "bpt:hs": "Sources/Behavioral",
    "bpt:vcvs": "Sources/Controlled",
    "bpt:vccs": "Sources/Controlled", "bpt:cccs": "Sources/Controlled",
    "bpt:ccvs": "Sources/Controlled", "bpt:npn": "Transistors/BJT NPN",
    "bpt:pnp": "Transistors/BJT PNP", "bpt:nmos": "Transistors/MOSFET N",
    "bpt:pmos": "Transistors/MOSFET P", "bpt:njfet": "Transistors/JFET N",
    "bpt:pjfet": "Transistors/JFET P", "bpt:switch": "Switches & relays/Controlled switches",
    "bpt:opamp_ideal": "Analog ICs/Op-amps", "bpt:opamp": "Analog ICs/Op-amps",
    "bpt:probe_v": "Probes & instruments", "bpt:probe_vd": "Probes & instruments",
    "bpt:probe_i": "Probes & instruments", "bpt:gnd": "Power symbols",
    "bpt:power": "Power symbols",
}  # fmt: skip
# Built-in and standard templates by name.
_TEMPLATES: dict[str, str] = {
    "resistor": "Resistors/Fixed", "capacitor": "Capacitors", "mlcc": "Capacitors/Ceramic",
    "electrolytic": "Capacitors/Aluminium electrolytic", "film": "Capacitors/Film",
    "inductor": "Inductors & transformers/Power inductors",
    "Diode (signal)": "Diodes/Signal & switching", "LED": "Diodes/LED",
    "Zener diode": "Diodes/Zener", "NPN transistor": "Transistors/BJT NPN",
    "PNP transistor": "Transistors/BJT PNP", "N-channel MOSFET": "Transistors/MOSFET N",
    "P-channel MOSFET": "Transistors/MOSFET P", "Op-amp macromodel": "Analog ICs/Op-amps",
    "Transformer": "Inductors & transformers/Transformers",
    "N-channel JFET": "Transistors/JFET N", "P-channel JFET": "Transistors/JFET P",
    "NPN with package": "Transistors/BJT NPN",
    "Real transformer": "Inductors & transformers/Transformers",
}  # fmt: skip
_KINDS: dict[str, str] = {
    "resistor": "Resistors", "capacitor": "Capacitors", "inductor": "Inductors & transformers",
    "transformer": "Inductors & transformers/Transformers", "diode": "Diodes",
    "transistor": "Transistors", "ic": "Analog ICs", "module": "Power/DC-DC modules",
    "other": OTHER,
}  # fmt: skip
_ELEMENTS: dict[str, str] = {
    "R": "Resistors", "C": "Capacitors", "L": "Inductors & transformers", "K": "Inductors & "
    "transformers/Coupled inductors", "D": "Diodes", "Q": "Transistors", "M": "Transistors",
    "J": "Transistors", "V": "Sources/Voltage", "I": "Sources/Current", "B": "Sources/Behavioral",
    "E": "Sources/Controlled", "F": "Sources/Controlled", "G": "Sources/Controlled",
    "H": "Sources/Controlled", "S": "Switches & relays/Controlled switches",
    "W": "Switches & relays/Controlled switches", "T": "RF & transmission lines/Transmission "
    "lines", "O": "RF & transmission lines/Transmission lines",
}  # fmt: skip


def template_category(name: str) -> str:
    """Category of a template by its id ("mlcc", "tpl:Standard templates/LED")."""
    return _TEMPLATES.get(name.rsplit("/", 1)[-1], OTHER)


def builtin_category(symbol_id: str) -> str | None:
    return _BUILTIN.get(symbol_id)


def element_category(element: str | None) -> str | None:
    """Category of a part simulated as SPICE ``element`` (an imported symbol); None: not
    simulated."""
    return _ELEMENTS.get(element.upper()) if element else None


def component_category(explicit: str, template: str | None, kind: str) -> str:
    """A component's category: its own, else its template's, else its kind's."""
    if explicit:
        return explicit
    if template is not None and (found := template_category(template)) != OTHER:
        return found
    return _KINDS.get(kind, OTHER)


# -- API --------------------------------------------------------------------------------------
class DataFieldInfo(BaseModel):
    key: str
    label: str
    type: FieldType
    unit: str
    options: list[str]
    source: Literal["metadata", "ratings"]


class CategoryInfo(BaseModel):
    path: str
    fields: list[DataFieldInfo]


def category_infos() -> list[CategoryInfo]:
    return [
        CategoryInfo(
            path=c.path,
            fields=[
                DataFieldInfo(
                    key=f.key,
                    label=f.label,
                    type=f.type,
                    unit=f.unit,
                    options=list(f.options),
                    source=f.source,
                )
                for f in c.fields
            ],
        )
        for c in CATEGORIES
    ]
