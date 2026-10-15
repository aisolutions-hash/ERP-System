"""Purchase Requisition Note (PRN) — additive, isolated module.

A PRN records a material purchase requirement, an approval workflow, a
point-in-time stock snapshot and optional attachments. It deliberately does NOT
create purchase orders, goods receipts or stock movements; approved PRNs are
only a validated input to the existing purchasing process.

Nothing here modifies existing tables, APIs or workflows. New tables only, and
all stock numbers are read from the existing Inventory / PurchaseOrder data.
"""
from __future__ import annotations

import os
from datetime import date, datetime
from pathlib import Path
from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..auth import AllStaff, CurrentUser, ManagerOrAdmin
from ..config import settings
from ..crud import write_audit
from ..database import get_db
from ..models import (
    AuditLog, Employee, Inventory, PRN, PRNLine, PRNLineMode, PRNStatus,
    Product, PurchaseOrder, PurchaseOrderLine, PurchaseStatus,
)
from ..schemas import PRNCreate, PRNFulfillmentIn, PRNLineIn, PRNRejectIn, PRNUpdate

router = APIRouter(prefix="/prn", tags=["prn"])

PRIORITIES = ("Normal", "Urgent", "Critical")
REQUIREMENT_TYPES = ("Production", "Maintenance", "Quality", "Safety",
                     "Administration", "Replenishment", "Other")
FULFILLMENT_STATUSES = ("Pending", "Partially Fulfilled", "Completed")
_OPEN_PO_STATUSES = (PurchaseStatus.ordered, PurchaseStatus.partially_received)
# PRNs that have entered the purchasing lifecycle (visible to Purchases).
_PURCHASING_SCOPE = (PRNStatus.sent_to_purchase, PRNStatus.partially_fulfilled,
                     PRNStatus.completed)
# Priority ordering for the purchase queue: Critical → Urgent → Normal.
_PRIORITY_RANK = case(
    (PRN.priority == "Critical", 0), (PRN.priority == "Urgent", 1), else_=2).label("prio_rank")

# Attachments: private storage, validated type + size (never publicly served).
_ALLOWED_EXT = {".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".doc", ".docx",
                ".xls", ".xlsx", ".csv", ".txt"}
_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024


def _attachment_dir() -> Path:
    base = Path(settings.REPORT_DIR).parent / "prn_attachments"
    base.mkdir(parents=True, exist_ok=True)
    return base


# --- numbering -------------------------------------------------------------
def _generate_prn_number(db: Session) -> str:
    # ponytail: max-based sequence with a unique constraint + retry in
    # create_prn serialises concurrent inserts. Ceiling: 9999 PRNs per month
    # (4-digit suffix); switch to a DB sequence if that is ever exceeded.
    prefix = f"PRN-{date.today():%Y%m}-"
    last = db.scalar(
        select(func.max(PRN.prn_number)).where(PRN.prn_number.like(f"{prefix}%"))
    )
    n = 1
    if last:
        try:
            n = int(str(last).rsplit("-", 1)[1]) + 1
        except (ValueError, IndexError):
            n = 1
    return f"{prefix}{n:04d}"


# --- validation ------------------------------------------------------------
def _validate_meta(priority: str | None, requirement_type: str | None) -> None:
    if priority is not None and priority not in PRIORITIES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            f"Invalid priority. Allowed: {', '.join(PRIORITIES)}")
    if requirement_type is not None and requirement_type not in REQUIREMENT_TYPES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            f"Invalid requirement type. Allowed: {', '.join(REQUIREMENT_TYPES)}")


def _validate_lines(lines: list[PRNLineIn], *, require_one: bool) -> None:
    if require_one and not lines:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "At least one material line is required")
    for ln in lines:
        if not (ln.description or "").strip():
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Material description is required")
        if ln.quantity is None or float(ln.quantity) <= 0:
            raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                "Required quantity must be greater than zero")
        if ln.entry_mode == PRNLineMode.existing and not ln.material_id:
            raise HTTPException(status.HTTP_400_BAD_REQUEST,
                                "An existing material must be selected for Existing mode")


