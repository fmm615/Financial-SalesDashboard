from __future__ import annotations
"""
Executive Cockpit — single endpoint that returns all data for the 60-second view.
Keeps the frontend to one network round-trip.
"""
from datetime import date, datetime, timedelta
from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session
from app.auth import get_current_user
from app.config import settings
from app.database import get_db
from app.models.members import Member, Transaction
from app.models.b2b import B2BDeal
from app.models.financial import CashPosition, FinancialRecord, SummitTracker

router = APIRouter(prefix="/api/cockpit", tags=["cockpit"])
Dep = Depends(get_current_user)


def _quarter(d: date) -> int:
    return (d.month - 1) // 3 + 1


def _quarter_start(d: date) -> date:
    q = _quarter(d)
    return date(d.year, (q - 1) * 3 + 1, 1)


@router.get("/summary")
def cockpit_summary(db: Session = Depends(get_db), _=Dep):
    today = date.today()
    month_start = today.replace(day=1)
    year_start = today.replace(month=1, day=1)
    q_start = _quarter_start(today)
    ago_90 = today - timedelta(days=90)
    ago_30 = today - timedelta(days=30)
    prev_month_end = month_start - timedelta(days=1)
    prev_month_start = prev_month_end.replace(day=1)

    # ── Bottom Line ──────────────────────────────────────────────────────────

    # This month's revenue (B2C from transactions + B2B from deals)
    b2c_mtd = float(db.query(func.coalesce(func.sum(Transaction.amount_net), 0)).filter(
        Transaction.date >= datetime.combine(month_start, datetime.min.time()),
        Transaction.is_refund.is_(False),
    ).scalar() or 0)
    b2b_mtd = float(db.query(func.coalesce(func.sum(B2BDeal.amount), 0)).filter(
        B2BDeal.status == "won",
        B2BDeal.close_date_actual >= month_start,
    ).scalar() or 0)
    revenue_mtd = b2c_mtd + b2b_mtd

    # Monthly target — uses admin-set overrides when present
    from app.targets import effective_targets
    targets = effective_targets(db)
    days_in_month = (month_start.replace(month=month_start.month % 12 + 1, day=1) - timedelta(days=1)).day if month_start.month < 12 else 31
    monthly_rev_target = targets["fy_revenue"] / 12
    days_elapsed = today.day
    expected_pace = monthly_rev_target * days_elapsed / days_in_month
    pacing_delta = revenue_mtd - expected_pace
    pacing_pct = (revenue_mtd / monthly_rev_target * 100) if monthly_rev_target > 0 else None
    revenue_status = (
        "green" if pacing_pct is not None and pacing_pct >= 90 else
        "amber" if pacing_pct is not None and pacing_pct >= 60 else "red"
    )

    # Cash & runway
    latest_cash = db.query(CashPosition).order_by(CashPosition.date.desc()).first()
    cash_balance = float(latest_cash.balance) if latest_cash else None
    expenses_3m = float(db.query(func.coalesce(func.sum(FinancialRecord.amount), 0)).filter(
        FinancialRecord.category.like("expense_%"),
        FinancialRecord.date >= today - timedelta(days=90),
    ).scalar() or 0)
    monthly_burn = expenses_3m / 3.0 if expenses_3m > 0 else None
    runway = (cash_balance / monthly_burn) if (cash_balance is not None and monthly_burn and monthly_burn > 0) else None
    runway_status = (
        "green" if runway is not None and runway > 12 else
        "amber" if runway is not None and runway >= 6 else "red"
    )

    # P&L this month
    month_expenses = float(db.query(func.coalesce(func.sum(FinancialRecord.amount), 0)).filter(
        FinancialRecord.category.like("expense_%"),
        FinancialRecord.date >= month_start,
    ).scalar() or 0)
    month_profit = revenue_mtd - month_expenses
    profit_status = "green" if month_profit >= 0 else "red"

    # ── Revenue Trend (6 months) ─────────────────────────────────────────────
    from app.date_utils import months_ago, month_end
    trend = []
    for i in range(5, -1, -1):
        ms = months_ago(today, i)
        me = month_end(ms)
        b2c = float(db.query(func.coalesce(func.sum(Transaction.amount_net), 0)).filter(
            Transaction.date.between(datetime.combine(ms, datetime.min.time()), datetime.combine(me, datetime.max.time())),
            Transaction.is_refund.is_(False),
        ).scalar() or 0)
        b2b = float(db.query(func.coalesce(func.sum(B2BDeal.amount), 0)).filter(
            B2BDeal.status == "won", B2BDeal.close_date_actual.between(ms, me),
        ).scalar() or 0)
        other = float(db.query(func.coalesce(func.sum(FinancialRecord.amount), 0)).filter(
            FinancialRecord.category == "revenue_other", FinancialRecord.date.between(ms, me),
        ).scalar() or 0)
        trend.append({"month": ms.strftime("%b %Y"), "b2c": b2c, "b2b": b2b, "other": other, "total": b2c + b2b + other})

    # MoM callouts
    cur = trend[-1] if trend else {}
    prev = trend[-2] if len(trend) >= 2 else {}
    def _pct(a, b): return round((a - b) / b * 100, 1) if b and b > 0 else None
    callouts = {
        "b2c_mom": _pct(cur.get("b2c", 0), prev.get("b2c", 0)),
        "b2b_mom": _pct(cur.get("b2b", 0), prev.get("b2b", 0)),
        "total_mom": _pct(cur.get("total", 0), prev.get("total", 0)),
    }

    # ── YTD vs targets ───────────────────────────────────────────────────────
    ytd_b2c = float(db.query(func.coalesce(func.sum(Transaction.amount_net), 0)).filter(
        Transaction.date >= datetime.combine(year_start, datetime.min.time()),
        Transaction.is_refund.is_(False),
    ).scalar() or 0)
    ytd_b2b = float(db.query(func.coalesce(func.sum(B2BDeal.amount), 0)).filter(
        B2BDeal.status == "won", B2BDeal.close_date_actual >= year_start,
    ).scalar() or 0)
    ytd_other = float(db.query(func.coalesce(func.sum(FinancialRecord.amount), 0)).filter(
        FinancialRecord.category == "revenue_other", FinancialRecord.date >= year_start,
    ).scalar() or 0)

    # ── What's Converting ────────────────────────────────────────────────────
    new_members_mtd = db.query(func.count(Member.id)).filter(
        Member.first_purchase_date >= datetime.combine(month_start, datetime.min.time())
    ).scalar() or 0
    active_monthly = db.query(func.count(Member.id)).filter(Member.tier == "core_monthly", Member.status == "active").scalar() or 0
    mrr_net_per = 50.42 / (1 + settings.b2c_vat_rate)
    mrr = active_monthly * mrr_net_per

    # ARPU MTD
    arpu = round(b2c_mtd / new_members_mtd, 2) if new_members_mtd > 0 else None

    # Top acquisition source
    top_src = db.query(
        Member.first_purchase_source, func.count(Member.id)
    ).filter(
        Member.first_purchase_date >= datetime.combine(month_start, datetime.min.time())
    ).group_by(Member.first_purchase_source).order_by(func.count(Member.id).desc()).first()

    # B2B this month
    won_90 = db.query(func.count(B2BDeal.id)).filter(B2BDeal.status == "won", B2BDeal.close_date_actual >= ago_90).scalar() or 0
    lost_90 = db.query(func.count(B2BDeal.id)).filter(B2BDeal.status == "lost", B2BDeal.close_date_actual >= ago_90).scalar() or 0
    win_rate = (won_90 / (won_90 + lost_90) * 100) if (won_90 + lost_90) > 0 else None

    b2b_mtd_count = db.query(func.count(B2BDeal.id)).filter(B2BDeal.status == "won", B2BDeal.close_date_actual >= month_start).scalar() or 0
    new_pipeline_mtd = db.query(func.coalesce(func.sum(B2BDeal.amount), 0)).filter(
        B2BDeal.created_at >= datetime.combine(month_start, datetime.min.time())
    ).scalar() or 0
    top_type = db.query(
        B2BDeal.deal_type, func.sum(B2BDeal.amount)
    ).filter(B2BDeal.status == "open").group_by(B2BDeal.deal_type).order_by(func.sum(B2BDeal.amount).desc()).first()
    top_deal_mtd = db.query(B2BDeal).filter(
        B2BDeal.status == "won", B2BDeal.close_date_actual >= month_start
    ).order_by(B2BDeal.amount.desc()).first()

    # ── Risks & Opportunities ────────────────────────────────────────────────
    signals = _compute_signals(
        db, today, new_members_mtd, revenue_mtd, runway, month_profit,
        ytd_b2c + ytd_b2b + ytd_other
    )

    return {
        "bottom_line": {
            "revenue_mtd": round(revenue_mtd, 2),
            "revenue_target": round(monthly_rev_target, 2),
            "revenue_pct": round(pacing_pct, 1) if pacing_pct is not None else None,
            "revenue_pacing_delta": round(pacing_delta, 2),
            "revenue_status": revenue_status,
            "cash_balance": cash_balance,
            "monthly_burn": round(monthly_burn, 2) if monthly_burn is not None else None,
            "runway_months": round(runway, 1) if runway is not None else None,
            "runway_status": runway_status,
            "month_profit": round(month_profit, 2),
            "profit_status": profit_status,
        },
        "revenue_trend": trend,
        "callouts": callouts,
        "targets": {
            "ytd_b2b": round(ytd_b2b, 2),
            "ytd_b2c": round(ytd_b2c, 2),
            "ytd_other": round(ytd_other, 2),
            "fy_b2b": targets["fy_b2b"],
            "fy_b2c": targets["fy_b2c"],
            "fy_other": targets["fy_other"],
        },
        "converting": {
            "b2c": {
                "new_members_mtd": new_members_mtd,
                "revenue_gross": round(b2c_mtd / (1 - settings.b2c_vat_rate / (1 + settings.b2c_vat_rate)), 2),
                "revenue_net": round(b2c_mtd, 2),
                "mrr": round(mrr, 2),
                "arpu": arpu,
                "top_source": top_src[0] if top_src else None,
            },
            "b2b": {
                "bookings_count": b2b_mtd_count,
                "bookings_value": round(b2b_mtd, 2),
                "top_deal": {"company": top_deal_mtd.company_name, "amount": top_deal_mtd.amount} if top_deal_mtd else None,
                "pipeline_added": float(new_pipeline_mtd),
                "win_rate_90d": round(win_rate, 1) if win_rate is not None else None,
                "top_type": top_type[0] if top_type else None,
            },
        },
        "signals": signals,
    }


