"""Short descriptions of document commands for the history panel ("Add R1, 2 wires")."""

from typing import Any
from uuid import UUID

from bpt.document.model import Project

_KINDS = ("instances", "wires", "junctions", "labels", "directives")


def _names(project: Project, ids: list[UUID]) -> list[str]:
    """Parts by reference, the rest counted by kind: ["R1", "2 wires"]."""
    wanted = set(ids)
    refs: list[str] = []
    counts: dict[str, int] = {}
    for sheet in project.sheets:
        for kind in _KINDS:
            for item in getattr(sheet, kind):
                if item.id not in wanted:
                    continue
                if kind == "instances":
                    refs.append(item.ref)
                elif kind == "labels":
                    refs.append(f"label {item.text}")
                else:
                    counts[kind] = counts.get(kind, 0) + 1
    singular = {"wires": "wire", "junctions": "junction", "directives": "directive"}
    extra = [f"{n} {kind}" if n > 1 else f"a {singular[kind]}" for kind, n in counts.items()]
    return refs + extra


def _list(names: list[str], limit: int = 4) -> str:
    if not names:
        return "objects"
    shown = ", ".join(names[:limit])
    return shown if len(names) <= limit else f"{shown} and {len(names) - limit} more"


def _ref(project: Project, object_id: Any) -> str:
    names = _names(project, [object_id])
    return names[0] if names else "a part"


def describe(command: Any, project: Project, before: bool) -> str | None:
    """Label of ``command``; ``before`` = the project is still as it was before the command.

    Returns None when the description needs the other state (added objects are named after
    they exist, removed ones before they go).
    """
    kind = getattr(command, "type", "")
    if kind == "add_objects":
        if before:
            return None
        ids = [item.id for k in _KINDS for item in getattr(command, k)]
        return f"Add {_list(_names(project, ids))}"
    if not before:
        return None
    match kind:
        case "remove_objects":
            return f"Delete {_list(_names(project, list(command.ids)))}"
        case "move_objects":
            return f"Move {_list(_names(project, list(command.ids)))}"
        case "update_instance":
            name = _ref(project, command.id)
            if command.ref is not None:
                return f"Rename {name} to {command.ref}"
            if command.rot is not None:
                return f"Rotate {name}"
            if command.mirror is not None:
                return f"Mirror {name}"
            if command.look is not None:
                return f"Change the drawing of {name}"
            if command.symbol is not None:
                return f"Change the symbol of {name}"
            if command.ratings is not None:
                return f"Ratings of {name}"
            return f"Move {name}"
        case "set_params":
            values = ", ".join(f"{k}={v}" if v is not None else f"no {k}"
                               for k, v in command.params.items())  # fmt: skip
            what = values or "model"
            return f"Set {_ref(project, command.id)}: {what}"
        case "set_wire_points":
            return "Edit a wire"
        case "update_label":
            return "Edit a label"
        case "update_directive":
            return "Edit a directive"
        case "set_parameter":
            where = f" of sheet {command.sheet}" if command.sheet else ""
            if command.value is None:
                return f"Remove parameter {command.name}{where}"
            return f"Parameter {command.name} = {command.value}{where}"
        case "set_model" | "set_subcircuit":
            return f"Model {command.name}"
        case "set_simulation":
            return "Analysis settings"
        case "set_stress_rules":
            return "Stress margins"
        case "set_graph":
            return f"Graph {command.name}" if command.graph else f"Delete graph {command.name}"
        case "add_sheet":
            return f"Add sheet {command.sheet.name}"
        case "remove_sheet":
            return f"Delete sheet {command.name}"
        case "rename_sheet":
            return f"Rename sheet {command.name} to {command.new_name}"
        case "set_symbol":
            return f"Library part {command.id.split('/')[-1]}"
        case "set_symbol_link":
            part = command.id.split("/")[-1]
            return f"{part} follows its library" if command.linked else f"{part} as a copy"
        case "set_port_layout":
            return f"Block pins of {command.sheet}"
        case "set_sheet_symbol":
            return f"Block symbol of {command.sheet}"
        case "restore_project":
            return f"Back to snapshot {command.label}".strip()
        case "transaction":
            if command.label:
                return str(command.label)[:1].upper() + str(command.label)[1:]
            labels = [describe(c, project, True) for c in command.commands]
            known = [label for label in labels if label]
            if len(command.commands) == 1 and known:
                return known[0]
            return f"{len(command.commands)} changes" + (f": {known[0]}…" if known else "")
    return kind.replace("_", " ").capitalize() or "Change"
