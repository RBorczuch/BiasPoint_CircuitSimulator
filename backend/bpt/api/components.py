"""Equivalent-circuit templates (built-in and user, FR-CMP-2 / 9), fitting, component cards."""

import shutil
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Literal

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from bpt.api.projects import State
from bpt.document.model import (
    Characteristic,
    Component,
    ComponentKind,
    ModelCard,
    Project,
    SubcktModel,
    TemplateField,
    UserTemplate,
)
from bpt.library.builtin import builtin_symbols
from bpt.library.symbols import Symbol
from bpt.models import bench
from bpt.models import templates as tpl
from bpt.models import user_templates as utpl
from bpt.models.card import Card, CardCurve, compute_card
from bpt.models.fit import Bounds, FitError, FitResult, fit_sheet, fit_template
from bpt.models.multiport_fit import fit_multiport, is_multiport
from bpt.models.semi_fit import fit_bjt, fit_diode, fit_mosfet
from bpt.units import InvalidValueError, parse_value

router = APIRouter(prefix="/api/components", tags=["components"])


from bpt.library.categories import component_category, template_category  # noqa: E402


class TemplateInfo(BaseModel):
    name: str  # the id: a built-in name ("capacitor") or "tpl:<library>/<name>"
    label: str
    kind: str
    symbol: str  # built-in symbol it looks like ("" = its own drawing or a box)
    description: str
    main: str  # field shown as the value ("" = none)
    fields: list[TemplateField]
    library: str  # "" for the built-in ones
    ports: list[str]
    version: int = 1
    category: str = ""  # where the library offers it ("Capacitors/Ceramic")


def _user_info(t: UserTemplate) -> TemplateInfo:
    from bpt.library.blocks import ports

    top = t.sheets[0]
    return TemplateInfo(
        name=t.id, label=t.name, kind=t.kind, symbol="", description=t.description, main="",
        fields=t.fields, library=t.id.removeprefix("tpl:").split("/")[0],
        ports=[name for name, _side in ports(top)], version=t.version,
        category=t.category or component_category("", t.id, t.kind),
    )  # fmt: skip


@router.get("/templates")
def templates() -> list[TemplateInfo]:
    """Built-in templates first, then those of the libraries (standard examples included)."""
    from bpt.library import libraries

    builtin = [
        TemplateInfo(
            name=t.name,
            label=t.label,
            kind=t.kind,
            symbol=t.symbol,
            description=t.description,
            main=t.main,
            fields=[TemplateField(**f.__dict__) for f in t.fields],
            library="",
            ports=["1", "2"],
            category=template_category(t.name),
        )
        for t in tpl.TEMPLATES.values()
    ]
    return builtin + [_user_info(t) for t in libraries.all_templates().values()]


def _user_template(name: str) -> UserTemplate | None:
    from bpt.library import libraries

    if not name.startswith("tpl:"):
        return None
    template = libraries.all_templates().get(name)
    if template is None:
        raise HTTPException(404, f"no template {name}")
    return template


class TemplateForm(BaseModel):
    template: str
    form: dict[str, str]
    fmin: float = 10.0
    fmax: float = 1e9
    theme: str = "light"


@router.post("/templates/preview")
def preview(body: TemplateForm) -> list[CardCurve]:
    """Characteristics of a filled-in form from the formulas (instant, while typing).

    User templates have no formulas: their characteristics come from ``/templates/card``.
    """
    if body.template.startswith("tpl:"):
        return []
    try:
        template = tpl.get(body.template)
        values = tpl.numbers(template, body.form)
        freqs = np.logspace(np.log10(body.fmin), np.log10(body.fmax), 161)
        z = tpl.impedance(template, values, freqs)
    except tpl.TemplateError as exc:
        raise HTTPException(422, str(exc)) from exc
    f = freqs.tolist()
    out = [
        CardCurve(name="|Z|(f)", x_unit="Hz", y_unit="Ω", x=f, y=np.abs(z).tolist()),
        CardCurve(name="phase(f)", x_unit="Hz", y_unit="°", x=f,
                  y=np.degrees(np.angle(z)).tolist()),
    ]  # fmt: skip
    if template.kind != "resistor":
        out.append(CardCurve(name="ESR(f)", x_unit="Hz", y_unit="Ω", x=f, y=z.real.tolist()))
    if "vhalf" in values:
        volts = np.linspace(0, 3 * values["vhalf"], 31)
        out.append(CardCurve(name="C(V)", x_unit="V", y_unit="F", x=volts.tolist(),
                             y=tpl.capacitance(template, values, volts).tolist()))  # fmt: skip
    if "isat" in values:
        amps = np.linspace(0, 3 * values["isat"], 31)
        out.append(CardCurve(name="L(I)", x_unit="A", y_unit="H", x=amps.tolist(),
                             y=tpl.inductance(template, values, amps).tolist()))  # fmt: skip
    return out


