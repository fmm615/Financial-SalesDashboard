from __future__ import annotations
"""
PDF report generator using ReportLab Platypus.
PLAYBOOK-branded, A4 portrait, dark cover page.
"""
import io
import logging
from datetime import date, datetime
from pathlib import Path
from typing import Optional

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    BaseDocTemplate, Frame, HRFlowable, Image, PageBreak,
    PageTemplate, Paragraph, Spacer, Table, TableStyle,
)

logger = logging.getLogger(__name__)

PURPLE = colors.HexColor("#2A004C")
LIME   = colors.HexColor("#C8FF00")
GREY   = colors.HexColor("#555555")
WHITE  = colors.white
W, H   = A4
REPORTS_DIR = Path(__file__).parent.parent / "data" / "reports"
REPORTS_DIR.mkdir(parents=True, exist_ok=True)

styles = getSampleStyleSheet()
TITLE_STYLE  = ParagraphStyle("pbtitle",  fontName="Helvetica-Bold",   fontSize=26, textColor=LIME,   leading=32, spaceAfter=8)
SUB_STYLE    = ParagraphStyle("pbsub",    fontName="Helvetica",        fontSize=13, textColor=WHITE,  leading=16)
H1_STYLE     = ParagraphStyle("pbh1",     fontName="Helvetica-Bold",   fontSize=14, textColor=PURPLE, leading=18, spaceBefore=12, spaceAfter=4)
H2_STYLE     = ParagraphStyle("pbh2",     fontName="Helvetica-Bold",   fontSize=11, textColor=PURPLE, leading=14, spaceBefore=8,  spaceAfter=2)
BODY_STYLE   = ParagraphStyle("pbbody",   fontName="Helvetica",        fontSize=9,  textColor=GREY,   leading=13)
BULLET_STYLE = ParagraphStyle("pbbullet", fontName="Helvetica",        fontSize=9,  textColor=GREY,   leading=13, leftIndent=12, bulletIndent=0)
CAPTION_STYLE= ParagraphStyle("pbcap",    fontName="Helvetica-Oblique",fontSize=8,  textColor=GREY,   leading=11, spaceAfter=4)
FOOTER_STYLE = ParagraphStyle("pbfooter", fontName="Helvetica",        fontSize=7,  textColor=GREY,   leading=10)


