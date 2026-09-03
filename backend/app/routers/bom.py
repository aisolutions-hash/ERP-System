from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import BillOfMaterial, Product
from ..schemas import BOMCreate, BOMOut, BOMUpdate

router = APIRouter(prefix="/bom", tags=["BOM"])


def _bom_with_names(db: Session, bom: BillOfMaterial) -> dict:
    """Serialize BOM with product names resolved."""
    prod = db.get(Product, bom.product_id)
    rm = db.get(Product, bom.raw_material_product_id)
    return {
        "id": bom.id,
        "product_id": bom.product_id,
        "raw_material_product_id": bom.raw_material_product_id,
        "quantity_per_unit": bom.quantity_per_unit,
        "uom": bom.uom,
        "effective_date": bom.effective_date.isoformat() if bom.effective_date else None,
        "version": bom.version,
        "notes": bom.notes or "",
        "is_active": bom.is_active,
        "created_at": bom.created_at.isoformat() if bom.created_at else None,
        "updated_at": bom.updated_at.isoformat() if bom.updated_at else None,
        "product_name": prod.model if prod else "Unknown",
        "raw_material_name": rm.model if rm else "Unknown",
    }


@router.get("", response_model=list[BOMOut])
def list_bom(product_id: int | None = None, is_active: bool = True, db: Session = Depends(get_db)):
    q = db.query(BillOfMaterial).order_by(BillOfMaterial.product_id, BillOfMaterial.version)
    if product_id:
        q = q.filter(BillOfMaterial.product_id == product_id)
    if is_active is not None:
        q = q.filter(BillOfMaterial.is_active == is_active)
    items = q.all()
    return [_bom_with_names(db, b) for b in items]


@router.get("/by-product/{product_id}")
def bom_for_product(product_id: int, db: Session = Depends(get_db)):
    """Get all active BOM lines for a finished product."""
    items = (
        db.query(BillOfMaterial)
        .filter(BillOfMaterial.product_id == product_id, BillOfMaterial.is_active == True)
        .order_by(BillOfMaterial.version, BillOfMaterial.id)
        .all()
    )
    return [_bom_with_names(db, b) for b in items]


@router.post("", response_model=BOMOut, status_code=201)
def create_bom(body: BOMCreate, db: Session = Depends(get_db)):
    if body.product_id == body.raw_material_product_id:
        raise HTTPException(400, "Finished product and raw material cannot be the same")
    product = db.get(Product, body.product_id)
    if not product:
        raise HTTPException(404, "Product not found")
    rm = db.get(Product, body.raw_material_product_id)
    if not rm:
        raise HTTPException(404, "Raw material product not found")
    if body.quantity_per_unit <= 0:
        raise HTTPException(400, "Quantity per unit must be > 0")
    dup = (
        db.query(BillOfMaterial)
        .filter(
            BillOfMaterial.product_id == body.product_id,
            BillOfMaterial.raw_material_product_id == body.raw_material_product_id,
            BillOfMaterial.version == body.version,
            BillOfMaterial.is_active == True,
        )
        .first()
    )
    if dup:
        raise HTTPException(400, "Duplicate active BOM line for this product/raw material/version")
    bom = BillOfMaterial(**body.model_dump())
    db.add(bom)
    db.commit()
    db.refresh(bom)
    return _bom_with_names(db, bom)


@router.put("/{bom_id}", response_model=BOMOut)
def update_bom(bom_id: int, body: BOMUpdate, db: Session = Depends(get_db)):
    bom = db.get(BillOfMaterial, bom_id)
    if not bom:
        raise HTTPException(404, "BOM line not found")
    if body.raw_material_product_id is not None and body.product_id is not None:
        if body.product_id == body.raw_material_product_id:
            raise HTTPException(400, "Finished product and raw material cannot be the same")
    if body.quantity_per_unit is not None and body.quantity_per_unit <= 0:
        raise HTTPException(400, "Quantity per unit must be > 0")
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(bom, k, v)
    db.commit()
    db.refresh(bom)
    return _bom_with_names(db, bom)


@router.patch("/{bom_id}", response_model=BOMOut)
def patch_bom(bom_id: int, body: BOMUpdate, db: Session = Depends(get_db)):
    """Alias for PUT - partial update."""
    return update_bom(bom_id, body, db)


@router.delete("/{bom_id}")
def delete_bom(bom_id: int, db: Session = Depends(get_db)):
    """Soft-delete by deactivating."""
    bom = db.get(BillOfMaterial, bom_id)
    if not bom:
        raise HTTPException(404, "BOM line not found")
    bom.is_active = False
    db.commit()
    return {"message": "BOM line deactivated", "id": bom_id}


@router.get("/validate")
def validate_bom_data(db: Session = Depends(get_db)):
    """Return validation summary for all active BOMs."""
    boms = db.query(BillOfMaterial).filter(BillOfMaterial.is_active == True).all()
    issues = []
    for b in boms:
        product = db.get(Product, b.product_id)
        rm = db.get(Product, b.raw_material_product_id)
        if not product:
            issues.append(f"BOM#{b.id}: product_id {b.product_id} not found")
        if not rm:
            issues.append(f"BOM#{b.id}: raw_material_product_id {b.raw_material_product_id} not found")
        if b.quantity_per_unit <= 0:
            issues.append(f"BOM#{b.id}: quantity_per_unit must be > 0")
    return {"total_boms": len(boms), "issues": issues}
