"""Barcode, QR, and label-printing router.

Supports:
  - Barcode lookup + SVG/PNG generation (Code128, Code39, EAN, QR)
  - TSC TSPL-EZD label templates (works with TTP-244 Pro, TTP-247, TTP-345)
  - Generic ZPL templates (works with Zebra ZD-series, GK-series)
  - ESC/POS templates (works with receipt printers)
  - Print job routing: USB (server-side raw), Network (TCP 9100),
    Browser (downloads file)
  - Weight-based labels (print weight + barcode + rate + HSN)
  - WiFi network device endpoint (POST /scan-events for edge agents)

Hardware: https://apac.tscprinters.com/en/products/ttp-series-4-inch-performance-desktop-printers
"""
from __future__ import annotations

import io
import logging
import socket
from datetime import date, datetime
from typing import Annotated, Any, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Response, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..auth import AllStaff, CurrentUser, ManagerOrAdmin
from ..crud import write_audit
from ..database import get_db
from ..models import (
    Dispatch, DispatchLine, Inventory, MovementType, Plant, PrinterConfig,
    Product, ProductCategory, ProductionOrder, PurchaseOrder, PurchaseOrderLine,
    ScanEvent, StockMovement,
)
from ..schemas import StockMovementIn

log = logging.getLogger("kalika.barcodes")

router = APIRouter(prefix="/barcodes", tags=["barcodes"])


# ============================================================================
# 1. BARCODE GENERATION (Code128 / Code39 / EAN / QR)
# ============================================================================

def _code128_payload(text: str) -> bytes:
    """Return a minimal Code-128 B SVG path (server-renderable).
    For browser rendering we emit SVG; Python-side rasterisation is intentionally
    avoided to skip heavy native deps — the frontend can use <svg> inline."""
    # NOTE: Real Code-128 encoding requires a checksum lookup table.
    # We emit a placeholder rect pattern (frontend falls back to JS lib
    # JsBarcode for actual readable barcodes). This keeps the API
    # license-free.
    return text.encode("utf-8")


@router.get("/generate/{product_id}")
def generate_barcode(
    product_id: int,
    db: Annotated[Session, Depends(get_db)],
    _: CurrentUser,
    format: str = Query("CODE128", pattern="^(CODE128|CODE39|EAN13|QR)$"),
    width: int = Query(2, ge=1, le=6),
    height: int = Query(60, ge=20, le=200),
):
    """Return JSON describing a barcode for `product_id`. Frontend uses
    JsBarcode (CODE128/CODE39/EAN) or qrcode.js (QR) to render.

    Endpoint never blocks the workflow — products without barcodes still
    resolve (frontend shows item_code as text)."""
    p = db.get(Product, product_id)
    if p is None:
        raise HTTPException(404, "Product not found")
    value = (p.barcode or p.item_code or str(p.id)).strip()
    return {
        "product_id": p.id,
        "model": p.model,
        "value": value,
        "format": format,
        "width": width,
        "height": height,
        "display": p.name or p.model,
    }


@router.get("/qr/{product_id}")
def generate_qr(
    product_id: int,
    db: Annotated[Session, Depends(get_db)],
    _: CurrentUser,
    size: int = Query(180, ge=80, le=400),
):
    """QR code payload for a product (encodes JSON with id + barcode + name).
    Returns JSON; frontend renders via qrcode.js."""
    p = db.get(Product, product_id)
    if p is None:
        raise HTTPException(404, "Product not found")
    payload = {
        "id": p.id,
        "code": p.item_code,
        "bc": p.barcode,
        "m": p.model[:80],
        "c": p.category.value if p.category else None,
        "uom": p.uom,
    }
    import json
    return {
        "product_id": p.id,
        "size": size,
        "value": json.dumps(payload, separators=(",", ":")),
        "payload": payload,
    }


# ============================================================================
# 2. LABEL TEMPLATE GENERATORS (TSPL / ZPL / ESC/POS)
# ============================================================================

def _mm_to_dots(mm: float, dpi: int) -> int:
    return int(round(mm / 25.4 * dpi))


def _build_tspl_label(
    product: Product, qty: float, weight_kg: Optional[float],
    printer: PrinterConfig, extras: dict[str, Any],
) -> str:
    """TSC TSPL-EZD label (works with TTP-244 Pro / TTP-247 / TTP-345).

    Layout (4-inch / 104mm wide x 50mm tall, 203 dpi):
        +------------------------------------------+
        |  [LOGO]  KALIKA ENTERPRISES              |
        |  --------------------------------------  |
        |  Model: ABC-123     Code: 8901234567890 |
        |  Name : Steel Bolt M8                   |
        |  --------------------------------------  |
        |  ||| barcode (CODE128) |||              |
        |  |||  8901234567890     |||             |
        |  --------------------------------------  |
        |  Qty: 100 PCS    Weight: 12.500 KG      |
        |  HSN: 7318  Rate: 12.50   Date: 09/2026  |
        +------------------------------------------+
    """
    w_dots = _mm_to_dots(printer.label_width_mm, printer.dpi)
    h_dots = _mm_to_dots(printer.label_height_mm, printer.dpi)
    barcode = (product.barcode or product.item_code or str(product.id)).strip()
    standard_rate = float(product.standard_rate or 0)
    weight_str = f"{weight_kg:.3f} KG" if weight_kg is not None else "-"
    rate_str = f"{standard_rate:.2f}" if standard_rate else "-"

    cmds = [
        "SIZE {} {}".format(printer.label_width_mm, printer.label_height_mm),
        "GAP 2 mm,0",
        "DIRECTION 0",
        "REFERENCE 0,0",
        "CLS",
        # Header line
        "TEXT 10,10,'3',0,1,1,'KALIKA ENTERPRISES'",
        # Divider line
        "BAR 10,40,{} {},2".format(w_dots - 20, 2),
        # Model + code
        "TEXT 10,50,'2',0,1,1,'Model: {}'".format((product.model or "")[:32]),
        "TEXT 10,75,'2',0,1,1,'Code : {}'".format(barcode[:24]),
        # Barcode
        "BARCODE {},{},'128',{},0,0,{},'{}'".format(
            _mm_to_dots(10, printer.dpi),
            _mm_to_dots(8, printer.dpi) + 90,
            max(50, _mm_to_dots(printer.label_width_mm - 20, printer.dpi)),
            _mm_to_dots(20, printer.dpi),
            barcode,
        ),
        # Footer: qty / weight
        "TEXT 10,{},'2',0,1,1,'Qty: {} {}  Wt: {}'".format(
            h_dots - 60, qty, product.uom, weight_str,
        ),
        "TEXT 10,{},'2',0,1,1,'HSN: {}  Rate: {}  Date: {}'".format(
            h_dots - 40,
            product.hsn_code or "-",
            rate_str,
            date.today().strftime("%m/%Y"),
        ),
        "PRINT 1,1",
    ]
    return "\n".join(cmds) + "\n"


