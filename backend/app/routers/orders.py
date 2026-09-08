"""Sales order management (CRUD + lifecycle + status sync with dispatch)."""
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..auth import CurrentUser, AllStaff, ManagerOrAdmin
from ..crud import apply_updates, get_or_404, write_audit
from ..database import get_db
from ..models import (
    Customer, Dispatch, DispatchLine, OrderStatus, OrderType, Product,
    ProductSourceType, ProductionOrder, PurchaseRequirement, SalesOrder,
    SalesOrderLine, StockMovement, MovementType,
)
from ..schemas import (
    SalesOrderCreate, SalesOrderLineIn, SalesOrderLineUpdate, SalesOrderOut,
    SalesOrderUpdate,
)
from ..services.business import inventory_map, sync_purchase_shortages
from ..services.customers import get_or_create_customer
from datetime import date

router = APIRouter(prefix="/orders", tags=["orders"])


def _next_no(db: Session) -> str:
    prefix = f"SO-{date.today().strftime('%Y%m%d')}-"
    n = db.scalar(select(func.count()).select_from(SalesOrder).where(SalesOrder.order_no.like(f"{prefix}%")))
    return f"{prefix}{n + 1:03d}"


def _line_stock_status(order_type, product, ordered: float, dispatched: float,
                       available: float) -> dict:
    """Stock-check a single order line against REAL inventory."""
    balance = ordered - dispatched
    if balance <= 0:
        status = "FULFILLED" if balance == 0 else "OVER_FULFILLED"
        return {"balance_qty": balance, "available_stock": available,
                "shortage_qty": 0.0, "readiness": status, "ready": False}
    shortage = balance - available
    if available >= balance:
        return {"balance_qty": balance, "available_stock": available,
                "shortage_qty": 0.0, "readiness": "READY_FOR_DISPATCH", "ready": True}
    if product is not None:
        st = product.source_type
        if st == ProductSourceType.trading:
            return {"balance_qty": balance, "available_stock": available,
                    "shortage_qty": shortage, "readiness": "PURCHASE_REQUIRED", "ready": False}
        if st == ProductSourceType.manufactured:
            return {"balance_qty": balance, "available_stock": available,
                    "shortage_qty": shortage, "readiness": "PRODUCTION_REQUIRED", "ready": False}
    return {"balance_qty": balance, "available_stock": available,
            "shortage_qty": shortage, "readiness": "MANUAL_DECISION_REQUIRED", "ready": False}


_ORDER_STOCK_ORDER = ("PURCHASE_REQUIRED", "PRODUCTION_REQUIRED",
                      "MANUAL_DECISION_REQUIRED", "READY_FOR_DISPATCH",
                      "FULFILLED", "OVER_FULFILLED")


def _order_stock_status(readiness: list[str]) -> str:
    """Order-level stock status = the most blocking line state."""
    for s in _ORDER_STOCK_ORDER:
        if s in readiness:
            return s
    return "NO_LINES"