def _component(body: "TemplateForm | TemplateSave", library: str = "preview",
               name: str = "part") -> Component:  # fmt: skip
    """The component a filled-in form makes (built-in or user template)."""
    try:
        user = _user_template(body.template)
        if user is not None:
            return utpl.component_from_template(user, body.form, library, name)
        return tpl.template_component(tpl.get(body.template), body.form, library, name)
    except (tpl.TemplateError, utpl.UserTemplateError) as exc:
        raise HTTPException(422, str(exc)) from exc


def with_look(component: Component, look: str) -> Component:
    """The component drawn as ``look`` of its symbol ("" = its basic drawing)."""
    top = component.sheets[0]
    if top.symbol is None:
        return component
    base = builtin_symbols().get(_like(top.symbol), top.symbol)
    if not look:
        graphics = base.graphics
    else:
        found = next((lk for lk in [*base.looks, *top.symbol.looks] if lk.name == look), None)
        if found is None:
            raise HTTPException(422, f"no look {look!r} for {base.name}")
        graphics = found.graphics
    symbol = top.symbol.model_copy(update={"graphics": graphics})
    sheets = [top.model_copy(update={"symbol": symbol}), *component.sheets[1:]]
    return component.model_copy(update={"sheets": sheets})


def _keeps_drawing(previous: Component, fresh: Component) -> bool:
    """Whether a new version can keep the saved part's drawing (a look chosen, a box, another
    symbol): it has the same pins."""
    old, new = previous.sheets[0].symbol, fresh.sheets[0].symbol
    if old is None or new is None:
        return True  # a box (or a box before): its pins follow the ports
    return sorted(p.number for p in old.pins) == sorted(p.number for p in new.pins)


def _like(symbol: Symbol) -> str:
    """The built-in symbol a part's drawing comes from: same pins and reference letter."""
    numbers = sorted(p.number for p in symbol.pins)
    for sid, s in builtin_symbols().items():
        if sorted(p.number for p in s.pins) == numbers and s.ref_prefix == symbol.ref_prefix:
            return sid
    return ""


class Circuit(BaseModel):
    svg: str  # the equivalent circuit with the form's values written in
    ports: list[str]
    parameters: dict[str, str]


@router.post("/templates/circuit")
def circuit(body: TemplateForm) -> Circuit:
    """The equivalent circuit of a filled-in template, drawn (for the template's preview)."""
    from bpt.library.blocks import ports, project_symbols
    from bpt.models.circuit_view import readable
    from bpt.models.standard_templates import CAPTIONS
    from bpt.render.svg import render_sheet

    component = _component(body)
    project = Project(name="preview", sheets=component.sheets)
    top = component.sheets[0]
    user = _user_template(body.template)
    fields = user.fields if user else [TemplateField(key=f.key, label=f.label, unit=f.unit)
                                       for f in tpl.get(body.template).fields]  # fmt: skip
    symbols = project_symbols(project)
    # For reading: parts named by their fields, values with units, formulas computed, the
    # .model line spelled out.
    shown, texts = readable(top, symbols, fields, CAPTIONS.get(body.template))
    return Circuit(svg=render_sheet(shown, symbols, body.theme, texts=texts, fit_texts=True),
                   ports=[n for n, _s in ports(top)], parameters=top.parameters)  # fmt: skip


