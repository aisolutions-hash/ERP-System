"""Validation: reconcile a v2 import batch against the source workbook.

Hard errors (fail validation):
  * row-count mismatch per sheet
  * daily quantity totals mismatch per sheet/day
  * per-customer totals mismatch
  * identifier corruption (float-style text ids)
  * sub-total / grand-total leakage into masters
  * duplicate transactions
  * orphan lines (line without parent/product)
Warnings (do not block):
  * stale 2025 date headers remapped to Aug-2026
  * unknown STORE PO NO semantics
  * TCL-2-3 historical split unavailable
  * missing item codes, non-numeric quantities, negative balances
  * Excel cached totals that disagree with their own daily cells
"""
from __future__ import annotations

import re
from collections import defaultdict

from sqlalchemy import func, select

from ..models import (
    Customer, Dispatch, DispatchLine, MovementType, OrderType, Product,
    ProductionOrder, RawMaterialBalance, SalesOrder, SalesOrderLine,
    StockMovement,
)
from .migration_v2 import canonical_customer

FLOAT_ID_RE = re.compile(r"^\d+\.0$")
TOTAL_NAMES = {"SUB-TOTAL", "SUBTOTAL", "G. TOTAL", "G.TOTAL", "TOTAL", "GRAND TOTAL"}
SALESPERSON_NAMES = {"ASMITA", "VAISHNAVI", "NARAYAN", "NIKITA", "GANESH",
                     "ABHISHEK", "SATYA", "SANDIP", "DHARMA", "VAISHNAVI / NARAYAN"}

TOL = 1e-6


def _close(a, b):
    return abs((a or 0) - (b or 0)) <= TOL


