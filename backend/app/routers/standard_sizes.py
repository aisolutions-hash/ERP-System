"""Standard Size Master: list, add, edit, status, Excel preview/import/export."""
from __future__ import annotations

from io import BytesIO
from typing import Annotated

from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile, status
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..auth import AllStaff, CurrentUser
from ..crud import get_or_404, write_audit
from ..database import get_db
from ..models import Product, StandardSize
from ..schemas import StandardSizeCreate, StandardSizeOut, StandardSizeUpdate
from ..services.standard_sizes import (
    FIELD_LABELS, import_standard_sizes, preview_standard_sizes, size_key,
)

router = APIRouter(prefix="/standard-sizes", tags=["standard-sizes"])

SORT_FIELDS = {
    "size_inches": StandardSize.size_inches,
    "size_mm": StandardSize.size_mm,
    "number_of_rolls": StandardSize.number_of_rolls,
    "item_code": StandardSize.item_code,
    "material_description": StandardSize.material_description,
    "status": StandardSize.status,
    "created_at": StandardSize.created_at,
    "updated_at": StandardSize.updated_at,
}


def _user_name(user) -> str:
    return (getattr(user, "full_name", "") or getattr(user, "username", "") or "").strip()


def _serialize(row: StandardSize) -> dict:
    product = row.product
    return {
        "id": row.id,
        "size_inches": row.size_inches,
        "size_mm": row.size_mm,
        "number_of_rolls": row.number_of_rolls,
        "tare_weight_6mm": row.tare_weight_6mm,
        "tare_weight_10mm": row.tare_weight_10mm,
        "tare_weight_12mm": row.tare_weight_12mm,
        "gross_weight": row.gross_weight or "",
        "item_code": row.item_code or "",
        "material_description": row.material_description or "",
        "paper_core_weight": row.paper_core_weight or "",
        "status": row.status or "Active",
        "remarks": row.remarks or "",
        "product_id": row.product_id,
        "product": {
            "id": product.id,
            "item_code": product.item_code,
            "model": product.model,
            "name": product.name,
            "uom": product.uom,
        } if product else None,
        "created_by": row.created_by or "",
        "created_at": row.created_at,
        "updated_by": row.updated_by or "",
        "updated_at": row.updated_at,
    }


def _find_duplicate(db: Session, size_inches, size_mm,
                    exclude_id: int | None = None) -> StandardSize | None:
    key = size_key(size_inches, size_mm)
    if key is None:
        return None
    stmt = select(StandardSize)
    if key[0] == "in":
        stmt = stmt.where(StandardSize.size_inches == key[1])
    else:
        stmt = stmt.where(StandardSize.size_mm == key[1])
    if exclude_id is not None:
        stmt = stmt.where(StandardSize.id != exclude_id)
    return db.scalars(stmt.order_by(StandardSize.id).limit(1)).first()


def _duplicate_message(row: StandardSize, size_inches, size_mm) -> str:
    size = f'{size_inches:g}"' if size_inches is not None else f"{size_mm:g} mm"
    item = f", item {row.item_code}" if row.item_code else ""
    return (f"Standard size {size} already exists as record #{row.id}{item}. "
            "Confirm to update that existing record instead of creating a duplicate.")


def _link_product(db: Session, data: dict) -> None:
    """Resolve an optional link to an EXISTING product (never creates one)."""
    item_code = (data.get("item_code") or "").strip()
    if item_code:
        data["item_code"] = item_code
    product = None
    if data.get("product_id") is not None:
        product = get_or_404(db, Product, data["product_id"])
    elif item_code:
        product = db.scalars(
            select(Product).where(func.lower(Product.item_code) == item_code.lower())
            .order_by(Product.id).limit(1)
        ).first()
    if product is not None:
        data["product_id"] = product.id
        if not data.get("item_code"):
            data["item_code"] = product.item_code or ""
        if not (data.get("material_description") or "").strip():
            data["material_description"] = product.model or product.name or ""


def _base_query(search: str, status_filter: str):
    stmt = select(StandardSize)
    if search:
        like = f"%{search}%"
        conditions = [
            StandardSize.item_code.ilike(like),
            StandardSize.material_description.ilike(like),
            StandardSize.gross_weight.ilike(like),
            StandardSize.paper_core_weight.ilike(like),
        ]
        try:
            number = float(search)
            conditions += [StandardSize.size_inches == number,
                           StandardSize.size_mm == number]
        except ValueError:
            pass
        stmt = stmt.where(or_(*conditions))
    if status_filter:
        stmt = stmt.where(StandardSize.status == status_filter)
    return stmt


@router.get("", response_model=dict)
def list_standard_sizes(
    db: Annotated[Session, Depends(get_db)],
    _: CurrentUser,
    search: str = "",
    status_filter: str = Query(default="", alias="status"),
    sort_by: str = "size_inches",
    sort_dir: str = "asc",
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=500),
):
    stmt = _base_query(search, status_filter)
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    column = SORT_FIELDS.get(sort_by, StandardSize.size_inches)
    order = column.desc() if sort_dir.lower() == "desc" else column.asc()
    rows = db.scalars(
        stmt.order_by(order, StandardSize.id.asc())
        .offset((page - 1) * page_size).limit(page_size)
    ).all()
    return {"items": [_serialize(r) for r in rows], "total": total,
            "page": page, "page_size": page_size}