@router.post("/templates/card")
def template_card(body: TemplateForm, state: State) -> Card:
    """Characteristics of a filled-in template by simulation (user templates, any kind)."""
    component = _component(body)
    project = Project(name="card", sheets=component.sheets)
    try:
        with _runner(state) as run:
            return compute_card(run, project, component.sheets[0].name, component)
    except bench.BenchError as exc:
        raise HTTPException(422, str(exc)) from exc


class TemplateFit(BaseModel):
    template: str
    form: dict[str, str]
    free: list[str]
    characteristics: list[Characteristic]
    # field -> [min, max] (values with units, "" = open)
    bounds: dict[str, tuple[str, str]] = Field(default_factory=dict)


def _bounds(texts: dict[str, tuple[str, str]]) -> Bounds:
    out: Bounds = {}
    for key, pair in texts.items():
        try:
            out[key] = (parse_value(pair[0]) if pair[0].strip() else None,
                        parse_value(pair[1]) if pair[1].strip() else None)  # fmt: skip
        except InvalidValueError as exc:
            raise FitError(f"bounds of {key}: {exc}") from exc
    return out


_DEVICES = {" NMOS(": ("mos", 1), " PMOS(": ("mos", -1), " NPN(": ("bjt", 1),
            " PNP(": ("bjt", -1)}  # fmt: skip


def _device(template: UserTemplate) -> tuple[str, int] | None:
    """("mos" | "bjt", 1 | -1) of a transistor template by its .model line, else None."""
    for sheet in template.sheets[:1]:
        for directive in sheet.directives:
            text = directive.text.upper()
            for marker, device in _DEVICES.items():
                if marker in text:
                    return device
    return None


@router.post("/templates/fit")
def fit(body: TemplateFit, state: State) -> FitResult:
    """Fit the free fields of a template to characteristic points.

    Built-in templates by their formulas; user templates (two pins) by simulation.
    """
    try:
        user = _user_template(body.template)
        if user is None:
            return fit_template(body.template, body.form, body.free, body.characteristics,
                                _bounds(body.bounds))  # fmt: skip
        values = utpl.form_values(user, body.form)
        if user.kind == "diode":  # SPICE parameters: by the model's formulas
            return fit_diode(values, body.free, body.characteristics, _bounds(body.bounds))
        if (device := _device(user)) is not None:
            kind, sign = device
            fitter = fit_mosfet if kind == "mos" else fit_bjt
            return fitter(values, body.free, body.characteristics, _bounds(body.bounds), sign)
        if missing := [k for k in body.free if k not in values]:
            raise FitError(f"give a starting value for {', '.join(missing)}")
        component = utpl.component_from_template(user, body.form, "fit", "part")
        project = Project(name="fit", sheets=component.sheets)
        if is_multiport(project, "part", user.kind):
            with _runner(state) as run:
                return fit_multiport(run, project, "part", user.kind, values, body.free,
                                     body.characteristics, _bounds(body.bounds))  # fmt: skip
        drive: Literal["v", "i"] = "i" if user.kind == "inductor" else "v"
        with _runner(state) as run:
            start = {k: values[k] for k in body.free}
            result = fit_sheet(run, project, "part", start, body.characteristics, drive,
                               bounds=_bounds(body.bounds))  # fmt: skip
        result.values = {**{k: v for k, v in body.form.items() if v.strip()}, **result.values}
        return result
    except (FitError, tpl.TemplateError, utpl.UserTemplateError, bench.BenchError) as exc:
        raise HTTPException(422, str(exc)) from exc


class TemplateSave(BaseModel):
    template: str
    form: dict[str, str]
    library: str
    name: str
    description: str = ""
    category: str = ""  # where the library lists it ("" = from the template)
    look: str | None = None  # another drawing of the template's symbol (polarized, Schottky)
    metadata: dict[str, str] = Field(default_factory=dict)
    ratings: dict[str, str] = Field(default_factory=dict)
    characteristics: list[Characteristic] = Field(default_factory=list)
    changes: str = ""


