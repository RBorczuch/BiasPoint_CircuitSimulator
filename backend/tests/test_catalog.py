"""Parts of the extended catalogue (FR-MOD-10) simulated by ngspice against their formulas."""

import math

import numpy as np
import pytest

from bpt.analysis.spec import AcAnalysis, OpAnalysis, TranAnalysis
from bpt.engines.ngspice.engine import NgspiceEngine
from bpt.library.builtin import builtin_models, builtin_subcircuits
from bpt.models import bench
from bpt.netlist.ir import CircuitIR, Device

pytestmark = pytest.mark.ngspice


@pytest.fixture(scope="module")
def run():  # type: ignore[no-untyped-def]
    engine = NgspiceEngine()
    yield bench.engine_runner(engine)
    engine.close()


def _circuit(devices: list[Device], subckts: tuple[str, ...] = (), models: tuple[str, ...] = ()
             ) -> CircuitIR:  # fmt: skip
    circuit = CircuitIR(title="catalogue", devices=devices)
    for name in subckts:
        circuit.subckt_models[name] = builtin_subcircuits()[name]
    for name in models:
        circuit.models[name] = builtin_models()[name]
    return circuit


@pytest.mark.parametrize("pos", [0.0, 0.25, 0.9, 1.0])
def test_potentiometer_divides_by_its_position(run, pos: float) -> None:  # type: ignore[no-untyped-def]
    circuit = _circuit([
        Device(ref="V1", element="V", nodes=["a", "0"], params={"dc": "10"}),
        Device(ref="X1", element="X", nodes=["a", "0", "w"], model="POT",
               params={"r": "10k", "pos": str(pos)}),
        Device(ref="RL", element="R", nodes=["w", "0"], params={"R": "1G"}),
    ], subckts=("POT",))  # fmt: skip
    reader = run(circuit, OpAnalysis())
    assert float(np.real(reader.signal("V(w)"))[0]) == pytest.approx(10 * (1 - pos), abs=1e-3)


def test_fuse_opens_at_its_melting_integral(run) -> None:  # type: ignore[no-untyped-def]
    """2 A through I²t = 1 A²s: open after 1 / 2² = 0.25 s, and it stays open."""
    circuit = _circuit([
        Device(ref="I1", element="I", nodes=["0", "a"], params={"dc": "2"}),
        Device(ref="X1", element="X", nodes=["a", "0"], model="FUSE",
               params={"r": "10m", "i2t": "1"}),
        Device(ref="RB", element="R", nodes=["a", "0"], params={"R": "100"}),
    ], subckts=("FUSE",))  # fmt: skip
    reader = run(circuit, TranAnalysis(tstep="1m", tstop="0.4", tmax="1m"))
    t = np.real(reader.signal("time"))
    v = np.real(reader.signal("V(a)"))
    assert float(np.interp(0.1, t, v)) == pytest.approx(0.02, rel=0.05)  # 2 A on 10 mΩ
    blown = float(t[np.argmax(v > 1)])
    assert blown == pytest.approx(0.25, rel=0.02)
    assert float(v[-1]) == pytest.approx(200, rel=0.01)  # all the current through RB now


def test_varicap_capacitance_falls_with_reverse_voltage(run) -> None:  # type: ignore[no-untyped-def]
    """C(V) = CJO / (1 + V/VJ)^M at the reverse bias, from the AC current through it."""
    card = builtin_models()["VARICAP"]
    cjo, vj, m = 40e-12, 0.7, 0.5
    for bias in (1.0, 4.0, 10.0):
        circuit = _circuit([
            Device(ref="V1", element="V", nodes=["k", "0"], params={"dc": str(bias), "ac": "1"}),
            Device(ref="D1", element="D", nodes=["0", "k"], model="VARICAP"),
        ], models=("VARICAP",))  # fmt: skip
        reader = run(circuit, AcAnalysis(variation="lin", points=1, fstart="1meg", fstop="1meg"))
        current = complex(np.asarray(reader.signal("I(V1)"))[0])
        c = abs(current) / (2 * math.pi * 1e6)
        assert c == pytest.approx(cjo / (1 + bias / vj) ** m, rel=0.02), (bias, card.params)


