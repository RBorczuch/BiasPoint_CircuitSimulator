import pytest

from bpt.units import InvalidValueError, format_value, normalize_for_spice, parse_value


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("10", 10),
        ("-2.5", -2.5),
        ("1e-3", 1e-3),
        ("10k", 10e3),
        ("1meg", 1e6),
        ("1MEG", 1e6),
        ("1M", 1e-3),  # SPICE: M is milli
        ("100mA", 0.1),
        ("10kΩ", 10e3),
        ("2.2uF", 2.2e-6),
        ("2.2µF", 2.2e-6),
        ("4k7", 4.7e3),
        ("2u2", 2.2e-6),
        ("1meg5", 1.5e6),
        ("1R5", 1.5),
        ("3V3", 3.3),
        ("-4k7", -4.7e3),
        ("3.3V", 3.3),
        ("10mil", 254e-6),
        (" 47 n ", 47e-9),
    ],
)
def test_parse_value(text: str, expected: float) -> None:
    assert parse_value(text) == pytest.approx(expected)


@pytest.mark.parametrize("text", ["", "abc", "{R*2}", "1..2", "k10", "4k7k3"])
def test_parse_value_rejects(text: str) -> None:
    with pytest.raises(InvalidValueError):
        parse_value(text)


def test_format_and_spice_round_trip() -> None:
    assert format_value(4700, "Ω") == "4.7kΩ"
    assert format_value(2.2e-6, "F") == "2.2µF"
    assert format_value(0) == "0"
    for text in ["4k7", "2u2", "1meg", "100m", "33p", "0.5"]:
        spice = normalize_for_spice(text)
        assert parse_value(spice) == pytest.approx(parse_value(text))
    assert normalize_for_spice("1meg") == "1meg"
    assert normalize_for_spice("{Rload*2}") == "{Rload*2}"


def test_format_value_rounds_before_choosing_the_prefix() -> None:
    assert format_value(0.99999, "V") == "1V"
    assert format_value(999.96e-3, "A", 3) == "1A"


@pytest.mark.parametrize(
    ("text", "expected"),
    [("1,5k", 1500.0), ("4,7 n", 4.7e-9), ("-0,25", -0.25), ("2,2uF", 2.2e-6)],
)
def test_decimal_comma(text: str, expected: float) -> None:
    assert parse_value(text) == pytest.approx(expected)
    assert normalize_for_spice(text) == normalize_for_spice(text.replace(",", "."))
