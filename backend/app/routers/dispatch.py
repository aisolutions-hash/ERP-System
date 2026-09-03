"""Dispatch management (CRUD + status sync with linked sales orders)."""
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..auth import CurrentUser, AllStaff, ManagerOrAdmin
from ..crud import apply_updates, get_or_404, write_audit
from ..database import get_db
from ..models import (
    Customer, Dispatch, DispatchLine, DispatchStatus, Inventory, MovementType,
    OrderStatus, Plant, Product, SalesOrder, StockMovement,
)
from ..schemas import DispatchCreate, DispatchLineIn, DispatchOut, DispatchUpdate
from datetime import date
from ..models import SalesOrderLine

router = APIRouter(prefix="/dispatch", tags=["dispatch"])


def _next_no(db: Session) -> str:
    prefix = f"DP-{date.today().strftime('%Y%m%d')}-"
    n = db.scalar(select(func.count()).select_from(Dispatch).where(Dispatch.dispatch_no.like(f"{prefix}%")))
    return f"{prefix}{n + 1:03d}"


def _serialize_dispatch(db: Session, d: Dispatch) -> dict:
    customer = d.customer
    plant = d.plant
    lines = []
    for ln in d.lines:
        lines.append({
            "id": ln.id, "product_id": ln.product_id, "description": ln.description,
            "quantity": ln.quantity, "dispatch_date": ln.dispatch_date,
            "rate": float(ln.rate) if ln.rate is not None else None,
            "weight": ln.weight,
            "product": {"id": ln.product.id, "model": ln.product.model,
                        "item_code": ln.product.item_code, "category": ln.product.category.value} if ln.product else None,
        })
    # PO number from the linked sales order line (STORE PO NO = customer-side ref)
    po_no = ""
    if d.sales_order_id:
        ln = db.scalar(select(SalesOrderLine.customer_po_no)
                       .where(SalesOrderLine.order_id == d.sales_order_id)
                       .where(SalesOrderLine.customer_po_no != "").limit(1))
        po_no = ln or ""
    salesperson_name = d.salesperson.name if d.salesperson else None
    return {
        "id": d.id, "dispatch_no": d.dispatch_no, "customer_id": d.customer_id,
        "plant_id": d.plant_id, "sales_order_id": d.sales_order_id,
        "customer_po_no": po_no,
        "sales_person": d.sales_person or (salesperson_name or ""),
        "salesperson": {"id": d.salesperson.id, "name": d.salesperson.name} if d.salesperson else None,
        "schedule_qty": d.schedule_qty,
        "ask_till_date": d.ask_till_date, "dispatched_qty": d.dispatched_qty,
        "completion_pct": d.completion_pct, "balance_qty": d.balance_qty,
        "opening_stock": d.opening_stock, "status": d.status.value,
        "dispatch_date": d.dispatch_date, "delivery_status": d.delivery_status,
        "transport_details": d.transport_details, "report_date": d.report_date,
        "remarks": d.remarks, "created_at": d.created_at,
        "customer": {"id": customer.id, "name": customer.name} if customer else None,
        "plant": {"id": plant.id, "name": plant.name} if plant else None,
        "lines": lines,
    }


@router.get("/summary", response_model=dict)
def dispatch_summary(
    db: Annotated[Session, Depends(get_db)],
    _: CurrentUser,
    customer_id: int | None = None,
    date_from: str = "",
    date_to: str = "",
):
    """Per-customer dispatch totals + completeness/over-fulfilment flag."""
    stmt = select(Dispatch)
    if customer_id:
        stmt = stmt.where(Dispatch.customer_id == customer_id)
    if date_from:
        stmt = stmt.where(Dispatch.report_date >= date.fromisoformat(date_from))
    if date_to:
        stmt = stmt.where(Dispatch.report_date <= date.fromisoformat(date_to))
    rows = db.scalars(stmt).all()
    by = {}
    for d in rows:
        key = d.customer_id
        e = by.setdefault(key, {"customer_id": key,
                                "customer": (d.customer.name if d.customer else None),
                                "total_schedule": 0.0, "total_dispatched": 0.0,
                                "total_balance": 0.0, "count": 0})
        e["total_schedule"] += d.schedule_qty or 0
        e["total_dispatched"] += d.dispatched_qty or 0
        e["total_balance"] += d.balance_qty or 0
        e["count"] += 1
    items = []
    for e in by.values():
        sched = e["total_schedule"]
        e["completion_pct"] = round(e["total_dispatched"] / sched, 4) if sched else 0.0
        e["over_dispatched"] = e["total_balance"] < 0
        items.append(e)
    items.sort(key=lambda x: (x["customer"] or "ZZZ").lower())
    return {"items": items, "total": len(items)}


