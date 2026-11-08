"""Waveform decimation for plotting: min/max per pixel column, bucketed by x.

Simulation time steps are non-uniform, so buckets are equal slices of the *x range*
(not equal sample counts); each non-empty bucket keeps its min and max, preserving peaks.
"""

from dataclasses import dataclass

import numpy as np
import numpy.typing as npt

F64 = npt.NDArray[np.float64]


@dataclass
class Decimated:
    x: F64
    y_min: F64
    y_max: F64
    raw: bool  # True when no decimation was needed (y_min == y_max)


def decimate(
    x: F64, y: F64, pixels: int, x_min: float | None = None, x_max: float | None = None
) -> Decimated:
    """``x`` must be ascending (time, frequency, sweep)."""
    lo = 0 if x_min is None else int(np.searchsorted(x, x_min, side="left"))
    hi = len(x) if x_max is None else int(np.searchsorted(x, x_max, side="right"))
    # Keep one sample beyond each edge so lines reach the plot border.
    lo, hi = max(lo - 1, 0), min(hi + 1, len(x))
    xs, ys = x[lo:hi], y[lo:hi]
    if len(xs) <= 2 * pixels or pixels <= 0:
        return Decimated(xs.copy(), ys.copy(), ys.copy(), raw=True)
    edges = np.linspace(xs[0], xs[-1], pixels + 1)
    starts = np.unique(np.searchsorted(xs, edges[:-1], side="left"))
    starts = starts[starts < len(xs)]
    return Decimated(
        x=xs[starts].copy(),
        y_min=np.minimum.reduceat(ys, starts),
        y_max=np.maximum.reduceat(ys, starts),
        raw=False,
    )