@router.post("/from-template")
def save_from_template(body: TemplateSave) -> Component:
    """Save a filled-in template (built-in or user) as a component of a user library."""
    from bpt.library import libraries

    name, library_name = body.name.strip(), body.library.strip()
    if not name or not library_name:
        raise HTTPException(422, "a name and a library are required")
    component = _component(body, library_name, name)
    component = component.model_copy(update={
        "description": body.description or component.description, "metadata": body.metadata,
        "ratings": body.ratings, "characteristics": body.characteristics,
        "changes": body.changes, "category": body.category.strip(),
    })  # fmt: skip
    try:
        library = libraries.load(library_name)
    except OSError:
        library = libraries.Library(name=library_name, source="components")
    previous = next((c for c in library.components if c.id == component.id), None)
    if body.look is not None:
        component = with_look(component, body.look)
    elif previous is not None and _keeps_drawing(previous, component):
        # The drawing chosen before (a look, a box, another symbol) stays in the new version.
        top = component.sheets[0].model_copy(update={"symbol": previous.sheets[0].symbol})
        component = component.model_copy(update={"sheets": [top, *component.sheets[1:]]})
    library.components = [c for c in library.components if c.id != component.id] + [component]
    libraries.save(library)
    return next(c for c in libraries.load(library_name).components if c.id == component.id)


class UserTemplateSave(BaseModel):
    project_id: str
    sheet: str  # the top sheet: ports = pins, parameters = fields
    library: str
    name: str
    kind: ComponentKind = "other"
    description: str = ""
    fields: list[TemplateField] = Field(default_factory=list)
    symbol: str | None = None  # draw it as this built-in symbol (same pins)
    changes: str = ""
    category: str = ""  # where the library offers it ("" = from its kind)
    # False: a new template, refused when the library has one of that name (409).
    replace: bool = True


@router.post("/templates")
def save_template(body: UserTemplateSave, state: State) -> UserTemplate:
    """Save a sheet as a template of a user library (FR-CMP-9)."""
    from bpt.library import libraries

    name, library_name = body.name.strip(), body.library.strip()
    if not name or not library_name:
        raise HTTPException(422, "a name and a library are required")
    try:
        project = state.get(body.project_id).session.project
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    try:
        template = utpl.make_template(
            project, body.sheet, library_name, name, kind=body.kind,
            description=body.description, fields=body.fields, symbol=body.symbol,
            changes=body.changes,
        )  # fmt: skip
    except utpl.UserTemplateError as exc:
        raise HTTPException(422, str(exc)) from exc
    # The library's copy: no draft form on its sheets (the template's fields are the form).
    sheets = [s.model_copy(update={"form": []}) for s in template.sheets]
    template = template.model_copy(update={"category": body.category.strip(), "sheets": sheets})
    try:
        library = libraries.load(library_name)
    except OSError:
        library = libraries.Library(name=library_name, source="templates")
    if not body.replace and any(t.id == template.id for t in library.templates):
        raise HTTPException(409, f"{library_name} has a template {name!r} already")
    library.templates = [t for t in library.templates if t.id != template.id] + [template]
    libraries.save(library)
    return next(t for t in libraries.load(library_name).templates if t.id == template.id)


@router.get("/templates/symbols")
def template_symbols(project_id: str, sheet: str, state: State) -> list[str]:
    """Built-in symbols a sheet can be drawn as (their pins are its ports)."""
    try:
        return utpl.symbol_choices(state.get(project_id).session.project.sheet(sheet))
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc


@contextmanager
def _runner(state: State) -> Iterator[bench.Run]:
    """Simulations of a request, in a throwaway result store."""
    root = Path(tempfile.mkdtemp(prefix="bpt-bench-"))
    try:
        yield bench.engine_runner(state.orchestrator.engine, root)
    finally:
        shutil.rmtree(root, ignore_errors=True)


