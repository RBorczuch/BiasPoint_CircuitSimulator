"""Transfer function blocks H(s): the expression read as polynomials, simulated by s_xfer."""

import math

import numpy as np
import pytest

from bpt.models.transfer import TransferError, parse_transfer, response


def test_forms_of_one_low_pass() -> None:
    """A formula, a pole in a bracket, polynomials: the same first-order low-pass."""
    w = 2 * math.pi * 1e3
    for text in ("1/(1+s/(2*pi*1k))", f"{w}/(s+{w})", "1 / (1 + s / 6283.185307)"):
        num, den = parse_transfer(text)
        assert num == pytest.approx([w]) and den == pytest.approx([1, w], rel=1e-6)


def test_zeros_poles_gain_and_implicit_products() -> None:
    num, den = parse_transfer("10(s+1k)/((s+100)(s+10k))")
    assert np.roots(num) == pytest.approx([-1e3])
    assert sorted(np.roots(den)) == pytest.approx([-1e4, -100])
    assert num[0] == pytest.approx(10)
    second = parse_transfer("1/(s^2 + 2*0.5*1k*s + 1meg)")
    assert second[1] == pytest.approx([1, 1e3, 1e6])


def test_refused() -> None:
    for text, why in [("s^2/(s+1)", "more zeros"), ("1/(s+", "ends"), ("1/(x+1)", "unknown"),
                      ("", "give"), ("1/s^0.5", "whole")]:  # fmt: skip
        with pytest.raises(TransferError, match=why):
            parse_transfer(text)


def test_response_of_the_low_pass() -> None:
    num, den = parse_transfer("1/(1+s/(2*pi*1k))")
    h = response(num, den, np.array([1e3]))[0]
    assert abs(h) == pytest.approx(1 / math.sqrt(2), rel=1e-9)
    assert math.degrees(np.angle(h)) == pytest.approx(-45, abs=1e-6)


@pytest.mark.ngspice
def test_simulated_in_ac_and_transient(client) -> None:  # type: ignore[no-untyped-def]
    """The block in a circuit: -3 dB at 1 kHz in AC, the step reaching 63 % at one time constant."""
    from tests.test_api import H

    pid = client.post("/api/projects", json={"name": "hs"}, headers=H).json()["id"]
    sheet = client.get(f"/api/projects/{pid}/document", headers=H).json()["project"]["sheets"][0]
    ids = ["00000000-0000-7000-8000-00000000000" + str(k) for k in range(1, 4)]
    command = {"type": "add_objects", "sheet": sheet["name"], "instances": [
        {"id": ids[0], "ref": "V1", "symbol": "bpt:vsource", "at": [0, 0],
         "model": {"params": {"dc": "0", "ac": "1", "tran": "PULSE(0 1 0 1n 1n 1 2)"}}},
        {"id": ids[1], "ref": "A1", "symbol": "bpt:hs", "at": [2540, 0],
         "model": {"params": {"h": "1/(1+s/(2*pi*1k))"}}},
        {"id": ids[2], "ref": "R1", "symbol": "bpt:resistor", "at": [5080, 0],
         "model": {"params": {"R": "1k"}}},
    ], "labels": [
        {"kind": "local", "text": "in", "at": [0, -381]},
        {"kind": "local", "text": "in", "at": [2032, 0]},
        {"kind": "local", "text": "out", "at": [3048, 0]},
        {"kind": "local", "text": "0", "at": [0, 381]},
        {"kind": "local", "text": "out", "at": [5080, -381]},
        {"kind": "local", "text": "0", "at": [5080, 381]},
    ]}  # fmt: skip
    r = client.post(f"/api/projects/{pid}/commands", json={"command": command}, headers=H)
    assert r.status_code == 200, r.text
    netlist = client.get(f"/api/projects/{pid}/export/netlist", headers=H).text
    assert "s_xfer(" in netlist and "den_coeff=[1 6283.18530718]" in netlist

    def run(card: str) -> str:
        job = client.post(f"/api/projects/{pid}/analyses/run", json={"card": card},
                          headers=H).json()  # fmt: skip
        for _ in range(500):
            info = client.get(f"/api/jobs/{job['job_id']}", headers=H).json()
            if info["status"] != "running" and info["status"] != "queued":
                assert info["status"] == "ok", info.get("error")
                return str(info["run_id"])
        raise AssertionError("the run did not end")

    ac = run(".ac dec 50 10 100k")
    q = client.post(f"/api/runs/{ac}/query", json={"signals": ["V(out)"], "format": "json"},
                    headers=H).json()  # fmt: skip
    f, mag = np.array(q["x"]), np.abs(np.array(q["series"]["V(out)"]["re"]) + 1j *
                                      np.array(q["series"]["V(out)"]["im"]))  # fmt: skip
    k = int(np.argmin(np.abs(f - 1e3)))
    assert 20 * np.log10(mag[k]) == pytest.approx(-3.01, abs=0.1)
    tran = run(".tran 1u 2m")
    body = {"signals": ["V(out)"], "format": "json", "pixels": 4000}
    q = client.post(f"/api/runs/{tran}/query", headers=H, json=body).json()
    series = q["series"]["V(out)"]
    t, v = np.array(q["x"]), (np.array(series["min"]) + np.array(series["max"])) / 2
    tau = 1 / (2 * math.pi * 1e3)
    assert float(np.interp(tau, t, v)) == pytest.approx(1 - math.exp(-1), abs=0.02)
