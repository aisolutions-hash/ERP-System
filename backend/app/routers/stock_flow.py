"""Location-based stock flow: Stock Transfers (Main Store -> Dispatch/Production)
and simple Customer Dispatches (Dispatch location -> customer).

Both reuse the existing Inventory + StockMovement pipeline. Main Store is
plant_id = NULL (existing convention); Dispatch/Production are seeded Plants.
Customer on a transfer/dispatch is an OPTIONAL transaction reference only —
there is no Allocation/Reservation concept. This is additive: the sales-order
driven Dispatch module is untouched.
"""
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from ..auth import CurrentUser, AllStaff, ManagerOrAdmin
from ..crud import get_or_404, write_audit
from ..database import get_db
from ..models import (
    Customer, CustomerDispatch, CustomerDispatchLine, MovementType, Plant,
    Product, StockTransfer, StockTransferLine,
)
from ..schemas import (
    CustomerDispatchCreate, CustomerDispatchUpdate, StockTransferCreate,
    StockTransferUpdate,
)
from ..services.business import sync_purchase_shortages
from ..services.customers import get_or_create_customer
from ..services.local_orders import sync_local_orders_for_products
from ..services.reorder_alerts import refresh_reorder_alert
from ..services.stock_service import (
    ensure_available_stock, reconvert_document, resolve_or_create_product,
    reverse_and_remove_ref,
)
from datetime import date

# Internal stock locations (Main Store = plant_id NULL, existing convention).
_LOCATION_NAMES = ("Dispatch", "Production")


def _get_plant_or_404(db: Session, plant_id: int | None, what: str) -> Plant | None:
    if plant_id is None:
        return None
    p = db.get(Plant, plant_id)
    if p is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail=f"{what} plant {plant_id} not found")
    return p


def _line_totals(lines) -> dict[int, float]:
    """product_id -> pooled OUT quantity for a set of document rows."""
    totals: dict[int, float] = {}
    for ln in lines:
        if ln.product_id is not None and float(ln.quantity or 0) > 0:
            totals[ln.product_id] = totals.get(ln.product_id, 0.0) + float(ln.quantity or 0)
    return totals


def _check_create_out_availability(db: Session, plant_id: int | None, lines, context: str) -> None:
    """Locked availability guard for the OUT legs of a NEW document.

    Each tracked line's OUT quantity must be covered by the current available
    stock at the source location. Runs before any flush/commit, so a rejection
    leaves no partial database write. Locks the row with FOR UPDATE so the check
    and the subsequent deduction are atomic in the same transaction."""
    totals = _line_totals(lines)
    for pid in sorted(totals):
        ensure_available_stock(db, pid, plant_id, totals[pid], context=context)


def _check_edit_out_availability(db: Session, old_plant_id: int | None,
                                 new_plant_id: int | None, old_lines, new_lines,
                                 context: str) -> None:
    """Net-delta availability guard for reconvert-based edits.

    An edit reverses every existing leg then re-applies the document, so only
    the NET additional OUT quantity per (product, source) must be covered.
    When the source location changes, the old source is fully restored and the
    new source must cover the full new quantity."""
    old_totals = {pid: float(q or 0) for pid, q in _line_totals(old_lines).items()}
    new_totals = _line_totals(new_lines)
    same_plant = old_plant_id == new_plant_id
    for pid in sorted(new_totals):
        need = new_totals[pid] if not same_plant else (new_totals[pid] - old_totals.get(pid, 0.0))
        if need > 0:
            ensure_available_stock(db, pid, new_plant_id, need, context=context)


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------
def _next_transfer_no(db: Session) -> str:
    prefix = f"TR-{date.today().strftime('%Y%m%d')}-"
    n = db.scalar(select(func.count()).select_from(StockTransfer)
                  .where(StockTransfer.transfer_no.like(f"{prefix}%"))) or 0
    return f"{prefix}{n + 1:03d}"