class CardRequest(BaseModel):
    component: str | None = None  # a library component id ...
    project_id: str | None = None  # ... or a sheet of an open project
    sheet: str | None = None
    params: dict[str, str] = Field(default_factory=dict)  # a placed part's overrides
    theme: str = "light"  # of the equivalent-circuit drawing


def _subject(state: State, body: CardRequest) -> tuple[Project, str, Component | None]:
    from bpt.library import libraries

    if body.component:
        component = libraries.all_components().get(body.component)
        if component is None:
            raise HTTPException(404, f"no component {body.component}")
        return Project(name="card", sheets=component.sheets), component.sheets[0].name, component
    if body.project_id and body.sheet:
        try:
            _rev, project = state.get(body.project_id).session.snapshot()
            sheet = project.sheet(body.sheet)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        info = sheet.component
        component = Component(**info.model_dump(), sheets=[]) if info else None
        return project, sheet.name, component
    raise HTTPException(422, "give a component, or a project and a sheet")


@router.post("/card")
def card(body: CardRequest, state: State) -> Card:
    """Characteristics of a component (library or placed) computed by simulation."""
    from bpt.library.blocks import project_symbols
    from bpt.render.svg import render_sheet

    project, top, component = _subject(state, body)
    try:
        with _runner(state) as run:
            result = compute_card(run, project, top, component, body.params)
    except bench.BenchError as exc:
        raise HTTPException(422, str(exc)) from exc
    sheet = project.sheet(top)
    result.parameters = {**sheet.parameters, **{k: v for k, v in body.params.items() if v}}
    shown = utpl.filled_sheet(sheet, result.parameters)  # values written in, not {esr}
    result.circuit = render_sheet(shown, project_symbols(project), body.theme)
    result.labels = _field_labels(component)
    return result


def _field_labels(component: Component | None) -> dict[str, str]:
    """Form labels of the parameters of a component made from a template."""
    from bpt.library import libraries

    name = component.template.name if component and component.template else ""
    if name in tpl.TEMPLATES:
        return {f.key: f.label for f in tpl.TEMPLATES[name].fields}
    user = libraries.all_templates().get(name)
    return {f.key: f.label for f in user.fields if f.label} if user else {}


class SheetFit(BaseModel):
    project_id: str
    sheet: str
    start: dict[str, str]  # sheet parameter -> starting value
    characteristics: list[Characteristic]
    drive: Literal["v", "i"] = "v"  # "i" for inductors
    bounds: dict[str, tuple[str, str]] = Field(default_factory=dict)  # as for templates


@router.post("/fit-sheet")
def fit_own(body: SheetFit, state: State) -> FitResult:
    """Fit parameters of any two-port sheet (an own equivalent circuit) by simulation."""
    try:
        _rev, project = state.get(body.project_id).session.snapshot()
    except KeyError as exc:
        raise HTTPException(404, str(exc)) from exc
    try:
        with _runner(state) as run:
            return fit_sheet(run, project, body.sheet, body.start, body.characteristics,
                             body.drive, bounds=_bounds(body.bounds))  # fmt: skip
    except (FitError, bench.BenchError) as exc:
        raise HTTPException(422, str(exc)) from exc


# -- a model pasted in the inspector (FR-MOD-7) ------------------------------------------------


class PastedModel(BaseModel):
    text: str


class CheckedModel(BaseModel):
    name: str
    kind: Literal["model", "subckt"]
    type: str  # the .model type (d, npn, nmos...) or "subckt"
    pins: list[str] = []
    summary: str
    encrypted: bool = False
    notes: list[str] = []
    card: ModelCard | None = None
    subckt: SubcktModel | None = None
    check: str = ""  # what the simulator said of it ("" = it simulates)
    checked: bool = False  # a check was run (some types have none)


class PastedModels(BaseModel):
    dialect: str
    notes: list[str]
    items: list[CheckedModel]


