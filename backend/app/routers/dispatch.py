"""Dispatch management (CRUD + status sync with linked sales orders)."""
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..auth import CurrentUser, AllStaff, ManagerOrAdmin
from ..crud import apply_updates, get_or_404, write_audit
from ..database import get_db
from ..models import (
    Customer, Dispatch, DispatchLine, DispatchStatus, MovementType,
    OrderStatus, OrderType, Plant, Product, ProductionOrder, ProductionStatus,
    SalesOrder, SalesOrderLine, StockMovement,
)
from ..schemas import DispatchCreate, DispatchLineIn, DispatchUpdate
from ..services.business import sync_purchase_shortages
from ..services.customers import get_or_create_customer
from ..services.reorder_alerts import refresh_reorder_alert
from ..services.stock_service import (
    apply_movement, reconvert_document, resolve_or_create_product,
    reverse_and_remove_ref,
)
from datetime import date

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
            "sales_order_line_id": ln.sales_order_line_id,
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
    if o.order_type == OrderType.local:
        from ..services.local_orders import sync_local_order_status
        sync_local_order_status(db, o)
        return
    dispatched = db.scalar(select(func.coalesce(func.sum(Dispatch.dispatched_qty), 0)).where(Dispatch.sales_order_id == o.id)) or 0
    order_qty = sum(float(l.quantity or 0) for l in o.lines)
    if dispatched >= order_qty and order_qty > 0:
        o.status = OrderStatus.completed
    elif dispatched > 0:
        o.status = OrderStatus.dispatched
    elif d.status in (DispatchStatus.completed, DispatchStatus.delivered):
        o.status = OrderStatus.completed


def _sync_remaining_order_status(db: Session, sales_order_id: int | None):
    """Recompute linked order status from the dispatches that remain after a delete."""
    if not sales_order_id:
        return
    o = db.get(SalesOrder, sales_order_id)
    if o is None:
        return
    if o.order_type == OrderType.local:
        from ..services.local_orders import sync_local_order_status
        sync_local_order_status(db, o)
        return
    remaining = db.scalar(select(func.coalesce(func.sum(Dispatch.dispatched_qty), 0))
                          .where(Dispatch.sales_order_id == o.id)) or 0
    order_qty = sum(float(l.quantity or 0) for l in o.lines)
    if order_qty and remaining >= order_qty:
        o.status = OrderStatus.completed
    elif remaining > 0:
        o.status = OrderStatus.dispatched
    else:
        o.status = OrderStatus.new


def _stocked(db: Session, dispatch_id: int) -> bool:
    """True if any stock movement was ever created for this dispatch."""
    return (db.scalar(select(func.count()).select_from(StockMovement)
                      .where(StockMovement.ref_type == "dispatch",
                             StockMovement.ref_id == dispatch_id)) or 0) > 0


def _resolve_line_product(db: Session, ln) -> Product | None:
    """Resolve a dispatch line's product: linked id, or a manual item with an
    Item Code (lazily created through the shared manual-product resolver)."""
    if ln.product_id:
        return get_or_404(db, Product, ln.product_id)
    if (ln.item_code or "").strip():
        return resolve_or_create_product(db, ln.item_code, ln.description)
    return None


def _resolve_dispatch_lines(db: Session, raw_lines) -> list[DispatchLine]:
    """Validate + resolve dispatch lines into row objects. Manual lines with an
    Item Code are matched/created lazily so user-typed items stay stock-trackable."""
    rows = []
    for ln in raw_lines:
        if float(ln.quantity or 0) < 0:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail="Dispatch quantity cannot be negative")
        product = _resolve_line_product(db, ln)
        rows.append(DispatchLine(
            product_id=product.id if product else None,
            description=(ln.description or "").strip(),
            quantity=float(ln.quantity or 0),
            dispatch_date=ln.dispatch_date,
            rate=ln.rate, weight=ln.weight,
            sales_order_line_id=ln.sales_order_line_id))
    return rows


def _dispatch_entries(d: Dispatch) -> list[tuple]:
    """Current tracked dispatch lines -> entry list for stock application.

    Each line is a single DISPATCH (out) movement at the dispatch's location
    (NULL plant = Main Store, legacy behaviour preserved).
    """
    return [
        (ln.product_id, MovementType.dispatch, ln.quantity,
         ln.dispatch_date or date.today(),
         f"Dispatched against {d.dispatch_no}", d.plant_id)
        for ln in d.lines
        if ln.product_id and float(ln.quantity or 0) != 0
    ]