def _next_dispatch_no(db: Session) -> str:
    prefix = f"CD-{date.today().strftime('%Y%m%d')}-"
    n = db.scalar(select(func.count()).select_from(CustomerDispatch)
                  .where(CustomerDispatch.dispatch_no.like(f"{prefix}%"))) or 0
    return f"{prefix}{n + 1:03d}"


def _dispatch_plant(db: Session) -> Plant:
    p = db.scalar(select(Plant).where(Plant.name == "Dispatch"))
    if p is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="Dispatch location not found — seed internal locations first")
    return p


def _set_customer(db: Session, doc, customer_id, customer_name):
    """Resolve the optional customer reference.

    customer_id (when provided) must exist; its name is stored for display.
    Otherwise a free-text customer_name is promoted into the central Customer
    master (auto-created on first use) and linked to the document.
    """
    if customer_id is not None:
        c = db.get(Customer, customer_id)
        if c is None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail=f"Customer {customer_id} not found")
        doc.customer_id = c.id
        doc.customer_name = c.name
    else:
        c = get_or_create_customer(db, customer_name)
        doc.customer_id = c.id if c else None
        doc.customer_name = c.name if c else ""


def _resolve_lines(db: Session, raw_lines, what: str, line_model) -> list:
    """Validate + resolve incoming lines into document line rows.

    `line_model` picks the row class (StockTransferLine / CustomerDispatchLine).
    Catalogue-linked products resolve directly; manual lines with an Item Code
    are matched/created lazily via the shared resolver. Lines without any
    product reference and without an Item Code stay untracked (documented but
    no stock effect).
    """
    if not raw_lines:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="Add at least one line")
    rows = []
    for ln in raw_lines:
        if float(ln.quantity or 0) < 0:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail=f"{what} quantity cannot be negative")
        if not ln.product_id and (ln.description or "").strip() and not (ln.item_code or "").strip():
            product = None
        elif ln.product_id:
            product = get_or_404(db, Product, ln.product_id)
        else:
            product = resolve_or_create_product(db, ln.item_code, ln.description)
        rows.append(line_model(product_id=product.id if product else None,
                               item_code=(ln.item_code or "").strip(),
                               description=(ln.description or "").strip(),
                               quantity=float(ln.quantity or 0)))
    return rows


def _apply_transfer_stock(db: Session, t: StockTransfer):
    """Reverse any prior transfer legs and re-apply the current document state.

    Each tracked line produces two legs sharing the document reference:
      OUT leg  -> source location, MovementType.TRANSFER (stock -qty)
      IN leg   -> destination location, MovementType.RECEIPT (stock +qty)
    """
    entries = []
    for ln in t.lines:
        if ln.product_id and float(ln.quantity or 0) != 0:
            qty = float(ln.quantity or 0)
            from_name = t.from_plant.name if t.from_plant else "Main Store"
            to_name = t.to_plant.name if t.to_plant else "?"
            entries.append((ln.product_id, MovementType.transfer, qty, t.transfer_date,
                            f"Transfer out {t.transfer_no} from {from_name}", t.from_plant_id))
            entries.append((ln.product_id, MovementType.receipt, qty, t.transfer_date,
                            f"Transfer in {t.transfer_no} to {to_name}", t.to_plant_id))
    reconvert_document(db, "stock_transfer", t.id, entries)
    for ln in t.lines:
        if ln.product_id:
            refresh_reorder_alert(db, ln.product_id)


def _apply_dispatch_stock(db: Session, d: CustomerDispatch):
    """Reverse any prior dispatch legs and re-apply the current document state.

    Each tracked line is a single OUT leg at the Dispatch location using the
    existing MovementType.DISPATCH (stock -qty).
    """
    entries = []
    for ln in d.lines:
        if ln.product_id and float(ln.quantity or 0) != 0:
            customer = d.customer_name or "customer"
            entries.append((ln.product_id, MovementType.dispatch, float(ln.quantity),
                            d.dispatch_date,
                            f"Dispatched to {customer} ({d.dispatch_no})", d.plant_id))
    reconvert_document(db, "customer_dispatch", d.id, entries)
    for ln in d.lines:
        if ln.product_id:
            refresh_reorder_alert(db, ln.product_id)


