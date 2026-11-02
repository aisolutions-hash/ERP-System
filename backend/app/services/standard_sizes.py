"""Standard Size Master: Excel parsing, validation, preview and import.

The master is intentionally separate from Product/Inventory. Import only links
rows to an existing product when the item code already exists; it never creates
or edits inventory items. Blank cells stay blank (NULL) rather than becoming 0.
"""
from __future__ import annotations

import re
from io import BytesIO
from pathlib import Path
from typing import Any

import pandas as pd
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import Product, StandardSize
from .import_common import (
    build_column_map, cell_num, cell_text, is_blank_row, normalize_header,
    row_to_dict,
)

# The workbook shipped with the application (used for the one-time seed).
SOURCE_FILE = Path(__file__).resolve().parent.parent / "assets" / "Standard_Size.xlsx"

HEADER_ALIASES: dict[str, list[str]] = {
    "size_inches": ["size in inches", "size in inch", "size inches", "inches",
                    "size (inches)", "size\""],
    "size_mm": ["size in mm", "size in millimeters", "size in millimetres",
                "size mm", "mm", "size (mm)"],
    "number_of_rolls": ["no of roll", "no of rolls", "number of rolls", "rolls",
                        "no. of rolls", "roll count"],
    "tare_weight_6mm": ["tare weight 6 mm", "tare weight 6mm", "tare wt 6 mm",
                        "tare wt 6mm", "tare 6 mm"],
    "tare_weight_10mm": ["tare weight 10 mm", "tare weight 10mm", "tare wt 10 mm",
                         "tare wt 10mm", "tare 10 mm"],
    "tare_weight_12mm": ["tare weight 12 mm", "tare weight 12mm", "tare wt 12 mm",
                         "tare wt 12mm", "tare 12 mm"],
    "gross_weight": ["gross weight", "gross weight / weight range", "gross weight range",
                     "weight range", "gross wt"],
    "item_code": ["item code", "item code no", "code", "paper core item code",
                  "product code"],
    "material_description": ["description", "material description", "material",
                             "particulars", "product description"],
    "paper_core_weight": ["paper core weight", "core weight", "weight", "paper core wt"],
    "status": ["status"],
}

FIELD_LABELS = {
    "size_inches": "Size in Inches",
    "size_mm": "Size in MM",
    "number_of_rolls": "Number of Rolls",
    "tare_weight_6mm": "Tare Weight 6 mm",
    "tare_weight_10mm": "Tare Weight 10 mm",
    "tare_weight_12mm": "Tare Weight 12 mm",
    "gross_weight": "Gross Weight / Weight Range",
    "item_code": "Item Code",
    "material_description": "Material Description",
    "paper_core_weight": "Paper Core Weight",
    "status": "Status",
}

_NA = {"", "NA", "N/A", "-", "--", "NIL", "NULL"}
_NUM_RE = re.compile(r"\d+(?:\.\d+)?")


def _is_blank(value: Any) -> bool:
    return cell_text(value).strip().upper() in _NA


def parse_dimension(value: Any) -> float | None:
    """Read '2\"', '50mm' or 2.5 into a number; blank/NA stays NULL."""
    if _is_blank(value):
        return None
    match = _NUM_RE.search(cell_text(value))
    return float(match.group()) if match else None


def size_key(size_inches: float | None, size_mm: float | None) -> tuple | None:
    """Identity of a standard size: inches when supplied, otherwise millimetres."""
    if size_inches is not None:
        return ("in", round(float(size_inches), 4))
    if size_mm is not None:
        return ("mm", round(float(size_mm), 4))
    return None


def _read_rows(filename: str, content: bytes) -> list[list[Any]]:
    name = (filename or "").lower()
    if name.endswith(".csv"):
        df = pd.read_csv(BytesIO(content), header=None, dtype=object,
                         keep_default_na=False)
    else:
        df = pd.read_excel(BytesIO(content), header=None, dtype=object,
                           keep_default_na=False)
    return [list(row) for row in df.values.tolist()]


