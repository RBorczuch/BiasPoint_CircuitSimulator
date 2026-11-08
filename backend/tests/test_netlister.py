from bpt.document.builder import import_netlist
from bpt.document.model import Instance, Junction, Label, ModelRef, Project, Sheet, Wire
from bpt.netlist.netlister import netlist_project
from bpt.netlist.ngspice_writer import write_netlist
from bpt.netlist.spice_parser import parse_netlist


def rc_project() -> Project:
    """V1 -- R1 (rotated) -- C1 to ground; label "out" on the wire between R1 and C1.

    Pins: V1 +(0,-381) -(0,381); R1 at (762,-381) rot 90 -> pins (1143,-381), (381,-381);
    C1 at (1524,0) -> (1524,-381), (1524,381).
    """
    sheet = Sheet(
        name="root",
        instances=[
            Instance(ref="V1", symbol="bpt:vsource", at=(0, 0),
                     model=ModelRef(params={"dc": "0", "tran": "PULSE(0 1 0 1n 1n 1 2)"})),
            Instance(ref="R1", symbol="bpt:resistor", at=(762, -381), rot=90,
                     model=ModelRef(params={"R": "1k"})),
            Instance(ref="C1", symbol="bpt:capacitor", at=(1524, 0),
                     model=ModelRef(params={"C": "1u"})),
            Instance(ref="#GND1", symbol="bpt:gnd", at=(0, 381)),
            Instance(ref="#GND2", symbol="bpt:gnd", at=(1524, 381)),
        ],
        wires=[Wire(points=[(0, -381), (381, -381)]), Wire(points=[(1143, -381), (1524, -381)])],
        labels=[Label(text="out", at=(1300, -381))],  # on the wire interior
    )  # fmt: skip
    return Project(name="rc", sheets=[sheet])


def test_rc_netlist() -> None:
    result = netlist_project(rc_project())
    assert result.ok, result.issues
    lines = write_netlist(result.circuit)
    assert "V1 n001 0 DC 0 PULSE(0 1 0 1n 1n 1 2)" in lines
    assert "R1 out n001 1k" in lines
    assert "C1 out 0 1u" in lines
    assert result.circuit.net_names["out"] == "out"


def test_crossing_wires_connect_only_at_junction() -> None:
    project = rc_project()
    sheet = project.sheets[0]
    # A vertical wire to R2 crossing the output wire does not join the "out" net ...
    sheet.wires.append(Wire(points=[(1400, -600), (1400, -200)]))
    sheet.instances.append(Instance(ref="R2", symbol="bpt:resistor", at=(1400, 181)))
    lines = write_netlist(netlist_project(project).circuit)
    assert any(line.startswith("R2 n002 ") for line in lines)
    # ... until a junction is placed at the crossing.
    sheet.junctions.append(Junction(at=(1400, -381)))
    lines = write_netlist(netlist_project(project).circuit)
    assert any(line.startswith("R2 out ") for line in lines)


def test_erc_reports_unconnected_pin_and_missing_ground() -> None:
    project = rc_project()
    sheet = project.sheets[0]
    sheet.wires.pop()  # R1 no longer reaches C1
    codes = {issue.code for issue in netlist_project(project).issues}
    assert "unconnected-pin" in codes

    sheet.instances = [i for i in sheet.instances if not i.ref.startswith("#GND")]
    codes = {issue.code for issue in netlist_project(project).issues}
    assert "no-ground" in codes


def test_erc_reports_voltage_source_loop() -> None:
    project = rc_project()
    sheet = project.sheets[0]
    sheet.instances.append(Instance(ref="V2", symbol="bpt:vsource", at=(0, 0)))  # parallel to V1
    assert "source-loop" in {issue.code for issue in netlist_project(project).issues}


def test_erc_warns_about_milli_written_as_mega() -> None:
    from bpt.netlist.erc import check_circuit
    from bpt.netlist.ir import CircuitIR, Device

    circuit = CircuitIR(
        devices=[
            Device(ref="V1", element="V", nodes=["a", "0"], params={"tran": "SIN(0 1 1MHz)"}),
            Device(ref="R1", element="R", nodes=["a", "0"], params={"R": "1meg"}),
        ],
        directives=[".ac dec 10 1 2.5M"],
    )
    issues = [i for i in check_circuit(circuit) if i.code == "milli-not-mega"]
    assert [i.refs for i in issues] == [["V1"], []]
    assert '"1MHz" is 1 milli' in issues[0].message


