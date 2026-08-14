"""Raw material management (read + CRUD on balances)."""
from typing import Annotated

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..auth import CurrentUser, ManagerOrAdmin
from ..crud import get_or_404, write_audit
from ..database import get_db
from ..models import Inventory, Product, ProductCategory, RawMaterialBalance
from ..schemas import ProductCreate, ProductOut, RawMaterialBalanceOut

router = APIRouter(prefix="/raw-materials", tags=["raw-materials"])


def _rm_product_stmt():
    return select(Product).where(Product.category == ProductCategory.raw_material)


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
        items.append({
            **ProductOut.model_validate(p).model_dump(),
            "balance": RawMaterialBalanceOut.model_validate(b).model_dump() if b else None,
            "current_stock": inv.current_stock if inv else None,
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
    completion_pct: float | None = None, balance_qty: float | None = None,
    opening_stock: float | None = None,
):
    from datetime import date as _date
    rd = _date.fromisoformat(report_date)
    get_or_404(db, Product, product_id)
    b = db.scalars(select(RawMaterialBalance).where(
        RawMaterialBalance.product_id == product_id, RawMaterialBalance.report_date == rd)).first()
    if b is None:
        b = RawMaterialBalance(product_id=product_id, report_date=rd)
        db.add(b)
    if schedule_qty is not None: b.schedule_qty = schedule_qty
    if ask_till_date is not None: b.ask_till_date = ask_till_date
    if inward_qty is not None: b.inward_qty = inward_qty
    if completion_pct is not None: b.completion_pct = completion_pct
    if balance_qty is not None: b.balance_qty = balance_qty
    if opening_stock is not None: b.opening_stock = opening_stock
    db.commit()
    db.refresh(b)
    write_audit(db, user, "UPSERT", "raw_material_balances", b.id)
    return b