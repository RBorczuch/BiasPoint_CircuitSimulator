"""Importing SPICE models into a user library: a part (symbol + model) for each model.

For every definition found in a file the importer suggests a symbol and, for subcircuits, how
the symbol pins map onto the subcircuit pins (by pin name, else by the usual pin order of that
kind of part). The user can change both in the import wizard; the result is a library with the
models and one ready-to-place part per model ("1N4148" = diode symbol + model 1N4148).
"""

import re
from collections.abc import Mapping

from pydantic import BaseModel

from bpt.document.model import ModelCard, SubcktModel
from bpt.library.blocks import box_symbol
from bpt.library.builtin import builtin_symbols
from bpt.library.symbols import SpiceMapping, Symbol

from .spicelib import Definition

PART_PREFIX = "part:"
GENERIC = "generic"  # a box symbol made from the subcircuit's pins


class Suggestion(BaseModel):
    name: str
    kind: str  # "model" | "subckt"
    type: str  # model type (d, npn, ...) or "subckt"
    pins: list[str]  # subcircuit pins (empty for .model)
    summary: str
    encrypted: bool
    notes: list[str]
    symbol: str  # suggested symbol id, or "generic"
    pin_map: list[str]  # symbol pin numbers in the order of the subcircuit pins


_MODEL_SYMBOLS = {
    "npn": "bpt:npn", "pnp": "bpt:pnp", "nmos": "bpt:nmos", "pmos": "bpt:pmos",
    "njf": "bpt:njfet", "pjf": "bpt:pjfet", "sw": "bpt:switch",
}  # fmt: skip


def _norm(pin: str) -> str:
    return re.sub(r"[^a-z0-9+-]", "", pin.lower())


def _model_symbol(name: str, card: ModelCard) -> str:
    if card.type == "d":
        if "led" in name.lower():
            return "bpt:led"
        try:
            bv = float(re.sub(r"[^\d.eE+-]", "", card.params.get("bv", "")) or "1e9")
        except ValueError:
            bv = 1e9
        return "bpt:zener" if bv < 50 else "bpt:diode"
    if card.type == "vdmos":
        return "bpt:pmos" if "pchan" in card.params else "bpt:nmos"
    return _MODEL_SYMBOLS.get(card.type, GENERIC)


def _roles(pins: list[str], table: Mapping[str, tuple[str, ...]]) -> list[str] | None:
    """Pin of each subcircuit pin by name: {"D": ("d", "drain")} -> ["D", "G", "S"]."""
    out = []
    for pin in pins:
        name = _norm(pin)
        found = [role for role, names in table.items() if name in names]
        if len(found) != 1:
            return None
        out.append(found[0])
    return out if len(set(out)) == len(out) else None


_OPAMP = {
    "+": ("+", "in+", "inp", "+in", "nonin", "noninv", "ninv", "inplus", "p", "vinp", "ip"),
    "-": ("-", "in-", "inn", "-in", "inv", "inm", "inminus", "n", "vinn", "im"),
    "V+": ("v+", "vcc", "vdd", "vp", "vpos", "vs+", "+v", "vplus", "avdd", "pos"),
    "V-": ("v-", "vee", "vss", "vn", "vneg", "vs-", "-v", "vminus", "gnd", "avss", "neg"),
    "out": ("out", "o", "vout", "output", "vo"),
}
_FET = {"D": ("d", "drain"), "G": ("g", "gate"), "S": ("s", "source")}
_BJT = {"C": ("c", "collector"), "B": ("b", "base"), "E": ("e", "emitter")}
_DIODE = {"A": ("a", "anode", "1", "+", "p"), "K": ("k", "c", "cathode", "2", "-", "n")}


def _subckt_symbol(name: str, sub: SubcktModel) -> tuple[str, list[str]]:
    pins, body = sub.pins, " ".join(sub.body).lower()
    if len(pins) == 5:
        # Op-amp macromodels: + - V+ V- out is the usual order when the names say nothing.
        return "bpt:opamp", _roles(pins, _OPAMP) or ["+", "-", "V+", "V-", "out"]
    if len(pins) == 3 and (fet := _roles(pins, _FET)):
        p_type = " pmos" in body or "pchan" in body or re.search(r"\bvdmos\b.*\bpchan", body)
        return ("bpt:pmos" if p_type else "bpt:nmos"), fet
    if len(pins) == 3 and (bjt := _roles(pins, _BJT)):
        return ("bpt:pnp" if " pnp" in body else "bpt:npn"), bjt
    if len(pins) == 2 and (diode := _roles(pins, _DIODE)):
        return ("bpt:led" if "led" in name.lower() else "bpt:diode"), diode
    return GENERIC, list(pins)


def suggest(definition: Definition) -> Suggestion:
    if definition.kind == "model" and definition.model is not None:
        card = definition.model
        return Suggestion(name=definition.name, kind="model", type=card.type, pins=[],
                          summary=definition.summary, encrypted=False, notes=definition.notes,
                          symbol=_model_symbol(definition.name, card), pin_map=[])  # fmt: skip
    assert definition.subckt is not None
    symbol, pin_map = _subckt_symbol(definition.name, definition.subckt)
    return Suggestion(name=definition.name, kind="subckt", type="subckt",
                      pins=definition.subckt.pins, summary=definition.summary,
                      encrypted=definition.encrypted, notes=definition.notes, symbol=symbol,
                      pin_map=pin_map)  # fmt: skip


def part_symbol(
    library: str, name: str, symbol_id: str, pin_map: list[str], sub: SubcktModel | None
) -> Symbol:
    """The ready-to-place part: the chosen symbol with this model as its default."""
    part_id = f"{PART_PREFIX}{library}/{name}"
    if symbol_id == GENERIC or symbol_id not in builtin_symbols():
        pins = sub.pins if sub is not None else ["1", "2"]
        half = (len(pins) + 1) // 2
        base = box_symbol(part_id, name, pins[:half], pins[half:], ref_prefix="X",
                          description=f"{name} (subcircuit model)", category=library)  # fmt: skip
        nodes = [p.number for p in base.pins]
        return base.model_copy(update={
            "spice": SpiceMapping(element="X", nodes=nodes), "default_model": name,
        })  # fmt: skip
    base = builtin_symbols()[symbol_id]
    update: dict[str, object] = {
        "id": part_id, "name": name, "category": library, "default_model": name,
        "description": f"{name}: {base.name.lower()} ({'subcircuit' if sub else 'model'})",
        "default_params": {k: v for k, v in base.default_params.items() if k != "gain"},
    }  # fmt: skip
    if sub is not None:  # an X element: symbol pins in the subcircuit's order
        update["spice"] = SpiceMapping(element="X", nodes=pin_map)
    return base.model_copy(update=update)