def _serialize_order(db: Session, o: SalesOrder) -> dict:
    customer = o.customer
    inv = inventory_map(db)
    lines = []
    for ln in o.lines:
        # dispatched quantity for this order line
        d_qty = db.scalar(
            select(func.coalesce(func.sum(DispatchLine.quantity), 0))
            .select_from(Dispatch)
            .join(DispatchLine, DispatchLine.dispatch_id == Dispatch.id)
            .where(Dispatch.sales_order_id == o.id)
        ) if o.order_type == OrderType.oem else 0.0
        ordered = float(ln.quantity or 0)
        disp = float(d_qty or 0)
        available = inv.get(ln.product_id, 0.0) if ln.product_id else 0.0
        st = _line_stock_status(o.order_type, ln.product, ordered, disp, available)
        lines.append({
            "id": ln.id, "product_id": ln.product_id, "description": ln.description,
            "quantity": ordered, "customer_po_no": ln.customer_po_no,
            "unit_price": float(ln.unit_price) if ln.unit_price is not None else None,
            "less": float(ln.less) if ln.less is not None else None,
            "amount": float(ln.amount) if ln.amount is not None else None,
            "dispatched_qty": disp,
            **st,
            "fulfilment": st["readiness"].replace("_", " ").title(),
            "product": {"id": ln.product.id, "model": ln.product.model,
                        "item_code": ln.product.item_code, "category": ln.product.category.value,
                        "source_type": ln.product.source_type.value if ln.product.source_type else None}
            if ln.product else None,
        })
    dispatch_qty = db.scalar(
        select(func.coalesce(func.sum(Dispatch.dispatched_qty), 0)).where(Dispatch.sales_order_id == o.id)
    )
    return {
        "id": o.id, "order_no": o.order_no, "customer_id": o.customer_id,
        "customer_name": o.customer_name or "",
        "order_date": o.order_date, "required_delivery_date": o.required_delivery_date,
        "order_type": o.order_type.value, "customer_po_no": o.customer_po_no,
        "salesperson": {"id": o.salesperson.id, "name": o.salesperson.name} if o.salesperson else None,
        "status": o.status.value, "total_value": float(o.total_value), "remarks": o.remarks,
        "created_at": o.created_at,
        "customer": {"id": customer.id, "name": customer.name}
        if customer else ({"name": o.customer_name} if o.customer_name else None),
        "lines": lines,
        "dispatch_qty": float(dispatch_qty or 0),
        "stock_status": _order_stock_status([l["readiness"] for l in lines]),
        "ready": all(l["ready"] for l in lines) and bool(lines),
    }


def _recalc_total(o: SalesOrder, lines: list[SalesOrderLine]):
    """Total Amount = Qty x Rate per line (authoritative). Less is recorded
    and displayed only; it never feeds the total (per business rule)."""
    for l in lines:
        if l.amount is None:
            l.amount = float(l.unit_price or 0) * float(l.quantity or 0)
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
    order_type: str = Query(default="", alias="order_type"),
    exclude_order_type: str = Query(default="", alias="exclude_order_type"),
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
    if order_type:
        try:
            stmt = stmt.where(SalesOrder.order_type == OrderType[order_type.lower()])
        except KeyError:
            pass
    if exclude_order_type:
        try:
            stmt = stmt.where(SalesOrder.order_type != OrderType[exclude_order_type.lower()])
        except KeyError:
            pass
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
    if body.customer_id is None and not (body.customer_name or "").strip():
        raise HTTPException(status_code=400, detail="Customer is required (select an existing one or type a name)")
    if not body.lines:
        raise HTTPException(status_code=400, detail="Add at least one order line")
    for ln in body.lines:
        if ln.product_id is None and not (ln.description or "").strip():
            raise HTTPException(status_code=400, detail="Each order line needs a product or a description")
        if (ln.quantity or 0) <= 0:
            raise HTTPException(status_code=400, detail="Each order line needs a quantity greater than 0")
    if body.customer_id is not None and not db.get(Customer, body.customer_id):
        raise HTTPException(status_code=400, detail=f"Customer {body.customer_id} not found")
    # A typed new customer is promoted into the central customer master.
    if body.customer_id is None and (body.customer_name or "").strip():
        c = get_or_create_customer(db, body.customer_name)
        body.customer_id = c.id if c else None
        body.customer_name = c.name if c else body.customer_name
    lines = [SalesOrderLine(**ln.model_dump()) for ln in body.lines]
    o = SalesOrder(order_no=body.order_no or _next_no(db), customer_id=body.customer_id,
                   customer_name=(body.customer_name or "").strip(),
                   order_type=body.order_type, customer_po_no=body.customer_po_no,
                   salesperson_id=body.salesperson_id,
                   order_date=body.order_date, required_delivery_date=body.required_delivery_date,
                   status=body.status, remarks=body.remarks, lines=lines)
    _recalc_total(o, lines)
    db.add(o)
    db.commit()
    db.refresh(o)
    write_audit(db, user, "CREATE", "sales_orders", o.id, f"Created {o.order_type.value} order {o.order_no}")
    sync_purchase_shortages(db)
    return _serialize_order(db, o)


