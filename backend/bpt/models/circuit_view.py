"""The equivalent circuit of a template drawn for reading (the part editor's preview).

What the netlist needs is not what a reader needs: a part whose value is a field is named by
the field (``ESR`` instead of ``R2``) and shows ``50 mΩ`` (the value with its unit), a formula its
value (``{aol/(6.2832*gbw*cint)}`` →
``31.83 MΩ``), a nonlinear value what it is (``C(V) 10 µF at 0 V``), a behavioural source the
template's caption (``I = gm·Vd``) or its expression shortened, and a ``.model`` line its
parameters with their values, a few per line.
"""

import ast
import math
import operator
import re
from collections.abc import Callable

from bpt.document.model import Sheet, TemplateField
from bpt.library.symbols import Symbol
from bpt.netlist.ngspice_writer import is_behavioural
from bpt.units import InvalidValueError, format_value, parse_value

_UNIT = {"R": "Ω", "C": "F", "L": "H", "V": "V", "I": "A"}
_BARE = re.compile(r"^\{\s*(\w+)\s*\}$")
_KEY = re.compile(r"\{\s*(\w+)\s*\}")
_MODEL = re.compile(r"^\s*\.model\s+(\S+)\s+(\w+)\s*\((.*)\)\s*$", re.IGNORECASE | re.DOTALL)
_PROBE = re.compile(r"\b[vi]\s*\([^()]*\)", re.IGNORECASE)  # v(1,2), i(L1): 0 when shown
LONG = 28  # characters of an expression shown before it is cut
PER_LINE = 3  # model parameters per line

_OPS: dict[type, Callable[..., float]] = {
    ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
    ast.Div: operator.truediv, ast.Pow: operator.pow, ast.USub: operator.neg,
    ast.UAdd: operator.pos,
}  # fmt: skip
_FUNCS: dict[str, Callable[..., float]] = {
    "sqrt": math.sqrt, "exp": math.exp, "log": math.log, "ln": math.log, "log10": math.log10,
    "abs": abs, "pwr": math.pow, "pow": math.pow, "min": min, "max": max,
}  # fmt: skip


def quantity(value: float, unit: str) -> str:
    """``50 mΩ``, ``0.995``: spaced like the chart's axis labels."""
    if not unit:  # a ratio or a coefficient: 0.5, not 500m
        return f"{value:.4g}"
    if unit[0].isdigit():  # 1/V: a prefix would read as part of the number (10 m1/V)
        return f"{value:.4g} {unit}"
    text = format_value(value, unit, 4)
    number = text[: len(text) - len(unit)].rstrip("afpnµmkMGT")
    return f"{number} {text[len(number) :]}"


def evaluate(expression: str, values: dict[str, float]) -> float | None:
    """A parameter expression (``1/(6.283*flf*rlf)``, ``lp*n*n``) with the form's values; probes
    of the circuit (``v(1,2)``, ``i(L1)``) count as 0. None when it cannot be computed."""
    text = _PROBE.sub("0", expression.strip().strip("{}")).replace("^", "**")
    try:
        tree = ast.parse(text, mode="eval")
    except SyntaxError:
        return None

    def walk(node: ast.AST) -> float:
        match node:
            case ast.Expression(body=body):
                return walk(body)
            case ast.Constant(value=int() | float() as number):
                return float(number)
            case ast.Name(id=name) if name in values:
                return values[name]
            case ast.BinOp(left=left, op=op, right=right) if type(op) in _OPS:
                return _OPS[type(op)](walk(left), walk(right))
            case ast.UnaryOp(op=op, operand=operand) if type(op) in _OPS:
                return _OPS[type(op)](walk(operand))
            case ast.Call(func=ast.Name(id=name), args=args) if name.lower() in _FUNCS:
                return _FUNCS[name.lower()](*(walk(a) for a in args))
        raise ValueError(ast.dump(node))

    try:
        result = walk(tree)
    except (ValueError, ArithmeticError, TypeError):
        return None
    return result if math.isfinite(result) else None


def _numbers(parameters: dict[str, str]) -> dict[str, float]:
    out: dict[str, float] = {}
    for key, text in parameters.items():
        try:
            out[key] = parse_value(text)
        except InvalidValueError:
            continue
    return out


