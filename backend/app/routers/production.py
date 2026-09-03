"""Production management (CRUD + daily movements + status lifecycle)."""
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..auth import CurrentUser, AllStaff, ManagerOrAdmin
from ..crud import apply_updates, get_or_404, write_audit
from ..database import get_db
from ..models import (
    Inventory, MovementType, Plant, Product, ProductionMovement, ProductionOrder,
    ProductionStatus, StockMovement, Plan, PlanType,
)
from ..schemas import ProductionOrderCreate, ProductionOrderOut, ProductionOrderUpdate
from datetime import date

router = APIRouter(prefix="/production", tags=["production"])


def _next_no(db: Session) -> str:
    today = date.today()
    prefix = f"PO-{today.strftime('%Y%m%d')}-"
    n = db.scalar(select(func.count()).select_from(ProductionOrder).where(ProductionOrder.order_no.like(f"{prefix}%")))
    return f"{prefix}{n + 1:03d}"


def _serialize_po(db: Session, o: ProductionOrder) -> dict:
    product = o.product
    return {
        "id": o.id, "order_no": o.order_no, "product_id": o.product_id,
        "section": o.section, "schedule_qty": o.schedule_qty, "ask_till_date": o.ask_till_date,
        "produced_qty": o.produced_qty, "completion_pct": o.completion_pct,
        "balance_qty": o.balance_qty, "opening_stock": o.opening_stock,
        "status": o.status.value, "start_date": o.start_date, "completion_date": o.completion_date,
        "report_date": o.report_date, "remarks": o.remarks,
        "product": {"id": product.id, "model": product.model, "item_code": product.item_code,
                    "name": product.name, "category": product.category.value} if product else None,
        "movements": [{"id": m.id, "production_order_id": m.production_order_id,
                       "quantity": m.quantity, "production_date": m.production_date} for m in o.movements],
    }


def _recalc_status(o: ProductionOrder):
    if o.schedule_qty:
        o.completion_pct = round(o.produced_qty / o.schedule_qty, 4)
        o.balance_qty = o.schedule_qty - o.produced_qty
    else:
        o.completion_pct = 0.0
        o.balance_qty = 0.0
    if o.status == ProductionStatus.planned and o.produced_qty > 0:
        o.status = ProductionStatus.in_production
    if o.schedule_qty > 0 and o.produced_qty >= o.schedule_qty:
        o.status = ProductionStatus.completed
        o.completion_date = date.today()


@router.get("", response_model=dict)
def list_production(
    db: Annotated[Session, Depends(get_db)],
    _: CurrentUser,
    search: str = "",
    status_: str = Query(default="", alias="status"),
    product_id: int | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=500),
):
    stmt = select(ProductionOrder)
    if search:
        like = f"%{search}%"
        stmt = stmt.where(or_(ProductionOrder.order_no.ilike(like), ProductionOrder.section.ilike(like)))
    if status_:
        stmt = stmt.where(ProductionOrder.status == status_)
    if product_id:
        stmt = stmt.where(ProductionOrder.product_id == product_id)
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(ProductionOrder.report_date.desc(), ProductionOrder.id.desc())
                      .offset((page - 1) * page_size).limit(page_size)).all()
    return {"items": [_serialize_po(db, o) for o in rows],
            "total": total, "page": page, "page_size": page_size}


@router.post("", response_model=dict, status_code=status.HTTP_201_CREATED)
def create_production(body: ProductionOrderCreate, db: Annotated[Session, Depends(get_db)],
                      user: AllStaff):
    get_or_404(db, Product, body.product_id)
    o = ProductionOrder(
        order_no=body.order_no or _next_no(db), product_id=body.product_id,
        section=body.section, schedule_qty=body.schedule_qty, ask_till_date=body.ask_till_date,
        produced_qty=body.produced_qty, opening_stock=body.opening_stock,
        status=body.status, start_date=body.start_date, completion_date=body.completion_date,
        report_date=body.report_date, remarks=body.remarks,
    )
    _recalc_status(o)
    db.add(o)
    db.commit()
    db.refresh(o)
    write_audit(db, user, "CREATE", "production_orders", o.id, f"Created production order {o.order_no}")
    return _serialize_po(db, o)


@router.get("/actual", response_model=dict)
def list_production_actual(
    db: Annotated[Session, Depends(get_db)],
    _: CurrentUser,
    product_id: int | None = None,
    date_from: str = "",
    date_to: str = "",
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=1000),
):
    """Daily production output (actual) — never collapsed into monthly numbers."""
    stmt = (select(ProductionMovement)
            .join(ProductionOrder, ProductionOrder.id == ProductionMovement.production_order_id)
            .join(Product, Product.id == ProductionOrder.product_id, isouter=True))
    if product_id:
        stmt = stmt.where(ProductionOrder.product_id == product_id)
    if date_from:
        stmt = stmt.where(ProductionMovement.production_date >= date.fromisoformat(date_from))
    if date_to:
        stmt = stmt.where(ProductionMovement.production_date <= date.fromisoformat(date_to))
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(ProductionMovement.production_date.desc(), ProductionMovement.id.desc())
                      .offset((page - 1) * page_size).limit(page_size)).all()
    items = []
    for m in rows:
        po = m.production_order
        p = po.product if po else None
        items.append({
            "id": m.id, "production_order_id": m.production_order_id,
            "production_date": m.production_date, "quantity": m.quantity,
            "product_id": p.id if p else po.product_id,
            "model": p.model if p else None,
            "item_code": p.item_code if p else None,
            "ref": po.order_no if po else "",
        })
    return {"items": items, "total": total, "page": page, "page_size": page_size}


