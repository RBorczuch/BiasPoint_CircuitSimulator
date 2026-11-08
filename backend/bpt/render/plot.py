"""Headless plots of simulation results (SVG): what an AI agent sees without the GUI open.

Transient and DC sweeps: signals against the x axis, decimated to min/max columns so long
runs draw fast. AC: magnitude in dB and phase in degrees on a logarithmic frequency axis.
"""

import math
from html import escape

import numpy as np

from bpt.results.decimate import decimate
from bpt.results.store import RunReader
from bpt.units import format_value

W, H = 1000, 560
LEFT, RIGHT, TOP, BOTTOM = 86, 20, 30, 50
COLORS = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#0891b2", "#db2777", "#4b5563"]
PALETTE = {
    "light": {"bg": "#ffffff", "grid": "#e5e7eb", "axis": "#6b7280", "text": "#111827"},
    "dark": {"bg": "#111318", "grid": "#2a2f3a", "axis": "#9ca3af", "text": "#e5e7eb"},
}
MAX_SIGNALS = 8


class PlotError(ValueError):
    pass


def nice_ticks(lo: float, hi: float, count: int = 6) -> list[float]:
    if not math.isfinite(lo) or not math.isfinite(hi):
        return []
    if hi <= lo:
        hi = lo + (abs(lo) or 1.0)
    raw = (hi - lo) / count
    magnitude = 10 ** math.floor(math.log10(raw))
    step = next(m * magnitude for m in (1, 2, 2.5, 5, 10) if m * magnitude >= raw)
    first = math.ceil(lo / step) * step
    return [first + i * step for i in range(int((hi - first) / step + 1e-9) + 1)]


def _default_signals(run: RunReader) -> list[str]:
    names = [s.name for s in run.meta.signals if s.name != run.meta.scale]
    voltages = [n for n in names if n.upper().startswith("V(")]
    return (voltages or names)[:4]


def render_plot(run: RunReader, signals: list[str] | None = None, theme: str = "light") -> str:
    """SVG of a run: ``signals`` (default: the first voltages) against its x axis."""
    scale = run.meta.scale
    if scale is None:
        raise PlotError("an operating point has no plot; read its values instead")
    names = signals or _default_signals(run)
    if not names:
        raise PlotError("the run has no signals to plot")
    for name in names:
        run.meta.signal(name)  # KeyError for an unknown signal
    names = names[:MAX_SIGNALS]
    x = np.real(np.asarray(run.signal(scale)))
    colors = PALETTE.get(theme, PALETTE["light"])
    is_ac = run.meta.analysis.kind == "ac"
    parts: list[str] = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" '
        f'font-family="Inter, Segoe UI, sans-serif" font-size="13">',
        f'<rect width="{W}" height="{H}" fill="{colors["bg"]}"/>',
    ]
    if is_ac:
        mid = TOP + (H - TOP - BOTTOM) // 2
        series = {n: np.asarray(run.signal(n)) for n in names}
        mags = {n: 20 * np.log10(np.maximum(np.abs(y), 1e-30)) for n, y in series.items()}
        phases = {n: np.degrees(np.unwrap(np.angle(y))) for n, y in series.items()}
        parts += _panel(x, mags, names, (TOP, mid - 18), "dB", colors, log_x=True, x_labels=False)
        parts += _panel(x, phases, names, (mid + 18, H - BOTTOM), "°", colors, log_x=True)
        x_unit = "Hz"
    else:
        series = {n: np.real(np.asarray(run.signal(n))) for n in names}
        unit = next((s.unit for s in run.meta.signals if s.name == names[0]), "")
        parts += _panel(x, series, names, (TOP, H - BOTTOM), unit, colors, log_x=False)
        x_unit = next((s.unit for s in run.meta.signals if s.name == scale), "")
    parts.append(f'<text x="{W - RIGHT}" y="{H - 10}" text-anchor="end" fill="{colors["axis"]}">'
                 f"{escape(scale)} [{escape(x_unit)}]</text>")  # fmt: skip
    for i, name in enumerate(names):  # legend
        parts.append(f'<rect x="{LEFT + 8 + i * 150}" y="{8}" width="14" height="4" '
                     f'fill="{COLORS[i % len(COLORS)]}"/>'
                     f'<text x="{LEFT + 28 + i * 150}" y="{15}" fill="{colors["text"]}">'
                     f"{escape(name)}</text>")  # fmt: skip
    parts.append("</svg>")
    return "".join(parts)


