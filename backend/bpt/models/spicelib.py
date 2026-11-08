"""Manufacturer SPICE libraries (``.lib``, ``.mod``, ``.sub``, ``.cir``) -> model definitions.

Reads ``.model`` cards and ``.subckt`` blocks written for ngspice, LTspice or PSpice and turns
them into the ngspice dialect, keeping the original text:

* PSpice ``E/G ... VALUE={expr}`` and ``TABLE`` become B sources (``V=`` / ``I=`` / ``pwl``);
  ``IF(c,a,b)`` becomes ``(c) ? (a) : (b)``, ``LIMIT(x,lo,hi)`` ``min(max(x,lo),hi)``;
  ``PARAMS:`` and ``AKO:`` (a model derived from another) are resolved;
* LTspice informational model parameters (``mfg=``, ``Vpk=``...) are dropped;
* top-level ``.param`` / ``.func`` lines used by a subcircuit are copied into it;
* encrypted models (PSpice ``$CDNENCSTART``, LTspice/other encrypted blocks) are reported
  instead of being imported.

What cannot be converted (``LAPLACE``, ``FREQ`` sources, ``.include`` of other files) is kept
and listed in the notes of the model, so the user sees why a simulation may fail.
"""

import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from typing import Literal

from bpt.document.model import ModelCard, SubcktModel

Dialect = Literal["ngspice", "ltspice", "pspice"]

# Parameters LTspice keeps for its part browser; ngspice warns about them (or fails).
_INFO_PARAMS = {
    "mfg", "vpk", "ipk", "iave", "vceo", "icrating", "rds", "qg", "vds", "type", "vfwd",
    "vrev", "vbr", "pdiss", "ron", "qrr", "trr_info",
}  # fmt: skip
_PSPICE_ONLY_PARAMS = {"t_abs", "t_measured", "t_rel_global", "t_rel_local"}
_ENCRYPTED = re.compile(r"\$CDNENCSTART|^\s*\*?\s*#?ENCRYPTED|\.PROTECT\b.*\n.*[^\x00-\x7f]{4}",
                        re.IGNORECASE | re.MULTILINE)  # fmt: skip
_MODEL_TYPES = {
    "d", "npn", "pnp", "nmos", "pmos", "njf", "pjf", "sw", "csw", "vdmos", "nmf", "pmf",
    "r", "c", "l", "res", "cap", "ind", "lpnp", "core",
}  # fmt: skip


@dataclass
class Definition:
    """One model found in a library file."""

    name: str
    kind: Literal["model", "subckt"]
    model: ModelCard | None = None
    subckt: SubcktModel | None = None
    encrypted: bool = False
    notes: list[str] = field(default_factory=list)

    @property
    def summary(self) -> str:
        if self.kind == "model" and self.model is not None:
            return f".model {self.name} {self.model.type} ({len(self.model.params)} parameters)"
        pins = " ".join(self.subckt.pins) if self.subckt else ""
        return f".subckt {self.name} {pins}"


@dataclass
class Parsed:
    dialect: Dialect
    definitions: list[Definition] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)  # file-level remarks


def detect_dialect(text: str) -> Dialect:
    upper = text.upper()
    if "$CDN" in upper or re.search(r"\bVALUE\s*=\s*\{", upper) or "PARAMS:" in text:
        return "pspice"
    if re.search(r"\bMFG\s*=|\bVDMOS\b|\bRSER\s*=|\bUPLIM\(|\bDNLIM\(", upper):
        return "ltspice"
    return "ngspice"


def _logical_lines(text: str) -> list[str]:
    """Join ``+`` continuations, drop comments; keeps everything else as written."""
    out: list[str] = []
    for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = raw.rstrip()
        stripped = line.lstrip()
        if not stripped or stripped.startswith("*"):
            continue
        line = re.split(r"\s;|^;|\s\$\s|\s\$$", line, maxsplit=1)[0].rstrip()  # inline comments
        if not line.strip():
            continue
        if line.lstrip().startswith("+") and out:
            out[-1] += " " + line.lstrip()[1:].strip()
        else:
            out.append(line.strip())
    return out


def _params(text: str) -> dict[str, str]:
    """``A=1 B = {x*2} C=1e-9`` -> dict (keys lower-case, braces kept)."""
    text = re.sub(r"\s*=\s*", "=", text.strip())
    out: dict[str, str] = {}
    for match in re.finditer(r"([A-Za-z_][\w.]*)=(\{[^}]*\}|\"[^\"]*\"|'[^']*'|[^\s,()]+)", text):
        out[match.group(1).lower()] = match.group(2)
    return out