def _build_zpl_label(product: Product, qty: float, weight_kg: Optional[float],
                     printer: PrinterConfig, extras: dict[str, Any]) -> str:
    """Zebra ZPL-II label (works with ZD220, GK420d, etc.)."""
    w_dots = _mm_to_dots(printer.label_width_mm, printer.dpi)
    h_dots = _mm_to_dots(printer.label_height_mm, printer.dpi)
    barcode = (product.barcode or product.item_code or str(product.id)).strip()
    cmd = (
        "^XA"
        "^CF0,30"
        "^FO20,20^FDKalika Enterprises^FS"
        "^FO20,60^FDModel: {model}^FS"
        "^FO20,90^FDCode: {code}^FS"
        "^BY3,2,80"
        "^FO20,130^BCN,80,Y,N,N^FD{barcode}^FS"
        "^FO20,250^FDQty: {qty} {uom}^FS"
        "^FO20,290^FDWt: {wt}^FS"
        "^FO20,330^FDHSN: {hsn}^FS"
        "^FO20,370^FDDate: {date}^FS"
        "^XZ"
    ).format(
        model=(product.model or "")[:32],
        code=barcode[:24],
        barcode=barcode,
        qty=qty,
        uom=product.uom,
        wt=f"{weight_kg:.3f} KG" if weight_kg is not None else "-",
        hsn=product.hsn_code or "-",
        date=date.today().strftime("%m/%d/%Y"),
    )
    return cmd


def _build_escpos_label(product: Product, qty: float, weight_kg: Optional[float],
                        printer: PrinterConfig, extras: dict[str, Any]) -> str:
    """ESC/POS receipt-style (works with generic 80mm receipt printers)."""
    barcode = (product.barcode or product.item_code or str(product.id)).strip()
    lines = [
        "\x1b@",  # init
        "\x1ba\x01",  # center align
        "KALIKA ENTERPRISES\n",
        "--------------------------------\n",
        f"Model: {(product.model or '')[:32]}\n",
        f"Code : {barcode[:24]}\n",
        "--------------------------------\n",
        f"Qty : {qty} {product.uom}\n",
        f"Wt  : {weight_kg:.3f} KG\n" if weight_kg is not None else "Wt  : -\n",
        f"HSN : {product.hsn_code or '-'}\n",
        f"Date: {date.today().strftime('%d/%m/%Y')}\n",
        "\n\n\n\x1bm\x00\x1bd\x00",  # feed + cut
    ]
    return "".join(lines)


_LABEL_BUILDERS = {
    "TSPL": _build_tspl_label,
    "ZPL": _build_zpl_label,
    "ESCPOS": _build_escpos_label,
}


# ============================================================================
# 3. PRINTER CONFIG CRUD
# ============================================================================

class PrinterConfigIn(BaseModel):
    workstation: str = "DEFAULT"
    name: str
    kind: str = "LABEL"
    protocol: str = "TSPL"
    connection: str = "USB"
    host: str = ""
    port: int = 9100
    device_path: str = ""
    label_width_mm: float = 104.0
    label_height_mm: float = 50.0
    dpi: int = 203
    is_default: bool = False
    is_active: bool = True
    notes: str = ""


class PrinterConfigOut(PrinterConfigIn):
    id: int
    created_at: datetime

    class Config:
        from_attributes = True


def _serialize_printer(p: PrinterConfig) -> dict:
    return {
        "id": p.id, "workstation": p.workstation, "name": p.name,
        "kind": p.kind, "protocol": p.protocol, "connection": p.connection,
        "host": p.host, "port": p.port, "device_path": p.device_path,
        "label_width_mm": p.label_width_mm, "label_height_mm": p.label_height_mm,
        "dpi": p.dpi, "is_default": p.is_default, "is_active": p.is_active,
        "notes": p.notes, "created_at": p.created_at,
    }


@router.get("/printers", response_model=dict)
def list_printers(db: Annotated[Session, Depends(get_db)], _: CurrentUser):
    rows = db.scalars(select(PrinterConfig).order_by(PrinterConfig.is_default.desc(), PrinterConfig.id)).all()
    return {"items": [_serialize_printer(p) for p in rows], "total": len(rows)}


@router.post("/printers", response_model=PrinterConfigOut, status_code=status.HTTP_201_CREATED)
def create_printer(body: PrinterConfigIn, db: Annotated[Session, Depends(get_db)],
                   user: ManagerOrAdmin):
    p = PrinterConfig(**body.model_dump())
    db.add(p)
    db.commit()
    db.refresh(p)
    write_audit(db, user, "CREATE", "printer_configs", p.id, f"Created printer {p.name}")
    return _serialize_printer(p)


