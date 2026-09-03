"""Phase 4 Part A: Promote the validated August 2026 staging data into PostgreSQL.

Strategy (explicit, reversible):
  1. Backup the live database with pg_dump to a timestamped file.
  2. Apply schema migration (create new tables + add new columns, idempotent).
  3. Clear the UNTRUSTED Phase-1 data from the tables being promoted
     (already backed up in step 1), preserving users/auth tables.
  4. Promote every validated staging record verbatim (IDs + source refs kept).
  5. Derive inventory (finished/trading stock) from the stock_movements ledger.
  6. Verify final counts vs staging.

The live database is only modified by this script and never by import/validate.

Usage:
  python scripts/promote_v2.py [--staging PATH] [--dry-run]
"""
import argparse
import subprocess
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import create_engine, text
from app.config import settings
from app.database import Base
import app.models  # noqa: F401

DEFAULT_STAGING = Path(__file__).resolve().parent.parent / "data" / "import_batches" / "staging_aug_2026.sqlite"
BACKUP_DIR = Path(__file__).resolve().parent.parent / "data" / "backups"

# Tables promoted verbatim from staging, in dependency (FK) order.
# Each element: (staging_table, pg_table), columns transferred as-is.
TRANSACTION_TABLES = [
    "reporting_periods", "import_batches", "customers", "customer_aliases",
    "salespersons", "products", "product_aliases", "raw_material_balances",
    "plants", "production_orders", "production_movements", "sales_orders",
    "sales_order_lines", "dispatches", "dispatch_lines", "stock_movements",
    "plans", "suppliers",
]
# tables whose Phase-1 rows are cleared before promotion
CLEAR_TABLES = ["plans", "purchase_order_lines", "purchase_orders",
                "stock_movements", "dispatch_lines", "dispatches",
                "sales_order_lines", "sales_orders", "production_movements",
                "production_orders", "raw_material_balances", "inventory",
                "plants", "product_aliases", "products", "customer_aliases",
                "salespersons", "customers", "suppliers",
                "import_batches", "reporting_periods"]


def extend_enums(eng):
    """Add newly-introduced enum members to native PG enum types."""
    extend = {
        "movementtype": ["opening", "purchase_receipt", "rm_consumption", "transfer"],
    }
    with eng.begin() as c:
        for typname, members in extend.items():
            for m in members:
                c.execute(text(f"ALTER TYPE {typname} ADD VALUE IF NOT EXISTS '{m}'"))