def readable(sheet: Sheet, symbols: dict[str, Symbol], fields: list[TemplateField],
             captions: dict[str, str] | None = None,
             ) -> tuple[Sheet, dict[str, tuple[str, str]]]:  # fmt: skip
    """(the sheet with its ``.model`` lines written out, (name, value) shown for each part ref)."""
    values = _numbers(sheet.parameters)
    by_key = {f.key: f for f in fields}

    def shown(key: str, unit: str = "") -> str:
        field = by_key.get(key)
        number = values.get(key)
        if number is None:
            return sheet.parameters.get(key, key)
        return quantity(number, unit or (field.unit if field else ""))

    def caption(text: str) -> str:
        return _KEY.sub(lambda m: shown(m.group(1)), text)

    def name(element: str, text: str) -> str | None:
        """The field's name for a part whose value is that field (unless it only repeats the
        letter: C of a capacitor)."""
        bare = _BARE.match(text.strip())
        field = by_key.get(bare.group(1)) if bare else None
        label = field.label.strip() if field else ""
        return label if label and label.upper() != element else None

    def value(element: str, text: str) -> str:
        unit = _UNIT.get(element, "")
        text = text.strip()
        if bare := _BARE.match(text):
            return shown(bare.group(1), unit)
        if is_behavioural(text):
            probe = "V" if re.search(r"\bv\s*\(", text, re.IGNORECASE) else "I"
            at_zero = evaluate(text, values)
            rest = f" {quantity(at_zero, unit)} at 0 {probe}" if at_zero is not None else ""
            return f"{element}({probe}){rest}"
        number = evaluate(text, values)
        if number is not None and ("{" in text or re.fullmatch(r"[\d.eE+-]+", text)):
            return quantity(number, unit)
        try:
            return quantity(parse_value(text), unit)
        except InvalidValueError:
            return _short(caption(text))

    out: dict[str, tuple[str, str]] = {}
    for inst in sheet.instances:
        symbol = symbols.get(inst.symbol)
        if symbol is None or symbol.spice is None or symbol.power_net is not None:
            continue
        if captions and inst.ref in captions:
            out[inst.ref] = (inst.ref, caption(captions[inst.ref]))
            continue
        element = symbol.spice.element
        params = {**symbol.default_params, **inst.model.params}
        text = ""
        if element == "B":
            current = inst.model.params.get("i")
            out[inst.ref] = (inst.ref, f"I = {_short(caption(current))}" if current else
                             f"V = {_short(caption(params.get('v', '')))}")  # fmt: skip
            continue
        if element in ("V", "I"):
            if "dc" in params and not any(params.get(k) for k in ("ac", "tran")):
                text = params["dc"]
        elif symbol.value_param:
            text = params.get(symbol.value_param, "")
        if text.strip():
            out[inst.ref] = (name(element, text) or inst.ref, value(element, text))
    directives = [d.model_copy(update={"text": model_lines(d.text, values, by_key)})
                  for d in sheet.directives]  # fmt: skip
    return sheet.model_copy(update={"directives": directives}), out


def model_lines(text: str, values: dict[str, float], fields: dict[str, TemplateField]) -> str:
    """``.model devmodel D(IS={is} N={n} ...)`` as ``.model devmodel D`` and lines of
    ``IS 2.52 nA · N 1.752 · RS 0.568 Ω``; other directives as they are."""
    found = _MODEL.match(text)
    if not found:
        return text
    name, kind, body = found.groups()
    items = []
    for token in body.split():
        key, _eq, raw = token.partition("=")
        bare = _BARE.match(raw.strip())
        if bare and bare.group(1) in values:
            field = fields.get(bare.group(1))
            items.append(f"{key} {quantity(values[bare.group(1)], field.unit if field else '')}")
        else:
            items.append(f"{key} {raw}" if raw else key)
    rows = [" · ".join(items[i : i + PER_LINE]) for i in range(0, len(items), PER_LINE)]
    return "\n".join([f".model {name} {kind}", *rows])


def _short(text: str) -> str:
    return text if len(text) <= LONG else text[: LONG - 1] + "…"
