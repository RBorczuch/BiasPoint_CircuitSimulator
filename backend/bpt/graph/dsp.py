"""Signal processing for graph nodes (numpy only): resampling, windows, FFT, filters, measures.

Transient results have non-uniform time steps; spectra and filters first resample onto a
uniform grid. Filters work in the frequency domain with a Butterworth magnitude response and
no phase shift (zero-phase), which is what one wants for looking at results.
"""

from itertools import pairwise

import numpy as np
import numpy.typing as npt

F64 = npt.NDArray[np.float64]
C128 = npt.NDArray[np.complex128]

MAX_POINTS = 1 << 18


class DspError(ValueError):
    """The signal does not allow the operation (too short, no edges, ...)."""


def uniform(x: F64, y: F64, points: int | None = None) -> tuple[F64, F64]:
    """Resample onto an even grid (at least as fine as the median step, at most 2^18 points)."""
    if len(x) < 4:
        raise DspError("the signal has too few points")
    span = float(x[-1] - x[0])
    if span <= 0:
        raise DspError("the x axis does not increase")
    if points is None:
        step = float(np.median(np.diff(x)))
        points = int(span / step) + 1 if step > 0 else len(x)
    points = int(min(MAX_POINTS, max(16, points)))
    grid = np.linspace(float(x[0]), float(x[-1]), points)
    return grid, np.interp(grid, x, y)


WINDOWS = ["hann", "blackman-harris", "flattop", "rect"]


_COSINE_SUMS: dict[str, tuple[float, ...]] = {
    "rect": (1.0,),
    "hann": (0.5, 0.5),
    "blackman-harris": (0.35875, 0.48829, 0.14128, 0.01168),
    "flattop": (0.21557895, 0.41663158, 0.277263158, 0.083578947, 0.006947368),
}


def window(name: str, n: int) -> F64:
    """Cosine-sum window: a0 - a1 cos(2πk) + a2 cos(4πk) - ..."""
    if name not in _COSINE_SUMS:
        raise DspError(f"unknown window {name!r}; use {', '.join(WINDOWS)}")
    k = np.arange(n) / max(n - 1, 1)
    out = np.zeros(n)
    for i, a in enumerate(_COSINE_SUMS[name]):
        out += (-1) ** i * a * np.cos(2 * np.pi * i * k)
    return out


def spectrum(x: F64, y: F64, window_name: str = "hann") -> tuple[F64, C128]:
    """One-sided spectrum scaled to peak amplitude: a 1 V sine shows as 1 V at its frequency."""
    t, v = uniform(x, y)
    n = len(t)
    w = window(window_name, n)
    values = np.fft.rfft(v * w) / np.sum(w)
    values[1:] *= 2  # one-sided: fold the negative frequencies (DC stays)
    freqs = np.fft.rfftfreq(n, d=float(t[1] - t[0]))
    return freqs, values


def butterworth(
    x: F64, y: F64, kind: str, f1: float, f2: float = 0.0, order: int = 2
) -> tuple[F64, F64]:
    """Zero-phase Butterworth filter (low, high, band) on a uniform grid; returns (x, y)."""
    t, v = uniform(x, y)
    freqs = np.fft.rfftfreq(len(t), d=float(t[1] - t[0]))
    f = np.maximum(freqs, 1e-30)
    low = 1 / np.sqrt(1 + (f / f1) ** (2 * order)) if f1 > 0 else np.ones_like(f)
    if kind == "low":
        gain = low
    elif kind == "high":
        gain = 1 / np.sqrt(1 + (f1 / f) ** (2 * order))
        gain[0] = 0.0
    elif kind == "band":
        if not 0 < f1 < f2:
            raise DspError("a band-pass needs 0 < f low < f high")
        gain = (1 / np.sqrt(1 + (f1 / f) ** (2 * order))) * (
            1 / np.sqrt(1 + (f / f2) ** (2 * order))
        )
        gain[0] = 0.0
    else:
        raise DspError("filter type is low, high or band")
    return t, np.fft.irfft(np.fft.rfft(v) * gain, n=len(t))


