"""Inventory management: stock levels, movements, low-stock alerts."""
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from ..auth import CurrentUser, AllStaff, ManagerOrAdmin
from ..crud import apply_updates, get_or_404, write_audit
from ..database import get_db
from ..models import (
    BOM, BillOfMaterial, CustomerDispatchLine, DispatchLine, Inventory,
    MovementType, Plant, Product, ProductCategory, ProductionOrder,
    PurchaseOrderLine, PurchaseRequirement, RawMaterialBalance,
    SalesOrderLine, StockMovement, StockTransferLine,
)
from ..schemas import (
    InventoryUpdate, InventoryOut, ManualAddStockIn, StockMovementIn, StockMovementOut,
)
from ..services.business import sync_purchase_shortages
from ..services.reorder_alerts import refresh_reorder_alert
from ..services.stock_service import apply_movement, ensure_available_stock, get_or_create_inventory, resolve_or_create_product
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
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Quantity must be greater than 0")
    # Availability guard for OUT movements (issue / consumption / adjustment /
    # dispatch / transfer): never deduct more stock than is currently available.
    # Locked inside the same transaction as the deduction, so a rejected request
    # leaves no partial database write. Receipts/production output are inbound.
    if body.movement_type not in (MovementType.receipt, MovementType.production_output):
        ensure_available_stock(db, body.product_id, body.plant_id, body.quantity,
                               context=f"{body.movement_type.value}")
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
    db.flush()
    refresh_reorder_alert(db, body.product_id)
    db.commit()
    db.refresh(m)
    write_audit(db, user, "CREATE", "stock_movements", m.id,
                f"{body.movement_type.value} {body.quantity} for product {body.product_id}")
    sync_purchase_shortages(db)
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
    rows = db.scalars(stmt.options(selectinload(StockMovement.product), selectinload(StockMovement.plant))
                      .order_by(StockMovement.transaction_date.desc(), StockMovement.id.desc())
                      .offset((page - 1) * page_size).limit(page_size)).all()
    items = []
    for m in rows:
        item = StockMovementOut.model_validate(m).model_dump()
        p = m.product
        item["product"] = {"id": p.id, "model": p.model, "uom": p.uom,
                           "item_code": p.item_code, "category": p.category.value} if p else None
        item["plant"] = m.plant.name if m.plant else None
        items.append(item)
    return {"items": items, "total": total, "page": page, "page_size": page_size}


def _resolve_target_product(db: Session, body: "ManualAddStockIn") -> Product:
    """Resolve (reuse or freshly create) the Product that owns this stock.

    A `product_id` is reused as the tracking identity. Otherwise the item is
    matched/created via the shared resolver so behaviour is identical to the
    Purchase flow: an Item Code matches/creates a Product keyed on
    (item_code, model); a blank Item Code with a description gets its own fresh
    Product (unique internal ID, never merged by description). Returns None
    only if there is genuinely nothing to identify the item.
    """
    if body.product_id is not None:
        return get_or_404(db, Product, body.product_id)
    p = resolve_or_create_product(db, body.item_code or "", body.description or "",
                                  allow_blank=True)
    if p is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot identify the item: provide a Product, an Item Code, or a description.",
        )
    return p


