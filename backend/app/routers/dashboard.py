"""Dashboard analytics: KPIs, trends, and charts.

Phase 7 additions:
  - /sales-by-customer      → top customers by dispatch value (marketing)
  - /sales-by-salesperson   → salesperson leaderboard
  - /category-breakdown     → dispatch / production mix by category
  - /order-type-mix         → OEM vs TRADING vs LOCAL mix
  - /top-products           → top-selling products (sales & marketing signal)
  - /revenue-trend          → daily revenue (dispatch value) trend
  - /open-pipeline-value    → total open-order value by status
  - /scanner-activity       → scan volume (powered by /barcodes/scan-events/analytics)
"""
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..auth import CurrentUser
from ..database import get_db
from ..models import (
    Customer, Dispatch, DispatchLine, Inventory, OrderStatus, OrderType,
    Plant, Product, ProductCategory, ProductionMovement, ProductionOrder,
    PurchaseOrder, RawMaterialBalance, SalesOrder, Salesperson, Supplier,
)
from datetime import date, datetime, timedelta

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


@router.get("/summary")
def summary(
    db: Annotated[Session, Depends(get_db)],
    _: CurrentUser,
    report_date: str = "",
):
    rd = date.fromisoformat(report_date) if report_date else date.today()

    total_orders = db.scalar(select(func.count()).select_from(SalesOrder)) or 0
    new_today = db.scalar(select(func.count()).select_from(SalesOrder).where(SalesOrder.order_date == rd)) or 0
    pending = db.scalar(select(func.count()).select_from(SalesOrder).where(
        SalesOrder.status.in_([OrderStatus.new, OrderStatus.confirmed]))) or 0
    in_production = db.scalar(select(func.count()).select_from(SalesOrder).where(
        SalesOrder.status == OrderStatus.in_production)) or 0
    ready = db.scalar(select(func.count()).select_from(SalesOrder).where(
        SalesOrder.status == OrderStatus.ready)) or 0
    dispatched = db.scalar(select(func.count()).select_from(SalesOrder).where(
        SalesOrder.status == OrderStatus.dispatched)) or 0
    completed = db.scalar(select(func.count()).select_from(SalesOrder).where(
        SalesOrder.status == OrderStatus.completed)) or 0
    order_value = db.scalar(select(func.coalesce(func.sum(SalesOrder.total_value), 0)).select_from(SalesOrder)) or 0

    rm_count = db.scalar(select(func.count()).select_from(Product).where(Product.category == ProductCategory.raw_material)) or 0
    rm_balance = db.scalar(select(func.coalesce(func.sum(RawMaterialBalance.balance_qty), 0)).select_from(RawMaterialBalance)) or 0
    rm_stock = db.scalar(select(func.coalesce(func.sum(Inventory.current_stock), 0)).select_from(
        Inventory).where(Inventory.plant_id.is_(None))) or 0

    inv_rows = db.scalars(select(Inventory)).all()
    low = sum(1 for i in inv_rows if i.min_level is not None and 0 < i.current_stock < i.min_level)
    oos = sum(1 for i in inv_rows if i.min_level is not None and i.current_stock <= 0)

    prod = db.scalars(select(ProductionOrder)).all()
    planned = sum(o.schedule_qty for o in prod)
    produced = sum(o.produced_qty for o in prod)
    prod_pending = sum(o.balance_qty for o in prod)

    po_count = db.scalar(select(func.count()).select_from(PurchaseOrder)) or 0
    po_value = db.scalar(select(func.coalesce(func.sum(PurchaseOrder.total_amount), 0)).select_from(PurchaseOrder)) or 0

    disp = db.scalars(select(Dispatch)).all()
    disp_sched = sum(d.schedule_qty for d in disp)
    disp_done = sum(d.dispatched_qty for d in disp)
    disp_pending = sum(d.balance_qty for d in disp)

    supplier_count = db.scalar(select(func.count()).select_from(Supplier)) or 0
    customer_count = db.scalar(select(func.count()).select_from(Customer)) or 0
    plant_count = db.scalar(select(func.count()).select_from(Plant)) or 0
    product_count = db.scalar(select(func.count()).select_from(Product)) or 0
    store_items = db.scalar(select(func.count()).select_from(Product).where(Product.category == ProductCategory.store)) or 0

    # Phase 7: sales / marketing KPI additions
    open_pipeline_value = db.scalar(
        select(func.coalesce(func.sum(SalesOrder.total_value), 0))
        .where(SalesOrder.status.in_([
            OrderStatus.new, OrderStatus.confirmed, OrderStatus.in_production,
            OrderStatus.ready, OrderStatus.dispatched,
        ]))
    ) or 0
    dispatched_revenue = db.scalar(
        select(func.coalesce(func.sum(SalesOrder.total_value), 0))
        .where(SalesOrder.status.in_([OrderStatus.dispatched, OrderStatus.completed]))
    ) or 0

    return {
        "report_date": rd.isoformat(),
        "total_orders": total_orders, "new_orders_today": new_today, "pending_orders": pending,
        "completed_orders": completed, "orders_in_production": in_production,
        "ready_to_dispatch": ready, "orders_dispatched": dispatched, "order_value": float(order_value),
        "raw_material_count": rm_count, "raw_material_stock": float(rm_stock),
        "raw_material_balance": float(rm_balance),
        "low_stock_items": low, "out_of_stock_items": oos,
        "production_planned_qty": planned, "production_produced_qty": produced,
        "production_pending_qty": prod_pending,
        "purchase_count": po_count, "purchase_value": float(po_value),
        "dispatch_scheduled": disp_sched, "dispatch_done": disp_done, "dispatch_pending": disp_pending,
        "supplier_count": supplier_count, "customer_count": customer_count,
        "plant_count": plant_count, "product_count": product_count, "store_items": store_items,
        # New sales / marketing KPIs
        "open_pipeline_value": float(open_pipeline_value),
        "dispatched_revenue": float(dispatched_revenue),
        "fulfilment_pct": round(
            (dispatched_revenue / (dispatched_revenue + open_pipeline_value)) * 100, 2
        ) if (dispatched_revenue + open_pipeline_value) > 0 else 0.0,
    }


