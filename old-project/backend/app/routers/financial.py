from __future__ import annotations
from datetime import date, datetime, timedelta
from typing import Optional
from fastapi import APIRouter, Depends, Query
from sqlalchemy import func
from sqlalchemy.orm import Session
from app.auth import get_current_user
from app.config import settings
from app.database import get_db
from app.models.financial import CashPosition, DailySnapshot, FinancialRecord, SummitTracker
from app.models.members import Member, Transaction
from app.models.b2b import B2BDeal
from app.date_utils import months_ago, month_end
from app.targets import effective_targets

router = APIRouter(prefix="/api/financial", tags=["financial"])
Dep = Depends(get_current_user)


@router.get("/summary")
def financial_summary(db: Session = Depends(get_db), _=Dep):
    today = date.today()
    month_start = today.replace(day=1)

    # Cash & runway
    latest_cash = db.query(CashPosition).order_by(CashPosition.date.desc()).first()
    cash_balance = latest_cash.balance if latest_cash else None

    # Burn rate: trailing 3 months avg expenses
    three_months_ago = today - timedelta(days=90)
    total_expenses = db.query(func.coalesce(func.sum(FinancialRecord.amount), 0)).filter(
        FinancialRecord.category.like("expense_%"),
        FinancialRecord.date >= three_months_ago,
    ).scalar() or 0
    monthly_burn = float(total_expenses) / 3.0
    runway_months = (cash_balance / monthly_burn) if (cash_balance is not None and monthly_burn > 0) else None

    # Revenue YTD
    year_start = today.replace(month=1, day=1)
    ytd_b2b = float(db.query(func.coalesce(func.sum(FinancialRecord.amount), 0)).filter(
        FinancialRecord.category == "revenue_b2b", FinancialRecord.date >= year_start
    ).scalar() or 0)
    ytd_b2c_fin = float(db.query(func.coalesce(func.sum(FinancialRecord.amount), 0)).filter(
        FinancialRecord.category == "revenue_b2c", FinancialRecord.date >= year_start
    ).scalar() or 0)
    ytd_other = float(db.query(func.coalesce(func.sum(FinancialRecord.amount), 0)).filter(
        FinancialRecord.category == "revenue_other", FinancialRecord.date >= year_start
    ).scalar() or 0)

    # B2C bookings from transactions (canonical source until Zoho live)
    ytd_b2c_bookings = float(db.query(func.coalesce(func.sum(Transaction.amount_net), 0)).filter(
        Transaction.date >= datetime.combine(year_start, datetime.min.time()),
        Transaction.is_refund.is_(False),
    ).scalar() or 0)
    # Use whichever is larger — financial_records (Zoho recognized) or transactions (bookings)
    ytd_b2c = max(ytd_b2c_fin, ytd_b2c_bookings)

    # B2B bookings from HubSpot
    ytd_b2b_bookings = float(db.query(func.coalesce(func.sum(B2BDeal.amount), 0)).filter(
        B2BDeal.status == "won",
        B2BDeal.close_date_actual >= year_start,
    ).scalar() or 0)
    # Use Zoho recognized if available, else bookings
    ytd_b2b_display = ytd_b2b if ytd_b2b > 0 else ytd_b2b_bookings

    ytd_total = ytd_b2b_display + ytd_b2c + ytd_other

    # P&L this month (from financial_records only)
    month_revenue = float(db.query(func.coalesce(func.sum(FinancialRecord.amount), 0)).filter(
        FinancialRecord.category.like("revenue_%"),
        FinancialRecord.date >= month_start,
    ).scalar() or 0)
    month_expenses = float(db.query(func.coalesce(func.sum(FinancialRecord.amount), 0)).filter(
        FinancialRecord.category.like("expense_%"),
        FinancialRecord.date >= month_start,
    ).scalar() or 0)
    month_profit = month_revenue - month_expenses

    from app.targets import effective_targets
    _targets = effective_targets(db)

    return {
        "cash_balance": cash_balance,
        "cash_as_of": latest_cash.date.isoformat() if latest_cash else None,
        "monthly_burn": round(monthly_burn, 2) if monthly_burn > 0 else None,
        "runway_months": round(runway_months, 1) if runway_months is not None else None,
        "ytd_revenue": round(ytd_total, 2),
        "ytd_b2b": round(ytd_b2b_display, 2),
        "ytd_b2b_bookings": round(ytd_b2b_bookings, 2),
        "ytd_b2c": round(ytd_b2c, 2),
        "ytd_other": round(ytd_other, 2),
        "fy_target": _targets["fy_revenue"],
        "fy_target_b2b": _targets["fy_b2b"],
        "fy_target_b2c": _targets["fy_b2c"],
        "fy_target_other": _targets["fy_other"],
        "ytd_pct": round(ytd_total / _targets["fy_revenue"] * 100, 1) if _targets["fy_revenue"] > 0 else None,
        "month_revenue": round(month_revenue, 2),
        "month_expenses": round(month_expenses, 2),
        "month_profit": round(month_profit, 2),
        "zoho_sync_enabled": settings.zoho_sync_enabled,
    }


