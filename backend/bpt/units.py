"""Parsing and formatting of component values.

Accepted input (case-insensitive, SPICE semantics):

* plain numbers: ``10``, ``-2.5``, ``1e-3``
* scale suffixes: ``T G MEG K M(=milli) U µ N P F MIL``; ``M`` is *milli* as in SPICE,
  mega is ``MEG``
* European notation, the suffix as decimal point: ``4k7`` = 4.7k, ``2u2`` = 2.2u,
  ``1R5`` / ``1V5`` = 1.5
* trailing unit letters are ignored: ``10kΩ``, ``1uF``, ``3.3V``, ``100mA``
  (like SPICE, ``1F`` therefore means one femto)

Values in braces (``{Rload*2}``) are parameter expressions; they are kept as text and
evaluated by the simulator.
"""

import math
import re

SCALE = {
    "t": 1e12,
    "g": 1e9,
    "meg": 1e6,
    "k": 1e3,
    "m": 1e-3,
    "mil": 25.4e-6,
    "u": 1e-6,
    "µ": 1e-6,  # micro sign
    "μ": 1e-6,  # greek mu
    "n": 1e-9,
    "p": 1e-12,
    "f": 1e-15,
}
# Letters that act as a decimal point with scale 1 in European notation (1R5, 3V3).
UNIT_DECIMAL = {"r", "v", "a"}

_NUMBER = r"[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?"
_PLAIN = re.compile(rf"^({_NUMBER})(.*)$", re.IGNORECASE)
_EURO = re.compile(r"^([+-]?\d+)(meg|[tgkmuµμnpfrva])(\d+)(.*)$", re.IGNORECASE)
_SUFFIXES = sorted(SCALE, key=len, reverse=True)  # match "meg"/"mil" before "m"
# A decimal comma (1,5k; 4,7 nF): one value never holds a list, so the comma is the point.
_DECIMAL_COMMA = re.compile(r"^([+-]?\d+),(\d)")


class InvalidValueError(ValueError):
    """Text is not a valid component value."""


def is_expression(text: str) -> bool:
    """True for parameter expressions such as ``{R*2}``."""
    stripped = text.strip()
    return stripped.startswith("{") and stripped.endswith("}")


def _scale_of(rest: str) -> float:
    lowered = rest.lower()
    for suffix in _SUFFIXES:
        if lowered.startswith(suffix):
            return SCALE[suffix]
    return 1.0


def parse_value(text: str) -> float:
    """Parse a component value to a float (see module docstring for the syntax)."""
    raw = _DECIMAL_COMMA.sub(r"\1.\2", "".join(text.split()))  # spaces, tabs, any blank
    if not raw or is_expression(raw):
        raise InvalidValueError(f"not a numeric value: {text!r}")
    euro = _EURO.match(raw)
    if euro:
        whole, suffix, frac, rest = euro.groups()
        if any(ch.isdigit() for ch in rest):
            raise InvalidValueError(f"not a numeric value: {text!r}")
        suffix = suffix.lower()
        scale = 1.0 if suffix in UNIT_DECIMAL else SCALE[suffix]
        sign = -1.0 if whole.startswith("-") else 1.0
        return sign * (abs(float(whole)) + float(f"0.{frac}")) * scale
    plain = _PLAIN.match(raw)
    if not plain:
        raise InvalidValueError(f"not a numeric value: {text!r}")
    number, rest = plain.groups()
    if rest and (any(ch.isdigit() for ch in rest) or not (rest[0].isalpha() or rest[0] in "µμΩ°%")):
        raise InvalidValueError(f"not a numeric value: {text!r}")
    return float(number) * _scale_of(rest)


_SI_PREFIXES = [
    (1e12, "T"),
    (1e9, "G"),
    (1e6, "M"),
    (1e3, "k"),
    (1.0, ""),
    (1e-3, "m"),
    (1e-6, "µ"),
    (1e-9, "n"),
    (1e-12, "p"),
    (1e-15, "f"),
]
_SPICE_PREFIX = {"M": "meg", "µ": "u", "": ""}


def _engineering(value: float) -> tuple[float, str]:
    if value == 0 or not math.isfinite(value):
        return value, ""
    magnitude = abs(value)
    for scale, prefix in _SI_PREFIXES:
        if magnitude >= scale * (1 - 1e-12):
            return value / scale, prefix
    return value / 1e-15, "f"


_NO_PREFIX = {"%", "dB", "°", "deg"}


def format_value(value: float, unit: str = "", digits: int = 4) -> str:
    """Human-readable engineering notation with SI prefix: ``4.7kΩ``, ``2.2µF``."""
    if unit in _NO_PREFIX:  # 12.5%, -3dB, 45°: prefixes would read as nonsense ("1k%")
        return f"{value:.{digits}g}{unit}"
    # Round first: 0.99999 V shown with 4 digits is "1V", not "1000mV".
    rounded = float(f"{value:.{digits}g}") if math.isfinite(value) else value
    mantissa, prefix = _engineering(rounded)
    # At least 3 digits for the mantissa: 110 µA with 2 digits would print as "1.1e+02µA".
    return f"{mantissa:.{max(digits, 3)}g}{prefix}{unit}"


def to_spice(value: float, digits: int = 12) -> str:
    """Value as SPICE text (``4.7k``, ``2.2u``, ``1meg``) without loss of precision."""
    mantissa, prefix = _engineering(value)
    return f"{mantissa:.{digits}g}{_SPICE_PREFIX.get(prefix, prefix)}"


def normalize_for_spice(text: str) -> str:
    """Convert a user value to SPICE syntax; expressions pass through unchanged."""
    if is_expression(text):
        return text.strip()
    return to_spice(parse_value(text))


def parse_quantity(text: str, unit: str = "") -> float:
    """A value typed with its unit ("10 ms", "1 MHz", "4k7"): with the unit written out, SI
    rules apply ("M" before it is mega); without it SPICE rules ("M" = milli)."""
    raw = re.sub(r"\s+", "", text)
    if unit and len(raw) > len(unit) and raw.lower().endswith(unit.lower()):
        raw = raw[: -len(unit)]
        if raw.endswith("M"):
            raw = raw[:-1] + "meg"
    return parse_value(raw)
