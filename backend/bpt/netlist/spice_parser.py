"""SPICE netlist parser (ngspice-compatible subset) -> CircuitIR + analyses.

Supported: R C L V I E F G H B D Q M J S elements, ``.model``, ``.param``, ``.op``, ``.dc``,
``.ac``, ``.tran``, ``.end``; ``+`` continuation lines, ``*`` and ``;`` / ``$`` comments.
Other dot cards (``.include``, ``.options``, ``.ic``, ``.temp``, ...) are kept as directives.
Subcircuits (``X``, ``.subckt``) and ``.control`` blocks are not supported yet.
"""

import re
from dataclasses import dataclass, field
from typing import cast

from bpt.analysis.spec import AcAnalysis, AnalysisSpec, DcAnalysis, OpAnalysis, TranAnalysis
from bpt.document.model import ModelCard
from bpt.library.builtin import builtin_models
from bpt.library.symbols import ElementKind
from bpt.netlist.ir import CircuitIR, Device


class SpiceSyntaxError(ValueError):
    def __init__(self, line_no: int, message: str) -> None:
        super().__init__(f"line {line_no}: {message}")
        self.line_no = line_no


@dataclass
class ParsedNetlist:
    circuit: CircuitIR
    analyses: list[AnalysisSpec] = field(default_factory=list)


_TRAN_FUNCS = {"sin", "pulse", "pwl", "exp", "sffm", "am", "trnoise", "trrandom"}
_NODE_COUNT = {"R": 2, "C": 2, "L": 2, "V": 2, "I": 2, "B": 2, "E": 4, "G": 4, "F": 2, "H": 2,
               "D": 2, "J": 3, "S": 4}  # fmt: skip
_INLINE_COMMENT = re.compile(r"\s[;$].*$")


def _logical_lines(text: str) -> list[tuple[int, str]]:
    """Join continuation lines and drop comments; keeps the first physical line number."""
    lines: list[tuple[int, str]] = []
    for number, raw in enumerate(text.splitlines(), start=1):
        line = _INLINE_COMMENT.sub("", raw).rstrip()
        stripped = line.strip()
        if number == 1:
            lines.append((number, stripped))  # title
        elif not stripped or stripped.startswith("*"):
            continue
        elif stripped.startswith("+") and len(lines) > 1:
            prev_no, prev = lines[-1]
            lines[-1] = (prev_no, f"{prev} {stripped[1:].strip()}")
        else:
            lines.append((number, stripped))
    return lines


def _tokens(line: str) -> list[str]:
    """Split on whitespace, keeping ``( ... )`` and ``{ ... }`` groups attached to their token."""
    line = re.sub(r"\s*=\s*", "=", line)
    line = re.sub(r"(\w)\s+\(", r"\1(", line)  # "PULSE (0 1)" -> "PULSE(0 1)"
    tokens: list[str] = []
    current, depth = "", 0
    for ch in line:
        if ch in "({":
            depth += 1
        elif ch in ")}":
            depth -= 1
        if ch.isspace() and depth == 0:
            if current:
                tokens.append(current)
            current = ""
        else:
            current += ch
    if current:
        tokens.append(current)
    return tokens


def _key_values(tokens: list[str]) -> dict[str, str]:
    params: dict[str, str] = {}
    for token in tokens:
        key, sep, value = token.partition("=")
        if not sep:
            raise ValueError(f"expected key=value, got {token!r}")
        params[key.lower()] = value
    return params


def _parse_model(tokens: list[str]) -> tuple[str, ModelCard]:
    # .model NAME TYPE(params) | .model NAME TYPE params...
    if len(tokens) < 3:
        raise ValueError(".model needs a name and a type")
    name, rest = tokens[1], " ".join(tokens[2:])
    match = re.match(r"^(\w+)\s*\(?(.*?)\)?$", rest, re.DOTALL)
    if not match:
        raise ValueError(f"cannot parse model {rest!r}")
    model_type, params_text = match.groups()
    params = _key_values(_tokens(params_text.replace(",", " "))) if params_text.strip() else {}
    return name, ModelCard(type=model_type.lower(), params=params)


def source_params(text: str) -> dict[str, str]:
    """Source parameters from SPICE text: "dc 5 ac 1 pulse(0 5 0 1n 1n 1m 2m)"."""
    return _source_params(_tokens(text))


