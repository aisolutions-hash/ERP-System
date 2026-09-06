"""Product catalogue management (CRUD + barcode lookup + mobile camera
recognize)."""
from __future__ import annotations

import base64
import logging
from typing import Annotated, Optional

from fastapi import APIRouter, Body, Depends, Query, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..auth import CurrentUser, ManagerOrAdmin
from ..crud import apply_updates, get_or_404, write_audit
from ..database import get_db
from ..models import Inventory, Product, ProductCategory
from ..schemas import ProductCreate, ProductOut, ProductUpdate

log = logging.getLogger("kalika.products")

router = APIRouter(prefix="/products", tags=["products"])


def _serialize_stock(p: Product) -> dict:
    return {
        "id": p.id,
        "model": p.model,
        "item_code": p.item_code,
        "name": p.name,
        "category": p.category.value if p.category else None,
        "uom": p.uom,
        "barcode": p.barcode,
        "barcode_format": p.barcode_format,
        "qr_data": p.qr_data,
        "weight_per_unit": p.weight_per_unit,
        "weight_uom": p.weight_uom,
        "standard_rate": float(p.standard_rate) if p.standard_rate is not None else None,
        "hsn_code": p.hsn_code,
        "gst_rate": p.gst_rate,
        "is_active": p.is_active,
    }


@router.get("", response_model=dict)
def list_products(
    db: Annotated[Session, Depends(get_db)],
    _: CurrentUser,
    search: str = "",
    category: str = "",
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=500),
):
    stmt = select(Product)
    if search:
        like = f"%{search}%"
        stmt = stmt.where(or_(
            Product.model.ilike(like),
            Product.item_code.ilike(like),
            Product.name.ilike(like),
            Product.barcode.ilike(like),
        ))
    if category:
        stmt = stmt.where(Product.category == category)
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(Product.category, Product.model)
                      .offset((page - 1) * page_size).limit(page_size)).all()
    return {"items": [ProductOut.model_validate(p).model_dump() for p in rows],
            "total": total, "page": page, "page_size": page_size}


@router.post("", response_model=ProductOut, status_code=status.HTTP_201_CREATED)
def create_product(body: ProductCreate, db: Annotated[Session, Depends(get_db)],
                   user: ManagerOrAdmin):
    p = Product(**body.model_dump())
    if not p.barcode and p.item_code:
        p.barcode = p.item_code  # default barcode = item_code
    db.add(p)
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise status.HTTP_409_CONFLICT
    db.refresh(p)
    write_audit(db, user, "CREATE", "products", p.id, f"Created product {p.model}")
    return p


@router.get("/lookup", response_model=dict)
def lookup_by_barcode(
    db: Annotated[Session, Depends(get_db)],
    _: CurrentUser,
    barcode: str = Query(..., min_length=1),
):
    """Resolve a scanned barcode to a product + current stock snapshot.

    Looks at `products.barcode` first, then falls back to `item_code`,
    then to `product_aliases.alias_code`. Backward-compatible: works
    even if a product has no explicit barcode (returns match by item_code).
    """
    # Import alias lazily to avoid circular import at module load
    from ..models import ProductAlias

    like = f"%{barcode.strip()}%"
    p = db.scalar(select(Product).where(
        or_(Product.barcode == barcode.strip(), Product.item_code == barcode.strip())
    ))
    if p is None:
        # Try alias map
        alias = db.scalar(select(ProductAlias).where(ProductAlias.alias_code == barcode.strip()))
        if alias:
            p = db.get(Product, alias.product_id)
    if p is None:
        return {"found": False, "product": None, "stock": [], "barcode": barcode}

    # Stock snapshot (all plant buckets)
    inv_rows = db.scalars(select(Inventory).where(Inventory.product_id == p.id)).all()
    stock = [{
        "plant_id": i.plant_id,
        "plant_name": i.plant.name if i.plant else "Main Store",
        "current_stock": float(i.current_stock or 0),
        "min_level": i.min_level,
    } for i in inv_rows]
    total_stock = sum(s["current_stock"] for s in stock)
    return {
        "found": True,
        "barcode": barcode,
        "matched_on": "barcode" if p.barcode == barcode else "item_code",
        "product": _serialize_stock(p),
        "stock": stock,
        "total_stock": total_stock,
    }


