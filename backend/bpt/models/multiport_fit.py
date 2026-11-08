"""Fitting a transformer or an op-amp to datasheet points, by simulation of its own benches.

The points are compared with the curves of its card (``multiport_card``): the turns ratio and the
primary's impedance with the secondary open, the open-loop gain in dB. Each step of the fit is one
simulation per value being fitted, so a fit takes seconds: fewer iterations than the formulas'.
"""

import math

import numpy as np

from bpt.document.model import Characteristic, Project
from bpt.library.blocks import ports
from bpt.models import bench
from bpt.models import templates as tpl
from bpt.models.fit import (
    Bounds,
    FitError,
    FitResult,
    Problem,
    curves_of,
    levenberg_marquardt,
    log_bounds,
    usable,
)
from bpt.models.multiport_card import Value, family, multiport_curves
from bpt.units import InvalidValueError, parse_value, to_spice

KINDS = {"transformer": ("Ratio(f)", "|Zin|(f)"), "opamp": ("Aol(f)",), "hybrid": ("h21(f)",)}
UNITS = {"Ratio(f)": ("Hz", "V/V"), "|Zin|(f)": ("Hz", "Ω"), "Aol(f)": ("Hz", "dB"),
         "h21(f)": ("Hz", "")}  # fmt: skip


def _reader(params: dict[str, str]) -> Value:
    def value(key: str) -> float | None:
        try:
            return parse_value(params[key])
        except (KeyError, InvalidValueError):
            return None

    return value


def is_multiport(base: Project, top: str, kind: str) -> bool:
    sheet = next((s for s in base.sheets if s.name == top), None)
    return sheet is not None and family(kind, [name for name, _side in ports(sheet)]) is not None


def fit_multiport(run: bench.Run, base: Project, top: str, kind: str, form: dict[str, str],
                  free: list[str], chars: list[Characteristic],
                  bounds: Bounds | None = None) -> FitResult:  # fmt: skip
    """The ``free`` values of the part on sheet ``top`` fitted to its characteristic points."""
    sheet = next(s for s in base.sheets if s.name == top)
    names = [name for name, _side in ports(sheet)]
    which = family(kind, names)
    if which is None:
        raise FitError("this part has no curves to fit")
    chars = usable(chars, KINDS[which])
    if not free:
        raise FitError("choose the values to fit")
    try:
        start = {k: parse_value(form[k]) for k in free}
    except KeyError as exc:
        raise FitError(f"give a starting value for {exc.args[0]}") from exc
    except InvalidValueError as exc:
        raise FitError(f"starting values must be numbers: {exc}") from exc
    if zero := [k for k, v in start.items() if v <= 0]:
        raise FitError(f"give {', '.join(zero)} a starting value above 0")
    p0 = np.array([math.log(start[k]) for k in free])
    given = {k: v for k, v in form.items() if v.strip()}

    def evaluate(vectors: list[np.ndarray]) -> list[list[np.ndarray]]:
        out: list[list[np.ndarray]] = []
        for vector in vectors:
            params = given | {
                k: to_spice(float(v)) for k, v in zip(free, np.exp(vector), strict=True)
            }

            curves = (
                multiport_curves(run, base, top, kind, names, params, _reader(params), full=False)
                or []
            )
            models = []
            for c in chars:
                # (of |Zin|(f), the secondary open: the first)
                curve = next((m for m in curves if m.name == c.name), None)
                if curve is None:
                    raise FitError(f"this part has no {c.name} curve")
                x = np.array([pt[0] for pt in c.points])
                values = np.interp(np.log(x), np.log(curve.x), curve.y)
                models.append(np.asarray(values))
            out.append(models)
        return out

    problem = Problem(chars, evaluate, p0, *log_bounds(free, bounds))
    p, iterations = levenberg_marquardt(problem, max_iter=12, restarts=False)
    (models,) = evaluate([p])
    curves, error, worst = curves_of(chars, models)
    fitted = {k: tpl.spice_text(float(v)) for k, v in zip(free, np.exp(p), strict=True)}
    return FitResult(values=given | fitted, curves=curves, error=error, max_error=worst,
                     iterations=iterations)  # fmt: skip
