"""Raw material management: master-data CRUD + balance tracking.

Master data is the existing Product model (category=raw_material) so
user-created raw materials immediately become available to every module that
selects materials (BOM, Purchase, Production, Inventory, Material
Requirements, Stock Movements …). Balance = Schedule - Inward and Inward % are
always recomputed server-side so the UI never stores stale calculated values.
MIN/MAX stock drive the existing Alerts centre. Current stock stays sourced
from Inventory / stock movements — this module never writes a competing figure.

Delete safety: a raw material that is referenced by business records (BOM,
purchase, inventory, production, stock movements, requirements, …) is NEVER
cascade-deleted; the delete is rejected with a clear message.
"""
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..auth import CurrentUser, ManagerOrAdmin
from ..crud import apply_updates, get_or_404, write_audit
from ..database import get_db
from ..models import (
    BillOfMaterial, BOM, CustomerDispatchLine, DispatchLine, Inventory, Plan,
    Product, ProductAlias, ProductCategory, ProductionOrder, PurchaseOrderLine,
    PurchaseRequirement, RawMaterialBalance, SalesOrderLine, StockMovement,
    StockTransferLine,
)
from ..schemas import ProductCreate, ProductOut, ProductUpdate, RawMaterialBalanceOut
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


def _referenced_by(db: Session, product_id: int) -> list[str]:
    """Return the modules whose records reference this product.

    A referenced raw material must never be cascade-deleted; the caller
    rejects the delete with the returned list so the user sees exactly where
    the material is used.
    """
    checks = [
        ("BOM", BOM, BOM.product_id),
        ("Purchase", PurchaseOrderLine, PurchaseOrderLine.product_id),
        ("Inventory / Stock", Inventory, Inventory.product_id),
        ("Stock Movements", StockMovement, StockMovement.product_id),
        ("Stock Transfers", StockTransferLine, StockTransferLine.product_id),
        ("Customer Dispatches", CustomerDispatchLine, CustomerDispatchLine.product_id),
        ("Production", ProductionOrder, ProductionOrder.product_id),
        ("Sales Orders", SalesOrderLine, SalesOrderLine.product_id),
        ("Dispatch", DispatchLine, DispatchLine.product_id),
        ("Plans", Plan, Plan.product_id),
        ("Material Requirements", PurchaseRequirement, PurchaseRequirement.product_id),
        ("Raw Material Balances", RawMaterialBalance, RawMaterialBalance.product_id),
        ("Product Aliases", ProductAlias, ProductAlias.product_id),
    ]
    refs = []
    for label, model, column in checks:
        if db.scalar(select(func.count()).select_from(model).where(column == product_id)):
            refs.append(label)
    if db.scalar(select(func.count()).select_from(BillOfMaterial).where(
            or_(BillOfMaterial.product_id == product_id,
                BillOfMaterial.raw_material_product_id == product_id))):
        if "BOM" not in refs:
            refs.append("BOM")
    return refs


@router.post("", response_model=ProductOut, status_code=status.HTTP_201_CREATED)
def create_raw_material(body: ProductCreate, db: Annotated[Session, Depends(get_db)],
                        user: ManagerOrAdmin):
    model_name = (body.model or "").strip()
    if not model_name:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Material name is required")
    dup = db.scalar(select(Product.id).where(
        func.lower(Product.model) == model_name.lower()).limit(1))
    if dup:
        raise HTTPException(status.HTTP_409_CONFLICT,
                            f"Raw material '{model_name}' already exists. Duplicate records are not created.")
    data = body.model_dump()
    data["model"] = model_name
    data["category"] = ProductCategory.raw_material
    p = Product(**data)
    db.add(p)
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "Could not create raw material (item code / model already in use).")
    db.refresh(p)
    write_audit(db, user, "CREATE", "products", p.id, f"Created raw material {p.model}")
    return p


def _serialize_detail(db: Session, p: Product) -> dict:
    """Full detail for the View action (product master + latest balance keys)."""
    b = db.scalars(
        select(RawMaterialBalance).where(RawMaterialBalance.product_id == p.id)
        .order_by(RawMaterialBalance.report_date.desc()).limit(1)
    ).first()
    inv = db.scalars(select(Inventory).where(Inventory.product_id == p.id,
                                             Inventory.plant_id.is_(None))).first()
    return {
        **ProductOut.model_validate(p).model_dump(),
        "source_type": p.source_type.value if p.source_type else None,
        "family": p.family,
        "balance": RawMaterialBalanceOut.model_validate(b).model_dump() if b else None,
        "current_stock": inv.current_stock if inv else 0,
    }


@router.get("/{product_id}", response_model=dict)
def get_raw_material(product_id: int, db: Annotated[Session, Depends(get_db)],
                     _: CurrentUser):
    p = get_or_404(db, Product, product_id)
    if p.category != ProductCategory.raw_material:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Raw material not found")
    return _serialize_detail(db, p)


@router.patch("/{product_id}", response_model=ProductOut)
def update_raw_material(product_id: int, body: ProductUpdate,
                        db: Annotated[Session, Depends(get_db)],
                        user: ManagerOrAdmin):
    p = get_or_404(db, Product, product_id)
    if p.category != ProductCategory.raw_material:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Raw material not found")
    if body.model is not None:
        new_model = (body.model or "").strip()
        if not new_model:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Material name is required")
        dup = db.scalar(select(Product.id).where(
            func.lower(Product.model) == new_model.lower(),
            Product.id != product_id).limit(1))
        if dup:
            raise HTTPException(status.HTTP_409_CONFLICT,
                                f"Another record already uses material name '{new_model}'.")
        p.model = new_model
    # Category stays raw_material (excluded from generic update).
    apply_updates(p, body, exclude={"model", "category"})
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "Could not update raw material (item code / model already in use).")
    db.refresh(p)
    write_audit(db, user, "UPDATE", "products", p.id, f"Updated raw material {p.model}")
    return p


@router.delete("/{product_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_raw_material(product_id: int, db: Annotated[Session, Depends(get_db)],
                        user: ManagerOrAdmin):
    p = get_or_404(db, Product, product_id)
    if p.category != ProductCategory.raw_material:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Raw material not found")
    refs = _referenced_by(db, product_id)
    if refs:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Cannot delete raw material '{p.model}': it is referenced in "
            f"{', '.join(refs)}. Remove/reassign those records first, or edit it "
            "instead.")
    try:
        db.delete(p)
        db.commit()
    except Exception:
        db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT,
                            "Cannot delete raw material: it is referenced by other records.")
    write_audit(db, user, "DELETE", "products", product_id, f"Deleted raw material {p.model}")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


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