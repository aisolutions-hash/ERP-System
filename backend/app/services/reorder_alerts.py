"""Reorder (low-stock) alert auto-generation for raw materials.

Reuses the existing Alert model + AlertType.stock_shortage so raw-material
MIN STOCK thresholds hook into the existing Alerts centre instead of building a
parallel alert system. The service:

  * creates exactly one OPEN alert per raw material when current stock < MIN stock
  * auto-resolves that alert once current stock >= MIN stock (or MIN is cleared)
  * never commits — callers own the transaction so alert state stays atomic
    with the stock-changing operation.
"""
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Alert, AlertPriority, AlertType, Inventory, Product, ProductCategory, RawMaterialBalance

ENTITY_TYPE = "raw_material"
ALERT_TYPE = AlertType.stock_shortage


def _current_and_min(db: Session, product_id: int) -> tuple[float | None, float | None]:
    """Latest MIN STOCK from raw_material_balances + current stock from Inventory."""
    b = db.scalars(
        select(RawMaterialBalance)
        .where(RawMaterialBalance.product_id == product_id)
        .order_by(RawMaterialBalance.report_date.desc())
        .limit(1)
    ).first()
    min_stock = b.min_stock if b else None
    inv = db.scalars(
        select(Inventory).where(Inventory.product_id == product_id, Inventory.plant_id.is_(None))
    ).first()
    current = inv.current_stock if inv else 0.0
    return (float(current or 0.0), float(min_stock) if min_stock is not None else None)


def _resolve_open(db: Session, product_id: int) -> None:
    now = datetime.now(timezone.utc)
    alerts = db.scalars(select(Alert).where(
        Alert.type == ALERT_TYPE,
        Alert.entity_type == ENTITY_TYPE,
        Alert.entity_id == product_id,
        Alert.status == "OPEN",
    )).all()
    for a in alerts:
        a.status = "RESOLVED"
        a.is_read = True
        a.resolved_at = now


def refresh_reorder_alert(db: Session, product_id: int, model_label: str = "") -> None:
    """Create / resolve the reorder alert for product_id.

    No-op for non-raw-material products. When MIN STOCK is not configured the
    product is not flagged (existing OPEN alerts are still cleaned up).
    """
    product = db.get(Product, product_id)
    if product is None or product.category != ProductCategory.raw_material:
        return
    current, min_stock = _current_and_min(db, product_id)
    label = product.model or model_label or f"material #{product_id}"

    if min_stock is None:
        _resolve_open(db, product_id)
        return

    if current < min_stock:
        existing = db.scalars(select(Alert).where(
            Alert.type == ALERT_TYPE,
            Alert.entity_type == ENTITY_TYPE,
            Alert.entity_id == product_id,
            Alert.status == "OPEN",
        ).order_by(Alert.id.desc()).limit(1)).first()
        if existing is None:
            db.add(Alert(
                type=ALERT_TYPE,
                priority=AlertPriority.high,
                message=(
                    f"Reorder required for {label}: current stock {current:g} "
                    f"is below MIN stock {min_stock:g}."
                ),
                entity_type=ENTITY_TYPE,
                entity_id=product_id,
                target_role="store",
            ))
    else:
        _resolve_open(db, product_id)