"""Sales History, read-only against the test database."""
import pytest

from app.sales import TABS

URL = "/api/sales/history"


def test_login_and_clean_filters_are_required(anonymous, doctor):
    assert anonymous.get(URL).status_code == 401
    assert doctor.get(URL, params={"tab": "drafts"}).status_code == 422
    assert doctor.get(URL, params={"status": "PAID; DROP"}).status_code == 422
    assert doctor.get(URL, params={"status": "SOLD"}).status_code == 422
    assert doctor.get(URL, params={"limit": 30}).status_code == 422
    assert doctor.get(URL, params={"date_from": "2026-02-01", "date_to": "2026-01-01"}).status_code == 422


@pytest.mark.parametrize("tab", list(TABS))
def test_each_tab_holds_only_its_own_bills(doctor, stranger, tab):
    body = doctor.get(URL, params={"tab": tab, "date_preset": "all", "cancelled": "all", "limit": 10}).json()
    types, only, never = TABS[tab]
    assert all(r["sales_type"] in types and (not only or r["status"] in only) and r["status"] not in never for r in body["rows"])
    assert len(body["rows"]) == min(10, body["total"]) and body["tab_counts"][tab] == body["total"]
    assert body["totals"]["count"] == body["total"] and body["register_totals"] is None  # cancelled shown: not comparable
    assert stranger.get(URL, params={"tab": tab, "date_preset": "all"}).json()["total"] == 0
    if body["rows"]:
        one = body["rows"][0]
        found = doctor.get(URL, params={"tab": tab, "date_preset": "all", "cancelled": "all", "q": one["sales_number"]}).json()
        assert any(r["sales_document_id"] == one["sales_document_id"] for r in found["rows"])


def test_totals_add_up_and_the_register_is_offered_only_when_comparable(doctor):
    every = doctor.get(URL, params={"date_preset": "all", "limit": 100}).json()
    if every["total"] <= 100:
        assert sum(r["net"] for r in every["rows"]) == every["totals"]["net"]
    assert every["register_totals"]["count"] == every["register_totals"]["sales_count"] + every["register_totals"]["returns_count"]
    assert every["permissions"]["print"] in (True, False) and every["locations"]
    cancelled = doctor.get(URL, params={"date_preset": "all", "cancelled": "only", "limit": 10}).json()
    assert all(r["status"] == "CANCELLED" for r in cancelled["rows"])
    file = doctor.get(URL, params={"date_preset": "all", "output": "csv"})
    assert file.headers["content-type"].startswith("text/csv") and file.text.startswith("Bill no.")


def test_a_bill_opens_with_its_rows_and_payments_and_only_for_its_hospital(doctor, stranger):
    row = doctor.get(URL, params={"date_preset": "all", "limit": 10}).json()["rows"][0]
    bill = doctor.get(f"/api/sales/bills/{row['sales_document_id']}").json()
    assert bill["sales_number"] == row["sales_number"] and bill["net"] == row["net"] and bill["balance"] == row["balance"]
    assert len(bill["lines"]) == row["product_count"] and bill["payment_modes"][0]["code"]
    assert stranger.get(f"/api/sales/bills/{row['sales_document_id']}").status_code == 404
    returns = doctor.get(URL, params={"tab": "returns", "date_preset": "all", "limit": 10}).json()["rows"]
    if returns:
        assert doctor.get(f"/api/sales/bills/{returns[0]['sales_document_id']}").json()["return_info"] is not None


def test_the_register_shows_the_newest_documents_and_the_estimates_by_state(doctor, stranger):
    newest = doctor.get("/api/sales/register").json()
    assert len(newest["rows"]) <= 10 and newest["summary"]["outstanding_cents"] >= 0 and newest["permissions"]
    dates = [r["document_date"] for r in newest["rows"]]
    assert dates == sorted(dates, reverse=True)
    for show, states in (("ESTIMATES_PENDING", {"DRAFT", "CONFIRMED"}), ("ESTIMATES_CANCELLED", {"CANCELLED"})):
        rows = doctor.get("/api/sales/register", params={"show": show}).json()["rows"]
        assert all(r["sales_type"] == "ESTIMATE" and r["status"] in states for r in rows)
    assert doctor.get("/api/sales/register", params={"show": "EVERYTHING"}).status_code == 422
    assert stranger.get("/api/sales/register").json()["rows"] == []


MAIN_PHARMACY = 13  # an active stock location of hospital 1 in the test database


def test_the_counter_sells_only_from_a_location_of_its_own_hospital(doctor, stranger):
    counter = doctor.get("/api/sales/counter", params={"location_id": MAIN_PHARMACY}).json()
    assert counter["payment_modes"][0]["code"] and "pay" in counter["permissions"]
    assert stranger.get("/api/sales/counter", params={"location_id": MAIN_PHARMACY}).status_code == 422
    assert doctor.get("/api/sales/products", params={"location_id": 999999999, "q": "a"}).status_code == 422


def test_products_carry_stock_price_and_batches_in_the_order_a_sale_takes_them(doctor):
    found = doctor.get("/api/sales/products", params={"location_id": MAIN_PHARMACY, "q": "AKTEST"}).json()
    assert found and all("AKTEST" in (p["item_name"] + (p["generic_name"] or "")).upper() for p in found)
    stocked = [p for p in found if float(p["dispensable_stock"]) > 0]
    if stocked:
        batches = doctor.get(f"/api/sales/products/{stocked[0]['item_id']}/batches", params={"location_id": MAIN_PHARMACY}).json()
        assert batches and sum(float(b["quantity_on_hand"]) for b in batches) <= float(stocked[0]["dispensable_stock"])
        dated = [b["expiry_date"] for b in batches if b["expiry_date"]]
        assert dated == sorted(dated)