def validate_batch(db, parsed: dict, batch_id: int) -> dict:
    hard: list[str] = []
    warnings: list[str] = []
    checks: list[dict] = []

    def check(name, sheet, excel, erp, ok):
        checks.append({"check": name, "sheet": sheet, "excel": excel,
                       "erp": erp, "diff": (erp - excel) if isinstance(excel, (int, float)) and isinstance(erp, (int, float)) else None,
                       "status": "OK" if ok else "FAIL"})
        if not ok:
            hard.append(f"{sheet}: {name} excel={excel} erp={erp}")

    # ------------------------------------------------------------------
    # 1. row counts per sheet
    # ------------------------------------------------------------------
    counts = {
        "RAW  MATERIAL": db.scalar(select(func.count()).select_from(RawMaterialBalance)) or 0,
        "STORE": db.scalar(select(func.count()).select_from(SalesOrder).where(
            SalesOrder.order_type == "TRADING", SalesOrder.import_batch_id == batch_id)) or 0,
        "PRODUCTION": db.scalar(select(func.count()).select_from(ProductionOrder).where(
            ProductionOrder.import_batch_id == batch_id)) or 0,
        "DISPATCH": db.scalar(select(func.count()).select_from(Dispatch).where(
            Dispatch.import_batch_id == batch_id)) or 0,
    }
    for sheet, db_count in counts.items():
        p = parsed.get(sheet)
        if p is None:
            hard.append(f"{sheet}: missing parse")
            continue
        excel_rows = sum(len(s.rows) for s in p.sections)
        if sheet == "STORE":
            # STORE rows without code+model are skipped by the importer
            excel_rows = sum(1 for s in p.sections for r in s.rows if r.code or r.values.get("MODEL"))
        check("row_count", sheet, excel_rows, db_count, excel_rows == db_count)

    # ------------------------------------------------------------------
    # 2. daily totals per sheet/day (parsed daily cells vs stock movements)
    # ------------------------------------------------------------------
    sheet_to_type = {
        "RAW  MATERIAL": MovementType.purchase_receipt,
        "PRODUCTION": MovementType.production_output,
        "DISPATCH": MovementType.dispatch,
        "STORE": MovementType.dispatch,
    }
    for sheet, mtype in sheet_to_type.items():
        p = parsed.get(sheet)
        if p is None:
            continue
        excel_daily = defaultdict(float)
        for s in p.sections:
            for r in s.rows:
                for d, q in r.daily.items():
                    excel_daily[d] += q
        db_daily = defaultdict(float)
        rows = db.scalars(select(StockMovement).where(
            StockMovement.source_sheet == sheet,
            StockMovement.movement_type == mtype,
            StockMovement.import_batch_id == batch_id)).all()
        for m in rows:
            db_daily[m.transaction_date] += m.quantity
        all_days = sorted(set(excel_daily) | set(db_daily))
        for d in all_days:
            e, v = excel_daily.get(d, 0.0), db_daily.get(d, 0.0)
            check(f"daily_total {d.isoformat()} {mtype}", sheet, round(e, 4), round(v, 4), _close(e, v))
        check(f"daily_txn_count {mtype}", sheet,
              sum(len(r.daily) for s in p.sections for r in s.rows), len(rows),
              sum(len(r.daily) for s in p.sections for r in s.rows) == len(rows))

    # ------------------------------------------------------------------
    # 3. per-customer totals (STORE + DISPATCH)
    # ------------------------------------------------------------------
    # Excel side
    for sheet in ("STORE", "DISPATCH"):
        p = parsed.get(sheet)
        if p is None:
            continue
        excel_by_cust: dict[str, dict[str, float]] = defaultdict(lambda: {"schedule": 0.0, "qty": 0.0})
        sched_key = "PO QTY" if sheet == "STORE" else "SCHEDULE"
        for s in p.sections:
            label = canonical_customer(s.label) if s.label else "(unassigned)"
            for r in s.rows:
                excel_by_cust[label]["schedule"] += float(r.values.get(sched_key) or 0) if isinstance(r.values.get(sched_key), (int, float)) else 0
                excel_by_cust[label]["qty"] += sum(r.daily.values())
        # ERP side
        if sheet == "STORE":
            rows = db.execute(
                select(Customer.name, func.sum(SalesOrderLine.quantity))
                .select_from(SalesOrder)
                .join(Customer, Customer.id == SalesOrder.customer_id, isouter=True)
                .join(SalesOrderLine, SalesOrderLine.order_id == SalesOrder.id)
                .where(SalesOrder.order_type == OrderType.trading,
                       SalesOrder.import_batch_id == batch_id)
                .group_by(Customer.name)).all()
            erp_by_cust = {n or "(unassigned)": {"schedule": q or 0.0, "qty": 0.0} for n, q in rows}
            mv = db.execute(
                select(SalesOrder.customer_id, func.sum(StockMovement.quantity))
                .select_from(StockMovement)
                .join(SalesOrder, SalesOrder.id == StockMovement.ref_id)
                .where(StockMovement.ref_type == "sales_order",
                       StockMovement.source_sheet == "STORE",
                       StockMovement.import_batch_id == batch_id)
                .group_by(SalesOrder.customer_id)).all()
            mv_by_cid = {cid: q for cid, q in mv}
            cust_names = {c.id: c.name for c in db.scalars(select(Customer)).all()}
            for name, sums in excel_by_cust.items():
                erp_s = erp_by_cust.get(name, {"schedule": 0.0, "qty": 0.0})
                check(f"customer schedule total [{name}]", sheet,
                      round(sums["schedule"], 4), round(erp_s["schedule"], 4),
                      _close(sums["schedule"], erp_s["schedule"]))
            # qty via movements per customer
            cid_by_name = {v: k for k, v in cust_names.items()}
            for name, sums in excel_by_cust.items():
                cid = cid_by_name.get(name)
                v = mv_by_cid.get(cid, 0.0)
                check(f"customer outward total [{name}]", sheet,
                      round(sums["qty"], 4), round(v, 4), _close(sums["qty"], v))
        else:
            rows = db.execute(
                select(Customer.name, func.sum(Dispatch.schedule_qty),
                       func.sum(Dispatch.dispatched_qty))
                .select_from(Dispatch)
                .join(Customer, Customer.id == Dispatch.customer_id, isouter=True)
                .where(Dispatch.import_batch_id == batch_id)
                .group_by(Customer.name)).all()
            erp_by_cust = {n or "(unassigned)": {"schedule": q or 0.0, "qty": m or 0.0}
                           for n, q, m in rows}
            for name, sums in excel_by_cust.items():
                erp_s = erp_by_cust.get(name, {"schedule": 0.0, "qty": 0.0})
                check(f"customer schedule total [{name}]", sheet,
                      round(sums["schedule"], 4), round(erp_s["schedule"], 4),
                      _close(sums["schedule"], erp_s["schedule"]))
                check(f"customer dispatch total [{name}]", sheet,
                      round(sums["qty"], 4), round(erp_s["qty"], 4),
                      _close(sums["qty"], erp_s["qty"]))

    # ------------------------------------------------------------------
    # 4. identifier corruption
    # ------------------------------------------------------------------
    all_codes = db.scalars(select(Product.item_code)).all()
    bad_ids = [c for c in all_codes if FLOAT_ID_RE.match(c or "")]
    all_pos = db.scalars(select(SalesOrderLine.customer_po_no)).all()
    bad_pos = [c for c in all_pos if FLOAT_ID_RE.match(c or "")]
    if bad_ids or bad_pos:
        hard.append(f"identifier corruption: item_codes={bad_ids[:5]} po_nos={bad_pos[:5]}")
    checks.append({"check": "identifier_text_integrity", "sheet": "ALL",
                   "excel": "text ids", "erp": f"bad={len(bad_ids) + len(bad_pos)}",
                   "diff": None, "status": "OK" if not (bad_ids or bad_pos) else "FAIL"})

    # ------------------------------------------------------------------
    # 5. sub-total / grand-total leakage into masters
    # ------------------------------------------------------------------
    leak_p = db.scalars(select(Product.model).where(func.upper(Product.model).in_(TOTAL_NAMES))).all()
    leak_c = db.scalars(select(Customer.name).where(func.upper(Customer.name).in_(TOTAL_NAMES))).all()
    leak_sp = db.scalars(select(Customer.name).where(func.upper(Customer.name).in_(SALESPERSON_NAMES))).all()
    for label, leaks in (("product", leak_p), ("customer", leak_c), ("salesperson-as-customer", leak_sp)):
        if leaks:
            hard.append(f"{label} leakage: {leaks[:8]}")
    checks.append({"check": "no_subtotal_leakage", "sheet": "ALL",
                   "excel": "totals excluded", "erp": f"leaks={len(leak_p) + len(leak_c) + len(leak_sp)}",
                   "diff": None, "status": "OK" if not (leak_p or leak_c or leak_sp) else "FAIL"})

    # ------------------------------------------------------------------
    # 6. duplicate transactions
    # ------------------------------------------------------------------
    dup = db.execute(
        select(StockMovement.product_id, StockMovement.transaction_date,
               StockMovement.movement_type, StockMovement.source_sheet,
               StockMovement.source_row, func.count())
        .where(StockMovement.import_batch_id == batch_id)
        .group_by(StockMovement.product_id, StockMovement.transaction_date,
                  StockMovement.movement_type, StockMovement.source_sheet,
                  StockMovement.source_row)
        .having(func.count() > 1)).all()
    if dup:
        hard.append(f"duplicate stock movements: {len(dup)} groups e.g. {dup[:3]}")
    checks.append({"check": "no_duplicate_movements", "sheet": "ALL",
                   "excel": "unique", "erp": f"dup_groups={len(dup)}",
                   "diff": None, "status": "OK" if not dup else "FAIL"})

    # ------------------------------------------------------------------
    # 7. orphans
    # ------------------------------------------------------------------
    orphan_dl = db.scalar(select(func.count()).select_from(DispatchLine).where(
        DispatchLine.product_id.is_(None), DispatchLine.import_batch_id == batch_id)) or 0
    orphan_sl = db.scalar(select(func.count()).select_from(SalesOrderLine).where(
        SalesOrderLine.product_id.is_(None), SalesOrderLine.import_batch_id == batch_id)) or 0
    if orphan_dl or orphan_sl:
        hard.append(f"orphan lines: dispatch_lines={orphan_dl} sales_order_lines={orphan_sl}")
    checks.append({"check": "no_orphan_lines", "sheet": "ALL",
                   "excel": "linked", "erp": f"orphans={orphan_dl + orphan_sl}",
                   "diff": None, "status": "OK" if not (orphan_dl or orphan_sl) else "FAIL"})

    # ------------------------------------------------------------------
    # warnings
    # ------------------------------------------------------------------
    # Excel cached qty column vs its own daily cells (source inconsistency)
    for sheet in ("STORE", "DISPATCH", "PRODUCTION", "RAW  MATERIAL"):
        p = parsed.get(sheet)
        if p is None:
            continue
        qty_key = {"STORE": "OUTWARD", "DISPATCH": "DISPATCH",
                   "PRODUCTION": "PRODUCTION QTY", "RAW  MATERIAL": "INWARD QTY"}[sheet]
        mismatches = []
        for s in p.sections:
            for r in s.rows:
                cached = r.values.get(qty_key)
                if isinstance(cached, (int, float)) and not _close(float(cached), sum(r.daily.values())):
                    mismatches.append(r.row)
        if mismatches:
            warnings.append(f"{sheet}: {len(mismatches)} rows where cached {qty_key} != sum(daily cells) "
                            f"(source inconsistency; daily cells used as truth) rows={mismatches[:10]}")
    # negative balances
    for sheet in ("STORE", "DISPATCH"):
        p = parsed.get(sheet)
        if p is None:
            continue
        sched_key = "PO QTY" if sheet == "STORE" else "SCHEDULE"
        neg = [r.row for s in p.sections for r in s.rows
               if isinstance(r.values.get(sched_key), (int, float))
               and (r.values.get(sched_key) - sum(r.daily.values())) < -TOL]
        if neg:
            warnings.append(f"{sheet}: {len(neg)} rows over-dispatched (negative balance preserved) rows={neg[:10]}")
    # missing item codes
    for sheet in ("STORE", "DISPATCH", "PRODUCTION"):
        p = parsed.get(sheet)
        if p is None:
            continue
        missing = [r.row for s in p.sections for r in s.rows
                   if not r.code and (r.values.get("MODEL"))]
        if missing:
            warnings.append(f"{sheet}: {len(missing)} product rows without item code (model-keyed) rows={missing[:10]}")

    status = "READY_FOR_PROMOTION" if not hard else "NOT_READY_FOR_PROMOTION"
    return {"status": status, "hard_errors": hard, "warnings": warnings, "checks": checks}