@router.get("/revenue-trend")
def revenue_trend(
    months: int = Query(12, ge=3, le=24),
    db: Session = Depends(get_db),
    _=Dep,
):
    today = date.today()
    from app.date_utils import months_ago, month_end
    result = []
    for i in range(months - 1, -1, -1):
        m_start = months_ago(today, i)
        m_end = month_end(m_start)

        def _rev(cat):
            return float(db.query(func.coalesce(func.sum(FinancialRecord.amount), 0)).filter(
                FinancialRecord.category == cat,
                FinancialRecord.date.between(m_start, m_end),
            ).scalar() or 0)

        # B2C from transactions if Zoho not live
        b2c_txn = float(db.query(func.coalesce(func.sum(Transaction.amount_net), 0)).filter(
            Transaction.date.between(
                datetime.combine(m_start, datetime.min.time()),
                datetime.combine(m_end, datetime.max.time()),
            ),
            Transaction.is_refund.is_(False),
        ).scalar() or 0)

        b2b_fin = _rev("revenue_b2b")
        b2b_bookings = float(db.query(func.coalesce(func.sum(B2BDeal.amount), 0)).filter(
            B2BDeal.status == "won",
            B2BDeal.close_date_actual.between(m_start, m_end),
        ).scalar() or 0)

        result.append({
            "month": m_start.strftime("%Y-%m"),
            "label": m_start.strftime("%b %Y"),
            "b2c": round(max(_rev("revenue_b2c"), b2c_txn), 2),
            "b2b": round(b2b_fin if b2b_fin > 0 else b2b_bookings, 2),
            "b2b_bookings": round(b2b_bookings, 2),
            "b2b_recognized": round(b2b_fin, 2),
            "other": round(_rev("revenue_other"), 2),
        })
    return result


@router.get("/expenses")
def expenses(
    months: int = Query(12, ge=1, le=24),
    db: Session = Depends(get_db),
    _=Dep,
):
    today = date.today()
    since = today.replace(day=1) - timedelta(days=(months - 1) * 30)
    since = since.replace(day=1)

 # `strftime` is SQLite-only; Postgres needs `to_char`. Pick the right
    # SQL function based on the active dialect so this works on both.
    dialect = db.bind.dialect.name if db.bind is not None else ""
    if dialect == "postgresql":
        month_expr = func.to_char(FinancialRecord.date, "YYYY-MM")
    else:
        month_expr = func.strftime("%Y-%m", FinancialRecord.date)

    rows = db.query(
        FinancialRecord.category,
        month_expr.label("month"),
        func.sum(FinancialRecord.amount).label("amount"),
    ).filter(
        FinancialRecord.category.like("expense_%"),
        FinancialRecord.date >= since,
    ).group_by(FinancialRecord.category, "month").all()

    return [{"category": r.category, "month": r.month, "amount": float(r.amount or 0)} for r in rows]


@router.get("/summit")
def summit_tracker(db: Session = Depends(get_db), _=Dep):
    latest = db.query(SummitTracker).order_by(SummitTracker.snapshot_date.desc()).first()
    if not latest:
        return {"has_data": False}

    summit_date = datetime.strptime(settings.summit_date, "%Y-%m-%d").date()
    days_away = (summit_date - date.today()).days
    gap = latest.gap_to_breakeven if latest.gap_to_breakeven is not None else (
        (settings.summit_total_cost_target - (latest.revenue_raised_to_date or 0))
        if latest.revenue_raised_to_date is not None else None
    )
    daily_target = round(gap / days_away, 2) if (gap is not None and days_away > 0) else None

    return {
        "has_data": True,
        "snapshot_date": latest.snapshot_date.isoformat(),
        "ticket_registrations": latest.ticket_registrations,
        "ticket_target": latest.ticket_target or settings.summit_ticket_target,
        "judges_confirmed": latest.judges_confirmed,
        "judges_target": latest.judges_target or settings.summit_judge_target,
        "mou_signed": latest.mou_signed,
        "mou_target": latest.mou_target or settings.summit_mou_target,
        "booths_sold": latest.booths_sold,
        "revenue_raised_to_date": latest.revenue_raised_to_date,
        "total_summit_costs": latest.total_summit_costs or settings.summit_total_cost_target,
        "gap_to_breakeven": gap,
        "days_to_summit": days_away,
        "daily_close_target": daily_target,
        "summit_date": settings.summit_date,
    }


@router.post("/summit")
def update_summit(
    data: dict,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    from app.auth import get_username
    today = date.today()
    tracker = db.query(SummitTracker).filter(SummitTracker.snapshot_date == today).first()
    if not tracker:
        tracker = SummitTracker(snapshot_date=today)
        db.add(tracker)
    allowed = [
        "ticket_registrations", "judges_confirmed", "mou_signed", "booths_sold",
        "moderators_confirmed", "pitching_confirmed", "b2b_partners_confirmed",
        "revenue_raised_to_date", "total_summit_costs", "notes",
    ]
    for field in allowed:
        if field in data:
            setattr(tracker, field, data[field])
    tracker.updated_by = user.get("sub", "admin")

    # Recalculate gap
    if tracker.revenue_raised_to_date is not None:
        total_costs = tracker.total_summit_costs or settings.summit_total_cost_target
        tracker.gap_to_breakeven = total_costs - tracker.revenue_raised_to_date

    db.commit()
    return {"status": "ok"}


@router.post("/cash")
def add_cash_position(
    data: dict,
    db: Session = Depends(get_db),
    _=Dep,
):
    """Manually record cash position (Phase 1, until Zoho live)."""
    pos = CashPosition(
        date=datetime.strptime(data["date"], "%Y-%m-%d").date(),
        balance=float(data["balance"]),
        source="manual",
        notes=data.get("notes"),
    )
    db.add(pos)
    db.commit()
    return {"status": "ok", "id": pos.id}