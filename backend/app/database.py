"""Database engine and session management."""
from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import DeclarativeBase, sessionmaker, Session

from .config import settings


def _get_engine():
    url = settings.database_url
    is_cs = "/cloudsql/" in url and "localhost" in url

    engine = create_engine(
        url,
        pool_pre_ping=True,
        # Smaller pool for Cloud SQL (db-f1-micro = 0.6 GB RAM)
        pool_size=3 if is_cs else 5,
        max_overflow=2 if is_cs else 10,
        pool_recycle=1800 if is_cs else -1,
        future=True,
    )

    @event.listens_for(engine, "connect")
    def _set_postgres_session(dbapi_conn, _):
        try:
            cur = dbapi_conn.cursor()
            cur.execute("SET timezone='Asia/Kolkata'")
            cur.close()
        except Exception:
            # Non-postgres/edge drivers (e.g. pg8000) may not support SET here; ignore.
            pass

    return engine


engine = _get_engine()
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False, future=True)


class Base(DeclarativeBase):
    pass


def get_db():
    db: Session = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def check_db_health() -> dict:
    """Quick DB connectivity check for the health endpoint."""
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return {"status": "ok", "database": "connected"}
    except Exception as e:
        return {"status": "error", "database": str(e)[:200]}