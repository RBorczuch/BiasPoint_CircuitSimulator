"""Symbol definitions: graphics + pins + mapping to a SPICE element."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

PinType = Literal["passive", "input", "output", "bidirectional", "power_in", "power_out"]
Orientation = Literal["left", "right", "up", "down"]
Point = tuple[int, int]  # same as bpt.document.model.Point (the model imports this module)


class _Base(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class Pin(_Base):
    """``at`` is the connection point relative to the symbol origin (unrotated)."""

    number: str
    name: str = ""
    at: Point
    length: int = 127
    orientation: Orientation = "up"
    type: PinType = "passive"
    # Hidden power pin (KiCad): joins the global net of this name without a wire.
    implicit_net: str | None = None


class Polyline(_Base):
    kind: Literal["polyline"] = "polyline"
    points: list[Point]
    fill: bool = False


class Rect(_Base):
    kind: Literal["rect"] = "rect"
    start: Point
    end: Point
    fill: bool = False


class Circle(_Base):
    kind: Literal["circle"] = "circle"
    center: Point
    radius: int
    fill: bool = False


class Arc(_Base):
    kind: Literal["arc"] = "arc"
    start: Point
    mid: Point
    end: Point


class Text(_Base):
    kind: Literal["text"] = "text"
    at: Point
    text: str
    size: int = 127


Graphic = Annotated[Polyline | Rect | Circle | Arc | Text, Field(discriminator="kind")]

ElementKind = Literal[
    "R", "C", "L", "V", "I", "E", "F", "G", "H", "B", "D", "Q", "M", "J", "S", "X", "A"
]


class SpiceMapping(_Base):
    """How an instance becomes a SPICE element line.

    ``nodes`` lists pin numbers in SPICE node order; ``"=0"`` stands for the ground node
    (used e.g. by the ideal op-amp, a VCVS referenced to ground).
    """

    element: ElementKind
    nodes: list[str]


class Parasitic(_Base):
    """A non-ideal property of a part: an extra R, L or C in series or in parallel with it.

    Stored like any parameter (``key`` in the instance params); empty = absent (ideal).
    The netlister expands it into a separate element.
    """

    key: str  # instance parameter, e.g. "esr"
    label: str  # "ESR"
    element: Literal["R", "L", "C"]
    connection: Literal["series", "parallel"]
    unit: str  # "Ω", "H", "F"
    description: str = ""


Standard = Literal["iec", "ansi"]


class Look(_Base):
    """Another drawing of the same part (ANSI zigzag, electrolytic capacitor...); same pins."""

    name: str  # stored in the instance: Instance.look
    label: str
    # Drawn automatically when this standard is chosen in the settings (None: only by hand).
    standard: Standard | None = None
    # Drawn automatically for a source whose waveform is this one (SIN, PULSE), when the part
    # has no look of its own.
    signal: str | None = None
    # A user drawing new parts of the symbol get, in every project (symbol editor: "all my
    # projects"); parts placed earlier keep theirs.
    default: bool = False
    graphics: list[Graphic]


def signal_of(params: dict[str, str]) -> str:
    """The waveform keyword of a source's transient value ("SIN(0 1 1k)" -> "SIN")."""
    return params.get("tran", "").strip().split("(")[0].strip().upper()


class UserLook(_Base):
    """A drawing made in the symbol editor for another symbol (same pins): ``target``'s look."""

    target: str  # symbol id, e.g. "bpt:isource"
    look: Look


def with_extra_looks(symbol: "Symbol", extra: list[Look]) -> "Symbol":
    """``symbol`` offering also ``extra`` looks (by name; a later one replaces an earlier one)."""
    if not extra:
        return symbol
    names = {lk.name for lk in extra}
    looks = [lk for lk in symbol.looks if lk.name not in names] + list(extra)
    return symbol.model_copy(update={"looks": looks})


class Variant(_Base):
    """Another way to simulate the same part (ideal / behavioural / transistor level...)."""

    name: str  # stored in the instance: ModelRef.variant
    label: str
    description: str = ""
    faster: bool = False  # a simplified model: offered when a run takes long
    spice: SpiceMapping
    default_model: str | None = None
    default_params: dict[str, str] = Field(default_factory=dict)


class Symbol(_Base):
    id: str
    name: str
    description: str = ""
    ref_prefix: str
    pins: list[Pin]
    graphics: list[Graphic] = Field(default_factory=list)
    spice: SpiceMapping | None = None
    power_net: str | None = None  # power/ground symbols: name of the net their pin joins
    default_params: dict[str, str] = Field(default_factory=dict)
    default_model: str | None = None
    category: str = "Misc"
    # Anchor of the reference and value texts (symbol coordinates; texts stay upright).
    ref_at: Point | None = (152, -64)
    value_at: Point | None = (152, 64)
    value_param: str | None = None  # parameter shown as the value (R, C, L, dc, ...)
    parasitics: list[Parasitic] = Field(default_factory=list)  # non-ideal properties offered
    variants: list[Variant] = Field(default_factory=list)  # the first one is the default
    looks: list[Look] = Field(default_factory=list)  # other drawings; ``graphics`` is IEC
    # Library version: bumped when the symbol (or its default model) changes in its library;
    # a project's copy keeps the version it was copied at.
    version: int = 1
    updated: str = ""  # date of that version (YYYY-MM-DD)
    changes: str = ""  # what changed in it
    kind: str | None = None  # a component's kind (capacitor, ic...)
    # Category path where the library lists the part ("Capacitors/Ceramic"); None: only in its
    # library (not simulated). A library part also carries its data for filters and cards.
    group: str | None = None
    metadata: dict[str, str] = Field(default_factory=dict)
    ratings: dict[str, str] = Field(default_factory=dict)

    def with_look(self, name: str | None, standard: Standard = "iec",
                  params: dict[str, str] | None = None) -> "Symbol":  # fmt: skip
        """This symbol drawn as look ``name`` or, without one, as its waveform (``params``)
        or the ``standard`` asks."""
        look = next((lk for lk in self.looks if lk.name == name), None) if name else None
        if look is None and not name:
            wave = signal_of(params or {})
            look = next((lk for lk in self.looks if wave and lk.signal == wave), None) or next(
                (lk for lk in self.looks if lk.standard == standard), None
            )
        return self if look is None else self.model_copy(update={"graphics": look.graphics})

    def with_variant(self, name: str | None) -> "Symbol":
        """This symbol simulated as variant ``name`` (unknown or None: as it is)."""
        variant = next((v for v in self.variants if v.name == name), None)
        if variant is None:
            return self
        return self.model_copy(update={
            "spice": variant.spice, "default_model": variant.default_model,
            "default_params": variant.default_params,
        })  # fmt: skip

    def pin(self, number: str) -> Pin:
        for pin in self.pins:
            if pin.number == number:
                return pin
        raise KeyError(f"symbol {self.id} has no pin {number!r}")