def _panel(
    x: np.ndarray,
    series: dict[str, np.ndarray],
    names: list[str],
    rows: tuple[int, int],
    unit: str,
    colors: dict[str, str],
    *,
    log_x: bool,
    x_labels: bool = True,
) -> list[str]:
    top, bottom = rows
    width = W - LEFT - RIGHT
    xs = np.log10(np.maximum(x, 1e-30)) if log_x else x
    if len(xs) > 1 and xs[0] > xs[-1]:  # a sweep run downwards
        xs, series = xs[::-1], {n: y[::-1] for n, y in series.items()}
    xs = np.ascontiguousarray(xs, dtype=float)
    series = {n: np.ascontiguousarray(y, dtype=float) for n, y in series.items()}
    x_lo, x_hi = float(xs[0]), float(xs[-1])
    if x_hi <= x_lo:
        x_hi = x_lo + 1
    columns = {n: decimate(xs, y, width) for n, y in series.items()}
    lo = min(float(np.nanmin(c.y_min)) for c in columns.values())
    hi = max(float(np.nanmax(c.y_max)) for c in columns.values())
    pad = (hi - lo) * 0.05 or abs(hi) * 0.05 or 1.0
    lo, hi = lo - pad, hi + pad

    def px(v: float) -> float:
        return LEFT + (v - x_lo) / (x_hi - x_lo) * width

    def py(v: float) -> float:
        return bottom - (v - lo) / (hi - lo) * (bottom - top)

    out = []
    for t in nice_ticks(lo, hi):
        y = py(t)
        out.append(f'<line x1="{LEFT}" x2="{W - RIGHT}" y1="{y:.1f}" y2="{y:.1f}" '
                   f'stroke="{colors["grid"]}"/>'
                   f'<text x="{LEFT - 6}" y="{y + 4:.1f}" text-anchor="end" '
                   f'fill="{colors["axis"]}">'
                   f"{escape(format_value(t, unit, 3))}</text>")  # fmt: skip
    if log_x:
        ticks = [float(d) for d in range(math.ceil(x_lo), math.floor(x_hi) + 1)]
        label = [format_value(10**d, "", 3) for d in ticks]
    else:
        ticks = nice_ticks(x_lo, x_hi, 8)
        label = [format_value(t, "", 3) for t in ticks]
    for t, text in zip(ticks, label, strict=True):
        xx = px(t)
        out.append(f'<line x1="{xx:.1f}" x2="{xx:.1f}" y1="{top}" y2="{bottom}" '
                   f'stroke="{colors["grid"]}"/>')  # fmt: skip
        if x_labels:
            out.append(f'<text x="{xx:.1f}" y="{bottom + 18}" text-anchor="middle" '
                       f'fill="{colors["axis"]}">{escape(text)}</text>')  # fmt: skip
    out.append(f'<rect x="{LEFT}" y="{top}" width="{width}" height="{bottom - top}" fill="none" '
               f'stroke="{colors["axis"]}"/>')  # fmt: skip
    for i, name in enumerate(names):
        c = columns[name]
        points = []
        for xv, a, b in zip(c.x, c.y_min, c.y_max, strict=True):
            if not (math.isfinite(a) and math.isfinite(b)):
                continue
            points.append(f"{px(float(xv)):.1f},{py(float(a)):.1f}")
            if b != a:
                points.append(f"{px(float(xv)):.1f},{py(float(b)):.1f}")
        out.append(f'<polyline points="{" ".join(points)}" fill="none" '
                   f'stroke="{COLORS[i % len(COLORS)]}" stroke-width="1.6" '
                   f'stroke-linejoin="round"/>')  # fmt: skip
    return out