def test_thyristor_blocks_latches_on_a_gate_pulse_and_turns_off_at_zero(run) -> None:  # type: ignore[no-untyped-def]
    """12 V through 100 Ω: blocks until a 20 mA gate pulse, then stays on after it (about
    1 V across), turns off when the supply goes to zero and blocks again without a pulse."""
    supply = "PWL(0 12 4m 12 4.1m 0 5m 0 5.1m 12 8m 12)"
    gate = "PULSE(0 20m 1m 1u 1u 50u 1)"
    circuit = _circuit([
        Device(ref="V1", element="V", nodes=["s", "0"], params={"dc": "", "tran": supply}),
        Device(ref="RL", element="R", nodes=["s", "a"], params={"R": "100"}),
        Device(ref="X1", element="X", nodes=["a", "0", "g"], model="SCR", params={"rgk": "1k"}),
        Device(ref="IG", element="I", nodes=["0", "g"], params={"dc": "", "tran": gate}),
    ], subckts=("SCR",))  # fmt: skip
    reader = run(circuit, TranAnalysis(tstep="2u", tstop="8m", tmax="2u"))
    t = np.real(reader.signal("time"))
    v = np.real(reader.signal("V(a)"))

    def at(time: float) -> float:
        return float(np.interp(time, t, v))

    assert at(0.9e-3) == pytest.approx(12, abs=0.1)  # blocking
    assert 0.5 < at(3e-3) < 1.5  # on, long after the pulse
    assert at(7e-3) == pytest.approx(12, abs=0.1)  # off again, no pulse to turn it on


@pytest.mark.parametrize(("current", "closed"), [(25e-3, True), (15e-3, False)])
def test_relay_pulls_in_above_its_pull_in_current(run, current: float, closed: bool) -> None:  # type: ignore[no-untyped-def]
    """Rising from zero: the contact closes only above the pull-in current (20 mA)."""
    circuit = _circuit([
        Device(ref="IC", element="I", nodes=["0", "a1"], params={"dc": "",
               "tran": f"PWL(0 0 1m {current})"}),
        Device(ref="VC", element="V", nodes=["com", "0"], params={"dc": "1"}),
        Device(ref="RN", element="R", nodes=["no", "0"], params={"R": "1k"}),
        Device(ref="RC", element="R", nodes=["nc", "0"], params={"R": "1k"}),
        Device(ref="X1", element="X", nodes=["a1", "0", "com", "no", "nc"], model="RELAY"),
    ], subckts=("RELAY",))  # fmt: skip
    reader = run(circuit, TranAnalysis(tstep="10u", tstop="20m", tmax="10u"))
    no = float(np.real(reader.signal("V(no)"))[-1])
    nc = float(np.real(reader.signal("V(nc)"))[-1])
    assert (no > 0.9) is closed and (nc > 0.9) is not closed


def test_relay_holds_until_its_drop_out_current(run) -> None:  # type: ignore[no-untyped-def]
    """Pulled in at 25 mA, it stays closed at 10 mA (above the 6 mA drop-out) and opens at
    4 mA."""
    pwl = "PWL(0 0 1m 25m 5m 25m 6m 10m 10m 10m 11m 4m 15m 4m)"
    circuit = _circuit([
        Device(ref="IC", element="I", nodes=["0", "a1"], params={"dc": "", "tran": pwl}),
        Device(ref="VC", element="V", nodes=["com", "0"], params={"dc": "1"}),
        Device(ref="RN", element="R", nodes=["no", "0"], params={"R": "1k"}),
        Device(ref="RC", element="R", nodes=["nc", "0"], params={"R": "1k"}),
        Device(ref="X1", element="X", nodes=["a1", "0", "com", "no", "nc"], model="RELAY"),
    ], subckts=("RELAY",))  # fmt: skip
    reader = run(circuit, TranAnalysis(tstep="10u", tstop="15m", tmax="10u"))
    t = np.real(reader.signal("time"))
    no = np.real(reader.signal("V(no)"))
    assert float(np.interp(9e-3, t, no)) > 0.9  # held at 10 mA
    assert float(np.interp(14e-3, t, no)) < 0.1  # dropped at 4 mA


