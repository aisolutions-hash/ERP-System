"""Application configuration loaded from environment / .env file."""
from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BASE_DIR / ".env", env_file_encoding="utf-8", extra="ignore")

    APP_NAME: str = "Kalika Enterprises ERP"
    APP_VERSION: str = "1.0.0"
    DEBUG: bool = False
    API_PREFIX: str = "/api"

    DATABASE_URL: str = "postgresql+psycopg2://kalika_app:kalika@127.0.0.1:5432/kalika_erp"
    JWT_SECRET: str = "change-me-in-production"
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRE_MINUTES: int = 480
    ACCESS_TOKEN_NAME: str = "kalika_access"

    GCS_BUCKET: str = "kalisoftai-datahub"
    GCS_EXCEL_FILE: str = "Kalika_inventory/Daily Report Aug-26.xlsx"
    GOOGLE_APPLICATION_CREDENTIALS: str | None = None
    REPORT_DIR: Path = BASE_DIR / "reports"

    CORS_ORIGINS: list[str] = ["http://localhost:5173", "http://127.0.0.1:5173"]

    @property
    def report_dir(self) -> Path:
        self.REPORT_DIR.mkdir(parents=True, exist_ok=True)
        return self.REPORT_DIR


settings = Settings()