@router.get("/pending", response_model=dict)
def pending_orders(
    db: Annotated[Session, Depends(get_db)],
    _: CurrentUser,
    mode: str = Query(default="all", alias="mode"),  # all | current | previous
    order_type: str = Query(default="", alias="order_type"),
    customer_id: int | None = None,
):
    """Pending PO / order ledger: ordered vs dispatched; balance determines
    Pending (>0, not yet dispatched), Partially Dispatched (>0, partly sent),
    Completed/Closed (=0), Over-fulfilled (<0). Negative balance is valid
    business data (over-dispatch preserved). 'current' = orders dated in the
    present calendar month (dynamic, no hard-coded year/month); 'previous' =
    anything before the current month (carried-forward pending balance)."""
    today = date.today()
    month_start = today.replace(day=1)
    next_month = (month_start.replace(year=month_start.year + 1, month=1)
                  if month_start.month == 12
                  else month_start.replace(month=month_start.month + 1))
    stmt = select(SalesOrder, SalesOrderLine)
    stmt = stmt.join(SalesOrderLine, SalesOrderLine.order_id == SalesOrder.id)
    if customer_id:
        stmt = stmt.where(SalesOrder.customer_id == customer_id)
    if order_type:
        try:
            stmt = stmt.where(SalesOrder.order_type == OrderType[order_type.lower()])
        except KeyError:
            pass
    if mode == "current":
        stmt = stmt.where(SalesOrder.order_date >= month_start,
                          SalesOrder.order_date < next_month)
    elif mode == "previous":
        stmt = stmt.where(SalesOrder.order_date < month_start)
    rows = db.execute(stmt).all()
    items = []
    for o, ln in rows:
        d_qty = db.scalar(
            select(func.coalesce(func.sum(DispatchLine.quantity), 0))
            .select_from(Dispatch)
            .join(DispatchLine, DispatchLine.dispatch_id == Dispatch.id)
            .where(Dispatch.sales_order_id == o.id)
        ) or 0.0
        ordered = float(ln.quantity or 0)
        disp = float(d_qty or 0)
        balance = ordered - disp
        if balance > 0:
            pstatus = "Partially Dispatched" if disp > 0 else "Pending"
        elif balance == 0:
            pstatus = "Completed (Closed)" if o.status in (
                OrderStatus.completed, OrderStatus.cancelled) else "Completed"
        else:
            pstatus = "Over-fulfilled"
        items.append({
            "order_id": o.id, "order_no": o.order_no, "order_type": o.order_type.value,
            "customer_id": o.customer_id, "customer": o.customer.name if o.customer else None,
            "order_date": o.order_date, "period": f"{o.order_date.year}-{o.order_date.month:02d}",
            "line_id": ln.id, "product_id": ln.product_id,
            "model": ln.product.model if ln.product else None,
            "item_code": ln.product.item_code if ln.product else (ln.description or ""),
            "customer_po_no": ln.customer_po_no or o.customer_po_no or "",
            "ordered_qty": ordered, "dispatched_qty": disp, "balance_qty": balance,
            "status": pstatus,
        })
    return {"items": items, "total": len(items), "mode": mode,
            "current_month": f"{month_start.year}-{month_start.month:02d}"}


@router.get("/{order_id}", response_model=dict)
def get_order(order_id: int, db: Annotated[Session, Depends(get_db)],
              _: CurrentUser):
    return _serialize_order(db, get_or_404(db, SalesOrder, order_id))


