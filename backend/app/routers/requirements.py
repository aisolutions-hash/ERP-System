"""Purchase / production requirements (shortage detection) + status workflow.

Shortage = Required (pending order balance) - Available (stock ledger).

Category by product.source_type:
  TRADING      -> PURCHASE requirement
  MANUFACTURED -> PRODUCTION requirement
  MIXED/UNKNOWN-> DECISION required (user picks source)

Material category (Raw Material / Finished / Trading / Store) is exposed from
Product.category for category-wise filtering, reusing the existing product
category system. Status lifecycle (purchase team):
  Pending -> In Progress -> Ordered -> Received -> Completed
"""
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..auth import CurrentUser, AllStaff
from ..crud import write_audit
from ..database import get_db
from ..models import (
    Alert, AlertType, Inventory, Product, ProductSourceType,
    PurchaseRequirement, SalesOrder, SalesOrderLine,
)
from ..services.business import REQUIREMENT_STATUSES
from ..services.migration_v2 import product_family

router = APIRouter(prefix="/requirements", tags=["requirements"])

_STATUSES = tuple(REQUIREMENT_STATUSES)

# Product-level shortage alert types rendered as the row "Alert" indicator.
_ALERT_TYPES = (AlertType.purchase_required.value,
                AlertType.production_material_shortage.value)


def _inventory_map(db: Session) -> dict[int, float]:
    rows = db.execute(
        select(Inventory.product_id, func.sum(Inventory.current_stock))
        .where(Inventory.plant_id.is_(None))
        .group_by(Inventory.product_id)
    ).all()
    return {pid: float(q or 0) for pid, q in rows}


def _overlay(db: Session, product_id: int, line_id: int | None) -> str:
    """Persisted status for this requirement, if any."""
    q = select(PurchaseRequirement.status).where(
        PurchaseRequirement.product_id == product_id)
    if line_id:
        q = q.where(PurchaseRequirement.sales_order_line_id == line_id)
    return db.scalar(q.order_by(PurchaseRequirement.id.desc()).limit(1)) or ""


def _category(product: Product) -> tuple[str, str]:
    st = product.source_type
    if st == ProductSourceType.trading:
        return "PURCHASE", st.value
    if st == ProductSourceType.manufactured:
        return "PRODUCTION", st.value
    if st == ProductSourceType.mixed:
        return "DECISION", st.value
    return "DECISION", (st.value if st else "UNKNOWN")


@router.get("", response_model=dict)
def list_requirements(
    db: Annotated[Session, Depends(get_db)],
    _: CurrentUser,
    category: str = "",
    material_category: str = "",
    status_: str = Query(default="", alias="status"),
    shortage_only: bool = Query(default=True, alias="shortage_only"),
    customer_id: int | None = None,
    search: str = "",
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
):
    inv = _inventory_map(db)
    open_alerts = {
        (a.entity_id, a.type.value) for a in db.scalars(
            select(Alert).where(Alert.status == "OPEN",
                                Alert.entity_type == "product",
                                Alert.type.in_(_ALERT_TYPES))
        ).all()
    }
    needle = search.strip().lower()
    rows = db.execute(
        select(SalesOrder, SalesOrderLine)
        .join(SalesOrderLine, SalesOrderLine.order_id == SalesOrder.id)
        .join(Product, Product.id == SalesOrderLine.product_id, isouter=True)
    ).all()
    built = []
    for o, ln in rows:
        if not ln.product_id or ln.product is None:
            continue
        p = ln.product
        if needle:
            hay = " ".join(filter(None, [p.model, p.item_code, p.family,
                                         o.order_no, o.customer.name if o.customer else "",
                                         ln.customer_po_no or o.customer_po_no or ""])).lower()
            if needle not in hay:
                continue
        available = inv.get(p.id, 0.0)
        required = float(ln.quantity or 0)
        if required <= 0:
            continue
        shortage = required - available
        if shortage_only and shortage <= 0:
            continue
        cat, stype = _category(p)
        if category and cat != category:
            continue
        if material_category and p.category.value != material_category:
            continue
        status = _overlay(db, p.id, ln.id) or ("Pending" if shortage > 0 else "OK")
        if status_ and status != status_:
            continue
        if customer_id and o.customer_id != customer_id:
            continue
        # alert indicator for THIS product (any of its open shortage alerts)
        alerted = any(pid == p.id for pid, _ in open_alerts)
        built.append({
            "id": f"R{ln.id}",
            "product_id": p.id, "model": p.model, "item_code": p.item_code,
            "family": p.family or product_family(p.model),
            "source_type": stype,
            "material_category": p.category.value,
            "customer_id": o.customer_id,
            "customer": o.customer.name if o.customer else None,
            "order_no": o.order_no, "order_id": o.id, "line_id": ln.id,
            "customer_po_no": ln.customer_po_no or o.customer_po_no or "",
            "required_qty": required, "available_qty": available,
            "shortage_qty": shortage,
            "category": cat,
            "status": status,
            "alerted": alerted,
        })
    built.sort(key=lambda x: -x["shortage_qty"])
    total = len(built)
    start = (page - 1) * page_size
    return {"items": built[start:start + page_size], "total": total,
            "page": page, "page_size": page_size}


@router.patch("/{line_id}", response_model=dict)
def update_requirement(
    line_id: int, db: Annotated[Session, Depends(get_db)],
    user: AllStaff, status: str = "", category: str = "",
    notes: str = "",
):
    """Update a requirement's status (Pending/In Progress/Ordered/Received/
    Completed) and/or resolve its source category (PURCHASE/PRODUCTION).
    Status values are validated server-side and persisted."""
    ln = db.get(SalesOrderLine, line_id)
    if ln is None or ln.product_id is None:
        return {"ok": False, "error": "line not found"}
    if status and status not in _STATUSES:
        raise HTTPException(status_code=400,
                            detail=f"Invalid status '{status}'. Allowed: {', '.join(_STATUSES)}")
    if category:
        pr = db.scalar(select(PurchaseRequirement).where(
            PurchaseRequirement.sales_order_line_id == line_id,
            PurchaseRequirement.product_id == ln.product_id).limit(1))
        if pr is None:
            pr = PurchaseRequirement(
                product_id=ln.product_id, sales_order_line_id=line_id,
                sales_order_id=ln.order_id, category=category)
            db.add(pr)
        pr.category = category
        if notes:
            pr.notes = notes
        db.commit()
        write_audit(db, user, "CATEGORY", "purchase_requirements", pr.id,
                    f"Line {line_id} category -> {category}")
        return {"ok": True, "line_id": line_id, "category": category}
    if status:
        pr = db.scalar(select(PurchaseRequirement).where(
            PurchaseRequirement.sales_order_line_id == line_id,
            PurchaseRequirement.product_id == ln.product_id).limit(1))
        if pr is None:
            pr = PurchaseRequirement(
                product_id=ln.product_id, sales_order_line_id=line_id,
                sales_order_id=ln.order_id, category="PURCHASE")
            db.add(pr)
        pr.status = status
        if notes:
            pr.notes = notes
        db.commit()
        write_audit(db, user, "STATUS", "purchase_requirements", pr.id,
                    f"Line {line_id} status -> {status}")
        return {"ok": True, "line_id": line_id, "status": status}
    return {"ok": False}
