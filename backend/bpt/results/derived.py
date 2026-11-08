"""Signals computed after a run when the simulator does not provide them.

ngspice reports no currents of resistors and capacitors in AC analysis ("Current and power not
available for ac analysis"); they follow from the node voltages: I = (V1 - V2) / Z with Z = R
or 1 / (jωC). The current is positive into the first terminal, as for every other probe.
"""

from pathlib import Path

import numpy as np

from bpt.netlist.ir import CircuitIR
from bpt.results.store import RunMeta, RunWriter
from bpt.units import InvalidValueError, parse_value


def add_ac_currents(directory: Path, circuit: CircuitIR, meta: RunMeta) -> RunMeta:
    """Append I(<ref>) of R and C parts to an AC run; returns the updated metadata."""
    names = {s.name.lower(): s for s in meta.signals}
    if meta.scale != "frequency" or "frequency" not in names:
        return meta
    # The files as they are now, read once (the writer appends to them meanwhile; one read per
    # signal took ~3 ms each: 24 s for 7500 signals).
    files = {info.file: (directory / info.file).read_bytes() for info in meta.signals}
    writer = RunWriter(directory, meta)

    def load(name: str) -> np.ndarray | None:
        info = names.get(name.lower())
        if info is None:
            return None
        dtype = np.dtype("<c16" if info.complex else "<f8")
        count = -1 if info.length is None else info.length
        return np.frombuffer(files[info.file], dtype=dtype, count=count, offset=info.offset)

    frequency = np.real(load("frequency"))  # type: ignore[arg-type]
    omega = 2 * np.pi * frequency

    def voltage(node: str) -> np.ndarray | None:
        if node == "0":
            return np.zeros_like(frequency, dtype=complex)
        net = circuit.net_names.get(node, node)
        return load(f"V({net})") if f"v({net})".lower() in names else load(net)

    for device in circuit.devices:
        # Parasitic parts ("C1_esr") sit inside the chain of their part: same current.
        if device.element not in ("R", "C") or "_" in device.ref:
            continue
        if f"i({device.ref})".lower() in names:
            continue
        try:
            value = parse_value(device.params.get(device.element, ""))  # R=…, C=…
        except InvalidValueError:
            continue  # {expression}: the value is only known inside the simulator
        a, b = voltage(device.nodes[0]), voltage(device.nodes[1])
        if a is None or b is None or value == 0:
            continue
        drop = a - b
        current = drop / value if device.element == "R" else drop * 1j * omega * value
        writer.add_signal(f"I({device.ref})", current, "A")
    return writer.finish()