# A small circuit around each kind of device: enough for ngspice to read the model and solve.
_SMOKE: dict[str, tuple[str, list[tuple[str, str, str, float]]]] = {
    "d": ("D", [("V1", "a", "0", 0.6)]),
    "npn": ("Q", [("VC", "c", "0", 5.0), ("IB", "0", "b", 10e-6)]),
    "pnp": ("Q", [("VC", "c", "0", -5.0), ("IB", "b", "0", 10e-6)]),
    "nmos": ("M", [("VD", "d", "0", 5.0), ("VG", "g", "0", 5.0)]),
    "pmos": ("M", [("VD", "d", "0", -5.0), ("VG", "g", "0", -5.0)]),
    "vdmos": ("M", [("VD", "d", "0", 5.0), ("VG", "g", "0", 5.0)]),
    "njf": ("J", [("VD", "d", "0", 5.0), ("VG", "g", "0", 0.0)]),
    "pjf": ("J", [("VD", "d", "0", -5.0), ("VG", "g", "0", 0.0)]),
}
_NODES = {"D": ["a", "0"], "Q": ["c", "b", "0"], "M": ["d", "g", "0", "0"], "J": ["d", "g", "0"]}


def _smoke(run: bench.Run, name: str, card: ModelCard | None, subckt: SubcktModel | None
           ) -> tuple[bool, str]:  # fmt: skip
    """Whether the model simulates: an operating point of it in a small circuit. A subcircuit
    has each pin to ground through 1 GΩ (only that it reads and solves)."""
    from bpt.analysis.spec import OpAnalysis
    from bpt.netlist.ir import CircuitIR, Device

    circuit = CircuitIR(title=f"check {name}")
    if subckt is not None:
        nodes = [f"p{k}" for k in range(len(subckt.pins))]
        circuit.devices.append(Device(ref="X1", element="X", nodes=nodes, model=name))
        circuit.devices += [Device(ref=f"RP{k}", element="R", nodes=[n, "0"], params={"R": "1G"})
                            for k, n in enumerate(nodes)]  # fmt: skip
        circuit.subckt_models[name] = subckt
    elif card is not None and card.type.lower() in _SMOKE:
        element, sources = _SMOKE[card.type.lower()]
        circuit.devices.append(Device(ref=f"{element}1", element=element,  # type: ignore[arg-type]
                                      nodes=_NODES[element], model=name))  # fmt: skip
        circuit.devices += [bench.source(ref, plus, minus, value)
                            for ref, plus, minus, value in sources]  # fmt: skip
        circuit.models[name] = card
    else:
        return False, ""
    try:
        run(circuit, OpAnalysis())
    except bench.BenchError as exc:
        return True, str(exc)
    return True, ""


def _where(text: str, said: str) -> str:
    """ngspice names the line of the netlist it was given: the line of the pasted text instead,
    found by the element or the parameter the message names."""
    import re

    names = re.findall(r"\[([^\]]+)\]", said)  # Undefined parameter [x]
    element = re.search(r":\s*([\w.]+)\s", said)  # ...: q.x1.q1 p0 p1 0 model could not...
    if element:
        names.append(element.group(1).split(".")[-1])
    for name in names:
        pattern = re.compile(rf"(?<![\w.]){re.escape(name)}(?![\w])", re.IGNORECASE)
        for number, line in enumerate(text.splitlines(), start=1):
            if pattern.search(line) and not line.lstrip().startswith("*"):
                return f"line {number} of the text: {line.strip()} - {said}"
    return said


@router.post("/models/check")
def check_models(body: PastedModel, state: State) -> PastedModels:
    """Models pasted as text (any dialect, converted for ngspice), each tried in the simulator:
    what ngspice says of a model that does not read or solve, with its line."""
    from bpt.models.spicelib import parse_library

    if not body.text.strip():
        raise HTTPException(422, "paste a .model or .subckt")
    if len(body.text) > 2_000_000:
        raise HTTPException(422, "the text is too long for a model")
    parsed = parse_library(body.text, source="pasted")
    items: list[CheckedModel] = []
    with _runner(state) as run:
        for d in parsed.definitions:
            checked, said = (False, "") if d.encrypted else _smoke(run, d.name, d.model, d.subckt)
            said = _where(body.text, said) if said else ""
            items.append(CheckedModel(
                name=d.name, kind=d.kind,
                type=d.model.type if d.model is not None else "subckt",
                pins=d.subckt.pins if d.subckt is not None else [], summary=d.summary,
                encrypted=d.encrypted, notes=d.notes, card=d.model, subckt=d.subckt,
                check=said, checked=checked,
            ))  # fmt: skip
    notes = list(parsed.notes)
    if not items:
        notes.append("no .model or .subckt found (a .subckt needs its .ends)")
    return PastedModels(dialect=parsed.dialect, notes=notes, items=items)