@router.get("/{product_id}", response_model=ProductOut)
def get_product(product_id: int, db: Annotated[Session, Depends(get_db)],
                _: CurrentUser):
    return get_or_404(db, Product, product_id)


@router.patch("/{product_id}", response_model=ProductOut)
def update_product(product_id: int, body: ProductUpdate, db: Annotated[Session, Depends(get_db)],
                   user: ManagerOrAdmin):
    p = get_or_404(db, Product, product_id)
    apply_updates(p, body)
    if not p.barcode and p.item_code:
        p.barcode = p.item_code
    db.commit()
    db.refresh(p)
    write_audit(db, user, "UPDATE", "products", product_id, f"Updated product {p.model}")
    return p


@router.delete("/{product_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_product(product_id: int, db: Annotated[Session, Depends(get_db)],
                   user: ManagerOrAdmin):
    p = get_or_404(db, Product, product_id)
    db.delete(p)
    db.commit()
    write_audit(db, user, "DELETE", "products", product_id, f"Deleted product {p.model}")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ============================================================================
# Mobile-camera / OCR-lite product recognition
# ============================================================================

class RecognizeRequest(BaseModel):
    """Mobile camera upload — base64 JPEG/PNG, optional barcode hints typed
    by the user, optional GPS, optional notes from the chat."""
    image_base64: str = Field(..., description="base64-encoded JPEG/PNG")
    barcode_hint: str = ""
    text_hint: str = ""
    notes: str = ""
    use_ocr: bool = True


class RecognizeCandidate(BaseModel):
    product_id: Optional[int] = None
    item_code: str = ""
    model: str = ""
    category: Optional[str] = None
    barcode: str = ""
    score: float = 0.0
    reason: str = ""


class RecognizeResponse(BaseModel):
    found: bool
    candidates: list[RecognizeCandidate] = []
    extracted: dict = {}
    matched_product: Optional[dict] = None
    next_step: str = ""   # LOOKUP_OK | NEEDS_BARCODE | NEEDS_CONFIRMATION | NO_MATCH
    message: str = ""


# Known vendor+model fingerprints — Phase 7 lite OCR. Replace with a real OCR
# service (Vision API / Tesseract / Scanbot Document SDK) when budget allows.
_OCR_FINGERPRINTS = [
    {
        "match": "steinel", "vendor": "Steinel",
        "models": [
            {"name": "HL 1620 S", "code": "STEINEL-HL1620S",
             "uom": "Each", "category": "store",
             "specs": "1600 W hot-air tool, 2-stage 300/500°C, "
                      "2-stage 240/500 l/min, 3-year warranty."},
            {"name": "HL 1820 S", "code": "STEINEL-HL1820S",
             "uom": "Each", "category": "store",
             "specs": "2300 W hot-air tool, variable temperature."},
            {"name": "HL 1910 E", "code": "STEINEL-HL1910E",
             "uom": "Each", "category": "store",
             "specs": "2000 W hot-air tool with LCD."},
        ],
    },
    {
        "match": "speedglas", "vendor": "3M",
        "models": [
            {"name": "Adflo Particle Filter P SL", "code": "3M-837010",
             "barcode": "4040355969110", "stock_code": "UU012118871",
             "uom": "Pack", "category": "trading",
             "specs": "3M Adflo Particle Filter P SL — 2 filters per pack, "
                      "EXP 05/2031, HSN 9020, country of origin Poland, "
                      "imported 06/2026."},
        ],
    },
]


def _lite_ocr(image_b64: str) -> dict:
    """No real OCR (intentionally license-free). Returns a fingerprint hint
    based on the base64 payload length — a real implementation would call
    Google Vision API, Tesseract, or Scanbot Document SDK here. The endpoint
    contract stays the same so the OCR backend can be swapped later."""
    return {
        "ocr_engine": "lite-fingerprint",
        "image_size_bytes": len(image_b64),
        "note": "Upgrade to Google Vision / Tesseract / Scanbot SDK for real OCR.",
    }


