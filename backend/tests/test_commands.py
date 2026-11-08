import pytest
from pydantic import TypeAdapter

from bpt.document.commands import (
    AddObjects,
    AddSheet,
    AnyCommand,
    CommandError,
    MoveObjects,
    RemoveObjects,
    RemoveSheet,
    RenameSheet,
    SetModel,
    SetParameter,
    SetParams,
    SetWirePoints,
    Transaction,
    UpdateDirective,
    UpdateInstance,
    UpdateLabel,
)
from bpt.document.model import Directive, Instance, Label, ModelCard, Project, Sheet, Wire
from bpt.document.session import DocumentSession
from tests.test_netlister import rc_project


def _ids(project: Project) -> dict[str, object]:
    sheet = project.sheets[0]
    return {
        "v1": sheet.instances[0].id,
        "r1": sheet.instances[1].id,
        "wire": sheet.wires[0].id,
        "label": sheet.labels[0].id,
    }


def _commands(project: Project) -> list[AnyCommand]:
    ids = _ids(project)
    directive = Directive(text=".param a=1", at=(0, 0))
    project.sheets[0].directives.append(directive)
    return [
        AddObjects(instances=[Instance(ref="R9", symbol="bpt:resistor", at=(5, 5))],
                   wires=[Wire(points=[(0, 0), (127, 0)])]),
        RemoveObjects(ids=[ids["r1"], ids["wire"]]),
        MoveObjects(ids=[ids["v1"], ids["wire"], ids["label"]], dx=127, dy=-254),
        UpdateInstance(id=ids["r1"], rot=180, mirror=True, ref="R100"),
        SetParams(id=ids["r1"], params={"R": "4k7", "tc1": "1m"}),
        SetParams(id=ids["v1"], params={"tran": None}, model="X"),
        SetWirePoints(id=ids["wire"], points=[(0, 0), (0, 127), (127, 127)]),
        UpdateLabel(id=ids["label"], text="vout", kind="global"),
        UpdateDirective(id=directive.id, text=".param a=2"),
        SetParameter(name="Rload", value="1k"),
        SetModel(name="D1N4148", card=ModelCard(type="d", params={"is": "2.5n"})),
        AddSheet(sheet=Sheet(name="power")),
        RenameSheet(name="root", new_name="main"),
        Transaction(commands=[SetParameter(name="a", value="1"),
                              SetParameter(name="b", value="2")]),
    ]  # fmt: skip


@pytest.mark.parametrize("index", range(14))
def test_command_inverse_restores_document(index: int) -> None:
    project = rc_project()
    command = _commands(project)[index]
    before = project.model_copy(deep=True)
    inverse = command.apply(project)
    assert project != before
    inverse.apply(project)
    assert project == before


def test_commands_round_trip_through_json() -> None:
    adapter = TypeAdapter(AnyCommand)
    for command in _commands(rc_project()):
        assert adapter.validate_json(adapter.dump_json(command)) == command


def test_session_undo_redo_and_revision() -> None:
    session = DocumentSession(rc_project())
    original = session.project.model_copy(deep=True)
    session.execute(SetParameter(name="a", value="1"))
    session.execute(RemoveSheet(name="root"))
    assert session.revision == 2 and not session.project.sheets
    session.undo()
    session.undo()
    assert session.project == original and session.revision == 4
    session.redo()
    assert session.project.parameters == {"a": "1"}
    with pytest.raises(CommandError):
        session.redo()
        session.redo()


def test_failed_transaction_rolls_back() -> None:
    project = rc_project()
    before = project.model_copy(deep=True)
    bad = Transaction(commands=[
        SetParameter(name="a", value="1"),
        AddObjects(labels=[Label(text="x", at=(0, 0))]),
        RemoveObjects(ids=[project.sheets[0].instances[0].id] * 2),  # second removal fails
    ])  # fmt: skip
    with pytest.raises(CommandError):
        bad.apply(project)
    assert project == before


def test_question_mark_refs_are_numbered_on_apply() -> None:
    project = rc_project()  # has V1, R1, C1
    add = AddObjects(instances=[
        Instance(ref="R?", symbol="bpt:resistor", at=(0, 0)),
        Instance(ref="R?", symbol="bpt:resistor", at=(0, 0)),
        Instance(ref="R3", symbol="bpt:resistor", at=(0, 0)),
    ])  # fmt: skip
    add.apply(project)
    refs = sorted(i.ref for i in project.sheets[0].instances if i.ref.startswith("R"))
    assert refs == ["R1", "R2", "R3", "R4"]
    assert add.instances[0].ref == "R?"  # the command itself is not modified


