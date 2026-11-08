"""Transfer function blocks H(s) (FR-MOD-8): an expression in s as a ratio of polynomials.

The block is simulated by XSPICE's ``s_xfer`` code model (AC and transient alike), given the
coefficients of the numerator and the denominator, highest power of s first. The expression may
be written as a formula (``1/(1+s/(2*pi*1k))``), as zeros and poles in brackets
(``1k*(s+2k)/((s+100)*(s+10k))``) or as polynomials: anything of numbers (SPICE suffixes), ``s``,
``pi``, ``+ - * /``, integer powers ``^`` and parentheses.
"""

import math
import re

import numpy as np

from bpt.units import InvalidValueError, parse_value

Poly = np.ndarray  # coefficients, highest power first


class TransferError(ValueError):
    """The expression is not a ratio of polynomials in s."""


_TOKEN = re.compile(r"\s*(?:(?P<num>(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?[a-zA-Zµ]*)"
                    r"|(?P<name>[a-zA-Z_]\w*)|(?P<op>[-+*/^()]))")  # fmt: skip


def _tokens(text: str) -> list[str]:
    out: list[str] = []
    i = 0
    text = text.strip()
    while i < len(text):
        m = _TOKEN.match(text, i)
        if not m or m.end() == i:
            raise TransferError(f"cannot read “{text[i : i + 10]}”")
        out.append(m.group(0).strip())
        i = m.end()
    return out


def _trim(p: Poly) -> Poly:
    nz = np.flatnonzero(np.abs(p) > 0)
    return p[nz[0] :] if len(nz) else np.array([0.0])


class _Parser:
    """Recursive descent to (numerator, denominator)."""

    def __init__(self, text: str) -> None:
        self.tokens = _tokens(text)
        self.at = 0

    def peek(self) -> str | None:
        return self.tokens[self.at] if self.at < len(self.tokens) else None

    def take(self) -> str:
        word = self.peek()
        if word is None:
            raise TransferError("the expression ends too early")
        self.at += 1
        return word

    def parse(self) -> tuple[Poly, Poly]:
        value = self.sum()
        if self.peek() is not None:
            raise TransferError(f"unexpected “{self.peek()}”")
        return value

    def sum(self) -> tuple[Poly, Poly]:
        n, d = self.product()
        while self.peek() in ("+", "-"):
            sign = 1.0 if self.take() == "+" else -1.0
            n2, d2 = self.product()
            n, d = np.polyadd(np.polymul(n, d2), sign * np.polymul(n2, d)), np.polymul(d, d2)
        return n, d

    def product(self) -> tuple[Poly, Poly]:
        n, d = self.power()
        while self.peek() in ("*", "/") or self._implicit():
            op = self.take() if self.peek() in ("*", "/") else "*"
            n2, d2 = self.power()
            if op == "*":
                n, d = np.polymul(n, n2), np.polymul(d, d2)
            else:
                if not np.any(n2):
                    raise TransferError("division by zero")
                n, d = np.polymul(n, d2), np.polymul(d, n2)
        return n, d

    def _implicit(self) -> bool:
        """2s, 2(s+1), (s+1)(s+2): a product without its star."""
        word = self.peek()
        return (
            word is not None
            and (word == "(" or word[0].isalpha())
            and self.at > 0
            and self.tokens[self.at - 1] not in ("+", "-", "*", "/", "^", "(")
        )

    def power(self) -> tuple[Poly, Poly]:
        n, d = self.unary()
        if self.peek() == "^":
            self.take()
            exponent_text = self.take()
            try:
                exponent = int(exponent_text)
            except ValueError as exc:
                raise TransferError(f"a power must be a whole number, not {exponent_text}") from exc
            if exponent < 0:
                n, d, exponent = d, n, -exponent
            pn, pd = np.array([1.0]), np.array([1.0])
            for _ in range(exponent):
                pn, pd = np.polymul(pn, n), np.polymul(pd, d)
            n, d = pn, pd
        return n, d

    def unary(self) -> tuple[Poly, Poly]:
        if self.peek() == "-":
            self.take()
            n, d = self.unary()
            return -n, d
        if self.peek() == "+":
            self.take()
        return self.atom()

    def atom(self) -> tuple[Poly, Poly]:
        word = self.take()
        if word == "(":
            value = self.sum()
            if self.take() != ")":
                raise TransferError("a bracket is not closed")
            return value
        if word.lower() == "s":
            return np.array([1.0, 0.0]), np.array([1.0])
        if word.lower() == "pi":
            return np.array([math.pi]), np.array([1.0])
        if word[0].isdigit() or word[0] == ".":
            try:
                return np.array([parse_value(word)]), np.array([1.0])
            except InvalidValueError as exc:
                raise TransferError(f"“{word}” is not a number") from exc
        raise TransferError(f"unknown name “{word}” (only s and pi)")


def parse_transfer(text: str) -> tuple[list[float], list[float]]:
    """(numerator, denominator) coefficients, highest power first, the denominator's leading
    coefficient 1. Refused: an improper function (more zeros than poles: it grows without end)."""
    if not text.strip():
        raise TransferError("give H(s), e.g. 1/(1+s/(2*pi*1k))")
    n, d = (_trim(np.asarray(p, dtype=float)) for p in _Parser(text).parse())
    if not np.any(d):
        raise TransferError("the denominator is zero")
    if len(n) > len(d):
        raise TransferError("more zeros than poles: H(s) grows without end at high frequency")
    lead = d[0]
    return [float(c) for c in n / lead], [float(c) for c in d / lead]


def response(num: list[float], den: list[float], freqs: np.ndarray) -> np.ndarray:
    s = 2j * math.pi * freqs
    return np.asarray(np.polyval(num, s) / np.polyval(den, s))


def corner_span(num: list[float], den: list[float]) -> tuple[float, float]:
    """A frequency range showing every zero and pole (a decade and more around them)."""
    roots = [abs(r) / (2 * math.pi) for r in [*np.roots(num), *np.roots(den)] if abs(r) > 0]
    if not roots:
        return 1.0, 1e6
    return max(min(roots) / 100, 1e-3), max(roots) * 100


def s_xfer_params(num: list[float], den: list[float]) -> dict[str, str]:
    """The ``.model ... s_xfer(...)`` parameters (vectors in brackets)."""

    def vector(c: list[float]) -> str:
        return "[" + " ".join(f"{v:.12g}" for v in c) + "]"

    return {"gain": "1", "num_coeff": vector(num), "den_coeff": vector(den)}
