"""Stock Query and Stock Ledger, read-only against the test database."""
from decimal import Decimal

QUERY = "/api/stock/query"
LEDGER = "/api/stock/ledger"


def test_login_is_required(anonymous):
    assert anonymous.get(f"{QUERY}/products", params={"q": "ab"}).status_code == 401
    assert anonymous.get(f"{QUERY}/1").status_code == 401
    assert anonymous.get(LEDGER).status_code == 401


def test_query_finds_a_stocked_product_and_adds_up(doctor, stranger):
    stocked = doctor.get("/api/stock/overall", params={"limit": 1}).json()["items"][0]
    assert doctor.get(f"{QUERY}/products", params={"q": "a"}).json() == {"items": [], "more": False}
    found = doctor.get(f"{QUERY}/products", params={"q": stocked["item_name"]}).json()["items"]
    product = next(p for p in found if p["item_name"] == stocked["item_name"])
    # the catalog is shared, but a hospital that never touched the product is not offered it
    assert stranger.get(f"{QUERY}/products", params={"q": stocked["item_name"]}).json()["items"] == []

    body = doctor.get(f"{QUERY}/{product['item_id']}").json()
    assert body["item_name"] == stocked["item_name"]
    assert len(body["purchases"]) <= 10 and len(body["sales"]) <= 30 and len(body["movements"]) <= 50
    on_shelves = sum(Decimal(s["quantity_on_hand"]) for s in body["shelves"])
    assert on_shelves == Decimal(body["summary"]["on_hand"])
    assert stranger.get(f"{QUERY}/{product['item_id']}").json()["shelves"] == []
    assert doctor.get(f"{QUERY}/999999999").status_code == 404


def _check_rows_add_up(rows):
    for r in rows:
        q = Decimal(r["opening_quantity"]) + Decimal(r["in_quantity"]) - Decimal(r["out_quantity"])
        assert q == Decimal(r["closing_quantity"]), r["item_name"]
        assert r["opening_value_cents"] + r["in_value_cents"] - r["out_value_cents"] == r["closing_value_cents"], r["item_name"]


def test_ledger_rows_and_totals_add_up(doctor):
    for params in ({}, {"from_date": "2026-01-01", "to_date": "2026-06-30"}):
        everything = doctor.get(LEDGER, params={**params, "output": "all"}).json()
        rows, totals = everything["items"], everything["totals"]
        assert rows and everything["total"] == len(rows)
        _check_rows_add_up(rows)
        for column in ("opening_quantity", "in_quantity", "out_quantity", "closing_quantity"):
            assert sum(Decimal(r[column]) for r in rows) == Decimal(totals[column]), column
        for column in ("opening_value_cents", "in_value_cents", "out_value_cents", "closing_value_cents"):
            assert sum(r[column] for r in rows) == totals[column], column


def test_ledger_of_one_store_pages_and_filters(doctor, stranger):
    first = doctor.get(LEDGER, params={"limit": 3}).json()
    assert len(first["items"]) == 3 and first["total"] > 3 and first["locations"]
    store = first["locations"][0]["value"]
    one = doctor.get(LEDGER, params={"location_id": store, "output": "all"}).json()
    _check_rows_add_up(one["items"])
    name = first["items"][0]["item_name"]
    assert any(r["item_name"] == name for r in doctor.get(LEDGER, params={"q": name}).json()["items"])

    assert doctor.get(LEDGER, params={"from_date": "2026-05-01", "to_date": "2026-04-01"}).status_code == 422
    assert doctor.get(LEDGER, params={"from_date": "yesterday"}).status_code == 422
    assert stranger.get(LEDGER, params={"location_id": store}).status_code == 422
    assert stranger.get(LEDGER).json()["total"] == 0


def test_ledger_file_ends_with_the_totals(doctor):
    file = doctor.get(LEDGER, params={"output": "csv"})
    assert file.headers["content-type"].startswith("text/csv")
    lines = file.text.strip().splitlines()
    total = doctor.get(LEDGER, params={"limit": 1}).json()["total"]
    assert len(lines) == total + 2 and lines[-1].startswith("TOTAL,")


def test_diary_runs_from_opening_to_closing(doctor, stranger):
    moved = next(r for r in doctor.get(LEDGER, params={"output": "all"}).json()["items"] if Decimal(r["in_quantity"]) > 0)
    body = doctor.get(f"{LEDGER}/{moved['item_id']}/diary").json()
    assert body["item_name"] == moved["item_name"] and body["lines"]
    if len(body["lines"]) < 500:
        last = Decimal(body["lines"][-1]["running_quantity"])
        assert last == Decimal(body["closing_quantity"])
        assert Decimal(body["opening_quantity"]) + Decimal(body["in_quantity"]) - Decimal(body["out_quantity"]) == last
    assert stranger.get(f"{LEDGER}/{moved['item_id']}/diary").json()["lines"] == []
    assert doctor.get(f"{LEDGER}/999999999/diary").status_code == 404
    assert doctor.get(f"{LEDGER}/{moved['item_id']}/diary", params={"from_date": "2026-05-02", "to_date": "2026-05-01"}).status_code == 422
