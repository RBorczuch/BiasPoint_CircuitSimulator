"""Fitting semiconductor model parameters to datasheet points (FR-MOD-1, phase 6).

Diodes (signal, LED, Zener) from their SPICE parameters, with the formulas of the model, so the
fit is instant and needs no simulation:

* ``VF(IF)``: the forward voltage at a forward current, ``VF = N Vt ln(IF/IS + 1) + IF RS``
  (Shockley with the series resistance; explicit in IF, so the error is the voltage error the
  datasheet criterion asks about);
* ``Cj(VR)``: the junction capacitance at a reverse voltage, ``CJO / (1 + VR/VJ)^M``;
* ``VZ(IZ)``: the reverse (Zener) voltage at a reverse current in breakdown,
  ``BV + N Vt ln(IZ/IBV) + IZ RS`` (ngspice sets the breakdown so that IBV flows at BV).

The values are fitted in log space by the same Levenberg-Marquardt as the passive templates,
with the same weights, limits and verification (``bpt.models.fit``).
"""

import math

import numpy as np

from bpt.document.model import Characteristic
from bpt.models import fit
from bpt.models import templates as tpl
from bpt.units import InvalidValueError, parse_value

DIODE_KINDS = ("VF(IF)", "Cj(VR)", "VZ(IZ)")
DIODE_UNITS = {"VF(IF)": ("A", "V"), "Cj(VR)": ("V", "F"), "VZ(IZ)": ("A", "V")}
VT = 1.380649e-23 * 300.15 / 1.602176634e-19  # thermal voltage at 27 °C (ngspice's TNOM)
_DEFAULTS = {"is": 1e-14, "n": 1.0, "rs": 0.0, "cjo": 0.0, "vj": 1.0, "mj": 0.5, "bv": 1e30,
             "ibv": 1e-3}  # fmt: skip


def diode_curves(values: dict[str, float], chars: list[Characteristic]) -> list[np.ndarray]:
    out = []
    for c in chars:
        x = np.array([p[0] for p in c.points])
        if c.name == "VF(IF)":
            out.append(values["n"] * VT * np.log(x / values["is"] + 1) + x * values["rs"])
        elif c.name == "VZ(IZ)":
            knee = values["n"] * VT * np.log(x / values["ibv"])
            out.append(values["bv"] + knee + x * values["rs"])
        else:
            out.append(values["cjo"] / (1 + np.maximum(x, 0) / values["vj"]) ** values["mj"])
    return out