def _stock_snapshot(db: Session, product_id: int, required_qty: float | None = None) -> dict:
    """Read available / incoming stock from existing records (never invented).

    Available = Main Store current_stock (the existing convention in
    requirements.py). Reserved is not a concept this system tracks, so it is
    returned as None with a support flag rather than a fabricated number.
    Incoming = open (ordered / partially received) PO line balance.
    """
    available = db.scalar(
        select(func.coalesce(func.sum(Inventory.current_stock), 0)).where(
            Inventory.product_id == product_id, Inventory.plant_id.is_(None))
    ) or 0
    incoming = db.scalar(
        select(func.coalesce(func.sum(PurchaseOrderLine.quantity - PurchaseOrderLine.received_qty), 0))
        .join(PurchaseOrder, PurchaseOrder.id == PurchaseOrderLine.po_id)
        .where(PurchaseOrderLine.product_id == product_id,
               PurchaseOrder.status.in_(_OPEN_PO_STATUSES))
    ) or 0
    available = float(available)
    incoming = float(incoming)
    suggested = None
    if required_qty is not None:
        suggested = max(float(required_qty) - available - incoming, 0.0)
    return {
        "available_stock": available,
        "reserved_stock": None,
        "reserved_supported": False,
        "incoming_qty": incoming,
        "suggested_qty": suggested,
    }


# --- serialization ---------------------------------------------------------
def _line_out(ln: PRNLine) -> dict:
    return {
        "id": ln.id,
        "entry_mode": ln.entry_mode.value,
        "material_id": ln.material_id,
        "material_code": ln.material_code,
        "description": ln.description,
        "specification": ln.specification,
        "quantity": ln.quantity,
        "uom": ln.uom,
        "available_stock": ln.available_stock,
        "reserved_stock": ln.reserved_stock,
        "incoming_qty": ln.incoming_qty,
        "suggested_qty": ln.suggested_qty,
        "remarks": ln.remarks,
        "attachment_name": ln.attachment_name,
        "has_attachment": bool(ln.attachment_path),
        "is_new_material": ln.is_new_material,
    }


def _prn_out(prn: PRN, with_lines: bool = True) -> dict:
    out = {
        "id": prn.id,
        "prn_number": prn.prn_number,
        "prn_date": prn.prn_date.isoformat() if prn.prn_date else None,
        "department": prn.department,
        "requested_by_id": prn.requested_by_id,
        "requested_by_name": prn.requested_by_name,
        "required_by_date": prn.required_by_date.isoformat() if prn.required_by_date else None,
        "priority": prn.priority,
        "requirement_type": prn.requirement_type,
        "purpose": prn.purpose,
        "status": prn.status.value,
        "fulfillment_status": prn.fulfillment_status,
        "rejection_reason": prn.rejection_reason,
        "approved_by_name": prn.approved_by_name,
        "approved_at": prn.approved_at.isoformat() if prn.approved_at else None,
        "purchase_reference": prn.purchase_reference,
        "production_reference": prn.production_reference,
        "company_name": prn.company_name,
        "department_head": prn.department_head,
        "checked_by_name": prn.checked_by_name,
        "purchase_remarks": prn.purchase_remarks,
        "item_count": len(prn.lines),
        "created_at": prn.created_at.isoformat() if prn.created_at else None,
        "updated_at": prn.updated_at.isoformat() if prn.updated_at else None,
    }
    if with_lines:
        out["lines"] = [_line_out(ln) for ln in prn.lines]
    return out


def _history(db: Session, prn_id: int) -> list[dict]:
    rows = db.scalars(
        select(AuditLog).where(AuditLog.entity == "prns", AuditLog.entity_id == prn_id)
        .order_by(AuditLog.created_at.asc(), AuditLog.id.asc())
    ).all()
    return [{
        "action": a.action,
        "details": a.details,
        "user_id": a.user_id,
        "created_at": a.created_at.isoformat() if a.created_at else None,
    } for a in rows]