def _serialize_line_product(ln) -> dict | None:
    if ln.product is None:
        return None
    p = ln.product
    return {"id": p.id, "model": p.model, "item_code": p.item_code,
            "category": p.category.value}


def _serialize_transfer(t: StockTransfer) -> dict:
    customer = None
    if t.customer:
        customer = {"id": t.customer.id, "name": t.customer.name}
    elif t.customer_name:
        customer = {"name": t.customer_name}
    return {
        "id": t.id, "transfer_no": t.transfer_no,
        "from_plant_id": t.from_plant_id, "to_plant_id": t.to_plant_id,
        "customer_id": t.customer_id, "customer_name": t.customer_name,
        "customer": customer,
        "from_plant": {"id": t.from_plant.id, "name": t.from_plant.name}
        if t.from_plant else {"name": "Main Store"},
        "to_plant": {"id": t.to_plant.id, "name": t.to_plant.name}
        if t.to_plant else None,
        "transfer_date": t.transfer_date, "notes": t.notes,
        "created_at": t.created_at,
        "lines": [{
            "id": ln.id, "product_id": ln.product_id,
            "item_code": ln.item_code or (ln.product.item_code if ln.product else ""),
            "description": ln.description, "quantity": ln.quantity,
            "product": _serialize_line_product(ln),
        } for ln in t.lines],
    }


def _serialize_dispatch(d: CustomerDispatch) -> dict:
    customer = None
    if d.customer:
        customer = {"id": d.customer.id, "name": d.customer.name}
    elif d.customer_name:
        customer = {"name": d.customer_name}
    return {
        "id": d.id, "dispatch_no": d.dispatch_no,
        "customer_id": d.customer_id, "customer_name": d.customer_name,
        "customer": customer,
        "plant_id": d.plant_id,
        "plant": {"id": d.plant.id, "name": d.plant.name} if d.plant else None,
        "dispatch_date": d.dispatch_date, "remarks": d.remarks,
        "created_at": d.created_at,
        "lines": [{
            "id": ln.id, "product_id": ln.product_id,
            "item_code": ln.item_code or (ln.product.item_code if ln.product else ""),
            "description": ln.description, "quantity": ln.quantity,
            "product": _serialize_line_product(ln),
        } for ln in d.lines],
    }


def _warnings(doc_lines) -> list[str]:
    return [
        f"Line {i + 1} ({ln.description or 'manual item'}) has no Item Code and no linked "
        "product — recorded on the document but stock was NOT updated. Add an Item Code "
        "or link a product to track stock."
        for i, ln in enumerate(doc_lines)
        if ln.product_id is None and not (ln.item_code or "").strip()
    ]


# ---------------------------------------------------------------------------
# Locations
# ---------------------------------------------------------------------------
locations_router = APIRouter(prefix="/inventory", tags=["inventory"])


@locations_router.get("/locations", response_model=dict)
def list_locations(db: Annotated[Session, Depends(get_db)], _: CurrentUser):
    rows = db.scalars(select(Plant).where(Plant.name.in_(_LOCATION_NAMES))
                      .order_by(Plant.name)).all()
    items = [{"id": p.id, "name": p.name} for p in rows]
    items.insert(0, {"id": None, "name": "Main Store"})
    return {"items": items, "total": len(items)}


# ---------------------------------------------------------------------------
# Stock Transfers
# ---------------------------------------------------------------------------
transfer_router = APIRouter(prefix="/inventory/transfers", tags=["inventory"])


