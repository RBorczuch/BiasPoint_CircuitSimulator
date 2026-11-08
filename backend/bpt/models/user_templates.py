"""User templates of equivalent circuits (FR-CMP-9).

A template is a sheet with ports whose parameters are the fields of a form (label, unit,
default, description, required); its blocks' sheets come along. Filling the form makes a
component: a copy of the sheets with the values as the top sheet's parameters. Any part works:
two-terminal passives, transformers (four ports), transistors, integrated circuits.
"""

import re

from bpt.document.ids import new_id
from bpt.document.model import (
    Characteristic,
    Component,
    ComponentKind,
    Project,
    Sheet,
    Template,
    TemplateField,
    UserTemplate,
    safe_sheet_name,
)
from bpt.library.blocks import PREFIX, ports
from bpt.library.builtin import builtin_symbols
from bpt.netlist.ngspice_writer import is_behavioural


class UserTemplateError(ValueError):
    """The sheet or the form cannot make a template / component."""


def collect_sheets(project: Project, top: str) -> list[Sheet]:
    """``top`` and every sheet used inside it as a block, as plain (unowned) copies.

    A component placed inside keeps its identity (``Sheet.component`` of its top sheet): a
    module saved with an IC in it still shows and lists that IC as a part."""
    sheets: list[Sheet] = []
    todo = [top]
    while todo:
        name = todo.pop(0)
        if any(s.name == name for s in sheets):
            continue
        sheet = project.sheet(name)
        keep = sheet.component if sheets else None  # the saved sheet becomes the new part
        sheets.append(sheet.model_copy(update={"owner": None, "component": keep}, deep=True))
        todo += [i.symbol[len(PREFIX) :] for i in sheet.instances if i.symbol.startswith(PREFIX)]
        todo += [v.sheet for v in sheet.variants]  # its other models come along
    return sheets


def symbol_choices(sheet: Sheet) -> list[str]:
    """Built-in symbols whose pins are exactly the sheet's ports (it can look like them)."""
    names = {name for name, _side in ports(sheet)}
    return [sid for sid, s in builtin_symbols().items()
            if s.spice is not None and s.pins and {p.number for p in s.pins} == names]  # fmt: skip


def with_symbol_of(sheet: Sheet, symbol_id: str | None) -> Sheet:
    """The sheet drawn as built-in ``symbol_id`` (same pins), or as it is."""
    if not symbol_id:
        return sheet
    if symbol_id not in symbol_choices(sheet):
        raise UserTemplateError(f"{symbol_id} does not have the sheet's ports as pins")
    ideal = builtin_symbols()[symbol_id]
    drawn = ideal.model_copy(update={
        "id": f"{PREFIX}{sheet.name}", "parasitics": [], "variants": [], "looks": [],
        "default_params": {}, "default_model": None, "value_param": None,
    })  # fmt: skip
    return sheet.model_copy(update={"symbol": drawn})


def make_template(
    project: Project,
    sheet: str,
    library: str,
    name: str,
    *,
    kind: ComponentKind = "other",
    description: str = "",
    fields: list[TemplateField] | None = None,
    symbol: str | None = None,
    changes: str = "",
) -> UserTemplate:
    """A template from a project sheet; ``fields`` describe its parameters (default: all)."""
    try:
        sheets = collect_sheets(project, sheet)
    except KeyError as exc:
        raise UserTemplateError(str(exc)) from exc
    top = sheets[0]
    if not ports(top):
        raise UserTemplateError("the sheet has no ports: add port labels for the part's pins")
    given = {f.key: f for f in fields or []}
    if unknown := [k for k in given if k not in top.parameters]:
        raise UserTemplateError(f"no sheet parameter {', '.join(unknown)}")
    out = []
    # The form's order (as the template editor arranged it), then the other parameters in the
    # sheet's order; the sheet's values are the defaults.
    keys = [k for k in given] + [k for k in top.parameters if k not in given]
    for key in keys:
        f = given.get(key, TemplateField(key=key))
        value = top.parameters[key]
        out.append(f if f.default else f.model_copy(update={"default": value}))
    sheets[0] = with_symbol_of(top, symbol)
    return UserTemplate(id=f"tpl:{library}/{name}", name=name, kind=kind,
                        description=description, fields=out, sheets=sheets,
                        changes=changes)  # fmt: skip


def form_values(template: UserTemplate, form: dict[str, str]) -> dict[str, str]:
    """The filled-in form: defaults where empty; required fields must have a value."""
    values: dict[str, str] = {}
    for f in template.fields:
        value = (form.get(f.key) or "").strip() or f.default.strip()
        if not value:
            if f.required:
                raise UserTemplateError(f"{f.label or f.key} is required")
            continue
        _check_range(f, value)
        values[f.key] = value
    return values


def _check_range(f: TemplateField, value: str) -> None:
    """A number outside the field's minimum / maximum is refused (expressions are not checked)."""
    from bpt.units import InvalidValueError, parse_value

    try:
        number = parse_value(value)
    except InvalidValueError:
        return
    name = f.label or f.key
    for bound, below in ((f.minimum, True), (f.maximum, False)):
        if not bound.strip():
            continue
        try:
            limit = parse_value(bound)
        except InvalidValueError:
            continue
        if (number < limit) if below else (number > limit):
            word = "at least" if below else "at most"
            raise UserTemplateError(f"{name} must be {word} {bound} (got {value})")


def component_from_template(
    template: UserTemplate,
    form: dict[str, str],
    library: str,
    name: str,
    *,
    description: str = "",
    metadata: dict[str, str] | None = None,
    ratings: dict[str, str] | None = None,
    characteristics: list[Characteristic] | None = None,
) -> Component:
    values = form_values(template, form)
    top, *inner = template.sheets
    sheet_name = safe_sheet_name(name)
    renamed = {top.name: sheet_name}
    first = top.model_copy(update={
        "id": new_id(), "name": sheet_name, "parameters": {**top.parameters, **values},
        "symbol": (top.symbol.model_copy(update={"id": f"{PREFIX}{sheet_name}"})
                   if top.symbol else None),
    }, deep=True)  # fmt: skip
    rest = [
        s.model_copy(update={"id": new_id()}, deep=True) for s in inner if s.name not in renamed
    ]
    filled = {k: v for k, v in form.items() if v.strip()}
    return Component(
        id=f"cmp:{library}/{name}", name=name, kind=template.kind,
        description=description or template.description, metadata=dict(metadata or {}),
        ratings=dict(ratings or {}), template=Template(name=template.id, values=filled),
        characteristics=list(characteristics or []), sheets=[first, *rest],
    )  # fmt: skip


def filled_sheet(sheet: Sheet, values: dict[str, str]) -> Sheet:
    """For display: ``{key}`` in part values replaced by the form's values, a nonlinear value
    (``Cnom/(1+(v(1,2)/vhalf)^2)``) shown as what it is: ``C(V)``, ``L(I)``."""

    def fill(key: str, text: str) -> str:
        bare = re.fullmatch(r"\{\s*(\w+)\s*\}", text.strip())
        if bare and bare.group(1) in values:
            return values[bare.group(1)]
        if is_behavioural(text):
            return f"{key}(V)" if re.search(r"\bv\s*\(", text, re.IGNORECASE) else f"{key}(I)"
        return text

    instances = [
        inst.model_copy(update={"model": inst.model.model_copy(update={
            "params": {k: fill(k, v) for k, v in inst.model.params.items()}})})
        for inst in sheet.instances
    ]  # fmt: skip
    return sheet.model_copy(update={"instances": instances})