def _sync_dispatch_stock(db: Session, d: Dispatch):
    """Reconcile Inventory/StockMovement with the dispatch's current lines.

    Only touches stock when the dispatch already has recorded movements
    (planning-only dispatches created without lines stay untouched).
    """
    if not _stocked(db, d.id):
        return
    reconvert_document(db, "dispatch", d.id, _dispatch_entries(d))
    for ln in d.lines:
        if ln.product_id and ln.quantity:
            refresh_reorder_alert(db, ln.product_id)


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
    # Auto-create a typed customer in the central master when no id is given.
    if body.customer_id is None and (body.customer_name or "").strip():
        c = get_or_create_customer(db, body.customer_name)
        body.customer_id = c.id if c else None
        body.customer_name = c.name if c else ""
    # New dispatches default to the seeded Dispatch location (location-based flow).
    if body.plant_id is None:
        dp = db.scalar(select(Plant).where(Plant.name == "Dispatch"))
        if dp is not None:
            body.plant_id = dp.id
    d = Dispatch(
        dispatch_no=body.dispatch_no or _next_no(db), customer_id=body.customer_id,
        plant_id=body.plant_id, sales_order_id=body.sales_order_id,
        sales_person=body.sales_person, schedule_qty=body.schedule_qty,
        ask_till_date=body.ask_till_date, dispatched_qty=body.dispatched_qty,
        opening_stock=body.opening_stock, status=body.status,
        dispatch_date=body.dispatch_date, delivery_status=body.delivery_status,
        transport_details=body.transport_details, report_date=body.report_date,
        remarks=body.remarks,
        lines=_resolve_dispatch_lines(db, body.lines),
    )
    d.dispatched_qty = sum(float(l.quantity or 0) for l in d.lines)
    _recalc_status(d)
    db.add(d)
    db.flush()
    # Lines provided at creation are actual date-wise dispatch entries: apply stock.
    reconvert_document(db, "dispatch", d.id, _dispatch_entries(d))
    db.commit()
    db.refresh(d)
    _sync_sales_order(db, d)
    db.commit()
    write_audit(db, user, "CREATE", "dispatches", d.id, f"Created dispatch {d.dispatch_no}")
    sync_purchase_shortages(db)
    return _serialize_dispatch(db, d)


@router.post("/{dispatch_id}/lines", response_model=dict)
def add_dispatch_line(dispatch_id: int, body: DispatchLineIn,
                      db: Annotated[Session, Depends(get_db)], user: AllStaff):
    """Record an actual dispatched quantity; reduces finished-goods stock."""
    d = get_or_404(db, Dispatch, dispatch_id)
    if body.quantity <= 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Dispatch quantity must be greater than 0")
    # Default new dispatches to the Dispatch location (location-based flow).
    if d.plant_id is None:
        dp = db.scalar(select(Plant).where(Plant.name == "Dispatch"))
        if dp is not None:
            d.plant_id = dp.id
    product = _resolve_line_product(db, body)
    db.add(DispatchLine(dispatch_id=d.id, product_id=product.id if product else None,
                        description=(body.description or "").strip(),
                        quantity=body.quantity,
                        dispatch_date=body.dispatch_date or date.today(),
                        rate=body.rate, weight=body.weight,
                        sales_order_line_id=body.sales_order_line_id))
    db.flush()
    db.expire(d, ["lines"])
    d.dispatched_qty = sum(float(l.quantity or 0) for l in d.lines)
    _recalc_status(d)
    if product:
        apply_movement(db, product.id, MovementType.dispatch, body.quantity,
                       body.dispatch_date or date.today(), ref_type="dispatch", ref_id=d.id,
                       remarks=f"Dispatched against {d.dispatch_no}", plant_id=d.plant_id)
        refresh_reorder_alert(db, product.id)
    db.commit()
    db.refresh(d)
    _sync_sales_order(db, d)
    db.commit()
    write_audit(db, user, "CREATE", "dispatch_lines", d.id, f"Dispatched {body.quantity} on {d.dispatch_no}")
    sync_purchase_shortages(db)
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
    if body.sales_order_line_id is not None:
        ln.sales_order_line_id = body.sales_order_line_id
    product = _resolve_line_product(db, body)
    if product is not None:
        ln.product_id = product.id
    d.dispatched_qty = sum(float(l.quantity or 0) for l in d.lines)
    _recalc_status(d)
    _sync_dispatch_stock(db, d)
    db.commit()
    db.refresh(d)
    _sync_sales_order(db, d)
    db.commit()
    write_audit(db, user, "UPDATE", "dispatch_lines", line_id,
                f"Dispatch line {line_id}: {old_qty} -> {new_qty}")
    sync_purchase_shortages(db)
    return _serialize_dispatch(db, d)


