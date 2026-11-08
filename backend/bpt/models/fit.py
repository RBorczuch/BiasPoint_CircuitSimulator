"""Fitting equivalent-circuit values to characteristic points (FR-CMP).

Points come from a datasheet (typed in, digitized, CSV) or a measurement: |Z|(f), phase(f),
ESR(f), C(V) or L(I). The free values are fitted in log space (they span decades and stay
positive) by Levenberg-Marquardt with a numeric Jacobian. Two ways to compute the model:

* a template: impedance from the formula, fast (``fit_template``);
* any sheet with two ports: by simulation (``fit_sheet``); every Jacobian column is one more
  copy of the part in the same AC run, so one iteration costs one or two runs.

Values nothing in the data depends on (a leakage resistance seen through no point) are held
near their starting value by a weak pull, instead of drifting off.
"""

import math
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

import numpy as np
from pydantic import BaseModel

from bpt.analysis.spec import AcAnalysis
from bpt.document.model import Characteristic, Project
from bpt.models import bench
from bpt.models import templates as tpl
from bpt.units import InvalidValueError, parse_value, to_spice

TWO_PI = 2 * math.pi
KINDS = ("|Z|(f)", "phase(f)", "ESR(f)", "C(V)", "L(I)")
UNITS = {"|Z|(f)": ("Hz", "Ω"), "phase(f)": ("Hz", "°"), "ESR(f)": ("Hz", "Ω"),
         "C(V)": ("V", "F"), "L(I)": ("A", "H")}  # fmt: skip
_PULL = 1e-3  # weight of the pull towards the starting values (log units)


class FitError(ValueError):
    """The points cannot be fitted."""


class Curve(BaseModel):
    name: str
    x: list[float]
    measured: list[float]
    model: list[float]
    error: float  # RMS: percent, or degrees for the phase
    max_error: float = 0.0  # the worst point, same unit
    residuals: list[float] = []  # per point: percent (or degrees), model - measured


class FitResult(BaseModel):
    values: dict[str, str]  # the fitted form / parameter values
    curves: list[Curve]
    error: float  # worst RMS error of the magnitude curves, percent
    max_error: float = 0.0  # worst point of the magnitude curves, percent
    iterations: int


Bounds = dict[str, tuple[float | None, float | None]]  # value -> (min, max); None = open


# Characteristics whose x must be positive (a log axis): frequencies, a diode's forward current.
_POSITIVE_X = ("|Z|(f)", "phase(f)", "ESR(f)", "VF(IF)", "Ratio(f)", "|Zin|(f)", "Aol(f)",
               "h21(f)")  # fmt: skip


def usable(chars: list[Characteristic], kinds: tuple[str, ...] = KINDS) -> list[Characteristic]:
    """The points that can be fitted (finite, positive where the kind needs it), sorted."""
    out = []
    for c in chars:
        if c.name not in kinds:
            raise FitError(f"unknown characteristic {c.name!r} (one of {', '.join(kinds)})")
        pts = [(x, y) for x, y in c.points if math.isfinite(x) and math.isfinite(y)]
        if c.name not in ("phase(f)", "Aol(f)"):  # (the others are magnitudes)
            pts = [(x, y) for x, y in pts if y > 0]
        if c.name in _POSITIVE_X:
            pts = [(x, y) for x, y in pts if x > 0]
        weight = dict(zip(map(tuple, c.points), c.weights, strict=False))
        if pts:
            pts = sorted(pts)
            weights = [max(float(weight.get(p, 1.0)), 0.0) for p in pts] if c.weights else []
            out.append(c.model_copy(update={"points": pts, "weights": weights}))
    if not out:
        raise FitError("no points to fit")
    return out


def _weights(char: Characteristic) -> np.ndarray:
    return np.array(char.weights) if char.weights else np.ones(len(char.points))


def _residuals(char: Characteristic, model: np.ndarray) -> np.ndarray:
    """What the fit minimizes: log ratios (relative errors), or errors over the largest value
    ("lin"), or radians for a phase; each times the point's weight."""
    y = np.array([p[1] for p in char.points])
    if char.name == "phase(f)":
        r = np.radians(model - y)
    elif char.name == "Aol(f)":  # decibels: as the log ratio of the gains
        r = (model - y) * math.log(10) / 20
    elif char.scale == "lin":
        r = (model - y) / max(float(np.max(np.abs(y))), 1e-300)
    else:
        r = np.log(np.maximum(model, 1e-300) / y)
    return np.asarray(r * np.sqrt(_weights(char)))