@transfer_router.get("", response_model=dict)
def list_transfers(
    db: Annotated[Session, Depends(get_db)],
    _: CurrentUser,
    search: str = "",
    customer_id: int | None = None,
    date_from: str = "",
    date_to: str = "",
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=500),
):
    stmt = select(StockTransfer)
    if search:
        like = f"%{search}%"
        stmt = stmt.where(or_(StockTransfer.transfer_no.ilike(like),
                              StockTransfer.customer_name.ilike(like),
                              StockTransfer.notes.ilike(like)))
    if customer_id:
        stmt = stmt.where(StockTransfer.customer_id == customer_id)
    if date_from:
        stmt = stmt.where(StockTransfer.transfer_date >= date.fromisoformat(date_from))
    if date_to:
        stmt = stmt.where(StockTransfer.transfer_date <= date.fromisoformat(date_to))
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.options(selectinload(StockTransfer.lines))
                      .order_by(StockTransfer.transfer_date.desc(), StockTransfer.id.desc())
                      .offset((page - 1) * page_size).limit(page_size)).all()
    return {"items": [_serialize_transfer(t) for t in rows],
            "total": total, "page": page, "page_size": page_size}


@transfer_router.post("", response_model=dict, status_code=status.HTTP_201_CREATED)
def create_transfer(body: StockTransferCreate, db: Annotated[Session, Depends(get_db)],
                    user: AllStaff):
    _get_plant_or_404(db, body.to_plant_id, "Destination")
    if body.from_plant_id is not None and body.from_plant_id == body.to_plant_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="Source and destination locations must be different")
    _get_plant_or_404(db, body.from_plant_id, "Source")

    transfer_no = (body.transfer_no or "").strip() or _next_transfer_no(db)
    if db.scalar(select(func.count()).select_from(StockTransfer)
                 .where(StockTransfer.transfer_no == transfer_no)):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="Transfer number already exists")

    t = StockTransfer(transfer_no=transfer_no,
                      from_plant_id=body.from_plant_id,
                      to_plant_id=body.to_plant_id,
                      transfer_date=body.transfer_date,
                      notes=(body.notes or "").strip())
    t.lines = _resolve_lines(db, body.lines, "Transfer", StockTransferLine)
    # Availability guard: the OUT leg (source location) must have the stock.
    _check_create_out_availability(db, t.from_plant_id, t.lines, "stock transfer out")
    _set_customer(db, t, body.customer_id, body.customer_name)
    db.add(t)
    db.flush()
    _apply_transfer_stock(db, t)
    db.commit()
    db.refresh(t)
    write_audit(db, user, "CREATE", "stock_transfers", t.id,
                f"Transferred stock {t.transfer_no} ({t.customer_name or 'no customer'})")
    sync_purchase_shortages(db)
    sync_local_orders_for_products(db, [ln.product_id for ln in t.lines])
    result = _serialize_transfer(t)
    result["warnings"] = _warnings(t.lines)
    return result


@transfer_router.get("/{transfer_id}", response_model=dict)
def get_transfer(transfer_id: int, db: Annotated[Session, Depends(get_db)],
                 _: CurrentUser):
    t = get_or_404(db, StockTransfer, transfer_id)
    result = _serialize_transfer(t)
    result["warnings"] = _warnings(t.lines)
    return result


