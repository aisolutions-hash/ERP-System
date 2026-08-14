"""Inventory management: stock levels, movements, low-stock alerts."""
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..auth import CurrentUser, AllStaff
from ..crud import get_or_404, write_audit
from ..database import get_db
from ..models import (
    Inventory, MovementType, Plant, Product, StockMovement,
)
from ..schemas import (
    InventoryOut, StockMovementIn, StockMovementOut,
)
from datetime import date

router = APIRouter(prefix="/inventory", tags=["inventory"])


def _serialize_inv(inv: Inventory) -> dict:
    product = inv.product
    plant = inv.plant
    status_label = "OK"
    if inv.min_level is not None and inv.current_stock <= 0:
        status_label = "OUT_OF_STOCK"
    elif inv.min_level is not None and inv.current_stock < inv.min_level:
        status_label = "LOW"
    return {
        "id": inv.id, "product_id": inv.product_id, "plant_id": inv.plant_id,
        "opening_stock": inv.opening_stock, "received_qty": inv.received_qty,
        "issued_qty": inv.issued_qty, "current_stock": inv.current_stock,
        "min_level": inv.min_level, "status": status_label,
        "product": {"id": product.id, "model": product.model, "item_code": product.item_code,
                    "name": product.name, "category": product.category.value, "uom": product.uom} if product else None,
        "plant": {"id": plant.id, "name": plant.name} if plant else None,
    }


@router.get("", response_model=dict)
def list_inventory(
    db: Annotated[Session, Depends(get_db)],
    _: CurrentUser,
    search: str = "",
    category: str = "",
    plant_id: int | None = None,
    status_: str = Query(default="", alias="status"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
):
    stmt = select(Inventory)
    if plant_id is not None:
        stmt = stmt.where(Inventory.plant_id == plant_id)
    rows = db.scalars(stmt.order_by(Inventory.product_id)).all()
    items = [_serialize_inv(i) for i in rows]

    if search:
        items = [i for i in items if search.lower() in (i["product"]["model"] or "").lower()
                 or search.lower() in (i["product"]["item_code"] or "").lower()]
    if category:
        items = [i for i in items if i["product"]["category"] == category]
    if status_ == "LOW":
        items = [i for i in items if i["status"] == "LOW"]
    elif status_ == "OUT_OF_STOCK":
        items = [i for i in items if i["status"] == "OUT_OF_STOCK"]
    total = len(items)
    start = (page - 1) * page_size
    return {"items": items[start:start + page_size], "total": total, "page": page, "page_size": page_size}


@router.get("/low-stock", response_model=dict)
def low_stock(
    db: Annotated[Session, Depends(get_db)],
    _: CurrentUser,
):
    rows = db.scalars(select(Inventory)).all()
    low = [i for i in [_serialize_inv(x) for x in rows] if i["status"] in ("LOW", "OUT_OF_STOCK")]
    low.sort(key=lambda x: x["current_stock"])
    return {"items": low, "total": len(low)}


@router.post("/movements", response_model=StockMovementOut, status_code=status.HTTP_201_CREATED)
def create_movement(body: StockMovementIn, db: Annotated[Session, Depends(get_db)],
                    user: AllStaff):
    """Record a stock movement and update the matching inventory row."""
    get_or_404(db, Product, body.product_id)
    if body.quantity <= 0:
        raise status.HTTP_400_BAD_REQUEST
    m = StockMovement(product_id=body.product_id, plant_id=body.plant_id,
                      movement_type=body.movement_type, quantity=body.quantity,
                      transaction_date=body.transaction_date, remarks=body.remarks)
    inv = db.scalars(select(Inventory).where(
        Inventory.product_id == body.product_id,
        Inventory.plant_id == (body.plant_id if body.plant_id else None),
    )).first()
    if inv is None:
        inv = Inventory(product_id=body.product_id, plant_id=body.plant_id,
                        opening_stock=0, received_qty=0, issued_qty=0, current_stock=0)
        db.add(inv)
    if body.movement_type in (MovementType.receipt, MovementType.production_output):
        inv.received_qty = float(inv.received_qty or 0) + body.quantity
        inv.current_stock = float(inv.current_stock or 0) + body.quantity
    else:  # issue, consumption, dispatch, adjustment
        inv.issued_qty = float(inv.issued_qty or 0) + body.quantity
        inv.current_stock = float(inv.current_stock or 0) - body.quantity
    db.add(m)
    db.commit()
    db.refresh(m)
    write_audit(db, user, "CREATE", "stock_movements", m.id,
                f"{body.movement_type.value} {body.quantity} for product {body.product_id}")
    return m


@router.get("/movements", response_model=dict)
def list_movements(
    db: Annotated[Session, Depends(get_db)],
    _: CurrentUser,
    product_id: int | None = None,
    plant_id: int | None = None,
    movement_type: str = "",
    date_from: str = "",
    date_to: str = "",
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
):
    stmt = select(StockMovement)
    if product_id:
        stmt = stmt.where(StockMovement.product_id == product_id)
    if plant_id:
        stmt = stmt.where(StockMovement.plant_id == plant_id)
    if movement_type:
        stmt = stmt.where(StockMovement.movement_type == movement_type)
    if date_from:
        stmt = stmt.where(StockMovement.transaction_date >= date.fromisoformat(date_from))
    if date_to:
        stmt = stmt.where(StockMovement.transaction_date <= date.fromisoformat(date_to))
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(StockMovement.transaction_date.desc(), StockMovement.id.desc())
                      .offset((page - 1) * page_size).limit(page_size)).all()
    return {"items": [StockMovementOut.model_validate(m).model_dump() for m in rows],
            "total": total, "page": page, "page_size": page_size}