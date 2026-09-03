"""Central business engines for Kalika ERP.

Contains:
  1. BOM / Material Requirement Engine (6C, 6D)
     Production requirement -> BOM -> material requirement -> RM shortage
  2. Order Fulfilment Engine (6G)
     For each sales order line: ordered vs dispatched -> balance -> stock check
     -> READY / PRODUCTION_REQUIRED / PURCHASE_REQUIRED / MANUAL_DECISION_REQUIRED
  3. Alert generation (6F) - shared helpers
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import (
    Alert, AlertPriority, AlertType, BillOfMaterial, Dispatch, DispatchLine,
    Inventory, OrderStatus, Product, ProductSourceType, PurchaseRequirement,
    SalesOrder, SalesOrderLine,
)


def inventory_map(db: Session) -> dict[int, float]:
    """product_id -> current stock (aggregated, default plant)."""
    rows = db.execute(
        select(Inventory.product_id, func.sum(Inventory.current_stock))
        .where(Inventory.plant_id.is_(None))
        .group_by(Inventory.product_id)
    ).all()
    return {pid: float(q or 0) for pid, q in rows}


def available_stock(db: Session, product_id: int) -> float:
    return inventory_map(db).get(product_id, 0.0)


def active_bom_map(db: Session) -> dict[int, list[BillOfMaterial]]:
    """product_id -> list of active BOM lines."""
    boms = (
        db.query(BillOfMaterial)
        .filter(BillOfMaterial.is_active == True)  # noqa: E712
        .all()
    )
    out: dict[int, list[BillOfMaterial]] = {}
    for b in boms:
        out.setdefault(b.product_id, []).append(b)
    return out


# ---------------------------------------------------------------------------
# 6C: Material Requirement Engine
# ---------------------------------------------------------------------------
def compute_material_requirements(
    db: Session,
    production_requirement: float,
    product_id: int,
    product_name: str = "",
) -> list[dict[str, Any]]:
    """Required RM = production_qty * BOM qty per unit. Compare vs available.
    Returns list of requirement dicts with status READY / SHORTAGE / NO_BOM.
    """
    inv = inventory_map(db)
    boms = active_bom_map(db).get(product_id, [])
    if not boms:
        return [{
            "product_id": product_id,
            "product_name": product_name,
            "production_quantity": production_requirement,
            "raw_material_id": None,
            "raw_material_name": "",
            "bom_quantity_per_unit": 0,
            "uom": "",
            "required_quantity": 0,
            "available_quantity": 0,
            "shortage_quantity": 0,
            "status": "NO_BOM",
        }]
    items = []
    for b in boms:
        rm = db.get(Product, b.raw_material_product_id)
        rm_name = rm.model if rm else "Unknown"
        required = production_requirement * b.quantity_per_unit
        available = inv.get(b.raw_material_product_id, 0.0)
        shortage = required - available
        status = "READY" if available >= required else "SHORTAGE"
        items.append({
            "product_id": product_id,
            "product_name": product_name,
            "production_quantity": production_requirement,
            "raw_material_id": b.raw_material_product_id,
            "raw_material_name": rm_name,
            "bom_quantity_per_unit": b.quantity_per_unit,
            "uom": b.uom,
            "required_quantity": round(required, 4),
            "available_quantity": round(available, 4),
            "shortage_quantity": round(max(shortage, 0), 4),
            "status": status,
        })
    return items


def production_material_readiness(db: Session, product_id: int) -> dict[str, Any]:
    """Readiness indicator for a product's production:
    🟢 ready / 🟠 shortage / 🔴 no bom.
    Omits production qty (uses BOM presence + RM availability only)."""
    boms = active_bom_map(db).get(product_id, [])
    if not boms:
        return {"product_id": product_id, "has_bom": False, "ready": False,
                "status": "NO_BOM", "label": "No BOM configured"}
    inv = inventory_map(db)
    for b in boms:
        available = inv.get(b.raw_material_product_id, 0.0)
        if available < b.quantity_per_unit * 1.0:
            return {"product_id": product_id, "has_bom": True, "ready": False,
                    "status": "SHORTAGE",
                    "label": f"Shortage on {b.raw_material_product_id}"}
    return {"product_id": product_id, "has_bom": True, "ready": True,
            "status": "READY", "label": "Ready"}


# ---------------------------------------------------------------------------
# 6G: Order Fulfilment Engine
# ---------------------------------------------------------------------------
def fulfilment_for_line(db: Session, line: SalesOrderLine, inv: dict[int, float] | None = None):
    """Decision for a single sales order line: ready / production / purchase / manual."""
    inv = inv or inventory_map(db)
    product = line.product
    if product is None:
        return None
    ordered = float(line.quantity or 0)
    fulfilled = float(line.dispatched_qty or 0) if hasattr(line, "dispatched_qty") else 0.0
    # fallback: compute fulfilled from dispatch optionally
    balance = ordered - fulfilled
    available = inv.get(product.id, 0.0)
    shortage = balance - available
    src = product.source_type
    src_val = src.value if src else "UNKNOWN"

    if balance <= 0:
        status = "FULFILLED" if balance == 0 else "OVER_FULFILLED"
        return {"status": status, "shortage": 0.0}

    if available >= balance:
        return {"status": "READY", "shortage": 0.0, "fulfilment_status": "READY_FOR_DISPATCH"}

    if src_val == "MANUFACTURED":
        return {"status": "PRODUCTION_REQUIRED", "shortage": shortage}
    if src_val == "TRADING":
        return {"status": "PURCHASE_REQUIRED", "shortage": shortage}
    return {"status": "MANUAL_DECISION_REQUIRED", "shortage": shortage}


# ---------------------------------------------------------------------------
# 6F: Alert helpers
# ---------------------------------------------------------------------------
def ensure_alert(
    db: Session,
    alert_type: str,
    message: str,
    priority: str = "MEDIUM",
    entity_type: str = "",
    entity_id: int | None = None,
    target_role: str = "",
) -> Alert | None:
    """Create a new OPEN alert unless an identical OPEN one already exists
    for the same type+entity (dedupe protection)."""
    existing = (
        db.query(Alert)
        .filter(Alert.status == "OPEN", Alert.type == alert_type,
                Alert.entity_type == entity_type, Alert.entity_id == entity_id)
        .first()
    )
    if existing:
        return existing
    alert = Alert(
        type=alert_type, priority=priority, message=message,
        entity_type=entity_type, entity_id=entity_id, target_role=target_role,
    )
    db.add(alert)
    db.commit()
    db.refresh(alert)
    return alert


def resolve_entity_alerts(db: Session, entity_type: str, entity_id: int):
    now = datetime.now(timezone.utc)
    db.query(Alert).filter(
        Alert.entity_type == entity_type,
        Alert.entity_id == entity_id,
        Alert.status == "OPEN",
    ).update({"status": "RESOLVED", "is_read": True, "resolved_at": now})
    db.commit()


def upsert_purchase_requirement(
    db: Session,
    *,
    product_id: int,
    required_qty: float,
    available_qty: float,
    shortage_qty: float,
    category: str,
    requirement_type: str = "TRADING_PRODUCT",
    customer_id: int | None = None,
    sales_order_id: int | None = None,
    sales_order_line_id: int | None = None,
    source_type: str = "",
    notes: str = "",
    commit: bool = True,
) -> PurchaseRequirement | None:
    """Create or reconcile a purchase requirement (dedup by product + line +
    type + open status). Returns None if shortage <= 0 (no requirement).
    Newly-created rows are flagged with attribute _just_created = True."""
    if shortage_qty <= 0:
        return None
    pr = None
    q = db.query(PurchaseRequirement).filter(
        PurchaseRequirement.product_id == product_id,
        PurchaseRequirement.requirement_type == requirement_type,
        PurchaseRequirement.status == "Pending",
    )
    if sales_order_line_id:
        q = q.filter(PurchaseRequirement.sales_order_line_id == sales_order_line_id)
    pr = q.order_by(PurchaseRequirement.id.desc()).first()
    if pr is None:
        pr = PurchaseRequirement(
            product_id=product_id,
            customer_id=customer_id,
            sales_order_id=sales_order_id,
            sales_order_line_id=sales_order_line_id,
            required_qty=0.0,
            available_qty=0.0,
            shortage_qty=0.0,
            category=category,
            requirement_type=requirement_type,
            source_type=source_type,
        )
        pr._just_created = True
        db.add(pr)
    pr.required_qty = required_qty
    pr.available_qty = available_qty
    pr.shortage_qty = shortage_qty
    if notes:
        pr.notes = notes
    if commit:
        db.commit()
        db.refresh(pr)
    return pr


# ---------------------------------------------------------------------------
# 6J: Automatic Order Status Lifecycle
# ---------------------------------------------------------------------------
# OrderStatus progression: New -> Confirmed -> In Production / On Purchase
#   -> Ready -> Dispatched -> Completed / Over-fulfilled / Cancelled
#
# "On Purchase" is stored via OrderStatus.confirmed (awaiting purchased goods);
# it is surfaced distinctly in recompute results and UI labels.
_ORDINAL = {
    OrderStatus.new: 0,
    OrderStatus.confirmed: 1,  # also represents "On Purchase" while awaiting stock
    OrderStatus.in_production: 1,
    OrderStatus.ready: 2,
    OrderStatus.dispatched: 3,
    OrderStatus.completed: 4,
    OrderStatus.cancelled: 5,
}


def _dispatch_by_order(db: Session) -> dict[int, float]:
    stmt = (
        select(Dispatch.sales_order_id, func.coalesce(func.sum(DispatchLine.quantity), 0))
        .join(DispatchLine, DispatchLine.dispatch_id == Dispatch.id)
        .group_by(Dispatch.sales_order_id)
    )
    return {oid: float(q or 0) for oid, q in db.execute(stmt).all()}


def _line_decision(src_val: str, balance: float, available: float) -> str:
    """Map a single order line to the most advanced lifecycle step it requires."""
    if balance <= 0:
        return "completed"  # fully (or over) fulfilled
    if available >= balance:
        return "ready"
    if src_val == "MANUFACTURED":
        return "in_production"
    if src_val == "TRADING":
        return "on_purchase"
    return "confirmed"  # manual decision needed


def _order_status_from_lines(lines: list[dict], dispatches: dict[int, float]) -> OrderStatus:
    """Aggregate per-line decisions into the single most advanced status."""
    if not lines:
        return OrderStatus.new
    decides = [ln["decision"] for ln in lines]
    if any(d == "cancelled" for d in decides):
        return OrderStatus.cancelled
    total_ordered = sum(float(ln["ordered"]) for ln in lines)
    total_dispatched = sum(float(dispatches.get(ln["order_id"], 0)) for ln in lines)
    if total_ordered > 0 and total_dispatched >= total_ordered:
        # complete / possibly over-fulfilled
        return OrderStatus.dispatched if total_dispatched == total_ordered else OrderStatus.completed
    # Not complete. Pick the furthest-progressed open line.
    if any(d == "ready" for d in decides):
        return OrderStatus.ready
    if any(d == "on_purchase" for d in decides):
        return OrderStatus.confirmed  # On Purchase
    if any(d == "in_production" for d in decides):
        return OrderStatus.in_production
    return OrderStatus.confirmed


def recompute_order_statuses(
    db: Session,
    order_id: int | None = None,
    commit: bool = True,
) -> dict:
    """Recompute sales order status from real business signals.

    Never regresses a terminal status (completed / cancelled). Returns counts
    of orders whose status changed.
    """
    inv = inventory_map(db)
    disp = _dispatch_by_order(db)

    stmt = (
        select(SalesOrder, SalesOrderLine)
        .join(SalesOrderLine, SalesOrderLine.order_id == SalesOrder.id)
        .join(Product, Product.id == SalesOrderLine.product_id, isouter=True)
    )
    if order_id is not None:
        stmt = stmt.where(SalesOrder.id == order_id)

    by_order: dict[int, list] = {}
    order_map: dict[int, SalesOrder] = {}
    for o, ln in db.execute(stmt).all():
        order_map.setdefault(o.id, o)
        if ln.product is None:
            continue
        p = ln.product
        ordered = float(ln.quantity or 0)
        balance = ordered - float(disp.get(o.id, 0.0))
        available = inv.get(p.id, 0.0)
        src_val = (p.source_type.value if p.source_type else "UNKNOWN")
        decision = _line_decision(src_val, balance, available)
        by_order.setdefault(o.id, []).append({
            "order_id": o.id, "ordered": ordered,
            "line_status": decision, "decision": decision,
            "product_id": p.id, "product": p.model,
        })

    changed = 0
    for oid, lines in by_order.items():
        o = order_map[oid]
        if o.status in (OrderStatus.completed, OrderStatus.cancelled):
            continue  # terminal - never regress
        new_status = _order_status_from_lines(lines, disp)
        if _ORDINAL.get(new_status, 0) > _ORDINAL.get(o.status, 0):
            old = o.status
            o.status = new_status
            changed += 1
            db.add(o)

    if commit:
        db.commit()
    return {"changed": changed, "scanned": len(by_order)}
