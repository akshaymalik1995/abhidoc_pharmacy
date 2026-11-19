"""Purchase lists and the view of one document, read-only against the test database."""
import pytest

from app.purchase_documents import TYPES

URL = "/api/purchase/documents"


def test_login_and_a_known_kind_are_required(anonymous, doctor):
    assert anonymous.get(URL, params={"kind": "orders"}).status_code == 401
    assert doctor.get(URL).status_code == 422
    assert doctor.get(URL, params={"kind": "everything"}).status_code == 422


@pytest.mark.parametrize("kind", list(TYPES))
def test_each_list_holds_only_its_own_documents(doctor, stranger, kind):
    body = doctor.get(URL, params={"kind": kind, "limit": 5}).json()
    assert all(row["purchase_type"] in TYPES[kind] for row in body["rows"])
    assert len(body["rows"]) == min(5, body["total"])
    assert stranger.get(URL, params={"kind": kind}).json()["total"] == 0
    if not body["rows"]:
        return
    one = body["rows"][0]
    by_number = doctor.get(URL, params={"kind": kind, "q": one["purchase_number"]}).json()
    assert any(r["purchase_document_id"] == one["purchase_document_id"] for r in by_number["rows"])
    by_status = doctor.get(URL, params={"kind": kind, "status": one["status"].lower(), "limit": 100}).json()
    assert by_status["rows"] and all(r["status"] == one["status"] for r in by_status["rows"])
    assert one["status"] in body["statuses"]

    file = doctor.get(URL, params={"kind": kind, "output": "csv"})
    assert file.headers["content-type"].startswith("text/csv")
    assert len(file.text.strip().splitlines()) - 1 == min(body["total"], 5000)

    seen = doctor.get(f"{URL}/{one['purchase_document_id']}").json()
    assert seen["purchase_number"] == one["purchase_number"]
    assert stranger.get(f"{URL}/{one['purchase_document_id']}").status_code == 404


def test_bad_filters_are_refused(doctor):
    assert doctor.get(URL, params={"kind": "orders", "from_date": "2026-05-02", "to_date": "2026-05-01"}).status_code == 422
    assert doctor.get(URL, params={"kind": "orders", "status": "x; DROP"}).status_code == 422
    assert doctor.get(f"{URL}/999999999").status_code == 404


def test_order_form_lookups(doctor, anonymous):
    assert anonymous.get("/api/purchase/suppliers").status_code == 401
    assert doctor.get("/api/purchase/suppliers").json()
    assert doctor.get("/api/purchase/products").json() == []
    name = doctor.get("/api/medicines", params={"limit": 1}).json()["items"][0]["item_name"]
    found = doctor.get("/api/purchase/products", params={"q": name}).json()
    assert any(p["item_name"] == name for p in found) and len(found) <= 20
    assert doctor.get("/api/purchase/products", params={"q": "%"}).json() == [] or "%" in doctor.get("/api/purchase/products", params={"q": "%"}).json()[0]["item_name"]
    me = doctor.get("/api/me").json()
    assert me["locations"] and {"value", "label"} <= set(me["locations"][0])


def test_wanted_screen(doctor, stranger, anonymous):
    assert anonymous.get("/api/purchase/wanted").status_code == 401
    body = doctor.get("/api/purchase/wanted").json()
    assert body["suppliers"] and all(row["purchase_type"] in TYPES["wanted"] for row in body["lists"])
    if body["wanted"]:
        assert body["wanted"]["purchase_type"] == "REORDER_WANTED_LIST"
        assert body["wanted"]["status"] in ("DRAFT", "OPEN", "STAGED")
    for listed in body["lists"][:3]:
        asked = {"wanted_document_id": listed["purchase_document_id"]}
        one = doctor.get("/api/purchase/wanted", params=asked).json()["wanted"]
        assert one["purchase_number"] == listed["purchase_number"]
        assert stranger.get("/api/purchase/wanted", params=asked).status_code == 404
    assert stranger.get("/api/purchase/wanted").json()["wanted"] is None
    assert doctor.get("/api/purchase/wanted", params={"wanted_document_id": 999999999}).status_code == 404


def test_the_open_filter_keeps_every_unfinished_order(doctor):
    body = doctor.get("/api/purchase/documents", params={"kind": "orders", "status": "ALL_OPEN", "limit": 100}).json()
    assert body["rows"] and all(r["status"] in {"DRAFT", "OPEN", "STAGED", "ORDERED", "PARTIALLY_RECEIVED", "PENDING_APPROVAL"} for r in body["rows"])