@transfer_router.patch("/{transfer_id}", response_model=dict)
def update_transfer(transfer_id: int, body: StockTransferUpdate,
                    db: Annotated[Session, Depends(get_db)], user: AllStaff):
    t = get_or_404(db, StockTransfer, transfer_id)
    data = body.model_dump(exclude_unset=True)

    old_from_plant_id = t.from_plant_id
    old_lines = list(t.lines)

    if body.transfer_no is not None and body.transfer_no.strip() and body.transfer_no != t.transfer_no:
        if db.scalar(select(func.count()).select_from(StockTransfer)
                     .where(StockTransfer.transfer_no == body.transfer_no,
                            StockTransfer.id != t.id)):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                                detail="Transfer number already exists")
        t.transfer_no = body.transfer_no.strip()
    if "to_plant_id" in data:
        if body.to_plant_id is None:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail="Destination location is required")
        _get_plant_or_404(db, body.to_plant_id, "Destination")
        t.to_plant_id = body.to_plant_id
    if "from_plant_id" in data:
        if body.from_plant_id is not None:
            _get_plant_or_404(db, body.from_plant_id, "Source")
        t.from_plant_id = body.from_plant_id
    if body.from_plant_id is not None and body.from_plant_id == t.to_plant_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="Source and destination locations must be different")
    if "transfer_date" in data:
        t.transfer_date = body.transfer_date
    if "notes" in data and body.notes is not None:
        t.notes = body.notes

    change_lines = "lines" in data
    change_loc = "from_plant_id" in data or "to_plant_id" in data or "transfer_date" in data

    # Customer fields (transaction reference).
    if "customer_id" in data:
        _set_customer(db, t, body.customer_id, None)
    elif "customer_name" in data:
        _set_customer(db, t, None, body.customer_name)

    # Resolve the new lines first so the availability guard can run BEFORE any
    # stock reversal: the net-delta check must be against the location's REAL
    # pre-edit available stock, not against its own restored amount.
    new_lines = None
    if change_lines:
        new_lines = _resolve_lines(db, body.lines, "Transfer", StockTransferLine)
    if change_lines or change_loc:
        _check_edit_out_availability(db, old_from_plant_id, t.from_plant_id,
                                     old_lines, new_lines or old_lines, "stock transfer out")

    if change_lines:
        reverse_and_remove_ref(db, "stock_transfer", t.id)
        db.query(StockTransferLine).filter(StockTransferLine.transfer_id == t.id).delete()
        t.lines = new_lines
    if change_lines or change_loc:
        _apply_transfer_stock(db, t)

    db.commit()
    db.refresh(t)
    write_audit(db, user, "UPDATE", "stock_transfers", t.id,
                f"Updated transfer {t.transfer_no}")
    sync_purchase_shortages(db)
    sync_local_orders_for_products(db, [ln.product_id for ln in t.lines])
    result = _serialize_transfer(t)
    result["warnings"] = _warnings(t.lines)
    return result


@transfer_router.delete("/{transfer_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_transfer(transfer_id: int, db: Annotated[Session, Depends(get_db)],
                    user: ManagerOrAdmin):
    t = get_or_404(db, StockTransfer, transfer_id)
    product_ids = [ln.product_id for ln in t.lines]
    reverse_and_remove_ref(db, "stock_transfer", t.id)
    db.delete(t)
    db.commit()
    write_audit(db, user, "DELETE", "stock_transfers", transfer_id,
                f"Deleted transfer {t.transfer_no}")
    sync_purchase_shortages(db)
    sync_local_orders_for_products(db, product_ids)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ---------------------------------------------------------------------------
# Customer Dispatch (simple location-based, additive to Sales-Order dispatch)
# ---------------------------------------------------------------------------
dispatch_router = APIRouter(prefix="/inventory/dispatches", tags=["inventory"])


@dispatch_router.get("", response_model=dict)
def list_dispatches(
    db: Annotated[Session, Depends(get_db)],
    _: CurrentUser,
    search: str = "",
    customer_id: int | None = None,
    date_from: str = "",
    date_to: str = "",
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=500),
):
    stmt = select(CustomerDispatch)
    if search:
        like = f"%{search}%"
        stmt = stmt.where(or_(CustomerDispatch.dispatch_no.ilike(like),
                              CustomerDispatch.customer_name.ilike(like),
                              CustomerDispatch.remarks.ilike(like)))
    if customer_id:
        stmt = stmt.where(CustomerDispatch.customer_id == customer_id)
    if date_from:
        stmt = stmt.where(CustomerDispatch.dispatch_date >= date.fromisoformat(date_from))
    if date_to:
        stmt = stmt.where(CustomerDispatch.dispatch_date <= date.fromisoformat(date_to))
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.options(selectinload(CustomerDispatch.lines))
                      .order_by(CustomerDispatch.dispatch_date.desc(), CustomerDispatch.id.desc())
                      .offset((page - 1) * page_size).limit(page_size)).all()
    return {"items": [_serialize_dispatch(d) for d in rows],
            "total": total, "page": page, "page_size": page_size}


