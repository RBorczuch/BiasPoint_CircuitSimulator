"""Models pasted in the inspector: parsed, converted and tried in ngspice (FR-MOD-7)."""

import pytest
from fastapi.testclient import TestClient

from tests.test_api import H

pytestmark = pytest.mark.ngspice


def check(client: TestClient, text: str) -> dict:
    r = client.post("/api/components/models/check", headers=H, json={"text": text})
    assert r.status_code == 200, r.text
    return dict(r.json())


def test_a_good_diode_and_an_ltspice_transistor_simulate(client: TestClient) -> None:
    result = check(
        client,
        ".model D1N4148 D(IS=2.52n N=1.752 RS=0.568)\n"
        ".model Q2N3904 NPN(IS=6.734f BF=416.4 VAF=74.03 Vceo=40 mfg=NXP)",
    )
    items = {i["name"]: i for i in result["items"]}
    assert items["D1N4148"]["checked"] and items["D1N4148"]["check"] == ""
    assert items["D1N4148"]["card"]["type"].lower() == "d"
    assert items["Q2N3904"]["check"] == ""  # LTspice's Vceo and mfg are dropped, not errors


def test_a_subcircuit_that_does_not_read_says_where(client: TestClient) -> None:
    result = check(client, ".subckt BAD a b\nQ1 a b 0 NOSUCHMODEL\n.ends")
    (item,) = result["items"]
    assert item["kind"] == "subckt" and item["pins"] == ["a", "b"]
    assert item["checked"] and item["check"].startswith("line 2 of the text: Q1 a b 0 NOSUCHMODEL")
    missing = check(client, "* a resistor\n.subckt R2 a b\nR1 a b {rx}\n.ends")["items"][0]
    assert missing["check"].startswith("line 3 of the text")  # the undefined parameter's line
    good = check(client, ".subckt GOOD a b\nR1 a b 1k\n.ends")["items"][0]
    assert good["check"] == ""


def test_nothing_to_find(client: TestClient) -> None:
    result = check(client, "* only a comment\n")
    assert result["items"] == []
    assert any(".ends" in n for n in result["notes"])