# --- purchasing progress (derived from linked POs, never stored) -----------
def _linked_pos_map(db: Session, prn_ids) -> dict[int, list[PurchaseOrder]]:
    ids = [i for i in prn_ids if i]
    if not ids:
        return {}
    rows = db.scalars(
        select(PurchaseOrder).where(PurchaseOrder.prn_id.in_(ids)).order_by(PurchaseOrder.id)
    ).all()
    out: dict[int, list[PurchaseOrder]] = {}
    for po in rows:
        out.setdefault(po.prn_id, []).append(po)
    return out


def _po_brief(po: PurchaseOrder) -> dict:
    ordered = sum(float(l.quantity or 0) for l in po.lines)
    received = sum(float(l.received_qty or 0) for l in po.lines)
    return {
        "id": po.id, "po_number": po.po_number, "status": po.status.value,
        "order_date": po.order_date.isoformat() if po.order_date else None,
        "total_amount": float(po.total_amount or 0),
        "ordered_qty": ordered, "received_qty": received,
    }


def _purchasing_status(prn: PRN, pos: list) -> str:
    """Derived purchasing stage shown in the Purchases department view."""
    if prn.status == PRNStatus.completed:
        return "Completed"
    if prn.status == PRNStatus.partially_fulfilled:
        return "Partially Received"
    if prn.status != PRNStatus.sent_to_purchase:
        return prn.status.value
    return "PO Created" if pos else "Awaiting PO"


def _line_progress(db: Session, prn_id: int) -> dict[int, dict]:
    """Per-PRN-line ordered / received quantities summed over linked PO lines."""
    rows = db.execute(
        select(PurchaseOrderLine.prn_line_id,
               func.coalesce(func.sum(PurchaseOrderLine.quantity), 0),
               func.coalesce(func.sum(PurchaseOrderLine.received_qty), 0))
        .join(PurchaseOrder, PurchaseOrder.id == PurchaseOrderLine.po_id)
        .where(PurchaseOrder.prn_id == prn_id,
               PurchaseOrder.status != PurchaseStatus.cancelled,
               PurchaseOrderLine.prn_line_id.isnot(None))
        .group_by(PurchaseOrderLine.prn_line_id)
    ).all()
    return {r[0]: {"ordered_qty": float(r[1] or 0), "received_qty": float(r[2] or 0)}
            for r in rows}


def _get(db: Session, prn_id: int) -> PRN:
    prn = db.get(PRN, prn_id)
    if prn is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"PRN {prn_id} not found")
    return prn


def _is_requester(prn: PRN, user) -> bool:
    return prn.requested_by_id == user.id


# --- read endpoints --------------------------------------------------------
@router.get("/constants", response_model=dict)
def constants(_: CurrentUser):
    return {
        "priorities": list(PRIORITIES),
        "requirement_types": list(REQUIREMENT_TYPES),
        "statuses": [s.value for s in PRNStatus],
        "fulfillment_statuses": list(FULFILLMENT_STATUSES),
    }


@router.get("/departments", response_model=list)
def departments(db: Annotated[Session, Depends(get_db)], _: CurrentUser):
    """Distinct departments already used by the system (employees + existing PRNs)."""
    names = set()
    names.update((d or "").strip() for d in db.scalars(
        select(Employee.department).distinct()).all())
    names.update((d or "").strip() for d in db.scalars(
        select(PRN.department).distinct()).all())
    return sorted(n for n in names if n)


@router.get("/materials", response_model=list)
def materials(db: Annotated[Session, Depends(get_db)], _: CurrentUser,
              search: str = "", limit: int = Query(50, ge=1, le=200)):
    """Material master lookup for the PRN linepicker (reuses Product master)."""
    stmt = select(Product).where(Product.is_active.is_(True))
    if search.strip():
        like = f"%{search.strip()}%"
        stmt = stmt.where(or_(Product.model.ilike(like), Product.item_code.ilike(like),
                              Product.family.ilike(like)))
    rows = db.scalars(stmt.order_by(Product.model).limit(limit)).all()
    return [{
        "id": p.id, "item_code": p.item_code, "model": p.model, "uom": p.uom,
        "category": p.category.value,
        "label": f"{p.item_code + ' · ' if p.item_code else ''}{p.model}",
    } for p in rows]


