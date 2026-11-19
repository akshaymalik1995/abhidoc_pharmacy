"""Stock registers and the view of one document, read-only against the test database."""
import typing

import pytest

from app.stock_documents import StockType

URL = "/api/stock/documents"
TYPES = typing.get_args(StockType)


def test_login_and_a_known_type_are_required(anonymous, doctor):
    assert anonymous.get(URL, params={"stock_type": "STOCK_ISSUE"}).status_code == 401
    assert doctor.get(URL).status_code == 422
    assert doctor.get(URL, params={"stock_type": "PHYSICAL_COUNT; DROP"}).status_code == 422


@pytest.mark.parametrize("stock_type", TYPES)
def test_each_register_holds_only_its_own_documents(doctor, stranger, stock_type):
    body = doctor.get(URL, params={"stock_type": stock_type, "limit": 5}).json()
    assert all(row["stock_type"] == stock_type for row in body["rows"])
    assert len(body["rows"]) == min(5, body["total"]) and body["locations"]
    assert stranger.get(URL, params={"stock_type": stock_type}).json()["total"] == 0
    if not body["rows"]:
        return
    one = body["rows"][0]
    by_number = doctor.get(URL, params={"stock_type": stock_type, "q": one["stock_number"]}).json()
    assert any(r["stock_document_id"] == one["stock_document_id"] for r in by_number["rows"])
    by_status = doctor.get(URL, params={"stock_type": stock_type, "status": one["status"], "limit": 100}).json()
    assert by_status["rows"] and all(r["status"] == one["status"] for r in by_status["rows"])
    assert one["status"] in body["statuses"]

    everything = doctor.get(URL, params={"stock_type": stock_type, "output": "all"}).json()
    assert len(everything["rows"]) == min(body["total"], 10000)
    if body["total"] <= 10000:
        assert sum(r["product_count"] or 0 for r in everything["rows"]) == body["product_count_total"]
    file = doctor.get(URL, params={"stock_type": stock_type, "output": "csv"})
    assert file.headers["content-type"].startswith("text/csv")

    seen = doctor.get(f"{URL}/{one['stock_document_id']}").json()
    assert seen["stock_number"] == one["stock_number"] and isinstance(seen["lines"], list)
    assert stranger.get(f"{URL}/{one['stock_document_id']}").status_code == 404


def test_bad_filters_are_refused(doctor):
    asked = {"stock_type": "STOCK_TRANSFER"}
    assert doctor.get(URL, params={**asked, "from_date": "2026-05-02", "to_date": "2026-05-01"}).status_code == 422
    assert doctor.get(URL, params={**asked, "status": "x; DROP"}).status_code == 422
    assert doctor.get(f"{URL}/999999999").status_code == 404
