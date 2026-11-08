"""Characteristics of a part by simulation (component card, fitting).

The part (a sheet with ports, usually a component's equivalent circuit) is placed several
times in a test circuit, each copy with its own parameter overrides and DC bias and its own
source, so one AC run measures all of them: the impedance of several parameter sets (the
fitting Jacobian), or the small-signal capacitance at several DC voltages (C(V)).

* ``drive="v"``: a voltage source across the copy (DC = bias, AC 1 V); Z = 1 / I.
  For capacitors and anything that blocks or limits DC current.
* ``drive="i"``: a current source into the copy (DC = bias, AC 1 A); Z = V.
  For inductors (a DC voltage across a winding would be a short).

Parts with more pins (transistors) are placed by ``port_circuit``: each copy's ports go to
named nets, the caller adds the sources (``dc_sweep`` runs it).
"""

import math
import tempfile
from collections.abc import Callable
from dataclasses import dataclass, field
from itertools import count
from pathlib import Path
from typing import Literal

import numpy as np

from bpt.analysis.spec import AcAnalysis, AnalysisSpec, DcAnalysis
from bpt.document.builder import place_component
from bpt.document.model import Project, Sheet
from bpt.engines.base import Engine
from bpt.library.blocks import PREFIX, ports, project_symbols
from bpt.netlist.ir import CircuitIR, Device
from bpt.netlist.netlister import netlist_project
from bpt.results.store import ResultStore, RunReader
from bpt.units import to_spice

Run = Callable[[CircuitIR, AnalysisSpec], RunReader]
TWO_PI = 2 * math.pi


class BenchError(RuntimeError):
    """The part cannot be measured."""


@dataclass
class Copy:
    params: dict[str, str] = field(default_factory=dict)  # sheet parameter overrides
    drive: Literal["v", "i"] = "v"
    dc: float = 0.0


def engine_runner(engine: Engine, root: Path | None = None) -> Run:
    """Runs bench circuits on ``engine``; results go to a throwaway store."""
    store = ResultStore(root or Path(tempfile.mkdtemp(prefix="bpt-bench-")))

    def run(circuit: CircuitIR, analysis: AnalysisSpec) -> RunReader:
        meta = engine.run(circuit, analysis, store)
        if meta.status != "ok":
            raise BenchError(meta.error or f"simulation {meta.status}")
        return store.open(meta.run_id)

    return run


def needed_sheets(sheets: list[Sheet], top: str) -> list[Sheet]:
    """``top`` and every sheet placed inside it (directly or deeper)."""
    by_name = {s.name: s for s in sheets}
    order: list[str] = []
    stack = [top]
    while stack:
        name = stack.pop()
        if name in order or name not in by_name:
            continue
        order.append(name)
        stack += [i.symbol[len(PREFIX):] for i in by_name[name].instances
                  if i.symbol.startswith(PREFIX)]  # fmt: skip
    if top not in by_name:
        raise BenchError(f"no sheet {top}")
    return [by_name[n] for n in order]


def two_ports(sheet: Sheet) -> tuple[str, str]:
    names = [name for name, _side in ports(sheet)]
    if len(names) != 2:
        raise BenchError(f"{sheet.name} has {len(names)} ports; characteristics need 2")
    return names[0], names[1]


def bench_circuit(base: Project, top: str, copies: list[Copy]) -> CircuitIR:
    """The test circuit: copy k between nets ``p<k>`` and ground, driven by source ``S<k>``."""
    sheets = needed_sheets(base.sheets, top)
    root = Sheet(name="bench")
    project = base.model_copy(update={"sheets": [*sheets, root]})
    symbol = project_symbols(project).get(f"{PREFIX}{top}")
    if symbol is None or symbol.spice is None:
        raise BenchError(f"{top} has no ports")
    first, _second = two_ports(sheets[0])
    grounds = count(1)
    for k, copy in enumerate(copies, start=1):
        nets = [f"p{k}" if node == first else "0" for node in symbol.spice.nodes]
        add = place_component(symbol, f"X{k}", nets, (0, 4000 * k), copy.params, None, grounds)
        root.instances += add.instances
        root.wires += add.wires
        root.labels += add.labels
    result = netlist_project(project)
    errors = [i.message for i in result.issues if i.severity == "error"]
    if errors:
        raise BenchError("; ".join(errors))
    circuit = result.circuit
    node_of = {user: node for node, user in circuit.net_names.items()}
    for k, copy in enumerate(copies, start=1):
        node = node_of.get(f"p{k}", f"p{k}")
        dc = to_spice(copy.dc)
        if copy.drive == "v":
            device = Device(ref=f"VS{k}", element="V", nodes=[node, "0"],
                            params={"dc": dc, "ac": "1"})  # fmt: skip
        else:  # current flows from ground through the source into the part
            device = Device(ref=f"IS{k}", element="I", nodes=["0", node],
                            params={"dc": dc, "ac": "1"})  # fmt: skip
        circuit.devices.append(device)
    return circuit