def schema_migrate(eng):
    """Create missing tables and add missing columns (idempotent)."""
    Base.metadata.create_all(bind=eng)
    adds = {
        "customers": [
            ("source_excel", "VARCHAR(255) DEFAULT ''"),
            ("confirmation_status", "VARCHAR(60) DEFAULT 'CONFIRMED'"),
        ],
        "products": [
            ("source_type", "VARCHAR(60) DEFAULT 'UNKNOWN'"),
            ("family", "VARCHAR(120) DEFAULT ''"),
            ("sourcing_note", "TEXT DEFAULT ''"),
            ("source_sheet", "VARCHAR(120) DEFAULT ''"),
            ("source_row", "INTEGER"),
            ("import_batch_id", "INTEGER"),
            ("source_excel", "VARCHAR(255) DEFAULT ''"),
        ],
        "stock_movements": [
            ("source_excel", "VARCHAR(255) DEFAULT ''"),
            ("source_sheet", "VARCHAR(120) DEFAULT ''"),
            ("source_row", "INTEGER"),
            ("import_batch_id", "INTEGER"),
            ("remarks", "TEXT DEFAULT ''"),
        ],
        "production_orders": [
            ("ask_till_date", "DOUBLE PRECISION"),
            ("completion_pct", "DOUBLE PRECISION"),
            ("opening_stock", "DOUBLE PRECISION DEFAULT 0"),
            ("source_sheet", "VARCHAR(120) DEFAULT ''"),
            ("source_row", "INTEGER"),
            ("import_batch_id", "INTEGER"),
            ("period_id", "INTEGER"),
            ("source_excel", "VARCHAR(255) DEFAULT ''"),
            ("remarks", "TEXT DEFAULT ''"),
        ],
        "production_movements": [
            ("source_excel", "VARCHAR(255) DEFAULT ''"),
            ("source_row", "INTEGER"),
            ("import_batch_id", "INTEGER"),
        ],
        "sales_orders": [
            ("order_type", "VARCHAR(40) DEFAULT 'OEM'"),
            ("customer_po_no", "VARCHAR(120) DEFAULT ''"),
            ("salesperson_id", "INTEGER"),
            ("period_id", "INTEGER"),
            ("required_delivery_date", "DATE"),
            ("source_excel", "VARCHAR(255) DEFAULT ''"),
            ("source_sheet", "VARCHAR(120) DEFAULT ''"),
            ("source_row", "INTEGER"),
            ("import_batch_id", "INTEGER"),
        ],
        "sales_order_lines": [
            ("customer_po_no", "VARCHAR(120) DEFAULT ''"),
            ("source_row", "INTEGER"),
            ("import_batch_id", "INTEGER"),
        ],
        "dispatches": [
            ("salesperson_id", "INTEGER"),
            ("period_id", "INTEGER"),
            ("ask_till_date", "DOUBLE PRECISION"),
            ("completion_pct", "DOUBLE PRECISION"),
            ("opening_stock", "DOUBLE PRECISION DEFAULT 0"),
            ("dispatch_date", "DATE"),
            ("delivery_status", "VARCHAR(120) DEFAULT ''"),
            ("transport_details", "TEXT DEFAULT ''"),
            ("report_date", "DATE"),
            ("source_excel", "VARCHAR(255) DEFAULT ''"),
            ("source_sheet", "VARCHAR(120) DEFAULT ''"),
            ("source_row", "INTEGER"),
            ("import_batch_id", "INTEGER"),
            ("remarks", "TEXT DEFAULT ''"),
        ],
        "dispatch_lines": [
            ("rate", "NUMERIC(14,2)"),
            ("weight", "DOUBLE PRECISION"),
            ("source_excel", "VARCHAR(255) DEFAULT ''"),
            ("source_row", "INTEGER"),
            ("import_batch_id", "INTEGER"),
        ],
        "plans": [
            ("source_excel", "VARCHAR(255) DEFAULT ''"),
            ("source_sheet", "VARCHAR(120) DEFAULT ''"),
            ("source_row", "INTEGER"),
            ("import_batch_id", "INTEGER"),
            ("remarks", "TEXT DEFAULT ''"),
        ],
        "raw_material_balances": [
            ("source_row", "INTEGER"),
            ("import_batch_id", "INTEGER"),
            ("notes", "TEXT DEFAULT ''"),
        ],
    }
    with eng.begin() as c:
        for tbl, cols in adds.items():
            for name, ddl in cols:
                c.execute(text(f'ALTER TABLE {tbl} ADD COLUMN IF NOT EXISTS {name} {ddl}'))


def _find_pgdump():
    import shutil
    exe = shutil.which("pg_dump")
    if exe:
        return exe
    for ver in ("17", "16", "15", "14"):
        cand = Path(f"C:/Program Files/PostgreSQL/{ver}/bin/pg_dump.exe")
        if cand.exists():
            return str(cand)
    return "pg_dump"


def backup(eng):
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = BACKUP_DIR / f"kalika_erp_prepromote_{ts}.dump"
    url = settings.DATABASE_URL
    # parse: postgresql+psycopg2://user:pass@host:port/db
    cred = url.split("://")[1]
    user, rest = cred.split(":", 1)
    passwd, rest2 = rest.split("@", 1)
    hostport, dbname = rest2.rsplit("/", 1)
    host = hostport.split(":")[0]
    port = hostport.split(":")[1] if ":" in hostport else "5432"
    env = dict(__import__("os").environ)
    env["PGPASSWORD"] = passwd
    cmd = [_find_pgdump(), "-h", host, "-p", port, "-U", user, "-Fc", "-f", str(path), dbname]
    print(f"[backup] {cmd}  -> {path}")
    subprocess.run(cmd, env=env, check=True)
    print(f"[backup] wrote {path}")
    return path


def clear(eng):
    with eng.begin() as c:
        for tbl in CLEAR_TABLES:
            c.execute(text(f"DELETE FROM {tbl}"))


def _iso(v):
    if v is None:
        return None
    return v.isoformat() if hasattr(v, "isoformat") else v


def _coerce(meta_col, value):
    """Coerce a sqlite3 value to the PostgreSQL column type."""
    import datetime as _dt
    from sqlalchemy import Boolean, Date, DateTime
    if value is None:
        return None
    typ = meta_col.type
    if isinstance(typ, Boolean):
        if isinstance(value, bool):
            return value
        return bool(int(value))
    if isinstance(typ, DateTime):
        if isinstance(value, _dt.datetime):
            return value
        if isinstance(value, _dt.date):
            return _dt.datetime.combine(value, _dt.time())
        return value  # let PG parse ISO string
    if isinstance(typ, Date):
        if isinstance(value, _dt.datetime):
            return value.date()
        if isinstance(value, _dt.date):
            return value
        # sqlite returns 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM:SS'
        s = str(value).split(" ")[0]
        return _dt.date.fromisoformat(s)
    return value


