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
from uuid import uuid4

from fastapi import HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..models import (
    Inventory, MovementType, Product, ProductCategory, ProductSourceType, StockMovement,
)


def _effect_for(movement_type: MovementType) -> int:
    """Return +1 (stock increases) or -1 (stock decreases) for a type."""
    if movement_type in (MovementType.receipt, MovementType.production_output):
        return 1
    return -1


def get_or_create_inventory(db: Session, product_id: int, plant_id: Optional[int] = None,
                            lock: bool = True) -> Inventory:
    """Return the Inventory row for (product_id, plant_id), creating it if needed.

    With `lock=True` (default, used by every stock-affecting write path) the row
    is read with `SELECT ... FOR UPDATE`, so the check-and-mutate sequence in a
    caller runs inside the SAME database transaction and concurrent stock-outs
    for the same product/location are serialised (the row lock is held until the
    transaction commits or rolls back). plant_id NULL = Main Store.

    Creation is safe under concurrency: uniqueness is enforced by the
    uq_inventory_product_plant (non-NULL plant) and uq_inventory_product_main
    (NULL plant) indexes; on a unique-violation race the transaction retries the
    read inside a savepoint instead of silently duplicating a row.
    """
    cond = (Inventory.plant_id.is_(None) if plant_id is None
            else Inventory.plant_id == plant_id)
    stmt = select(Inventory).where(Inventory.product_id == product_id, cond)
    if lock:
        stmt = stmt.with_for_update()
    inv = db.scalars(stmt).first()
    if inv is not None:
        return inv
    try:
        with db.begin_nested():
            inv = Inventory(product_id=product_id, plant_id=plant_id,
                            opening_stock=0, received_qty=0, issued_qty=0, current_stock=0)
            db.add(inv)
            db.flush()
        return inv
    except IntegrityError:
        # A concurrent transaction created the same row first; read it now.
        inv = db.scalars(stmt).first()
        if inv is not None:
            return inv
        raise


def ensure_available_stock(db: Session, product_id: int, plant_id: Optional[int],
                           required_qty: float = 0.0, *, context: str = "stock out") -> Inventory:
    """Locked availability guard for a stock OUT operation.

    Locks the (product_id, plant_id) Inventory row, verifies `required_qty` can
    be taken, and raises HTTP 400 (with the available amount) when it cannot.
    Because the row is locked with FOR UPDATE and the caller applies the effect
    in the same transaction, a rejected request leaves NO partial database
    write and a concurrent request cannot observe the stale balance. Returns the
    locked row so the caller can mutate it (check + mutation are atomic).
    """
    inv = get_or_create_inventory(db, product_id, plant_id)
    available = float(inv.current_stock or 0)
    if float(required_qty or 0) > available:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(f"Cannot {context}: requested {float(required_qty):g}, "
                    f"available stock: {available:g}."),
        )
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


def _unique_blank_model(db: Session, name: str) -> str:
    """Pick an unused `model` for a blank-item-code Product.

    Searches across all products so two same-description items never share a
    model (they are distinct records tracked by internal ID, never merged).
    """
    base = name[:470]
    if not db.scalar(select(Product.id).where(Product.model == base).limit(1)):
        return base
    for n in range(2, 301):
        candidate = f"{base} (#{n})"
        if not db.scalar(select(Product.id).where(Product.model == candidate).limit(1)):
            return candidate
    return f"{base} ({uuid4().hex[:8]})"


def resolve_or_create_product(db: Session, item_code: str,
                              description: str = "",
                              allow_blank: bool = False) -> Product | None:
    """Shared manual-product resolver for stock-trackable documents.

    Matches an existing Product keyed on (item_code, model); creates one lazily
    (category trading, source TRADING) when no match exists. When `allow_blank`
    is set, a line with no Item Code but with a description is given its own
    fresh Product (unique internal ID) so stock can still be tracked — the
    resolver never merges two blank-code lines by description. Returns None only
    when there is genuinely nothing to key on (no Item Code AND `allow_blank`
    with no description, or no Item Code with `allow_blank` unset), keeping
    dispatch / stock-flow behaviour unchanged.
    """
    ic = (item_code or "").strip()
    if not ic:
        if not allow_blank:
            return None
        name = (description or "").strip()
        if not name:
            return None
        model = _unique_blank_model(db, name)
        p = Product(item_code="", model=model, name=name,
                    category=ProductCategory.trading, uom="Each",
                    source_type=ProductSourceType.trading, is_active=True)
        db.add(p)
        db.flush()
        return p
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