def _cover_page(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(PURPLE)
    canvas.rect(0, 0, W, H, fill=True, stroke=False)
    canvas.setFillColor(LIME)
    canvas.setFont("Helvetica-Bold", 36)
    canvas.drawString(20*mm, H - 40*mm, "PLAYBOOK")
    canvas.setFillColor(WHITE)
    canvas.setFont("Helvetica", 9)
    canvas.drawString(20*mm, H - 48*mm, "Financial Operating System")
    canvas.restoreState()


def _page_footer(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(colors.HexColor("#EEEEEE"))
    canvas.rect(0, 0, W, 12*mm, fill=True, stroke=False)
    canvas.setFillColor(GREY)
    canvas.setFont("Helvetica", 7)
    canvas.drawString(20*mm, 4*mm, "PLAYBOOK — Confidential")
    canvas.drawRightString(W - 20*mm, 4*mm, f"Page {doc.page}")
    canvas.restoreState()


def _img_from_bytes(png: bytes, width_mm: float = 160) -> Image:
    buf = io.BytesIO(png)
    img = Image(buf)
    aspect = img.imageHeight / float(img.imageWidth)
    w = width_mm * mm
    img.drawWidth = w
    img.drawHeight = w * aspect
    return img


def generate_report(
    report_id: str,
    send_email: bool = False,
    db=None,
) -> None:
    """Entry point called by the background thread. Updates the Report row."""
    _close_db = False
    if db is None:
        from app.database import SessionLocal
        db = SessionLocal()
        _close_db = True

    from app.models.reports import Report
    report = db.query(Report).filter(Report.id == report_id).first()
    if not report:
        return

    try:
        report.status = "generating"
        db.commit()

        pdf_path, zip_path, bullets = _build_report(db, report)

        report.pdf_path = pdf_path
        report.zip_path = zip_path
        report.status = "done"
        report.completed_at = datetime.utcnow()

        # Drive upload
        try:
            from app.services.drive_service import upload_report
            urls = upload_report(
                pdf_path=pdf_path,
                zip_path=zip_path,
                report_type=report.report_type,
                year=report.period_start.year if report.period_start else 2026,
            )
            report.drive_pdf_url = urls.get("pdf_url")
            report.drive_zip_url = urls.get("zip_url")
        except Exception as e:
            logger.warning("Drive upload failed: %s", e)

        db.commit()

        # Email
        if send_email:
            try:
                from app.services.email_service import send_report_email
                ok = send_report_email(
                    period_label=report.period_label,
                    report_type=report.report_type,
                    summary_bullets=bullets,
                    pdf_path=pdf_path,
                    zip_path=zip_path,
                    pdf_url=report.drive_pdf_url,
                    zip_url=report.drive_zip_url,
                )
                if ok:
                    report.email_sent = True
                    report.email_sent_at = datetime.utcnow()
                    db.commit()
            except Exception as e:
                logger.warning("Email delivery failed: %s", e)

    except Exception as e:
        logger.exception("Report generation failed for %s: %s", report_id, e)
        report.status = "failed"
        report.error_message = str(e)[:500]
        db.commit()
    finally:
        if _close_db:
            db.close()


def _build_report(db, report) -> tuple[str, str, list[str]]:
    from sqlalchemy import func
    from app.models.members import Member, Transaction
    from app.models.b2b import B2BDeal
    from app.models.financial import FinancialRecord, CashPosition

    period_start: date = report.period_start
    period_end: date   = report.period_end

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    slug = report.period_label.replace(" ", "_").replace("–", "-").replace("/", "-")
    pdf_path = str(REPORTS_DIR / f"report_{slug}.pdf")

    # ─── Gather data ────────────────────────────────────────────────
    b2c_total = float(db.query(func.coalesce(func.sum(Transaction.amount_net), 0)).filter(
        Transaction.date >= datetime.combine(period_start, datetime.min.time()),
        Transaction.date <= datetime.combine(period_end, datetime.max.time()),
        Transaction.is_refund.is_(False),
    ).scalar() or 0)
    b2b_total = float(db.query(func.coalesce(func.sum(B2BDeal.amount), 0)).filter(
        B2BDeal.status == "won",
        B2BDeal.close_date_actual >= period_start,
        B2BDeal.close_date_actual <= period_end,
    ).scalar() or 0)
    other_total = float(db.query(func.coalesce(func.sum(FinancialRecord.amount), 0)).filter(
        FinancialRecord.category == "revenue_other",
        FinancialRecord.date >= period_start,
        FinancialRecord.date <= period_end,
    ).scalar() or 0)
    expenses_total = float(db.query(func.coalesce(func.sum(FinancialRecord.amount), 0)).filter(
        FinancialRecord.category.like("expense_%"),
        FinancialRecord.date >= period_start,
        FinancialRecord.date <= period_end,
    ).scalar() or 0)
    new_members = db.query(func.count(Member.id)).filter(
        Member.first_purchase_date >= datetime.combine(period_start, datetime.min.time()),
        Member.first_purchase_date <= datetime.combine(period_end, datetime.max.time()),
    ).scalar() or 0
    total_revenue = b2c_total + b2b_total + other_total
    net_profit = total_revenue - expenses_total
    latest_cash = db.query(CashPosition).order_by(CashPosition.date.desc()).first()

    # Revenue trend for chart (monthly)
    from app.routers.financial import revenue_trend as _rt_endpoint
    # build manually to avoid FastAPI dependency injection
    from datetime import timedelta
    trend_rows = []
    cursor = period_start.replace(day=1)
    while cursor <= period_end:
        m_end = (cursor.replace(month=cursor.month % 12 + 1, day=1) - timedelta(days=1)) if cursor.month < 12 else cursor.replace(day=31)
        b2c_m = float(db.query(func.coalesce(func.sum(Transaction.amount_net), 0)).filter(
            Transaction.date.between(datetime.combine(cursor, datetime.min.time()), datetime.combine(m_end, datetime.max.time())),
            Transaction.is_refund.is_(False),
        ).scalar() or 0)
        b2b_m = float(db.query(func.coalesce(func.sum(B2BDeal.amount), 0)).filter(
            B2BDeal.status == "won", B2BDeal.close_date_actual.between(cursor, m_end),
        ).scalar() or 0)
        other_m = float(db.query(func.coalesce(func.sum(FinancialRecord.amount), 0)).filter(
            FinancialRecord.category == "revenue_other", FinancialRecord.date.between(cursor, m_end),
        ).scalar() or 0)
        trend_rows.append({"label": cursor.strftime("%b %Y"), "b2c": b2c_m, "b2b": b2b_m, "other": other_m, "total": b2c_m + b2b_m + other_m})
        # advance to next month
        next_month = cursor.month + 1 if cursor.month < 12 else 1
        next_year = cursor.year if cursor.month < 12 else cursor.year + 1
        cursor = cursor.replace(year=next_year, month=next_month, day=1)

    # B2B pipeline
    pipeline_rows = db.query(
        B2BDeal.stage,
        func.count(B2BDeal.id).label("count"),
        func.sum(B2BDeal.amount).label("total_value"),
    ).filter(B2BDeal.status == "open").group_by(B2BDeal.stage).all()
    pipeline_data = [{"stage": r.stage or "Unknown", "count": r.count, "total_value": float(r.total_value or 0)} for r in pipeline_rows]

    expense_rows = db.query(
        FinancialRecord.category,
        func.sum(FinancialRecord.amount).label("amount"),
    ).filter(
        FinancialRecord.category.like("expense_%"),
        FinancialRecord.date >= period_start,
        FinancialRecord.date <= period_end,
    ).group_by(FinancialRecord.category).all()
    expense_data = [{"category": r.category, "amount": float(r.amount or 0)} for r in expense_rows]

    # ─── Charts ─────────────────────────────────────────────────────
    from reports.charts import revenue_trend_chart, pipeline_funnel_chart, expense_breakdown_chart
    rev_png  = revenue_trend_chart(trend_rows) if trend_rows else None
    pip_png  = pipeline_funnel_chart(pipeline_data) if pipeline_data else None
    exp_png  = expense_breakdown_chart(expense_data) if expense_data else None

    # ─── Build summary bullets ───────────────────────────────────────
    bullets = [
        f"Total revenue: ${total_revenue:,.0f} (B2C ${b2c_total:,.0f} | B2B ${b2b_total:,.0f} | Other ${other_total:,.0f})",
        f"Net profit / (loss): ${net_profit:,.0f}",
        f"New B2C members: {new_members:,}",
    ]
    if latest_cash:
        bullets.append(f"Cash balance: ${float(latest_cash.balance):,.0f} as of {latest_cash.date}")

    # ─── PDF assembly ────────────────────────────────────────────────
    cover_frame   = Frame(0, 0, W, H, leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0, id="cover")
    content_frame = Frame(20*mm, 14*mm, W - 40*mm, H - 28*mm, id="content")

    doc = BaseDocTemplate(
        pdf_path, pagesize=A4,
        leftMargin=20*mm, rightMargin=20*mm, topMargin=20*mm, bottomMargin=14*mm,
    )
    cover_template   = PageTemplate("cover",   frames=[cover_frame],   onPage=_cover_page)
    content_template = PageTemplate("content", frames=[content_frame], onPage=_page_footer)
    doc.addPageTemplates([cover_template, content_template])

    story = [
        # Cover page content
        Spacer(1, 80*mm),
        Paragraph("PLAYBOOK", TITLE_STYLE),
        Paragraph(f"Financial Report", SUB_STYLE),
        Paragraph(report.period_label, SUB_STYLE),
        Paragraph(f"Generated {datetime.utcnow().strftime('%d %B %Y')}", ParagraphStyle("pbdate", fontName="Helvetica", fontSize=9, textColor=colors.HexColor("#AAAAAA"), leading=13)),
        PageBreak(),

        # Executive summary
        Paragraph("Executive Summary", H1_STYLE),
        HRFlowable(width="100%", thickness=1, color=LIME, spaceAfter=8),
        _kv_table([
            ("Total Revenue", f"${total_revenue:,.0f}"),
            ("  B2C (net)", f"${b2c_total:,.0f}"),
            ("  B2B (bookings)", f"${b2b_total:,.0f}"),
            ("  Other", f"${other_total:,.0f}"),
            ("Total Expenses", f"${expenses_total:,.0f}"),
            ("Net Profit / (Loss)", f"${net_profit:,.0f}"),
            ("New B2C Members", f"{new_members:,}"),
            ("Cash Balance", f"${float(latest_cash.balance):,.0f}" if latest_cash else "—"),
        ]),
        Spacer(1, 8*mm),

        # Revenue trend
        Paragraph("Revenue Trend", H1_STYLE),
        HRFlowable(width="100%", thickness=1, color=LIME, spaceAfter=6),
    ]

    if rev_png:
        story.append(_img_from_bytes(rev_png, 160))
        story.append(Paragraph("Monthly revenue by source (USD net)", CAPTION_STYLE))
    else:
        story.append(Paragraph("No revenue trend data for this period.", BODY_STYLE))

    story += [
        Spacer(1, 6*mm),
        Paragraph("B2B Pipeline", H1_STYLE),
        HRFlowable(width="100%", thickness=1, color=LIME, spaceAfter=6),
    ]
    if pip_png:
        story.append(_img_from_bytes(pip_png, 160))
        story.append(Paragraph("Open pipeline by stage (current snapshot)", CAPTION_STYLE))
    else:
        story.append(Paragraph("No open pipeline data.", BODY_STYLE))

    story += [
        Spacer(1, 6*mm),
        Paragraph("Expense Breakdown", H1_STYLE),
        HRFlowable(width="100%", thickness=1, color=LIME, spaceAfter=6),
    ]
    if exp_png:
        story.append(_img_from_bytes(exp_png, 120))
        story.append(Paragraph("Expenses by category for the period", CAPTION_STYLE))
    else:
        story.append(Paragraph("No expense data for this period.", BODY_STYLE))

    story += [
        Spacer(1, 6*mm),
        Paragraph(f"Report generated by PLAYBOOK FOS on {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}.", FOOTER_STYLE),
    ]

    doc.build(story)

    # ─── CSV ZIP ─────────────────────────────────────────────────────
    from reports.csv_export import export_report_zip
    zip_path = export_report_zip(db, period_start, period_end, str(REPORTS_DIR), report.period_label)

    return pdf_path, zip_path, bullets


def _kv_table(rows: list[tuple]) -> Table:
    data = [[Paragraph(k, BODY_STYLE), Paragraph(v, ParagraphStyle("pbkv", fontName="Helvetica-Bold", fontSize=9, textColor=PURPLE, leading=13))] for k, v in rows]
    t = Table(data, colWidths=[90*mm, 70*mm])
    t.setStyle(TableStyle([
        ("ROWBACKGROUNDS", (0, 0), (-1, -1), [colors.white, colors.HexColor("#F7F4FB")]),
        ("LINEBELOW", (0, 0), (-1, -1), 0.3, colors.HexColor("#EEEEEE")),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
    ]))
    return t
