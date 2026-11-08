"""Building-block nodes (graf.md §15.1, G1): Number, Complex parts, Calculus, Lookup and the
Equation view. Registered in the catalogue on import (see the end of ``catalog``)."""

import re
from dataclasses import replace
from typing import Any

import numpy as np

from bpt.units import InvalidValueError, parse_quantity

from . import dsp
from .catalog import (
    Context,
    Inputs,
    NodeError,
    Param,
    Params,
    Socket,
    _expr,
    _time_signal,
    node,
)
from .values import FamilyValue, ScalarValue, SignalValue, TableValue, Value

_UNIT_AT_END = re.compile(r"^(.*?)\s*(V|A|W|Ω|Hz|F|H|dB|s|°|%)?$")


def _quantity(text: str, what: str, unit: str = "") -> float:
    try:
        return parse_quantity(text, unit)
    except InvalidValueError as exc:
        raise NodeError(f"{what}: {exc}") from exc


@node(
    "math/number",
    "Number",
    "Input",
    'A constant with its unit ("50 Ω", "12 V", "4k7"): a value to use in several places, or '
    "to set a parameter of another node (take the parameter from an input).",
    outputs=[Socket(name="value", type="scalar", label="value")],
    params=[
        Param(name="value", kind="text", label="Value", default="1", placeholder="12 V"),
        Param(name="name", kind="text", label="Name", default="", placeholder="Vin"),
    ],
)
def _number(ctx: Context, inputs: Inputs, params: Params) -> dict[str, Value]:
    text = re.sub(r"(?i)ohms?$", "Ω", str(params["value"]).strip())
    match = _UNIT_AT_END.match(text)
    unit = (match[2] or "") if match else ""
    value = _quantity(text, "value", unit)
    name = str(params.get("name") or "").strip() or str(params["value"]).strip()
    return {"value": ScalarValue(name=name, value=value, unit=unit)}


@node(
    "math/complex",
    "Complex parts",
    "Math",
    "Parts of a (complex, AC) signal: real and imaginary part, magnitude, dB, phase in degrees "
    "and the phase without 360° jumps.",
    inputs=[Socket(name="signal", type="signal", label="signal")],
    outputs=[
        Socket(name="re", type="signal", label="re"),
        Socket(name="im", type="signal", label="im"),
        Socket(name="mag", type="signal", label="mag"),
        Socket(name="db", type="signal", label="dB"),
        Socket(name="phase", type="signal", label="phase"),
        Socket(name="uphase", type="signal", label="phase, unwrapped"),
    ],
)
def _complex_parts(ctx: Context, inputs: Inputs, params: Params) -> dict[str, Value]:
    signal: SignalValue = inputs["signal"]
    y = np.asarray(signal.y, dtype=complex)
    angle = np.angle(y)

    def part(name: str, values: Any, unit: str) -> SignalValue:
        return replace(
            signal, name=f"{name}({signal.name})", y=np.asarray(values, dtype=float), unit=unit
        )

    return {
        "re": part("re", y.real, signal.unit),
        "im": part("im", y.imag, signal.unit),
        "mag": part("mag", np.abs(y), signal.unit),
        "db": part("dB", 20 * np.log10(np.maximum(np.abs(y), 1e-15)), "dB"),
        "phase": part("ph", np.degrees(angle), "°"),
        "uphase": part("uph", np.degrees(np.unwrap(angle)), "°"),
    }


_CALCULUS = ["derivative", "integral", "integral in window", "moving average", "envelope", "peaks"]


