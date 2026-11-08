"""Headless rendering of schematics (SVG, PNG through the native resvg binding)."""

from dataclasses import dataclass, field
from typing import Any

from bpt.document.model import Project, Sheet
from bpt.library.blocks import project_symbols
from bpt.render.svg import render_sheet, sheet_bounds


class RenderError(ValueError):
    pass


@dataclass
class Rendered:
    svg: str
    meta: dict[str, Any] = field(default_factory=dict)


def _sheet(project: Project, name: str) -> Sheet:
    for sheet in project.sheets:
        if sheet.name == name:
            return sheet
    raise RenderError(f"no sheet {name!r}")


def render_target(project: Project, target: str = "schematic", theme: str = "light") -> Rendered:
    """SVG of a capture target: schematic | sheet:<name> | refs:R1,C2.

    ``selection`` and ``window`` only exist in the GUI; headless they fall back to the sheet.
    """
    if not project.sheets:
        raise RenderError("the project has no sheets")
    symbols = project_symbols(project)
    sheet = project.sheets[0]
    box = None
    kind, _, arg = target.partition(":")
    if kind == "sheet":
        sheet = _sheet(project, arg)
    elif kind == "refs":
        wanted = {r.strip().lower() for r in arg.split(",") if r.strip()}
        for candidate in project.sheets:
            box = sheet_bounds(candidate, symbols, wanted)
            if box:
                sheet = candidate
                break
        else:
            raise RenderError(f"no parts {arg!r} on any sheet")
        box.grow(box.min_x, box.min_y, pad=4 * 127)
        box.grow(box.max_x, box.max_y, pad=4 * 127)
    elif kind not in ("schematic", "selection", "window"):
        raise RenderError(f"unknown target {target!r}")
    svg = render_sheet(sheet, symbols, theme, box, standard=project.symbol_standard or "iec")
    bounds = box or sheet_bounds(sheet, symbols)
    meta: dict[str, Any] = {"sheet": sheet.name, "headless": True}
    if bounds:
        meta["width_mm"] = (bounds.max_x - bounds.min_x) / 100
        meta["height_mm"] = (bounds.max_y - bounds.min_y) / 100
        visible = sheet_bounds(sheet, symbols) if box is None else box
        meta["refs"] = sorted(
            i.ref for i in sheet.instances
            if visible and visible.min_x <= i.at[0] <= visible.max_x
            and visible.min_y <= i.at[1] <= visible.max_y
            and not (symbols.get(i.symbol) and symbols[i.symbol].power_net is not None)
        )  # fmt: skip
    return Rendered(svg, meta)


def svg_to_png(svg: str, width: int) -> bytes:
    import bpt_native

    png: bytes = bpt_native.svg_to_png(svg, width)
    return png
