from __future__ import annotations
"""
Generates per-section CSV files and bundles them into a ZIP archive.
Returns the path to the ZIP file.
"""
import io
import zipfile
from datetime import date, datetime
from pathlib import Path
from typing import Optional
import pandas as pd
from sqlalchemy.orm import Session

from app.models.members import Member, Transaction
from app.models.b2b import B2BDeal
from app.models.financial import FinancialRecord, CashPosition


def export_report_zip(
    db: Session,
    period_start: date,
    period_end: date,
    out_dir: str,
    period_label: str,
) -> str:
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    slug = period_label.replace(" ", "_").replace("–", "-").replace("/", "-")
    zip_path = str(Path(out_dir) / f"report_{slug}.zip")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("b2c_transactions.csv", _b2c_transactions(db, period_start, period_end))
        zf.writestr("b2c_members.csv", _b2c_members(db, period_start, period_end))
        zf.writestr("b2b_deals.csv", _b2b_deals(db, period_start, period_end))
        zf.writestr("financial_records.csv", _financial_records(db, period_start, period_end))
        zf.writestr("cash_positions.csv", _cash_positions(db))
        zf.writestr("summary.csv", _summary_sheet(db, period_start, period_end, period_label))

    with open(zip_path, "wb") as f:
        f.write(buf.getvalue())
    return zip_path


def _b2c_transactions(db: Session, start: date, end: date) -> str:
    rows = db.query(Transaction).filter(
        Transaction.date >= datetime.combine(start, datetime.min.time()),
        Transaction.date <= datetime.combine(end, datetime.max.time()),
    ).order_by(Transaction.date.asc()).all()

    data = [{
        "id": r.id,
        "date": r.date.date().isoformat() if r.date else "",
        "email": r.email,
        "processor": r.processor,
        "processor_transaction_id": r.processor_transaction_id,
        "product_name": r.product_name,
        "category": r.category,
        "currency": r.currency,
        "amount_gross": r.amount_gross,
        "vat_amount": r.vat_amount,
        "amount_net": r.amount_net,
        "is_first_purchase": r.is_first_purchase,
        "is_renewal": r.is_renewal,
        "is_refund": r.is_refund,
    } for r in rows]
    return pd.DataFrame(data).to_csv(index=False)


def _b2c_members(db: Session, start: date, end: date) -> str:
    rows = db.query(Member).filter(
        Member.first_purchase_date >= datetime.combine(start, datetime.min.time()),
        Member.first_purchase_date <= datetime.combine(end, datetime.max.time()),
    ).order_by(Member.first_purchase_date.asc()).all()

    data = [{
        "id": r.id,
        "email": r.email,
        "first_purchase_date": r.first_purchase_date.date().isoformat() if r.first_purchase_date else "",
        "first_purchase_source": r.first_purchase_source,
        "first_purchase_processor": r.first_purchase_processor,
        "tier": r.tier,
        "status": r.status,
    } for r in rows]
    return pd.DataFrame(data).to_csv(index=False)


def _b2b_deals(db: Session, start: date, end: date) -> str:
    rows = db.query(B2BDeal).filter(
        B2BDeal.close_date_actual >= start,
        B2BDeal.close_date_actual <= end,
    ).order_by(B2BDeal.close_date_actual.asc()).all()

    data = [{
        "id": r.id,
        "hubspot_deal_id": r.hubspot_deal_id,
        "company_name": r.company_name,
        "deal_name": r.deal_name,
        "deal_type": r.deal_type,
        "source": r.source,
        "owner": r.owner,
        "stage": r.stage,
        "status": r.status,
        "amount": r.amount,
        "currency": r.currency,
        "close_date_actual": r.close_date_actual.isoformat() if r.close_date_actual else "",
        "contract_end_date": r.contract_end_date.isoformat() if r.contract_end_date else "",
    } for r in rows]
    return pd.DataFrame(data).to_csv(index=False)


def _financial_records(db: Session, start: date, end: date) -> str:
    rows = db.query(FinancialRecord).filter(
        FinancialRecord.date >= start,
        FinancialRecord.date <= end,
    ).order_by(FinancialRecord.date.asc()).all()

    data = [{
        "id": r.id,
        "date": r.date.isoformat() if r.date else "",
        "category": r.category,
        "description": r.description,
        "amount": r.amount,
        "currency": r.currency,
        "zoho_transaction_id": r.zoho_transaction_id,
        "source": r.source,
    } for r in rows]
    return pd.DataFrame(data).to_csv(index=False)


def _cash_positions(db: Session) -> str:
    rows = db.query(CashPosition).order_by(CashPosition.date.desc()).limit(24).all()
    data = [{
        "date": r.date.isoformat() if r.date else "",
        "balance": r.balance,
        "source": r.source,
        "notes": r.notes,
    } for r in rows]
    return pd.DataFrame(data).to_csv(index=False)


def _summary_sheet(db: Session, start: date, end: date, label: str) -> str:
    from sqlalchemy import func
    b2c = float(db.query(func.coalesce(func.sum(Transaction.amount_net), 0)).filter(
        Transaction.date >= datetime.combine(start, datetime.min.time()),
        Transaction.date <= datetime.combine(end, datetime.max.time()),
        Transaction.is_refund.is_(False),
    ).scalar() or 0)
    b2b = float(db.query(func.coalesce(func.sum(B2BDeal.amount), 0)).filter(
        B2BDeal.status == "won",
        B2BDeal.close_date_actual >= start,
        B2BDeal.close_date_actual <= end,
    ).scalar() or 0)
    other = float(db.query(func.coalesce(func.sum(FinancialRecord.amount), 0)).filter(
        FinancialRecord.category == "revenue_other",
        FinancialRecord.date >= start,
        FinancialRecord.date <= end,
    ).scalar() or 0)
    expenses = float(db.query(func.coalesce(func.sum(FinancialRecord.amount), 0)).filter(
        FinancialRecord.category.like("expense_%"),
        FinancialRecord.date >= start,
        FinancialRecord.date <= end,
    ).scalar() or 0)
    members = db.query(func.count(Member.id)).filter(
        Member.first_purchase_date >= datetime.combine(start, datetime.min.time()),
        Member.first_purchase_date <= datetime.combine(end, datetime.max.time()),
    ).scalar() or 0

    rows = [
        {"metric": "Period", "value": label},
        {"metric": "B2C Revenue (net)", "value": round(b2c, 2)},
        {"metric": "B2B Revenue (bookings)", "value": round(b2b, 2)},
        {"metric": "Other Revenue", "value": round(other, 2)},
        {"metric": "Total Revenue", "value": round(b2c + b2b + other, 2)},
        {"metric": "Total Expenses", "value": round(expenses, 2)},
        {"metric": "Net Profit", "value": round(b2c + b2b + other - expenses, 2)},
        {"metric": "New B2C Members", "value": members},
    ]
    return pd.DataFrame(rows).to_csv(index=False)
