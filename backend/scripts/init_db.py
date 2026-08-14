"""Create database tables and seed the initial admin user."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.auth import hash_password
from app.database import Base, SessionLocal, engine
from app.models import User, UserRole


def create_tables():
    Base.metadata.create_all(bind=engine)
    print("[ok] tables ensured")


def seed_admin(username: str = "admin", password: str = "admin123",
               email: str = "admin@kalika.local", full_name: str = "ERP Administrator"):
    db = SessionLocal()
    try:
        existing = db.query(User).filter(User.username == username).first()
        if existing:
            print(f"[skip] user '{username}' already exists")
            return
        db.add(User(username=username, email=email, full_name=full_name,
                    password_hash=hash_password(password), role=UserRole.admin))
        db.commit()
        print(f"[ok] admin user '{username}' created")
    finally:
        db.close()


if __name__ == "__main__":
    create_tables()
    if "--no-seed" not in sys.argv:
        seed_admin()