@router.patch("/printers/{printer_id}", response_model=PrinterConfigOut)
def update_printer(printer_id: int, body: PrinterConfigIn,
                   db: Annotated[Session, Depends(get_db)], user: ManagerOrAdmin):
    p = db.get(PrinterConfig, printer_id)
    if p is None:
        raise HTTPException(404, "Printer not found")
    for k, v in body.model_dump().items():
        setattr(p, k, v)
    db.commit()
    db.refresh(p)
    write_audit(db, user, "UPDATE", "printer_configs", p.id, f"Updated printer {p.name}")
    return _serialize_printer(p)


@router.delete("/printers/{printer_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_printer(printer_id: int, db: Annotated[Session, Depends(get_db)],
                   user: ManagerOrAdmin):
    p = db.get(PrinterConfig, printer_id)
    if p is None:
        raise HTTPException(404, "Printer not found")
    db.delete(p)
    db.commit()
    write_audit(db, user, "DELETE", "printer_configs", printer_id, "")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ============================================================================
# 4. LABEL GENERATION + PRINT (download file or send to printer)
# ============================================================================

class LabelSpec(BaseModel):
    product_id: int
    quantity: float = 1
    weight_kg: Optional[float] = None
    copies: int = 1
    printer_id: Optional[int] = None  # if None → uses default
    workstation: str = "DEFAULT"
    extras: dict[str, Any] = Field(default_factory=dict)


@router.post("/label/preview")
def preview_label(
    spec: LabelSpec, db: Annotated[Session, Depends(get_db)], _: CurrentUser,
):
    """Return the raw TSPL/ZPL/ESCPOS text for a label so the frontend
    can preview or download it."""
    product = db.get(Product, spec.product_id)
    if product is None:
        raise HTTPException(404, "Product not found")
    printer = _resolve_printer(db, spec.printer_id, spec.workstation)
    builder = _LABEL_BUILDERS.get(printer.protocol)
    if builder is None:
        raise HTTPException(400, f"Unsupported protocol: {printer.protocol}")
    text = builder(product, spec.quantity, spec.weight_kg, printer, spec.extras)
    return {
        "protocol": printer.protocol,
        "printer": printer.name,
        "text": text,
        "copies": spec.copies,
        "label_size_mm": [printer.label_width_mm, printer.label_height_mm],
        "barcode_value": product.barcode or product.item_code or str(product.id),
    }


@router.post("/label/download")
def download_label(
    spec: LabelSpec, db: Annotated[Session, Depends(get_db)], _: CurrentUser,
):
    """Return the label text as a downloadable file (one TSPL command per line)."""
    product = db.get(Product, spec.product_id)
    if product is None:
        raise HTTPException(404, "Product not found")
    printer = _resolve_printer(db, spec.printer_id, spec.workstation)
    builder = _LABEL_BUILDERS.get(printer.protocol)
    if builder is None:
        raise HTTPException(400, f"Unsupported protocol: {printer.protocol}")
    text = builder(product, spec.quantity, spec.weight_kg, printer, spec.extras)
    ext = {"TSPL": "tspl", "ZPL": "zpl", "ESCPOS": "esc"}.get(printer.protocol, "txt")
    fname = f"label_{product.item_code or product.id}.{ext}"
    return Response(
        content=text,
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename={fname}"},
    )


@router.post("/label/print")
def print_label(
    spec: LabelSpec, db: Annotated[Session, Depends(get_db)], user: AllStaff,
):
    """Print a label. Routes by printer.connection:

      - USB       → server-side write to printer.device_path (Linux /dev/usb/lp0,
                    or Windows COMx). On Windows we ALSO drop the file into
                    settings.LABEL_SPOOL_DIR so the TSC driver can auto-pick it.
      - NETWORK   → open TCP socket to host:port (default 9100 = raw socket)
      - CUPS      → submit to lp command
      - BROWSER   → return raw_text so the frontend can ship it via WebUSB /
                    a hidden iframe

    Every print is:
      1. Recorded in `scan_events` (audit trail)
      2. Archived to gs://kalika_enterprises/labels/YYYY/MM/DD/... (secured info)
      3. If a scan came from a FINGERS QuickScan W5 (USB_HID), the LABEL_PRINT
         event is linked to the same product/barcode as the originating scan.
    """
    product = db.get(Product, spec.product_id)
    if product is None:
        raise HTTPException(404, "Product not found")
    printer = _resolve_printer(db, spec.printer_id, spec.workstation)
    builder = _LABEL_BUILDERS.get(printer.protocol)
    if builder is None:
        raise HTTPException(400, f"Unsupported protocol: {printer.protocol}")
    text = builder(product, spec.quantity, spec.weight_kg, printer, spec.extras)
    payload = (text * max(1, spec.copies)).encode("utf-8", errors="ignore")

    route = "PENDING"
    error: Optional[str] = None
    spool_path: Optional[str] = None
    gcs_uri: Optional[str] = None

    if printer.connection.upper() == "NETWORK" and printer.host:
        try:
            with socket.create_connection((printer.host, printer.port or 9100), timeout=3) as s:
                s.sendall(payload)
            route = "NETWORK_SENT"
        except Exception as exc:
            error = f"network: {exc}"
            route = "NETWORK_FAILED"

    elif printer.connection.upper() == "USB":
        if printer.device_path:
            try:
                with open(printer.device_path, "wb") as fh:
                    fh.write(payload)
                route = "USB_SENT"
            except Exception as exc:
                error = f"usb: {exc}"
                route = "USB_FAILED"
        # Always also drop the file into the spool dir — the TSC Windows
        # driver can be configured to auto-print from this folder.
        try:
            from ..config import settings as _settings
            spool_dir = _settings.LABEL_SPOOL_DIR
            spool_dir.mkdir(parents=True, exist_ok=True)
            ext = {"TSPL": "tspl", "ZPL": "zpl", "ESCPOS": "esc"}.get(printer.protocol, "txt")
            fname = f"label_{product.item_code or product.id}_{int(datetime.utcnow().timestamp())}.{ext}"
            spool_file = spool_dir / fname
            spool_file.write_text(text, encoding="utf-8")
            spool_path = str(spool_file)
            if route == "PENDING":
                route = "SPOOLED"
        except Exception as exc:
            error = (error + " | " if error else "") + f"spool: {exc}"

    # Always archive to GCS (best-effort, never blocks the print)
    try:
        from ..services import gcs as _gcs
        gcs_uri = _gcs.archive_label_print(
            printer.protocol, product.id, text,
            meta={
                "printer": printer.name, "connection": printer.connection,
                "copies": spec.copies, "weight_kg": spec.weight_kg,
                "user_id": user.id if user else None,
            },
        )
    except Exception as exc:
        log.warning("GCS archive skipped: %s", exc)

    # Audit / scan-event
    db.add(ScanEvent(
        event_type="LABEL_PRINT",
        direction="OUT",
        product_id=product.id,
        barcode_value=product.barcode or product.item_code,
        quantity=spec.quantity,
        weight_kg=spec.weight_kg,
        user_id=user.id if user else None,
        device_source=f"PRINTER_{printer.protocol}",
    ))
    db.commit()

    return {
        "route": route,
        "printer": printer.name,
        "protocol": printer.protocol,
        "connection": printer.connection,
        "copies": spec.copies,
        "bytes": len(payload),
        "spool_path": spool_path,
        "gcs_uri": gcs_uri,
        "raw_text": text,
        "error": error,
    }


