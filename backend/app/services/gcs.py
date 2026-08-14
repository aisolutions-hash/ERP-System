"""Fetch the source Excel workbook from Google Cloud Storage using ADC."""
from pathlib import Path

from ..config import settings

try:
    from google.cloud import storage
    _GCS_AVAILABLE = True
except ImportError:
    _GCS_AVAILABLE = False


def download_excel(dest: Path | None = None) -> Path:
    """Download GCS_EXCEL_FILE to the data directory. Returns local path."""
    dest = dest or (Path(__file__).resolve().parent.parent.parent.parent / "data"
                    / settings.GCS_EXCEL_FILE.split("/")[-1])
    dest.parent.mkdir(parents=True, exist_ok=True)

    if not _GCS_AVAILABLE:
        raise RuntimeError("google-cloud-storage not installed")

    client = storage.Client()
    bucket = client.bucket(settings.GCS_BUCKET)
    blob = bucket.blob(settings.GCS_EXCEL_FILE)
    if not blob.exists():
        raise FileNotFoundError(f"gs://{settings.GCS_BUCKET}/{settings.GCS_EXCEL_FILE} not found")
    blob.download_to_filename(str(dest))
    return dest