@router.get("/stock-lookup", response_model=dict)
def stock_lookup(db: Annotated[Session, Depends(get_db)], _: CurrentUser,
                 material_id: int, required_qty: float | None = None):
    product = db.get(Product, material_id)
    if product is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Material not found")
    snap = _stock_snapshot(db, material_id, required_qty)
    snap.update({"material_id": material_id, "uom": product.uom, "model": product.model,
                 "item_code": product.item_code})
    return snap


@router.get("", response_model=dict)
def list_prns(db: Annotated[Session, Depends(get_db)], _: CurrentUser,
              search: str = "", department: str = "", status_: str = Query("", alias="status"),
              priority: str = "", requested_by: str = "",
              date_from: date | None = None, date_to: date | None = None,
              page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=500)):
    stmt = select(PRN)
    if search.strip():
        like = f"%{search.strip()}%"
        line_prn_ids = select(PRNLine.prn_id).where(PRNLine.description.ilike(like))
        stmt = stmt.where(or_(PRN.prn_number.ilike(like),
                              PRN.id.in_(line_prn_ids)))
    if department:
        stmt = stmt.where(PRN.department == department)
    if status_:
        stmt = stmt.where(PRN.status == status_)
    if priority:
        stmt = stmt.where(PRN.priority == priority)
    if requested_by:
        stmt = stmt.where(PRN.requested_by_name.ilike(f"%{requested_by}%"))
    if date_from:
        stmt = stmt.where(PRN.prn_date >= date_from)
    if date_to:
        stmt = stmt.where(PRN.prn_date <= date_to)
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(PRN.id.desc())
                      .offset((page - 1) * page_size).limit(page_size)).all()
    pos_map = _linked_pos_map(db, {p.id for p in rows})
    items = []
    for p in rows:
        item = _prn_out(p, with_lines=False)
        pos = pos_map.get(p.id, [])
        item["linked_po_count"] = len(pos)
        item["purchasing_status"] = _purchasing_status(p, pos)
        items.append(item)
    return {"items": items, "total": total, "page": page, "page_size": page_size}


@router.get("/purchase-requests", response_model=dict)
def purchase_requests(db: Annotated[Session, Depends(get_db)], _: ManagerOrAdmin,
                      view: str = "requests", search: str = "", priority: str = "",
                      page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=500)):
    """Purchase Department queue of PRNs (awaiting PO, in progress, partial, done).

    Sorted by priority then required-by date so the most urgent work is first."""
    po_exists = select(PurchaseOrder.prn_id).where(PurchaseOrder.prn_id.isnot(None))
    if view == "requests":
        conds = [PRN.status == PRNStatus.sent_to_purchase, ~PRN.id.in_(po_exists)]
    elif view == "in_progress":
        conds = [or_(
            and_(PRN.status == PRNStatus.sent_to_purchase, PRN.id.in_(po_exists)),
            PRN.status == PRNStatus.partially_fulfilled,
        )]
    elif view == "partially":
        conds = [PRN.status == PRNStatus.partially_fulfilled]
    elif view == "completed":
        conds = [PRN.status == PRNStatus.completed]
    else:  # all purchasing-scope PRNs
        conds = [PRN.status.in_(_PURCHASING_SCOPE)]
    if search.strip():
        like = f"%{search.strip()}%"
        line_prn_ids = select(PRNLine.prn_id).where(PRNLine.description.ilike(like))
        conds.append(or_(PRN.prn_number.ilike(like), PRN.department.ilike(like),
                         PRN.requested_by_name.ilike(like), PRN.id.in_(line_prn_ids)))
    if priority:
        conds.append(PRN.priority == priority)

    total = db.scalar(select(func.count()).select_from(PRN).where(*conds)) or 0
    rows = db.scalars(
        select(PRN).where(*conds)
        .order_by(_PRIORITY_RANK, PRN.required_by_date.is_(None), PRN.required_by_date.asc(),
                  PRN.id.desc())
        .offset((page - 1) * page_size).limit(page_size)
    ).all()
    pos_map = _linked_pos_map(db, {p.id for p in rows})
    items = []
    for p in rows:
        item = _prn_out(p, with_lines=True)
        pos = pos_map.get(p.id, [])
        item["linked_pos"] = [_po_brief(x) for x in pos]
        item["purchasing_status"] = _purchasing_status(p, pos)
        items.append(item)
    return {"items": items, "total": total, "page": page, "page_size": page_size}