def _guesses(chars: list[Characteristic]) -> dict[str, float]:
    """Starting values read off the points: the slope of the low-current points gives N and
    IS, the excess voltage at the highest current RS, the lowest-voltage capacitance CJO."""
    out: dict[str, float] = {}
    by = {c.name: c for c in chars}
    if (vf := by.get("VF(IF)")) is not None and len(vf.points) >= 2:
        (i1, v1), (i2, v2) = vf.points[0], vf.points[1]
        if i2 > i1 and v2 > v1:
            n = (v2 - v1) / (VT * math.log(i2 / i1))
            out["n"] = min(max(n, 0.5), 4)
            out["is"] = i1 / math.exp(v1 / (out["n"] * VT))
            i3, v3 = vf.points[-1]
            excess = v3 - out["n"] * VT * math.log(i3 / out["is"] + 1)
            out["rs"] = max(excess / i3, 1e-3)
    if (cj := by.get("Cj(VR)")) is not None and cj.points:
        out["cjo"] = max(cj.points, key=lambda p: p[1])[1]
    if (vz := by.get("VZ(IZ)")) is not None and vz.points:
        i0, v0 = vz.points[len(vz.points) // 2]
        out["ibv"], out["bv"] = i0, v0
    return out


def zener_values(vz: float, izt: float, zz: float, n: float = 1.0) -> dict[str, float]:
    """BV, IBV and RS from the datasheet's Zener voltage at the test current and the dynamic
    impedance there: the slope of VZ(IZ) is N Vt / IZ + RS."""
    rs = max(zz - n * VT / izt, 0.01)
    return {"bv": vz - izt * rs, "ibv": izt, "rs": rs}


def fit_diode(form: dict[str, str], free: list[str], chars: list[Characteristic],
              bounds: fit.Bounds | None = None) -> fit.FitResult:  # fmt: skip
    """Fit the ``free`` diode parameters (``is``, ``n``, ``rs``, ``cjo``, ``vj``, ``mj``) to
    the points; the others as in ``form`` (SPICE defaults when absent)."""
    chars = fit.usable(chars, DIODE_KINDS)
    if unknown := [k for k in free if k not in _DEFAULTS]:
        raise fit.FitError(f"cannot fit {', '.join(unknown)} to forward, capacitance or Zener "
                           "points")  # fmt: skip
    if not free:
        raise fit.FitError("choose the values to fit")
    known: dict[str, float] = dict(_DEFAULTS)
    for key, text in form.items():
        if key in known and text.strip():
            try:
                known[key] = parse_value(text)
            except InvalidValueError as exc:
                raise fit.FitError(f"{key}: {exc}") from exc
    guesses = _guesses(chars)
    start = []
    for key in free:
        # Read off the points when possible: a better start than a default from another part.
        value = guesses.get(key) or known[key] or 1e-3
        start.append(math.log(value))

    def values_of(p: np.ndarray) -> dict[str, float]:
        return {**known, **dict(zip(free, np.exp(p), strict=True))}

    def evaluate(vectors: list[np.ndarray]) -> list[list[np.ndarray]]:
        return [diode_curves(values_of(p), chars) for p in vectors]

    problem = fit.Problem(chars, evaluate, np.array(start), *fit.log_bounds(free, bounds))
    p, iterations = fit.levenberg_marquardt(problem)
    (models,) = evaluate([p])
    curves, error, worst = fit.curves_of(chars, models)
    fitted = {k: tpl.spice_text(float(v)) for k, v in zip(free, np.exp(p), strict=True)}
    values = {**{k: v for k, v in form.items() if v.strip()}, **fitted}
    return fit.FitResult(values=values, curves=curves, error=error, max_error=worst,
                         iterations=iterations)  # fmt: skip


# -- MOSFETs (level 1) ------------------------------------------------------------------------

MOSFET_KINDS = ("Id(Vgs)", "RDS(Vgs)", "Id(Vds)")
MOSFET_UNITS = {"Id(Vgs)": ("V", "A"), "RDS(Vgs)": ("V", "Ω"), "Id(Vds)": ("V", "A")}
_MOS_DEFAULTS = {"vto": 1.6, "kp": 0.5, "lambda": 0.0, "theta": 0.0, "rd": 0.0, "rs": 0.0}


def _level1(vgs: np.ndarray, vds: np.ndarray, v: dict[str, float]) -> np.ndarray:
    """Square-law drain current at the device's own terminals (W = L = 1); with ``theta`` the
    mobility falls as 1 / (1 + THETA·(Vgs - VTO)), as level 3 has it at that size."""
    vov = np.maximum(vgs - v["vto"], 0.0)
    vds = np.maximum(vds, 0.0)
    kp = v["kp"] / (1 + v.get("theta", 0.0) * vov)
    triode = kp * (vov * vds - vds**2 / 2)
    saturation = kp / 2 * vov**2
    return np.asarray(np.where(vds < vov, triode, saturation) * (1 + v["lambda"] * vds))


def drain_current(vgs: np.ndarray, vds: np.ndarray, v: dict[str, float]) -> np.ndarray:
    """Id with RS and RD: the current at which the inner voltages give that current (bisection
    between 0 and the current without them; the drop only lowers it)."""
    lo = np.zeros_like(vgs)
    hi = _level1(vgs, vds, v) + 1e-30
    for _ in range(60):
        mid = (lo + hi) / 2
        inner = _level1(vgs - mid * v["rs"], vds - mid * (v["rs"] + v["rd"]), v)
        too_high = mid > inner
        hi = np.where(too_high, mid, hi)
        lo = np.where(too_high, lo, mid)
    return (lo + hi) / 2


def mosfet_curves(values: dict[str, float], chars: list[Characteristic], sign: int = 1
                  ) -> list[np.ndarray]:  # fmt: skip
    """``sign`` = -1 for a P-channel part: its datasheet voltages and currents are negative."""
    v = {**values, "vto": sign * values["vto"]}
    out = []
    for c in chars:
        if c.name == "Id(Vds)":  # an output curve at one gate voltage
            vds = sign * np.array([p[0] for p in c.points])
            out.append(sign * drain_current(np.full_like(vds, sign * c.at["Vgs"]), vds, v))
            continue
        vgs = sign * np.array([p[0] for p in c.points])
        if c.name == "Id(Vgs)":
            vds = np.full_like(vgs, sign * c.at["Vds"]) if "Vds" in c.at else vgs
            out.append(sign * drain_current(vgs, vds, v))
        else:  # on-resistance at a small drain voltage
            vov = np.maximum(vgs - v["vto"], 1e-9)
            out.append((1 + v.get("theta", 0.0) * vov) / (v["kp"] * vov) + v["rd"] + v["rs"])
    return out


def _mos_guesses(chars: list[Characteristic], sign: int) -> dict[str, float]:
    """sqrt(2 Id / KP) is linear in Vgs above the threshold: two transfer points give KP and
    VTO; an on-resistance point then gives the series resistance."""
    out: dict[str, float] = {}
    by = {c.name: c for c in chars}
    if (tr := by.get("Id(Vgs)")) is not None and len(tr.points) >= 2:
        (g1, i1), (g2, i2) = tr.points[0], tr.points[-1]
        r1, r2 = math.sqrt(abs(i1)), math.sqrt(abs(i2))
        if abs(g2 - g1) > 1e-9 and r2 != r1:
            slope = (r2 - r1) / (sign * (g2 - g1))
            out["kp"] = max(2 * slope**2, 1e-6)
            out["vto"] = sign * (sign * g1 - r1 / slope)
    if (rd := by.get("RDS(Vgs)")) is not None and rd.points and "kp" in out:
        g, r = rd.points[-1]
        channel = 1 / (out["kp"] * max(sign * g - sign * out["vto"], 1e-3))
        out["rd"] = out["rs"] = max((r - channel) / 2, 1e-3)
    return out


def gate_charge_values(qgs: float, qgd: float, plateau: float, vdd: float) -> dict[str, float]:
    """Level 1 capacitances from the datasheet's gate charge: up to the plateau the gate charges
    Cgs + Cgd by the plateau voltage (Qgs), on the plateau Cgd swings by about VDD (Qgd).
    Constant capacitances: a compromise with a real part's Crss, large at low drain voltage."""
    cgd = qgd / vdd
    return {"cgso": max(qgs / plateau - cgd, 0.0), "cgdo": cgd}


def mosfet_values(ciss: float, coss: float, crss: float) -> dict[str, float]:
    """Level 1 capacitances from the datasheet's Ciss, Coss, Crss: Cgd = Crss, Cgs = Ciss -
    Crss, Cds = Coss - Crss (constant: the datasheet values at its stated Vds)."""
    return {"cgso": max(ciss - crss, 0.0), "cgdo": crss, "cbd": max(coss - crss, 0.0)}


def fit_mosfet(form: dict[str, str], free: list[str], chars: list[Characteristic],
               bounds: fit.Bounds | None = None, sign: int = 1) -> fit.FitResult:  # fmt: skip
    """Fit ``vto``, ``kp``, ``lambda``, ``rd``, ``rs`` to transfer and on-resistance points.
    ``sign`` = -1: a P-channel part, its points negative as in its datasheet; the fit works on
    magnitudes and VTO comes back negative."""

    def magnitudes(c: Characteristic) -> Characteristic:
        if sign == 1:
            return c
        if c.name == "RDS(Vgs)":  # a resistance stays positive
            return c.model_copy(update={"points": [(-x, y) for x, y in c.points]})
        return c.model_copy(update={"points": [(-x, -y) for x, y in c.points],
                                    "at": {k: -v for k, v in c.at.items()}})  # fmt: skip

    chars = fit.usable([magnitudes(c) for c in chars], MOSFET_KINDS)
    if any(c.name == "Id(Vds)" and "Vgs" not in c.at for c in chars):
        raise fit.FitError("give the Vgs the output points were taken at")
    if unknown := [k for k in free if k not in _MOS_DEFAULTS]:
        raise fit.FitError(f"cannot fit {', '.join(unknown)} to transfer, output or RDS(on) points")
    if not free:
        raise fit.FitError("choose the values to fit")
    known = dict(_MOS_DEFAULTS)
    for key, text in form.items():
        if key in known and text.strip():
            try:
                known[key] = parse_value(text)
            except InvalidValueError as exc:
                raise fit.FitError(f"{key}: {exc}") from exc
    known["vto"] *= sign  # magnitudes from here on
    guesses = _mos_guesses(chars, 1)
    # The threshold is fitted as it is (it may be near zero), the others in log space.
    names = [k for k in free if k != "vto"]
    start = [math.log(guesses.get(k) or known[k] or 1e-3) for k in names]
    fit_vto = "vto" in free
    if fit_vto:
        start.append(guesses.get("vto", known["vto"]))

    def values_of(p: np.ndarray) -> dict[str, float]:
        out = {**known, **dict(zip(names, np.exp(p[: len(names)]), strict=True))}
        if fit_vto:
            out["vto"] = float(p[-1])
        return out

    def evaluate(vectors: list[np.ndarray]) -> list[list[np.ndarray]]:
        return [mosfet_curves(values_of(p), chars) for p in vectors]

    low, high = fit.log_bounds(names, bounds)
    if fit_vto:
        lo, hi = (bounds or {}).get("vto", (None, None))
        limits = sorted(sign * b for b in (lo, hi) if b is not None)
        low = np.append(low, limits[0] if lo is not None else -np.inf)
        high = np.append(high, limits[-1] if hi is not None else np.inf)
    problem = fit.Problem(chars, evaluate, np.array(start), low, high)
    p, iterations = fit.levenberg_marquardt(problem)
    (models,) = evaluate([p])
    curves, error, worst = fit.curves_of(chars, models)
    result = values_of(p)
    result["vto"] *= sign
    fitted = {k: tpl.spice_text(float(result[k])) for k in free}
    values = {**{k: v for k, v in form.items() if v.strip()}, **fitted}
    return fit.FitResult(values=values, curves=curves, error=error, max_error=worst,
                         iterations=iterations)  # fmt: skip


# -- bipolar transistors (Gummel-Poon, DC) ----------------------------------------------------

BJT_KINDS = ("hFE(Ic)", "VBE(Ic)", "VCEsat(Ic)", "Ic(Vce)")
BJT_UNITS = {"hFE(Ic)": ("A", ""), "VBE(Ic)": ("A", "V"), "VCEsat(Ic)": ("A", "V"),
             "Ic(Vce)": ("V", "A")}  # fmt: skip
_BJT_DEFAULTS = {"is": 1e-16, "bf": 100.0, "br": 1.0, "vaf": 1e30, "ikf": 1e30, "ise": 0.0,
                 "ne": 1.5, "rb": 0.0, "rc": 0.0}  # fmt: skip


def _gummel_poon(vbe: np.ndarray, vbc: np.ndarray, v: dict[str, float]
                 ) -> tuple[np.ndarray, np.ndarray]:  # fmt: skip
    """(Ic, Ib) at the inner junction voltages (NF = NR = 1, no VAR, IKR, ISC)."""
    i_f = v["is"] * np.expm1(np.minimum(vbe / VT, 200))
    i_r = v["is"] * np.expm1(np.minimum(vbc / VT, 200))
    q1 = 1 / np.maximum(1 - vbc / v["vaf"], 1e-3)
    q2 = i_f / v["ikf"]
    qb = q1 / 2 * (1 + np.sqrt(1 + 4 * q2))
    ic = (i_f - i_r) / qb - i_r / v["br"]
    leak = v["ise"] * np.expm1(np.minimum(vbe / (v["ne"] * VT), 200)) if v["ise"] > 0 else 0.0
    ib = i_f / v["bf"] + leak + i_r / v["br"]
    return ic, ib


def _active(ic: np.ndarray, vce: float, v: dict[str, float]) -> tuple[np.ndarray, np.ndarray]:
    """(Vbe at the pin, Ib) giving collector current ``ic`` at ``vce`` (bisection on Vbe)."""
    lo, hi = np.zeros_like(ic), np.full_like(ic, 1.5)
    vce_inner = vce - ic * v["rc"]
    for _ in range(45):  # 1.5 V / 2^45: far below a picovolt
        mid = (lo + hi) / 2
        current, _ib = _gummel_poon(mid, mid - vce_inner, v)
        low = current < ic
        lo, hi = np.where(low, mid, lo), np.where(low, hi, mid)
    vbe = (lo + hi) / 2
    _ic, ib = _gummel_poon(vbe, vbe - vce_inner, v)
    return vbe + ib * v["rb"], ib


def _saturated(ic: np.ndarray, beta: float, v: dict[str, float]) -> np.ndarray:
    """VCE with the base driven at Ib = Ic / beta (Newton on both junction voltages)."""
    ib_t = ic / beta
    x = np.stack([np.full_like(ic, 0.75), np.full_like(ic, 0.65)])
    for _ in range(80):

        def residual(vbe: np.ndarray, vbc: np.ndarray) -> np.ndarray:
            c, b = _gummel_poon(vbe, vbc, v)
            return np.stack(
                [np.log(np.maximum(c, 1e-30) / ic), np.log(np.maximum(b, 1e-30) / ib_t)]
            )

        f = residual(x[0], x[1])
        h = 1e-6
        j00 = (residual(x[0] + h, x[1])[0] - f[0]) / h
        j01 = (residual(x[0], x[1] + h)[0] - f[0]) / h
        j10 = (residual(x[0] + h, x[1])[1] - f[1]) / h
        j11 = (residual(x[0], x[1] + h)[1] - f[1]) / h
        det = j00 * j11 - j01 * j10
        det = np.where(np.abs(det) < 1e-30, 1e-30, det)
        d0 = (f[0] * j11 - f[1] * j01) / det
        d1 = (f[1] * j00 - f[0] * j10) / det
        step = np.clip(np.stack([d0, d1]), -0.05, 0.05)
        x = x - step
        if float(np.max(np.abs(step))) < 1e-10:
            break
    return np.asarray(x[0] - x[1] + ic * v["rc"])


def _output(vce: np.ndarray, ib: float, v: dict[str, float]) -> np.ndarray:
    """Ic at ``vce`` with the base driven by the current ``ib`` (an output curve): bisection on
    Vbe for that base current, the drop on RC followed in a few rounds."""
    ic = np.zeros_like(vce)
    for _ in range(4):
        inner = vce - ic * v["rc"]
        lo, hi = np.zeros_like(vce), np.full_like(vce, 1.5)
        for _ in range(45):
            mid = (lo + hi) / 2
            _c, base = _gummel_poon(mid, mid - inner, v)
            low = base < ib
            lo, hi = np.where(low, mid, lo), np.where(low, hi, mid)
        vbe = (lo + hi) / 2
        ic, _b = _gummel_poon(vbe, vbe - inner, v)
    return np.asarray(ic)


def bjt_curves(values: dict[str, float], chars: list[Characteristic]) -> list[np.ndarray]:
    """On magnitudes (a PNP's datasheet values are negated before)."""
    out = []
    for c in chars:
        if c.name == "Ic(Vce)":  # an output curve at one base current
            out.append(_output(np.array([p[0] for p in c.points]), c.at["Ib"], values))
            continue
        ic = np.array([p[0] for p in c.points])
        if c.name == "VCEsat(Ic)":
            out.append(_saturated(ic, c.at.get("beta", 10.0), values))
            continue
        vbe, ib = _active(ic, c.at.get("Vce", 5.0), values)
        out.append(ic / ib if c.name == "hFE(Ic)" else vbe)
    return out


def bjt_values(ft: float, ic: float, cobo: float, cibo: float) -> dict[str, float]:
    """TF from the transition frequency at a collector current (1/(2 pi fT) less the junction
    charging time), CJC from Cobo, CJE from Cibo."""
    tf = 1 / (2 * math.pi * ft) - (cibo + cobo) * VT / ic
    return {"tf": max(tf, 1e-12), "cjc": cobo, "cje": cibo}


def fit_bjt(form: dict[str, str], free: list[str], chars: list[Characteristic],
            bounds: fit.Bounds | None = None, sign: int = 1) -> fit.FitResult:  # fmt: skip
    """Fit Gummel-Poon parameters to hFE(Ic), VBE(Ic) and VCE(sat)(Ic) points; ``sign`` = -1
    for a PNP (its points negative, as in its datasheet)."""
    if sign == -1:

        def negated(c: Characteristic) -> Characteristic:
            gain = c.name == "hFE(Ic)"  # a gain stays positive
            # Conditions as magnitudes too: Vce typed -5 V as in the datasheet or 5 V.
            return c.model_copy(update={
                "points": [(-x, y if gain else -y) for x, y in c.points],
                "at": {k: abs(v) for k, v in c.at.items()},
            })  # fmt: skip

        chars = [negated(c) for c in chars]
    chars = fit.usable(chars, BJT_KINDS)
    if any(c.name == "Ic(Vce)" and "Ib" not in c.at for c in chars):
        raise fit.FitError("give the Ib the output points were taken at")
    if unknown := [k for k in free if k not in _BJT_DEFAULTS]:
        raise fit.FitError(
            f"cannot fit {', '.join(unknown)} to hFE, VBE, VCE(sat) or output points"
        )
    if not free:
        raise fit.FitError("choose the values to fit")
    known = dict(_BJT_DEFAULTS)
    for key, text in form.items():
        if key in known and text.strip():
            try:
                known[key] = parse_value(text)
            except InvalidValueError as exc:
                raise fit.FitError(f"{key}: {exc}") from exc
    by = {c.name: c for c in chars}
    guesses: dict[str, float] = {}
    if (h := by.get("hFE(Ic)")) is not None:
        guesses["bf"] = max(p[1] for p in h.points) * 1.2
        guesses["ikf"] = h.points[-1][0] * 2
        if known["ise"] <= 0:
            guesses["ise"] = known["is"]
    start = [math.log(guesses.get(k) or known[k] or 1e-3) for k in free]

    def values_of(p: np.ndarray) -> dict[str, float]:
        return {**known, **dict(zip(free, np.exp(p), strict=True))}

    def evaluate(vectors: list[np.ndarray]) -> list[list[np.ndarray]]:
        return [bjt_curves(values_of(p), chars) for p in vectors]

    problem = fit.Problem(chars, evaluate, np.array(start), *fit.log_bounds(free, bounds))
    p, iterations = fit.levenberg_marquardt(problem)
    (models,) = evaluate([p])
    curves, error, worst = fit.curves_of(chars, models)
    fitted = {k: tpl.spice_text(float(v)) for k, v in zip(free, np.exp(p), strict=True)}
    values = {**{k: v for k, v in form.items() if v.strip()}, **fitted}
    return fit.FitResult(values=values, curves=curves, error=error, max_error=worst,
                         iterations=iterations)  # fmt: skip
