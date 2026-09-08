"""Raw material management (read + CRUD on balances).

Balance = Schedule - Inward and Inward % are always recomputed server-side on
every update so the UI never stores stale calculated values. MIN/MAX stock are
persisted on the RawMaterialBalance row and drive the existing Alerts centre
(via services.reorder_alerts). Current stock stays sourced from Inventory /
stock movements — this module never writes a competing stock figure.
"""
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import CurrentUser, ManagerOrAdmin
from ..crud import get_or_404, write_audit
from ..database import get_db
from ..models import Inventory, Product, ProductCategory, RawMaterialBalance
from ..schemas import ProductOut, RawMaterialBalanceOut
from ..services.reorder_alerts import refresh_reorder_alert

router = APIRouter(prefix="/raw-materials", tags=["raw-materials"])


def _rm_product_stmt():
    return select(Product).where(Product.category == ProductCategory.raw_material)


def _recalc(b: RawMaterialBalance) -> None:
    """Server-side source of truth for Balance Qty + Inward %."""
    sched = b.schedule_qty
    inward = b.inward_qty
    if sched is None:
        # Schedule not set yet — leave user-entered values untouched.
        return
    sched = float(sched)
    inward = float(inward or 0)
    b.balance_qty = round(sched - inward, 4)
    b.completion_pct = round(inward / sched, 4) if sched else 0.0


def _validate_numeric(label: str, value: float | None) -> None:
    if value is not None and value < 0:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            f"{label} cannot be negative")


@router.get("", response_model=dict)
def list_raw_materials(
    db: Annotated[Session, Depends(get_db)],
    _: CurrentUser,
    search: str = "",
    report_date: str = "",
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
):
    products = db.scalars(_rm_product_stmt().order_by(Product.model)).all()
    items = []
    for p in products:
        b = db.scalars(
            select(RawMaterialBalance).where(RawMaterialBalance.product_id == p.id)
            .order_by(RawMaterialBalance.report_date.desc()).limit(1)
        ).first()
        inv = db.scalars(select(Inventory).where(Inventory.product_id == p.id, Inventory.plant_id.is_(None))).first()
        balance = RawMaterialBalanceOut.model_validate(b).model_dump() if b else None
        current = inv.current_stock if inv else None
        # Reorder flag: current stock below configured MIN stock.
        reorder = False
        if balance is not None and balance.get("min_stock") is not None and current is not None:
            reorder = float(current or 0) < float(balance["min_stock"])
        items.append({
            **ProductOut.model_validate(p).model_dump(),
            "balance": balance,
            "current_stock": current,
            "reorder_required": reorder,
        })
    if search:
        items = [i for i in items if search.lower() in i["model"].lower() or search.lower() in (i["item_code"] or "").lower()]
    return {"items": items, "total": len(items), "page": page, "page_size": page_size}


@router.post("/balances", response_model=RawMaterialBalanceOut, status_code=status.HTTP_201_CREATED)
def upsert_balance(
    db: Annotated[Session, Depends(get_db)],
    user: ManagerOrAdmin,
    product_id: int, report_date: str, schedule_qty: float | None = None,
    ask_till_date: float | None = None, inward_qty: float | None = None,
    opening_stock: float | None = None,
    min_stock: float | None = None, max_stock: float | None = None,
):
    from datetime import date as _date
    rd = _date.fromisoformat(report_date)
    product = get_or_404(db, Product, product_id)

    for label, val in (("Schedule Quantity", schedule_qty), ("Inward Quantity", inward_qty),
                       ("Opening Stock", opening_stock), ("MIN STOCK", min_stock),
                       ("MAX STOCK", max_stock)):
        _validate_numeric(label, val)
    if min_stock is not None and max_stock is not None and max_stock < min_stock:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "MAX STOCK cannot be less than MIN STOCK")

    b = db.scalars(select(RawMaterialBalance).where(
        RawMaterialBalance.product_id == product_id, RawMaterialBalance.report_date == rd)).first()
    if b is None:
        b = RawMaterialBalance(product_id=product_id, report_date=rd)
        db.add(b)
    if schedule_qty is not None: b.schedule_qty = schedule_qty
    if ask_till_date is not None: b.ask_till_date = ask_till_date
    if inward_qty is not None: b.inward_qty = inward_qty
    if opening_stock is not None: b.opening_stock = opening_stock
    if min_stock is not None: b.min_stock = min_stock
    if max_stock is not None: b.max_stock = max_stock

    _recalc(b)  # balance + inward % recomputed from schedule/inward
    db.flush()
    refresh_reorder_alert(db, product_id, model_label=product.model)
    db.commit()
    db.refresh(b)
    write_audit(db, user, "UPSERT", "raw_material_balances", b.id)
    return b