@router.get("/purchase-requests/count", response_model=dict)
def purchase_requests_count(db: Annotated[Session, Depends(get_db)], _: ManagerOrAdmin):
    """Counts for the Purchases navigation badge and queue cards."""
    po_exists = select(PurchaseOrder.prn_id).where(PurchaseOrder.prn_id.isnot(None))

    def count(*conds) -> int:
        return db.scalar(select(func.count()).select_from(PRN).where(*conds)) or 0

    return {
        "requests": count(PRN.status == PRNStatus.sent_to_purchase, ~PRN.id.in_(po_exists)),
        "in_progress": count(or_(
            and_(PRN.status == PRNStatus.sent_to_purchase, PRN.id.in_(po_exists)),
            PRN.status == PRNStatus.partially_fulfilled)),
        "partially_received": count(PRN.status == PRNStatus.partially_fulfilled),
        "completed": count(PRN.status == PRNStatus.completed),
    }


@router.get("/{prn_id}", response_model=dict)
def get_prn(prn_id: int, db: Annotated[Session, Depends(get_db)], _: CurrentUser):
    prn = _get(db, prn_id)
    out = _prn_out(prn)
    pos = _linked_pos_map(db, {prn.id}).get(prn.id, [])
    out["linked_pos"] = [_po_brief(p) for p in pos]
    out["purchasing_status"] = _purchasing_status(prn, pos)
    progress = _line_progress(db, prn.id)
    for ln in out["lines"]:
        p = progress.get(ln["id"], {})
        received = p.get("received_qty", 0.0)
        ln["ordered_qty"] = p.get("ordered_qty", 0.0)
        ln["received_qty"] = received
        ln["remaining_qty"] = max(float(ln.get("quantity") or 0) - received, 0.0)
    out["history"] = _history(db, prn.id)
    return out


# --- write: create / edit --------------------------------------------------
@router.post("", response_model=dict, status_code=status.HTTP_201_CREATED)
def create_prn(body: PRNCreate, db: Annotated[Session, Depends(get_db)], user: AllStaff):
    _validate_meta(body.priority, body.requirement_type)
    _validate_lines(body.lines, require_one=True)

    uid, uname = user.id, (user.full_name or user.username)
    prn = None
    for _attempt in range(5):
        prn = PRN(
            prn_number=_generate_prn_number(db),
            prn_date=body.prn_date or date.today(),
            department=body.department or "",
            department_head=body.department_head or "",
            company_name=body.company_name or "",
            requested_by_id=uid, requested_by_name=uname,
            required_by_date=body.required_by_date,
            priority=body.priority or "Normal",
            requirement_type=body.requirement_type or "Production",
            purpose=body.purpose or "",
            production_reference=body.production_reference or "",
            checked_by_name=body.checked_by_name or "",
            purchase_remarks=body.purchase_remarks or "",
            status=PRNStatus.draft, fulfillment_status="Pending",
        )
        db.add(prn)
        try:
            db.flush()
            break
        except IntegrityError:
            db.rollback()
            prn = None
    if prn is None:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "Could not allocate a PRN number; please retry")

    _apply_lines(db, prn, body.lines)
    db.commit()
    db.refresh(prn)
    write_audit(db, user, "CREATE", "prns", prn.id, f"Created PRN {prn.prn_number}")
    return _prn_out(prn)


