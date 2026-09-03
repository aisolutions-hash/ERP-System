"""Material Requirement Engine UI router (Phase 6C/6D).

Combines production requirements (from plans + production orders) with the
BOM to compute required RM, available RM, shortage RM, and status.
"""
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import CurrentUser
from ..database import get_db
from ..models import (
    BillOfMaterial, Inventory, Plan, PlanType, Product, ProductCategory,
    ProductionOrder,
)
from ..services.business import (
    active_bom_map, compute_material_requirements,
    inventory_map, production_material_readiness,
)
from ..services.migration_v2 import product_family

router = APIRouter(prefix="/material-requirements", tags=["material-requirements"])


def _production_requirement_sources(db: Session):
    """Gather production requirements from production plans + orders."""
    sources = []
    plans = (
        db.query(Plan)
        .filter(Plan.plan_type == PlanType.production)
        .all()
    )
    for p in plans:
        if not p.product_id:
            continue
        sources.append({
            "kind": "plan", "id": p.id, "product_id": p.product_id,
            "product_name": p.model, "quantity": float(p.quantity or 0),
            "owner": p.owner, "date": p.plan_date, "customer_id": p.customer_id,
            "customer": p.customer.name if p.customer else None,
        })
    orders = db.query(ProductionOrder).all()
    for o in orders:
        if not o.product_id:
            continue
        sources.append({
            "kind": "order", "id": o.id, "product_id": o.product_id,
            "product_name": o.order_no, "quantity": float(o.schedule_qty or 0),
            "owner": "", "date": o.report_date, "customer_id": o.customer_id,
            "customer": o.customer.name if o.customer else None,
        })
    return sources


@router.get("/summary")
def material_requirements_summary(
    db: Annotated[Session, Depends(get_db)],
    _: CurrentUser = None,
    status: str = "",
    product_id: int | None = None,
):
    """Aggregate requirement across all production sources per RM."""
    inv = inventory_map(db)
    boms = active_bom_map(db)
    sources = _production_requirement_sources(db)
    by_rm: dict[int, dict] = {}
    results = []
    for s in sources:
        if product_id and s["product_id"] != product_id:
            continue
        product_boms = boms.get(s["product_id"], [])
        if not product_boms:
            results.append({
                "product_id": s["product_id"],
                "product_name": s["product_name"],
                "production_quantity": s["quantity"],
                "has_bom": False,
                "items": [],
                "status": "NO_BOM",
                "customer": s["customer"],
                "date": s["date"].isoformat() if s["date"] else None,
                "owner": s["owner"],
            })
            continue
        items = compute_material_requirements(db, s["quantity"], s["product_id"], s["product_name"])
        overall = "SHORTAGE" if any(i["status"] == "SHORTAGE" for i in items) else "READY"
        if status and overall != status:
            continue
        results.append({
            "product_id": s["product_id"],
            "product_name": s["product_name"],
            "production_quantity": s["quantity"],
            "has_bom": True,
            "items": items,
            "status": overall,
            "customer": s["customer"],
            "date": s["date"].isoformat() if s["date"] else None,
            "owner": s["owner"],
        })
    # aggregate RM-level totals
    for r in results:
        for it in r["items"]:
            if not it["raw_material_id"]:
                continue
            key = it["raw_material_id"]
            if key not in by_rm:
                by_rm[key] = {
                    "raw_material_id": key,
                    "raw_material_name": it["raw_material_name"],
                    "required_quantity": 0.0,
                    "available_quantity": it["available_quantity"],
                    "shortage_quantity": 0.0,
                    "uom": it["uom"] or "KG",
                    "status": "READY",
                    "products": set(),
                }
            agg = by_rm[key]
            agg["required_quantity"] += it["required_quantity"]
            agg["shortage_quantity"] += it["shortage_quantity"]
            agg["products"].add(r["product_name"])
            if it["status"] == "SHORTAGE":
                agg["status"] = "SHORTAGE"
    for agg in by_rm.values():
        agg["required_quantity"] = round(agg["required_quantity"], 4)
        agg["shortage_quantity"] = round(agg["shortage_quantity"], 4)
        agg["products"] = sorted(agg["products"])
    return {
        "requirements": results,
        "rm_aggregate": sorted(by_rm.values(), key=lambda x: -x["shortage_quantity"]),
    }


@router.get("/rm-shortage")
def rm_shortage(
    db: Annotated[Session, Depends(get_db)],
    _: CurrentUser,
    product_id: int | None = None,
):
    """Raw material shortage list: only RM where required > available."""
    summary = material_requirements_summary(db, None, product_id=product_id)
    shortages = [
        a for a in summary["rm_aggregate"]
        if a["shortage_quantity"] > 0
    ]
    return shortages


@router.get("/production-readiness")
def production_readiness(
    db: Annotated[Session, Depends(get_db)],
    _: CurrentUser,
    product_id: int | None = None,
):
    """Per-product production material readiness (ready / shortage / no bom)."""
    products = db.query(Product).filter(
        Product.category != ProductCategory.trading
    ).all()
    out = []
    for p in products:
        r = production_material_readiness(db, p.id)
        r.update({"product_name": p.model, "family": p.family or product_family(p.model)})
        out.append(r)
    if product_id:
        out = [x for x in out if x["product_id"] == product_id]
    return out
