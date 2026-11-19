"""Runs against the test database. The one record it creates is removed again."""
import uuid

from app.db import transaction
from app.masters import MASTERS

URL = "/api/masters"


def test_login_is_required(anonymous):
    assert anonymous.get(URL).status_code == 401
    assert anonymous.post(f"{URL}/manufacturers", json={}).status_code == 401


def test_every_master_is_listed_and_readable(doctor):
    listed = doctor.get(URL).json()
    assert [m["key"] for m in listed] == list(MASTERS)
    for master in listed:
        page = doctor.get(f"{URL}/{master['key']}", params={"limit": 2})
        assert page.status_code == 200, (master["key"], page.text)
        body = page.json()
        assert body["total"] == master["count"] and len(body["rows"]) == min(2, master["count"])
    assert doctor.get(f"{URL}/no_such_list").status_code == 404


def test_bad_records_are_refused(doctor):
    assert doctor.post(f"{URL}/manufacturers", json={"reference_code": " ", "display_name": "x"}).status_code == 422
    assert doctor.post(f"{URL}/manufacturers", json={"reference_code": "x" * 300, "display_name": "x"}).status_code == 422
    assert doctor.post(f"{URL}/manufacturers", json={"reference_code": "x", "display_name": "x", "sort_order": "1.5"}).status_code == 422
    assert doctor.post(f"{URL}/product_categories", json={"reference_code": "x", "display_name": "x", "string_value": "Other"}).status_code == 422
    assert doctor.post(f"{URL}/tax_codes", json={"tax_code": "x", "tax_name": "x", "effective_from": "soon"}).status_code == 422
    assert doctor.post(f"{URL}/storage_bins", json={"location_id": 999999999}).status_code == 422


def test_a_record_round_trips_and_stays_in_its_hospital(doctor, stranger):
    code = f"AKTEST-{uuid.uuid4().hex[:10]}"
    created = doctor.post(f"{URL}/manufacturers", json={"reference_code": f" {code} ", "display_name": "AKTEST maker"})
    assert created.status_code == 201, created.text
    record_id = created.json()["id"]
    try:
        row = doctor.get(f"{URL}/manufacturers", params={"q": code}).json()["rows"][0]
        assert row["reference_code"] == code and row["is_active"] == 1 and row["sort_order"] == 0
        assert doctor.post(f"{URL}/manufacturers", json={"reference_code": code, "display_name": "twin"}).status_code == 409

        assert doctor.put(f"{URL}/manufacturers/{record_id}", json={**row, "display_name": "AKTEST renamed", "is_active": False}).status_code == 204
        row = doctor.get(f"{URL}/manufacturers", params={"q": code}).json()["rows"][0]
        assert row["display_name"] == "AKTEST renamed" and row["is_active"] == 0

        # not another hospital's to see or change, and not reachable through a different master
        assert stranger.get(f"{URL}/manufacturers", params={"q": code}).json()["total"] == 0
        assert stranger.put(f"{URL}/manufacturers/{record_id}", json={"display_name": "x"}).status_code == 404
        assert doctor.put(f"{URL}/marketers/{record_id}", json={"display_name": "x"}).status_code == 404
    finally:
        with transaction() as cur:
            cur.execute("DELETE FROM his_reference_values WHERE reference_value_id = %s AND reference_code = %s", (record_id, code))
