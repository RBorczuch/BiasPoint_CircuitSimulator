"""Project document model (source of truth for the file format and the API).

Coordinates are integers in internal units of 10 µm; the default grid is 1.27 mm = 127 units
(the KiCad symbol grid). Values are stored as text (``"4k7"``, ``"{Rload*2}"``) and parsed by
:mod:`bpt.units` when netlisting.
"""

import re
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from bpt.document.ids import new_id
from bpt.library.symbols import Look, Symbol

SCHEMA_VERSION = 1
GRID = 127  # 1.27 mm

Point = tuple[int, int]
Rotation = Literal[0, 90, 180, 270]


class Base(BaseModel):
    model_config = ConfigDict(extra="forbid", validate_assignment=True)


class ModelRef(Base):
    """What simulates an instance.

    ``builtin``: the symbol's default SPICE element, configured by ``params``
    (e.g. ``{"R": "10k"}`` or ``{"dc": "5", "tran": "SIN(0 1 1k)"}``).
    ``model`` optionally names a model card (``.model``) from the project or a library.
    """

    kind: Literal["builtin"] = "builtin"
    model: str | None = None
    params: dict[str, str] = Field(default_factory=dict)
    # A subcircuit model: the symbol pin numbers in the order of the subcircuit's pins
    # ("=VCC" ties one to a global net). None = by pin name, else the symbol's SPICE order.
    pins: list[str] | None = None
    variant: str | None = None  # one of the symbol's variants (ideal, behavioural, ...)


class TextPlace(Base):
    """Where a part's text (reference, value) was put by hand: offset from the part's origin in
    sheet axes and its rotation (90 = read bottom to top)."""

    at: Point
    rot: Literal[0, 90] = 0


class Instance(Base):
    id: UUID = Field(default_factory=new_id)
    ref: str
    symbol: str
    model: ModelRef = Field(default_factory=ModelRef)
    at: Point
    rot: Rotation = 0
    mirror: bool = False
    # Drawing of the symbol (a ``Look`` name); None = as the IEC / ANSI setting asks.
    look: str | None = None
    # Rated values of an ideal part for the stress analysis (voltage, current, power...);
    # a library component has them in its metadata.
    ratings: dict[str, str] = Field(default_factory=dict)
    # Texts moved or turned by hand ("ref", "value"); absent ones sit where the symbol puts them.
    texts: dict[str, TextPlace] = Field(default_factory=dict)


class Wire(Base):
    id: UUID = Field(default_factory=new_id)
    points: Annotated[list[Point], Field(min_length=2)]
    # A bus: drawn thick, no electrical connection of its own (members join by label names).
    bus: bool = False


class Junction(Base):
    id: UUID = Field(default_factory=new_id)
    at: Point


PortSide = Literal["left", "right", "top", "bottom"]
LabelKind = Literal["local", "global", "port"]  # port: hierarchical label of a sheet block


class Label(Base):
    """Net label; ``local`` labels join nets within a sheet, ``global`` across sheets."""

    id: UUID = Field(default_factory=new_id)
    kind: LabelKind = "local"
    text: str
    at: Point
    rot: Rotation = 0


class Directive(Base):
    """Free SPICE text placed on the schematic (``.param``, ``.include``, ...)."""

    id: UUID = Field(default_factory=new_id)
    text: str
    at: Point


ComponentKind = Literal[
    "resistor",
    "capacitor",
    "inductor",
    "transformer",
    "diode",
    "transistor",
    "ic",
    "module",
    "other",
]


class Characteristic(Base):
    """Source points of a characteristic (datasheet, measurement): |Z|(f), C(V), I-V..."""

    name: str  # "|Z|(f)", "ESR(f)", "C(V)"
    x_unit: str = ""
    y_unit: str = ""
    points: list[tuple[float, float]] = Field(default_factory=list)
    source: str = ""  # where the points come from: datasheet, digitizer, CSV, measurement
    # How much each point counts in a fit (empty = all 1; 0 = shown, not fitted).
    weights: list[float] = Field(default_factory=list)
    # Fit errors relative to each point ("log": values spanning decades) or to the largest
    # value ("lin": values crossing zero, or where small ones do not matter).
    scale: Literal["log", "lin"] = "log"
    # Conditions the points were taken at, e.g. {"Vds": 10} for a transfer curve.
    at: dict[str, float] = Field(default_factory=dict)


class Template(Base):
    """The standard equivalent circuit the sheets were generated from, with its form values."""

    name: str  # "capacitor-esr-esl"
    values: dict[str, str] = Field(default_factory=dict)


