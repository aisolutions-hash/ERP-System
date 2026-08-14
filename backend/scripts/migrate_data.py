"""Run the Excel -> PostgreSQL migration."""
import argparse
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import settings
from app.services import gcs
from app.services.migration import run_migration


def main():
    parser = argparse.ArgumentParser(description="Migrate the Kalika Excel report into PostgreSQL")
    parser.add_argument("--file", help="Local xlsx path (default: download from GCS)")
    parser.add_argument("--report-date", default=date.today().isoformat(),
                        help="report_date to stamp on imported rows (ISO format)")
    parser.add_argument("--reset", action="store_true", help="Wipe existing tables before import")
    args = parser.parse_args()

    if args.file:
        xlsx = Path(args.file)
    else:
        print(f"[gcs] downloading {settings.GCS_EXCEL_FILE} ...")
        xlsx = gcs.download_excel()
    print(f"[migrate] using {xlsx} (report_date={args.report_date}, reset={args.reset})")
    rd = date.fromisoformat(args.report_date)
    result = run_migration(xlsx, report_date=rd, reset=args.reset)
    for r in result["results"]:
        if "error" in r:
            print(f"  [!!] {r['sheet']}: ERROR {r['error']}")
        elif r.get("skipped_existing"):
            print(f"  [..] {r['sheet']}: already migrated for this report date (use --reset to re-import)")
        else:
            print(f"  [ok] {r['sheet']}: {r['imported']} imported, {r['skipped']} skipped")
    print("[migrate] done")


if __name__ == "__main__":
    main()