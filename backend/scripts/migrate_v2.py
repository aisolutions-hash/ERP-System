"""Phase 3: run the v2 migration into an ISOLATED staging database.

The live PostgreSQL database is never touched. A fresh staging SQLite file is
created per run (use --fresh to overwrite an existing staging file), the
workbook is imported into it, and a validation report reconciles Excel vs ERP.

Usage:
    python scripts\\migrate_v2.py [--file PATH] [--staging PATH] [--fresh]
"""
import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app import models  # noqa: F401  (register models)
from app.services.migration_v2 import run_migration_v2
from app.services.validation_v2 import validate_batch

DEFAULT_XLSX = Path(__file__).resolve().parent.parent.parent / "data" / "gcs-cache" / "Kalika_inventory" / "Daily Report Aug-26.xlsx"
DEFAULT_STAGING = Path(__file__).resolve().parent.parent / "data" / "import_batches" / "staging_aug_2026.sqlite"
REPORT_DIR = Path(__file__).resolve().parent.parent / "reports"


def main():
    ap = argparse.ArgumentParser(description="v2 isolated migration + validation")
    ap.add_argument("--file", default=str(DEFAULT_XLSX), help="source workbook")
    ap.add_argument("--staging", default=str(DEFAULT_STAGING), help="staging sqlite path")
    ap.add_argument("--fresh", action="store_true", help="delete existing staging file first")
    args = ap.parse_args()

    xlsx = Path(args.file)
    staging = Path(args.staging)
    if not xlsx.exists():
        print(f"[!!] source workbook not found: {xlsx}")
        sys.exit(2)
    if staging.exists():
        if not args.fresh:
            print(f"[!!] staging file exists: {staging} (use --fresh to overwrite)")
            sys.exit(2)
        staging.unlink()
    staging.parent.mkdir(parents=True, exist_ok=True)

    engine = create_engine(f"sqlite:///{staging}", future=True)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autoflush=False, autocommit=False,
                           expire_on_commit=False, future=True)
    db = Session()
    try:
        print(f"[migrate v2] importing {xlsx.name} -> {staging.name}")
        result = run_migration_v2(db, xlsx)
        batch, period, ctx, parsed = result["batch"], result["period"], result["ctx"], result["parsed"]

        print(f"[migrate v2] import batch #{batch.id} imported; running validation ...")
        report = validate_batch(db, parsed, batch.id)

        batch.status = report["status"]
        batch.hard_errors = json.dumps(report["hard_errors"], indent=1)
        batch.warnings = json.dumps(report["warnings"] + ctx.warnings, indent=1)
        stats = dict(ctx.stats)
        batch.stats = json.dumps(stats, indent=1)
        db.commit()

        REPORT_DIR.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        report_path = REPORT_DIR / f"validation_batch_{batch.id}_{ts}.json"
        full_report = {
            "batch_id": batch.id, "source_file": str(xlsx),
            "staging_db": str(staging), "period": f"{period.year}-{period.month:02d}",
            "status": report["status"], "stats": stats,
            "hard_errors": report["hard_errors"],
            "warnings": report["warnings"] + ctx.warnings,
            "checks": report["checks"],
        }
        report_path.write_text(json.dumps(full_report, indent=1, default=str), encoding="utf-8")

        print("\n===== IMPORT STATS =====")
        for k in sorted(stats):
            print(f"  {k}: {stats[k]}")
        print("\n===== VALIDATION =====")
        ok = sum(1 for c in report["checks"] if c["status"] == "OK")
        fail = sum(1 for c in report["checks"] if c["status"] == "FAIL")
        print(f"  checks passed: {ok}  failed: {fail}")
        if report["hard_errors"]:
            print("  HARD ERRORS:")
            for e in report["hard_errors"]:
                print(f"   [x] {e}")
        print("  WARNINGS:")
        for w in report["warnings"] + ctx.warnings:
            print(f"   [!] {w}")
        print(f"\n  STATUS: {report['status']}")
        print(f"  report: {report_path}")
        print("  LIVE DATABASE: untouched (staging only)")
        sys.exit(0 if report["status"] == "READY_FOR_PROMOTION" else 1)
    finally:
        db.close()


if __name__ == "__main__":
    main()