def _extract_text_signals(req: RecognizeRequest) -> list[str]:
    """Combine everything the user typed + barcode hint + notes into one
    searchable bag of text. The mobile UI lets the user chat while snapping
    a photo, so their typed hints guide the recognition."""
    bits = []
    if req.barcode_hint:
        bits.append(req.barcode_hint.strip())
    if req.text_hint:
        bits.append(req.text_hint.strip())
    if req.notes:
        bits.append(req.notes.strip())
    return [b for b in bits if b]


@router.post("/recognize", response_model=RecognizeResponse)
def recognize_product(
    req: RecognizeRequest,
    db: Annotated[Session, Depends(get_db)],
    _: CurrentUser,
):
    """Mobile-camera product recognition.

    Two-tier lookup:
      1. If `barcode_hint` is provided, try the exact barcode lookup first.
      2. Otherwise, score every known OCR fingerprint against the user's
         text signals (vendor, model, stock_code, part number, etc.) and
         return the top-3 candidates with confidence scores.

    On a real install, plug in Google Vision / Tesseract / Scanbot Document
    SDK and write the extracted text into `extracted.text` before scoring.
    """
    extracted = _lite_ocr(req.image_base64)
    text_signals = _extract_text_signals(req)

    # ----- Tier 1: exact barcode lookup -----
    if req.barcode_hint:
        p = db.scalar(select(Product).where(
            or_(Product.barcode == req.barcode_hint.strip(),
                Product.item_code == req.barcode_hint.strip())
        ))
        if p is not None:
            return RecognizeResponse(
                found=True,
                matched_product={
                    "id": p.id, "item_code": p.item_code, "model": p.model,
                    "category": p.category.value if p.category else None,
                    "barcode": p.barcode, "uom": p.uom,
                    "weight_per_unit": p.weight_per_unit,
                    "weight_uom": p.weight_uom,
                    "standard_rate": float(p.standard_rate) if p.standard_rate else None,
                    "hsn_code": p.hsn_code, "gst_rate": p.gst_rate,
                },
                candidates=[RecognizeCandidate(
                    product_id=p.id, item_code=p.item_code, model=p.model,
                    category=p.category.value if p.category else None,
                    barcode=p.barcode, score=1.0,
                    reason=f"Exact barcode match on {req.barcode_hint}",
                )],
                extracted=extracted,
                next_step="LOOKUP_OK",
                message=f"Identified: {p.model}",
            )

    # ----- Tier 2: fingerprint scoring -----
    candidates: list[RecognizeCandidate] = []
    bag = " ".join(text_signals).lower()
    for fp in _OCR_FINGERPRINTS:
        for m in fp["models"]:
            score = 0.0
            reasons: list[str] = []
            if fp["match"] in bag:
                score += 0.3
                reasons.append(f"vendor '{fp['vendor']}'")
            if m["name"].lower() in bag:
                score += 0.4
                reasons.append(f"model '{m['name']}'")
            if m.get("code", "").lower() in bag:
                score += 0.3
                reasons.append(f"code '{m['code']}'")
            if m.get("barcode", "") and m["barcode"] in bag:
                score += 0.4
                reasons.append(f"ean '{m['barcode']}'")
            if m.get("stock_code", "") and m["stock_code"].lower() in bag:
                score += 0.4
                reasons.append(f"stock code '{m['stock_code']}'")
            if score > 0:
                candidates.append(RecognizeCandidate(
                    item_code=m.get("code", ""),
                    model=m["name"],
                    category=m.get("category"),
                    barcode=m.get("barcode", ""),
                    score=min(score, 1.0),
                    reason="; ".join(reasons),
                ))

    # ----- Tier 3: DB match on text signals (alias + model) -----
    for sig in text_signals:
        s = sig.lower()
        like = f"%{s}%"
        p = db.scalar(select(Product).where(or_(
            Product.model.ilike(like),
            Product.item_code.ilike(like),
            Product.barcode.ilike(like),
            Product.name.ilike(like),
        )))
        if p is not None and not any(c.product_id == p.id for c in candidates):
            candidates.append(RecognizeCandidate(
                product_id=p.id, item_code=p.item_code, model=p.model,
                category=p.category.value if p.category else None,
                barcode=p.barcode, score=0.5,
                reason=f"DB match on '{sig}'",
            ))

    candidates.sort(key=lambda c: -c.score)
    top = candidates[:5]

    if not top:
        return RecognizeResponse(
            found=False, candidates=[], extracted=extracted,
            next_step="NEEDS_BARCODE",
            message=("No product matched. Scan the barcode or type the vendor + "
                     "model (e.g. '3M Adflo 837010', 'Steinel HL 1620 S')."),
        )

    if top[0].score >= 0.7:
        if top[0].product_id:
            p = db.get(Product, top[0].product_id)
            if p is not None:
                return RecognizeResponse(
                    found=True,
                    matched_product={
                        "id": p.id, "item_code": p.item_code, "model": p.model,
                        "category": p.category.value if p.category else None,
                        "barcode": p.barcode, "uom": p.uom,
                        "weight_per_unit": p.weight_per_unit,
                        "weight_uom": p.weight_uom,
                        "standard_rate": float(p.standard_rate) if p.standard_rate else None,
                        "hsn_code": p.hsn_code, "gst_rate": p.gst_rate,
                    },
                    candidates=top,
                    extracted=extracted,
                    next_step="LOOKUP_OK",
                    message=f"Identified: {p.model}",
                )
        return RecognizeResponse(
            found=False, candidates=top, extracted=extracted,
            next_step="NEEDS_CONFIRMATION",
            message=("Likely match found. Confirm to create the product."),
        )

    return RecognizeResponse(
        found=False, candidates=top, extracted=extracted,
        next_step="NEEDS_CONFIRMATION",
        message="Possible matches found. Review and confirm.",
    )