def promote(eng, staging, dry_run=False):
    import sqlite3
    from sqlalchemy import inspect as sa_inspect
    scon = sqlite3.connect(str(staging))
    scon.row_factory = sqlite3.Row
    scur = scon.cursor()
    meta = Base.metadata

    counts = {}
    if dry_run:
        with eng.connect() as c:
            for tbl in TRANSACTION_TABLES:
                n = scur.execute(f"SELECT COUNT(*) FROM {tbl}").fetchone()[0]
                counts[tbl] = n
        return counts

    with eng.begin() as c:
        for tbl in TRANSACTION_TABLES:
            rows = scur.execute(f"SELECT * FROM {tbl}").fetchall()
            if not rows:
                counts[tbl] = 0
                continue
            cols = rows[0].keys()
            table = meta.tables[tbl]
            placeholders = ", ".join([f":{col}" for col in cols])
            colsql = ", ".join(cols)
            for r in rows:
                params = {col: _coerce(table.c[col], r[col]) for col in cols}
                c.execute(text(f"INSERT INTO {tbl} ({colsql}) VALUES ({placeholders})"), params)
            counts[tbl] = len(rows)
        # reset identity sequences
        seq_tables = TRANSACTION_TABLES
        for tbl in seq_tables:
            try:
                c.execute(text(
                    f"SELECT setval(pg_get_serial_sequence('{tbl}', 'id'), "
                    f"(SELECT COALESCE(MAX(id),1) FROM {tbl}))"))
            except Exception:
                pass
    return counts


def derive_inventory(eng, dry_run=False):
    """Finished/trading stock from the stock_movements ledger (per product, no plant)."""
    sql = """
    INSERT INTO inventory (product_id, plant_id, opening_stock, received_qty, issued_qty, current_stock, min_level, updated_at)
    SELECT m.product_id, NULL,
           COALESCE(SUM(CASE WHEN m.movement_type='opening' THEN m.quantity ELSE 0 END),0),
           COALESCE(SUM(CASE WHEN m.movement_type IN ('receipt','purchase_receipt','production_output','transfer','adjustment') THEN m.quantity ELSE 0 END),0),
           COALESCE(SUM(CASE WHEN m.movement_type IN ('issue','dispatch','consumption','rm_consumption') THEN m.quantity ELSE 0 END),0),
           SUM(m.quantity), NULL, now()
    FROM stock_movements m
    GROUP BY m.product_id HAVING SUM(m.quantity) <> 0
    """
    if dry_run:
        return 0
    with eng.begin() as c:
        r = c.execute(text(sql))
        return r.rowcount


def verify(eng, staging):
    import sqlite3
    scon = sqlite3.connect(str(staging))
    scur = scon.cursor()
    with eng.connect() as c:
        print("\n===== VERIFICATION (staging vs PostgreSQL) =====")
        status = True
        for tbl in TRANSACTION_TABLES:
            s = scur.execute(f"SELECT COUNT(*) FROM {tbl}").fetchone()[0]
            p = c.execute(text(f"SELECT COUNT(*) FROM {tbl}")).fetchone()[0]
            ok = s == p
            status &= ok
            print(f"  {tbl:22} staging={s:<6} pg={p:<6} {'OK' if ok else 'MISMATCH'}")
        inv = c.execute(text("SELECT COUNT(*) FROM inventory")).fetchone()[0]
        print(f"  {'inventory (derived)':22} pg={inv}")
        return status


def main():
    ap = argparse.ArgumentParser(description="Promote validated staging -> PostgreSQL")
    ap.add_argument("--staging", default=str(DEFAULT_STAGING))
    ap.add_argument("--dry-run", action="store_true", help="report plan without writing")
    args = ap.parse_args()

    staging = Path(args.staging)
    if not staging.exists():
        print(f"[!!] staging file not found: {staging}")
        sys.exit(2)

    eng = create_engine(settings.DATABASE_URL, future=True)

    if args.dry_run:
        print("[dry-run] schema migration:")
        # just report table create needs
        counts = promote(eng, staging, dry_run=True)
        print("  would promote:", counts)
        return

    print("== Schema migrate ==")
    extend_enums(eng)
    schema_migrate(eng)
    print(".. schema up to date")

    print("== Backup ==")
    backup(eng)

    print("== Clear untrusted Phase-1 data ==")
    clear(eng)
    print(".. cleared")

    print("== Promote validated staging data ==")
    counts = promote(eng, staging)
    for k, v in counts.items():
        print(f"  {k}: {v}")

    print("== Derive inventory from stock ledger ==")
    n = derive_inventory(eng)
    print(f"  inventory rows: {n}")

    ok = verify(eng, staging)
    print("\nRESULT:", "PROMOTED_OK" if ok else "PROMOTION_MISMATCH")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