def _header_index(rows: list[list[Any]]) -> int | None:
    known = {normalize_header(n) for names in HEADER_ALIASES.values() for n in names}
    for idx, row in enumerate(rows):
        hits = sum(1 for c in row if normalize_header(c) in known)
        if hits >= 2:
            return idx
    return None


def read_standard_size_table(filename: str, content: bytes):
    """Return (headers, data_rows, colmap, header_idx) using any column order."""
    rows = _read_rows(filename, content)
    header_idx = _header_index(rows)
    if header_idx is None:
        raise ValueError(
            "Could not find a header row. Expected columns such as "
            "'Size in inches', 'Size in MM', 'No of roll', 'Item Code', "
            "'Description' and 'Weight'."
        )
    headers = [cell_text(c) for c in rows[header_idx]]
    colmap = build_column_map(headers, HEADER_ALIASES)
    if "size_inches" not in colmap.values() and "size_mm" not in colmap.values():
        raise ValueError("The file has no Size in Inches / Size in MM column.")
    mapping = {field: headers[idx] for idx, field in colmap.items()}
    return headers, rows[header_idx + 1:], colmap, header_idx, mapping


def _optional_number(mapped: dict, field: str, errors: list[str]) -> float | None:
    raw = mapped.get(field)
    if _is_blank(raw):
        return None
    number = cell_num(raw)
    if number is None:
        errors.append(f"Invalid {FIELD_LABELS[field]}")
        return None
    if number < 0:
        errors.append(f"{FIELD_LABELS[field]} cannot be negative")
        return None
    return number


def parse_standard_size_rows(filename: str, content: bytes) -> dict:
    headers, data, colmap, header_idx, mapping = read_standard_size_table(
        filename, content
    )
    parsed: list[dict] = []
    seen: dict[tuple, int] = {}

    for offset, raw in enumerate(data):
        mapped = row_to_dict(colmap, raw)
        if is_blank_row(mapped):
            continue

        row_no = header_idx + 2 + offset
        errors: list[str] = []
        warnings: list[str] = []

        inches_raw = mapped.get("size_inches")
        mm_raw = mapped.get("size_mm")
        inches = parse_dimension(inches_raw)
        mm = parse_dimension(mm_raw)
        if _is_blank(inches_raw) and _is_blank(mm_raw):
            errors.append("Missing size (inches / mm)")
        else:
            if not _is_blank(inches_raw) and inches is None:
                errors.append("Invalid Size in Inches")
            if not _is_blank(mm_raw) and mm is None:
                errors.append("Invalid Size in MM")

        rolls_value = _optional_number(mapped, "number_of_rolls", errors)
        rolls = int(round(rolls_value)) if rolls_value is not None else None
        if rolls_value is not None and abs(rolls_value - rolls) > 1e-9:
            errors.append("Number of Rolls must be a whole number")

        tare6 = _optional_number(mapped, "tare_weight_6mm", errors)
        tare10 = _optional_number(mapped, "tare_weight_10mm", errors)
        tare12 = _optional_number(mapped, "tare_weight_12mm", errors)

        status_text = cell_text(mapped.get("status")).strip().title()
        status = status_text if status_text in ("Active", "Inactive") else "Active"
        if status_text and status_text not in ("Active", "Inactive"):
            warnings.append(f"Unknown status {status_text!r}; defaulted to Active")

        key = size_key(inches, mm)
        duplicate_row = seen.get(key) if key else None
        if key and duplicate_row is None:
            seen[key] = row_no
        elif duplicate_row is not None:
            warnings.append(f"Duplicate size of row {duplicate_row}")

        parsed.append({
            "row": row_no,
            "size_inches": inches,
            "size_mm": mm,
            "number_of_rolls": rolls,
            "tare_weight_6mm": tare6,
            "tare_weight_10mm": tare10,
            "tare_weight_12mm": tare12,
            "gross_weight": cell_text(mapped.get("gross_weight")),
            "item_code": cell_text(mapped.get("item_code")),
            "material_description": cell_text(mapped.get("material_description")),
            "paper_core_weight": cell_text(mapped.get("paper_core_weight")),
            "status": status,
            "remarks": "",
            "errors": errors,
            "warnings": warnings,
            "duplicate_of": None,
            "duplicate_row": duplicate_row,
        })

    return {"headers": headers, "mapping": mapping, "rows": parsed}