def _model_card(line: str, notes: list[str]) -> tuple[str, ModelCard, str | None] | None:
    """(name, card, AKO base) from a ``.model`` line."""
    match = re.match(r"\.model\s+(\S+)\s+(?:AKO:(\S+)\s+)?([A-Za-z]+)\s*\(?(.*?)\)?\s*$", line,
                     re.IGNORECASE)  # fmt: skip
    if match is None:
        return None
    name, ako, kind, rest = match.groups()
    kind = kind.lower()
    if kind not in _MODEL_TYPES:
        notes.append(f"unknown model type {kind!r}")
    params = {}
    for key, value in _params(rest).items():
        if key in _INFO_PARAMS or key in _PSPICE_ONLY_PARAMS:
            notes.append(f"dropped {key}={value} (not a simulation parameter in ngspice)")
            continue
        params[key] = value.strip("{}") if re.fullmatch(r"\{[\d.eE+-]+\}", value) else value
    return name, ModelCard(type=kind, params=params), ako


def _split_args(text: str) -> list[str]:
    """Top-level comma separated arguments of a function call."""
    depth, start, out = 0, 0, []
    for i, c in enumerate(text):
        if c in "({":
            depth += 1
        elif c in ")}":
            depth -= 1
        elif c == "," and depth == 0:
            out.append(text[start:i].strip())
            start = i + 1
    out.append(text[start:].strip())
    return out


def _replace_calls(expr: str, name: str, build: Callable[[list[str]], str]) -> str:
    """Rewrite every ``name(args)`` call (case-insensitive, nested calls handled).

    The arguments are rewritten first and the search goes on after the replacement, so a call
    ``build`` leaves as it was (wrong number of arguments) is not matched again forever.
    """
    pattern = re.compile(rf"\b{name}\s*\(", re.IGNORECASE)
    out, pos = [], 0
    while (match := pattern.search(expr, pos)) is not None:
        depth, i = 1, match.end()
        while i < len(expr) and depth:
            depth += {"(": 1, ")": -1}.get(expr[i], 0)
            i += 1
        inner = _replace_calls(expr[match.end() : i - 1], name, build)
        out += [expr[pos : match.start()], build(_split_args(inner))]
        pos = i
    return "".join([*out, expr[pos:]])


def convert_expression(expr: str) -> str:
    """PSpice / LTspice behavioural expression -> ngspice B-source expression."""
    expr = _replace_calls(
        expr,
        "IF",
        lambda a: f"(({a[0]}) ? ({a[1]}) : ({a[2]}))" if len(a) == 3 else f"if({','.join(a)})",
    )
    expr = _replace_calls(
        expr,
        "LIMIT",
        lambda a: (
            f"min(max({a[0]},{min_max(a)[0]}),{min_max(a)[1]})"
            if len(a) == 3
            else f"limit({','.join(a)})"
        ),
    )
    expr = _replace_calls(
        expr, "UPLIM", lambda a: f"min({a[0]},{a[1]})" if len(a) == 2 else f"uplim({','.join(a)})"
    )
    expr = _replace_calls(
        expr, "DNLIM", lambda a: f"max({a[0]},{a[1]})" if len(a) == 2 else f"dnlim({','.join(a)})"
    )
    expr = _replace_calls(expr, "TABLE", lambda a: f"pwl({','.join(a)})")
    return expr  # fmt: skip


def min_max(args: list[str]) -> tuple[str, str]:
    """PSpice LIMIT(x, a, b) accepts the bounds in either order."""
    lo, hi = args[1], args[2]
    try:
        if float(lo) > float(hi):
            lo, hi = hi, lo
    except ValueError:
        pass
    return lo, hi


def _convert_element(line: str, notes: list[str]) -> str:
    """One element line of a subcircuit, PSpice / LTspice -> ngspice."""
    head = line[:1].upper()
    if head in ("E", "G"):
        kind = "V" if head == "E" else "I"
        value = re.match(r"(\S+)\s+(\S+)\s+(\S+)\s+VALUE\s*=?\s*\{(.*)\}\s*$", line, re.IGNORECASE)
        if value:
            name, a, b, expr = value.groups()
            return f"B{name[1:]}_{head} {a} {b} {kind}={{{convert_expression(expr)}}}"
        table = re.match(r"(\S+)\s+(\S+)\s+(\S+)\s+TABLE\s*\{(.*?)\}\s*=?\s*(.*)$", line,
                         re.IGNORECASE)  # fmt: skip
        if table:
            name, a, b, expr, pairs = table.groups()
            points = re.findall(r"\(?\s*([^,()\s]+)\s*,\s*([^,()\s]+)\s*\)?", pairs)
            flat = ",".join(f"{x},{y}" for x, y in points)
            return f"B{name[1:]}_{head} {a} {b} {kind}={{pwl({convert_expression(expr)},{flat})}}"
        if re.search(r"\b(LAPLACE|FREQ|CHEBYSHEV)\b", line, re.IGNORECASE):
            notes.append(f"{line.split()[0]}: LAPLACE/FREQ sources are not supported by ngspice")
    if head == "B":
        return re.sub(r"\{(.*)\}", lambda m: "{" + convert_expression(m.group(1)) + "}", line)
    if head in ("R", "C", "L") and re.search(r"\{.*\b(IF|LIMIT|TABLE)\s*\(", line, re.IGNORECASE):
        return re.sub(r"\{(.*)\}", lambda m: "{" + convert_expression(m.group(1)) + "}", line)
    return line


