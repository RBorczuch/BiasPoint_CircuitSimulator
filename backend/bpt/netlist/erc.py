"""Electrical rules checks that need only the circuit IR."""

import re
from dataclasses import dataclass, field
from typing import Literal

from bpt.netlist.ir import CircuitIR, Device

Severity = Literal["error", "warning"]


@dataclass(frozen=True)
class ErcIssue:
    severity: Severity
    code: str
    message: str
    refs: list[str] = field(default_factory=list)  # device refs or net names involved

    @classmethod
    def error(cls, code: str, message: str, refs: list[str]) -> "ErcIssue":
        return cls("error", code, message, refs)

    @classmethod
    def warning(cls, code: str, message: str, refs: list[str]) -> "ErcIssue":
        return cls("warning", code, message, refs)


def _dc_paths(device: Device) -> list[tuple[str, str]]:
    """Node pairs between which the device conducts at DC."""
    n = device.nodes
    match device.element:
        case "R" | "L" | "V" | "D" | "B":
            return [(n[0], n[1])]
        case "E" | "H" | "S":
            return [(n[0], n[1])]
        case "Q" | "J":
            return [(n[0], n[1]), (n[1], n[2])]
        case "M":
            return [(n[0], n[2]), (n[2], n[3])] if len(n) > 3 else [(n[0], n[2])]
        case "X":  # a block: assume its ports may conduct (checked inside the block)
            return [(n[0], other) for other in n[1:]]
        case _:  # C, I, F, G: no DC conduction
            return []


class _Groups:
    def __init__(self) -> None:
        self.parent: dict[str, str] = {}

    def find(self, x: str) -> str:
        self.parent.setdefault(x, x)
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: str, b: str) -> bool:
        """Join; returns False if a and b were already connected."""
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return False
        self.parent[rb] = ra
        return True


def check_circuit(circuit: CircuitIR) -> list[ErcIssue]:
    issues: list[ErcIssue] = []
    nodes = {node for device in circuit.devices for node in device.nodes}
    if circuit.devices and "0" not in nodes:
        issues.append(ErcIssue.error("no-ground", "circuit has no ground (node 0)", []))
        return issues

    dc = _Groups()
    for device in circuit.devices:
        for a, b in _dc_paths(device):
            dc.union(a, b)
    ground = dc.find("0")
    for node in sorted(nodes - {"0"}):
        if dc.find(node) != ground:
            net = circuit.net_names.get(node, node)
            issues.append(ErcIssue.error(
                "no-dc-path", f"net {net} has no DC path to ground", [net]
            ))  # fmt: skip

    loops = _Groups()
    for device in circuit.devices:
        if device.element in ("V", "L", "E", "H") and not loops.union(*device.nodes[:2]):
            issues.append(ErcIssue.error(
                "source-loop",
                f"{device.ref} closes a loop of voltage sources / inductors",
                [device.ref],
            ))  # fmt: skip
    issues += _milli_mega(circuit)
    return issues


# "1MHz", "2.2M": SPICE reads M as milli; people usually mean mega.
_MILLI = re.compile(r"(?<![\w.])[+-]?(?:\d+\.?\d*|\.\d+)M(?![eE][gG])[a-zA-ZΩ]*")


def _milli_mega(circuit: CircuitIR) -> list[ErcIssue]:
    found: list[ErcIssue] = []
    texts = [(d.ref, " ".join(d.params.values())) for d in circuit.devices]
    texts += [("directive", text) for text in circuit.directives]
    for ref, text in texts:
        for token in _MILLI.findall(text):
            number = token.split("M")[0]
            found.append(ErcIssue.warning(
                "milli-not-mega",
                f'{ref}: "{token}" is {number} milli in SPICE (M = milli); write {number}meg',
                [] if ref == "directive" else [ref],
            ))  # fmt: skip
    return found