def _product_index(db: Session) -> dict[str, Product]:
    return {
        (p.item_code or "").strip().lower(): p
        for p in db.scalars(select(Product)).all()
        if (p.item_code or "").strip()
    }


def _existing_index(db: Session) -> dict[tuple, StandardSize]:
    index: dict[tuple, StandardSize] = {}
    for row in db.scalars(select(StandardSize)).all():
        key = size_key(row.size_inches, row.size_mm)
        if key and key not in index:
            index[key] = row
    return index


def _annotate(db: Session, parsed: dict) -> dict:
    products = _product_index(db)
    existing = _existing_index(db)
    for row in parsed["rows"]:
        if row["errors"]:
            row["status_label"] = "Invalid"
            continue
        product = products.get(row["item_code"].lower()) if row["item_code"] else None
        row["product_id"] = product.id if product else None
        match = existing.get(size_key(row["size_inches"], row["size_mm"]))
        if match is not None:
            row["duplicate_of"] = match.id
            row["status_label"] = "Duplicate"
            row["warnings"].append(
                f"Already exists as record #{match.id}"
                f"{f' ({match.item_code})' if match.item_code else ''}"
            )
        elif row["duplicate_row"] is not None:
            row["status_label"] = "Duplicate"
        else:
            row["status_label"] = "Valid"
    parsed["summary"] = {
        "total": len(parsed["rows"]),
        "valid": sum(1 for r in parsed["rows"] if r["status_label"] == "Valid"),
        "duplicates": sum(1 for r in parsed["rows"] if r["status_label"] == "Duplicate"),
        "invalid": sum(1 for r in parsed["rows"] if r["status_label"] == "Invalid"),
    }
    return parsed


def preview_standard_sizes(db: Session, filename: str, content: bytes) -> dict:
    return _annotate(db, parse_standard_size_rows(filename, content))


def import_standard_sizes(db: Session, filename: str, content: bytes,
                          user_name: str = "System Import") -> dict:
    preview = preview_standard_sizes(db, filename, content)
    imported = skipped = failed = 0
    for row in preview["rows"]:
        if row["errors"]:
            row["result"] = "Failed"
            failed += 1
            continue
        if row["duplicate_of"] is not None or row["duplicate_row"] is not None:
            row["result"] = "Skipped (already exists)"
            skipped += 1
            continue
        db.add(StandardSize(
            size_inches=row["size_inches"],
            size_mm=row["size_mm"],
            number_of_rolls=row["number_of_rolls"],
            tare_weight_6mm=row["tare_weight_6mm"],
            tare_weight_10mm=row["tare_weight_10mm"],
            tare_weight_12mm=row["tare_weight_12mm"],
            gross_weight=row["gross_weight"],
            item_code=row["item_code"],
            material_description=row["material_description"],
            paper_core_weight=row["paper_core_weight"],
            status=row["status"],
            remarks=row["remarks"],
            product_id=row.get("product_id"),
            created_by=user_name,
            updated_by=user_name,
        ))
        row["result"] = "Imported"
        imported += 1
    db.commit()
    return {
        "headers": preview["headers"],
        "mapping": preview["mapping"],
        "rows": preview["rows"],
        "summary": {
            "total": len(preview["rows"]),
            "imported": imported,
            "skipped": skipped,
            "failed": failed,
        },
    }


def seed_standard_sizes(db: Session, path: Path | None = None) -> dict:
    """One-time seed from the bundled workbook; a non-empty master is left alone."""
    count = db.scalar(select(func.count()).select_from(StandardSize)) or 0
    source = path or SOURCE_FILE
    if count:
        return {"seeded": 0, "reason": "master already has records"}
    if not source.is_file():
        return {"seeded": 0, "reason": f"source file not found: {source}"}
    result = import_standard_sizes(
        db, source.name, source.read_bytes(), user_name="System Import"
    )
    return {"seeded": result["summary"]["imported"], **result["summary"]}
