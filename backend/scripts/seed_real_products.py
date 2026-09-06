"""Seed real-world product data captured from supplier labels.

Run once to populate the catalogue with the Steinel + 3M products the
operator has on hand. Idempotent: re-runs update the row in place.
"""
from __future__ import annotations

import logging
from datetime import date

from sqlalchemy import select

from app.database import SessionLocal
from app.models import (
    Inventory, Product, ProductCategory, ProductSourceType,
)

log = logging.getLogger("kalika.seed")

SEED_PRODUCTS = [
    {
        "item_code": "STEINEL-HL1620S",
        "model": "Steinel HL 1620 S — 1600 W Hot Air Tool",
        "name": "Steinel HL 1620 S 1600 W Hot Air Blower (Heißluftgebläse)",
        "category": ProductCategory.store,
        "uom": "Each",
        "barcode": "STEINEL-HL1620S",
        "barcode_format": "CODE128",
        "weight_per_unit": 1.4,    # Steinel HL 1620 S is ~1.4 kg
        "weight_uom": "KG",
        "standard_rate": 14500.0,
        "hsn_code": "8516",
        "gst_rate": 18.0,
        "sourcing_note": "Imported Steinel hot-air tool. 2-stage 300/500°C, 240/500 l/min, 3-yr warranty.",
        "source_excel": "MOBILE_CAMERA:steinel-hl-1620s",
        "open_qty": 2,
    },
    {
        "item_code": "3M-837010",
        "model": "3M Adflo Particle Filter P SL (2-pack)",
        "name": "3M Speedglas Adflo Particle Filter P SL — 1 pack of 2 filters",
        "category": ProductCategory.trading,
        "uom": "Pack",
        "barcode": "4040355969110",   # EAN-13 from the box
        "barcode_format": "EAN13",
        "weight_per_unit": 0.18,       # ~90 g each filter x 2
        "weight_uom": "KG",
        "standard_rate": 4200.0,
        "hsn_code": "9020",
        "gst_rate": 18.0,
        "sourcing_note": (
            "3M Speedglas Adflo Particle Filter P SL. "
            "Stock code UU012118871, part 837010, EXP 05/2031, "
            "imported 06/2026, country of origin Poland, "
            "importer 3M India Ltd."
        ),
        "source_excel": "MOBILE_CAMERA:3m-adflo-837010",
        "open_qty": 24,                # 12 packs × 2 filters
    },
]


def run() -> None:
    db = SessionLocal()
    try:
        for spec in SEED_PRODUCTS:
            existing = db.scalar(
                select(Product).where(Product.item_code == spec["item_code"])
            )
            if existing is None:
                p = Product(
                    item_code=spec["item_code"],
                    model=spec["model"],
                    name=spec["name"],
                    category=spec["category"],
                    source_type=ProductSourceType.trading,
                    uom=spec["uom"],
                    barcode=spec["barcode"],
                    barcode_format=spec["barcode_format"],
                    weight_per_unit=spec["weight_per_unit"],
                    weight_uom=spec["weight_uom"],
                    standard_rate=spec["standard_rate"],
                    hsn_code=spec["hsn_code"],
                    gst_rate=spec["gst_rate"],
                    sourcing_note=spec["sourcing_note"],
                    source_excel=spec["source_excel"],
                    is_active=True,
                )
                db.add(p)
                db.flush()
                inv = Inventory(
                    product_id=p.id, plant_id=None,
                    opening_stock=spec["open_qty"],
                    received_qty=0, issued_qty=0,
                    current_stock=spec["open_qty"],
                )
                db.add(inv)
                log.info("seeded %s id=%d", spec["item_code"], p.id)
            else:
                # Keep stock/import-batch columns alone, refresh spec fields.
                existing.model = spec["model"]
                existing.name = spec["name"]
                existing.uom = spec["uom"]
                existing.barcode = spec["barcode"]
                existing.weight_per_unit = spec["weight_per_unit"]
                existing.weight_uom = spec["weight_uom"]
                existing.standard_rate = spec["standard_rate"]
                existing.hsn_code = spec["hsn_code"]
                existing.gst_rate = spec["gst_rate"]
                existing.sourcing_note = spec["sourcing_note"]
                log.info("updated %s id=%d", spec["item_code"], existing.id)
        db.commit()
    finally:
        db.close()
    log.info("seed complete")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run()
