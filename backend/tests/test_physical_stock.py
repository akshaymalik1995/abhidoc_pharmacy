"""Runs against the test database. Read-only: every write here is one that must be refused."""
import pytest
from fastapi.testclient import TestClient

from app.auth import _serializer
from app.db import transaction
from app.main import app

HOSPITAL = 999
URL = "/api/physical-stock"


def client(session: dict | None = None, cookie: str | None = None) -> TestClient:
    c = TestClient(app)
    if session is not None:
        cookie = _serializer.dumps(session)
    if cookie:
        c.cookies.set("session", cookie)
    return c


def doctor_of(hospital_id: int) -> TestClient:
    return client({"doctor_id": 25, "hospital_id": hospital_id})


def a_count(status: str) -> tuple[int, int]:
    """(count id, its hospital) of any count in that status."""
    with transaction() as cur:
        cur.execute(
            "SELECT stock_document_id, hospital_id FROM stock_documents"
            " WHERE stock_type = 'PHYSICAL_COUNT' AND source_module = 'PHARMACY' AND status = %s LIMIT 1",
            (status,),
        )
        row = cur.fetchone()
    if not row:
        pytest.skip(f"no {status} count in the test database")
    return row["stock_document_id"], row["hospital_id"]


def test_login_is_required():
    assert client().get(URL).status_code == 401
    assert client(cookie="not-a-real-cookie").get(URL).status_code == 401
    assert client({"doctor_id": True, "hospital_id": HOSPITAL}).get(URL).status_code == 401
    forged = _serializer.dumps({"doctor_id": 25, "hospital_id": HOSPITAL})[:-2] + "xx"
    assert client(cookie=forged).get(URL).status_code == 401


def test_screen_loads_locations():
    body = doctor_of(HOSPITAL).get(URL).json()
    assert body["locations"] and body["location_id"] in {l["location_id"] for l in body["locations"]}


def test_open_count_hides_book_quantity():
    count, hospital = a_count("DRAFT")
    body = doctor_of(hospital).get(URL, params={"count_id": count}).json()
    assert body["count"]["status"] == "DRAFT"
    assert body["lines"] and all(line["system_quantity"] is None for line in body["lines"])


def test_posted_count_shows_book_quantity():
    count, hospital = a_count("POSTED")
    body = doctor_of(hospital).get(URL, params={"count_id": count}).json()
    assert body["lines"] and all(line["system_quantity"] is not None for line in body["lines"])


def test_other_hospital_cannot_see_a_count():
    count, hospital = a_count("POSTED")
    assert doctor_of(hospital + 1).get(URL, params={"count_id": count}).status_code == 404


def test_login_without_hospital_gets_the_configured_default():
    assert client({"doctor_id": 25}).get(URL).status_code == 200


def test_bad_saves_are_refused():
    (draft, draft_hospital), (posted, posted_hospital) = a_count("DRAFT"), a_count("POSTED")
    doctor = doctor_of(draft_hospital)
    line = {"stock_item_id": 1, "counted_quantity": "1"}
    assert doctor.put(f"{URL}/{draft}/lines", json={"lines": []}).status_code == 422
    assert doctor.put(f"{URL}/{draft}/lines", json={"lines": [{**line, "counted_quantity": "-1"}]}).status_code == 422
    assert doctor.put(f"{URL}/{draft}/lines", json={"lines": [{**line, "counted_quantity": "1.0001"}]}).status_code == 422
    assert doctor.put(f"{URL}/{draft}/lines", json={"lines": [{**line, "stock_item_id": 2**40}]}).status_code == 404
    assert doctor_of(posted_hospital).put(f"{URL}/{posted}/lines", json={"lines": [line]}).status_code == 409
    assert doctor.put(f"{URL}/999999999/lines", json={"lines": [line]}).status_code == 404
