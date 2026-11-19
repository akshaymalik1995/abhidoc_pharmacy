"""Local settings, read once from backend/settings.ini (not committed)."""
import configparser
from pathlib import Path

_file = Path(__file__).resolve().parent.parent / "settings.ini"
_ini = configparser.ConfigParser(interpolation=None)
if not _ini.read(_file):
    raise RuntimeError(f"Missing {_file}. Copy settings.example.ini and fill it in.")
_own = _ini["pharmacy"]

SESSION_SECRET = _own["session_secret"]
SESSION_TIMEOUT_MINUTES = _own.getint("session_timeout_minutes", 720)
# DocAssist treats a login with no hospital as hospital 1. Unset here means such a login is refused.
DEFAULT_HOSPITAL_ID = _own.getint("default_hospital_id", 0)

# ponytail: database credentials are read from DocAssist's own config.ini so they
# live in one place; give this app its own when it is deployed separately.
_docassist = configparser.ConfigParser(interpolation=None)
if not _docassist.read(_own["docassist_config"]):
    raise RuntimeError(f"Cannot read {_own['docassist_config']}")
_db = _docassist[_own["docassist_env"]]

DB_HOST = _db["sql_host"]
DB_USER = _db["sql_username"]
DB_PASSWORD = _db["sql_password"]
DB_NAME = _db["sql_database"]
