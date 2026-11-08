from bpt.results.log import parse_log

NETS = {"b": "base", "out": "out"}
DEVICES = {"R1": "R1", "D1": "D1", "Q1": "Q1"}


def test_classify_merge_and_link() -> None:
    lines = [
        "Note: No compatibility mode selected!",
        "Warning: singular matrix:  check node b",
        "Warning: singular matrix:  check node b",
        "doAnalyses: TRAN:  Timestep too small; time = 1e-05: trouble with d1-instance d1",
        "Error on line 3 : r1 out 0 xyz",
        "Note: Starting source stepping",
    ]
    messages = parse_log(lines, NETS, DEVICES)
    assert [m.severity for m in messages] == ["warning", "error", "error", "info"]
    assert messages[0].nets == ["base"] and messages[0].count == 2
    assert messages[1].refs == ["D1"]
    assert messages[2].refs == ["R1"] and messages[2].nets == []


def test_multiline_message() -> None:
    lines = [
        "Warning: Model issue on line 3 :",
        ".model dx d(is=10f foo=3) ...",
        "unrecognized parameter (foo) - ignored",
        "Note: Starting source stepping",
    ]
    messages = parse_log(lines, {}, {}, {"Dx": ["D1", "D2"]})
    assert len(messages) == 2
    assert messages[0].severity == "warning" and messages[0].text.endswith("- ignored")
    assert messages[0].refs == ["D1", "D2"]