def _impedances(reader: RunReader, copies: list[Copy]) -> list[np.ndarray]:
    out = []
    for k, copy in enumerate(copies, start=1):
        if copy.drive == "v":
            current = -np.asarray(reader.signal(f"I(VS{k})"), dtype=complex)  # into the part
            out.append(1 / current)
        else:
            out.append(np.asarray(reader.signal(f"V(p{k})"), dtype=complex))
    return out


def frequency_grid(fmin: float, fmax: float, per_decade: int = 20) -> AcAnalysis:
    return AcAnalysis(variation="dec", points=per_decade, fstart=to_spice(fmin),
                      fstop=to_spice(fmax))  # fmt: skip


def impedance_sweep(
    run: Run, base: Project, top: str, analysis: AcAnalysis, copies: list[Copy]
) -> tuple[np.ndarray, list[np.ndarray]]:
    """(frequencies, impedance of each copy)."""
    reader = run(bench_circuit(base, top, copies), analysis)
    freqs = np.asarray(reader.signal("frequency")).real.astype(float)
    return freqs, _impedances(reader, copies)


def capacitance_curve(
    run: Run, base: Project, top: str, volts: list[float], freq: float,
    params: dict[str, str] | None = None,
) -> np.ndarray:  # fmt: skip
    """Small-signal C at each DC voltage (from the reactance at ``freq``)."""
    copies = [Copy(dict(params or {}), "v", u) for u in volts]
    analysis = AcAnalysis(variation="lin", points=1, fstart=to_spice(freq), fstop=to_spice(freq))
    _f, zs = impedance_sweep(run, base, top, analysis, copies)
    return np.array([-1 / (TWO_PI * freq * z[0].imag) for z in zs])


def inductance_curve(
    run: Run, base: Project, top: str, amps: list[float], freq: float,
    params: dict[str, str] | None = None,
) -> np.ndarray:  # fmt: skip
    """Small-signal L at each DC current."""
    copies = [Copy(dict(params or {}), "i", i) for i in amps]
    analysis = AcAnalysis(variation="lin", points=1, fstart=to_spice(freq), fstop=to_spice(freq))
    _f, zs = impedance_sweep(run, base, top, analysis, copies)
    return np.array([z[0].imag / (TWO_PI * freq) for z in zs])


def iv_curve(
    run: Run, base: Project, top: str, vmin: float, vmax: float, points: int = 101
) -> tuple[np.ndarray, np.ndarray]:
    """DC current into the part over a voltage sweep."""
    circuit = bench_circuit(base, top, [Copy(drive="v")])
    step = (vmax - vmin) / max(points - 1, 1)
    reader = run(circuit, DcAnalysis(source="VS1", start=to_spice(vmin), stop=to_spice(vmax),
                                     step=to_spice(step)))  # fmt: skip
    volts = np.asarray(reader.signal("sweep")).real.astype(float)
    return volts, -np.asarray(reader.signal("I(VS1)")).real.astype(float)


def port_circuit(base: Project, top: str, copies: list[tuple[dict[str, str], dict[str, str]]],
                 sources: list[Device]) -> CircuitIR:  # fmt: skip
    """Copies of ``top`` given as (port -> net, parameter overrides), plus ``sources``.

    Sources name nets as the copies do; ground is ``0``. Ports left out go to ground.
    """
    sheets = needed_sheets(base.sheets, top)
    root = Sheet(name="bench")
    project = base.model_copy(update={"sheets": [*sheets, root]})
    symbol = project_symbols(project).get(f"{PREFIX}{top}")
    if symbol is None or symbol.spice is None:
        raise BenchError(f"{top} has no ports")
    grounds = count(1)
    for k, (nets, params) in enumerate(copies, start=1):
        order = [nets.get(node, "0") for node in symbol.spice.nodes]
        add = place_component(symbol, f"X{k}", order, (0, 4000 * k), params, None, grounds)
        root.instances += add.instances
        root.wires += add.wires
        root.labels += add.labels
    result = netlist_project(project)
    # Ground may come with the sources alone (an op-amp: no pin of it goes to ground).
    grounded = any("0" in device.nodes for device in sources)
    errors = [i.message for i in result.issues
              if i.severity == "error" and not (grounded and i.code == "no-ground")]  # fmt: skip
    if errors:
        raise BenchError("; ".join(errors))
    circuit = result.circuit
    node_of = {user: node for node, user in circuit.net_names.items()}
    for device in sources:
        nodes = [node_of.get(n, n) for n in device.nodes]
        circuit.devices.append(device.model_copy(update={"nodes": nodes}))
    return circuit


def dc_sweep(run: Run, circuit: CircuitIR, source: str, start: float, stop: float,
             points: int = 101) -> RunReader:  # fmt: skip
    step = (stop - start) / max(points - 1, 1)
    return run(circuit, DcAnalysis(source=source, start=to_spice(start), stop=to_spice(stop),
                                   step=to_spice(step)))  # fmt: skip


def source(ref: str, plus: str, minus: str, dc: float) -> Device:
    """A DC source (``V...`` or ``I...`` by its ref) between nets."""
    element: Literal["V", "I"] = "I" if ref.startswith("I") else "V"
    return Device(ref=ref, element=element, nodes=[plus, minus], params={"dc": to_spice(dc)})