@router.patch("/lines/{line_id}", response_model=dict)
def update_order_line(line_id: int, body: SalesOrderLineUpdate,
                      db: Annotated[Session, Depends(get_db)], user: AllStaff):
    """Edit a single order line's permitted fields. Dispatch/Balance remain
    transaction-derived and are never directly editable. Purchase requirements
    + team alerts are re-synced after the change."""
    ln = get_or_404(db, SalesOrderLine, line_id)
    o = get_or_404(db, SalesOrder, ln.order_id)
    fields = body.model_fields_set
    if "product_id" in fields:
        ln.product_id = body.product_id
    if body.description is not None:
        ln.description = body.description
    if body.quantity is not None:
        ln.quantity = body.quantity
    if body.unit_price is not None:
        ln.unit_price = body.unit_price
    if body.less is not None:
        ln.less = body.less
    if body.amount is not None:
        ln.amount = body.amount
    if body.customer_po_no is not None:
        ln.customer_po_no = body.customer_po_no
    _recalc_total(o, o.lines)
    db.commit()
    db.refresh(o)
    write_audit(db, user, "UPDATE", "sales_order_lines", line_id,
                f"Updated line {line_id} on order {o.order_no}")
    sync_purchase_shortages(db)
    return _serialize_order(db, o)


@router.patch("/{order_id}", response_model=dict)
def update_order(order_id: int, body: SalesOrderUpdate, db: Annotated[Session, Depends(get_db)],
                 user: AllStaff):
    o = get_or_404(db, SalesOrder, order_id)
    apply_updates(o, body, exclude={"lines"})
    if (body.customer_name or "").strip():
        c = get_or_create_customer(db, body.customer_name)
        if c:
            o.customer_id = c.id
            o.customer_name = c.name
    if body.lines is not None:
        for ln in o.lines:
            used = db.scalar(select(func.count()).select_from(DispatchLine)
                             .where(DispatchLine.sales_order_line_id == ln.id)) or 0
            if used:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                                    detail=f"Line '{ln.description or ln.id}' already has dispatch entries and cannot be removed")
        db.query(SalesOrderLine).filter(SalesOrderLine.order_id == o.id).delete()
        lines = [SalesOrderLine(**ln.model_dump()) for ln in body.lines]
        o.lines = lines
        _recalc_total(o, lines)
    db.commit()
    db.refresh(o)
    write_audit(db, user, "UPDATE", "sales_orders", o.id, f"Updated order {o.order_no}")
    sync_purchase_shortages(db)
    return _serialize_order(db, o)


@router.post("/{order_id}/status", response_model=dict)
def set_order_status(order_id: int, order_status: OrderStatus,
                     db: Annotated[Session, Depends(get_db)], user: AllStaff):
    o = get_or_404(db, SalesOrder, order_id)
    o.status = order_status
    db.commit()
    db.refresh(o)
    write_audit(db, user, "STATUS", "sales_orders", o.id, f"Order {o.order_no} -> {order_status.value}")
    sync_purchase_shortages(db)
    return _serialize_order(db, o)


@router.delete("/{order_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_order(order_id: int, db: Annotated[Session, Depends(get_db)],
                 user: ManagerOrAdmin):
    o = get_or_404(db, SalesOrder, order_id)
    refs = []
    if db.scalar(select(func.count()).select_from(Dispatch).where(Dispatch.sales_order_id == o.id)):
        refs.append("dispatches")
    if db.scalar(select(func.count()).select_from(PurchaseRequirement)
                 .where(PurchaseRequirement.sales_order_id == o.id)):
        refs.append("purchase requirements")
    if db.scalar(select(func.count()).select_from(ProductionOrder)
                 .where(ProductionOrder.sales_order_id == o.id)):
        refs.append("production orders")
    if refs:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail=f"Cannot delete order: referenced by existing {' and '.join(refs)}.")
    db.delete(o)
    db.commit()
    write_audit(db, user, "DELETE", "sales_orders", order_id, f"Deleted order {o.order_no}")
    sync_purchase_shortages(db)
    return Response(status_code=status.HTTP_204_NO_CONTENT)