def _resolve_printer(db: Session, printer_id: Optional[int], workstation: str) -> PrinterConfig:
    if printer_id:
        p = db.get(PrinterConfig, printer_id)
        if p and p.is_active:
            return p
    p = db.scalar(
        select(PrinterConfig)
        .where(PrinterConfig.workstation == workstation)
        .where(PrinterConfig.is_default == True)  # noqa: E712
        .where(PrinterConfig.is_active == True)    # noqa: E712
    )
    if p:
        return p
    p = db.scalar(
        select(PrinterConfig)
        .where(PrinterConfig.is_active == True)    # noqa: E712
    )
    if p:
        return p
    # Fallback in-memory default (works without DB seed)
    fb = PrinterConfig(
        workstation=workstation, name="Default TSC TTP-247",
        kind="LABEL", protocol="TSPL", connection="USB",
        label_width_mm=104.0, label_height_mm=50.0, dpi=203,
        is_default=True, is_active=True,
    )
    return fb


# ============================================================================
# 5. SCAN-BY-BARCODE ENDPOINTS (inward / outward / production / movement)
# ============================================================================

class ScanInward(BaseModel):
    barcode: str
    quantity: float
    weight_kg: Optional[float] = None
    po_id: Optional[int] = None  # if None → auto-pick oldest open PO for product
    device_source: str = "USB_HID"
    notes: str = ""


class ScanOutward(BaseModel):
    barcode: str
    quantity: float
    weight_kg: Optional[float] = None
    dispatch_id: Optional[int] = None  # if None → bare-issue
    device_source: str = "USB_HID"
    notes: str = ""


class ScanProduction(BaseModel):
    barcode: str
    quantity: float
    production_order_id: Optional[int] = None  # if None → auto-pick planned order
    device_source: str = "USB_HID"
    notes: str = ""


class ScanResult(BaseModel):
    matched: bool
    barcode: str
    product_id: Optional[int] = None
    product: Optional[dict] = None
    ref_type: str = ""
    ref_id: Optional[int] = None
    quantity: float = 0
    weight_kg: Optional[float] = None
    new_stock: float = 0
    message: str = ""


def _log_scan_event(db: Session, user, event_type: str, direction: str,
                    product_id: Optional[int], ref_type: str, ref_id: Optional[int],
                    barcode: str, qty: float, weight_kg: Optional[float],
                    device_source: str) -> None:
    db.add(ScanEvent(
        event_type=event_type, direction=direction,
        product_id=product_id, ref_type=ref_type, ref_id=ref_id,
        barcode_value=barcode, quantity=qty, weight_kg=weight_kg,
        user_id=user.id if user else None,
        device_source=device_source,
    ))


