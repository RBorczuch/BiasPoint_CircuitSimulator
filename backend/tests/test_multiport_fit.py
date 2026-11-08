"""A transformer and an op-amp fitted to points from a part with known values (real ngspice)."""

import pytest
from fastapi.testclient import TestClient

from tests.test_api import H

pytestmark = pytest.mark.ngspice


def curve(client: TestClient, template: str, form: dict[str, str], name: str,
          picks: list[float]) -> list[tuple[float, float]]:  # fmt: skip
    """The part's own curve at the frequencies ``picks``."""
    r = client.post("/api/components/templates/card",
                    headers=H, json={"template": template, "form": form})  # fmt: skip
    assert r.status_code == 200, r.text
    c = next(c for c in r.json()["curves"] if c["name"] == name)
    out = []
    for f in picks:
        i = min(range(len(c["x"])), key=lambda k: abs(c["x"][k] - f))
        out.append((c["x"][i], c["y"][i]))
    return out


def fit(client: TestClient, template: str, form: dict[str, str], free: list[str],
        chars: list[dict[str, object]]) -> dict[str, object]:  # fmt: skip
    r = client.post("/api/components/templates/fit",
                    headers=H, json={"template": template, "form": form, "free": free,
                          "characteristics": chars, "bounds": {}})  # fmt: skip
    assert r.status_code == 200, r.text
    return dict(r.json())


def number(text: object) -> float:
    from bpt.units import parse_value

    return parse_value(str(text))


def test_a_transformer_finds_its_turns_ratio_and_inductance(client: TestClient) -> None:
    template = "tpl:Standard templates/Real transformer"
    truth = {"lp": "3m", "n": "2"}
    ratio = curve(client, template, truth, "Ratio(f)", [1e3, 1e4, 1e5])
    zin = curve(client, template, truth, "|Zin|(f)", [100.0, 1e3, 1e4])
    result = fit(client, template, {"lp": "1m", "n": "0.5"}, ["lp", "n"],
                 [{"name": "Ratio(f)", "points": ratio},
                  {"name": "|Zin|(f)", "points": zin}])  # fmt: skip
    values = result["values"]
    assert isinstance(values, dict)
    assert number(values["n"]) == pytest.approx(2, rel=0.02)
    assert number(values["lp"]) == pytest.approx(3e-3, rel=0.05)
    assert result["max_error"] < 3


def test_an_op_amp_finds_its_gain_and_bandwidth(client: TestClient) -> None:
    template = "tpl:Standard templates/Op-amp macromodel"
    truth = {"aol": "500k", "gbw": "3meg"}
    points = curve(client, template, truth, "Aol(f)", [0.2, 1.0, 100.0, 1e4, 1e6])
    result = fit(client, template, {"aol": "200k", "gbw": "1meg"}, ["aol", "gbw"],
                 [{"name": "Aol(f)", "points": points}])  # fmt: skip
    values = result["values"]
    assert isinstance(values, dict)
    assert number(values["aol"]) == pytest.approx(500e3, rel=0.05)
    assert number(values["gbw"]) == pytest.approx(3e6, rel=0.05)


def test_a_zero_start_is_refused_with_its_name(client: TestClient) -> None:
    r = client.post("/api/components/templates/fit", headers=H, json={
        "template": "tpl:Standard templates/Op-amp macromodel",
        "form": {"aol": "200k", "gbw": "1meg", "vos": "0"}, "free": ["vos"],
        "characteristics": [{"name": "Aol(f)", "points": [(1.0, 100.0), (1e6, 0.0)]}], "bounds": {},
    })  # fmt: skip
    assert r.status_code == 422
    assert "vos" in r.json()["detail"]


def test_a_hybrid_pi_gain_falls_to_one_at_ft_and_fits(client: TestClient) -> None:
    """β at low frequency and |h21| = 1 at fT = gm / (2π(Cπ + Cμ)), by simulation; β and Cπ come
    back from points of that curve."""
    template = "tpl:Standard templates/Hybrid-pi BJT (small signal)"
    truth = {"ic": "1m", "beta": "150", "cpi": "20p", "cmu": "2p"}
    low = curve(client, template, truth, "h21(f)", [100.0])
    assert low[0][1] == pytest.approx(150, rel=0.02)
    gm = 1e-3 / 0.025852
    ft = gm / (2 * 3.141592653589793 * 22e-12)
    at_ft = curve(client, template, truth, "h21(f)", [ft])
    assert at_ft[0][1] == pytest.approx(1, rel=0.1)
    points = curve(client, template, truth, "h21(f)", [1e3, 1e6, 1e7, 1e8, 2e8])
    result = fit(client, template, {"ic": "1m", "beta": "100", "cpi": "5p", "cmu": "2p"},
                 ["beta", "cpi"], [{"name": "h21(f)", "points": points}])  # fmt: skip
    values = result["values"]
    assert isinstance(values, dict)
    assert number(values["beta"]) == pytest.approx(150, rel=0.05)
    assert number(values["cpi"]) == pytest.approx(20e-12, rel=0.05)


def test_ebers_moll_is_gummel_poon_without_the_early_effect(client: TestClient) -> None:
    """Its output lines are flat (no Early voltage): the collector current at 2 V and at 10 V
    are the same."""
    r = client.post("/api/components/templates/card", headers=H,
                    json={"template": "tpl:Standard templates/NPN transistor (Ebers-Moll)",
                          "form": {}})  # fmt: skip
    assert r.status_code == 200, r.text
    family = [c for c in r.json()["curves"] if c["name"] == "Ic(Vce)"]
    top = family[-1]
    at = {round(x): y for x, y in zip(top["x"], top["y"], strict=True)}
    assert at[10] == pytest.approx(at[2], rel=0.01)
