"""Sales order management (CRUD + lifecycle + status sync with dispatch)."""
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..auth import CurrentUser, AllStaff, ManagerOrAdmin
from ..crud import apply_updates, get_or_404, write_audit
from ..database import get_db
from ..models import (
    Customer, Dispatch, OrderStatus, Product, SalesOrder, SalesOrderLine,
)
from ..schemas import (
    SalesOrderCreate, SalesOrderLineIn, SalesOrderOut, SalesOrderUpdate,
)
from datetime import date

router = APIRouter(prefix="/orders", tags=["orders"])


def _next_no(db: Session) -> str:
    prefix = f"SO-{date.today().strftime('%Y%m%d')}-"
    n = db.scalar(select(func.count()).select_from(SalesOrder).where(SalesOrder.order_no.like(f"{prefix}%")))
    return f"{prefix}{n + 1:03d}"


def _serialize_order(db: Session, o: SalesOrder) -> dict:
    customer = o.customer
    lines = []
    for ln in o.lines:
        lines.append({
            "id": ln.id, "product_id": ln.product_id, "description": ln.description,
            "quantity": ln.quantity,
            "unit_price": float(ln.unit_price) if ln.unit_price is not None else None,
            "amount": float(ln.amount) if ln.amount is not None else None,
            "product": {"id": ln.product.id, "model": ln.product.model,
                        "item_code": ln.product.item_code, "category": ln.product.category.value} if ln.product else None,
        })
    dispatch_qty = db.scalar(
        select(func.coalesce(func.sum(Dispatch.dispatched_qty), 0)).where(Dispatch.sales_order_id == o.id)
    )
    return {
        "id": o.id, "order_no": o.order_no, "customer_id": o.customer_id,
        "order_date": o.order_date, "required_delivery_date": o.required_delivery_date,
        "status": o.status.value, "total_value": float(o.total_value), "remarks": o.remarks,
        "created_at": o.created_at,
        "customer": {"id": customer.id, "name": customer.name} if customer else None,
        "lines": lines,
        "dispatch_qty": float(dispatch_qty or 0),
    }


def _recalc_total(o: SalesOrder, lines: list[SalesOrderLine]):
    o.total_value = sum(float(l.amount or 0) for l in lines)


def _auto_status(o: SalesOrder):
    dispatch_total = o.total_value
    lines_total = sum(float(l.amount or 0) for l in o.lines)
    if o.status in (OrderStatus.completed, OrderStatus.cancelled):
        return


@router.get("", response_model=dict)
def list_orders(
    db: Annotated[Session, Depends(get_db)],
    _: CurrentUser,
    search: str = "",
    status_: str = Query(default="", alias="status"),
    customer_id: int | None = None,
    date_from: str = "",
    date_to: str = "",
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=500),
):
    stmt = select(SalesOrder)
    if search:
        like = f"%{search}%"
        stmt = stmt.where(SalesOrder.order_no.ilike(like))
    if status_:
        stmt = stmt.where(SalesOrder.status == status_)
    if customer_id:
        stmt = stmt.where(SalesOrder.customer_id == customer_id)
    if date_from:
        stmt = stmt.where(SalesOrder.order_date >= date.fromisoformat(date_from))
    if date_to:
        stmt = stmt.where(SalesOrder.order_date <= date.fromisoformat(date_to))
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(SalesOrder.order_date.desc(), SalesOrder.id.desc())
                      .offset((page - 1) * page_size).limit(page_size)).all()
    return {"items": [_serialize_order(db, o) for o in rows],
            "total": total, "page": page, "page_size": page_size}


@router.post("", response_model=dict, status_code=status.HTTP_201_CREATED)
def create_order(body: SalesOrderCreate, db: Annotated[Session, Depends(get_db)],
                 user: AllStaff):
    lines = [SalesOrderLine(**ln.model_dump()) for ln in body.lines]
    o = SalesOrder(order_no=body.order_no or _next_no(db), customer_id=body.customer_id,
                   order_date=body.order_date, required_delivery_date=body.required_delivery_date,
                   status=body.status, remarks=body.remarks, lines=lines)
    _recalc_total(o, lines)
    db.add(o)
    db.commit()
    db.refresh(o)
    write_audit(db, user, "CREATE", "sales_orders", o.id, f"Created order {o.order_no}")
    return _serialize_order(db, o)


@router.get("/{order_id}", response_model=dict)
def get_order(order_id: int, db: Annotated[Session, Depends(get_db)],
              _: CurrentUser):
    return _serialize_order(db, get_or_404(db, SalesOrder, order_id))


@router.patch("/{order_id}", response_model=dict)
def update_order(order_id: int, body: SalesOrderUpdate, db: Annotated[Session, Depends(get_db)],
                 user: AllStaff):
    o = get_or_404(db, SalesOrder, order_id)
    apply_updates(o, body, exclude={"lines"})
    if body.lines is not None:
        db.query(SalesOrderLine).filter(SalesOrderLine.order_id == o.id).delete()
        lines = [SalesOrderLine(**ln.model_dump()) for ln in body.lines]
        o.lines = lines
        _recalc_total(o, lines)
    db.commit()
    db.refresh(o)
    write_audit(db, user, "UPDATE", "sales_orders", o.id, f"Updated order {o.order_no}")
    return _serialize_order(db, o)


@router.post("/{order_id}/status", response_model=dict)
def set_order_status(order_id: int, order_status: OrderStatus,
                     db: Annotated[Session, Depends(get_db)], user: AllStaff):
    o = get_or_404(db, SalesOrder, order_id)
    o.status = order_status
    db.commit()
    db.refresh(o)
    write_audit(db, user, "STATUS", "sales_orders", o.id, f"Order {o.order_no} -> {order_status.value}")
    return _serialize_order(db, o)


@router.delete("/{order_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_order(order_id: int, db: Annotated[Session, Depends(get_db)],
                 user: ManagerOrAdmin):
    o = get_or_404(db, SalesOrder, order_id)
    db.delete(o)
    db.commit()
    write_audit(db, user, "DELETE", "sales_orders", order_id, f"Deleted order {o.order_no}")
    return Response(status_code=status.HTTP_204_NO_CONTENT)