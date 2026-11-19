"""Reuses the DocAssist login: reads the session cookie DocAssist signed."""
import hashlib
from dataclasses import dataclass
from datetime import datetime, timedelta

from fastapi import HTTPException, Request
from itsdangerous import BadSignature, URLSafeTimedSerializer

from . import settings
from .db import transaction

# Same signing parameters as Flask's default cookie session.
_serializer = URLSafeTimedSerializer(
    settings.SESSION_SECRET,
    salt="cookie-session",
    signer_kwargs={"key_derivation": "hmac", "digest_method": hashlib.sha1},
)
_MAX_AGE_SECONDS = settings.SESSION_TIMEOUT_MINUTES * 60


@dataclass(frozen=True)
class User:
    actor_id: int
    hospital_id: int
    is_admin: bool  # admins and doctors share id numbers


def _as_int(value) -> int | None:
    # exact type: bool is an int, and a tagged cookie value is a dict
    return value if type(value) is int and value > 0 else None


def read_session(cookie: str | None) -> dict:
    """The signed session as a dict, or {} when absent, forged or expired."""
    if not cookie or len(cookie) > 8192:
        return {}
    try:
        data = _serializer.loads(cookie, max_age=_MAX_AGE_SECONDS)
    except BadSignature:  # also covers SignatureExpired
        return {}
    return data if isinstance(data, dict) else {}


def _doctor_idle_too_long(session: dict) -> bool:
    last = session.get("doctor_last_activity")
    if not last:
        return False
    try:
        seen = datetime.fromisoformat(last)
    except (TypeError, ValueError):
        return True
    return datetime.utcnow() - seen > timedelta(minutes=settings.SESSION_TIMEOUT_MINUTES)


def current_user(request: Request) -> User:
    session = read_session(request.cookies.get("session"))
    admin_id = _as_int(session.get("admin_id"))
    doctor_id = _as_int(session.get("doctor_id"))
    if not admin_id and (not doctor_id or _doctor_idle_too_long(session)):
        raise HTTPException(401, "Please log in to DocAssist to continue.")

    hospital_id = _as_int(session.get("hospital_id"))
    if not hospital_id and doctor_id:
        with transaction() as cur:
            cur.execute(
                "SELECT hospital_id FROM Doctor_Hospital WHERE doctor_id = %s"
                " ORDER BY doctor_hospital_id DESC LIMIT 1",
                (doctor_id,),
            )
            row = cur.fetchone()
        hospital_id = _as_int(row["hospital_id"]) if row else None
    hospital_id = hospital_id or settings.DEFAULT_HOSPITAL_ID
    if not hospital_id:
        raise HTTPException(403, "This login is not linked to a hospital.")
    return User(actor_id=admin_id or doctor_id, hospital_id=hospital_id, is_admin=bool(admin_id))