@router.get("/by-customer/{customer_id}", response_model=dict)
def dispatch_by_customer(
    customer_id: int, db: Annotated[Session, Depends(get_db)], _: CurrentUser,
    page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=500),
):
    """Complete flat dispatch list for a customer (PO / model / item code /
    schedule / dispatched / balance / %, date, salesperson, status)."""
    get_or_404(db, Customer, customer_id)
    stmt = (select(Dispatch)
            .where(Dispatch.customer_id == customer_id)
            .order_by(Dispatch.report_date.desc(), Dispatch.id.desc()))
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.offset((page - 1) * page_size).limit(page_size)).all()
    items = []
    for d in rows:
        po_no = ""
        if d.sales_order_id:
            po_no = db.scalar(select(SalesOrderLine.customer_po_no)
                              .where(SalesOrderLine.order_id == d.sales_order_id)
                              .where(SalesOrderLine.customer_po_no != "").limit(1)) or ""
        for ln in d.lines:
            items.append({
                "dispatch_id": d.id, "line_id": ln.id,
                "dispatch_no": d.dispatch_no,
                "customer_po_no": po_no,
                "description": ln.description,
                "model": ln.product.model if ln.product else None,
                "item_code": ln.product.item_code if ln.product else (ln.description or ""),
                "schedule_qty": d.schedule_qty,
                "dispatch_qty": ln.quantity,
                "company_qty": d.dispatched_qty,
                "completion_pct": d.completion_pct,
                "balance_qty": d.balance_qty,
                "dispatch_date": ln.dispatch_date,
                "sales_person": d.sales_person or (d.salesperson.name if d.salesperson else ""),
                "status": d.status.value,
            })
    return {"items": items, "total": total, "page": page, "page_size": page_size}


def _recalc_status(d: Dispatch):
    if d.schedule_qty:
        d.completion_pct = round(d.dispatched_qty / d.schedule_qty, 4)
        d.balance_qty = d.schedule_qty - d.dispatched_qty
    else:
        d.completion_pct = 0.0
        d.balance_qty = 0.0
    if d.schedule_qty > 0 and d.dispatched_qty >= d.schedule_qty:
        d.status = DispatchStatus.completed
    elif d.dispatched_qty > 0:
        d.status = DispatchStatus.partial
    else:
        d.status = DispatchStatus.pending


def _sync_sales_order(db: Session, d: Dispatch):
    if not d.sales_order_id:
        return
    o = db.get(SalesOrder, d.sales_order_id)
    if o is None:
        return
    dispatched = db.scalar(select(func.coalesce(func.sum(Dispatch.dispatched_qty), 0)).where(Dispatch.sales_order_id == o.id)) or 0
    order_qty = sum(float(l.quantity or 0) for l in o.lines)
    if dispatched >= order_qty and order_qty > 0:
        o.status = OrderStatus.completed
    elif dispatched > 0:
        o.status = OrderStatus.dispatched
    elif d.status in (DispatchStatus.completed, DispatchStatus.delivered):
        o.status = OrderStatus.completed


@router.get("", response_model=dict)
def list_dispatch(
    db: Annotated[Session, Depends(get_db)],
    _: CurrentUser,
    search: str = "",
    status_: str = Query(default="", alias="status"),
    plant_id: int | None = None,
    customer_id: int | None = None,
    date_from: str = "",
    date_to: str = "",
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=500),
):
    stmt = select(Dispatch)
    if search:
        like = f"%{search}%"
        stmt = stmt.where(or_(Dispatch.dispatch_no.ilike(like), Dispatch.sales_person.ilike(like),
                              Dispatch.transport_details.ilike(like)))
    if status_:
        stmt = stmt.where(Dispatch.status == status_)
    if plant_id:
        stmt = stmt.where(Dispatch.plant_id == plant_id)
    if customer_id:
        stmt = stmt.where(Dispatch.customer_id == customer_id)
    if date_from:
        stmt = stmt.where(Dispatch.report_date >= date.fromisoformat(date_from))
    if date_to:
        stmt = stmt.where(Dispatch.report_date <= date.fromisoformat(date_to))
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(Dispatch.report_date.desc(), Dispatch.id.desc())
                      .offset((page - 1) * page_size).limit(page_size)).all()
    return {"items": [_serialize_dispatch(db, d) for d in rows],
            "total": total, "page": page, "page_size": page_size}


@router.post("", response_model=dict, status_code=status.HTTP_201_CREATED)
def create_dispatch(body: DispatchCreate, db: Annotated[Session, Depends(get_db)],
                    user: AllStaff):
    lines = [DispatchLine(**ln.model_dump()) for ln in body.lines]
    d = Dispatch(
        dispatch_no=body.dispatch_no or _next_no(db), customer_id=body.customer_id,
        plant_id=body.plant_id, sales_order_id=body.sales_order_id,
        sales_person=body.sales_person, schedule_qty=body.schedule_qty,
        ask_till_date=body.ask_till_date, dispatched_qty=body.dispatched_qty,
        opening_stock=body.opening_stock, status=body.status,
        dispatch_date=body.dispatch_date, delivery_status=body.delivery_status,
        transport_details=body.transport_details, report_date=body.report_date,
        remarks=body.remarks, lines=lines,
    )
    _recalc_status(d)
    db.add(d)
    db.commit()
    db.refresh(d)
    _sync_sales_order(db, d)
    db.commit()
    write_audit(db, user, "CREATE", "dispatches", d.id, f"Created dispatch {d.dispatch_no}")
    return _serialize_dispatch(db, d)