def _crossings(x: F64, y: F64, level: float, rising: bool) -> F64:
    """Interpolated x where y crosses level in the given direction."""
    above = y >= level
    idx = np.nonzero((~above[:-1] & above[1:]) if rising else (above[:-1] & ~above[1:]))[0]
    x0, x1, y0, y1 = x[idx], x[idx + 1], y[idx], y[idx + 1]
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(y1 != y0, x0 + (level - y0) * (x1 - x0) / (y1 - y0), x0)


def transition_time(x: F64, y: F64, rising: bool = True, lo: float = 0.1, hi: float = 0.9) -> float:
    """10-90 % rise (or 90-10 % fall) time of the first edge between the signal's extremes."""
    bottom, top = float(np.min(y)), float(np.max(y))
    if top - bottom <= 0:
        raise DspError("the signal is constant")
    l1, l2 = bottom + lo * (top - bottom), bottom + hi * (top - bottom)
    start = _crossings(x, y, l1 if rising else l2, rising)
    if not start.size:
        raise DspError("no rising edge" if rising else "no falling edge")
    end = _crossings(x, y, l2 if rising else l1, rising)
    end = end[end >= start[0]]
    if not end.size:
        raise DspError("the edge does not complete")
    return float(end[0] - start[0])


def transition_times(
    x: F64, y: F64, rising: bool = True, lo: float = 0.1, hi: float = 0.9
) -> list[float]:
    """10-90 % (or ``lo``-``hi``) time of every complete edge in one direction."""
    bottom, top = float(np.min(y)), float(np.max(y))
    if top - bottom <= 0:
        raise DspError("the signal is constant")
    l1, l2 = bottom + lo * (top - bottom), bottom + hi * (top - bottom)
    starts = _crossings(x, y, l1 if rising else l2, rising)
    ends = _crossings(x, y, l2 if rising else l1, rising)
    times: list[float] = []
    for k, start in enumerate(starts):
        until = starts[k + 1] if k + 1 < len(starts) else np.inf
        end = ends[(ends >= start) & (ends < until)]
        if end.size:
            times.append(float(end[0] - start))
    if not times:
        raise DspError("no complete rising edge" if rising else "no complete falling edge")
    return times


def periods(x: F64, y: F64, level: float | None = None) -> list[tuple[float, float]]:
    """(start, end) of each full period, between rising crossings of ``level`` (the mid level
    between the extremes by default)."""
    if level is None:
        level = (float(np.max(y)) + float(np.min(y))) / 2
    rises = _crossings(x, y, level, rising=True)
    if len(rises) < 2:
        raise DspError("fewer than one full period")
    return [(float(a), float(b)) for a, b in pairwise(rises)]


def duty_of(x: F64, y: F64, start: float, end: float, level: float) -> float:
    """Share of one period (start..end, from a rising crossing) above ``level``, in %."""
    falls = _crossings(x, y, level, rising=False)
    fall = falls[(falls > start) & (falls < end)]
    return float(fall[0] - start) / (end - start) * 100 if fall.size else 100.0


def _step(y: F64) -> float:
    """Size of the step from the first to the last value; refuses a signal that returns."""
    step = float(y[-1] - y[0])
    if abs(step) < 0.05 * float(np.ptp(y)) or step == 0:
        raise DspError(
            "no single step: the signal ends near where it starts - "
            "put a Time window around one edge"
        )
    return step


def overshoot(y: F64) -> float:
    """Step response overshoot in % of the step (from the first to the last value)."""
    step = _step(y)
    peak = float(np.max(y)) if step > 0 else float(np.min(y))
    return max(0.0, (peak - float(y[-1])) / step * 100)


def settling_time(x: F64, y: F64, band: float = 0.02) -> float:
    """Time after the start until the signal stays within ±band of the step around its end value."""
    step = abs(_step(y))
    outside = np.nonzero(np.abs(y - y[-1]) > band * step)[0]
    if not outside.size:
        return 0.0
    last = int(outside[-1])
    return float(x[min(last + 1, len(x) - 1)] - x[0])