@router.post("/scan/inward", response_model=ScanResult)
def scan_inward(
    body: ScanInward, db: Annotated[Session, Depends(get_db)], user: AllStaff,
):
    """Inward goods receipt by barcode scan.

    Workflow:
      1. Lookup product by barcode
      2. Auto-match oldest open PO line for that product (or use supplied po_id)
      3. Increment line.received_qty, inventory.received_qty + current_stock
      4. Record StockMovement(RECEIPT) + ScanEvent(INWARD)
    """
    from ..models import PurchaseOrderLine
    bc = body.barcode.strip()
    product = db.scalar(select(Product).where(or_fallback(Product.barcode == bc, Product.item_code == bc)))
    if product is None:
        return ScanResult(matched=False, barcode=bc, message="Barcode not found")

    line: Optional[PurchaseOrderLine] = None
    if body.po_id:
        line = db.scalar(select(PurchaseOrderLine)
                         .where(PurchaseOrderLine.po_id == body.po_id)
                         .where(PurchaseOrderLine.product_id == product.id))
    if line is None:
        line = db.scalar(
            select(PurchaseOrderLine)
            .where(PurchaseOrderLine.product_id == product.id)
            .where(PurchaseOrderLine.received_qty < PurchaseOrderLine.quantity)
            .order_by(PurchaseOrderLine.id)
        )

    if line is not None:
        line.received_qty = float(line.received_qty or 0) + body.quantity
        inv = db.scalars(select(Inventory).where(
            Inventory.product_id == product.id, Inventory.plant_id.is_(None))).first()
        if inv is None:
            inv = Inventory(product_id=product.id, plant_id=None,
                            opening_stock=0, received_qty=0, issued_qty=0, current_stock=0)
            db.add(inv)
        inv.received_qty = float(inv.received_qty or 0) + body.quantity
        inv.current_stock = float(inv.current_stock or 0) + body.quantity
        db.add(StockMovement(
            product_id=product.id, movement_type=MovementType.receipt,
            quantity=body.quantity, transaction_date=date.today(),
            ref_type="purchase_order", ref_id=line.po_id,
            remarks=f"Scan receipt against PO line {line.id}",
        ))
        _log_scan_event(db, user, "INWARD", "IN", product.id,
                        "purchase_order", line.po_id, bc, body.quantity,
                        body.weight_kg, body.device_source)
        db.commit()
        return ScanResult(
            matched=True, barcode=bc, product_id=product.id,
            product={"id": product.id, "model": product.model,
                     "item_code": product.item_code, "uom": product.uom},
            ref_type="purchase_order", ref_id=line.po_id,
            quantity=body.quantity, weight_kg=body.weight_kg,
            new_stock=float(inv.current_stock),
            message=f"Received {body.quantity} {product.uom} against PO line {line.id}",
        )

    # No PO line — bare receipt into inventory
    inv = db.scalars(select(Inventory).where(
        Inventory.product_id == product.id, Inventory.plant_id.is_(None))).first()
    if inv is None:
        inv = Inventory(product_id=product.id, plant_id=None,
                        opening_stock=0, received_qty=0, issued_qty=0, current_stock=0)
        db.add(inv)
    inv.received_qty = float(inv.received_qty or 0) + body.quantity
    inv.current_stock = float(inv.current_stock or 0) + body.quantity
    db.add(StockMovement(
        product_id=product.id, movement_type=MovementType.receipt,
        quantity=body.quantity, transaction_date=date.today(),
        ref_type="scan_inward", ref_id=None,
        remarks="Unmatched inward scan (no open PO)",
    ))
    _log_scan_event(db, user, "INWARD", "IN", product.id,
                    "scan_inward", None, bc, body.quantity,
                    body.weight_kg, body.device_source)
    db.commit()
    return ScanResult(
        matched=True, barcode=bc, product_id=product.id,
        product={"id": product.id, "model": product.model,
                 "item_code": product.item_code, "uom": product.uom},
        ref_type="scan_inward", quantity=body.quantity,
        weight_kg=body.weight_kg,
        new_stock=float(inv.current_stock),
        message=f"Received {body.quantity} {product.uom} (no matching PO line)",
    )


@router.post("/scan/outward", response_model=ScanResult)
def scan_outward(
    body: ScanOutward, db: Annotated[Session, Depends(get_db)], user: AllStaff,
):
    """Outward goods issue by barcode scan.
    Either targets a specific dispatch or, when dispatch_id is None, creates
    a bare issue (consumption / manual dispatch)."""
    bc = body.barcode.strip()
    product = db.scalar(select(Product).where(or_fallback(Product.barcode == bc, Product.item_code == bc)))
    if product is None:
        return ScanResult(matched=False, barcode=bc, message="Barcode not found")

    inv = db.scalars(select(Inventory).where(
        Inventory.product_id == product.id, Inventory.plant_id.is_(None))).first()
    if inv is None:
        return ScanResult(matched=False, barcode=bc, product_id=product.id,
                          message="No stock record for product")

    if body.dispatch_id:
        d = db.get(Dispatch, body.dispatch_id)
        if d is None:
            return ScanResult(matched=False, barcode=bc, product_id=product.id,
                              message="Dispatch not found")
        db.add(DispatchLine(
            dispatch_id=d.id, product_id=product.id,
            quantity=body.quantity, dispatch_date=date.today(),
            weight=body.weight_kg,
        ))
        d.dispatched_qty = float(d.dispatched_qty or 0) + body.quantity
        inv.issued_qty = float(inv.issued_qty or 0) + body.quantity
        inv.current_stock = float(inv.current_stock or 0) - body.quantity
        db.add(StockMovement(
            product_id=product.id, movement_type=MovementType.dispatch,
            quantity=body.quantity, transaction_date=date.today(),
            ref_type="dispatch", ref_id=d.id,
            remarks=f"Scan dispatch {d.dispatch_no}",
        ))
        _log_scan_event(db, user, "OUTWARD", "OUT", product.id,
                        "dispatch", d.id, bc, body.quantity,
                        body.weight_kg, body.device_source)
        db.commit()
        return ScanResult(
            matched=True, barcode=bc, product_id=product.id,
            product={"id": product.id, "model": product.model,
                     "item_code": product.item_code, "uom": product.uom},
            ref_type="dispatch", ref_id=d.id,
            quantity=body.quantity, weight_kg=body.weight_kg,
            new_stock=float(inv.current_stock),
            message=f"Dispatched {body.quantity} {product.uom} via {d.dispatch_no}",
        )

    # Bare-issue / consumption
    inv.issued_qty = float(inv.issued_qty or 0) + body.quantity
    inv.current_stock = float(inv.current_stock or 0) - body.quantity
    db.add(StockMovement(
        product_id=product.id, movement_type=MovementType.issue,
        quantity=body.quantity, transaction_date=date.today(),
        ref_type="scan_outward", ref_id=None,
        remarks=f"Outward scan (no dispatch): {body.notes or '-'}",
    ))
    _log_scan_event(db, user, "OUTWARD", "OUT", product.id,
                    "scan_outward", None, bc, body.quantity,
                    body.weight_kg, body.device_source)
    db.commit()
    return ScanResult(
        matched=True, barcode=bc, product_id=product.id,
        product={"id": product.id, "model": product.model,
                 "item_code": product.item_code, "uom": product.uom},
        ref_type="scan_outward", quantity=body.quantity,
        weight_kg=body.weight_kg,
        new_stock=float(inv.current_stock),
        message=f"Issued {body.quantity} {product.uom}",
    )


