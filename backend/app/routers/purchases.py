"""Purchase order management (CRUD + receipt updates)."""
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..auth import CurrentUser, ManagerOrAdmin
from ..crud import apply_updates, get_or_404, write_audit
from ..database import get_db
from ..models import (
    MovementType, Product,
    PurchaseOrder, PurchaseOrderLine, PurchaseStatus, Supplier,
)
from ..services.business import sync_purchase_shortages
from ..services.reorder_alerts import refresh_reorder_alert
from ..services.stock_service import apply_movement, resolve_or_create_product, reverse_and_remove_ref
from ..schemas import (
    PurchaseOrderCreate, PurchaseOrderLineIn, PurchaseOrderUpdate,
)
from datetime import date

router = APIRouter(prefix="/purchases", tags=["purchases"])


def _serialize_po(db: Session, po: PurchaseOrder) -> dict:
    supplier = po.supplier
    lines = []
    for ln in po.lines:
        lines.append({
            "id": ln.id, "product_id": ln.product_id, "description": ln.description,
            "item_code": ln.item_code or (ln.product.item_code if ln.product else ""),
            "quantity": ln.quantity, "received_qty": ln.received_qty,
            "rate": float(ln.rate) if ln.rate is not None else None,
            "amount": float(ln.amount) if ln.amount is not None else None,
            "product": {"id": ln.product.id, "model": ln.product.model, "item_code": ln.product.item_code,
                        "category": ln.product.category.value} if ln.product else None,
        })
    return {
        "id": po.id, "po_number": po.po_number, "supplier_id": po.supplier_id,
        "supplier_name": po.supplier_name or "",
        "order_date": po.order_date, "status": po.status.value,
        "total_amount": float(po.total_amount), "notes": po.notes,
        "created_at": po.created_at,
        "supplier": {"id": supplier.id, "name": supplier.name}
        if supplier else ({"name": po.supplier_name} if po.supplier_name else None),
        "lines": lines,
    }


def _recalc(po: PurchaseOrder, lines: list[PurchaseOrderLine]):
    total = sum(float(l.amount or 0) for l in lines)
    po.total_amount = total
    received = all(float(l.received_qty or 0) >= float(l.quantity or 0) and float(l.quantity or 0) > 0 for l in lines if l.quantity)
    partial = any(float(l.received_qty or 0) > 0 for l in lines)
    if lines and received:
        po.status = PurchaseStatus.received
    elif partial:
        po.status = PurchaseStatus.partially_received
    else:
        po.status = PurchaseStatus.ordered


def _attach_stock_warnings(result: dict, lines):
    """Add a `warnings` list only for received lines that truly cannot be
    stock-tracked (no linked product AND no Item Code). Manual lines with an
    Item Code are resolved into the stock system and need no warning."""
    flagged = [ln for ln in lines
               if ln.product_id is None
               and not (ln.item_code or "").strip()
               and float(ln.received_qty or 0) > 0]
    if flagged:
        result["warnings"] = [
            f"Line {ln.id} ({ln.description or 'manual item'}) has no Item Code and no linked product — "
            "receipt recorded on the PO but stock was NOT updated. Add an Item Code or link a product to track stock."
            for ln in flagged]


def _resolve_line_product(db: Session, line: PurchaseOrderLine) -> Product | None:
    """Return the Product that owns inventory/stock for a PO line.

    Catalogue-linked lines resolve directly. Manual lines (product_id None)
    with an Item Code are matched/created as a Product keyed on that Item Code
    so they flow through the existing Inventory + StockMovement pipeline without
    requiring a Product Master entry up front. Manual lines with no Item Code
    cannot be uniquely identified and resolve to None (stock stays untouched).
    """
    if line.product_id:
        return db.get(Product, line.product_id)
    p = resolve_or_create_product(db, line.item_code, line.description)
    if p:
        line.product_id = p.id
    return p


