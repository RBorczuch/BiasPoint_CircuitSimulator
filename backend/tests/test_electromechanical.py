"""Electromechanical parts and ABM sensors (FR-MOD-11) in ngspice against their formulas."""

import math

import numpy as np
import pytest

from bpt.analysis.spec import OpAnalysis, TranAnalysis
from bpt.engines.ngspice.engine import NgspiceEngine
from bpt.library.builtin import builtin_subcircuits
from bpt.models import bench
from bpt.netlist.ir import CircuitIR, Device

pytestmark = pytest.mark.ngspice


@pytest.fixture(scope="module")
def run():  # type: ignore[no-untyped-def]
    engine = NgspiceEngine()
    yield bench.engine_runner(engine)
    engine.close()


def _circuit(devices: list[Device], name: str) -> CircuitIR:
    circuit = CircuitIR(title=name, devices=devices)
    circuit.subckt_models[name] = builtin_subcircuits()[name]
    return circuit


MOTOR = {"r": 1.0, "ke": 10e-3, "kt": 10e-3, "j": 10e-6, "b": 1e-6}


def test_motor_speed_and_its_time_constant(run) -> None:  # type: ignore[no-untyped-def]
    """No load at 12 V: w = V*kt / (R*b + ke*kt); it gets there with tau = J*R / (R*b + ke*kt)
    (the armature inductance small)."""
    m = MOTOR
    denominator = m["r"] * m["b"] + m["ke"] * m["kt"]
    speed = 12 * m["kt"] / denominator
    tau = m["j"] * m["r"] / denominator
    circuit = _circuit([
        Device(ref="V1", element="V", nodes=["p", "0"],
               params={"dc": "", "tran": "PULSE(0 12 0 1u 1u 1 2)"}),
        Device(ref="X1", element="X", nodes=["p", "0", "w"], model="MOTOR",
               params={k: str(v) for k, v in m.items()}),
    ], "MOTOR")  # fmt: skip
    reader = run(circuit, TranAnalysis(tstep="10u", tstop=f"{8 * tau:.6g}", tmax="10u"))
    t = np.real(reader.signal("time"))
    w = np.real(reader.signal("V(w)"))
    assert float(w[-1]) == pytest.approx(speed, rel=0.01)
    assert float(np.interp(tau, t, w)) == pytest.approx(speed * (1 - math.exp(-1)), rel=0.03)


def test_motor_slows_under_a_load_torque(run) -> None:  # type: ignore[no-untyped-def]
    """A load torque TL (a current out of W) lowers the steady speed by TL*R / (R*b + ke*kt)."""
    m = MOTOR
    load = 5e-3
    denominator = m["r"] * m["b"] + m["ke"] * m["kt"]
    circuit = _circuit([
        Device(ref="V1", element="V", nodes=["p", "0"], params={"dc": "12"}),
        Device(ref="X1", element="X", nodes=["p", "0", "w"], model="MOTOR",
               params={k: str(v) for k, v in m.items()}),
        Device(ref="TL", element="I", nodes=["w", "0"], params={"dc": str(load)}),
    ], "MOTOR")  # fmt: skip
    w = float(np.real(run(circuit, OpAnalysis()).signal("V(w)"))[0])
    assert w == pytest.approx((12 * m["kt"] - load * m["r"]) / denominator, rel=1e-3)


def test_loudspeaker_impedance_peaks_at_its_resonance(run) -> None:  # type: ignore[no-untyped-def]
    """|Z| peaks at fs = 1/(2π√(Mms·Cms)) with Zmax = Re + BL²/Rms."""
    re, bl, mms, cms, rms = 6.0, 7.0, 20e-3, 0.5e-3, 2.0
    fs = 1 / (2 * math.pi * math.sqrt(mms * cms))
    circuit = _circuit([
        Device(ref="V1", element="V", nodes=["p", "0"], params={"dc": "0", "ac": "1"}),
        Device(ref="X1", element="X", nodes=["p", "0", "v"], model="SPEAKER",
               params={"re": str(re), "le": "1n", "bl": str(bl), "mms": str(mms),
                       "cms": str(cms), "rms": str(rms)}),
    ], "SPEAKER")  # fmt: skip
    reader = run(circuit, bench.frequency_grid(fs / 10, fs * 10, 200))
    f = np.real(reader.signal("frequency"))
    z = np.abs(1 / np.asarray(reader.signal("I(V1)")))
    k = int(np.argmax(z))
    assert float(f[k]) == pytest.approx(fs, rel=0.02)
    assert float(z[k]) == pytest.approx(re + bl**2 / rms, rel=0.01)


@pytest.mark.parametrize("celsius", [25.0, 50.0, 0.0])
def test_ntc_follows_the_b_equation(run, celsius: float) -> None:  # type: ignore[no-untyped-def]
    r25, beta = 10e3, 3950.0
    expected = r25 * math.exp(beta * (1 / (celsius + 273.15) - 1 / 298.15))
    circuit = _circuit([
        Device(ref="V1", element="V", nodes=["a", "0"], params={"dc": "1"}),
        Device(ref="VT", element="V", nodes=["t", "0"], params={"dc": str(celsius)}),
        Device(ref="X1", element="X", nodes=["a", "0", "t"], model="NTC"),
    ], "NTC")  # fmt: skip
    current = -float(np.real(run(circuit, OpAnalysis()).signal("I(V1)"))[0])
    assert 1 / current == pytest.approx(expected, rel=1e-4)


def test_hall_sensor_output_and_its_limits(run) -> None:  # type: ignore[no-untyped-def]
    for field, out in ((0.0, 2.5), (40.0, 3.5), (-40.0, 1.5), (200.0, 5.0)):
        circuit = _circuit([
            Device(ref="VB", element="V", nodes=["b", "0"], params={"dc": str(field)}),
            Device(ref="X1", element="X", nodes=["b", "o", "0"], model="HALL"),
            Device(ref="RL", element="R", nodes=["o", "0"], params={"R": "1G"}),
        ], "HALL")  # fmt: skip
        v = float(np.real(run(circuit, OpAnalysis()).signal("V(o)"))[0])
        assert v == pytest.approx(out, abs=1e-3), field