@router.get("/dispatch-by-plant")
def dispatch_by_plant(db: Annotated[Session, Depends(get_db)], _: CurrentUser):
    rows = db.scalars(select(Dispatch)).all()
    by = {}
    for d in rows:
        key = d.plant.name if d.plant else (d.customer.name if d.customer else "Unknown")
        e = by.setdefault(key, {"scheduled": 0.0, "dispatched": 0.0, "pending": 0.0})
        e["scheduled"] += d.schedule_qty
        e["dispatched"] += d.dispatched_qty
        e["pending"] += d.balance_qty
    items = [{"plant": k, **v} for k, v in sorted(by.items(), key=lambda x: -x[1]["scheduled"])]
    return {"items": items}


@router.get("/production-by-product")
def production_by_product(db: Annotated[Session, Depends(get_db)], _: CurrentUser):
    rows = db.scalars(select(ProductionOrder)).all()
    by = {}
    for o in rows:
        name = o.product.model if o.product else o.section or "Unknown"
        e = by.setdefault(name, {"planned": 0.0, "produced": 0.0, "pending": 0.0})
        e["planned"] += o.schedule_qty
        e["produced"] += o.produced_qty
        e["pending"] += o.balance_qty
    items = [{"product": k, **v} for k, v in sorted(by.items(), key=lambda x: -x[1]["produced"])]
    return {"items": items}


@router.get("/order-pipeline")
def order_pipeline(db: Annotated[Session, Depends(get_db)], _: CurrentUser):
    statuses = [s.value for s in OrderStatus]
    counts = {s: 0 for s in statuses}
    for s, c in db.execute(select(SalesOrder.status, func.count()).group_by(SalesOrder.status)).all():
        counts[s.value] = c
    return {"items": [{"status": s, "count": counts[s]} for s in statuses]}


@router.get("/inventory-status")
def inventory_status(db: Annotated[Session, Depends(get_db)], _: CurrentUser):
    rows = db.scalars(select(Inventory)).all()
    ok = low = oos = 0
    for i in rows:
        if i.min_level is None:
            ok += 1
        elif i.current_stock <= 0:
            oos += 1
        elif i.current_stock < i.min_level:
            low += 1
        else:
            ok += 1
    return {"items": [
        {"status": "Healthy", "count": ok},
        {"status": "Low Stock", "count": low},
        {"status": "Out of Stock", "count": oos},
    ]}


