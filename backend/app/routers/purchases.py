"""Purchase order management (CRUD + receipt updates)."""
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..auth import CurrentUser, ManagerOrAdmin
from ..crud import apply_updates, get_or_404, write_audit
from ..database import get_db
from ..models import (
    Inventory, MovementType, Product, PurchaseOrder, PurchaseOrderLine,
    PurchaseStatus, StockMovement, Supplier,
)
from ..schemas import (
    PurchaseOrderCreate, PurchaseOrderLineIn, PurchaseOrderOut, PurchaseOrderUpdate,
)
from datetime import date

router = APIRouter(prefix="/purchases", tags=["purchases"])


def _serialize_po(db: Session, po: PurchaseOrder) -> dict:
    supplier = po.supplier
    lines = []
    for ln in po.lines:
        lines.append({
            "id": ln.id, "product_id": ln.product_id, "description": ln.description,
            "quantity": ln.quantity, "received_qty": ln.received_qty,
            "rate": float(ln.rate) if ln.rate is not None else None,
            "amount": float(ln.amount) if ln.amount is not None else None,
            "product": {"id": ln.product.id, "model": ln.product.model, "item_code": ln.product.item_code,
                        "category": ln.product.category.value} if ln.product else None,
        })
    return {
        "id": po.id, "po_number": po.po_number, "supplier_id": po.supplier_id,
        "order_date": po.order_date, "status": po.status.value,
        "total_amount": float(po.total_amount), "notes": po.notes,
        "created_at": po.created_at,
        "supplier": {"id": supplier.id, "name": supplier.name} if supplier else None,
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


@router.post("", response_model=PurchaseOrderOut, status_code=status.HTTP_201_CREATED)
def create_purchase(body: PurchaseOrderCreate, db: Annotated[Session, Depends(get_db)],
                    user: ManagerOrAdmin):
    if db.query(PurchaseOrder).filter(PurchaseOrder.po_number == body.po_number).first():
        raise status.HTTP_409_CONFLICT
    po = PurchaseOrder(po_number=body.po_number, supplier_id=body.supplier_id,
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
    apply_updates(po, body, exclude={"lines"})
    if body.lines is not None:
        db.query(PurchaseOrderLine).filter(PurchaseOrderLine.po_id == po.id).delete()
        lines = [PurchaseOrderLine(**ln.model_dump()) for ln in body.lines]
        po.lines = lines
        _recalc(po, lines)
    db.commit()
    db.refresh(po)
    write_audit(db, user, "UPDATE", "purchase_orders", po.id, f"Updated PO {po.po_number}")
    return _serialize_po(db, po)


@router.post("/{po_id}/receive", response_model=dict)
def receive_purchase(po_id: int, line_id: int, received_qty: float,
                     db: Annotated[Session, Depends(get_db)],
                     user: ManagerOrAdmin):
    """Record receipt of goods against a PO line; updates inventory + movements."""
    po = get_or_404(db, PurchaseOrder, po_id)
    line = db.get(PurchaseOrderLine, line_id)
    if line is None or line.po_id != po.id:
        raise status.HTTP_404_NOT_FOUND
    if received_qty < 0:
        raise status.HTTP_400_BAD_REQUEST
    delta = received_qty - float(line.received_qty or 0)
    line.received_qty = received_qty
    if line.product_id:
        inv = db.scalars(select(Inventory).where(
            Inventory.product_id == line.product_id, Inventory.plant_id.is_(None))).first()
        if inv is None:
            inv = Inventory(product_id=line.product_id, plant_id=None,
                            opening_stock=0, received_qty=0, issued_qty=0, current_stock=0)
            db.add(inv)
        inv.received_qty = float(inv.received_qty or 0) + delta
        inv.current_stock = float(inv.current_stock or 0) + delta
        db.add(StockMovement(product_id=line.product_id, movement_type=MovementType.receipt,
                             quantity=delta, transaction_date=date.today(),
                             ref_type="purchase_order", ref_id=po.id,
                             remarks=f"Receipt against PO {po.po_number}"))
    _recalc(po, po.lines)
    db.commit()
    db.refresh(po)
    write_audit(db, user, "RECEIVE", "purchase_orders", po.id, f"Received {received_qty} for line {line_id}")
    return _serialize_po(db, po)


@router.delete("/{po_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_purchase(po_id: int, db: Annotated[Session, Depends(get_db)],
                    user: ManagerOrAdmin):
    po = get_or_404(db, PurchaseOrder, po_id)
    db.delete(po)
    db.commit()
    write_audit(db, user, "DELETE", "purchase_orders", po_id, f"Deleted PO {po.po_number}")
    return Response(status_code=status.HTTP_204_NO_CONTENT)