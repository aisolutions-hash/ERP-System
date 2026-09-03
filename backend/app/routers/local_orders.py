"""Local Orders view (Part I) - separated from OEM customer orders.

Historical ORDER/PLANE relationships are not fabricated: imported local orders
live in sales_orders(order_type=LOCAL) and the DISPATCH & PRODUCTION PLANE sheet
maps into `plans`. New ERP-created local records store proper relationships
(via this router's create flow and the existing orders/dispatch routers).
"""
from typing import Annotated

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..auth import CurrentUser, AllStaff
from ..crud import write_audit
from ..database import get_db
from ..models import (
    Dispatch, DispatchLine, OrderType, Plan, SalesOrder, SalesOrderLine,
)
from ..schemas import SalesOrderCreate
from datetime import date

router = APIRouter(prefix="/local-orders", tags=["local-orders"])


@router.get("", response_model=dict)
def list_local(
    db: Annotated[Session, Depends(get_db)],
    _: CurrentUser,
    customer_id: int | None = None,
    date_from: str = "",
    date_to: str = "",
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
):
    stmt = select(SalesOrder).where(SalesOrder.order_type == OrderType.local)
    if customer_id:
        stmt = stmt.where(SalesOrder.customer_id == customer_id)
    if date_from:
        stmt = stmt.where(SalesOrder.order_date >= date.fromisoformat(date_from))
    if date_to:
        stmt = stmt.where(SalesOrder.order_date <= date.fromisoformat(date_to))
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(SalesOrder.order_date.desc()).offset((page - 1) * page_size).limit(page_size)).all()
    items = []
    for o in rows:
        d_qty = db.scalar(
            select(func.coalesce(func.sum(DispatchLine.quantity), 0))
            .select_from(Dispatch)
            .join(DispatchLine, DispatchLine.dispatch_id == Dispatch.id)
            .where(Dispatch.sales_order_id == o.id)) or 0.0
        lines = [{
            "id": ln.id, "product_id": ln.product_id,
            "model": ln.product.model if ln.product else ln.description,
            "item_code": ln.product.item_code if ln.product else (ln.description or ""),
            "quantity": ln.quantity,
            "balance_qty": float(ln.quantity or 0) - float(d_qty or 0),
            "commitment": o.remarks,
        } for ln in o.lines]
        items.append({
            "id": o.id, "order_no": o.order_no, "customer_id": o.customer_id,
            "customer": o.customer.name if o.customer else None,
            "order_date": o.order_date, "status": o.status.value,
            "commitment": o.remarks, "lines": lines,
            "dispatched_qty": float(d_qty),
        })
    return {"items": items, "total": total, "page": page, "page_size": page_size}


@router.get("/plans", response_model=dict)
def local_plans(db: Annotated[Session, Depends(get_db)], _: CurrentUser):
    p = db.scalars(select(Plan).where(
        or_(Plan.plan_type == "PRODUCTION_PLAN",
            Plan.plan_type == "DISPATCH_PLAN"))).all()
    items = [{
        "id": pl.id, "plan_type": pl.plan_type.value, "model": pl.model,
        "customer": pl.customer.name if pl.customer else None,
        "quantity": pl.quantity, "owner": pl.owner, "status": pl.status,
        "plan_date": pl.plan_date, "remarks": pl.remarks,
    } for pl in p]
    return {"items": items, "total": len(items)}


@router.post("", response_model=dict, status_code=status.HTTP_201_CREATED)
def create_local_order(body: SalesOrderCreate, db: Annotated[Session, Depends(get_db)],
                       user: AllStaff):
    from .orders import _next_no, _recalc_total
    lines = [SalesOrderLine(**ln.model_dump()) for ln in body.lines]
    o = SalesOrder(order_no=body.order_no or f"SO-LOC-{date.today().strftime('%Y%m')}-LOCAL",
                   customer_id=body.customer_id, order_type=OrderType.local,
                   order_date=body.order_date, status=body.status, remarks=body.remarks,
                   lines=lines)
    _recalc_total(o, lines)
    db.add(o)
    db.commit()
    db.refresh(o)
    write_audit(db, user, "CREATE", "sales_orders", o.id, f"Created LOCAL order {o.order_no}")
    return {"id": o.id, "order_no": o.order_no, "status": o.status.value}