@router.delete("/lines/{line_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_dispatch_line(line_id: int, db: Annotated[Session, Depends(get_db)],
                         user: ManagerOrAdmin):
    """Delete a single date-wise dispatch entry.

    Stock for the removed entry is reversed through the existing reconvert
    mechanism (all remaining entries re-applied), the parent totals are
    recalculated, and other entries are preserved.
    """
    ln = get_or_404(db, DispatchLine, line_id)
    d = get_or_404(db, Dispatch, ln.dispatch_id)
    qty = float(ln.quantity or 0)
    sales_order_id = d.sales_order_id
    db.delete(ln)
    db.flush()
    db.expire(d, ["lines"])
    if not d.lines:
        # Last entry removed -> the dispatch holds no data; remove it entirely
        # (reverses stock, recomputes the linked order status).
        reverse_and_remove_ref(db, "dispatch", d.id)
        db.delete(d)
        db.commit()
        write_audit(db, user, "DELETE", "dispatch_lines", line_id,
                    f"Deleted last dispatch entry ({qty:g}) on {d.dispatch_no}")
        _sync_remaining_order_status(db, sales_order_id)
        db.commit()
        sync_purchase_shortages(db)
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    d.dispatched_qty = sum(float(l.quantity or 0) for l in d.lines)
    _recalc_status(d)
    _sync_dispatch_stock(db, d)
    db.commit()
    db.refresh(d)
    _sync_sales_order(db, d)
    db.commit()
    write_audit(db, user, "DELETE", "dispatch_lines", line_id,
                f"Deleted dispatch entry ({qty:g}) on {d.dispatch_no}")
    sync_purchase_shortages(db)
    return Response(status_code=status.HTTP_204_NO_CONTENT)

@router.delete("/{dispatch_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_dispatch(dispatch_id: int, db: Annotated[Session, Depends(get_db)],
                    user: ManagerOrAdmin):
    d = get_or_404(db, Dispatch, dispatch_id)
    sales_order_id = d.sales_order_id
    reverse_and_remove_ref(db, "dispatch", d.id)
    db.delete(d)
    db.commit()
    write_audit(db, user, "DELETE", "dispatches", dispatch_id, f"Deleted dispatch {d.dispatch_no}")
    _sync_remaining_order_status(db, sales_order_id)
    db.commit()
    sync_purchase_shortages(db)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# NEW ENDPOINTS: Item-wise customer dispatch view + completed production + local orders
# ---------------------------------------------------------------------------

