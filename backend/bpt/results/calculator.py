"""Waveform calculator: expressions over the signals of a run.

Syntax: ``+ - * / ^``, parentheses, numbers with SPICE suffixes (``1k``, ``2u2``), signals
``V(net)``, ``V(a,b)`` (= V(a) - V(b)), ``I(R1)``, ``I(Q1.C)``, the axis (``time``,
``frequency``, ``sweep``) and functions:

* element-wise: ``db mag abs ph uph gd re im sqrt exp ln log10 deriv integ``,
  ``sin cos tan asin acos atan sinh cosh tanh sign floor ceil round``
* scalars: ``rms avg mean max min pp`` (reduce over the visible run)
* constants: ``pi``, ``e``

``db`` is 20·log10|x|, ``ph`` the phase in degrees (within ±180°), ``uph`` the same without
the jumps at ±180° (Bode plots), ``gd`` the group delay -dφ/dω in seconds (x = frequency),
``integ`` the running integral over x.
"""

import re
from collections.abc import Callable
from typing import Any

import numpy as np
import numpy.typing as npt

from bpt.results.store import RunReader
from bpt.units import InvalidValueError, parse_value

Array = npt.NDArray[Any]  # real or complex depending on the expression

_TOKEN = re.compile(
    r"\s*(?:(?P<num>(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?[a-zµ]*\d*)|(?P<name>[A-Za-z_][\w.]*)"
    r"|(?P<op>[-+*/^(),]))",
    re.IGNORECASE,
)


class ExpressionError(ValueError):
    """The expression cannot be parsed or evaluated."""


def _tokens(text: str) -> list[tuple[str, str]]:
    pos, out = 0, []
    while pos < len(text):
        if text[pos:].strip() == "":
            break
        match = _TOKEN.match(text, pos)
        if not match or match.end() == pos:
            raise ExpressionError(f"unexpected {text[pos : pos + 10]!r}")
        kind = match.lastgroup or ""
        out.append((kind, match.group(kind)))
        pos = match.end()
    return out


SignalLookup = Callable[[str], Array]


