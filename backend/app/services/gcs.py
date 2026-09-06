"""GCS helpers — fetches the source workbook + pushes secured artifacts.

Supports two buckets:
  - settings.GCS_BUCKET          (legacy read-only — kalisoftai-datahub)
  - settings.GCS_SECURE_BUCKET   (kalika_enterprises — Phase 7 secured info:
                                  label archive, scan-event audit, barcode maps)
"""
from __future__ import annotations

import json
import logging
from datetime import date, datetime
from pathlib import Path
from typing import Any

from ..config import settings

log = logging.getLogger("kalika.gcs")

try:
    from google.cloud import storage  # type: ignore
    _GCS_AVAILABLE = True
except ImportError:
    _GCS_AVAILABLE = False


def _client():
    if not _GCS_AVAILABLE:
        raise RuntimeError("google-cloud-storage not installed")
    return storage.Client()


def download_excel(dest: Path | None = None) -> Path:
    """Download GCS_EXCEL_FILE to the data directory. Returns local path."""
    dest = dest or (Path(__file__).resolve().parent.parent.parent.parent / "data"
                    / settings.GCS_EXCEL_FILE.split("/")[-1])
    dest.parent.mkdir(parents=True, exist_ok=True)
    client = _client()
    bucket = client.bucket(settings.GCS_BUCKET)
    blob = bucket.blob(settings.GCS_EXCEL_FILE)
    if not blob.exists():
        raise FileNotFoundError(f"gs://{settings.GCS_BUCKET}/{settings.GCS_EXCEL_FILE} not found")
    blob.download_to_filename(str(dest))
    return dest


def _secure_bucket_name() -> str:
    """kalika_enterprises (or whatever GCS_SECURE_BUCKET is set to)."""
    return settings.GCS_SECURE_BUCKET or "kalika_enterprises"


def upload_secure(path: str, data: bytes | str, content_type: str = "application/octet-stream") -> str:
    """Push a small artifact into the secured bucket. Returns gs:// URI."""
    client = _client()
    bucket = client.bucket(_secure_bucket_name())
    blob = bucket.blob(path)
    if isinstance(data, str):
        data = data.encode("utf-8")
    blob.upload_from_string(data, content_type=content_type)
    return f"gs://{_secure_bucket_name()}/{path}"


def upload_secure_file(local_path: Path, remote_path: str | None = None) -> str:
    client = _client()
    bucket = client.bucket(_secure_bucket_name())
    remote_path = remote_path or f"uploads/{local_path.name}"
    blob = bucket.blob(remote_path)
    blob.upload_from_filename(str(local_path))
    return f"gs://{_secure_bucket_name()}/{remote_path}"


def download_secure(path: str, dest: Path) -> Path:
    client = _client()
    bucket = client.bucket(_secure_bucket_name())
    blob = bucket.blob(path)
    blob.download_to_filename(str(dest))
    return dest


def list_secure(prefix: str = "", limit: int = 200) -> list[dict[str, Any]]:
    client = _client()
    bucket = client.bucket(_secure_bucket_name())
    blobs = list(bucket.list_blobs(prefix=prefix, max_results=limit))
    return [{
        "name": b.name, "size": b.size, "updated": b.updated.isoformat() if b.updated else None,
        "content_type": b.content_type, "uri": f"gs://{_secure_bucket_name()}/{b.name}",
    } for b in blobs]


def archive_label_print(protocol: str, product_id: int, payload: str,
                        meta: dict[str, Any] | None = None) -> str:
    """Write a label print-job artifact into the secured bucket.

    Path scheme: labels/YYYY/MM/DD/{product_id}-{HHMMSS}.{ext}
    """
    now = datetime.utcnow()
    ext = {"TSPL": "tspl", "ZPL": "zpl", "ESCPOS": "esc"}.get(protocol, "txt")
    path = (
        f"labels/{now.strftime('%Y/%m/%d')}/{product_id}-{now.strftime('%H%M%S')}.{ext}"
    )
    body = payload
    if meta:
        header = json.dumps({"meta": meta, "ts": now.isoformat()}, indent=2)
        body = header + "\n----- PAYLOAD -----\n" + payload
    return upload_secure(path, body, content_type="text/plain; charset=utf-8")


def archive_scan_events(events: list[dict[str, Any]]) -> str:
    """Push a daily scan-event batch into the secured bucket."""
    today = date.today().isoformat()
    path = f"scan-events/{today}.json"
    body = json.dumps({"date": today, "count": len(events), "events": events}, indent=2)
    return upload_secure(path, body, content_type="application/json")


def archive_barcode_map(products: list[dict[str, Any]]) -> str:
    """Push the product ↔ barcode mapping (used by the scanner lookup)."""
    today = date.today().isoformat()
    path = f"barcode-map/{today}.json"
    body = json.dumps({"date": today, "count": len(products), "products": products}, indent=2)
    return upload_secure(path, body, content_type="application/json")