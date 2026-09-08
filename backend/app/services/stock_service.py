"""Centralised stock-effect helpers for stock-affecting documents.

Keeps Inventory balances and StockMovement history consistent when a
stock-affecting document (dispatch, production output, purchase receipt,
manual movement) is edited or deleted. Direction of a movement is derived
from `movement_type` exactly as the existing inline logic did:

    increment types (receipt, production_output):  current_stock += qty
    decrement types (issue, consumption, dispatch, adjustment, ...): current_stock -= qty

The previously duplicated get-or-create Inventory + arithmetic is replaced by
`apply_movement` so every caller shares one implementation.
"""
from typing import Optional

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..models import (
    Inventory, MovementType, Product, ProductCategory, ProductSourceType, StockMovement,
)


def _effect_for(movement_type: MovementType) -> int:
    """Return +1 (stock increases) or -1 (stock decreases) for a type."""
    if movement_type in (MovementType.receipt, MovementType.production_output):
        return 1
    return -1


def get_or_create_inventory(db: Session, product_id: int, plant_id: Optional[int] = None) -> Inventory:
    inv = db.scalars(select(Inventory).where(
        Inventory.product_id == product_id,
        Inventory.plant_id.is_(None) if plant_id is None else (Inventory.plant_id == plant_id),
    )).first()
    if inv is None:
        inv = Inventory(product_id=product_id, plant_id=plant_id,
                        opening_stock=0, received_qty=0, issued_qty=0, current_stock=0)
        db.add(inv)
        db.flush()
    return inv


def apply_movement(db: Session, product_id: int, movement_type: MovementType,
                   quantity: float, transaction_date, ref_type: str = "",
                   ref_id: Optional[int] = None, remarks: str = "",
                   plant_id: Optional[int] = None) -> StockMovement:
    """Apply a stock effect: update Inventory + record a StockMovement.

    `quantity` follows the existing convention (positive for normal
    entries; purchase-receive deltas may be negative). `plant_id` selects the
    location (NULL = Main Store, existing convention); callers that do not pass
    it keep the exact legacy behaviour.
    """
    sign = _effect_for(movement_type)
    inv = get_or_create_inventory(db, product_id, plant_id)
    if sign > 0:
        inv.received_qty = float(inv.received_qty or 0) + quantity
        inv.current_stock = float(inv.current_stock or 0) + quantity
    else:
        inv.issued_qty = float(inv.issued_qty or 0) + quantity
        inv.current_stock = float(inv.current_stock or 0) - quantity
    m = StockMovement(product_id=product_id, plant_id=plant_id,
                      movement_type=movement_type,
                      quantity=quantity, transaction_date=transaction_date,
                      ref_type=ref_type, ref_id=ref_id, remarks=remarks)
    db.add(m)
    db.flush()
    return m


def reverse_and_remove_ref(db: Session, ref_type: str, ref_id: Optional[int]) -> int:
    """Undo the inventory effect of every StockMovement for a reference and
    delete those movement records. Returns the number of movements reversed.

    The inverse of `apply_movement`: for a signed stored quantity it applies
    the exact opposite adjustment so net stock changes are fully removed.
    """
    movements = db.scalars(select(StockMovement).where(
        StockMovement.ref_type == ref_type,
        StockMovement.ref_id == ref_id,
    )).all()
    for m in movements:
        sign = _effect_for(m.movement_type)
        inv = get_or_create_inventory(db, m.product_id, m.plant_id)
        if sign > 0:
            inv.received_qty = float(inv.received_qty or 0) - m.quantity
            inv.current_stock = float(inv.current_stock or 0) - m.quantity
        else:
            inv.issued_qty = float(inv.issued_qty or 0) - m.quantity
            inv.current_stock = float(inv.current_stock or 0) + m.quantity
        db.delete(m)
    if movements:
        db.flush()
    return len(movements)


def reconvert_document(db: Session, ref_type: str, ref_id: Optional[int],
                       entries: list[tuple[int, MovementType, float, object, str, Optional[int]]]):
    """Reverse all existing stock effects for a reference, then re-apply the
    current document state so Inventory and StockMovement exactly match it.

    `entries` is a list of (product_id, movement_type, quantity, date, remarks)
    with an optional trailing plant_id (NULL = Main Store). Existing 5-tuple
    callers keep their current behaviour.
    """
    reverse_and_remove_ref(db, ref_type, ref_id)
    for entry in entries:
        product_id, movement_type, quantity, tdate, remarks = entry[:5]
        plant_id = entry[5] if len(entry) > 5 else None
        if product_id and quantity != 0:
            apply_movement(db, product_id, movement_type, quantity, tdate,
                           ref_type=ref_type, ref_id=ref_id, remarks=remarks,
                           plant_id=plant_id)


def resolve_or_create_product(db: Session, item_code: str,
                              description: str = "") -> Product | None:
    """Shared manual-product resolver for stock-trackable documents.

    Matches an existing Product keyed on (item_code, model); creates one lazily
    (category trading, source TRADING) when no match exists. Returns None when
    there is no Item Code so those lines stay untracked. Reuses the proven
    manual-purchase-item logic so transfers / dispatches behave identically.
    """
    ic = (item_code or "").strip()
    if not ic:
        return None
    name = (description or "").strip() or ic
    p = db.scalars(select(Product).where(
        Product.item_code == ic,
        Product.model == name,
    )).first()
    if p is None:
        p = Product(item_code=ic, model=name, name=name,
                    category=ProductCategory.trading, uom="Each",
                    source_type=ProductSourceType.trading, is_active=True)
        db.add(p)
        db.flush()
    return p