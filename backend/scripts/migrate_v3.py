"""Phase 7 — Barcode / Printer / Scan-event migrations.

Non-breaking ALTER TABLE statements. All new columns are nullable or have
server defaults so existing rows are preserved.

Run:
    cd backend && python -m scripts.migrate_v3
or:
    psql $DATABASE_URL -f backend/scripts/migrations_phase7.sql
"""
from __future__ import annotations

import logging
import sys
from pathlib import Path

from sqlalchemy import text

# Allow running as `python -m scripts.migrate_v3` from inside `backend/`
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.database import engine

log = logging.getLogger("kalika.migrations.phase7")


PHASE7_SQL = [
    # ---- products: barcode + traceability ----
    "ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode VARCHAR(80) DEFAULT ''",
    "ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode_format VARCHAR(30) DEFAULT 'CODE128'",
    "ALTER TABLE products ADD COLUMN IF NOT EXISTS qr_data TEXT DEFAULT ''",
    "ALTER TABLE products ADD COLUMN IF NOT EXISTS weight_per_unit DOUBLE PRECISION",
    "ALTER TABLE products ADD COLUMN IF NOT EXISTS weight_uom VARCHAR(10) DEFAULT 'KG'",
    "ALTER TABLE products ADD COLUMN IF NOT EXISTS standard_rate NUMERIC(14,2)",
    "ALTER TABLE products ADD COLUMN IF NOT EXISTS hsn_code VARCHAR(20) DEFAULT ''",
    "ALTER TABLE products ADD COLUMN IF NOT EXISTS gst_rate DOUBLE PRECISION",
    "CREATE INDEX IF NOT EXISTS ix_products_barcode ON products(barcode)",

    # ---- printer_configs ----
    """
    CREATE TABLE IF NOT EXISTS printer_configs (
        id SERIAL PRIMARY KEY,
        workstation VARCHAR(80) DEFAULT 'DEFAULT',
        name VARCHAR(120) NOT NULL,
        kind VARCHAR(20) DEFAULT 'LABEL',
        protocol VARCHAR(20) DEFAULT 'TSPL',
        connection VARCHAR(20) DEFAULT 'USB',
        host VARCHAR(120) DEFAULT '',
        port INTEGER DEFAULT 9100,
        device_path VARCHAR(255) DEFAULT '',
        label_width_mm DOUBLE PRECISION DEFAULT 104.0,
        label_height_mm DOUBLE PRECISION DEFAULT 50.0,
        dpi INTEGER DEFAULT 203,
        is_default BOOLEAN DEFAULT FALSE,
        is_active BOOLEAN DEFAULT TRUE,
        notes TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW(),
        CONSTRAINT uq_printer_workstation_name UNIQUE (workstation, name)
    )
    """,
    "CREATE INDEX IF NOT EXISTS ix_printer_configs_workstation ON printer_configs(workstation)",

    # ---- scan_events ----
    """
    CREATE TABLE IF NOT EXISTS scan_events (
        id BIGSERIAL PRIMARY KEY,
        event_type VARCHAR(30) NOT NULL,
        direction VARCHAR(10) DEFAULT 'IN',
        product_id INTEGER REFERENCES products(id),
        ref_type VARCHAR(40) DEFAULT '',
        ref_id INTEGER,
        barcode_value VARCHAR(120) DEFAULT '',
        quantity DOUBLE PRECISION DEFAULT 0,
        weight_kg DOUBLE PRECISION,
        user_id INTEGER REFERENCES users(id),
        device_source VARCHAR(40) DEFAULT 'USB_HID',
        scanned_at TIMESTAMP DEFAULT NOW()
    )
    """,
    "CREATE INDEX IF NOT EXISTS ix_scan_event_date_product ON scan_events(scanned_at, product_id)",
    "CREATE INDEX IF NOT EXISTS ix_scan_events_event_type ON scan_events(event_type)",
    "CREATE INDEX IF NOT EXISTS ix_scan_events_product_id ON scan_events(product_id)",
    "CREATE INDEX IF NOT EXISTS ix_scan_events_barcode_value ON scan_events(barcode_value)",
    "CREATE INDEX IF NOT EXISTS ix_scan_events_user_id ON scan_events(user_id)",

    # Seed a default TSC TTP-247 printer config (works with USB + TSPL)
    """
    INSERT INTO printer_configs
        (workstation, name, kind, protocol, connection, host, port, device_path,
         label_width_mm, label_height_mm, dpi, is_default, is_active, notes)
    VALUES
        ('DEFAULT', 'TSC TTP-247 (USB)', 'LABEL', 'TSPL', 'USB', '', 9100,
         '/dev/usb/lp0', 104.0, 50.0, 203, TRUE, TRUE,
         'TSC TTP-247 — 4-inch desktop thermal transfer, 203 dpi, 7 ips. TSPL-EZD firmware.')
    ON CONFLICT (workstation, name) DO NOTHING
    """,
]


def run() -> None:
    with engine.begin() as conn:
        for stmt in PHASE7_SQL:
            try:
                conn.execute(text(stmt))
                log.info("OK: %s", stmt[:80].replace("\n", " "))
            except Exception as exc:
                log.warning("SKIP (%s): %s", exc, stmt[:80].replace("\n", " "))
    log.info("Phase 7 migrations complete.")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run()