class VersionNote(Base):
    """An earlier version of a library part or template: when and what changed in it."""

    version: int
    updated: str = ""
    changes: str = ""


class ComponentInfo(Base):
    """What makes a block a real part (D15, FR-CMP): kind, metadata, ratings, versions."""

    id: str  # "cmp:<library>/<name>"
    name: str
    kind: ComponentKind = "other"
    description: str = ""
    category: str = ""  # where the library lists it ("Capacitors/Ceramic"); "" = automatic
    # manufacturer, part_number, technology, package, datasheet...
    metadata: dict[str, str] = Field(default_factory=dict)
    ratings: dict[str, str] = Field(default_factory=dict)  # voltage, power, current, ...
    template: Template | None = None
    characteristics: list[Characteristic] = Field(default_factory=list)
    version: int = 1
    updated: str = ""
    changes: str = ""
    history: list[VersionNote] = Field(default_factory=list)  # earlier versions, newest first


class Component(ComponentInfo):
    """A real part in a library: its equivalent circuit is ``sheets`` (the first is the top)."""

    sheets: list["Sheet"]


class TemplateField(Base):
    """A form field of a user template: one parameter of its top sheet."""

    key: str  # the sheet parameter ({key} in values)
    label: str = ""
    unit: str = ""
    default: str = ""
    description: str = ""
    required: bool = False
    minimum: str = ""  # the lowest value the form accepts ("" = any; SPICE suffixes)
    maximum: str = ""
    group: str = (
        ""  # a heading the form shows it under ("Loss", "Parasitics"; "Advanced" is folded)
    )
    help: str = ""  # what it does on the curves, where a datasheet gives it (the parameter's card)


class UserTemplate(Base):
    """An equivalent circuit to make components from (FR-CMP-9): a form over sheet parameters.

    The first sheet is the top: its ports are the part's pins, its parameters the fields.
    """

    id: str  # "tpl:<library>/<name>"
    name: str
    kind: ComponentKind = "other"
    description: str = ""
    category: str = ""  # where the library lists it; "" = from its kind
    fields: list[TemplateField] = Field(default_factory=list)
    sheets: list["Sheet"]
    version: int = 1
    updated: str = ""
    changes: str = ""
    history: list[VersionNote] = Field(default_factory=list)


class SheetVariant(Base):
    """Another model of a block (FR-CMP-8, FR-HIE-3): a sheet with the same ports simulated
    instead when a block chooses it ("Simulate as"), e.g. an averaged model of a converter."""

    name: str  # stored in the block: ModelRef.variant
    label: str
    description: str = ""
    sheet: str  # the sheet simulated instead
    faster: bool = False  # simplified: offered when a run takes long (FR-CMP-8)


class Sheet(Base):
    id: UUID = Field(default_factory=new_id)
    name: str
    instances: list[Instance] = Field(default_factory=list)
    wires: list[Wire] = Field(default_factory=list)
    junctions: list[Junction] = Field(default_factory=list)
    labels: list[Label] = Field(default_factory=list)
    directives: list[Directive] = Field(default_factory=list)
    # Parameters of the sheet as a block, with defaults (``.subckt ... params: R=1k``);
    # each block can override them, values inside use ``{R}``.
    parameters: dict[str, str] = Field(default_factory=dict)
    # Pins of the sheet's block symbol: side per port and order; by default ports on the left
    # half of the sheet go left, the others right, each side top to bottom.
    port_sides: dict[str, PortSide] = Field(default_factory=dict)
    port_order: list[str] = Field(default_factory=list)
    # The sheet drawn as a template (template editor): the form of its parameters.
    form: list[TemplateField] = Field(default_factory=list)
    # A drawn block symbol (FR-HIE-5): its pin numbers are port names. None = the automatic
    # box from the ports, also used while the drawing lacks a pin for some port.
    symbol: Symbol | None = None
    # A placed library component (FR-CMP): ``component`` on its top sheet; ``owner`` (the
    # component id) on all its sheets, which are hidden and read-only until copied.
    component: ComponentInfo | None = None
    owner: str | None = None
    # Other models of this sheet as a block; the sheet itself is the first ("Full model").
    variants: list[SheetVariant] = Field(default_factory=list)
    variant_label: str = ""  # label of the sheet itself among its variants (default "Full model")


class ModelCard(Base):
    """A SPICE ``.model`` card: ``.model <name> <type>(<params>)``."""

    type: str  # d, npn, pnp, nmos, pmos, njf, pjf, sw, ...
    params: dict[str, str] = Field(default_factory=dict)
    source: str = ""  # where it came from: a library file, a model wizard, ...
    original: str = ""  # the card as found there (another SPICE dialect, before conversion)


