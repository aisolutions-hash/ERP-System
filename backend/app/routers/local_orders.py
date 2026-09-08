"""Local Orders - complete live workflow.

Local Orders are SalesOrder(order_type=LOCAL) + SalesOrderLine. This router:
  * Customer: manual name auto-creates/reuses the central Customer master.
  * Order Type (TRADING / MANUFACTURING) with per-type downstream routing on
    insufficient stock (Purchase vs Production requirement).
  * Size/Description, Order Qty, Rate, Less (stored as entered), Delivery Date,
    Total Amount (line Amount = Qty x Rate - authoritative backend calc, Less
    never subtracted).
  * Stock check at the Dispatch location -> "Ready for Dispatch" or the
    Trading/Manufacturing requirement path.
  * Partial dispatch is handled by the existing sales-order-driven Dispatch
    module (date-wise entries, edit/delete with stock reversal, per-line
    attribution via DispatchLine.sales_order_line_id). Pending is always derived
    from actual data; editing an order never overwrites dispatch history.
"""
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import Integer, func, or_, select
from sqlalchemy.orm import Session

from ..auth import CurrentUser, AllStaff, ManagerOrAdmin
from ..crud import write_audit
from ..database import get_db
from ..models import (
    Customer, Dispatch, DispatchLine, OrderStatus, OrderType, Plan, SalesOrder,
    SalesOrderLine,
)
from ..schemas import LocalOrderCreate, LocalOrderUpdate
from ..services.business import sync_purchase_shortages
from ..services.customers import get_or_create_customer
from ..services.local_orders import (
    check_ready, normalize_local_type, serialize_local_order,
    sync_local_order_status,
)
from datetime import date

router = APIRouter(prefix="/local-orders", tags=["local-orders"])


def _local_no(db: Session) -> str:
    prefix = f"LOC-{date.today().strftime('%Y%m%d')}-"
    n = db.scalar(select(func.max(func.cast(func.substr(SalesOrder.order_no, len(prefix) + 1), Integer)))
                  .where(SalesOrder.order_no.like(f"{prefix}%"))) or 0
    return f"{prefix}{n + 1:03d}"


def _recalc_local_total(db: Session, o: SalesOrder, lines: list[SalesOrderLine]):
    """Authoritative local-order pricing: Amount = Qty x Rate per line.
    Less is preserved but not subtracted (per business rule). Lines scheduled
    for deletion (replaced id-less) are excluded from the totals."""
    kept = [l for l in lines if l not in db.deleted]
    for l in kept:
        rate = float(l.unit_price or 0)
        l.amount = rate * float(l.quantity or 0)
    o.total_value = sum(float(l.amount or 0) for l in kept)


def _resolve_customer(db: Session, body) -> tuple[int | None, str]:
    """Customer id is authoritative when given; otherwise a typed name is
    promoted into the central Customer master (auto-created, case-insensitive)."""
    if body.customer_id is not None:
        c = db.get(Customer, body.customer_id)
        if c is None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail=f"Customer {body.customer_id} not found")
        return c.id, c.name
    if not (body.customer_name or "").strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="Customer is required — select one or enter a new name")
    c = get_or_create_customer(db, body.customer_name)
    return (c.id, c.name) if c else (None, body.customer_name.strip())


def _apply_lines(db: Session, o: SalesOrder, raw_lines) -> None:
    """In-place order-line update preserving line ids (so historical dispatch
    attribution keeps working). Lines with dispatch history cannot be removed."""
    existing = {ln.id: ln for ln in o.lines}
    seen = set()
    for raw in raw_lines:
        rid = getattr(raw, "id", None)
        data = raw.model_dump(exclude={"id"}, exclude_none=True) if hasattr(raw, "model_dump") else raw
        if rid and rid in existing:
            ln = existing[rid]
            ln.product_id = data.get("product_id")
            ln.description = (data.get("description") or "").strip()
            ln.quantity = float(data.get("quantity") or 0)
            ln.unit_price = data.get("unit_price")
            ln.less = data.get("less")
            ln.customer_po_no = data.get("customer_po_no") or ""
            ln.amount = None
            seen.add(rid)
        else:
            o.lines.append(SalesOrderLine(
                product_id=data.get("product_id"),
                description=(data.get("description") or "").strip(),
                quantity=float(data.get("quantity") or 0),
                unit_price=data.get("unit_price"),
                less=data.get("less"),
                customer_po_no=data.get("customer_po_no") or "",
            ))
            seen.add(None)
    for ln in list(existing.values()):
        if ln.id in seen:
            continue
        used = db.scalar(select(func.count()).select_from(DispatchLine)
                         .where(DispatchLine.sales_order_line_id == ln.id)) or 0
        if used:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                                detail=f"Line '{ln.description or ln.id}' already has dispatch entries and cannot be removed")
        db.delete(ln)


def _serialize(db: Session, o: SalesOrder) -> dict:
    return serialize_local_order(db, o)


