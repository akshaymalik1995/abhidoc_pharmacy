"""Runs against the test database. The one write puts back the values it read."""
import pytest

from app.sql import like

URL = "/api/stock/overall"


def test_like_treats_wildcards_as_text():
    assert like(" 50%_a\\ ") == "%50\\%\\_a\\\\%"


def test_login_is_required(anonymous):
    assert anonymous.get(URL).status_code == 401
    assert anonymous.put("/api/stock/balances/1", json={}).status_code == 401


def test_page_totals_and_filters_agree(doctor):
    body = doctor.get(URL, params={"limit": 5}).json()
    assert body["total"] > 0 and len(body["items"]) == min(5, body["total"]) and body["locations"]
    grand = body["grand_total"]
    assert float(grand["quantity"]) == pytest.approx(sum(float(t["quantity"]) for t in body["location_totals"]))
    assert grand["landed_value_cents"] == sum(t["landed_value_cents"] for t in body["location_totals"])

    one = body["items"][0]
    found = doctor.get(URL, params={"q": one["item_name"]}).json()
    assert any(row["stock_balance_id"] == one["stock_balance_id"] for row in found["items"])
    assert doctor.get(URL, params={"q": "%"}).json()["total"] < body["total"]  # % is text, not "everything"
    low = doctor.get(URL, params={"alert": "low", "limit": 100}).json()
    assert all("Low" in row["statuses"] for row in low["items"])
    assert doctor.get(URL, params={"include_zero": True, "limit": 1}).json()["total"] >= body["total"]
    assert doctor.get(URL, params={"alert": "soon"}).status_code == 422


def test_other_hospital_sees_nothing(stranger):
    body = stranger.get(URL).json()
    assert body["total"] == 0 and body["location_totals"] == [] and body["grand_total"]["landed_value_cents"] == 0


def test_export_has_every_row_of_the_filter(doctor):
    total = doctor.get(URL, params={"alert": "low", "limit": 1}).json()["total"]
    everything = doctor.get(URL, params={"alert": "low", "output": "all"}).json()
    assert len(everything["items"]) == min(total, 5000)
    file = doctor.get(URL, params={"alert": "low", "output": "csv"})
    assert file.headers["content-type"].startswith("text/csv")
    lines = file.text.strip().splitlines()
    assert lines[0].lstrip("﻿").startswith("Pharmacy item,Location") and len(lines) - 1 == min(total, 5000)


def test_shelf_edit_round_trips_and_is_guarded(doctor, stranger):
    rows = doctor.get(URL, params={"q": "AKTEST", "limit": 1}).json()["items"]
    if not rows:
        pytest.skip("no AKTEST shelf row in the test database")
    row = rows[0]
    same = {
        "reorder_level": row["reorder_level"], "unit_cost": row["unit_cost_cents"] / 100,
        "landed_cost": row["landed_cost_cents"] / 100, "unit_mrp": row["unit_mrp_cents"] / 100,
        "rack_code": row["rack_code"] or "", "bin_code": row["bin_code"] or "", "is_active": True,
    }
    url = f"/api/stock/balances/{row['stock_balance_id']}"
    assert stranger.put(url, json=same).status_code == 404
    assert doctor.put(url, json={**same, "unit_mrp": -1}).status_code == 422
    assert doctor.put(url, json={**same, "quantity_on_hand": 5, "unit_cost": "1.001"}).status_code == 422
    assert doctor.put(url, json=same).status_code == 204
    after = doctor.get(URL, params={"q": row["item_name"], "limit": 100}).json()["items"]
    after = next(r for r in after if r["stock_balance_id"] == row["stock_balance_id"])
    assert {k: after[k] for k in row if k != "statuses"} == {k: row[k] for k in row if k != "statuses"}
