"""Supplier management (CRUD)."""
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..auth import CurrentUser, ManagerOrAdmin
from ..crud import apply_updates, get_or_404, write_audit
from ..database import get_db
from ..models import PurchaseOrder, Supplier
from ..schemas import SupplierCreate, SupplierOut, SupplierUpdate

router = APIRouter(prefix="/suppliers", tags=["suppliers"])


@router.get("", response_model=dict)
def list_suppliers(
    db: Annotated[Session, Depends(get_db)],
    _: CurrentUser,
    search: str = "",
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=500),
):
    stmt = select(Supplier)
    if search:
        like = f"%{search}%"
        stmt = stmt.where(or_(Supplier.name.ilike(like), Supplier.company.ilike(like),
                              Supplier.materials.ilike(like), Supplier.phone.ilike(like)))
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(Supplier.name).offset((page - 1) * page_size).limit(page_size)).all()

    items = []
    for s in rows:
        po_count = db.scalar(select(func.count()).select_from(PurchaseOrder).where(PurchaseOrder.supplier_id == s.id))
        po_value = db.scalar(select(func.coalesce(func.sum(PurchaseOrder.total_amount), 0)).where(PurchaseOrder.supplier_id == s.id))
        items.append({**SupplierOut.model_validate(s).model_dump(),
                      "stats": {"total_purchases": po_count, "total_value": float(po_value or 0)}})
    return {"items": items, "total": total, "page": page, "page_size": page_size}


@router.post("", response_model=SupplierOut, status_code=status.HTTP_201_CREATED)
def create_supplier(body: SupplierCreate, db: Annotated[Session, Depends(get_db)],
                    user: ManagerOrAdmin):
    sup = Supplier(**body.model_dump())
    db.add(sup)
    db.commit()
    db.refresh(sup)
    write_audit(db, user, "CREATE", "suppliers", sup.id, f"Created supplier {sup.name}")
    return sup


@router.get("/{supplier_id}", response_model=SupplierOut)
def get_supplier(supplier_id: int, db: Annotated[Session, Depends(get_db)],
                 _: CurrentUser):
    return get_or_404(db, Supplier, supplier_id)


@router.patch("/{supplier_id}", response_model=SupplierOut)
def update_supplier(supplier_id: int, body: SupplierUpdate, db: Annotated[Session, Depends(get_db)],
                    user: ManagerOrAdmin):
    sup = get_or_404(db, Supplier, supplier_id)
    apply_updates(sup, body)
    db.commit()
    db.refresh(sup)
    write_audit(db, user, "UPDATE", "suppliers", sup.id, f"Updated supplier {sup.name}")
    return sup


@router.delete("/{supplier_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_supplier(supplier_id: int, db: Annotated[Session, Depends(get_db)],
                    user: ManagerOrAdmin):
    sup = get_or_404(db, Supplier, supplier_id)
    db.delete(sup)
    db.commit()
    write_audit(db, user, "DELETE", "suppliers", supplier_id, f"Deleted supplier {sup.name}")
    return Response(status_code=status.HTTP_204_NO_CONTENT)