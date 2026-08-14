"""Meta endpoints: statuses, enums, filter option lists."""
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth import CurrentUser
from ..database import get_db
from ..models import (
    Customer, DispatchStatus, MovementType, OrderStatus, Plant, PlanType,
    Product, ProductCategory, ProductionStatus, PurchaseStatus, UserRole,
)

router = APIRouter(prefix="/meta", tags=["meta"])


@router.get("/statuses")
def statuses(_: CurrentUser):
    return {
        "user_roles": [r.value for r in UserRole],
        "product_categories": [c.value for c in ProductCategory],
        "order_statuses": [o.value for o in OrderStatus],
        "production_statuses": [p.value for p in ProductionStatus],
        "dispatch_statuses": [d.value for d in DispatchStatus],
        "purchase_statuses": [p.value for p in PurchaseStatus],
        "movement_types": [m.value for m in MovementType],
        "plan_types": [p.value for p in PlanType],
    }


@router.get("/filters")
def filters(db: Annotated[Session, Depends(get_db)], _: CurrentUser):
    customers = db.scalars(select(Customer).where(Customer.is_active.is_(True)).order_by(Customer.name)).all()
    plants = db.scalars(select(Plant).where(Plant.is_active.is_(True)).order_by(Plant.name)).all()
    products = db.scalars(select(Product).where(Product.is_active.is_(True)).order_by(Product.model)).all()
    return {
        "customers": [{"id": c.id, "name": c.name} for c in customers],
        "plants": [{"id": p.id, "name": p.name} for p in plants],
        "products": [{"id": p.id, "model": p.model, "item_code": p.item_code, "category": p.category.value} for p in products],
    }