@node(
    "math/calculus",
    "Calculus",
    "Math",
    "Derivative, running integral (and its total), the integral between two x values, a moving "
    "average over a width, the envelope (Hilbert) and the peaks above a level (a table, and "
    "their count).",
    inputs=[Socket(name="signal", type="signal", label="signal")],
    outputs=[
        Socket(name="signal", type="signal", label="signal"),
        Socket(name="value", type="scalar", label="value"),
        Socket(name="table", type="table", label="table"),
    ],
    params=[
        Param(name="mode", kind="choice", label="Mode", default="derivative", options=_CALCULUS),
        Param(name="start", kind="quantity", label="From x", default="", placeholder="start"),
        Param(name="stop", kind="quantity", label="To x", default="", placeholder="end"),
        Param(
            name="width", kind="quantity", label="Width", default="", placeholder="moving average"
        ),
        Param(name="level", kind="quantity", label="Level", default="", placeholder="peaks: mid"),
    ],
)
def _calculus(ctx: Context, inputs: Inputs, params: Params) -> dict[str, Value]:
    signal: SignalValue = inputs["signal"]
    mode = str(params["mode"])
    x, y = (
        _time_signal(signal, mode)
        if mode in ("envelope", "peaks")
        else (np.asarray(signal.x, dtype=float), np.asarray(signal.y))
    )
    if len(x) < 2:
        raise NodeError("the signal needs two points or more")
    xu, yu = signal.x_unit, signal.unit
    start, stop = str(params.get("start") or "").strip(), str(params.get("stop") or "").strip()
    if start or stop or mode == "integral in window":
        lo = _quantity(start, "from", xu) if start else float(x[0])
        hi = _quantity(stop, "to", xu) if stop else float(x[-1])
        keep = (x >= min(lo, hi)) & (x <= max(lo, hi))
        if keep.sum() < 2:
            raise NodeError("fewer than two points in the window")
        x, y = x[keep], y[keep]
    if mode == "derivative":
        d = np.gradient(y, x)
        return {
            "signal": replace(
                signal,
                name=f"d/d{signal.x_name}({signal.name})",
                x=x,
                y=d,
                unit=f"{yu}/{xu}" if xu else yu,
            )
        }
    if mode in ("integral", "integral in window"):
        running = np.concatenate([[0], np.cumsum((y[1:] + y[:-1]) / 2 * np.diff(x))])
        unit = f"{yu}·{xu}" if xu else yu
        total = running[-1]
        value = ScalarValue(
            name=f"∫{signal.name}",
            value=float(abs(total)) if np.iscomplexobj(total) else float(total),
            unit=unit,
        )
        return {
            "signal": replace(signal, name=f"∫{signal.name}", x=x, y=running, unit=unit),
            "value": value,
        }
    if mode == "moving average":
        width = _quantity(str(params.get("width") or ""), "width", xu)
        if width <= 0:
            raise NodeError("width: a positive length of x")
        running = np.concatenate([[0], np.cumsum((y[1:] + y[:-1]) / 2 * np.diff(x))])
        left = np.clip(x - width / 2, x[0], x[-1])
        right = np.clip(x + width / 2, x[0], x[-1])
        span = np.maximum(right - left, 1e-300)
        smooth = (dsp.interp(right, x, running) - dsp.interp(left, x, running)) / span
        return {"signal": replace(signal, name=f"avg({signal.name})", x=x, y=smooth)}
    if mode == "envelope":
        xs, ys = dsp.uniform(x, y)
        spectrum = np.fft.fft(ys - np.mean(ys))
        n = len(ys)
        h = np.zeros(n)
        h[0] = 1
        if n % 2 == 0:
            h[n // 2] = 1
            h[1 : n // 2] = 2
        else:
            h[1 : (n + 1) // 2] = 2
        env = np.abs(np.fft.ifft(spectrum * h)) + np.mean(ys)
        return {
            "signal": replace(signal, name=f"env({signal.name})", x=x, y=dsp.interp(x, xs, env))
        }
    # peaks: local maxima above the level (the middle between the extremes unless given)
    text = str(params.get("level") or "").strip()
    level = _quantity(text, "level", yu) if text else (float(np.max(y)) + float(np.min(y))) / 2
    inner = (y[1:-1] > y[:-2]) & (y[1:-1] >= y[2:]) & (y[1:-1] > level)
    idx = np.nonzero(inner)[0] + 1
    rows: list[list[float | str]] = [[float(x[i]), float(y[i])] for i in idx]
    table = TableValue(
        name=f"peaks({signal.name})",
        columns=[signal.x_name, signal.name],
        units=[xu, yu],
        rows=rows,
    )
    count = ScalarValue(name=f"peaks({signal.name})", value=float(len(idx)))
    return {"table": table, "value": count}


@node(
    "math/lookup",
    "Lookup",
    "Math",
    "Reads a signal or a table: y at an x, the x where y reaches a level (first, last or each "
    "crossing: a family), or a value of one table column at x of another (interpolated). x and "
    "the level can come from inputs (take the parameter from an input).",
    inputs=[
        Socket(name="signal", type="signal", label="signal", optional=True),
        Socket(name="table", type="table", label="table", optional=True),
    ],
    outputs=[Socket(name="value", type="scalar", label="value")],
    params=[
        Param(
            name="mode", kind="choice", label="Find", default="y at x", options=["y at x", "x at y"]
        ),
        Param(name="x", kind="quantity", label="x", default="", placeholder="y at x"),
        Param(name="y", kind="quantity", label="level y", default="", placeholder="x at y"),
        Param(
            name="which",
            kind="choice",
            label="Crossing",
            default="first",
            options=["first", "last", "all"],
        ),
        Param(name="columns", kind="text", label="Columns", default="", placeholder="table: x, y"),
    ],
)
def _lookup(ctx: Context, inputs: Inputs, params: Params) -> dict[str, Value]:
    signal: SignalValue | None = inputs.get("signal")
    table: TableValue | None = inputs.get("table")
    if signal is None and table is None:
        raise NodeError("connect a signal or a table")
    if signal is None:
        assert table is not None
        signal = _column_signal(table, str(params.get("columns") or ""))
    x = np.asarray(signal.x, dtype=float)
    mode = str(params["mode"])
    if mode == "y at x":
        at = _quantity(str(params.get("x") or ""), "x", signal.x_unit)
        if not x[0] <= at <= x[-1] and not x[-1] <= at <= x[0]:
            raise NodeError(f"x is outside the signal ({x[0]:g} … {x[-1]:g} {signal.x_unit})")
        y = np.asarray(signal.y)
        name = f"{signal.name} at {params['x']}"
        if np.iscomplexobj(y):
            v = complex(dsp.interp(at, x, y.real) + 1j * dsp.interp(at, x, y.imag))
            return {
                "value": ScalarValue(
                    name=name,
                    value=abs(v),
                    unit=signal.unit,
                    phase_deg=float(np.degrees(np.angle(v))),
                )
            }
        return {
            "value": ScalarValue(name=name, value=float(dsp.interp(at, x, y)), unit=signal.unit)
        }
    level = _quantity(str(params.get("y") or ""), "level y", signal.unit)
    y = np.abs(signal.y) if np.iscomplexobj(signal.y) else np.asarray(signal.y, dtype=float)
    above = y >= level
    idx = np.nonzero(above[:-1] != above[1:])[0]
    if not idx.size:
        raise NodeError(f"the signal never reaches {params['y']}")
    x0, x1, y0, y1 = x[idx], x[idx + 1], y[idx], y[idx + 1]
    with np.errstate(divide="ignore", invalid="ignore"):
        cross = np.where(y1 != y0, x0 + (level - y0) * (x1 - x0) / (y1 - y0), x0)
    name = f"{signal.x_name} at {signal.name} = {params['y']}"
    which = str(params.get("which") or "first")
    if which == "all":
        items: list[Value] = [
            ScalarValue(name=name, value=float(c), unit=signal.x_unit) for c in cross
        ]
        return {
            "value": FamilyValue(
                param="crossing", values=[str(k + 1) for k in range(len(cross))], items=items
            )
        }
    c = cross[0] if which == "first" else cross[-1]
    return {"value": ScalarValue(name=name, value=float(c), unit=signal.x_unit)}


def _column_signal(table: TableValue, columns: str) -> SignalValue:
    """Two columns of a table as y against x (the first two by default)."""
    names = [c.strip() for c in columns.split(",") if c.strip()] or table.columns[:2]
    if len(names) != 2 or any(n not in table.columns for n in names):
        raise NodeError(f"columns: two of {', '.join(table.columns)} (x, y)")
    try:
        xs = np.array([float(v) for v in table.column(names[0])])
        ys = np.array([float(v) for v in table.column(names[1])])
    except ValueError as exc:
        raise NodeError("the columns must hold numbers") from exc
    order = np.argsort(xs)
    unit = {c: u for c, u in zip(table.columns, table.units, strict=True)}
    return SignalValue(
        name=names[1],
        x=xs[order],
        y=ys[order],
        x_name=names[0],
        x_unit=unit[names[0]],
        unit=unit[names[1]],
    )


@node(
    "view/equation",
    "Equation",
    "View",
    "A formula of the numbers connected to a, b, c, d shown with the values put in and the "
    "result (like a worked example): P = a*b = 2 V * 1 mA = 2 mW. The result is an output too.",
    inputs=[Socket(name=v, type="scalar", label=v, optional=True) for v in ("a", "b", "c", "d")],
    outputs=[Socket(name="value", type="scalar", label="result")],
    params=[
        Param(name="expr", kind="text", label="Formula", default="a*b", placeholder="a*b"),
        Param(name="unit", kind="text", label="Unit", default="", placeholder="auto"),
        Param(name="name", kind="text", label="Name", default="", placeholder="P"),
    ],
    view="equation",
    families=False,
)
def _equation(ctx: Context, inputs: Inputs, params: Params) -> dict[str, Value]:
    result = _expr(ctx, inputs, params)["out"]
    if not isinstance(result, ScalarValue):
        raise NodeError("an Equation works with numbers; use Expression for signals")
    return {"value": result}
