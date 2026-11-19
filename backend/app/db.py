"""One pooled MySQL connection per request, handed out as a dict cursor."""
from contextlib import contextmanager

from sqlalchemy import URL, create_engine

from . import settings

# SQLAlchemy is used only as the connection pool; queries are plain SQL.
engine = create_engine(
    URL.create(
        "mysql+mysqlconnector",
        username=settings.DB_USER,
        password=settings.DB_PASSWORD,
        host=settings.DB_HOST,
        database=settings.DB_NAME,
    ),
    pool_size=5,
    pool_pre_ping=True,
    pool_recycle=1800,
    # transaction() always commits or rolls back itself, so the pool's own
    # rollback on return is a wasted trip (about 60 ms to the remote database).
    pool_reset_on_return=None,
)


@contextmanager
def transaction():
    """Yield a cursor; commit on success, roll back on any error."""
    connection = engine.raw_connection()
    try:
        cursor = connection.cursor(dictionary=True, buffered=True)
        try:
            yield cursor
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            cursor.close()
    finally:
        connection.close()  # returns it to the pool