class _Evaluator:
    def __init__(
        self,
        text: str,
        x: npt.NDArray[np.float64],
        lookup: SignalLookup | None,
        variables: dict[str, Array] | None = None,
    ) -> None:
        self.lookup = lookup
        self.variables = {k.lower(): v for k, v in (variables or {}).items()}
        self.tokens = _tokens(text)
        self.i = 0
        self.x = x

    # -- helpers ------------------------------------------------------------------------------

    def peek(self) -> str:
        return self.tokens[self.i][1] if self.i < len(self.tokens) else ""

    def take(self, expected: str | None = None) -> str:
        if self.i >= len(self.tokens):
            raise ExpressionError("unexpected end of expression")
        value = self.tokens[self.i][1]
        if expected is not None and value != expected:
            raise ExpressionError(f"expected {expected!r}, got {value!r}")
        self.i += 1
        return value

    def signal(self, name: str) -> Array:
        if name.lower() in ("0", "gnd"):
            return np.zeros_like(self.x)
        if self.lookup is None:
            raise ExpressionError(f"{name}: signals need a run here; use the inputs a, b, c…")
        try:
            return np.asarray(self.lookup(name))
        except KeyError:
            raise ExpressionError(f"no signal {name}") from None

    # -- grammar ------------------------------------------------------------------------------

    def parse(self) -> Array:
        value = self.expr()
        if self.i != len(self.tokens):
            raise ExpressionError(f"unexpected {self.peek()!r}")
        return value

    def expr(self) -> Array:
        value = self.term()
        while self.peek() in ("+", "-"):
            op = self.take()
            rhs = self.term()
            value = value + rhs if op == "+" else value - rhs
        return value

    def term(self) -> Array:
        value = self.unary()
        while self.peek() in ("*", "/"):
            op = self.take()
            rhs = self.unary()
            with np.errstate(divide="ignore", invalid="ignore"):
                value = value * rhs if op == "*" else value / rhs
        return value

    def unary(self) -> Array:
        # The sign binds looser than "^": -2^2 is -(2^2) = -4, as in maths and ngspice.
        if self.peek() == "-":
            self.take()
            return -self.unary()
        if self.peek() == "+":
            self.take()
            return self.unary()
        return self.power()

    def power(self) -> Array:
        value = self.primary()
        if self.peek() == "^":
            self.take()
            value = value ** self.unary()  # right-associative; 2^-1 allowed
        return value

    def primary(self) -> Array:
        kind, token = self.tokens[self.i] if self.i < len(self.tokens) else ("", "")
        if kind == "num":
            self.take()
            try:
                return np.asarray(parse_value(token))
            except InvalidValueError as exc:
                raise ExpressionError(str(exc)) from exc
        if token == "(":  # noqa: S105 - a parser token, not a password
            self.take()
            value = self.expr()
            self.take(")")
            return value
        if kind != "name":
            raise ExpressionError(f"unexpected {token!r}")
        self.take()
        lowered = token.lower()
        if lowered in ("time", "frequency", "sweep", "x"):
            return self.x
        if lowered in self.variables and self.peek() != "(":
            return self.variables[lowered]
        if lowered in _CONSTANTS and self.peek() != "(":
            return np.asarray(_CONSTANTS[lowered])
        if self.peek() != "(":
            raise ExpressionError(f"unknown name {token!r}")
        if lowered in ("v", "i", "p"):
            return self.probe(lowered)
        self.take("(")
        arg = self.expr()
        self.take(")")
        return self.function(lowered, arg)

    def probe(self, kind: str) -> Array:
        self.take("(")
        names = [self.take()]
        while self.peek() == ",":
            self.take()
            names.append(self.take())
        self.take(")")
        if kind == "v":
            value = self.signal(f"V({names[0]})")
            return value - self.signal(f"V({names[1]})") if len(names) > 1 else value
        if kind == "i":
            return self.signal(f"I({names[0]})")
        raise ExpressionError("P() is not a signal; use (V(a)-V(b))*I(ref)")

    def function(self, name: str, arg: Array) -> Array:
        x = self.x
        elementwise: dict[str, Callable[[Array], Array]] = {
            "db": lambda v: 20 * np.log10(np.maximum(np.abs(v), 1e-15)),
            "mag": np.abs,
            "abs": np.abs,
            "ph": lambda v: np.degrees(np.angle(v)),
            "re": np.real,
            "im": np.imag,
            "sqrt": np.sqrt,
            "exp": np.exp,
            "ln": np.log,
            "log10": np.log10,
            "deriv": lambda v: np.gradient(v, x) if v.size == x.size and x.size > 1 else v * 0,
            "integ": lambda v: _cumulative_trapezoid(v, x),
            "uph": lambda v: np.degrees(np.unwrap(np.angle(v))),
            "gd": lambda v: (
                -np.gradient(np.unwrap(np.angle(v)), 2 * np.pi * x)
                if v.size == x.size and x.size > 1
                else v * 0
            ),
            **{name: getattr(np, numpy) for name, numpy in _ELEMENTWISE.items()},
        }
        if name in elementwise:
            with np.errstate(divide="ignore", invalid="ignore"):
                return np.asarray(elementwise[name](arg))
        real = np.abs(arg) if np.iscomplexobj(arg) else arg
        if np.ndim(real) == 0:  # rms(5), max(V(a)) of an operating point: a constant over x
            real = np.full(x.shape, real)
        span = x[-1] - x[0] if x.size > 1 else 0.0
        if name in ("avg", "mean"):
            return np.asarray(np.trapezoid(real, x) / span if span else np.mean(real))
        if name == "rms":
            return np.asarray(
                np.sqrt(np.trapezoid(real**2, x) / span) if span else np.abs(real[-1])
            )
        reducers: dict[str, Callable[[Array], Any]] = {"max": np.max, "min": np.min, "pp": np.ptp}
        if name in reducers:
            return np.asarray(reducers[name](real))
        raise ExpressionError(f"unknown function {name}()")


_CONSTANTS = {"pi": np.pi, "e": np.e}
_ELEMENTWISE = {"sin": "sin", "cos": "cos", "tan": "tan", "asin": "arcsin", "acos": "arccos",
                "atan": "arctan", "sinh": "sinh", "cosh": "cosh", "tanh": "tanh", "sign": "sign",
                "floor": "floor", "ceil": "ceil", "round": "round"}  # fmt: skip


def _cumulative_trapezoid(y: Array, x: npt.NDArray[np.float64]) -> Array:
    if y.size != x.size or x.size < 2:
        return y * 0
    steps = (y[1:] + y[:-1]) / 2 * np.diff(x)
    return np.concatenate([[0], np.cumsum(steps)])


def evaluate(run: RunReader, expression: str) -> Array:
    """Evaluate ``expression`` for a run; returns an array over the x axis or a scalar."""
    if not expression.strip():
        raise ExpressionError("empty expression")
    scale = run.meta.scale
    x = np.real(np.asarray(run.signal(scale))) if scale else np.zeros(1)
    return _Evaluator(expression, x, run.signal).parse()


def evaluate_with(
    expression: str, x: npt.NDArray[np.float64], variables: dict[str, Array]
) -> Array:
    """Evaluate over named arrays (``a``, ``b``…) sharing the axis ``x``; no run signals."""
    if not expression.strip():
        raise ExpressionError("empty expression")
    return _Evaluator(expression, x, None, variables).parse()


def is_plain_signal(run: RunReader, name: str) -> bool:
    return any(s.name.lower() == name.lower() for s in run.meta.signals)