def test_big_sheets_stay_fast() -> None:
    """Import, select-all + move + delete and SVG of ~3000 parts: linear, not quadratic."""
    import time

    from bpt.document.builder import import_netlist
    from bpt.document.commands import MoveObjects, RemoveObjects
    from bpt.document.model import Project, Sheet
    from bpt.document.session import DocumentSession
    from bpt.library.blocks import project_symbols
    from bpt.netlist.spice_parser import parse_netlist
    from bpt.render.svg import render_sheet

    lines = ["t", "V1 n0 0 1"] + [f"R{i} n{i} n{i + 1} 1k\nC{i} n{i + 1} 0 1n" for i in range(1500)]
    session = DocumentSession(Project(name="big", sheets=[Sheet(name="root")]))
    start = time.perf_counter()
    session.execute(import_netlist(session.project, parse_netlist("\n".join(lines) + "\n")))
    sheet = session.project.sheets[0]
    ids = [o.id for kind in ("instances", "wires", "labels") for o in getattr(sheet, kind)]
    session.execute(MoveObjects(sheet="root", ids=ids, dx=127, dy=0))
    render_sheet(sheet, project_symbols(session.project))
    session.execute(RemoveObjects(sheet="root", ids=ids))
    assert not session.project.sheets[0].instances
    assert time.perf_counter() - start < 10  # was minutes before the indexes


def test_names_and_references_are_checked() -> None:
    """The API (agents, scripts) gets the same rules as the inspector."""
    import pytest

    from bpt.document.commands import (
        AddSheet,
        CommandError,
        RenameSheet,
        SetParameter,
        UpdateInstance,
    )
    from bpt.document.model import Instance, Project, Sheet
    from bpt.document.session import DocumentSession

    r1, r2 = Instance(ref="R1", symbol="bpt:resistor", at=(0, 0)), Instance(
        ref="R2", symbol="bpt:resistor", at=(0, 500))  # fmt: skip
    session = DocumentSession(Project(name="p", sheets=[Sheet(name="root", instances=[r1, r2])]))
    for bad in ("", "  ", "a/b", "ROOT"):
        with pytest.raises(CommandError):
            session.execute(AddSheet(sheet=Sheet(name=bad)))
    session.execute(AddSheet(sheet=Sheet(name="filter")))
    with pytest.raises(CommandError, match="already exists"):
        session.execute(RenameSheet(name="filter", new_name="Root"))
    session.execute(RenameSheet(name="filter", new_name="Filter"))  # case change of itself
    for bad in ("", "R 1", "r2"):
        with pytest.raises(CommandError):
            session.execute(UpdateInstance(sheet="root", id=r1.id, ref=bad))
    session.execute(UpdateInstance(sheet="root", id=r1.id, ref="R10"))
    for bad in ("", "a b", "1x"):
        with pytest.raises(CommandError):
            session.execute(SetParameter(name=bad, value="1"))
    session.execute(SetParameter(name="Rload", value="1k"))


def test_sheet_names_are_file_names() -> None:
    """Each sheet is saved as sheets/<name>.json: names must be valid file names."""
    from bpt.document.model import safe_sheet_name, sheet_name_problem

    for bad in ("Filtr 1:2", "a*b", "CON", "nul.txt", "x.", " lead"):
        assert sheet_name_problem(bad), bad
    assert sheet_name_problem("Filter 2~3") is None
    assert safe_sheet_name("C 10u/25V") == "C 10u_25V"
    assert sheet_name_problem(safe_sheet_name("con.txt")) is None


def test_graph_names_are_file_names() -> None:
    import pytest

    from bpt.document.commands import CommandError, SetGraph
    from bpt.document.model import Graph, Project, Sheet
    from bpt.document.session import DocumentSession

    session = DocumentSession(Project(name="p", sheets=[Sheet(name="root")]))
    with pytest.raises(CommandError, match="cannot contain"):
        session.execute(SetGraph(name="V(out)/V(in)", graph=Graph(name="V(out)/V(in)")))
    session.execute(SetGraph(name="Bode", graph=Graph(name="Bode")))
    with pytest.raises(CommandError, match="already exists"):
        session.execute(SetGraph(name="bode", graph=Graph(name="bode")))