def _apply_lines(db: Session, prn: PRN, lines: list[PRNLineIn]) -> None:
    """Reconcile the PRN's lines in place, then snapshot each existing
    material's stock. Preserved lines keep their id (and any attachment);
    removed lines are deleted. Manual lines get NULL stock (unknown), never 0."""
    payload_ids = {ln.id for ln in lines if ln.id}
    existing = {ln.id: ln for ln in prn.lines if ln.id}
    for old_id, old in existing.items():
        if old_id not in payload_ids:
            db.delete(old)
    for ln in lines:
        qty = float(ln.quantity)
        available = reserved = incoming = suggested = None
        if ln.material_id:
            snap = _stock_snapshot(db, ln.material_id, qty)
            available = snap["available_stock"]
            reserved = snap["reserved_stock"]
            incoming = snap["incoming_qty"]
            suggested = snap["suggested_qty"]
        row = existing.get(ln.id) if ln.id else None
        if row is None:
            row = PRNLine()
            prn.lines.append(row)
        row.entry_mode = PRNLineMode.existing if ln.material_id else PRNLineMode.manual
        row.material_id = ln.material_id
        row.material_code = ln.material_code or ""
        row.description = ln.description.strip()
        row.specification = ln.specification or ""
        row.quantity = qty
        row.uom = ln.uom or ""
        row.available_stock = available
        row.reserved_stock = reserved
        row.incoming_qty = incoming
        row.suggested_qty = suggested
        row.remarks = ln.remarks or ""
        row.is_new_material = ln.material_id is None
    db.flush()


@router.patch("/{prn_id}", response_model=dict)
def update_prn(prn_id: int, body: PRNUpdate, db: Annotated[Session, Depends(get_db)],
               user: AllStaff):
    prn = _get(db, prn_id)
    if prn.status not in (PRNStatus.draft, PRNStatus.rejected):
        raise HTTPException(status.HTTP_409_CONFLICT,
                            f"PRN in status '{prn.status.value}' cannot be edited")
    if not _is_requester(prn, user) and user.role.value != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the requester can edit this PRN")
    _validate_meta(body.priority, body.requirement_type)
    if body.lines is not None:
        _validate_lines(body.lines, require_one=True)

    if body.prn_date is not None:
        prn.prn_date = body.prn_date
    if body.department is not None:
        prn.department = body.department
    if body.department_head is not None:
        prn.department_head = body.department_head
    if body.company_name is not None:
        prn.company_name = body.company_name
    if body.required_by_date is not None:
        prn.required_by_date = body.required_by_date
    if body.priority is not None:
        prn.priority = body.priority
    if body.requirement_type is not None:
        prn.requirement_type = body.requirement_type
    if body.purpose is not None:
        prn.purpose = body.purpose
    if body.production_reference is not None:
        prn.production_reference = body.production_reference
    if body.checked_by_name is not None:
        prn.checked_by_name = body.checked_by_name
    if body.purchase_remarks is not None:
        prn.purchase_remarks = body.purchase_remarks
    if body.lines is not None:
        _apply_lines(db, prn, body.lines)
    # Editing a rejected PRN returns it to Draft for correction.
    if prn.status == PRNStatus.rejected:
        prn.status = PRNStatus.draft
        prn.rejection_reason = ""
    db.commit()
    db.refresh(prn)
    write_audit(db, user, "UPDATE", "prns", prn.id, f"Edited PRN {prn.prn_number}")
    return _prn_out(prn)


# --- workflow transitions --------------------------------------------------
def _transition(db: Session, prn: PRN, user, new_status: PRNStatus, action: str,
                details: str = "") -> PRN:
    prn.status = new_status
    db.commit()
    db.refresh(prn)
    write_audit(db, user, action, "prns", prn.id, details or f"PRN {prn.prn_number} -> {new_status.value}")
    return prn