@dispatch_router.get("/history", response_model=dict)
def dispatch_history(
    db: Annotated[Session, Depends(get_db)],
    _: CurrentUser,
    customer_id: int | None = None,
    date_from: str = "",
    date_to: str = "",
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
):
    """Flat, date-wise customer dispatch history (one row per line).

    Columns: date | customer | product | item code | quantity | location.
    Each dispatch transaction stays separate; previous dispatches are never
    overwritten.
    """
    stmt = (select(CustomerDispatchLine, CustomerDispatch)
            .join(CustomerDispatch, CustomerDispatch.id == CustomerDispatchLine.dispatch_id))
    if customer_id:
        stmt = stmt.where(CustomerDispatch.customer_id == customer_id)
    if date_from:
        stmt = stmt.where(CustomerDispatch.dispatch_date >= date.fromisoformat(date_from))
    if date_to:
        stmt = stmt.where(CustomerDispatch.dispatch_date <= date.fromisoformat(date_to))
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.execute(stmt.options(selectinload(CustomerDispatchLine.product),
                                   selectinload(CustomerDispatch.plant))
                      .order_by(CustomerDispatch.dispatch_date.desc(),
                                CustomerDispatch.id.desc(),
                                CustomerDispatchLine.id.desc())
                      .offset((page - 1) * page_size).limit(page_size)).all()
    items = []
    for ln, d in rows:
        p = ln.product
        items.append({
            "dispatch_id": d.id, "line_id": ln.id,
            "dispatch_no": d.dispatch_no,
            "dispatch_date": d.dispatch_date,
            "customer_id": d.customer_id,
            "customer": d.customer_name or (d.customer.name if d.customer else ""),
            "product_id": ln.product_id,
            "product": p.model if p else (ln.description or ""),
            "item_code": ln.item_code or (p.item_code if p else ""),
            "description": ln.description,
            "quantity": ln.quantity,
            "location": d.plant.name if d.plant else "Main Store",
        })
    return {"items": items, "total": total, "page": page, "page_size": page_size}


@dispatch_router.post("", response_model=dict, status_code=status.HTTP_201_CREATED)
def create_dispatch(body: CustomerDispatchCreate, db: Annotated[Session, Depends(get_db)],
                    user: AllStaff):
    plant = _get_plant_or_404(db, body.plant_id, "Dispatch") if body.plant_id else _dispatch_plant(db)

    dispatch_no = (body.dispatch_no or "").strip() or _next_dispatch_no(db)
    if db.scalar(select(func.count()).select_from(CustomerDispatch)
                 .where(CustomerDispatch.dispatch_no == dispatch_no)):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="Dispatch number already exists")

    d = CustomerDispatch(dispatch_no=dispatch_no, plant_id=plant.id,
                         dispatch_date=body.dispatch_date,
                         remarks=(body.remarks or "").strip())
    _set_customer(db, d, body.customer_id, body.customer_name)
    d.lines = _resolve_lines(db, body.lines, "Dispatch", CustomerDispatchLine)
    # Availability guard: every tracked line is an OUT leg at this location.
    _check_create_out_availability(db, d.plant_id, d.lines, "customer dispatch")
    db.add(d)
    db.flush()
    _apply_dispatch_stock(db, d)
    db.commit()
    db.refresh(d)
    write_audit(db, user, "CREATE", "customer_dispatches", d.id,
                f"Dispatched stock {d.dispatch_no} to {d.customer_name or 'no customer'}")
    sync_purchase_shortages(db)
    result = _serialize_dispatch(d)
    result["warnings"] = _warnings(d.lines)
    return result