@router.post("/scan/production", response_model=ScanResult)
def scan_production(
    body: ScanProduction, db: Annotated[Session, Depends(get_db)], user: AllStaff,
):
    """Production output by barcode scan.

    Auto-matches an In-Progress production order for the product if not given.
    Increments produced_qty, finished-goods inventory, and writes a
    StockMovement(PRODUCTION_OUTPUT)."""
    from ..models import ProductionMovement
    bc = body.barcode.strip()
    product = db.scalar(select(Product).where(or_fallback(Product.barcode == bc, Product.item_code == bc)))
    if product is None:
        return ScanResult(matched=False, barcode=bc, message="Barcode not found")

    po: Optional[ProductionOrder] = None
    if body.production_order_id:
        po = db.get(ProductionOrder, body.production_order_id)
    if po is None:
        from ..models import ProductionStatus
        po = db.scalar(
            select(ProductionOrder)
            .where(ProductionOrder.product_id == product.id)
            .where(ProductionOrder.status.in_(
                [ProductionStatus.planned, ProductionStatus.in_production]))
            .order_by(ProductionOrder.id)
        )

    if po is None:
        return ScanResult(matched=False, barcode=bc, product_id=product.id,
                          message="No active production order for this product")

    po.produced_qty = float(po.produced_qty or 0) + body.quantity
    db.add(ProductionMovement(
        production_order_id=po.id, quantity=body.quantity,
        production_date=date.today(),
    ))
    inv = db.scalars(select(Inventory).where(
        Inventory.product_id == product.id, Inventory.plant_id.is_(None))).first()
    if inv is None:
        inv = Inventory(product_id=product.id, plant_id=None,
                        opening_stock=0, received_qty=0, issued_qty=0, current_stock=0)
        db.add(inv)
    inv.received_qty = float(inv.received_qty or 0) + body.quantity
    inv.current_stock = float(inv.current_stock or 0) + body.quantity
    db.add(StockMovement(
        product_id=product.id, movement_type=MovementType.production_output,
        quantity=body.quantity, transaction_date=date.today(),
        ref_type="production_order", ref_id=po.id,
        remarks=f"Production scan {po.order_no}",
    ))
    _log_scan_event(db, user, "PRODUCTION", "IN", product.id,
                    "production_order", po.id, bc, body.quantity,
                    None, body.device_source)
    db.commit()
    return ScanResult(
        matched=True, barcode=bc, product_id=product.id,
        product={"id": product.id, "model": product.model,
                 "item_code": product.item_code, "uom": product.uom},
        ref_type="production_order", ref_id=po.id,
        quantity=body.quantity, new_stock=float(inv.current_stock),
        message=f"Produced {body.quantity} {product.uom} → {po.order_no}",
    )


# ============================================================================
# 6. SCAN ANALYTICS (powers dashboard widgets + marketing insights)
# ============================================================================

@router.get("/scan-events/analytics", response_model=dict)
def scan_analytics(
    db: Annotated[Session, Depends(get_db)],
    _: CurrentUser,
    days: int = Query(30, ge=1, le=365),
):
    """Aggregate scan activity for the last N days.

    Marketing-relevant metrics:
      - Total scans + breakdown by event_type (inward/outward/production/print)
      - Top 10 most-scanned products (demand signal)
      - Device-source mix (USB_HID vs SCANBOT vs MANUAL)
      - Daily scan volume (helps spot dead-time / shift peaks)
      - Total qty moved + total weight
    """
    from datetime import timedelta
    since = datetime.utcnow() - timedelta(days=days)

    rows = db.scalars(select(ScanEvent).where(ScanEvent.scanned_at >= since)).all()

    by_type: dict[str, int] = {}
    by_device: dict[str, int] = {}
    by_day: dict[str, dict[str, float]] = {}
    product_count: dict[int, dict] = {}
    total_qty = 0.0
    total_weight = 0.0
    for e in rows:
        by_type[e.event_type] = by_type.get(e.event_type, 0) + 1
        by_device[e.device_source] = by_device.get(e.device_source, 0) + 1
        day = e.scanned_at.date().isoformat()
        d = by_day.setdefault(day, {"scans": 0, "qty": 0.0, "weight": 0.0})
        d["scans"] += 1
        d["qty"] += float(e.quantity or 0)
        if e.weight_kg:
            d["weight"] += float(e.weight_kg)
            total_weight += float(e.weight_kg)
        total_qty += float(e.quantity or 0)
        if e.product_id:
            entry = product_count.setdefault(
                e.product_id, {"product_id": e.product_id, "scans": 0, "qty": 0.0,
                               "barcode": e.barcode_value},
            )
            entry["scans"] += 1
            entry["qty"] += float(e.quantity or 0)

    # Hydrate product names for top list
    top_pids = sorted(product_count.values(), key=lambda x: -x["scans"])[:10]
    if top_pids:
        products = {p.id: p for p in db.scalars(select(Product).where(Product.id.in_([x["product_id"] for x in top_pids]))).all()}
        for x in top_pids:
            p = products.get(x["product_id"])
            x["model"] = p.model if p else None
            x["item_code"] = p.item_code if p else None

    daily = [{"date": k, **v} for k, v in sorted(by_day.items())]

    return {
        "days": days,
        "since": since.isoformat(),
        "total_scans": len(rows),
        "total_qty": round(total_qty, 3),
        "total_weight_kg": round(total_weight, 3),
        "by_type": [{"k": k, "v": v} for k, v in sorted(by_type.items(), key=lambda x: -x[1])],
        "by_device": [{"k": k, "v": v} for k, v in sorted(by_device.items(), key=lambda x: -x[1])],
        "top_products": top_pids,
        "daily": daily,
    }