def test_parasitics_expand_into_extra_elements() -> None:
    from bpt.document.builder import import_netlist
    from bpt.netlist.spice_parser import parse_netlist

    project = Project(name="p", sheets=[Sheet(name="root")])
    import_netlist(project, parse_netlist("* t\nV1 in 0 DC 1\nC1 in out 1u\nR1 out 0 1k\n")).apply(
        project
    )
    c1 = next(i for i in project.sheets[0].instances if i.ref == "C1")
    c1.model.params.update({"esr": "10m", "esl": "1n", "rleak": ""})
    lines = write_netlist(netlist_project(project).circuit)
    assert "C1 in _c1_esr 1u" in lines
    assert "RC1_esr _c1_esr _c1_esl 10m" in lines
    assert "LC1_esl _c1_esl out 1n" in lines
    assert not any("rleak" in line.lower() for line in lines)


def test_unreadable_value_is_an_erc_error() -> None:
    project = Project(name="v", sheets=[Sheet(name="root")])
    import_netlist(project, parse_netlist("* v\nV1 in 0 DC 1\nR1 in 0 1k")).apply(project)
    resistor = next(i for i in project.sheets[0].instances if i.ref == "R1")
    resistor.model.params["R"] = "abc"
    issues = netlist_project(project).issues
    assert [i.code for i in issues if i.severity == "error"] == ["bad-value"]
    resistor.model.params["R"] = "{Rload}"
    assert not [i for i in netlist_project(project).issues if i.code == "bad-value"]


def test_sheets_connect_through_global_labels_only() -> None:
    project = Project(name="two", sheets=[Sheet(name="root"), Sheet(name="load")])
    import_netlist(project, parse_netlist("* a\nV1 vin 0 DC 1"), "root").apply(project)
    import_netlist(project, parse_netlist("* b\nR1 vin 0 1k"), "load").apply(project)
    # Local labels "vin" on two sheets are two different nets (named per sheet).
    circuit = netlist_project(project).circuit
    v1, r1 = (next(d for d in circuit.devices if d.ref == ref) for ref in ("V1", "R1"))
    assert v1.nodes[0] != r1.nodes[0]
    for sheet in project.sheets:
        for label in sheet.labels:
            label.kind = "global"
    circuit = netlist_project(project).circuit
    v1, r1 = (next(d for d in circuit.devices if d.ref == ref) for ref in ("V1", "R1"))
    assert v1.nodes[0] == r1.nodes[0]


def test_zero_ohm_resistor_is_a_warning() -> None:
    from bpt.document.builder import import_netlist
    from bpt.document.model import Project, Sheet
    from bpt.document.session import DocumentSession
    from bpt.netlist.netlister import netlist_project
    from bpt.netlist.spice_parser import parse_netlist

    session = DocumentSession(Project(name="p", sheets=[Sheet(name="root")]))
    session.execute(
        import_netlist(session.project, parse_netlist("t\nV1 a 0 5\nR1 a b 0\nR2 b 0 1k\n"))
    )
    issues = netlist_project(session.project).issues
    assert [(i.code, i.severity) for i in issues if i.code == "zero-value"] == [
        ("zero-value", "warning")
    ]


def test_ngspice_scripts_are_never_written() -> None:
    """A .control block (it can run "shell <command>") or .exec from an import is dropped."""
    from bpt.document.model import Directive

    project = rc_project()
    scripts = [".control\nshell calc.exe\n.endc", ".exec shell calc", ".ic V(out)=0", ".control"]
    for text in scripts:
        project.sheets[0].directives.append(Directive(text=text, at=(0, 0)))
    result = netlist_project(project)
    lines = write_netlist(result.circuit)
    assert not [line for line in lines if "shell" in line or "control" in line]
    assert ".ic V(out)=0" in lines and lines[-1] == ".end"  # an unclosed .control too
    assert any(i.code == "script-ignored" for i in result.issues)


