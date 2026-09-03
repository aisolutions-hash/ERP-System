"""Order Fulfilment Engine router (Phase 6G)."""
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..auth import CurrentUser, AllStaff
from ..crud import write_audit
from ..database import get_db
from ..models import (
    Customer, Dispatch, DispatchLine, Inventory, Product, ProductSourceType,
    SalesOrder, SalesOrderLine,
)
from ..schemas import FulfilmentIndicator
from ..services.business import fulfilment_for_line, inventory_map, upsert_purchase_requirement, ensure_alert, recompute_order_statuses

router = APIRouter(prefix="/fulfilment", tags=["fulfilment"])


@router.get("", response_model=dict)
def fulfilment_view(
    db: Annotated[Session, Depends(get_db)],
    _: CurrentUser,
    status: str = "",
    customer_id: int | None = None,
    product_id: int | None = None,
):
    """Evaluate every sales order line against stock & dispatch, applying the
    source_type decision logic (ready / production / purchase / manual)."""
    inv = inventory_map(db)
    # dispatch qty per order (order-level, same convention as orders.py)
    _d = select(
        Dispatch.sales_order_id,
        func.coalesce(func.sum(DispatchLine.quantity), 0).label("tot")
    ).join(DispatchLine, DispatchLine.dispatch_id == Dispatch.id)
    _d = _d.group_by(Dispatch.sales_order_id)
    disp_by_order = {oid: float(q or 0) for oid, q in db.execute(_d).all()}
    rows = db.execute(
        select(SalesOrder, SalesOrderLine)
        .join(SalesOrderLine, SalesOrderLine.order_id == SalesOrder.id)
        .join(Product, Product.id == SalesOrderLine.product_id, isouter=True)
        .order_by(SalesOrder.order_no)
    ).all()
    out = []
    for o, ln in rows:
        if not ln.product_id or ln.product is None:
            continue
        p = ln.product
        fulfilled = float(disp_by_order.get(o.id, 0.0) or 0.0)
        ordered = float(ln.quantity or 0)
        balance = ordered - fulfilled
        available = inv.get(p.id, 0.0)
        shortage = balance - available
        src = p.source_type
        src_val = src.value if src else "UNKNOWN"

        if balance <= 0:
            fstatus = "OVER_FULFILLED" if balance < 0 else "FULFILLED"
        elif available >= balance:
            fstatus = "READY_FOR_DISPATCH"
        elif src_val == "MANUFACTURED":
            fstatus = "PRODUCTION_REQUIRED"
        elif src_val == "TRADING":
            fstatus = "PURCHASE_REQUIRED"
        else:
            fstatus = "MANUAL_DECISION_REQUIRED"

        if status and fstatus != status:
            continue
        if customer_id and o.customer_id != customer_id:
            continue
        if product_id and ln.product_id != product_id:
            continue

        out.append({
            "sales_order_line_id": ln.id,
            "order_id": o.id,
            "order_no": o.order_no,
            "customer_id": o.customer_id,
            "customer": o.customer.name if o.customer else None,
            "product_id": p.id,
            "product_name": p.model,
            "item_code": p.item_code or "",
            "customer_po_no": ln.customer_po_no or o.customer_po_no or "",
            "source_type": src_val,
            "ordered_qty": ordered,
            "fulfilled_qty": fulfilled,
            "balance": round(balance, 4),
            "available_stock": round(available, 4),
            "shortage_qty": round(max(balance - available, 0), 4),
            "fulfilment_status": fstatus,
        })
    out.sort(key=lambda x: (x["fulfilment_status"], -x["shortage_qty"]))
    return {"items": out, "total": len(out)}


@router.post("/sync-requirements")
def sync_requirements(db: Annotated[Session, Depends(get_db)], user: AllStaff):
    """Reconcile purchase requirements + generate alerts for the current
    fulfilment state. Dedupe-safe (upserts existing open requirements)."""
    inv = inventory_map(db)
    _d = select(
        Dispatch.sales_order_id,
        func.coalesce(func.sum(DispatchLine.quantity), 0).label("tot")
    ).join(DispatchLine, DispatchLine.dispatch_id == Dispatch.id)
    _d = _d.group_by(Dispatch.sales_order_id)
    disp_by_order = {oid: float(q or 0) for oid, q in db.execute(_d).all()}
    rows = db.execute(
        select(SalesOrder, SalesOrderLine)
        .join(SalesOrderLine, SalesOrderLine.order_id == SalesOrder.id)
        .join(Product, Product.id == SalesOrderLine.product_id, isouter=True)
    ).all()
    created = 0
    alerts = 0
    for o, ln in rows:
        if not ln.product_id or ln.product is None:
            continue
        p = ln.product
        ordered = float(ln.quantity or 0)
        fulfilled = float(disp_by_order.get(o.id, 0.0) or 0.0)
        balance = ordered - fulfilled
        if balance <= 0:
            continue
        available = inv.get(p.id, 0.0)
        shortage = balance - available
        if shortage <= 0:
            continue
        src = p.source_type
        src_val = src.value if src else "UNKNOWN"
        if src_val == "MANUFACTURED":
            cat, rtype = "PRODUCTION", "RAW_MATERIAL"
        elif src_val == "TRADING":
            cat, rtype = "PURCHASE", "TRADING_PRODUCT"
        else:
            continue  # manual decision - do not auto-create transaction
        pr = upsert_purchase_requirement(
            db, product_id=p.id, required_qty=balance, available_qty=available,
            shortage_qty=shortage, category=cat, requirement_type=rtype,
            customer_id=o.customer_id, sales_order_id=o.id,
            sales_order_line_id=ln.id, source_type=src_val,
            notes=f"Shortage for {o.order_no}", commit=False,
        )
        if pr and getattr(pr, "_just_created", False):
            created += 1
    db.commit()

    # regenerate alerts from material requirement engine
    from .material_requirements import material_requirements_summary
    summary = material_requirements_summary(db, user)
    for agg in summary["rm_aggregate"]:
        if agg["shortage_quantity"] > 0:
            ensure_alert(
                db, "RAW_MATERIAL_SHORTAGE",
                f"Raw material shortage on {agg['raw_material_name']}: "
                f"req {agg['required_quantity']}, avail {agg['available_quantity']}, "
                f"short {agg['shortage_quantity']}",
                priority="HIGH", entity_type="raw_material",
                entity_id=agg["raw_material_id"], target_role="production",
            )
            alerts += 1
    db.commit()
    write_audit(db, user, "SYNC", "purchase_requirements", 0,
                f"Reconciled requirements ({created} new), {alerts} alerts")
    return {"ok": True, "requirements_created": created, "alerts_generated": alerts}


@router.post("/recompute-status")
def recompute_status(db: Annotated[Session, Depends(get_db)], user: AllStaff,
                     order_id: int | None = None):
    """Recompute sales order status lifecycle (6J) from real signals:
    New -> Confirmed -> In Production / On Purchase -> Ready -> Dispatched
    -> Completed / Cancelled. Only ever advances; never regresses terminal."""
    result = recompute_order_statuses(db, order_id=order_id)
    write_audit(db, user, "RECOMPUTE", "sales_orders", 0,
                f"Order status recompute: {result['changed']} changed / {result['scanned']} scanned")
    return {"ok": True, **result}