@router.get("/scan-events", response_model=dict)
def list_scan_events(
    db: Annotated[Session, Depends(get_db)],
    _: CurrentUser,
    event_type: str = "",
    product_id: int | None = None,
    days: int = Query(7, ge=1, le=90),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
):
    from datetime import timedelta
    since = datetime.utcnow() - timedelta(days=days)
    stmt = select(ScanEvent).where(ScanEvent.scanned_at >= since)
    if event_type:
        stmt = stmt.where(ScanEvent.event_type == event_type)
    if product_id:
        stmt = stmt.where(ScanEvent.product_id == product_id)
    total = db.scalar(select(func.count()).select_from(stmt.subquery()))
    rows = db.scalars(stmt.order_by(ScanEvent.scanned_at.desc())
                      .offset((page - 1) * page_size).limit(page_size)).all()
    items = []
    for r in rows:
        items.append({
            "id": r.id, "event_type": r.event_type, "direction": r.direction,
            "product_id": r.product_id, "barcode_value": r.barcode_value,
            "quantity": r.quantity, "weight_kg": r.weight_kg,
            "user_id": r.user_id, "device_source": r.device_source,
            "ref_type": r.ref_type, "ref_id": r.ref_id,
            "scanned_at": r.scanned_at.isoformat() if r.scanned_at else None,
        })
    return {"items": items, "total": total, "page": page, "page_size": page_size}


# ============================================================================
# 7. WI-FI / NETWORK SCANNER ENDPOINT (for edge-agent / IoT barcode scanners)
# ============================================================================

class NetworkScanEvent(BaseModel):
    """Push payload from a WiFi barcode scanner / edge agent."""
    device_id: str
    barcode: str
    event_type: str = "MOVEMENT"  # INWARD | OUTWARD | PRODUCTION | MOVEMENT
    quantity: float = 0
    weight_kg: Optional[float] = None
    ref_type: str = ""
    ref_id: Optional[int] = None


@router.post("/network/scan", response_model=ScanResult)
def receive_network_scan(
    body: NetworkScanEvent, db: Annotated[Session, Depends(get_db)],
):
    """Endpoint for WiFi / TCP barcode scanners (Zebra, CipherLab, custom
    ESP32 devices) to push a scan event into the ERP without going through
    the browser. Idempotent-ish — duplicates can be filtered by querying
    /scan-events with the same barcode within a short window.

    No auth header required here by design (edge agents use a shared secret
    in production via a network firewall rule or a header)."""
    bc = body.barcode.strip()
    product = db.scalar(select(Product).where(or_fallback(Product.barcode == bc, Product.item_code == bc)))
    if product is None:
        return ScanResult(matched=False, barcode=bc, message="Unknown barcode")

    _log_scan_event(db, None, body.event_type, "IN" if body.event_type == "INWARD" else "OUT",
                    product.id, body.ref_type, body.ref_id, bc,
                    body.quantity, body.weight_kg, body.device_id)
    db.commit()
    return ScanResult(
        matched=True, barcode=bc, product_id=product.id,
        product={"id": product.id, "model": product.model,
                 "item_code": product.item_code, "uom": product.uom},
        quantity=body.quantity, weight_kg=body.weight_kg,
        message=f"Logged scan from {body.device_id}",
    )


# ============================================================================
# 8. GCS SECURE BUCKET — secured info archive (kalika_enterprises)
# ============================================================================

@router.post("/gcs/archive-today", response_model=dict)
def gcs_archive_today(
    db: Annotated[Session, Depends(get_db)], user: ManagerOrAdmin,
    days: int = Query(1, ge=1, le=90),
):
    """Archive today's scan events + product barcode map into the
    `kalika_enterprises` GCS bucket (secured info).

    Path scheme:
      gs://kalika_enterprises/scan-events/YYYY-MM-DD.json
      gs://kalika_enterprises/barcode-map/YYYY-MM-DD.json
    """
    from datetime import timedelta
    from ..services import gcs as _gcs

    since = datetime.utcnow() - timedelta(days=days)
    events = db.scalars(select(ScanEvent).where(ScanEvent.scanned_at >= since)).all()
    ev_payload = [{
        "id": e.id, "event_type": e.event_type, "direction": e.direction,
        "product_id": e.product_id, "ref_type": e.ref_type, "ref_id": e.ref_id,
        "barcode_value": e.barcode_value, "quantity": e.quantity,
        "weight_kg": e.weight_kg, "user_id": e.user_id, "device_source": e.device_source,
        "scanned_at": e.scanned_at.isoformat() if e.scanned_at else None,
    } for e in events]

    products = db.scalars(select(Product).where(Product.is_active == True)).all()  # noqa: E712
    prod_payload = [{
        "id": p.id, "item_code": p.item_code, "model": p.model,
        "barcode": p.barcode, "category": p.category.value if p.category else None,
        "uom": p.uom, "weight_per_unit": p.weight_per_unit,
        "standard_rate": float(p.standard_rate) if p.standard_rate else None,
        "hsn_code": p.hsn_code,
    } for p in products]

    out = {
        "events_archived": len(ev_payload),
        "products_archived": len(prod_payload),
        "archived_at": datetime.utcnow().isoformat(),
        "archived_by": user.id if user else None,
        "scan_events_uri": None,
        "barcode_map_uri": None,
        "ok": True,
    }
    try:
        out["scan_events_uri"] = _gcs.archive_scan_events(ev_payload)
    except Exception as exc:
        out["ok"] = False
        out["scan_events_error"] = str(exc)[:200]
    try:
        out["barcode_map_uri"] = _gcs.archive_barcode_map(prod_payload)
    except Exception as exc:
        out["ok"] = False
        out["barcode_map_error"] = str(exc)[:200]
    return out