@router.post("/{prn_id}/submit", response_model=dict)
def submit_prn(prn_id: int, db: Annotated[Session, Depends(get_db)], user: AllStaff):
    prn = _get(db, prn_id)
    if prn.status not in (PRNStatus.draft, PRNStatus.rejected):
        raise HTTPException(status.HTTP_409_CONFLICT,
                            f"Cannot submit a PRN in status '{prn.status.value}'")
    if not _is_requester(prn, user) and user.role.value != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the requester can submit this PRN")
    if not prn.lines:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Add at least one material line before submitting")
    # A resubmission after rejection clears the previous reason.
    prn.rejection_reason = ""
    return _prn_out(_transition(db, prn, user, PRNStatus.pending_approval, "SUBMIT"))


@router.post("/{prn_id}/approve", response_model=dict)
def approve_prn(prn_id: int, db: Annotated[Session, Depends(get_db)], user: ManagerOrAdmin):
    prn = _get(db, prn_id)
    if prn.status != PRNStatus.pending_approval:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            f"Cannot approve a PRN in status '{prn.status.value}'")
    # Segregation of duties: no self-approval unless explicitly admin.
    if _is_requester(prn, user) and user.role.value != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "A requester cannot approve their own PRN")
    prn.approved_by_id = user.id
    prn.approved_by_name = user.full_name or user.username
    prn.approved_at = datetime.utcnow()
    return _prn_out(_transition(db, prn, user, PRNStatus.approved, "APPROVE"))


@router.post("/{prn_id}/reject", response_model=dict)
def reject_prn(prn_id: int, body: PRNRejectIn, db: Annotated[Session, Depends(get_db)],
               user: ManagerOrAdmin):
    prn = _get(db, prn_id)
    if prn.status != PRNStatus.pending_approval:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            f"Cannot reject a PRN in status '{prn.status.value}'")
    if not (body.reason or "").strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "A rejection reason is required")
    prn.rejection_reason = body.reason.strip()
    return _prn_out(_transition(db, prn, user, PRNStatus.rejected, "REJECT",
                                 f"Rejected: {prn.rejection_reason}"))


@router.post("/{prn_id}/cancel", response_model=dict)
def cancel_prn(prn_id: int, db: Annotated[Session, Depends(get_db)], user: AllStaff):
    prn = _get(db, prn_id)
    if prn.status in (PRNStatus.completed, PRNStatus.cancelled):
        raise HTTPException(status.HTTP_409_CONFLICT,
                            f"PRN already '{prn.status.value}'")
    if not _is_requester(prn, user) and user.role.value not in ("admin", "manager"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not permitted to cancel this PRN")
    return _prn_out(_transition(db, prn, user, PRNStatus.cancelled, "CANCEL"))


@router.post("/{prn_id}/send-to-purchase", response_model=dict)
def send_to_purchase(prn_id: int, db: Annotated[Session, Depends(get_db)], user: ManagerOrAdmin):
    """Mark an approved PRN as handed to the purchasing process. This only links
    to the existing purchasing workflow — it never creates a purchase order."""
    prn = _get(db, prn_id)
    if prn.status != PRNStatus.approved:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            f"Only an Approved PRN can be sent to purchase (current: '{prn.status.value}')")
    return _prn_out(_transition(db, prn, user, PRNStatus.sent_to_purchase, "SEND_TO_PURCHASE"))


