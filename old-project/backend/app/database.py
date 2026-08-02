from __future__ import annotations
from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, sessionmaker
from app.config import settings

# Railway (and some other hosts) sometimes hand out the legacy "postgres://"
# scheme, which SQLAlchemy's psycopg2 dialect no longer accepts — it needs
# "postgresql://". Normalize it here so both forms work.
_db_url = settings.database_url
if _db_url.startswith("postgres://"):
    _db_url = _db_url.replace("postgres://", "postgresql://", 1)

_is_sqlite = _db_url.startswith("sqlite")

# `check_same_thread` is a SQLite-only connect arg; passing it to psycopg2
# raises a TypeError, so only include it for SQLite connections.
_connect_args = {"check_same_thread": False} if _is_sqlite else {}

engine = create_engine(
    _db_url,
    connect_args=_connect_args,
    echo=settings.debug,
    pool_pre_ping=True,   # detect stale connections (Railway drops idle ones)
    pool_recycle=300,
)


if _is_sqlite:
    @event.listens_for(engine, "connect")
    def set_sqlite_pragma(dbapi_conn, connection_record):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()
        
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db():
    from app.models import members, b2b, financial, config_models, reports  # noqa: F401
    Base.metadata.create_all(bind=engine)
