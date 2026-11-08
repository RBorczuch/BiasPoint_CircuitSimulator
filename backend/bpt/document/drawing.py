"""Drawing a sheet in code like a person would: parts on a grid, real wires, ground symbols,
named nets and port labels (example projects, standard library components)."""

from itertools import count

from bpt.document.model import (
    Directive,
    Instance,
    Label,
    ModelRef,
    Point,
    Rotation,
    Sheet,
    Wire,
)
from bpt.library.blocks import block_symbol
from bpt.library.builtin import builtin_symbols
from bpt.netlist.connectivity import transform


class Drawing:
    def __init__(self, name: str = "root", parameters: dict[str, str] | None = None) -> None:
        self.sheet = Sheet(name=name, parameters=dict(parameters or {}))
        self.symbols = builtin_symbols()
        self._gnd = count(1)
        self._pwr = count(1)

    def part(self, symbol: str, ref: str, at: Point, rot: Rotation = 0, model: str | None = None,
             mirror: bool = False, **params: str) -> None:  # fmt: skip
        """Built-in ``symbol`` (without "bpt:"); ``params`` are its values."""
        model_ref = ModelRef(model=model, params=params)
        self.sheet.instances.append(Instance(ref=ref, symbol=f"bpt:{symbol}", at=at, rot=rot,
                                             mirror=mirror, model=model_ref))  # fmt: skip

    def block(self, sheet: Sheet, ref: str, at: Point, rot: Rotation = 0, mirror: bool = False,
              **params: str) -> None:  # fmt: skip
        """A block of ``sheet`` (a placed component's top sheet) with parameter overrides."""
        symbol = block_symbol(sheet)
        assert symbol is not None
        self.symbols[symbol.id] = symbol
        model = ModelRef(params=params)
        self.sheet.instances.append(
            Instance(ref=ref, symbol=symbol.id, at=at, rot=rot, mirror=mirror, model=model)
        )

    def pin(self, ref: str, number: str) -> Point:
        inst = next(i for i in self.sheet.instances if i.ref == ref)
        return transform(self.symbols[inst.symbol].pin(number).at, inst)

    def wire(self, *points: Point) -> None:
        self.sheet.wires.append(Wire(points=list(points)))

    def gnd(self, at: Point) -> None:
        self.part("gnd", f"#GND{next(self._gnd)}", at)

    def power(self, net: str, at: Point) -> None:
        self.part("power", f"#PWR{next(self._pwr)}", at, net=net)

    def label(self, text: str, at: Point) -> None:
        self.sheet.labels.append(Label(text=text, at=at))

    def port(self, text: str, at: Point) -> None:
        """A port label: a pin of the block (or component) this sheet becomes."""
        self.sheet.labels.append(Label(kind="port", text=text, at=at))

    def directive(self, text: str, at: Point) -> None:
        self.sheet.directives.append(Directive(text=text, at=at))
