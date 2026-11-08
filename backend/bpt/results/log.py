"""Simulator log -> structured messages (severity, parts and nets they mention)."""

import re

from bpt.results.store import LogMessage, Severity

# Lines that mean the analysis failed. "singular matrix" is only a warning: ngspice goes on
# with gmin / source stepping and often converges.
ERROR = re.compile(r"\berror\b|aborted|timestep too small|cannot recover", re.IGNORECASE)
_WARNING = re.compile(r"^warning\b|singular matrix|\bfailed\b", re.IGNORECASE)
_PREFIX = re.compile(r"^(warning|error|note|fatal)\b", re.IGNORECASE)
_NODE = re.compile(r"\bnode\s+([\w.#+-]+)", re.IGNORECASE)
_MODEL = re.compile(r"\.model\s+([^\s(]+)", re.IGNORECASE)
_TOKEN = re.compile(r"[A-Za-z][\w.#]*")
_NOISE = re.compile(
    r"^(note: no compatibility mode|circuit: |doing analysis at temp|using sparse|"
    r"no\. of data rows|reference value)",
    re.IGNORECASE,
)


def parse_log(
    lines: list[str],
    net_names: dict[str, str],
    devices: dict[str, str],
    models: dict[str, list[str]] | None = None,
) -> list[LogMessage]:
    """Classify log lines; repeated lines are merged (``count``).

    net_names: SPICE node -> net name; devices: SPICE element name -> schematic ref;
    models: model name -> refs of the parts using it.
    """
    nets_lower = {k.lower(): v for k, v in net_names.items()}
    devices_lower = {k.lower(): v for k, v in devices.items()}
    models_lower = {k.lower(): v for k, v in (models or {}).items()}
    messages: list[LogMessage] = []
    seen: dict[str, LogMessage] = {}
    for text in _group(lines):
        if text in seen:
            seen[text].count += 1
            continue
        severity: Severity = (
            "error" if ERROR.search(text) else "warning" if _WARNING.search(text) else "info"
        )
        nets = [nets_lower.get(n.lower(), n) for n in _NODE.findall(text)]
        refs: list[str] = []
        for token in _TOKEN.findall(text):
            ref = devices_lower.get(token.lower())
            if ref and ref not in refs and token.lower() not in nets_lower:
                refs.append(ref)
        for model in _MODEL.findall(text):
            refs += [r for r in models_lower.get(model.lower(), []) if r not in refs]
        nets = list(dict.fromkeys(nets))
        message = LogMessage(severity=severity, text=text, refs=refs, nets=nets)
        seen[text] = message
        messages.append(message)
    return messages


def _group(lines: list[str]) -> list[str]:
    """Join multi-line messages: a header ending in ':' takes the plain lines after it."""
    groups: list[list[str]] = []
    for raw in lines:
        text = raw.strip()
        if not text or _NOISE.match(text):
            continue
        if groups and groups[-1][0].endswith(":") and not _PREFIX.match(text):
            groups[-1].append(text)
        else:
            groups.append([text])
    return [" ".join(group) for group in groups]