def _point_errors(char: Characteristic, model: np.ndarray) -> np.ndarray:
    """Per point: degrees for a phase, else percent (of the point, or of the largest value)."""
    y = np.array([p[1] for p in char.points])
    if char.name == "phase(f)":
        return np.asarray(model - y)
    if char.name == "Aol(f)":  # the error of the gain itself, in percent like the magnitudes
        return np.asarray(100 * (10 ** ((model - y) / 20) - 1))
    if char.scale == "lin":
        return np.asarray(100 * (model - y) / max(float(np.max(np.abs(y))), 1e-300))
    return np.asarray(100 * (model / y - 1))


def _error(char: Characteristic, model: np.ndarray) -> float:
    errors = _point_errors(char, model)[_weights(char) > 0]
    return float(np.sqrt(np.mean(errors**2))) if len(errors) else 0.0


@dataclass
class Problem:
    """``evaluate`` maps parameter vectors (log values) to model curves, one list per vector."""

    chars: list[Characteristic]
    evaluate: Callable[[list[np.ndarray]], list[list[np.ndarray]]]
    start: np.ndarray
    low: np.ndarray | None = None  # log bounds of each value (-inf / +inf: open)
    high: np.ndarray | None = None

    def residuals(self, models: list[np.ndarray], p: np.ndarray) -> np.ndarray:
        parts = [_residuals(c, m) for c, m in zip(self.chars, models, strict=True)]
        return np.concatenate([*parts, _PULL * (p - self.start)])

    def clip(self, p: np.ndarray) -> np.ndarray:
        if self.low is None or self.high is None:
            return p
        return np.asarray(np.clip(p, self.low, self.high))


_RESTART_RMS = 0.05  # a fit worse than about 5 % RMS tries other starting points
_RESTART_MAX = 6  # values; more would make too many starts


def levenberg_marquardt(problem: Problem, max_iter: int = 60, restarts: bool = True
                        ) -> tuple[np.ndarray, int]:  # fmt: skip
    """Least squares in log space; a step leaving the bounds is cut back to them. When the
    result stays poor, the descent is repeated from other starts (each value ten times larger
    and smaller, then all of them) and the best result is kept: a model like Gummel-Poon has
    local minima a single start can fall into."""
    p, iterations, cost = _descend(problem, problem.start, max_iter)
    n = len(p)
    data = max(len(problem.residuals(problem.evaluate([p])[0], p)) - n, 1)
    if not restarts or n > _RESTART_MAX or math.sqrt(cost / data) <= _RESTART_RMS:
        return p, iterations
    shifts = [s * math.log(10) * np.eye(n)[k] for k in range(n) for s in (1, -1)]
    shifts += [np.full(n, math.log(10)), np.full(n, -math.log(10))] if n > 1 else []
    for shift in shifts:
        q, more, c = _descend(problem, problem.start + shift, max_iter)
        iterations += more
        if c < cost:
            p, cost = q, c
            if math.sqrt(cost / data) <= _RESTART_RMS:
                break
    return p, iterations


def _descend(problem: Problem, begin: np.ndarray, max_iter: int) -> tuple[np.ndarray, int, float]:
    """One Levenberg-Marquardt descent from ``begin``: the values, iterations and final cost."""
    p = problem.clip(begin.copy())
    n = len(p)
    step = 1e-4
    lam = 1e-2
    (models,) = problem.evaluate([p])
    r = problem.residuals(models, p)
    cost = float(r @ r)
    iterations = 0
    for iterations in range(1, max_iter + 1):  # noqa: B007 - reported
        shifted = [p + step * np.eye(n)[k] for k in range(n)]
        columns = problem.evaluate(shifted)
        jac = np.column_stack([
            (problem.residuals(m, q) - r) / step for m, q in zip(columns, shifted, strict=True)
        ])  # fmt: skip
        a, g = jac.T @ jac, jac.T @ r
        improved = done = False
        for _ in range(8):
            try:
                dp = np.linalg.solve(a + lam * np.diag(np.diag(a) + 1e-12), -g)
            except np.linalg.LinAlgError:
                lam *= 10
                continue
            dp = np.clip(dp, -3, 3)  # at most a factor of 20 per step
            dp = problem.clip(p + dp) - p
            (trial,) = problem.evaluate([p + dp])
            r_new = problem.residuals(trial, p + dp)
            cost_new = float(r_new @ r_new)
            if math.isfinite(cost_new) and cost_new < cost:
                done = cost - cost_new < 1e-10 * max(cost, 1e-30) or np.max(np.abs(dp)) < 1e-7
                p, r, cost, lam = p + dp, r_new, cost_new, max(lam / 3, 1e-9)
                improved = True
                break
            lam *= 4
        if not improved or done:
            break
    return p, iterations, cost