@dispatch_router.get("/{dispatch_id}", response_model=dict)
def get_dispatch(dispatch_id: int, db: Annotated[Session, Depends(get_db)],
                 _: CurrentUser):
    d = get_or_404(db, CustomerDispatch, dispatch_id)
    result = _serialize_dispatch(d)
    result["warnings"] = _warnings(d.lines)
    return result


@dispatch_router.patch("/{dispatch_id}", response_model=dict)
def update_dispatch(dispatch_id: int, body: CustomerDispatchUpdate,
                    db: Annotated[Session, Depends(get_db)], user: AllStaff):
    d = get_or_404(db, CustomerDispatch, dispatch_id)
    data = body.model_dump(exclude_unset=True)

    old_plant_id = d.plant_id
    old_lines = list(d.lines)

    if body.dispatch_no is not None and body.dispatch_no.strip() and body.dispatch_no != d.dispatch_no:
        if db.scalar(select(func.count()).select_from(CustomerDispatch)
                     .where(CustomerDispatch.dispatch_no == body.dispatch_no,
                            CustomerDispatch.id != d.id)):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                                detail="Dispatch number already exists")
        d.dispatch_no = body.dispatch_no.strip()
    if "plant_id" in data:
        if body.plant_id is not None:
            plant = _get_plant_or_404(db, body.plant_id, "Dispatch")
            d.plant_id = plant.id
    if "dispatch_date" in data:
        d.dispatch_date = body.dispatch_date
    if "remarks" in data and body.remarks is not None:
        d.remarks = body.remarks

    change_lines = "lines" in data
    change_loc = "plant_id" in data or "dispatch_date" in data

    if "customer_id" in data:
        _set_customer(db, d, body.customer_id, None)
    elif "customer_name" in data:
        _set_customer(db, d, None, body.customer_name)

    # Resolve the new lines first so the net-delta availability guard runs
    # BEFORE any stock reversal (real pre-edit available stock; full new
    # quantity when the Dispatch location itself changed).
    new_lines = None
    if change_lines:
        new_lines = _resolve_lines(db, body.lines, "Dispatch", CustomerDispatchLine)
    if change_lines or change_loc:
        _check_edit_out_availability(db, old_plant_id, d.plant_id,
                                     old_lines, new_lines or old_lines, "customer dispatch")

    if change_lines:
        reverse_and_remove_ref(db, "customer_dispatch", d.id)
        db.query(CustomerDispatchLine).filter(CustomerDispatchLine.dispatch_id == d.id).delete()
        d.lines = new_lines
    if change_lines or change_loc:
        _apply_dispatch_stock(db, d)

    db.commit()
    db.refresh(d)
    write_audit(db, user, "UPDATE", "customer_dispatches", d.id,
                f"Updated dispatch {d.dispatch_no}")
    sync_purchase_shortages(db)
    result = _serialize_dispatch(d)
    result["warnings"] = _warnings(d.lines)
    return result


@dispatch_router.delete("/{dispatch_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_dispatch(dispatch_id: int, db: Annotated[Session, Depends(get_db)],
                    user: ManagerOrAdmin):
    d = get_or_404(db, CustomerDispatch, dispatch_id)
    reverse_and_remove_ref(db, "customer_dispatch", d.id)
    db.delete(d)
    db.commit()
    write_audit(db, user, "DELETE", "customer_dispatches", dispatch_id,
                f"Deleted dispatch {d.dispatch_no}")
    sync_purchase_shortages(db)
    return Response(status_code=status.HTTP_204_NO_CONTENT)