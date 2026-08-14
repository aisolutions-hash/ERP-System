"""Production & dispatch plans (from the PLANE sheet) - CRUD."""
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..auth import CurrentUser, AllStaff, ManagerOrAdmin
from ..crud import apply_updates, get_or_404, write_audit
from ..database import get_db
from ..models import Plan, PlanType
from ..schemas import PlanCreate, PlanOut, PlanUpdate

router = APIRouter(prefix="/plans", tags=["plans"])


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
    p = Plan(**body.model_dump())
    db.add(p)
    db.commit()
    db.refresh(p)
    write_audit(db, user, "CREATE", "plans", p.id, f"Created {p.plan_type.value} plan for {p.model}")
    return p


@router.patch("/{plan_id}", response_model=PlanOut)
def update_plan(plan_id: int, body: PlanUpdate, db: Annotated[Session, Depends(get_db)],
                user: AllStaff):
    p = get_or_404(db, Plan, plan_id)
    apply_updates(p, body)
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