def curves_of(chars: list[Characteristic], models: list[np.ndarray]
            ) -> tuple[list[Curve], float, float]:  # fmt: skip
    """The verification: each curve with its points, model values, residuals and errors;
    the worst RMS and worst point of the magnitude curves."""
    curves = []
    for c, m in zip(chars, models, strict=True):
        errors = _point_errors(c, m)
        fitted = errors[_weights(c) > 0]
        curves.append(Curve(
            name=c.name, x=[p[0] for p in c.points], measured=[p[1] for p in c.points],
            model=[float(v) for v in m], error=_error(c, m),
            max_error=float(np.max(np.abs(fitted))) if len(fitted) else 0.0,
            residuals=[float(e) for e in errors],
        ))  # fmt: skip
    magnitudes = [c for c in curves if c.name != "phase(f)"]
    return (curves, max((c.error for c in magnitudes), default=0.0),
            max((c.max_error for c in magnitudes), default=0.0))  # fmt: skip


def log_bounds(names: list[str], bounds: Bounds | None) -> tuple[np.ndarray, np.ndarray]:
    low = np.full(len(names), -np.inf)
    high = np.full(len(names), np.inf)
    for k, name in enumerate(names):
        lo, hi = (bounds or {}).get(name, (None, None))
        if lo is not None and lo > 0:
            low[k] = math.log(lo)
        if hi is not None and hi > 0:
            high[k] = math.log(hi)
        if low[k] > high[k]:
            raise FitError(f"{name}: the minimum is above the maximum")
    return low, high


# -- templates --------------------------------------------------------------------------------


def _template_curves(template: tpl.TemplateDef, values: tpl.Values,
                     chars: list[Characteristic]) -> list[np.ndarray]:  # fmt: skip
    out = []
    for c in chars:
        x = np.array([p[0] for p in c.points])
        match c.name:
            case "C(V)":
                out.append(tpl.capacitance(template, values, x))
            case "L(I)":
                out.append(tpl.inductance(template, values, x))
            case _:
                z = tpl.impedance(template, values, x)
                out.append({"|Z|(f)": np.abs(z), "ESR(f)": z.real,
                            "phase(f)": np.degrees(np.angle(z))}[c.name])  # fmt: skip
    return out


def _at(char: Characteristic | None, pick: Callable[[list[tuple[float, float]]], float | None]
        ) -> float | None:  # fmt: skip
    return pick(char.points) if char is not None and char.points else None


def _guesses(template: tpl.TemplateDef, chars: list[Characteristic]) -> dict[str, float]:
    """Starting values read off the points (a fit from a poor start can end in a wrong dip)."""
    by = {c.name: c for c in chars}
    z, esr = by.get("|Z|(f)"), by.get("ESR(f)")
    out: dict[str, float] = {}
    if template.kind == "capacitor":
        if z is not None:
            f0, z0 = z.points[0]
            out["Cnom"] = 1 / (TWO_PI * f0 * z0)
            fmin, zmin = min(z.points, key=lambda p: p[1])
            out["esr"] = zmin
            f1, z1 = z.points[-1]
            if f1 > 2 * fmin:
                out["esl"] = z1 / (TWO_PI * f1)
        if esr is not None:
            out["esr"] = min(p[1] for p in esr.points)
            if template.name == "electrolytic":
                out["rlf"] = max(esr.points[0][1] - out["esr"], out["esr"] * 0.1)
        if (cv := by.get("C(V)")) is not None:
            out["Cnom"] = max(p[1] for p in cv.points)
            half = [p[0] for p in cv.points if p[1] <= out["Cnom"] / 2]
            if half:
                out["vhalf"] = half[0]
    elif template.kind == "inductor":
        if z is not None:
            f0, z0 = z.points[0]
            out["Lnom"] = z0 / (TWO_PI * f0)
            fmax, zmax = max(z.points, key=lambda p: p[1])
            if fmax < z.points[-1][0]:
                out["srf"] = fmax
                out["rp"] = zmax
        if (li := by.get("L(I)")) is not None:
            out["Lnom"] = max(p[1] for p in li.points)
            half = [p[0] for p in li.points if p[1] <= out["Lnom"] / 2]
            if half:
                out["isat"] = half[0]
    elif template.kind == "resistor" and z is not None:
        out["Rnom"] = z.points[0][1]
    return out