@router.get("/customer-items/{customer_id}", response_model=dict)
def customer_items(
    customer_id: int,
    db: Annotated[Session, Depends(get_db)],
    _: CurrentUser,
):
    """Item-wise dispatch view for a customer.

    Groups all dispatch lines by product across ALL dispatches for this customer.
    Shows: schedule qty (from sales orders), total dispatched, balance, %,
    and per-item dispatch history with dates/quantities.
    """
    get_or_404(db, Customer, customer_id)

    all_dispatches = db.scalars(
        select(Dispatch).where(Dispatch.customer_id == customer_id)
        .order_by(Dispatch.report_date.desc(), Dispatch.id.desc())
    ).all()

    all_dispatch_lines = db.scalars(
        select(DispatchLine)
        .join(Dispatch, Dispatch.id == DispatchLine.dispatch_id)
        .where(Dispatch.customer_id == customer_id)
        .order_by(DispatchLine.dispatch_date.desc())
    ).all()

    # Build dispatch map: dispatch_id -> Dispatch object
    dispatch_map = {d.id: d for d in all_dispatches}

    # Aggregate by product
    by_product: dict = {}

    for ln in all_dispatch_lines:
        if ln.product_id is None:
            continue
        pid = ln.product_id
        if pid not in by_product:
            by_product[pid] = {
                "product_id": pid,
                "product": ln.product,
                "total_dispatched": 0.0,
                "dispatch_history": [],
                "sales_order_ids": set(),
                "po_nos": [],
            }
        e = by_product[pid]
        e["total_dispatched"] += float(ln.quantity or 0)
        d = dispatch_map.get(ln.dispatch_id)
        e["dispatch_history"].append({
            "dispatch_id": ln.dispatch_id,
            "dispatch_no": d.dispatch_no if d else "",
            "quantity": ln.quantity,
            "dispatch_date": ln.dispatch_date,
            "status": d.status.value if d else "",
            "sales_order_id": d.sales_order_id if d else None,
        })
        if d and d.sales_order_id:
            e["sales_order_ids"].add(d.sales_order_id)

    # Enrich with PO numbers and schedule from SalesOrderLine
    for pid, e in by_product.items():
        for so_id in e["sales_order_ids"]:
            sols = db.scalars(
                select(SalesOrderLine)
                .where(SalesOrderLine.order_id == so_id)
                .where(SalesOrderLine.product_id == pid)
            ).all()
            for sol in sols:
                if sol.customer_po_no and sol.customer_po_no not in e["po_nos"]:
                    e["po_nos"].append(sol.customer_po_no)
                e.setdefault("schedule_qty", 0.0)
                e["schedule_qty"] += float(sol.quantity or 0)

    # For products with NO linked sales order, fall back to Dispatch.schedule_qty
    for pid, e in by_product.items():
        if "schedule_qty" not in e or not e["schedule_qty"]:
            sched = 0.0
            for d in all_dispatches:
                if any(ln.product_id == pid for ln in d.lines):
                    sched += float(d.schedule_qty or 0)
            e["schedule_qty"] = sched

    # Sort history by date desc
    for e in by_product.values():
        e["dispatch_history"].sort(key=lambda x: x["dispatch_date"] or date.min, reverse=True)

    items = []
    for pid, e in sorted(by_product.items(), key=lambda x: (x[1]["po_nos"][0] if x[1]["po_nos"] else "", x[1]["product"].model if x[1]["product"] else "")):
        p = e["product"]
        schedule = e.get("schedule_qty", 0.0)
        dispatched = e["total_dispatched"]
        balance = schedule - dispatched if schedule else None
        pct = round(dispatched / schedule, 4) if schedule else 0.0
        items.append({
            "product_id": pid,
            "model": p.model if p else None,
            "item_code": p.item_code if p else None,
            "description": p.name if p else None,
            "po_no": e["po_nos"][0] if e["po_nos"] else "",
            "schedule_qty": schedule,
            "dispatched_qty": dispatched,
            "balance_qty": balance,
            "dispatch_pct": pct,
            "is_over_dispatched": balance is not None and balance < 0,
            "dispatch_count": len(e["dispatch_history"]),
            "dispatch_history": e["dispatch_history"],
        })

    return {"items": items, "total": len(items)}