class SubcktModel(Base):
    """A device model written as a subcircuit (``.subckt name pins params: ... .ends``).

    ``body`` holds the ngspice lines between the header and ``.ends``; ``original`` the text
    as found in the manufacturer's file. Parts use it as an ``X`` element.
    """

    pins: list[str]
    params: dict[str, str] = Field(default_factory=dict)  # defaults, ``params:`` on the header
    body: list[str] = Field(default_factory=list)
    source: str = ""
    original: str = ""
    notes: list[str] = Field(default_factory=list)  # what the conversion could not do


AnalysisKind = Literal["op", "dc", "ac", "tran"]


_UNSAFE_NAME = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
_RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)),
             *(f"lpt{i}" for i in range(1, 10))}  # fmt: skip


def sheet_name_problem(name: str) -> str | None:
    """Why ``name`` cannot name a sheet (each sheet is a file ``sheets/<name>.json``)."""
    if not name.strip():
        return "a sheet needs a name"
    if _UNSAFE_NAME.search(name):
        return f'sheet name {name!r} cannot contain \\ / : * ? " < > | or control characters'
    if name != name.strip() or name.endswith("."):
        return f"sheet name {name!r} cannot start or end with a space or end with a dot"
    if name.split(".")[0].lower() in _RESERVED:
        return f"{name!r} is a reserved file name on Windows"
    return None


def safe_sheet_name(text: str) -> str:
    """``text`` (a component's name) made usable as a sheet name."""
    name = _UNSAFE_NAME.sub("_", text).strip().rstrip(".") or "part"
    return f"_{name}" if name.split(".")[0].lower() in _RESERVED else name


RATING_KEYS = ("voltage", "current", "power", "isat", "tj_max", "rth")


def rating_problem(key: str, value: str) -> str | None:
    """Why ``key = value`` cannot be a rating (stress analysis), or None."""
    from bpt.units import InvalidValueError, parse_value

    if key not in RATING_KEYS:
        return f"unknown rating {key!r} (use {', '.join(RATING_KEYS)})"
    try:
        number = parse_value(value)
    except InvalidValueError:
        return f"rating {key}: {value!r} is not a number"
    return None if number > 0 else f"rating {key} must be positive"


class StressRules(Base):
    """Stress analysis margins (FR-SIM-7): the part of each rating a design may use."""

    voltage: float = 80.0  # percent of the rated voltage
    current: float = 80.0  # percent of the rated current (RMS) and of Isat (peak)
    power: float = 50.0  # percent of the rated power
    temperature: float = 25.0  # kelvins below the maximum junction / hot-spot temperature
    ambient: float = 25.0  # °C, for Tj = Ta + P·Rth


class Simulation(Base):
    """Last parameters of each analysis kind (SPICE cards) and which one runs; the circuit
    temperature and simulator options apply to every analysis started from Simulate."""

    active: AnalysisKind = "op"
    cards: dict[str, str] = Field(
        default_factory=lambda: {
            "op": ".op",
            "dc": ".dc V1 0 5 0.1",
            "ac": ".ac dec 20 10 1meg",
            "tran": ".tran 10u 10m",
        }
    )
    temperature: str = ""  # °C; "" = ngspice's 27 °C
    options: dict[str, str] = Field(default_factory=dict)  # .options: reltol, gmin, itl1...


_OPTION_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_]{0,31}")
_OPTION_VALUE = re.compile(r"[^\s=;{}]{1,40}")  # one token: no spaces, cards or scripts


def option_lines(simulation: Simulation) -> list[str]:
    """``.options`` for the temperature and the simulator options (bad entries left out)."""
    values = {"temp": simulation.temperature.strip()} if simulation.temperature.strip() else {}
    values |= {k: v.strip() for k, v in simulation.options.items() if v.strip()}
    values = {k: v for k, v in values.items()
              if _OPTION_NAME.fullmatch(k) and _OPTION_VALUE.fullmatch(v)}  # fmt: skip
    return [".options " + " ".join(f"{k}={v}" for k, v in values.items())] if values else []


def simulation_problem(simulation: Simulation) -> str | None:
    """Why the temperature or an option cannot go to ngspice, or None."""
    temperature = simulation.temperature.strip()
    if temperature:
        try:
            float(temperature)
        except ValueError:
            return f"temperature {temperature!r} is not a number of °C"
    for key, value in simulation.options.items():
        if not _OPTION_NAME.fullmatch(key):
            return f"{key!r} is not a simulator option name"
        if value.strip() and not _OPTION_VALUE.fullmatch(value.strip()):
            return f"option {key} = {value!r}: one value without spaces"
    return None