@router.post("/{prn_id}/fulfillment", response_model=dict)
def update_fulfillment(prn_id: int, body: PRNFulfillmentIn,
                       db: Annotated[Session, Depends(get_db)], user: ManagerOrAdmin):
    """Record the fulfilment state against the linked purchasing outcome.
    Purely a reference update — no purchase receipt or stock movement is created."""
    prn = _get(db, prn_id)
    if prn.status not in (PRNStatus.sent_to_purchase, PRNStatus.partially_fulfilled,
                          PRNStatus.completed):
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "Fulfilment can only be recorded after a PRN is sent to purchase")
    if body.fulfillment_status not in FULFILLMENT_STATUSES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            f"Invalid fulfilment status. Allowed: {', '.join(FULFILLMENT_STATUSES)}")
    prn.fulfillment_status = body.fulfillment_status
    if body.purchase_reference:
        prn.purchase_reference = body.purchase_reference
    if body.purchase_remarks:
        prn.purchase_remarks = body.purchase_remarks
    if body.fulfillment_status == "Completed":
        prn.status = PRNStatus.completed
    elif body.fulfillment_status == "Partially Fulfilled":
        prn.status = PRNStatus.partially_fulfilled
    db.commit()
    db.refresh(prn)
    write_audit(db, user, "FULFILLMENT", "prns", prn.id,
                f"Fulfilment -> {prn.fulfillment_status}")
    return _prn_out(prn)


# --- attachments (private, validated) --------------------------------------
@router.post("/{prn_id}/lines/{line_id}/attachment", response_model=dict)
async def upload_attachment(prn_id: int, line_id: int, db: Annotated[Session, Depends(get_db)],
                            user: AllStaff, file: UploadFile = File(...)):
    prn = _get(db, prn_id)
    if prn.status not in (PRNStatus.draft, PRNStatus.rejected):
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "Attachments can only be changed while the PRN is a draft")
    if not _is_requester(prn, user) and user.role.value != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the requester can attach files")
    line = db.get(PRNLine, line_id)
    if line is None or line.prn_id != prn.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "PRN line not found")

    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext not in _ALLOWED_EXT:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            f"Unsupported file type '{ext or 'unknown'}'")
    content = await file.read()
    if len(content) > _MAX_ATTACHMENT_BYTES:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Attachment exceeds the 10 MB limit")
    if not content:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Empty file")

    folder = _attachment_dir() / str(prn.id)
    folder.mkdir(parents=True, exist_ok=True)
    stored = folder / f"line{line.id}_{uuid4().hex}{ext}"
    stored.write_bytes(content)

    # Remove a previous attachment for this line (only ours, never other files).
    if line.attachment_path:
        old = Path(line.attachment_path)
        if old.is_file() and _attachment_dir() in old.resolve().parents:
            try:
                old.unlink()
            except OSError:
                pass
    line.attachment_path = str(stored)
    line.attachment_name = file.filename or stored.name
    db.commit()
    write_audit(db, user, "ATTACH", "prns", prn.id, f"Attached {line.attachment_name}")
    return {"ok": True, "line_id": line.id, "attachment_name": line.attachment_name}


@router.get("/{prn_id}/lines/{line_id}/attachment")
def download_attachment(prn_id: int, line_id: int, db: Annotated[Session, Depends(get_db)],
                        _: CurrentUser):
    line = db.get(PRNLine, line_id)
    if line is None or line.prn_id != prn_id or not line.attachment_path:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Attachment not found")
    path = Path(line.attachment_path)
    if not path.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Attachment file is missing")
    return FileResponse(path, filename=line.attachment_name or path.name)


@router.delete("/{prn_id}/lines/{line_id}/attachment", status_code=status.HTTP_204_NO_CONTENT)
def delete_attachment(prn_id: int, line_id: int, db: Annotated[Session, Depends(get_db)],
                      user: AllStaff):
    prn = _get(db, prn_id)
    if not _is_requester(prn, user) and user.role.value != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only the requester can remove attachments")
    line = db.get(PRNLine, line_id)
    if line is None or line.prn_id != prn_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "PRN line not found")
    if line.attachment_path:
        old = Path(line.attachment_path)
        if old.is_file() and _attachment_dir() in old.resolve().parents:
            try:
                old.unlink()
            except OSError:
                pass
    line.attachment_path = ""
    line.attachment_name = ""
    db.commit()
    write_audit(db, user, "ATTACH_REMOVE", "prns", prn.id, "Attachment removed")
    return Response(status_code=status.HTTP_204_NO_CONTENT)
