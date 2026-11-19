"""Runs against the test database. The one product it creates is removed again."""
import uuid

from fastapi.testclient import TestClient

from app.db import transaction
from app.main import app

URL = "/api/medicines"


def test_login_is_required():
    for call in (TestClient(app).get(URL), TestClient(app).get(f"{URL}/options"),
                 TestClient(app).post(URL, json={"item_name": "x"})):
        assert call.status_code == 401


def test_list_pages_searches_and_filters(doctor):
    page = doctor.get(URL, params={"limit": 5}).json()
    assert len(page["items"]) == 5 and page["total"] > 5
    everything = doctor.get(URL, params={"limit": 1, "status": "all"}).json()["total"]
    assert everything >= page["total"]
    name = page["items"][0]["item_name"]
    found = doctor.get(URL, params={"q": name}).json()
    assert any(row["item_name"] == name for row in found["items"])
    assert doctor.get(URL, params={"manufacturer_code": "no-such-code"}).json() == {"items": [], "total": 0}
    assert doctor.get(URL, params={"limit": 1000}).status_code == 422


def test_options_cover_every_dropdown(doctor):
    lists = doctor.get(f"{URL}/options").json()
    assert {"manufacturer_code", "product_group_code", "dosage_form", "unit_of_measure"} <= set(lists)


def test_bad_products_are_refused(doctor):
    existing = doctor.get(URL, params={"limit": 1}).json()["items"][0]["item_name"]
    assert doctor.post(URL, json={"item_name": "  "}).status_code == 422
    assert doctor.post(URL, json={"item_name": "x", "tax_percent": "-1"}).status_code == 422
    assert doctor.post(URL, json={"item_name": "x", "item_type": "DRUG"}).status_code == 422
    assert doctor.post(URL, json={"item_name": existing.upper()}).status_code == 409
    assert doctor.post(URL, json={"item_name": uuid.uuid4().hex, "manufacturer_code": "no-such-code"}).status_code == 422
    assert doctor.get(f"{URL}/999999999").status_code == 404
    assert doctor.put(f"{URL}/999999999", json={"item_name": "x"}).status_code == 404


def test_a_product_round_trips(doctor):
    name = f"AKTEST {uuid.uuid4().hex[:12]}"
    created = doctor.post(URL, json={"item_name": f"  {name} ", "strength": "500 mg", "tax_percent": "12.5",
                                     "is_high_risk_medicine": True})
    assert created.status_code == 201, created.text
    item = created.json()
    try:
        assert item["item_name"] == name and item["is_active"] and item["generic_name"] == ""
        assert item["is_expirable"] is True and item["is_high_risk_medicine"] is True

        changed = doctor.put(f"{URL}/{item['item_id']}", json={**item, "strength": "650 mg", "is_expirable": False})
        assert changed.status_code == 200, changed.text
        stored = doctor.get(f"{URL}/{item['item_id']}").json()
        assert stored["strength"] == "650 mg" and stored["is_expirable"] is False
        assert float(stored["tax_percent"]) == 12.5 and stored["is_high_risk_medicine"] is True

        assert doctor.post(f"{URL}/{item['item_id']}/active", json={"active": False}).status_code == 204
        assert not any(r["item_id"] == item["item_id"] for r in doctor.get(URL, params={"q": name}).json()["items"])
        assert doctor.get(URL, params={"q": name, "status": "all"}).json()["items"][0]["is_active"] is False
        assert doctor.post(f"{URL}/{item['item_id']}/active", json={"active": True}).status_code == 204
        assert doctor.get(f"{URL}/{item['item_id']}").json()["is_active"] is True
    finally:
        with transaction() as cur:
            cur.execute("DELETE FROM pharmacy_items WHERE item_id = %s AND item_name = %s", (item["item_id"], name))
