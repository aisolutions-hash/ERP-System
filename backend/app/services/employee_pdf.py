"""Multi-page PDF builder for employee list exports.

Deliberately small: a titled table with a repeating header row, a generation
date and page numbers. Cells wrap so long names/emails stay readable. Reuses
the same ReportLab stack the quotation PDF uses.
"""
from __future__ import annotations

import io
from datetime import date
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle,
)


def build_employees_pdf_bytes(
    header_labels: list[str],
    rows: list[list],
    *,
    title: str = "Employee List",
    subtitle: str = "",
    generated_on: date | None = None,
) -> bytes:
    buf = io.BytesIO()
    page = landscape(A4)
    generated_on = generated_on or date.today()
    doc = SimpleDocTemplate(
        buf, pagesize=page, leftMargin=12 * mm, rightMargin=12 * mm,
        topMargin=16 * mm, bottomMargin=14 * mm, title=title,
    )

    styles = getSampleStyleSheet()
    style_title = ParagraphStyle(
        "EmpTitle", parent=styles["Heading1"], fontSize=15,
        textColor=colors.HexColor("#1e3a8a"), alignment=0, spaceAfter=2, leading=18,
    )
    style_meta = ParagraphStyle(
        "EmpMeta", parent=styles["Normal"], fontSize=8.5,
        textColor=colors.HexColor("#475569"), spaceAfter=1,
    )
    style_cell = ParagraphStyle(
        "EmpCell", parent=styles["Normal"], fontSize=7, leading=8.5,
        textColor=colors.HexColor("#334155"), wordWrap="CJK",
    )
    style_head = ParagraphStyle(
        "EmpHead", parent=styles["Normal"], fontSize=7.5, leading=9,
        textColor=colors.whitesmoke, fontName="Helvetica-Bold",
    )

    story = [Paragraph(escape(title), style_title)]
    if subtitle:
        story.append(Paragraph(escape(subtitle), style_meta))
    story.append(Paragraph(f"Generated on {generated_on.isoformat()}", style_meta))
    story.append(Spacer(1, 6))

    usable = page[0] - 24 * mm
    ncol = max(len(header_labels), 1)
    col_widths = [usable / ncol] * ncol

    def _wrap(v) -> Paragraph:
        return Paragraph(escape("" if v is None else str(v)), style_cell)

    data = [[Paragraph(escape(h), style_head) for h in header_labels]]
    for row in rows:
        data.append([_wrap(c) for c in row])

    if len(data) == 1:
        data.append([_wrap("No records")] + [""] * (ncol - 1))

    table = Table(data, colWidths=col_widths, repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1e3a8a")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#cbd5e1")),
        ("LEFTPADDING", (0, 0), (-1, -1), 3),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f8fafc")]),
    ]))
    story.append(table)

    def _footer(canvas, d):
        canvas.saveState()
        canvas.setFont("Helvetica", 7.5)
        canvas.setFillColor(colors.HexColor("#64748b"))
        w, _ = page
        canvas.drawRightString(w - 12 * mm, 8 * mm, f"Page {d.page}")
        canvas.drawString(12 * mm, 8 * mm, f"Generated {generated_on.isoformat()}")
        canvas.restoreState()

    doc.build(story, onFirstPage=_footer, onLaterPages=_footer)
    pdf = buf.getvalue()
    buf.close()
    return pdf