# -- a transfer function block H(s) (FR-MOD-8) -------------------------------------------------


class TransferText(BaseModel):
    h: str


class TransferPreview(BaseModel):
    num: list[float] = []  # coefficients, highest power of s first
    den: list[float] = []
    error: str = ""
    f: list[float] = []
    magnitude_db: list[float] = []
    phase: list[float] = []


@router.post("/transfer")
def transfer_preview(body: TransferText) -> TransferPreview:
    """H(s) read as a ratio of polynomials, with its Bode plot (or why it cannot be read)."""
    from bpt.models.transfer import TransferError, corner_span, parse_transfer, response

    try:
        num, den = parse_transfer(body.h)
    except TransferError as exc:
        return TransferPreview(error=str(exc))
    lo, hi = corner_span(num, den)
    f = np.logspace(np.log10(lo), np.log10(hi), 201)
    h = response(num, den, f)
    return TransferPreview(num=num, den=den, f=f.tolist(),
                           magnitude_db=(20 * np.log10(np.maximum(np.abs(h), 1e-300))).tolist(),
                           phase=np.degrees(np.unwrap(np.angle(h))).tolist())  # fmt: skip


# -- an equation-defined device (FR-MOD-9) ------------------------------------------------------


class EquationBranch(BaseModel):
    current: str = ""  # into its pin Pk (V1..VN: the branch voltages)
    charge: str = ""


class EquationDevice(BaseModel):
    project_id: str
    name: str
    branches: list[EquationBranch]
    parameters: dict[str, str] = Field(default_factory=dict)


class EquationResult(BaseModel):
    problems: list[str] = []  # what is wrong (nothing was added)
    sheet: str = ""  # the sheet added, to place as a block
    revision: int = 0


@router.post("/equation-device")
def equation_device(body: EquationDevice, state: State) -> EquationResult:
    """An equation-defined device as a new sheet of the project, after ngspice has read it
    (its pins through 1 GOhm to ground): problems instead, one per line, when it cannot."""
    from bpt.api.projects import _execute, _project
    from bpt.document.commands import AddSheet
    from bpt.document.model import safe_sheet_name
    from bpt.models.equations import Branch, device_sheet, problems

    p = _project(state, body.project_id)
    branches = [Branch(b.current, b.charge) for b in body.branches]
    if found := problems(branches, body.parameters):
        return EquationResult(problems=found)
    taken = {s.name.lower() for s in p.session.project.sheets}
    base, n = safe_sheet_name(body.name.strip() or "EDD")[:40], 2
    name = base
    while name.lower() in taken:
        name, n = f"{base[:36]}~{n}", n + 1
    sheet = device_sheet(name, branches, body.parameters)
    trial = Project(name="edd", sheets=[sheet])
    try:
        from bpt.analysis.spec import OpAnalysis
        from bpt.netlist.ir import Device

        nets = {f"P{k}": f"p{k}" for k in range(1, len(branches) + 1)} | {"REF": "0"}
        loads = [Device(ref=f"RCHK{k}", element="R", nodes=[net, "0"], params={"R": "1G"})
                 for k, net in enumerate(nets.values()) if net != "0"]  # fmt: skip
        circuit = bench.port_circuit(trial, name, [(nets, {})], loads)

        with _runner(state) as run:
            run(circuit, OpAnalysis())
    except bench.BenchError as exc:
        return EquationResult(problems=[f"ngspice: {exc}"])
    revision = _execute(p, AddSheet(sheet=sheet))
    return EquationResult(sheet=name, revision=revision)