def _source_params(tokens: list[str]) -> dict[str, str]:
    params: dict[str, str] = {}
    i = 0
    while i < len(tokens):
        token, lowered = tokens[i], tokens[i].lower()
        func = lowered.split("(", 1)[0]
        if lowered == "dc" and i + 1 < len(tokens):
            params["dc"], i = tokens[i + 1], i + 2
        elif lowered == "ac":
            params["ac"] = tokens[i + 1] if i + 1 < len(tokens) else "1"
            i += 2
            if i < len(tokens) and tokens[i].lower().split("(")[0] not in _TRAN_FUNCS | {"dc"}:
                params["acphase"], i = tokens[i], i + 1
        elif func in _TRAN_FUNCS and "(" in token:
            params["tran"], i = token, i + 1
            # PWL(...) r=0 td=1m: the repeat and delay belong to the waveform.
            while (
                func == "pwl" and i < len(tokens) and tokens[i].lower().split("=")[0] in ("r", "td")
            ):
                params["tran"], i = f"{params['tran']} {tokens[i]}", i + 1
        elif "=" in token:
            params.update(_key_values([token]))
            i += 1
        elif "dc" not in params and i == 0:
            params["dc"], i = token, i + 1
        else:
            raise ValueError(f"unexpected source token {token!r}")
    return params


_BEHAVIOURAL_FORM = re.compile(r"^(VALUE|TABLE|POLY|LAPLACE|FREQ)\b", re.IGNORECASE)
_VALUE_FORM = re.compile(r"^VALUE\s*=\s*\{(.*)\}\s*$", re.IGNORECASE | re.DOTALL)


def _behavioural_source(name: str, element: str, args: list[str]) -> Device | None:
    """PSpice-style ``E1 n+ n- VALUE={expr}`` as a B source; other forms are refused."""
    if len(args) < 3 or not _BEHAVIOURAL_FORM.match(args[2]):
        return None
    form = " ".join(args[2:])
    value = _VALUE_FORM.match(form)
    if value is None:
        raise ValueError(
            f"{name}: {args[2].upper()} sources are not supported; write it as a B source "
            f"(B1 n+ n- V={{...}})"
        )
    nodes = ["0" if node.lower() == "gnd" else node for node in args[:2]]
    key = "v" if element == "E" else "i"
    return Device(ref=name, element="B", nodes=nodes, params={key: value.group(1).strip()})


# LTspice instance parameters of non-ideal parts -> the parasitics of BiasPoint's symbols.
# ngspice does not know them: "C1 a b 10u Rser=0.1" simulated as an ideal capacitor.
_LTSPICE_PARASITICS = {
    "C": {"rser": "esr", "lser": "esl", "rpar": "rleak"},
    "L": {"rser": "dcr", "cpar": "cp", "rpar": "rp"},
    "V": {"rser": "rs"},
}


def _ltspice_parasitics(device: Device) -> Device:
    renames = _LTSPICE_PARASITICS.get(device.element, {})
    params = {renames.get(key, key): value for key, value in device.params.items()}
    return device.model_copy(update={"params": params})


def _parse_element(tokens: list[str], models: set[str]) -> Device:
    name = tokens[0]
    element = name[0].upper()
    args = tokens[1:]
    if element in ("E", "G") and (converted := _behavioural_source(name, element, args)):
        return converted
    if element == "Q":  # c b e [substrate] model [params]
        count = 3 if len(args) <= 4 or args[3].lower() in models else 4
    elif element == "M":  # d g s [b] model; VDMOS has no bulk node
        vdmos = len(args) == 4 or (len(args) > 4 and (args[3].lower() in models or "=" in args[4]))
        count = 3 if vdmos else 4
    elif element in _NODE_COUNT:
        count = _NODE_COUNT[element]
    elif element == "X":
        raise ValueError("subcircuits (X) are not supported yet")
    else:
        raise ValueError(f"unsupported element type {element!r}")
    if len(args) < count:
        raise ValueError(f"{name}: expected {count} nodes")
    nodes = ["0" if node.lower() == "gnd" else node for node in args[:count]]
    rest = args[count:]
    params: dict[str, str] = {}
    model: str | None = None
    match element:
        case "R" | "C" | "L":
            if not rest:
                raise ValueError(f"{name}: missing value")
            params = {element: rest[0], **_key_values(rest[1:])}
        case "V" | "I":
            params = _source_params(rest)
        case "E" | "G":
            params = {"gain": rest[0]} if rest else {}
        case "F" | "H":
            if len(rest) < 2:
                raise ValueError(f"{name}: expected controlling source and gain")
            params = {"source": rest[0], "gain": rest[1]}
        case "B":
            params = _key_values(rest)
        case "D" | "Q" | "M" | "J" | "S":
            if not rest:
                raise ValueError(f"{name}: missing model")
            model, extra = rest[0], rest[1:]
            if extra and "=" not in extra[0] and element in ("D", "Q", "J"):
                params["area"], extra = extra[0], extra[1:]  # positional area factor
            params.update(_key_values(extra))
    return Device(
        ref=name, element=cast(ElementKind, element), nodes=nodes, params=params, model=model
    )


