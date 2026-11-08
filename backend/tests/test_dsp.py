import numpy as np
import pytest

from bpt.graph import dsp


def test_spectrum_amplitude_and_frequency() -> None:
    t = np.linspace(0, 10e-3, 4001)
    y = 0.5 + 2.0 * np.sin(2 * np.pi * 1e3 * t)
    f, v = dsp.spectrum(t, y, "flattop")
    k = int(np.argmax(np.abs(v[5:]))) + 5
    assert f[k] == pytest.approx(1e3, rel=0.02)
    assert abs(v[k]) == pytest.approx(2.0, rel=0.01)  # flat-top: amplitude-correct
    assert abs(v[0]) == pytest.approx(0.5, rel=0.02)


def test_lowpass_removes_the_high_tone() -> None:
    t = np.linspace(0, 20e-3, 20001)
    y = np.sin(2 * np.pi * 100 * t) + np.sin(2 * np.pi * 20e3 * t)
    grid, out = dsp.butterworth(t, y, "low", 1e3, order=4)
    f, v = dsp.spectrum(grid, out, "flattop")
    assert abs(v[np.argmin(abs(f - 20e3))]) < 1e-3
    assert abs(v[np.argmin(abs(f - 100))]) == pytest.approx(1.0, rel=0.05)


def test_step_measures() -> None:
    tau = 1e-3
    t = np.linspace(0, 10e-3, 10001)
    y = 1 - np.exp(-t / tau)
    assert dsp.transition_time(t, y) == pytest.approx(np.log(9) * tau, rel=0.01)  # 2.197 τ
    assert dsp.overshoot(y) == pytest.approx(0.0, abs=1e-9)
    assert dsp.settling_time(t, y, 0.02) == pytest.approx(
        -np.log(0.02 / (1 - np.exp(-10))) * tau, rel=0.01
    )
    ringing = 1 - np.exp(-t / tau) * np.cos(2 * np.pi * 1e3 * t)
    assert dsp.overshoot(ringing) > 10


def test_periodic_measures() -> None:
    t = np.linspace(0, 10e-3, 100001)
    square = (np.mod(t, 1e-3) < 0.25e-3).astype(float)
    assert dsp.frequency(t, square) == pytest.approx(1e3, rel=1e-3)
    assert dsp.duty_cycle(t, square) == pytest.approx(25, abs=0.2)
    sine = np.sin(2 * np.pi * 1e3 * t) + 0.1 * np.sin(2 * np.pi * 3e3 * t)
    distortion, fundamental = dsp.thd(t, sine)
    assert fundamental == pytest.approx(1e3, rel=0.01)
    assert distortion == pytest.approx(10.0, rel=0.03)


def test_margins_of_a_three_pole_loop() -> None:
    f = np.logspace(0, 6, 4001)
    s = 2j * np.pi * f
    p = 2 * np.pi * 1e3
    loop = 4 / (1 + s / p) ** 3  # -180° at sqrt(3)·fp, where |L| = 4/8
    pm, gm = dsp.margins(f, loop)
    assert gm == pytest.approx(20 * np.log10(2), abs=0.05)  # 6.02 dB
    assert pm is not None and 20 < pm < 60