@router.get("/raw-material-stock")
def raw_material_stock(db: Annotated[Session, Depends(get_db)], _: CurrentUser):
    rows = db.scalars(select(RawMaterialBalance)).all()
    items = []
    for b in rows:
        items.append({
            "material": b.product.model if b.product else "?",
            "schedule": b.schedule_qty or 0, "inward": b.inward_qty or 0,
            "balance": b.balance_qty or 0, "opening": b.opening_stock or 0,
        })
    return {"items": items}


@router.get("/daily-trends")
def daily_trends(db: Annotated[Session, Depends(get_db)], _: CurrentUser,
                 days: int = Query(30, ge=7, le=180)):
    """Daily dispatch + production + revenue trends."""
    d_rows = db.execute(
        select(DispatchLine.dispatch_date, func.sum(DispatchLine.quantity))
        .group_by(DispatchLine.dispatch_date).order_by(DispatchLine.dispatch_date)
    ).all()
    p_rows = db.execute(
        select(ProductionMovement.production_date, func.sum(ProductionMovement.quantity))
        .group_by(ProductionMovement.production_date).order_by(ProductionMovement.production_date)
    ).all()
    by = {}
    for dd, q in d_rows:
        by.setdefault(dd.isoformat(), {"dispatch": 0.0, "production": 0.0, "revenue": 0.0})["dispatch"] += float(q)
    for pd, q in p_rows:
        by.setdefault(pd.isoformat(), {"dispatch": 0.0, "production": 0.0, "revenue": 0.0})["production"] += float(q)
    # Revenue from DispatchLine.rate * quantity
    rev_rows = db.execute(
        select(DispatchLine.dispatch_date,
               func.coalesce(func.sum(DispatchLine.rate * DispatchLine.quantity), 0))
        .group_by(DispatchLine.dispatch_date)
    ).all()
    for dd, r in rev_rows:
        by.setdefault(dd.isoformat(), {"dispatch": 0.0, "production": 0.0, "revenue": 0.0})["revenue"] += float(r)
    items = [{"date": k, **v} for k, v in sorted(by.items())][-days:]
    return {"items": items, "days": days}


@router.get("/low-stock-list")
def low_stock_list(db: Annotated[Session, Depends(get_db)], _: CurrentUser, limit: int = 10):
    rows = db.scalars(select(Inventory)).all()
    items = []
    for i in rows:
        if i.min_level is not None and i.current_stock < i.min_level:
            items.append({
                "product": i.product.model if i.product else "?",
                "item_code": i.product.item_code if i.product else "",
                "current_stock": i.current_stock, "min_level": i.min_level,
                "plant": i.plant.name if i.plant else "Main Store",
                "status": "OUT_OF_STOCK" if i.current_stock <= 0 else "LOW",
            })
    items.sort(key=lambda x: x["current_stock"])
    return {"items": items[:limit]}


# ============================================================================
# PHASE 7: SALES & MARKETING ANALYTICS
# ============================================================================

@router.get("/sales-by-customer")
def sales_by_customer(db: Annotated[Session, Depends(get_db)], _: CurrentUser,
                      days: int = Query(90, ge=1, le=365), limit: int = Query(10, ge=1, le=50)):
    """Top customers by dispatch value (last N days).

    Powers: customer leaderboard, account-management prioritisation,
    marketing campaign targeting."""
    since = date.today() - timedelta(days=days)
    # Sum DispatchLine.quantity * rate per customer
    rows = db.execute(
        select(
            Customer.id, Customer.name, Customer.code,
            func.coalesce(func.sum(DispatchLine.quantity), 0).label("qty"),
            func.coalesce(func.sum(DispatchLine.rate * DispatchLine.quantity), 0).label("revenue"),
            func.count(func.distinct(Dispatch.id)).label("dispatches"),
        )
        .join(Dispatch, Dispatch.customer_id == Customer.id)
        .join(DispatchLine, DispatchLine.dispatch_id == Dispatch.id)
        .where(Dispatch.dispatch_date >= since)
        .group_by(Customer.id, Customer.name, Customer.code)
        .order_by(func.coalesce(func.sum(DispatchLine.rate * DispatchLine.quantity), 0).desc())
        .limit(limit)
    ).all()
    items = [
        {
            "customer_id": r.id, "customer": r.name, "code": r.code,
            "qty": float(r.qty or 0),
            "revenue": float(r.revenue or 0),
            "dispatches": int(r.dispatches or 0),
        }
        for r in rows
    ]
    return {"items": items, "days": days, "total_customers_shown": len(items)}