def parse_library(text: str, source: str = "") -> Parsed:
    dialect = detect_dialect(text)
    result = Parsed(dialect=dialect)
    lines = _logical_lines(text)
    globals_: list[str] = []  # top-level .param / .func lines
    cards: dict[str, tuple[ModelCard, str | None, list[str], str]] = {}
    subckts: list[tuple[str, list[str], dict[str, str], list[str], list[str], str]] = []
    seen: set[str] = set()
    i = 0
    while i < len(lines):
        line = lines[i]
        word = line.split()[0].lower()
        if word == ".model":
            notes: list[str] = []
            card = _model_card(line, notes)
            if card is not None and card[0].lower() not in seen:
                seen.add(card[0].lower())
                cards[card[0]] = (card[1], card[2], notes, line)
            i += 1
        elif word == ".subckt":
            header = line.split()
            name = header[1]
            rest = " ".join(header[2:])
            split = re.split(r"\bparams:", rest, maxsplit=1, flags=re.IGNORECASE)
            pins_text = split[0]
            params = _params(split[1]) if len(split) > 1 else {}
            pins = [p for p in pins_text.split() if "=" not in p]
            params |= _params(" ".join(p for p in pins_text.split() if "=" in p))
            body: list[str] = []
            original = [line]
            depth = 1
            i += 1
            while i < len(lines) and depth:
                inner = lines[i]
                first = inner.split()[0].lower()
                original.append(inner)
                if first == ".subckt":
                    depth += 1
                elif first == ".ends":
                    depth -= 1
                    if depth == 0:
                        break
                body.append(inner)
                i += 1
            i += 1
            if name.lower() in seen:
                continue
            seen.add(name.lower())
            notes = []
            converted = [_convert_element(b, notes) if b[:1] != "." else b for b in body]
            subckts.append((name, pins, params, converted, notes, "\n".join(original)))
        elif word in (".param", ".func"):
            globals_.append(line)
            i += 1
        elif word in (".include", ".inc", ".lib") and len(line.split()) > 2:
            result.notes.append(f"{line}: other files are not read; import them separately")
            i += 1
        else:
            i += 1  # .lib/.endl section markers, .end, stray element lines

    encrypted_text = _ENCRYPTED.search(text) is not None
    for model_name, (found, ako, model_notes, card_text) in cards.items():
        if ako:
            base = next((c for n, (c, *_r) in cards.items() if n.lower() == ako.lower()), None)
            if base is None:
                model_notes.append(f"AKO base model {ako} not found")
            else:
                found = ModelCard(type=found.type, params={**base.params, **found.params})
        result.definitions.append(Definition(
            name=model_name, kind="model", notes=model_notes,
            model=found.model_copy(update={"source": source, "original": card_text}),
        ))  # fmt: skip
    for sub_name, pins, sub_params, body, sub_notes, sub_text in subckts:
        used = _used_globals(body, globals_)
        encrypted = encrypted_text and bool(_ENCRYPTED.search(sub_text))
        if encrypted:
            sub_notes.append("encrypted model: only the program it was made for can simulate it")
        result.definitions.append(Definition(
            name=sub_name, kind="subckt", encrypted=encrypted, notes=sub_notes,
            subckt=SubcktModel(pins=pins, params=sub_params, body=used + body, source=source,
                               original=sub_text, notes=list(sub_notes)),
        ))  # fmt: skip
    if encrypted_text and not any(d.encrypted for d in result.definitions):
        result.notes.append("the file contains encrypted parts; they were skipped")
    return result


def _used_globals(body: Iterable[str], globals_: list[str]) -> list[str]:
    text = " ".join(body)
    out = []
    for line in globals_:
        names = re.findall(
            r"([A-Za-z_]\w*)\s*(?:=|\()", line.split(None, 1)[1] if " " in line else ""
        )
        if any(re.search(rf"\b{re.escape(n)}\b", text) for n in names):
            out.append(line)
    return out