@router.get("/completed-production", response_model=dict)
def completed_production_for_dispatch(
    db: Annotated[Session, Depends(get_db)],
    _: CurrentUser,
    date_from: str = "",
    date_to: str = "",
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
):
    """Completed production records available for dispatch.

    Returns production orders with status=Completed, including product,
    customer (if linked), PO (if linked), produced qty, and dates.
    Most recent completions first.
    """
    stmt = (
        select(ProductionOrder)
        .where(ProductionOrder.status == ProductionStatus.completed)
    )
    if date_from:
        try:
            from_date = date.fromisoformat(date_from)
        except ValueError:
            from_date = None
        if from_date:
            stmt = stmt.where(ProductionOrder.completion_date >= from_date)
    if date_to:
        try:
            to_date = date.fromisoformat(date_to)
        except ValueError:
            to_date = None
        if to_date:
            stmt = stmt.where(ProductionOrder.completion_date <= to_date)
    stmt = stmt.order_by(
        ProductionOrder.completion_date.desc().nullslast(),
        ProductionOrder.report_date.desc(),
        ProductionOrder.id.desc(),
    )
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.offset((page - 1) * page_size).limit(page_size)).all()

    items = []
    for po in rows:
        p = po.product
        customer = None
        if po.customer_id:
            c = db.get(Customer, po.customer_id)
            customer = {"id": c.id, "name": c.name} if c else None

        # Get PO number from linked sales order
        po_no = ""
        if po.sales_order_id:
            so = db.get(SalesOrder, po.sales_order_id)
            if so:
                po_no = so.customer_po_no
                if not po_no:
                    sol = db.scalar(
                        select(SalesOrderLine.customer_po_no)
                        .where(SalesOrderLine.order_id == so.id)
                        .where(SalesOrderLine.customer_po_no != "")
                        .limit(1)
                    )
                    po_no = sol or ""

        # Available qty = produced - dispatched (from inventory or dispatch records)
        dispatched_for_order = 0.0
        if po.sales_order_id:
            dispatched_for_order = float(db.scalar(
                select(func.coalesce(func.sum(Dispatch.dispatched_qty), 0))
                .where(Dispatch.sales_order_id == po.sales_order_id)
            ) or 0)
        available_qty = float(po.produced_qty or 0) - dispatched_for_order

        items.append({
            "id": po.id,
            "order_no": po.order_no,
            "product_id": po.product_id,
            "model": p.model if p else None,
            "item_code": p.item_code if p else None,
            "description": p.name if p else None,
            "customer": customer,
            "customer_id": po.customer_id,
            "po_no": po_no,
            "schedule_qty": po.schedule_qty,
            "produced_qty": po.produced_qty,
            "completion_date": po.completion_date,
            "report_date": po.report_date,
            "available_qty": available_qty,
            "status": po.status.value,
            "remarks": po.remarks,
        })

    return {"items": items, "total": total, "page": page, "page_size": page_size}


@router.get("/local-order-dispatch", response_model=dict)
def local_order_dispatch(
    db: Annotated[Session, Depends(get_db)],
    _: CurrentUser,
    date_from: str = "",
    date_to: str = "",
    ready_only: str = Query(default="", alias="ready_only"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
):
    """Local Order dispatch plan (Dispatch Department).

    Live readiness: order type, size/description, order qty, already-dispatched,
    pending, delivery date and a status derived from actual stock + dispatches.
    Orders ready for dispatch are surfaced for a one-click Dispatch Now.
    """
    from ..services.local_orders import serialize_local_order, sync_local_order_status

    stmt = (
        select(SalesOrder)
        .where(SalesOrder.order_type == OrderType.local)
    )
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
    stmt = stmt.order_by(SalesOrder.order_date.desc(), SalesOrder.id.desc())
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.offset((page - 1) * page_size).limit(page_size)).all()

    items = []
    for o in rows:
        sync_local_order_status(db, o)
        s = serialize_local_order(db, o)
        if ready_only and ready_only in ("ready", "1", "true") and s["status"] not in ("Ready for Dispatch", "Partially Dispatched"):
            continue
        items.append(s)
    db.commit()

    return {"items": items, "total": len(items), "page": page, "page_size": page_size}


@router.get("/{dispatch_id}", response_model=dict)
def get_dispatch(dispatch_id: int, db: Annotated[Session, Depends(get_db)],
                 _: CurrentUser):
    return _serialize_dispatch(db, get_or_404(db, Dispatch, dispatch_id))


@router.patch("/{dispatch_id}", response_model=dict)
def update_dispatch(dispatch_id: int, body: DispatchUpdate, db: Annotated[Session, Depends(get_db)],
                    user: AllStaff):
    d = get_or_404(db, Dispatch, dispatch_id)
    if (body.customer_name or "").strip():
        c = get_or_create_customer(db, body.customer_name)
        if c:
            d.customer_id = c.id
    apply_updates(d, body, exclude={"lines", "customer_name"})
    if body.lines is not None:
        db.query(DispatchLine).filter(DispatchLine.dispatch_id == d.id).delete()
        d.lines = _resolve_dispatch_lines(db, body.lines)
    d.dispatched_qty = sum(float(l.quantity or 0) for l in d.lines)
    _recalc_status(d)
    _sync_dispatch_stock(db, d)
    db.commit()
    db.refresh(d)
    _sync_sales_order(db, d)
    db.commit()
    write_audit(db, user, "UPDATE", "dispatches", d.id, f"Updated dispatch {d.dispatch_no}")
    sync_purchase_shortages(db)
    return _serialize_dispatch(db, d)