def frequency(x: F64, y: F64, level: float | None = None) -> float:
    """Mean frequency from rising crossings of the mid level, or ``level`` (needs two full
    periods)."""
    mid = (float(np.max(y)) + float(np.min(y))) / 2 if level is None else level
    edges = _crossings(x, y, mid, rising=True)
    if len(edges) < 3:
        raise DspError("fewer than two full periods")
    return float((len(edges) - 1) / (edges[-1] - edges[0]))


def duty_cycle(x: F64, y: F64, level: float | None = None) -> float:
    """Share of each period above the mid level (or ``level``), in %, over whole periods."""
    mid = (float(np.max(y)) + float(np.min(y))) / 2 if level is None else level
    rises = _crossings(x, y, mid, rising=True)
    falls = _crossings(x, y, mid, rising=False)
    if len(rises) < 2:
        raise DspError("fewer than one full period")
    high = 0.0
    for start, stop in pairwise(rises):
        fall = falls[(falls > start) & (falls < stop)]
        if fall.size:
            high += float(fall[0] - start)
    return high / float(rises[-1] - rises[0]) * 100


def thd(x: F64, y: F64, harmonics: int = 10) -> tuple[float, float]:
    """Total harmonic distortion in % and the fundamental frequency (largest non-DC line)."""
    freqs, values = spectrum(x, y, "blackman-harris")
    mag = np.abs(values)
    if len(mag) < 8:
        raise DspError("the signal is too short")
    k = int(np.argmax(mag[2:])) + 2
    fundamental = float(mag[k])
    if fundamental == 0:
        raise DspError("no fundamental")
    width = 3  # the Blackman-Harris main lobe is ±4 bins wide; sum a few bins per line

    def line(i: int) -> float:
        return float(np.sqrt(np.sum(mag[max(0, i - width) : i + width + 1] ** 2)))

    power = sum(line(k * h) ** 2 for h in range(2, harmonics + 1) if k * h + width < len(mag))
    return float(np.sqrt(power) / line(k) * 100), float(freqs[k])


def margins(f: F64, loop: C128) -> tuple[float | None, float | None]:
    """(phase margin in degrees, gain margin in dB) of a loop gain L(f); None if no crossing."""
    mag_db = 20 * np.log10(np.maximum(np.abs(loop), 1e-30))
    phase = np.degrees(np.unwrap(np.angle(loop)))
    pm = None
    cross = np.nonzero((mag_db[:-1] >= 0) & (mag_db[1:] < 0))[0]
    if cross.size:
        i = int(cross[0])
        p = float(np.interp(0.0, [mag_db[i + 1], mag_db[i]], [phase[i + 1], phase[i]]))
        pm = 180.0 + p
        pm = (pm + 180.0) % 360.0 - 180.0
    gm = None
    target = -180.0
    wrapped = (phase - target + 180.0) % 360.0 - 180.0  # 0 where the phase is -180 (mod 360)
    sign = np.nonzero((wrapped[:-1] > 0) & (wrapped[1:] <= 0))[0]
    if sign.size:
        i = int(sign[0])
        gm = -float(np.interp(0.0, [wrapped[i + 1], wrapped[i]], [mag_db[i + 1], mag_db[i]]))
    return pm, gm


def interp(xq: object, x: npt.ArrayLike, y: npt.ArrayLike) -> np.ndarray:
    """``np.interp`` for an axis in either direction: a DC sweep from 5 V down to 0 V gave
    silently wrong values (numpy needs increasing x)."""
    xs, ys = np.asarray(x), np.asarray(y)
    if len(xs) > 1 and xs[0] > xs[-1]:
        xs, ys = xs[::-1], ys[::-1]
    return np.asarray(np.interp(xq, xs, ys))  # type: ignore[call-overload]