def _parse_analysis(card: str, tokens: list[str]) -> AnalysisSpec:
    args = tokens[1:]
    match card:
        case ".op":
            return OpAnalysis()
        case ".dc":
            if len(args) not in (4, 8):
                raise ValueError(
                    ".dc takes a source, start, stop and step, and optionally a second source "
                    "with its start, stop and step (a family of curves)"
                )
            second: list[str | None] = [*args[4:]] or [None] * 4
            return DcAnalysis(source=args[0], start=args[1], stop=args[2], step=args[3],
                              source2=second[0], start2=second[1], stop2=second[2],
                              step2=second[3])  # fmt: skip
        case ".ac":
            variation = args[0].lower()
            if variation not in ("dec", "oct", "lin"):
                raise ValueError(f"unknown AC variation {args[0]!r}")
            return AcAnalysis(
                variation=variation,  # type: ignore[arg-type]
                points=int(float(args[1])),
                fstart=args[2],
                fstop=args[3],
            )
        case _:  # .tran
            uic = any(a.lower() == "uic" for a in args)
            values = [a for a in args if a.lower() != "uic"]
            return TranAnalysis(
                tstep=values[0],
                tstop=values[1],
                tstart=values[2] if len(values) > 2 else "0",
                tmax=values[3] if len(values) > 3 else None,
                uic=uic,
            )


def parse_netlist(text: str) -> ParsedNetlist:
    lines = _logical_lines(text)
    if not lines:
        raise SpiceSyntaxError(1, "empty netlist")
    circuit = CircuitIR(title=lines[0][1] or "untitled")
    parsed = ParsedNetlist(circuit=circuit)
    model_names = {name.lower() for name in builtin_models()} | {
        line.split()[1].lower()
        for _n, line in lines[1:]
        if line.lower().startswith(".model") and len(line.split()) > 1
    }
    in_control = False
    for line_no, line in lines[1:]:
        tokens = _tokens(line)
        card = tokens[0].lower()
        try:
            if in_control:
                in_control = card != ".endc"
            elif card == ".control":
                in_control = True
            elif card == ".end":
                break
            elif card == ".model":
                name, model_card = _parse_model(tokens)
                circuit.models[name] = model_card
            elif card == ".param":
                for key, value in _key_values(tokens[1:]).items():
                    circuit.parameters[key] = value
            elif card in (".op", ".dc", ".ac", ".tran"):
                parsed.analyses.append(_parse_analysis(card, tokens))
            elif card in (".subckt", ".ends"):
                raise ValueError("subcircuits are not supported yet")
            elif card.startswith("."):
                circuit.directives.append(line)
            else:
                circuit.devices.append(_ltspice_parasitics(_parse_element(tokens, model_names)))
        except (ValueError, IndexError) as exc:
            raise SpiceSyntaxError(line_no, str(exc) or "syntax error") from exc
    builtin = builtin_models()
    for device in circuit.devices:  # referenced default models (NPN, D, ...) like in projects
        if device.model and device.model not in circuit.models and device.model in builtin:
            circuit.models[device.model] = builtin[device.model]
    circuit.net_names = {
        node.lower(): node for device in circuit.devices for node in device.nodes if node != "0"
    }
    return parsed


def parse_analysis_card(text: str) -> AnalysisSpec:
    """Parse one analysis card such as ``.tran 10u 5m`` or ``.ac dec 20 1 1meg``."""
    tokens = _tokens(text.strip())
    card = tokens[0].lower() if tokens else ""
    if not card.startswith("."):
        card = "." + card
    if card not in (".op", ".dc", ".ac", ".tran"):
        raise SpiceSyntaxError(1, f"unknown analysis {text!r}; use .op, .dc, .ac or .tran")
    try:
        return _parse_analysis(card, tokens)
    except (ValueError, IndexError) as exc:
        raise SpiceSyntaxError(1, f"cannot parse {text!r}: {exc}") from exc