@router.post("/add-stock", response_model=StockMovementOut, status_code=status.HTTP_201_CREATED)
def add_stock(body: ManualAddStockIn, db: Annotated[Session, Depends(get_db)],
              user: AllStaff):
    """Manually add physically received stock from Inventory.

    Records an INWARD (RECEIPT) movement on the resolved Product and increases
    the matching Inventory row at the chosen location. Uses the SAME
    `apply_movement` pipeline as purchases / transfers / production output, so
    Inventory.current_stock and the StockMovement history stay consistent and
    the new stock is immediately visible to dispatch, orders, production,
    raw-material and report modules without any extra wiring.
    """
    product = _resolve_target_product(db, body)
    if body.plant_id is not None:
        get_or_404(db, Plant, body.plant_id)

    # Apply category/unit only when the resolver freshly created the product,
    # so we never clobber an existing catalogue entry's metadata.
    if (body.category is not None or body.unit is not None) and not (product.item_code or "").strip():
        if body.category is not None:
            try:
                product.category = ProductCategory(body.category)
            except ValueError:
                raise HTTPException(status_code=400,
                                    detail=f"Invalid category {body.category!r}")
        if body.unit is not None and body.unit.strip():
            product.uom = body.unit.strip()
    elif body.unit is not None and body.unit.strip():
        product.uom = body.unit.strip()

    m = apply_movement(
        db, product.id, MovementType.receipt, body.quantity,
        body.transaction_date, ref_type="", ref_id=None,
        remarks=(body.remarks or "").strip(), plant_id=body.plant_id,
    )
    db.flush()
    refresh_reorder_alert(db, product.id)
    if body.min_level is not None:
        inv = db.scalars(
            select(Inventory).where(Inventory.product_id == product.id,
                                    Inventory.plant_id == (body.plant_id if body.plant_id else None))
        ).first()
        if inv is None:
            inv = get_or_create_inventory(db, product.id, body.plant_id)
        inv.min_level = float(body.min_level)
    db.commit()
    db.refresh(m)
    write_audit(db, user, "CREATE", "stock_movements", m.id,
                f"Manual stock add +{body.quantity} for product {product.id}"
                f" (plant {body.plant_id or 'Main'})")
    sync_purchase_shortages(db)
    return m


def _row_refs(db: Session, inv: Inventory) -> tuple[int, list[str]]:
    """Count and describe business references to an Inventory row (by product
    + location) so deletion never orphans stock-affecting data."""
    pid = inv.product_id
    loc = inv.plant_id
    refs: list[tuple[str, str, int]] = []
    T = [
        ("Stock Movement", StockMovement,
         (StockMovement.product_id == pid,
          StockMovement.plant_id.is_(None) if loc is None else StockMovement.plant_id == loc)),
        ("Purchase Order Line", PurchaseOrderLine, (PurchaseOrderLine.product_id == pid,)),
        ("Stock Transfer Line", StockTransferLine, (StockTransferLine.product_id == pid,)),
        ("Customer Dispatch", CustomerDispatchLine, (CustomerDispatchLine.product_id == pid,)),
        ("Dispatch", DispatchLine, (DispatchLine.product_id == pid,)),
        ("Sales/Local Order", SalesOrderLine, (SalesOrderLine.product_id == pid,)),
        ("Production Order", ProductionOrder, (ProductionOrder.product_id == pid,)),
        ("Purchase Requirement", PurchaseRequirement, (PurchaseRequirement.product_id == pid,)),
    ]
    count = 0
    hits: list[str] = []
    for label, model, cond in T:
        n = db.scalar(select(func.count()).select_from(model).where(*cond))
        if n:
            count += int(n)
            hits.append(f"{label}")
    return count, hits