@router.get("", response_model=dict)
def list_purchases(
    db: Annotated[Session, Depends(get_db)],
    _: CurrentUser,
    search: str = "",
    supplier_id: int | None = None,
    status_: str = Query(default="", alias="status"),
    date_from: str = "",
    date_to: str = "",
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=500),
):
    stmt = select(PurchaseOrder)
    if search:
        like = f"%{search}%"
        stmt = stmt.where(or_(PurchaseOrder.po_number.ilike(like), PurchaseOrder.notes.ilike(like)))
    if supplier_id:
        stmt = stmt.where(PurchaseOrder.supplier_id == supplier_id)
    if status_:
        stmt = stmt.where(PurchaseOrder.status == status_)
    if date_from:
        stmt = stmt.where(PurchaseOrder.order_date >= date.fromisoformat(date_from))
    if date_to:
        stmt = stmt.where(PurchaseOrder.order_date <= date.fromisoformat(date_to))
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(PurchaseOrder.order_date.desc(), PurchaseOrder.id.desc())
                      .offset((page - 1) * page_size).limit(page_size)).all()
    return {"items": [_serialize_po(db, p) for p in rows],
            "total": total, "page": page, "page_size": page_size}


@router.post("", response_model=dict, status_code=status.HTTP_201_CREATED)
def create_purchase(body: PurchaseOrderCreate, db: Annotated[Session, Depends(get_db)],
                    user: ManagerOrAdmin):
    if db.query(PurchaseOrder).filter(PurchaseOrder.po_number == body.po_number).first():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="PO number already exists")
    if body.supplier_id is not None and not db.get(Supplier, body.supplier_id):
        raise HTTPException(status_code=400, detail=f"Supplier {body.supplier_id} not found")
    po = PurchaseOrder(po_number=body.po_number, supplier_id=body.supplier_id,
                       supplier_name=(body.supplier_name or "").strip(),
                       order_date=body.order_date, notes=body.notes)
    lines = [PurchaseOrderLine(**ln.model_dump()) for ln in body.lines]
    po.lines = lines
    _recalc(po, lines)
    db.add(po)
    db.commit()
    db.refresh(po)
    write_audit(db, user, "CREATE", "purchase_orders", po.id, f"Created PO {po.po_number}")
    return _serialize_po(db, po)


@router.get("/{po_id}", response_model=dict)
def get_purchase(po_id: int, db: Annotated[Session, Depends(get_db)],
                 _: CurrentUser):
    po = get_or_404(db, PurchaseOrder, po_id)
    return _serialize_po(db, po)


@router.patch("/{po_id}", response_model=dict)
def update_purchase(po_id: int, body: PurchaseOrderUpdate, db: Annotated[Session, Depends(get_db)],
                    user: ManagerOrAdmin):
    po = get_or_404(db, PurchaseOrder, po_id)
    if body.po_number is not None and body.po_number != po.po_number:
        if db.query(PurchaseOrder).filter(
                PurchaseOrder.po_number == body.po_number,
                PurchaseOrder.id != po.id).first():
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="PO number already exists")
        po.po_number = body.po_number
    if body.supplier_id is not None and not db.get(Supplier, body.supplier_id):
        raise HTTPException(status_code=400, detail=f"Supplier {body.supplier_id} not found")
    apply_updates(po, body, exclude={"lines", "po_number"})
    if body.lines is not None:
        # Reverse every previously received quantity before replacing the
        # line set, so editing a received PO never leaves stale stock.
        reverse_and_remove_ref(db, "purchase_order", po.id)
        db.query(PurchaseOrderLine).filter(PurchaseOrderLine.po_id == po.id).delete()
        lines = [PurchaseOrderLine(**ln.model_dump()) for ln in body.lines]
        for ln in lines:
            if ln.received_qty and ln.received_qty > float(ln.quantity or 0):
                raise HTTPException(status_code=400,
                                    detail="Received quantity cannot exceed ordered quantity")
        po.lines = lines
        for ln in lines:
            if ln.received_qty:
                product = _resolve_line_product(db, ln)
                if product:
                    apply_movement(db, product.id, MovementType.receipt, ln.received_qty,
                                   date.today(), ref_type="purchase_order", ref_id=po.id,
                                   remarks=f"Receipt against PO {po.po_number}")
                    refresh_reorder_alert(db, product.id)
        _recalc(po, lines)
    db.commit()
    db.refresh(po)
    write_audit(db, user, "UPDATE", "purchase_orders", po.id, f"Updated PO {po.po_number}")
    result = _serialize_po(db, po)
    _attach_stock_warnings(result, po.lines)
    return result