def test_the_new_symbols_place_and_netlist() -> None:
    """Each new part placed from the library writes its subcircuit with the pins in order."""
    from bpt.document.builder import place_component
    from bpt.document.model import Project, Sheet
    from bpt.library.builtin import builtin_symbols
    from bpt.netlist.netlister import netlist_project

    symbols = builtin_symbols()
    for sid, pins in [("bpt:potentiometer", 3), ("bpt:fuse", 2), ("bpt:thyristor", 3),
                      ("bpt:relay", 5), ("bpt:photodiode", 2), ("bpt:optocoupler", 4),
                      ("bpt:igbt", 3), ("bpt:vcr", 4), ("bpt:transformer3", 6),
                      ("bpt:triac", 3), ("bpt:diac", 2), ("bpt:phototransistor", 2),
                      ("bpt:motor", 3), ("bpt:speaker", 3), ("bpt:ntc", 3),
                      ("bpt:hall", 3)]:  # fmt: skip
        sheet = Sheet(name="root")
        nets = [f"n{k}" for k in range(pins)]
        add = place_component(symbols[sid], "X1", nets, (0, 0), {}, None)
        sheet.instances += add.instances
        sheet.wires += add.wires
        sheet.labels += add.labels
        result = netlist_project(Project(name="t", sheets=[sheet]))
        model = symbols[sid].default_model
        assert result.circuit.subckt_models.get(model) is not None, sid
        line = next(d for d in result.circuit.devices if d.ref == "X1")
        assert line.nodes == nets, sid


def test_photodiode_gives_its_photocurrent_reverse_biased(run) -> None:  # type: ignore[no-untyped-def]
    """Reverse biased at 5 V through 10 kOhm: the photocurrent flows, 10 uA -> 0.1 V."""
    circuit = _circuit([
        Device(ref="V1", element="V", nodes=["s", "0"], params={"dc": "5"}),
        Device(ref="R1", element="R", nodes=["s", "k"], params={"R": "10k"}),
        Device(ref="X1", element="X", nodes=["0", "k"], model="PHOTODIODE",
               params={"iph": "10u"}),
    ], subckts=("PHOTODIODE",))  # fmt: skip
    reader = run(circuit, OpAnalysis())
    assert 5 - float(np.real(reader.signal("V(k)"))[0]) == pytest.approx(0.1, rel=0.02)


def test_optocoupler_collector_current_is_ctr_times_the_led_current(run) -> None:  # type: ignore[no-untyped-def]
    circuit = _circuit([
        Device(ref="IF", element="I", nodes=["0", "a"], params={"dc": "10m"}),
        Device(ref="VCE", element="V", nodes=["c", "0"], params={"dc": "5"}),
        Device(ref="X1", element="X", nodes=["a", "0", "c", "0"], model="OPTO",
               params={"ctr": "0.5"}),
    ], subckts=("OPTO",))  # fmt: skip
    reader = run(circuit, OpAnalysis())
    ic = -float(np.real(reader.signal("I(VCE)"))[0])
    assert ic == pytest.approx(5e-3, rel=0.05)  # CTR 0.5 of 10 mA (Early effect within 5 %)


def test_igbt_blocks_below_its_threshold_and_conducts_above(run) -> None:  # type: ignore[no-untyped-def]
    def collector(vg: float) -> float:
        circuit = _circuit([
            Device(ref="V1", element="V", nodes=["s", "0"], params={"dc": "100"}),
            Device(ref="RL", element="R", nodes=["s", "c"], params={"R": "10"}),
            Device(ref="VG", element="V", nodes=["g", "0"], params={"dc": str(vg)}),
            Device(ref="X1", element="X", nodes=["c", "g", "0"], model="IGBT"),
        ], subckts=("IGBT",))  # fmt: skip
        return float(np.real(run(circuit, OpAnalysis()).signal("V(c)"))[0])

    assert collector(3) == pytest.approx(100, abs=0.1)  # off below Vth = 5 V
    assert 0.5 < collector(15) < 3  # saturated: the PNP's junction and a little more


def test_voltage_controlled_resistor(run) -> None:  # type: ignore[no-untyped-def]
    """R = R0/(1 + K*Vc): 10 kOhm at 0 V, 5 kOhm at 1 V of control."""
    for vc, r in ((0.0, 10e3), (1.0, 5e3)):
        circuit = _circuit([
            Device(ref="V1", element="V", nodes=["a", "0"], params={"dc": "1"}),
            Device(ref="VC", element="V", nodes=["cp", "0"], params={"dc": str(vc)}),
            Device(ref="X1", element="X", nodes=["a", "0", "cp", "0"], model="VCR"),
        ], subckts=("VCR",))  # fmt: skip
        reader = run(circuit, OpAnalysis())
        assert -float(np.real(reader.signal("I(V1)"))[0]) == pytest.approx(1 / r, rel=1e-3)


