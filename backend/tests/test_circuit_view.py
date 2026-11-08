"""The readable equivalent circuit of a template (the part editor's preview)."""

import pytest
from fastapi.testclient import TestClient

from bpt.document.model import TemplateField
from bpt.models.circuit_view import evaluate, model_lines, quantity
from tests.test_api import H


def test_values_formulas_and_model_lines() -> None:
    assert quantity(0.05, "Ω") == "50 mΩ"
    assert quantity(0.5, "") == "0.5"
    assert quantity(0.01, "1/V") == "0.01 1/V"
    values = {"flf": 1e3, "rlf": 0.2, "Cnom": 10e-6, "vhalf": 6.3}
    assert evaluate("{1/(6.283185307*flf*rlf)}", values) == pytest.approx(795.8e-6, rel=1e-3)
    assert evaluate("Cnom/(1+(v(1,2)/vhalf)^2)", values) == pytest.approx(10e-6)  # at 0 V
    assert evaluate("__import__('os')", values) is None
    fields = {"is": TemplateField(key="is", unit="A"), "n": TemplateField(key="n")}
    text = model_lines(".model devmodel D(IS={is} N={n} RS={rs} EG=1.9)",
                       {"is": 2.52e-9, "n": 1.752}, fields)  # fmt: skip
    assert text.splitlines() == [".model devmodel D", "IS 2.52 nA · N 1.752 · RS {rs}", "EG 1.9"]


def test_circuit_named_by_fields(client: TestClient) -> None:
    def svg(template: str, form: dict[str, str] | None = None) -> str:
        body = {"template": template, "form": form or {}, "theme": "dark"}
        r = client.post("/api/components/templates/circuit", headers=H, json=body)
        assert r.status_code == 200, r.text
        return str(r.json()["svg"])

    cap = svg("electrolytic", {"Cnom": "100u", "esr": "50m", "rlf": "200m", "flf": "1k"})
    assert ">ESR (HF)</text>" in cap and ">50 mΩ</text>" in cap  # the field's name, the value
    assert ">795.8 µF</text>" in cap  # the formula of the ESR rise computed
    amp = svg("tpl:Standard templates/Op-amp macromodel")
    assert ">I = gm·Vd</text>" in amp and "tanh" not in amp  # a caption, not the expression
    assert ">31.83 MΩ</text>" in amp  # R = Aol / (2π GBW C)
    diode = svg("tpl:Standard templates/Diode (signal)")
    assert ">IS 2.52 nA · N 1.752 · RS 568 mΩ</text>" in diode