@router.get("/{dispatch_id}", response_model=dict)
def get_dispatch(dispatch_id: int, db: Annotated[Session, Depends(get_db)],
                 _: CurrentUser):
    return _serialize_dispatch(db, get_or_404(db, Dispatch, dispatch_id))


@router.patch("/{dispatch_id}", response_model=dict)
def update_dispatch(dispatch_id: int, body: DispatchUpdate, db: Annotated[Session, Depends(get_db)],
                    user: AllStaff):
    d = get_or_404(db, Dispatch, dispatch_id)
    apply_updates(d, body, exclude={"lines"})
    if body.lines is not None:
        db.query(DispatchLine).filter(DispatchLine.dispatch_id == d.id).delete()
        d.lines = [DispatchLine(**ln.model_dump()) for ln in body.lines]
    _recalc_status(d)
    db.commit()
    db.refresh(d)
    _sync_sales_order(db, d)
    db.commit()
    write_audit(db, user, "UPDATE", "dispatches", d.id, f"Updated dispatch {d.dispatch_no}")
    return _serialize_dispatch(db, d)


@router.post("/{dispatch_id}/lines", response_model=dict)
def add_dispatch_line(dispatch_id: int, body: DispatchLineIn,
                      db: Annotated[Session, Depends(get_db)], user: AllStaff):
    """Record an actual dispatched quantity; reduces finished-goods stock."""
    d = get_or_404(db, Dispatch, dispatch_id)
    if body.quantity <= 0:
        raise status.HTTP_400_BAD_REQUEST
    db.add(DispatchLine(dispatch_id=d.id, **body.model_dump()))
    d.dispatched_qty += body.quantity
    _recalc_status(d)
    if body.product_id:
        inv = db.scalars(select(Inventory).where(Inventory.product_id == body.product_id,
                                                 Inventory.plant_id.is_(None))).first()
        if inv is None:
            inv = Inventory(product_id=body.product_id, plant_id=None,
                            opening_stock=0, received_qty=0, issued_qty=0, current_stock=0)
            db.add(inv)
        inv.issued_qty = float(inv.issued_qty or 0) + body.quantity
        inv.current_stock = float(inv.current_stock or 0) - body.quantity
        db.add(StockMovement(product_id=body.product_id, movement_type=MovementType.dispatch,
                             quantity=body.quantity, transaction_date=body.dispatch_date,
                             ref_type="dispatch", ref_id=d.id,
                             remarks=f"Dispatched against {d.dispatch_no}"))
    db.commit()
    db.refresh(d)
    _sync_sales_order(db, d)
    db.commit()
    write_audit(db, user, "CREATE", "dispatch_lines", d.id, f"Dispatched {body.quantity} on {d.dispatch_no}")
    return _serialize_dispatch(db, d)


@router.patch("/lines/{line_id}", response_model=dict)
def update_dispatch_line(line_id: int, body: DispatchLineIn,
                         db: Annotated[Session, Depends(get_db)], user: AllStaff):
    """Edit a single dispatched quantity (over-dispatch allowed; negative
    balance preserved). Recalculates the parent dispatch totals/status."""
    ln = get_or_404(db, DispatchLine, line_id)
    d = get_or_404(db, Dispatch, ln.dispatch_id)
    old_qty = float(ln.quantity or 0)
    new_qty = float(body.quantity)
    ln.quantity = new_qty
    ln.dispatch_date = body.dispatch_date or ln.dispatch_date
    if body.product_id:
        ln.product_id = body.product_id
    d.dispatched_qty = float(d.dispatched_qty or 0) - old_qty + new_qty
    _recalc_status(d)
    db.commit()
    db.refresh(d)
    _sync_sales_order(db, d)
    db.commit()
    write_audit(db, user, "UPDATE", "dispatch_lines", line_id,
                f"Dispatch line {line_id}: {old_qty} -> {new_qty}")
    return _serialize_dispatch(db, d)
def delete_dispatch(dispatch_id: int, db: Annotated[Session, Depends(get_db)],
                    user: ManagerOrAdmin):
    d = get_or_404(db, Dispatch, dispatch_id)
    db.delete(d)
    db.commit()
    write_audit(db, user, "DELETE", "dispatches", dispatch_id, f"Deleted dispatch {d.dispatch_no}")
    return Response(status_code=status.HTTP_204_NO_CONTENT)