def test_three_winding_transformer_ratios(run) -> None:  # type: ignore[no-untyped-def]
    """1 V AC on the primary: 2 V on a 1:2 winding, 0.5 V on a 1:0.5 one (k near 1)."""
    circuit = _circuit([
        Device(ref="V1", element="V", nodes=["p", "0"], params={"dc": "0", "ac": "1"}),
        Device(ref="X1", element="X", nodes=["p", "0", "s", "0", "t", "0"], model="XFMR3",
               params={"ns": "2", "nt": "0.5", "k": "0.9999"}),
        Device(ref="RS", element="R", nodes=["s", "0"], params={"R": "1meg"}),
        Device(ref="RT", element="R", nodes=["t", "0"], params={"R": "1meg"}),
    ], subckts=("XFMR3",))  # fmt: skip
    reader = run(circuit, AcAnalysis(variation="lin", points=1, fstart="10k", fstop="10k"))
    assert abs(complex(np.asarray(reader.signal("V(s)"))[0])) == pytest.approx(2, rel=0.01)
    assert abs(complex(np.asarray(reader.signal("V(t)"))[0])) == pytest.approx(0.5, rel=0.01)


@pytest.mark.parametrize("gate", ["20m", "-20m"])
def test_triac_conducts_both_half_waves_after_a_gate_pulse_of_either_sign(run, gate: str) -> None:  # type: ignore[no-untyped-def]
    """±12 V half waves through 100 Ω: blocks until the gate pulse, conducts while the half wave
    lasts, off at its zero; fired again in the negative half wave by the next pulse."""
    supply = "PWL(0 12 4m 12 4.1m 0 5m 0 5.1m -12 9m -12 9.1m 0 10m 0)"
    pulses = f"PULSE(0 {gate} 1m 1u 1u 50u 5m)"  # at 1 ms and at 6 ms
    circuit = _circuit([
        Device(ref="V1", element="V", nodes=["s", "0"], params={"dc": "", "tran": supply}),
        Device(ref="RL", element="R", nodes=["s", "a"], params={"R": "100"}),
        Device(ref="X1", element="X", nodes=["a", "0", "g"], model="TRIAC"),
        Device(ref="IG", element="I", nodes=["0", "g"], params={"dc": "", "tran": pulses}),
    ], subckts=("TRIAC",))  # fmt: skip
    reader = run(circuit, TranAnalysis(tstep="2u", tstop="10m", tmax="2u"))
    t = np.real(reader.signal("time"))
    v = np.real(reader.signal("V(a)"))

    def at(time: float) -> float:
        return float(np.interp(time, t, v))

    assert at(0.9e-3) == pytest.approx(12, abs=0.1)  # blocking before the pulse
    assert 0.3 < at(3e-3) < 2  # on in the positive half wave
    assert at(5.5e-3) == pytest.approx(-12, abs=0.1)  # off: blocked after the zero
    assert -2 < at(8e-3) < -0.3  # fired again, conducting the negative half wave


def test_diac_breaks_over_at_its_voltage_both_ways(run) -> None:  # type: ignore[no-untyped-def]
    """A slow ramp through 10 kOhm: below VBO it blocks, past it the voltage falls back."""
    for sign in (1, -1):
        ramp = f"PWL(0 0 10m {sign * 40})"
        circuit = _circuit([
            Device(ref="V1", element="V", nodes=["s", "0"], params={"dc": "", "tran": ramp}),
            Device(ref="R1", element="R", nodes=["s", "a"], params={"R": "10k"}),
            Device(ref="X1", element="X", nodes=["a", "0"], model="DIAC", params={"vbo": "32"}),
        ], subckts=("DIAC",))  # fmt: skip
        reader = run(circuit, TranAnalysis(tstep="5u", tstop="10m", tmax="5u"))
        v = sign * np.real(reader.signal("V(a)"))
        peak = float(np.max(v))
        assert peak == pytest.approx(32, abs=1.5), sign  # breakover at VBO
        assert float(v[-1]) < 5, sign  # conducting after it


def test_phototransistor_collector_current_is_bf_times_the_photocurrent(run) -> None:  # type: ignore[no-untyped-def]
    circuit = _circuit([
        Device(ref="VC", element="V", nodes=["c", "0"], params={"dc": "5"}),
        Device(ref="X1", element="X", nodes=["c", "0"], model="PHOTOQ",
               params={"iph": "1u", "bf": "300"}),
    ], subckts=("PHOTOQ",))  # fmt: skip
    ic = -float(np.real(run(circuit, OpAnalysis()).signal("I(VC)"))[0])
    assert ic == pytest.approx(300e-6, rel=0.06)  # (the Early effect at 5 V: a few %)
