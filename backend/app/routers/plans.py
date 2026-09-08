"""Production & dispatch plans (from the PLANE sheet) - CRUD."""
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..auth import CurrentUser, AllStaff, ManagerOrAdmin
from ..crud import apply_updates, get_or_404, write_audit
from ..database import get_db
from ..models import Customer, Plan, PlanType, Product, ProductCategory, ProductSourceType
from ..schemas import PlanCreate, PlanOut, PlanUpdate
from ..services.customers import get_or_create_customer

router = APIRouter(prefix="/plans", tags=["plans"])


def _resolve_product(db: Session, product_id, model) -> Product | None:
    """Pick the plan's product: by explicit id, or by typed model name.

    A typed model that matches no existing product is auto-created in the
    central product master (mirroring the customer auto-create flow) so manual
    entry is never forced to a dropdown pick.
    """
    if product_id:
        return get_or_404(db, Product, int(product_id))
    name = (model or "").strip()
    if not name:
        return None
    p = db.scalar(select(Product).where(func.lower(Product.model) == name.lower()).limit(1))
    if p is None:
        p = Product(model=name, name=name, category=ProductCategory.finished,
                    uom="Each", source_type=ProductSourceType.manufactured, is_active=True)
        db.add(p)
        db.flush()
    return p


def _resolve_customer(db: Session, customer_id, customer_name) -> int | None:
    """Pick the plan's customer by typed name (auto-create), else explicit id."""
    name = (customer_name or "").strip()
    if name:
        c = get_or_create_customer(db, name)
        return c.id if c else None
    if customer_id:
        return get_or_404(db, Customer, int(customer_id)).id
    return None


@router.get("", response_model=dict)
def list_plans(
    db: Annotated[Session, Depends(get_db)],
    _: CurrentUser,
    plan_type: str = "",
    status_: str = Query(default="", alias="status"),
    search: str = "",
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=500),
):
    stmt = select(Plan)
    if plan_type:
        stmt = stmt.where(Plan.plan_type == plan_type)
    if status_:
        stmt = stmt.where(Plan.status == status_)
    if search:
        like = f"%{search}%"
        stmt = stmt.where(Plan.model.ilike(like))
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(Plan.plan_date.desc(), Plan.id)
                      .offset((page - 1) * page_size).limit(page_size)).all()
    return {"items": [PlanOut.model_validate(p).model_dump() for p in rows],
            "total": total, "page": page, "page_size": page_size}


@router.post("", response_model=PlanOut, status_code=status.HTTP_201_CREATED)
def create_plan(body: PlanCreate, db: Annotated[Session, Depends(get_db)],
                user: AllStaff):
    data = body.model_dump()
    prod = _resolve_product(db, data.get("product_id"), data.get("model"))
    data["product_id"] = prod.id if prod else None
    if prod is not None and not (data.get("model") or "").strip():
        data["model"] = prod.model
    data["customer_id"] = _resolve_customer(db, data.get("customer_id"), data.get("customer_name", ""))
    data.pop("customer_name", None)
    p = Plan(**data)
    db.add(p)
    db.commit()
    db.refresh(p)
    write_audit(db, user, "CREATE", "plans", p.id, f"Created {p.plan_type.value} plan for {p.model}")
    return p


@router.patch("/{plan_id}", response_model=PlanOut)
def update_plan(plan_id: int, body: PlanUpdate, db: Annotated[Session, Depends(get_db)],
                user: AllStaff):
    p = get_or_404(db, Plan, plan_id)
    data = {k: v for k, v in body.model_dump(exclude_unset=True).items()}
    if "model" in data or "product_id" in data:
        model = data.get("model", p.model)
        product_id = data.get("product_id", p.product_id)
        prod = _resolve_product(db, product_id, model)
        data["product_id"] = prod.id if prod else None
        if prod is not None and prod.id == p.product_id and not (model or "").strip():
            data["model"] = p.model
    if "customer_name" in data or "customer_id" in data:
        cname = data.get("customer_name", "")
        cid = data.get("customer_id", p.customer_id)
        data["customer_id"] = _resolve_customer(db, cid, cname)
    data.pop("customer_name", None)
    valid = {k: v for k, v in data.items() if k in PlanUpdate.model_fields}
    apply_updates(p, PlanUpdate(**valid))
    db.commit()
    db.refresh(p)
    write_audit(db, user, "UPDATE", "plans", p.id, f"Updated plan {p.id}")
    return p


@router.delete("/{plan_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_plan(plan_id: int, db: Annotated[Session, Depends(get_db)],
                user: ManagerOrAdmin):
    p = get_or_404(db, Plan, plan_id)
    db.delete(p)
    db.commit()
    write_audit(db, user, "DELETE", "plans", plan_id, f"Deleted plan {p.id}")
    return Response(status_code=status.HTTP_204_NO_CONTENT)