@router.get("/export")
def export_standard_sizes(
    db: Annotated[Session, Depends(get_db)],
    _: CurrentUser,
    search: str = "",
    status_filter: str = Query(default="", alias="status"),
):
    rows = db.scalars(
        _base_query(search, status_filter)
        .order_by(StandardSize.size_inches.asc(), StandardSize.id.asc())
    ).all()

    headers = [
        "Size in inches", "Size in MM", "No of roll", "Tare weight 6 mm",
        "Tare weight 10 mm", "Tare weight 12 mm", "Gross weight", "ITEM CODE",
        "DESCRIPTION", "WEIGHT", "Status", "Remarks", "Created By",
        "Created Date", "Last Updated By", "Last Updated Date",
    ]
    wb = Workbook()
    ws = wb.active
    ws.title = "Standard Sizes"
    ws.append(headers)
    fill = PatternFill("solid", fgColor="1E3A8A")
    font = Font(color="FFFFFF", bold=True)
    for cell in ws[1]:
        cell.fill = fill
        cell.font = font
    for r in rows:
        ws.append([
            r.size_inches, r.size_mm, r.number_of_rolls,
            r.tare_weight_6mm, r.tare_weight_10mm, r.tare_weight_12mm,
            r.gross_weight, r.item_code, r.material_description,
            r.paper_core_weight, r.status, r.remarks, r.created_by,
            r.created_at.strftime("%Y-%m-%d %H:%M") if r.created_at else "",
            r.updated_by,
            r.updated_at.strftime("%Y-%m-%d %H:%M") if r.updated_at else "",
        ])
    widths = [14, 12, 11, 16, 17, 17, 20, 14, 40, 18, 10, 30, 20, 18, 20, 18]
    for i, width in enumerate(widths, 1):
        ws.column_dimensions[ws.cell(row=1, column=i).column_letter].width = width
    buf = BytesIO()
    wb.save(buf)
    return Response(
        content=buf.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="standard_sizes.xlsx"'},
    )


@router.post("/import/preview", response_model=dict)
async def preview_import(
    db: Annotated[Session, Depends(get_db)],
    _: AllStaff,
    file: UploadFile = File(...),
):
    content = await file.read()
    if not content:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The uploaded file is empty")
    try:
        result = preview_standard_sizes(db, file.filename or "upload.xlsx", content)
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    result["filename"] = file.filename or "upload.xlsx"
    return result


@router.post("/import", response_model=dict)
async def import_sizes(
    db: Annotated[Session, Depends(get_db)],
    user: AllStaff,
    file: UploadFile = File(...),
):
    content = await file.read()
    if not content:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The uploaded file is empty")
    try:
        result = import_standard_sizes(
            db, file.filename or "upload.xlsx", content, user_name=_user_name(user)
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    summary = result["summary"]
    write_audit(
        db, user, "IMPORT", "standard_sizes", None,
        f"Standard size import: {summary['imported']} imported, "
        f"{summary['skipped']} skipped, {summary['failed']} failed",
        created=summary["imported"], failed=summary["failed"],
    )
    return result


@router.post("", response_model=StandardSizeOut, status_code=status.HTTP_201_CREATED)
def create_standard_size(
    body: StandardSizeCreate,
    db: Annotated[Session, Depends(get_db)],
    user: AllStaff,
):
    data = body.model_dump(exclude={"confirm_duplicate"})
    _link_product(db, data)
    duplicate = _find_duplicate(db, data["size_inches"], data["size_mm"])
    name = _user_name(user)
    if duplicate is not None:
        if not body.confirm_duplicate:
            raise HTTPException(status.HTTP_409_CONFLICT,
                                _duplicate_message(duplicate, data["size_inches"],
                                                   data["size_mm"]))
        for key, value in data.items():
            setattr(duplicate, key, value)
        duplicate.updated_by = name
        db.commit()
        db.refresh(duplicate)
        write_audit(db, user, "UPDATE", "standard_sizes", duplicate.id,
                    f"Updated duplicate standard size #{duplicate.id}")
        return duplicate

    row = StandardSize(**data, created_by=name, updated_by=name)
    db.add(row)
    db.commit()
    db.refresh(row)
    write_audit(db, user, "CREATE", "standard_sizes", row.id,
                f"Created standard size #{row.id}")
    return row


@router.get("/{size_id}", response_model=StandardSizeOut)
def get_standard_size(
    size_id: int,
    db: Annotated[Session, Depends(get_db)],
    _: CurrentUser,
):
    return get_or_404(db, StandardSize, size_id)


@router.patch("/{size_id}", response_model=StandardSizeOut)
def update_standard_size(
    size_id: int,
    body: StandardSizeUpdate,
    db: Annotated[Session, Depends(get_db)],
    user: AllStaff,
):
    row = get_or_404(db, StandardSize, size_id)
    data = body.model_dump(exclude_unset=True, exclude={"confirm_duplicate"})
    size_inches = data.get("size_inches", row.size_inches)
    size_mm = data.get("size_mm", row.size_mm)
    if size_inches is None and size_mm is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST,
                            "Enter at least one of Size in Inches or Size in MM")
    duplicate = _find_duplicate(db, size_inches, size_mm, exclude_id=row.id)
    if duplicate is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"Another standard size already uses this size (record #{duplicate.id}"
            f"{f', item {duplicate.item_code}' if duplicate.item_code else ''}). "
            "Edit that record instead.",
        )
    _link_product(db, data)
    changed = []
    for key, value in data.items():
        if not hasattr(row, key) or getattr(row, key) == value:
            continue
        setattr(row, key, value)
        changed.append(FIELD_LABELS.get(key, key))
    row.updated_by = _user_name(user)
    db.commit()
    db.refresh(row)
    write_audit(db, user, "UPDATE", "standard_sizes", row.id,
                f"Updated standard size #{row.id}"
                + (f": {', '.join(changed)}" if changed else ""))
    return row