def _compute_signals(db, today, new_members_mtd, revenue_mtd, runway, month_profit, ytd_total):
    """Threshold-driven risks & opportunities list. Max 5 items."""
    items = []
    month_start = today.replace(day=1)
    days_elapsed = today.day

    # B2C pacing — admin-set overrides when present
    from app.targets import effective_targets
    _t = effective_targets(db)
    target_mtd = _t["b2c_daily_members"] * days_elapsed
    if target_mtd > 0:
        pct = new_members_mtd / target_mtd * 100
        behind = int(target_mtd - new_members_mtd)
        if pct < 64:
            items.append({"type": "risk", "message": f"B2C conversion {round(100-pct)}% behind daily target — {behind} members short."})
        elif pct >= 110:
            items.append({"type": "opportunity", "message": f"B2C outpacing target by {round(pct-100)}% — {new_members_mtd - int(target_mtd)} members ahead."})

    # Runway alert
    if runway is not None:
        if runway < settings.cash_runway_critical_months:
            items.append({"type": "risk", "message": f"Runway critical: {runway:.1f} months at current burn rate."})
        elif runway < settings.cash_runway_warn_months:
            items.append({"type": "risk", "message": f"Runway below 12-month threshold: {runway:.1f} months."})
        elif runway >= 18:
            items.append({"type": "opportunity", "message": f"Runway healthy at {runway:.1f} months."})

    # B2B stuck deals
    stuck = db.query(B2BDeal).filter(
        B2BDeal.status == "open",
        B2BDeal.days_in_current_stage >= settings.b2b_stuck_deal_days,
    ).order_by(B2BDeal.amount.desc().nullslast()).first()
    if stuck:
        items.append({"type": "risk", "message": f"{stuck.company_name or 'Deal'} stuck in {stuck.stage} for {stuck.days_in_current_stage} days."})

    # Pipeline coverage
    q = (today.month - 1) // 3 + 1
    q_target = _t.get(f"q{q}", 0)
    if q_target > 0:
        open_pipeline = float(db.query(func.coalesce(func.sum(B2BDeal.amount), 0)).filter(B2BDeal.status == "open").scalar() or 0)
        coverage = open_pipeline / q_target
        if coverage < 3:
            items.append({"type": "risk", "message": f"B2B pipeline coverage {coverage:.1f}x quarterly target (3x recommended)."})
        elif coverage >= 4:
            items.append({"type": "opportunity", "message": f"B2B pipeline strong at {coverage:.1f}x quarterly target."})

    # Profit
    if month_profit > 0 and days_elapsed >= 15:
        items.append({"type": "opportunity", "message": f"Month profitable at ${month_profit:,.0f} net — through day {days_elapsed}."})

    # Summit
    summit = db.query(SummitTracker).order_by(SummitTracker.snapshot_date.desc()).first()
    if summit and summit.ticket_registrations:
        ticket_target = summit.ticket_target or settings.summit_ticket_target
        pct = summit.ticket_registrations / ticket_target * 100
        summit_dt = __import__("datetime").datetime.strptime(settings.summit_date, "%Y-%m-%d").date()
        days_away = (summit_dt - today).days
        if pct >= 50 and days_away > 0:
            items.append({"type": "opportunity", "message": f"Summit ticketing {pct:.0f}% sold with {days_away} days to go."})

    return items[:5]