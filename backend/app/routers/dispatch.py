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
    OrderStatus, OrderType, Plan, PlanType, Plant, Product, ProductionOrder,
    ProductionStatus, SalesOrder, SalesOrderLine, StockMovement,
)
from ..schemas import DispatchCreate, DispatchLineIn, DispatchUpdate
from ..services.business import sync_purchase_shortages
from ..services.customers import get_or_create_customer
from ..services.local_orders import order_line_remaining
from ..services.reorder_alerts import refresh_reorder_alert
from ..services.stock_service import (
    apply_movement, ensure_available_stock, reconvert_document,
    resolve_or_create_product, reverse_and_remove_ref,
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
    """Resolve a dispatch line's product: linked id, or a manual item lazily
    created through the shared manual-product resolver.

    Product ID is the tracking identity; Item Code stays optional. A manual
    line with an Item Code matches/creates a Product keyed on (item_code,
    model); a blank Item Code with a description gets its own fresh Product
    (never merged by description) so stock is always tracked. Returns None
    only when there is genuinely nothing to identify (no linked product,
    blank Item Code and blank description).
    """
    if ln.product_id:
        return get_or_404(db, Product, ln.product_id)
    return resolve_or_create_product(db, ln.item_code or "", ln.description or "",
                                     allow_blank=True)


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


def _require_available_stock(db: Session, d: Dispatch, added: list[DispatchLine]) -> None:
    """Mandatory stock availability guard for ANY dispatched quantity (C1).

    Every tracked dispatch line subtracts finished-goods stock at the
    dispatch's own location (`d.plant_id`, NULL = Main Store), so the currently
    available stock there is the ceiling for every NEW/added line quantity. The
    Inventory row is locked FOR UPDATE inside the same transaction that later
    applies the movement, so check-then-deduct is atomic: a rejected request
    leaves NO partial database write and a concurrent dispatch cannot observe a
    stale balance. This applies to Standard / Manufacture / Trading AND Local
    order dispatches (Local Orders simply draw from the Dispatch location).

    The existing Local Order BALANCE guard is preserved unchanged: never
    dispatch more than the remaining quantity on the linked order line.
    """
    plant_id = d.plant_id
    totals: dict[int, float] = {}
    for ln in added:
        if ln.product_id is not None and float(ln.quantity or 0) > 0:
            totals[ln.product_id] = totals.get(ln.product_id, 0.0) + float(ln.quantity or 0)
    for pid in sorted(totals):
        ensure_available_stock(db, pid, plant_id, totals[pid],
                               context=f"dispatch {d.dispatch_no or 'stock out'}")
    # Balance guard (LOCAL orders only, unchanged rule).
    if not d.sales_order_id:
        return
    o = db.get(SalesOrder, d.sales_order_id)
    if o is None or o.order_type != OrderType.local:
        return
    remaining_totals: dict[int, float] = {}
    for ln in added:
        if ln.sales_order_line_id is not None and float(ln.quantity or 0) > 0:
            remaining_totals[ln.sales_order_line_id] = remaining_totals.get(ln.sales_order_line_id, 0.0) + float(ln.quantity or 0)
    for rid, qty in remaining_totals.items():
        remaining = order_line_remaining(db, rid)
        if remaining is None:
            continue
        if qty > remaining:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(f"Cannot dispatch more than the remaining {remaining:g} on this order line "
                        f"(trying to dispatch {qty:g})."),
            )


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
    # Mandatory Local Order guard: never dispatch more than CURRENTLY available
    # at the Dispatch location (checked before any stock effect is applied).
    _require_available_stock(db, d, list(d.lines))
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
    new_line = DispatchLine(dispatch_id=d.id, product_id=product.id if product else None,
                            description=(body.description or "").strip(),
                            quantity=body.quantity,
                            dispatch_date=body.dispatch_date or date.today(),
                            rate=body.rate, weight=body.weight,
                            sales_order_line_id=body.sales_order_line_id)
    # Mandatory Local Order guard: the additional quantity must be <= the stock
    # currently available at the Dispatch location.
    _require_available_stock(db, d, [new_line])
    db.add(new_line)
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
    # Snapshot the OLD per-product quantities BEFORE mutating, so the net stock
    # effect of this edit can be validated against currently available stock.
    old_per_product: dict[int, float] = {}
    for l in d.lines:
        if l.product_id is not None:
            old_per_product[l.product_id] = old_per_product.get(l.product_id, 0.0) + float(l.quantity or 0)
    new_qty = float(body.quantity)
    ln.quantity = new_qty
    ln.dispatch_date = body.dispatch_date or ln.dispatch_date
    if body.sales_order_line_id is not None:
        ln.sales_order_line_id = body.sales_order_line_id
    product = _resolve_line_product(db, body)
    if product is not None:
        ln.product_id = product.id
    # Net-delta availability guard (C1): reconvert reverses the whole dispatch
    # then re-applies it, so only the NET additional consumption per product at
    # this location must be covered by stock currently available. Applies to
    # every order type (locked FOR UPDATE in the same transaction).
    new_per_product: dict[int, float] = {}
    for l in d.lines:
        if l.product_id is not None:
            new_per_product[l.product_id] = new_per_product.get(l.product_id, 0.0) + float(l.quantity or 0)
    for pid in sorted(new_per_product):
        net_delta = new_per_product[pid] - old_per_product.get(pid, 0.0)
        if net_delta > 0:
            ensure_available_stock(db, pid, d.plant_id, net_delta,
                                   context=f"dispatch {d.dispatch_no or 'stock out'}")
    # Balance guard on edit (LOCAL orders only, unchanged rule): the edited
    # entry (with its own old qty excluded) plus everything else on the order
    # line must still be within the remaining schedule.
    if d.sales_order_id:
        o = db.get(SalesOrder, d.sales_order_id)
        if o is not None and o.order_type == OrderType.local and ln.sales_order_line_id is not None:
            remaining = order_line_remaining(db, ln.sales_order_line_id, exclude_line_id=ln.id)
            if remaining is not None and new_qty > remaining:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=(f"Cannot dispatch more than the remaining {remaining:g} on this order line "
                            f"(trying to dispatch {new_qty:g})."),
                )
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

    Returns production orders and production plans with status=Completed,
    including product, customer (if linked), PO (if linked), produced qty, and
    dates. A record whose produced qty has already been fully dispatched
    (available = produced - dispatched <= 0) is not offered for dispatch again.
    Most recent completions first.
    """
    items = []

    # --- Completed production ORDERS (status set via daily output movements) ---
    from_date = to_date = None
    if date_from:
        try:
            from_date = date.fromisoformat(date_from)
        except ValueError:
            from_date = None
    if date_to:
        try:
            to_date = date.fromisoformat(date_to)
        except ValueError:
            to_date = None

    # --- Finished-goods pool per PRODUCT (C5) --------------------------------
    # Produced = SUM(production_output movements) per product (the only
    # movements that actually add finished goods to stock), dispatched = all
    # DISPATCH movements. Available for dispatch is then the product-level pool
    # max(0, produced - dispatched). This is exact — one pool per product, no
    # per-order/per-plan double counting — so the availability always equals the
    # real available finished-goods stock for that product. Records whose pool is
    # exhausted (produced - dispatched <= 0) are not offered again.
    produced_by_product = dict(db.execute(
        select(
            StockMovement.product_id,
            func.coalesce(func.sum(StockMovement.quantity), 0),
        )
        .where(StockMovement.movement_type == MovementType.production_output)
        .group_by(StockMovement.product_id)
    ).all())
    dispatched_by_product = dict(db.execute(
        select(
            StockMovement.product_id,
            func.coalesce(func.sum(StockMovement.quantity), 0),
        )
        .where(StockMovement.movement_type == MovementType.dispatch)
        .group_by(StockMovement.product_id)
    ).all())

    stmt = (
        select(ProductionOrder)
        .where(ProductionOrder.status == ProductionStatus.completed)
    )
    if from_date:
        stmt = stmt.where(ProductionOrder.completion_date >= from_date)
    if to_date:
        stmt = stmt.where(ProductionOrder.completion_date <= to_date)
    orders = db.scalars(stmt.order_by(
        ProductionOrder.completion_date.desc().nullslast(),
        ProductionOrder.report_date.desc(),
        ProductionOrder.id.desc(),
    )).all()

    for po in orders:
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

        # Available qty = finished-goods pool for this product (produced
        # production_output movements - dispatch movements).
        produced_total = float(produced_by_product.get(po.product_id, 0.0) or 0)
        dispatched_total = float(dispatched_by_product.get(po.product_id, 0.0) or 0)
        available_qty = produced_total - dispatched_total
        if available_qty <= 0:
            continue

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

    # --- Completed production PLANS (finished goods posted to Main Store) ---
    plan_stmt = (
        select(Plan)
        .where(Plan.plan_type == PlanType.production)
        .where(func.upper(func.trim(Plan.status)) == "COMPLETED")
        .where(Plan.product_id.isnot(None))
        .where(Plan.quantity > 0)
    )
    if from_date:
        plan_stmt = plan_stmt.where(Plan.plan_date >= from_date)
    if to_date:
        plan_stmt = plan_stmt.where(Plan.plan_date <= to_date)
    plans = db.scalars(plan_stmt.order_by(
        Plan.plan_date.desc(),
        Plan.id.desc(),
    )).all()

    # Already-dispatched finished goods per product are pooled above (C5);
    # plans draw from the SAME product-level pool, so a dispatch is never
    # double-counted against the plan and the producing order together.
    for pl in plans:
        p = pl.product
        customer = None
        if pl.customer_id:
            c = db.get(Customer, pl.customer_id)
            customer = {"id": c.id, "name": c.name} if c else None
        produced = float(pl.quantity or 0)
        dispatched = float(dispatched_by_product.get(pl.product_id, 0.0) or 0)
        available_qty = float(produced_by_product.get(pl.product_id, 0.0) or 0) - dispatched
        if available_qty <= 0:
            continue

        items.append({
            "id": pl.id,
            "order_no": f"PLAN-{pl.id}",
            "product_id": pl.product_id,
            "model": p.model if p else pl.model,
            "item_code": p.item_code if p else None,
            "description": p.name if p else None,
            "customer": customer,
            "customer_id": pl.customer_id,
            "po_no": "",
            "schedule_qty": pl.quantity,
            "produced_qty": pl.quantity,
            "completion_date": pl.plan_date,
            "report_date": pl.plan_date,
            "available_qty": available_qty,
            "status": "Completed",
            "remarks": pl.remarks,
        })

    # Most recent completions first, then paginate over the combined list.
    items.sort(key=lambda x: x["completion_date"] or date.min, reverse=True)
    total = len(items)
    start = (page - 1) * page_size
    return {
        "items": items[start:start + page_size],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


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
    old_plant_id = d.plant_id
    old_per_product: dict[int, float] = {}
    for l in d.lines:
        if l.product_id is not None:
            old_per_product[l.product_id] = old_per_product.get(l.product_id, 0.0) + float(l.quantity or 0)
    apply_updates(d, body, exclude={"lines", "customer_name"})
    if body.lines is not None:
        db.query(DispatchLine).filter(DispatchLine.dispatch_id == d.id).delete()
        d.lines = _resolve_dispatch_lines(db, body.lines)
    d.dispatched_qty = sum(float(l.quantity or 0) for l in d.lines)
    _recalc_status(d)
    # Net-delta availability guard (C1): reconvert reverses the whole dispatch
    # then re-applies it; only the NET additional OUT per product at the (new)
    # location must be covered. A location change restores the old location and
    # the new location must cover the full new quantity.
    new_per_product: dict[int, float] = {}
    for l in d.lines:
        if l.product_id is not None:
            new_per_product[l.product_id] = new_per_product.get(l.product_id, 0.0) + float(l.quantity or 0)
    plant_changed = old_plant_id != d.plant_id
    for pid in sorted(new_per_product):
        need = new_per_product[pid] if plant_changed else (new_per_product[pid] - old_per_product.get(pid, 0.0))
        if need > 0:
            ensure_available_stock(db, pid, d.plant_id, need,
                                   context=f"dispatch {d.dispatch_no or 'stock out'}")
    _sync_dispatch_stock(db, d)
    db.commit()
    db.refresh(d)
    _sync_sales_order(db, d)
    db.commit()
    write_audit(db, user, "UPDATE", "dispatches", d.id, f"Updated dispatch {d.dispatch_no}")
    sync_purchase_shortages(db)
    return _serialize_dispatch(db, d)