class ConfirmRequest(BaseModel):
    candidate: RecognizeCandidate
    extras: dict = Field(default_factory=dict)


@router.post("/recognize/confirm", response_model=dict)
def recognize_confirm(
    req: ConfirmRequest, db: Annotated[Session, Depends(get_db)],
    user: ManagerOrAdmin,
):
    """Create a new product from a recognition candidate (or update if the
    candidate already has a product_id). Mobile-camera flow ends here."""
    c = req.candidate
    extras = req.extras or {}

    if c.product_id:
        p = get_or_404(db, Product, c.product_id)
        if extras.get("standard_rate") is not None:
            p.standard_rate = extras["standard_rate"]
        if extras.get("hsn_code"):
            p.hsn_code = extras["hsn_code"]
        if extras.get("gst_rate") is not None:
            p.gst_rate = extras["gst_rate"]
        if extras.get("weight_per_unit") is not None:
            p.weight_per_unit = extras["weight_per_unit"]
        db.commit()
        db.refresh(p)
        write_audit(db, user, "UPDATE", "products", p.id,
                    f"Mobile-camera update: {p.model}")
        return {"created": False, "product": {
            "id": p.id, "item_code": p.item_code, "model": p.model,
            "barcode": p.barcode, "category": p.category.value,
        }}

    p = Product(
        item_code=c.item_code or f"AUTO-{int(__import__('time').time())}",
        model=c.model or "Unknown",
        category=ProductCategory(c.category) if c.category else ProductCategory.store,
        uom=extras.get("uom", "Each"),
        barcode=c.barcode or c.item_code or "",
        barcode_format="CODE128",
        weight_per_unit=extras.get("weight_per_unit"),
        weight_uom=extras.get("weight_uom", "KG"),
        standard_rate=extras.get("standard_rate"),
        hsn_code=extras.get("hsn_code", ""),
        gst_rate=extras.get("gst_rate"),
        name=extras.get("name", c.model or ""),
        is_active=True,
    )
    db.add(p)
    try:
        db.commit()
    except Exception as exc:
        db.rollback()
        log.warning("recognize/confirm: %s", exc)
        # Reuse existing on unique-conflict
        p = db.scalar(select(Product).where(Product.item_code == p.item_code))
        if p is None:
            raise status.HTTP_409_CONFLICT
    db.refresh(p)
    write_audit(db, user, "CREATE", "products", p.id,
                f"Mobile-camera create: {p.model} ({p.item_code})")
    return {"created": True, "product": {
        "id": p.id, "item_code": p.item_code, "model": p.model,
        "barcode": p.barcode, "category": p.category.value,
    }}