@router.get("/sales-by-salesperson")
def sales_by_salesperson(db: Annotated[Session, Depends(get_db)], _: CurrentUser,
                         days: int = Query(90, ge=1, le=365)):
    """Salesperson leaderboard — qty dispatched + revenue per owner."""
    since = date.today() - timedelta(days=days)
    rows = db.execute(
        select(
            Salesperson.id, Salesperson.name,
            func.coalesce(func.sum(DispatchLine.quantity), 0).label("qty"),
            func.coalesce(func.sum(DispatchLine.rate * DispatchLine.quantity), 0).label("revenue"),
            func.count(func.distinct(Dispatch.id)).label("dispatches"),
        )
        .join(Dispatch, Dispatch.salesperson_id == Salesperson.id)
        .join(DispatchLine, DispatchLine.dispatch_id == Dispatch.id)
        .where(Dispatch.dispatch_date >= since)
        .group_by(Salesperson.id, Salesperson.name)
        .order_by(func.coalesce(func.sum(DispatchLine.rate * DispatchLine.quantity), 0).desc())
    ).all()
    items = [
        {
            "salesperson_id": r.id, "name": r.name,
            "qty": float(r.qty or 0),
            "revenue": float(r.revenue or 0),
            "dispatches": int(r.dispatches or 0),
        }
        for r in rows
    ]
    return {"items": items, "days": days}


@router.get("/category-breakdown")
def category_breakdown(db: Annotated[Session, Depends(get_db)], _: CurrentUser):
    """Dispatch + production mix by product category. Useful for SKU rationalisation."""
    rows = db.execute(
        select(
            Product.category,
            func.coalesce(func.sum(DispatchLine.quantity), 0).label("dispatched_qty"),
            func.count(func.distinct(DispatchLine.id)).label("dispatch_lines"),
        )
        .join(DispatchLine, DispatchLine.product_id == Product.id, isouter=True)
        .group_by(Product.category)
    ).all()
    items = [
        {
            "category": r.category.value if r.category else "unknown",
            "dispatched_qty": float(r.dispatched_qty or 0),
            "dispatch_lines": int(r.dispatch_lines or 0),
        }
        for r in rows
    ]
    return {"items": items}


@router.get("/order-type-mix")
def order_type_mix(db: Annotated[Session, Depends(get_db)], _: CurrentUser):
    """Order count + value by type (OEM / TRADING / MANUFACTURING / LOCAL).

    Drives marketing campaign targeting (e.g., focus on TRADING repeat buyers)."""
    types = [t.value for t in OrderType]
    counts = {t: {"count": 0, "value": 0.0} for t in types}
    rows = db.execute(
        select(SalesOrder.order_type,
               func.count().label("c"),
               func.coalesce(func.sum(SalesOrder.total_value), 0).label("v"))
        .group_by(SalesOrder.order_type)
    ).all()
    for r in rows:
        if r.order_type:
            counts[r.order_type.value] = {"count": int(r.c), "value": float(r.v)}
    return {"items": [{"type": k, **v} for k, v in counts.items()]}