@router.get("/plan-vs-actual", response_model=dict)
def plan_vs_actual(
    db: Annotated[Session, Depends(get_db)],
    _: CurrentUser,
    product_id: int | None = None,
):
    """Plan vs Actual for each ProductionOrder (reliable FK link to its daily
    movements). Plan-only `Plan` records with no production order are returned
    in `unlinked_plans` (no fabricated plan-to-actual relationship)."""
    stmt = select(ProductionOrder)
    if product_id:
        stmt = stmt.where(ProductionOrder.product_id == product_id)
    orders = db.scalars(stmt.order_by(ProductionOrder.id)).all()
    rows = []
    for po in orders:
        p = po.product
        actual = float(po.produced_qty or 0)
        planned = float(po.schedule_qty or 0)
        remaining = planned - actual
        pct = round(actual / planned, 4) if planned else 0.0
        rows.append({
            "plan_id": po.id, "product_id": po.product_id,
            "model": p.model if p else None,
            "item_code": p.item_code if p else None,
            "planned_qty": planned, "actual_qty": actual,
            "remaining_qty": remaining, "completion_pct": pct,
            "status": po.status.value, "report_date": po.report_date,
            "movement_count": len(po.movements),
        })
    unlinked = []
    prod_orders = {po.product_id for po in orders}
    plans = db.scalars(select(Plan).where(Plan.plan_type == PlanType.production)).all()
    for pl in plans:
        if pl.product_id in prod_orders:
            continue
        unlinked.append({
            "plan_id": pl.id, "product_id": pl.product_id, "model": pl.model,
            "customer": pl.customer.name if pl.customer else None,
            "owner": pl.owner, "planned_qty": pl.quantity,
            "plan_date": pl.plan_date, "status": pl.status, "remarks": pl.remarks,
            "linkage": "Plan only — no production order link",
        })
    rows.sort(key=lambda x: -x["completion_pct"])
    return {"items": rows, "unlinked_plans": unlinked, "total": len(rows)}


@router.get("/{order_id}", response_model=dict)
def get_production(order_id: int, db: Annotated[Session, Depends(get_db)],
                   _: CurrentUser):
    return _serialize_po(db, get_or_404(db, ProductionOrder, order_id))


@router.patch("/{order_id}", response_model=dict)
def update_production(order_id: int, body: ProductionOrderUpdate,
                      db: Annotated[Session, Depends(get_db)], user: AllStaff):
    o = get_or_404(db, ProductionOrder, order_id)
    apply_updates(o, body)
    _recalc_status(o)
    db.commit()
    db.refresh(o)
    write_audit(db, user, "UPDATE", "production_orders", o.id, f"Updated production order {o.order_no}")
    return _serialize_po(db, o)


@router.post("/{order_id}/movements", response_model=dict)
def add_movement(order_id: int, quantity: float, production_date: str,
                 db: Annotated[Session, Depends(get_db)], user: AllStaff):
    """Record a daily production output; updates produced qty + finished goods stock."""
    o = get_or_404(db, ProductionOrder, order_id)
    if quantity <= 0:
        raise status.HTTP_400_BAD_REQUEST
    d = date.fromisoformat(production_date)
    db.add(ProductionMovement(production_order_id=o.id, quantity=quantity, production_date=d))
    o.produced_qty += quantity
    _recalc_status(o)
    # finished goods increase
    inv = db.scalars(select(Inventory).where(Inventory.product_id == o.product_id, Inventory.plant_id.is_(None))).first()
    if inv is None:
        inv = Inventory(product_id=o.product_id, plant_id=None,
                        opening_stock=0, received_qty=0, issued_qty=0, current_stock=0)
        db.add(inv)
    inv.received_qty = float(inv.received_qty or 0) + quantity
    inv.current_stock = float(inv.current_stock or 0) + quantity
    db.add(StockMovement(product_id=o.product_id, movement_type=MovementType.production_output,
                         quantity=quantity, transaction_date=d, ref_type="production_order",
                         ref_id=o.id, remarks=f"Production output {o.order_no}"))
    db.commit()
    db.refresh(o)
    write_audit(db, user, "CREATE", "production_movements", o.id, f"{quantity} output on {production_date}")
    return _serialize_po(db, o)


@router.patch("/movements/{movement_id}", response_model=dict)
def update_movement(movement_id: int, quantity: float,
                    db: Annotated[Session, Depends(get_db)], user: AllStaff,
                    production_date: str = ""):
    """Edit a daily production output quantity (actual) + date."""
    m = get_or_404(db, ProductionMovement, movement_id)
    o = get_or_404(db, ProductionOrder, m.production_order_id)
    delta = quantity - float(m.quantity or 0)
    m.quantity = quantity
    if production_date:
        m.production_date = date.fromisoformat(production_date)
    o.produced_qty = float(o.produced_qty or 0) + delta
    _recalc_status(o)
    db.commit()
    db.refresh(o)
    write_audit(db, user, "UPDATE", "production_movements", movement_id,
                f"Output {movement_id}: {m.quantity}")
    return _serialize_po(db, o)


@router.delete("/{order_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_production(order_id: int, db: Annotated[Session, Depends(get_db)],
                      user: ManagerOrAdmin):
    o = get_or_404(db, ProductionOrder, order_id)
    db.delete(o)
    db.commit()
    write_audit(db, user, "DELETE", "production_orders", order_id, f"Deleted production order {o.order_no}")
    return Response(status_code=status.HTTP_204_NO_CONTENT)