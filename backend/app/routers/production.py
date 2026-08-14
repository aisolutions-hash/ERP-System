"""Production management (CRUD + daily movements + status lifecycle)."""
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..auth import CurrentUser, AllStaff, ManagerOrAdmin
from ..crud import apply_updates, get_or_404, write_audit
from ..database import get_db
from ..models import (
    Inventory, MovementType, Plant, ProductionMovement, ProductionOrder,
    ProductionStatus, StockMovement,
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
    get_or_404(db, __import__("..models", fromlist=["Product"]).Product, body.product_id)
    from ..models import Product
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


@router.delete("/{order_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_production(order_id: int, db: Annotated[Session, Depends(get_db)],
                      user: ManagerOrAdmin):
    o = get_or_404(db, ProductionOrder, order_id)
    db.delete(o)
    db.commit()
    write_audit(db, user, "DELETE", "production_orders", order_id, f"Deleted production order {o.order_no}")
    return Response(status_code=status.HTTP_204_NO_CONTENT)