def fit_template(
    name: str,
    form: dict[str, str],
    free: list[str],
    chars: list[Characteristic],
    bounds: Bounds | None = None,
) -> FitResult:
    """Fit the ``free`` fields of template ``name`` (the rest stay as in ``form``), each within
    ``bounds`` when given."""
    template = tpl.get(name)
    chars = usable(chars)
    known = {f.key for f in template.fields}
    if unknown := [k for k in free if k not in known]:
        raise FitError(f"{template.label} has no field {', '.join(unknown)}")
    if not free:
        raise FitError("choose the values to fit")
    fixed = tpl.numbers(template, {k: v for k, v in form.items() if k not in free}, partial=True)
    guesses = _guesses(template, chars)
    start = []
    for key in free:
        text = form.get(key, "").strip()
        try:
            value = parse_value(text) if text else None
        except InvalidValueError:
            value = None
        if value is None or value <= 0 or (key in guesses and not text):
            value = guesses.get(key) or parse_value(template.field(key).default or "1")
        start.append(math.log(value))
    if "srf" in free:  # Cp is then derived from the SRF
        fixed.pop("cp", None)

    def values_of(p: np.ndarray) -> tpl.Values:
        return template.prepare({**fixed, **dict(zip(free, np.exp(p), strict=True))})

    def evaluate(vectors: list[np.ndarray]) -> list[list[np.ndarray]]:
        return [_template_curves(template, values_of(p), chars) for p in vectors]

    problem = Problem(chars, evaluate, np.array(start), *log_bounds(free, bounds))
    p, iterations = levenberg_marquardt(problem)
    (models,) = evaluate([p])
    curves, error, worst = curves_of(chars, models)
    fitted = {k: tpl.spice_text(float(v)) for k, v in zip(free, np.exp(p), strict=True)}
    values = {**{k: v for k, v in form.items() if v.strip()}, **fitted}
    if "srf" in free:
        values.pop("cp", None)
    return FitResult(values=values, curves=curves, error=error, max_error=worst,
                     iterations=iterations)  # fmt: skip


# -- any sheet, by simulation -----------------------------------------------------------------


def _interp_loglog(x: np.ndarray, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
    return np.asarray(np.exp(np.interp(np.log(x), np.log(xs), np.log(np.maximum(ys, 1e-300)))))


def fit_sheet(
    run: bench.Run,
    base: Project,
    top: str,
    start: dict[str, str],
    chars: list[Characteristic],
    drive: Literal["v", "i"] = "v",
    low_frequency: float = 1e3,
    bounds: Bounds | None = None,
) -> FitResult:
    """Fit sheet parameters ``start`` (name -> starting value) of ``top`` by simulation."""
    chars = usable(chars)
    if not start:
        raise FitError("choose the parameters to fit")
    names = list(start)
    try:
        p0 = np.array([math.log(parse_value(start[n])) for n in names])
    except (InvalidValueError, ValueError) as exc:
        raise FitError(f"starting values must be positive numbers: {exc}") from exc
    sweep = [c for c in chars if c.name.endswith("(f)")]
    if sweep:
        fmin = min(c.points[0][0] for c in sweep)
        fmax = max(c.points[-1][0] for c in sweep)
        grid = bench.frequency_grid(fmin / 1.01, fmax * 1.01, 40)

    def evaluate(vectors: list[np.ndarray]) -> list[list[np.ndarray]]:
        params = [{n: to_spice(float(v)) for n, v in zip(names, np.exp(p), strict=True)}
                  for p in vectors]  # fmt: skip
        out: list[list[np.ndarray]] = [[] for _ in vectors]
        if sweep:
            copies = [bench.Copy(ps, drive) for ps in params]
            freqs, zs = bench.impedance_sweep(run, base, top, grid, copies)
        for c in chars:
            x = np.array([pt[0] for pt in c.points])
            if c.name.endswith("(f)"):
                for k, z in enumerate(zs):
                    match c.name:
                        case "|Z|(f)":
                            out[k].append(_interp_loglog(x, freqs, np.abs(z)))
                        case "ESR(f)":
                            out[k].append(_interp_loglog(x, freqs, z.real))
                        case _:
                            out[k].append(np.interp(np.log(x), np.log(freqs),
                                                    np.degrees(np.angle(z))))  # fmt: skip
                continue
            copies = [bench.Copy(ps, "v" if c.name == "C(V)" else "i", float(b))
                      for ps in params for b in x]  # fmt: skip
            f_text = to_spice(low_frequency)
            analysis = AcAnalysis(variation="lin", points=1, fstart=f_text, fstop=f_text)
            _f, zs_bias = bench.impedance_sweep(run, base, top, analysis, copies)
            w = TWO_PI * low_frequency
            values = np.array([(-1 / (w * z[0].imag)) if c.name == "C(V)" else z[0].imag / w
                               for z in zs_bias])  # fmt: skip
            for k in range(len(vectors)):
                out[k].append(values[k * len(x) : (k + 1) * len(x)])
        return out

    problem = Problem(chars, evaluate, p0, *log_bounds(names, bounds))
    p, iterations = levenberg_marquardt(problem, max_iter=25, restarts=False)  # simulated
    (models,) = evaluate([p])
    curves, error, worst = curves_of(chars, models)
    values = {n: tpl.spice_text(float(v)) for n, v in zip(names, np.exp(p), strict=True)}
    return FitResult(values=values, curves=curves, error=error, max_error=worst,
                     iterations=iterations)  # fmt: skip