@router.get("", response_model=dict)
def list_local(
    db: Annotated[Session, Depends(get_db)],
    _: CurrentUser,
    customer_id: int | None = None,
    status_: str = Query(default="", alias="status"),
    date_from: str = "",
    date_to: str = "",
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
):
    stmt = select(SalesOrder).where(SalesOrder.order_type == OrderType.local)
    if customer_id:
        stmt = stmt.where(SalesOrder.customer_id == customer_id)
    if date_from:
        try:
            from_date = date.fromisoformat(date_from)
        except ValueError:
            from_date = None
        if from_date:
            stmt = stmt.where(SalesOrder.order_date >= from_date)
    if date_to:
        try:
            to_date = date.fromisoformat(date_to)
        except ValueError:
            to_date = None
        if to_date:
            stmt = stmt.where(SalesOrder.order_date <= to_date)
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(SalesOrder.order_date.desc(), SalesOrder.id.desc())
                      .offset((page - 1) * page_size).limit(page_size)).all()
    items = []
    for o in rows:
        sync_local_order_status(db, o)
        s = _serialize(db, o)
        if status_:
            if status_ == "ready" and s["status"] != "Ready for Dispatch":
                continue
            elif status_ == "partial" and s["status"] != "Partially Dispatched":
                continue
            elif status_ == "completed" and s["status"] != "Completed":
                continue
            elif status_ == "required" and s["status"] not in ("Purchase / Stock Required", "Production Required", "Stock Transfer Required"):
                continue
            elif status_ not in ("ready", "partial", "completed", "required"):
                continue
        items.append(s)
    db.commit()
    return {"items": items, "total": len(items), "page": page, "page_size": page_size}


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


@router.get("/{order_id}", response_model=dict)
def get_local_order(order_id: int, db: Annotated[Session, Depends(get_db)],
                    _: CurrentUser):
    o = db.get(SalesOrder, order_id)
    if o is None or o.order_type != OrderType.local:
        raise HTTPException(status_code=404, detail="Local order not found")
    sync_local_order_status(db, o)
    db.commit()
    return _serialize(db, o)


@router.post("", response_model=dict, status_code=status.HTTP_201_CREATED)
def create_local_order(body: LocalOrderCreate, db: Annotated[Session, Depends(get_db)],
                       user: AllStaff):
    if not body.lines or any((ln.quantity or 0) <= 0 for ln in body.lines):
        raise HTTPException(status_code=400,
                            detail="Add at least one order line with a quantity greater than 0")
    customer_id, customer_name = _resolve_customer(db, body)
    lines = [SalesOrderLine(**ln.model_dump(exclude={"id"})) for ln in body.lines]
    o = SalesOrder(order_no=body.order_no or _local_no(db),
                   customer_id=customer_id, customer_name=customer_name,
                   order_type=OrderType.local,
                   local_order_type=normalize_local_type(body.local_order_type),
                   order_date=body.order_date or date.today(),
                   required_delivery_date=body.required_delivery_date,
                   status=OrderStatus.new, remarks=body.remarks or "",
                   lines=lines)
    _recalc_local_total(db, o, lines)
    db.add(o)
    db.flush()
    sync_local_order_status(db, o)
    db.commit()
    db.refresh(o)
    write_audit(db, user, "CREATE", "sales_orders", o.id, f"Created LOCAL order {o.order_no}")
    sync_purchase_shortages(db)
    return _serialize(db, o)


@router.patch("/{order_id}", response_model=dict)
def update_local_order(order_id: int, body: LocalOrderUpdate,
                       db: Annotated[Session, Depends(get_db)], user: AllStaff):
    o = db.get(SalesOrder, order_id)
    if o is None or o.order_type != OrderType.local:
        raise HTTPException(status_code=404, detail="Local order not found")
    data = body.model_dump(exclude_unset=True)

    if "customer_id" in data:
        o.customer_id, o.customer_name = _resolve_customer(db, body)
    elif "customer_name" in data and body.customer_name is not None:
        o.customer_id, o.customer_name = _resolve_customer(db, body)

    if "local_order_type" in data:
        o.local_order_type = normalize_local_type(body.local_order_type)
    if "order_date" in data and body.order_date is not None:
        o.order_date = body.order_date
    if "required_delivery_date" in data:
        o.required_delivery_date = body.required_delivery_date
    if "remarks" in data and body.remarks is not None:
        o.remarks = body.remarks
    if "status" in data and body.status == OrderStatus.cancelled:
        o.status = OrderStatus.cancelled

    if body.lines is not None:
        if any((ln.quantity or 0) <= 0 for ln in body.lines):
            raise HTTPException(status_code=400,
                                detail="Each order line needs a quantity greater than 0")
        _apply_lines(db, o, body.lines)
        _recalc_local_total(db, o, o.lines)

    if o.status != OrderStatus.cancelled:
        sync_local_order_status(db, o)
    db.commit()
    db.refresh(o)
    write_audit(db, user, "UPDATE", "sales_orders", o.id, f"Updated LOCAL order {o.order_no}")
    sync_purchase_shortages(db)
    return _serialize(db, o)


@router.delete("/{order_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_local_order(order_id: int, db: Annotated[Session, Depends(get_db)],
                       user: ManagerOrAdmin):
    o = db.get(SalesOrder, order_id)
    if o is None or o.order_type != OrderType.local:
        raise HTTPException(status_code=404, detail="Local order not found")
    if db.scalar(select(func.count()).select_from(Dispatch).where(Dispatch.sales_order_id == o.id)):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="Cannot delete local order: it has dispatches.")
    db.delete(o)
    db.commit()
    write_audit(db, user, "DELETE", "sales_orders", o.id, f"Deleted LOCAL order {o.order_no}")
    sync_purchase_shortages(db)
    return Response(status_code=status.HTTP_204_NO_CONTENT)