@router.get("/top-products")
def top_products(db: Annotated[Session, Depends(get_db)], _: CurrentUser,
                 days: int = Query(90, ge=1, le=365), limit: int = Query(10, ge=1, le=50)):
    """Top-selling products by dispatched qty + revenue (sales & marketing signal)."""
    since = date.today() - timedelta(days=days)
    rows = db.execute(
        select(
            Product.id, Product.item_code, Product.model, Product.category,
            func.coalesce(func.sum(DispatchLine.quantity), 0).label("qty"),
            func.coalesce(func.sum(DispatchLine.rate * DispatchLine.quantity), 0).label("revenue"),
            func.coalesce(func.sum(DispatchLine.weight), 0).label("weight_kg"),
        )
        .join(DispatchLine, DispatchLine.product_id == Product.id)
        .join(Dispatch, DispatchLine.dispatch_id == Dispatch.id)
        .where(Dispatch.dispatch_date >= since)
        .group_by(Product.id, Product.item_code, Product.model, Product.category)
        .order_by(func.coalesce(func.sum(DispatchLine.quantity), 0).desc())
        .limit(limit)
    ).all()
    items = [
        {
            "product_id": r.id, "item_code": r.item_code, "model": r.model,
            "category": r.category.value if r.category else None,
            "qty": float(r.qty or 0),
            "revenue": float(r.revenue or 0),
            "weight_kg": float(r.weight_kg or 0),
        }
        for r in rows
    ]
    return {"items": items, "days": days}


@router.get("/open-pipeline-value")
def open_pipeline_value(db: Annotated[Session, Depends(get_db)], _: CurrentUser):
    """Open-order value broken down by status — directly visible to sales managers."""
    statuses = [OrderStatus.new, OrderStatus.confirmed, OrderStatus.in_production,
                OrderStatus.ready, OrderStatus.dispatched, OrderStatus.completed]
    items = []
    for s in statuses:
        v = db.scalar(
            select(func.coalesce(func.sum(SalesOrder.total_value), 0))
            .where(SalesOrder.status == s)
        ) or 0
        c = db.scalar(select(func.count()).select_from(SalesOrder).where(SalesOrder.status == s)) or 0
        items.append({"status": s.value, "count": int(c), "value": float(v)})
    return {"items": items}


@router.get("/revenue-trend")
def revenue_trend(db: Annotated[Session, Depends(get_db)], _: CurrentUser,
                  days: int = Query(60, ge=14, le=365)):
    """Daily dispatch revenue trend (DispatchLine.rate * quantity)."""
    since = date.today() - timedelta(days=days)
    rows = db.execute(
        select(DispatchLine.dispatch_date.label("d"),
               func.coalesce(func.sum(DispatchLine.rate * DispatchLine.quantity), 0).label("revenue"),
               func.coalesce(func.sum(DispatchLine.quantity), 0).label("qty"),
               func.coalesce(func.sum(DispatchLine.weight), 0).label("weight"))
        .where(DispatchLine.dispatch_date >= since)
        .group_by(DispatchLine.dispatch_date)
        .order_by(DispatchLine.dispatch_date)
    ).all()
    items = [{"date": r.d.isoformat(), "revenue": float(r.revenue or 0),
              "qty": float(r.qty or 0), "weight_kg": float(r.weight or 0)} for r in rows]
    total = round(sum(i["revenue"] for i in items), 2)
    return {"items": items, "days": days, "total_revenue": total}


@router.get("/fulfilment-health")
def fulfilment_health(db: Annotated[Session, Depends(get_db)], _: CurrentUser):
    """One-shot health card for sales dashboard:
       - Open orders count + value
       - In-production count + value
       - Ready-to-dispatch count + value
       - Stuck orders (>14 days in current status)
    """
    from sqlalchemy import or_
    fourteen_ago = date.today() - timedelta(days=14)
    stuck = db.scalar(
        select(func.count()).select_from(SalesOrder)
        .where(or_(
            (SalesOrder.order_date <= fourteen_ago) & (SalesOrder.status.in_([
                OrderStatus.new, OrderStatus.confirmed,
            ])),
            (SalesOrder.order_date <= fourteen_ago) & (SalesOrder.status == OrderStatus.in_production),
        ))
    ) or 0
    groups = {
        "open": [OrderStatus.new, OrderStatus.confirmed],
        "in_production": [OrderStatus.in_production],
        "ready": [OrderStatus.ready],
        "dispatched": [OrderStatus.dispatched],
    }
    out = {}
    for k, statuses in groups.items():
        c = db.scalar(select(func.count()).select_from(SalesOrder)
                      .where(SalesOrder.status.in_(statuses))) or 0
        v = db.scalar(select(func.coalesce(func.sum(SalesOrder.total_value), 0))
                      .where(SalesOrder.status.in_(statuses))) or 0
        out[k] = {"count": int(c), "value": float(v)}
    return {"groups": out, "stuck_orders": int(stuck)}