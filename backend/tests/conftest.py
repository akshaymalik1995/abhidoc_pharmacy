import pytest
from fastapi.testclient import TestClient

from app.auth import _serializer
from app.main import app


def login(hospital_id: int = 1) -> TestClient:
    """A client logged in as the test doctor of one hospital."""
    client = TestClient(app)
    client.cookies.set("session", _serializer.dumps({"doctor_id": 25, "hospital_id": hospital_id}))
    return client


@pytest.fixture(scope="session")
def doctor() -> TestClient:
    return login()


@pytest.fixture(scope="session")
def stranger() -> TestClient:
    """Logged in, but to a hospital that owns none of the test records."""
    return login(987654)


@pytest.fixture(scope="session")
def anonymous() -> TestClient:
    return TestClient(app)
