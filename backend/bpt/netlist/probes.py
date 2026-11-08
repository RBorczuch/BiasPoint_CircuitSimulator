"""Probes on the schematic (FR-SCH-9): the signal each one measures, by its reference."""

from dataclasses import dataclass
from typing import Literal

from bpt.document.model import Project
from bpt.library.blocks import PREFIX, project_symbols
from bpt.netlist.connectivity import resolve_nets

PROBE = "bpt:probe_"
ProbeKind = Literal["v", "vd", "i"]


@dataclass(frozen=True)
class ProbeSignal:
    ref: str
    kind: ProbeKind
    signal: str  # expression in the results: V(out), V(a)-V(b), I(IP1)
    sheet: str


def probe_signals(project: Project) -> dict[str, ProbeSignal]:
    """Probes on the top-level sheets (not inside blocks) by reference."""
    blocks = {i.symbol[len(PREFIX):] for s in project.sheets for i in s.instances
              if i.symbol.startswith(PREFIX)}  # fmt: skip
    top = project.model_copy(update={"sheets": [s for s in project.sheets if s.name not in blocks]})
    if not any(i.symbol.startswith(PROBE) for s in top.sheets for i in s.instances):
        return {}
    nets = resolve_nets(top, project_symbols(project)).pin_net
    out: dict[str, ProbeSignal] = {}
    for sheet in top.sheets:
        for inst in sheet.instances:
            kind = inst.symbol.removeprefix(PROBE)
            if not inst.symbol.startswith(PROBE) or kind not in ("v", "vd", "i"):
                continue
            pin, plus, minus = (nets.get((inst.id, p)) for p in ("1", "+", "-"))
            if kind == "v" and pin:
                signal = f"V({pin})"
            elif kind == "vd" and plus and minus:
                signal = f"V({plus})-V({minus})"
            elif kind == "i":
                signal = f"I({inst.ref})"
            else:
                continue
            out[inst.ref] = ProbeSignal(inst.ref, kind, signal, sheet.name)  # type: ignore[arg-type]
    return out