@router.patch("/{inv_id}", response_model=dict)
def update_inventory(inv_id: int, body: InventoryUpdate, db: Annotated[Session, Depends(get_db)],
                     user: AllStaff):
    """Edit an existing Inventory record.

    Quantity changes are reconciled through a single compensating StockMovement
    (never added on top of `current_stock`), so a change from 500 -> 700 yields
    700 and not 1200, and the movement history + Inventory balance always agree.
    """
    inv = get_or_404(db, Inventory, inv_id)
    product = get_or_404(db, Product, inv.product_id)
    has_movements = db.scalar(
        select(func.count()).select_from(StockMovement)
        .where(StockMovement.product_id == inv.product_id,
               StockMovement.plant_id.is_(None) if inv.plant_id is None
               else StockMovement.plant_id == inv.plant_id)
    ) or 0

    remarks = (body.remarks or "").strip() or f"Edit inventory #{inv_id}"

    # ---- Location / Product relocation: only safe when empty + unattached ----
    if body.plant_id is not None and body.plant_id != inv.plant_id:
        if has_movements or float(inv.current_stock or 0) != 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot relocate a row that already holds stock or has movement history. "
                       "Use Stock Transfer to move stock between locations.",
            )
        if body.plant_id and not db.get(Plant, body.plant_id):
            raise HTTPException(status_code=404, detail="Location not found")
        inv.plant_id = body.plant_id
    if body.product_id is not None and body.product_id != inv.product_id:
        if has_movements or float(inv.current_stock or 0) != 0:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot repoint a row that holds stock or has history. "
                       "Create a fresh inventory line for the other product.",
            )
        get_or_404(db, Product, body.product_id)
        inv.product_id = body.product_id
        product = db.get(Product, inv.product_id)

    # ---- Item Code / Description on the SAME Product (never duplicate) ----
    if body.item_code is not None or body.description is not None:
        new_code = body.item_code if body.item_code is not None else product.item_code
        new_code = (new_code or "").strip()
        new_model = (body.description if body.description is not None else product.model) or ""
        new_model = new_model.strip()
        if new_code or new_model:
            conflict = db.scalar(
                select(Product.id).where(Product.item_code == new_code,
                                         Product.id != product.id).limit(1)
            ) if new_code else None
            if conflict:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                                    detail=f"Item Code {new_code!r} is already used by another product.")
            if new_code:
                product.item_code = new_code
            model_name = new_model or product.model
            if (new_code or "") and model_name:
                product.model = model_name
            elif new_model:
                product.model = new_model

    # ---- Unit on the SAME Product ----
    if body.unit is not None and body.unit.strip():
        product.uom = body.unit.strip()

    # ---- Quantity reconcile (correct without double-count) ----
    if body.quantity is not None:
        new_qty = float(body.quantity)
        if new_qty < 0:
            raise HTTPException(status_code=400, detail="Quantity cannot be negative")
        cur = float(inv.current_stock or 0)
        delta = new_qty - cur
        if delta > 0:
            m = apply_movement(db, inv.product_id, MovementType.receipt, delta,
                               date.today(), ref_type="", ref_id=None,
                               remarks=remarks, plant_id=inv.plant_id)
        elif delta < 0:
            m = apply_movement(db, inv.product_id, MovementType.adjustment, -delta,
                               date.today(), ref_type="", ref_id=None,
                               remarks=remarks, plant_id=inv.plant_id)
        else:
            m = None
        if m:
            db.flush()
            refresh_reorder_alert(db, inv.product_id)

    if body.min_level is not None:
        inv.min_level = float(body.min_level)
    elif "min_level" in body.model_fields_set and body.min_level is None:
        inv.min_level = None

    db.commit()
    db.refresh(inv)
    write_audit(db, user, "UPDATE", "inventory", inv.id,
                f"Edited inventory line #{inv.id} (product {inv.product_id})")
    return _serialize_inv(inv)


@router.delete("/{inv_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_inventory(inv_id: int, db: Annotated[Session, Depends(get_db)],
                     user: ManagerOrAdmin):
    """Safely delete an Inventory record.

    Deletion is only allowed when the line is fully consumed (zero balance) AND
    not referenced by any business document or stock movement. This prevents
    orphaned movements and always keeps the Inventory balance consistent with
    the movement history.
    """
    inv = get_or_404(db, Inventory, inv_id)
    if float(inv.current_stock or 0) != 0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Cannot delete: this inventory line still holds "
                   f"{inv.current_stock:g} units. Consume or adjust it to zero first.",
        )
    count, hits = _row_refs(db, inv)
    if count:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Cannot delete: inventory line is referenced by {', '.join(hits)} "
                   f"({count} reference(s)).",
        )
    db.delete(inv)
    db.commit()
    write_audit(db, user, "DELETE", "inventory", inv_id, f"Deleted empty inventory line #{inv_id}")