GRAPH_VERSION = 2  # graphs/<name>.json: 2 added node versions, titles, bypass, groups...


class GraphNode(Base):
    """A node of an analysis graph: its type (``sim/tran``), widget values and placement.

    ``version``: of its type's parameters when it was made (older ones are migrated by the
    catalogue); ``title``: the user's name for it ("" = the type's); ``bypass``: switched off,
    its input passed on to an output of the same type, else its branch skipped;
    ``param_inputs``: parameters turned into ``scalar`` input sockets of the same name (a number
    from another node sets them)."""

    id: str
    type: str
    version: int = 1
    title: str = ""
    bypass: bool = False
    pos: tuple[float, float] = (0.0, 0.0)
    size: tuple[float, float] | None = None
    params: dict[str, str | bool | int | float] = Field(default_factory=dict)
    param_inputs: list[str] = Field(default_factory=list)


class GraphGroup(Base):
    """A frame around nodes with a title (the nodes inside it move with it on the canvas)."""

    id: str
    title: str = ""
    color: str = ""  # a name of the palette ("violet"), "" = neutral
    rect: tuple[float, float, float, float] = (0.0, 0.0, 400.0, 300.0)  # x, y, width, height


class GraphNote(Base):
    """Text on the canvas (Markdown)."""

    id: str
    text: str = ""
    pos: tuple[float, float] = (0.0, 0.0)
    size: tuple[float, float] | None = None


class GraphReroute(Base):
    """A point an edge passes through (to route it): what comes in (input ``in``) goes out
    (output ``out``) unchanged."""

    id: str
    pos: tuple[float, float] = (0.0, 0.0)


class Subgraph(Base):
    """A graph used as one node (G4): its sockets and parameters at its boundary."""

    version: int = 1
    inputs: list[dict[str, str]] = Field(default_factory=list)
    outputs: list[dict[str, str]] = Field(default_factory=list)
    params: list[dict[str, str]] = Field(default_factory=list)
    nodes: list[GraphNode] = Field(default_factory=list)
    edges: list["GraphEdge"] = Field(default_factory=list)


class GraphEdge(Base):
    """Output ``output`` of node ``source`` feeds input ``input`` of node ``target``."""

    source: str
    output: str
    target: str
    input: str


class Graph(Base):
    """Analysis graph (see node.md): simulations, calculations and views as connected nodes."""

    name: str
    nodes: list[GraphNode] = Field(default_factory=list)
    edges: list[GraphEdge] = Field(default_factory=list)
    groups: list[GraphGroup] = Field(default_factory=list)
    notes: list[GraphNote] = Field(default_factory=list)
    reroutes: list[GraphReroute] = Field(default_factory=list)
    subgraphs: dict[str, Subgraph] = Field(default_factory=dict)


class Project(Base):
    schema_version: int = SCHEMA_VERSION
    id: UUID = Field(default_factory=new_id)
    name: str
    sheets: list[Sheet] = Field(default_factory=list)
    parameters: dict[str, str] = Field(default_factory=dict)
    models: dict[str, ModelCard] = Field(default_factory=dict)
    subcircuits: dict[str, SubcktModel] = Field(default_factory=dict)  # subcircuit models
    simulation: Simulation = Field(default_factory=Simulation)
    stress: StressRules = Field(default_factory=StressRules)
    graphs: list[Graph] = Field(default_factory=list)
    # Copies of the library symbols used here (imported KiCad parts, ...), so the project opens
    # and simulates the same without the library.
    symbols: dict[str, Symbol] = Field(default_factory=dict)
    # Library symbols used by reference: their copies follow the library (updated when it
    # changes); the others are plain copies, updated only on request.
    linked: list[str] = Field(default_factory=list)
    # Copies of user drawings (symbol editor looks) used here, by the symbol they are for.
    looks: dict[str, list[Look]] = Field(default_factory=dict)
    # Drawing new parts of a symbol get in this project (symbol editor: "this project").
    default_looks: dict[str, str] = Field(default_factory=dict)
    # IEC (box resistor) or ANSI (zigzag) for parts without a look of their own; None: as the
    # program's setting
    symbol_standard: Literal["iec", "ansi"] | None = None

    def sheet(self, name: str) -> Sheet:
        for sheet in self.sheets:
            if sheet.name == name:
                return sheet
        raise KeyError(f"no sheet named {name!r}")


Component.model_rebuild()
UserTemplate.model_rebuild()