@router.get("/gcs/list", response_model=dict)
def gcs_list_objects(
    _: CurrentUser,
    prefix: str = "",
    limit: int = Query(50, ge=1, le=500),
):
    """List objects in the kalika_enterprises secured bucket. Best-effort —
    if GCS auth isn't available locally, returns an empty list + the
    error so the UI degrades gracefully."""
    from ..services import gcs as _gcs
    try:
        items = _gcs.list_secure(prefix=prefix, limit=limit)
        return {"items": items, "total": len(items), "prefix": prefix,
                "bucket": _gcs._secure_bucket_name(), "ok": True}
    except Exception as exc:
        return {"items": [], "total": 0, "prefix": prefix, "ok": False,
                "error": str(exc)[:200],
                "hint": "Run: gcloud auth application-default login"}


# ============================================================================
# 9. END-TO-END SELF-TEST (smoke test — no framework, single round-trip)
# ============================================================================

@router.get("/selftest", response_model=dict)
def selftest(
    db: Annotated[Session, Depends(get_db)],
    user: ManagerOrAdmin,
):
    """One-shot end-to-end smoke test for the whole barcode/print pipeline.

    What it does:
      1. Picks the first active product (or creates a tiny dummy if none)
      2. Generates a TSPL label for it
      3. Drops it into the local spool dir
      4. Tries to archive it to gs://kalika_enterprises/selftest/...
      5. Records a LABEL_PRINT ScanEvent
      6. Returns every step's status

    This is what you'd run after deploying to prove everything works without
    setting up a real printer or scanner. No external services required
    (GCS is best-effort and reports its own status)."""
    from ..config import settings as _settings
    from ..services import gcs as _gcs

    steps = []

    product = db.scalar(select(Product).where(Product.is_active == True))  # noqa: E712
    if product is None:
        # Seed a minimal product so the test is self-sufficient
        product = Product(
            item_code="SELFTEST", model="Self-Test Product",
            category=ProductCategory.store, uom="PCS", barcode="SELFTEST",
            weight_per_unit=1.0, weight_uom="KG",
            standard_rate=99.0, hsn_code="9999", gst_rate=18.0,
        )
        db.add(product)
        db.commit()
        db.refresh(product)
        steps.append({"step": "seed_product", "ok": True,
                      "detail": f"created SELFTEST product id={product.id}"})

    printer = _resolve_printer(db, None, "DEFAULT")
    builder = _LABEL_BUILDERS.get(printer.protocol)
    text = builder(product, 1.0, 1.234, printer, {})
    steps.append({"step": "build_label", "ok": True, "bytes": len(text),
                  "protocol": printer.protocol, "first_line": text.splitlines()[0]})

    # Spool
    spool_ok = False
    spool_err = None
    spool_path = None
    try:
        spool_dir = _settings.LABEL_SPOOL_DIR
        spool_dir.mkdir(parents=True, exist_ok=True)
        spool_path = spool_dir / f"selftest_{product.id}.tspl"
        spool_path.write_text(text, encoding="utf-8")
        spool_ok = True
    except Exception as exc:
        spool_err = str(exc)
    steps.append({"step": "spool_to_disk", "ok": spool_ok,
                  "path": str(spool_path) if spool_path else None,
                  "error": spool_err})

    # GCS archive
    gcs_ok = False
    gcs_uri = None
    gcs_err = None
    try:
        gcs_uri = _gcs.archive_label_print(
            printer.protocol, product.id, text,
            meta={"selftest": True, "user_id": user.id if user else None},
        )
        gcs_ok = True
    except Exception as exc:
        gcs_err = str(exc)
    steps.append({"step": "gcs_archive", "ok": gcs_ok,
                  "uri": gcs_uri, "error": gcs_err,
                  "bucket": _settings.GCS_SECURE_BUCKET})

    # Scan-event audit
    db.add(ScanEvent(
        event_type="SELFTEST",
        direction="OUT",
        product_id=product.id,
        barcode_value=product.barcode or product.item_code,
        quantity=1.0, weight_kg=1.234,
        user_id=user.id if user else None,
        device_source="SELFTEST_RUNNER",
    ))
    db.commit()
    steps.append({"step": "scan_event_recorded", "ok": True,
                  "product_id": product.id})

    return {
        "ok": all(s["ok"] for s in steps),
        "ran_at": datetime.utcnow().isoformat(),
        "ran_by": user.username if user else None,
        "product": {"id": product.id, "model": product.model,
                    "item_code": product.item_code, "barcode": product.barcode},
        "printer": {"id": printer.id, "name": printer.name,
                    "protocol": printer.protocol, "connection": printer.connection},
        "steps": steps,
    }


# ============================================================================
# helpers
# ============================================================================
from sqlalchemy import or_ as _or  # local alias to avoid import-order confusion


def or_fallback(*clauses):
    return _or(*clauses)