def test_refs_differing_only_in_case_are_duplicates() -> None:
    project = rc_project()
    project.sheets[0].instances[2].ref = "r1"  # C1 -> r1 next to R1: one name for ngspice
    issues = netlist_project(project).issues
    assert any(i.code == "duplicate-ref" for i in issues)


def test_vdmos_has_three_nodes() -> None:
    """M with a model and no bulk node (VDMOS, written so by the netlister) reads back."""
    circuit = parse_netlist("t\nM1 d g s IRF530\nM2 d g s b NCH W=1u\nM3 d g s NCH L=1u\n").circuit
    nodes = {d.ref: d.nodes for d in circuit.devices}
    assert nodes == {"M1": ["d", "g", "s"], "M2": ["d", "g", "s", "b"], "M3": ["d", "g", "s"]}


def test_ltspice_series_resistance_becomes_a_parasitic() -> None:
    """LTspice "Rser=" on C / L / V: ngspice ignores it, so it maps to ESR / DCR / Rs."""
    from bpt.document.session import DocumentSession

    session = DocumentSession(Project(name="p", sheets=[Sheet(name="root")]))
    text = "t\nV1 a 0 5 Rser=1\nC1 a b 10u Rser=0.1 Lser=2n\nL1 b 0 1m Rser=0.5 Cpar=10p\n"
    session.execute(import_netlist(session.project, parse_netlist(text)))
    refs = {d.ref: d for d in netlist_project(session.project).circuit.devices}
    assert {"V1_rs", "C1_esr", "C1_esl", "L1_dcr", "L1_cp"} <= set(refs)
    assert refs["C1_esr"].params == {"R": "0.1"}
    assert "rser" not in " ".join(write_netlist(netlist_project(session.project).circuit)).lower()


def test_net_read_by_an_expression_is_connected() -> None:
    """B1 b 0 V=V(a)*2 uses net a: V1 on it is not "not connected" (V3 on its own still is)."""
    from bpt.document.session import DocumentSession

    session = DocumentSession(Project(name="p", sheets=[Sheet(name="root")]))
    text = "t\nV1 a 0 1\nB1 b 0 V=V(a)*2\nR1 b 0 1k\nV3 q 0 1\n"
    session.execute(import_netlist(session.project, parse_netlist(text)))
    open_pins = [i.message for i in netlist_project(session.project).issues
                 if i.code == "unconnected-pin"]  # fmt: skip
    assert open_pins == ["V3: pin + is not connected"]


def test_a_behavioural_current_source_is_not_written_as_a_voltage() -> None:
    """B1 a b I=... imported or typed with ``i``: the symbol's default V=0 must not win."""
    from bpt.document.builder import import_netlist

    project = Project(name="b", sheets=[Sheet(name="root")])
    text = "* b\nV1 a 0 1\nR1 a b 1k\nB1 0 b I=1m*V(a)\nR2 b 0 1k\n"
    import_netlist(project, parse_netlist(text)).apply(project)
    lines = write_netlist(netlist_project(project).circuit)
    assert "B1 0 b I=1m*V(a)" in lines


def test_a_func_directive_comes_before_the_elements_using_it() -> None:
    """ngspice reads a .func only for elements after it ("no such function" otherwise)."""
    parsed = parse_netlist("* f\n.func dbl(x) {2*x}\nV1 a 0 1\nB1 b 0 V=dbl(V(a))\nR1 b 0 1k\n")
    lines = write_netlist(parsed.circuit)
    assert lines.index(".func dbl(x) {2*x}") < next(
        i for i, line in enumerate(lines) if line.startswith("B1")
    )


def test_a_directive_of_several_lines_reaches_ngspice_line_by_line() -> None:
    """ngSpice_Circ takes one line per entry: "a\nb" in one entry loses line b."""
    from bpt.document.model import Directive

    project = Project(name="d", sheets=[Sheet(name="root")])
    import_netlist(project, parse_netlist("* d\nV1 a 0 {x}\nR1 a 0 {y}\n")).apply(project)
    project.sheets[0].directives.append(Directive(text=".param x=1\n.param y=2k", at=(0, 0)))
    lines = write_netlist(netlist_project(project).circuit)
    assert ".param x=1" in lines and ".param y=2k" in lines
    assert all("\n" not in line for line in lines)