@router.post("/{po_id}/receive", response_model=dict)
def receive_purchase(po_id: int, line_id: int, received_qty: float,
                     db: Annotated[Session, Depends(get_db)],
                     user: ManagerOrAdmin):
    """Record receipt of goods against a PO line; updates inventory + movements."""
    po = get_or_404(db, PurchaseOrder, po_id)
    line = db.get(PurchaseOrderLine, line_id)
    if line is None or line.po_id != po.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Line not found on PO")
    if received_qty < 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Received qty cannot be negative")
    delta = received_qty - float(line.received_qty or 0)
    line.received_qty = received_qty
    product = _resolve_line_product(db, line)
    if product:
        apply_movement(db, product.id, MovementType.receipt, delta,
                       date.today(), ref_type="purchase_order", ref_id=po.id,
                       remarks=f"Receipt against PO {po.po_number}")
        refresh_reorder_alert(db, product.id)
    _recalc(po, po.lines)
    db.commit()
    db.refresh(po)
    write_audit(db, user, "RECEIVE", "purchase_orders", po.id, f"Received {received_qty} for line {line_id}")
    sync_purchase_shortages(db)
    result = _serialize_po(db, po)
    _attach_stock_warnings(result, po.lines)
    return result


@router.post("/{po_id}/grn-done", response_model=dict)
def grn_done(po_id: int, db: Annotated[Session, Depends(get_db)],
             user: ManagerOrAdmin):
    """Complete the GRN for a PO in one atomic pass.

    Receives every remaining pending quantity on the PO: stock movement
    (INWARD) is recorded per line exactly once, and the PO advances to
    `Received`. Already-received lines are skipped (delta <= 0), so repeating
    the action is idempotent and never duplicates stock movements."""
    po = get_or_404(db, PurchaseOrder, po_id)
    if po.status == PurchaseStatus.cancelled:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="Cannot complete GRN for a cancelled PO")
    today = date.today()
    received_any = False
    for line in po.lines:
        qty = float(line.quantity or 0)
        if qty <= 0:
            continue
        delta = qty - float(line.received_qty or 0)
        if delta <= 0:
            continue  # idempotent: nothing pending for this line
        line.received_qty = qty
        product = _resolve_line_product(db, line)
        if product:
            apply_movement(db, product.id, MovementType.receipt, delta,
                           today, ref_type="purchase_order", ref_id=po.id,
                           remarks=f"Receipt against PO {po.po_number}")
            refresh_reorder_alert(db, product.id)
        received_any = True
    _recalc(po, po.lines)
    db.commit()
    db.refresh(po)
    if received_any:
        write_audit(db, user, "GRN", "purchase_orders", po.id, f"GRN completed for PO {po.po_number}")
        sync_purchase_shortages(db)
    result = _serialize_po(db, po)
    _attach_stock_warnings(result, po.lines)
    return result


@router.delete("/{po_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_purchase(po_id: int, db: Annotated[Session, Depends(get_db)],
                    user: ManagerOrAdmin):
    po = get_or_404(db, PurchaseOrder, po_id)
    reverse_and_remove_ref(db, "purchase_order", po.id)
    db.delete(po)
    db.commit()
    write_audit(db, user, "DELETE", "purchase_orders", po_id, f"Deleted PO {po.po_number}")
    return Response(status_code=status.HTTP_204_NO_CONTENT)