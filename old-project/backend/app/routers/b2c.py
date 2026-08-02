from __future__ import annotations
from datetime import date, datetime, timedelta
from typing import Optional
from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, and_
from sqlalchemy.orm import Session
from app.auth import get_current_user
from app.config import settings
from app.database import get_db
from app.models.members import Member, Transaction, IBANEntry
from app.date_utils import months_ago, month_end

router = APIRouter(prefix="/api/b2c", tags=["b2c"])
Dep = Depends(get_current_user)


def _date_range(days_back: Optional[int] = None, start: Optional[str] = None, end: Optional[str] = None):
    today = date.today()
    if start and end:
        return datetime.strptime(start, "%Y-%m-%d"), datetime.strptime(end, "%Y-%m-%d").replace(hour=23, minute=59)
    d = timedelta(days=days_back or 30)
    return datetime.combine(today - d, datetime.min.time()), datetime.combine(today, datetime.max.time())


@router.get("/metrics")
def b2c_metrics(db: Session = Depends(get_db), _=Dep):
    today = date.today()
    month_start = today.replace(day=1)
    week_ago = today - timedelta(days=7)
    yesterday = today - timedelta(days=1)

    total_members = db.query(func.count(Member.id)).filter(Member.status == "active").scalar() or 0
    new_today = db.query(func.count(Member.id)).filter(
        func.date(Member.first_purchase_date) == today
    ).scalar() or 0
    new_yesterday = db.query(func.count(Member.id)).filter(
        func.date(Member.first_purchase_date) == yesterday
    ).scalar() or 0
    new_mtd = db.query(func.count(Member.id)).filter(
        Member.first_purchase_date >= datetime.combine(month_start, datetime.min.time())
    ).scalar() or 0

    # 7-day average
    new_7d = db.query(func.count(Member.id)).filter(
        Member.first_purchase_date >= datetime.combine(week_ago, datetime.min.time())
    ).scalar() or 0
    avg_7d = new_7d / 7.0

    # Revenue today/MTD
    rev_today = db.query(
        func.coalesce(func.sum(Transaction.amount_gross), 0),
        func.coalesce(func.sum(Transaction.amount_net), 0),
    ).filter(
        func.date(Transaction.date) == today,
        Transaction.is_refund.is_(False),
    ).one()
    rev_mtd = db.query(
        func.coalesce(func.sum(Transaction.amount_gross), 0),
        func.coalesce(func.sum(Transaction.amount_net), 0),
    ).filter(
        Transaction.date >= datetime.combine(month_start, datetime.min.time()),
        Transaction.is_refund.is_(False),
    ).one()

    # Subscription counts for MRR
    active_monthly = db.query(func.count(Member.id)).filter(
        Member.tier == "core_monthly", Member.status == "active"
    ).scalar() or 0
    active_annual = db.query(func.count(Member.id)).filter(
        Member.tier == "core_annual", Member.status == "active"
    ).scalar() or 0
    founding = db.query(func.count(Member.id)).filter(
        Member.tier == "founding", Member.status == "active"
    ).scalar() or 0

    mrr_net_per = 50.42 / (1 + settings.b2c_vat_rate)
    mrr = active_monthly * mrr_net_per
    arr = mrr * 12 + active_annual * (605 / 1.1)

    # Pacing
    days_elapsed = today.day
    days_in_month = (month_start.replace(month=month_start.month % 12 + 1, day=1) - timedelta(days=1)).day if month_start.month < 12 else 31
    target_mtd = settings.b2c_member_daily_target * days_elapsed
    pace_pct = (new_mtd / target_mtd * 100) if target_mtd > 0 else None
    projected_eom = (new_mtd / days_elapsed * days_in_month) if days_elapsed > 0 else None

    # Refunds MTD
    refunds_mtd = db.query(func.count(Transaction.id)).filter(
        Transaction.date >= datetime.combine(month_start, datetime.min.time()),
        Transaction.is_refund.is_(True),
    ).scalar() or 0

    return {
        "total_members": total_members,
        "new_today": new_today,
        "new_yesterday": new_yesterday,
        "new_mtd": new_mtd,
        "avg_7d": round(avg_7d, 1),
        "revenue_today_gross": float(rev_today[0]),
        "revenue_today_net": float(rev_today[1]),
        "revenue_mtd_gross": float(rev_mtd[0]),
        "revenue_mtd_net": float(rev_mtd[1]),
        "active_monthly_subs": active_monthly,
        "active_annual_subs": active_annual,
        "founding_members": founding,
        "mrr": round(mrr, 2),
        "arr": round(arr, 2),
        "pace_pct": round(pace_pct, 1) if pace_pct is not None else None,
        "projected_eom_members": round(projected_eom, 0) if projected_eom is not None else None,
        "days_elapsed": days_elapsed,
        "days_in_month": days_in_month,
        "monthly_target": settings.b2c_member_daily_target * days_in_month,
        "refunds_mtd": refunds_mtd,
        "daily_target": settings.b2c_member_daily_target,
    }


@router.get("/trend")
def b2c_trend(
    days: int = Query(90, ge=7, le=365),
    db: Session = Depends(get_db),
    _=Dep,
):
    since = date.today() - timedelta(days=days)
    rows = db.query(
        func.date(Member.first_purchase_date).label("day"),
        func.count(Member.id).label("new_members"),
    ).filter(
        Member.first_purchase_date >= datetime.combine(since, datetime.min.time())
    ).group_by("day").order_by("day").all()

    rev_rows = db.query(
        func.date(Transaction.date).label("day"),
        func.sum(Transaction.amount_gross).label("gross"),
        func.sum(Transaction.amount_net).label("net"),
    ).filter(
        Transaction.date >= datetime.combine(since, datetime.min.time()),
        Transaction.is_refund.is_(False),
    ).group_by("day").all()

    rev_by_day = {str(r.day): {"gross": float(r.gross or 0), "net": float(r.net or 0)} for r in rev_rows}
    target = settings.b2c_member_daily_target

    return [
        {
            "date": str(r.day),
            "new_members": r.new_members,
            "revenue_gross": rev_by_day.get(str(r.day), {}).get("gross", 0),
            "revenue_net": rev_by_day.get(str(r.day), {}).get("net", 0),
            "target": target,
        }
        for r in rows
    ]


@router.get("/sources")
def b2c_sources(
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    _=Dep,
):
    month_start = date.today().replace(day=1)
    dt_start = datetime.strptime(start, "%Y-%m-%d") if start else datetime.combine(month_start, datetime.min.time())
    dt_end = datetime.strptime(end, "%Y-%m-%d").replace(hour=23, minute=59) if end else datetime.now()

    rows = db.query(
        Member.first_purchase_source.label("source"),
        func.count(Member.id).label("count"),
    ).filter(
        Member.first_purchase_date.between(dt_start, dt_end)
    ).group_by(Member.first_purchase_source).order_by(func.count(Member.id).desc()).all()

    return [{"source": r.source or "unknown", "count": r.count} for r in rows]


@router.get("/processors")
def b2c_processors(
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    _=Dep,
):
    month_start = date.today().replace(day=1)
    dt_start = datetime.strptime(start, "%Y-%m-%d") if start else datetime.combine(month_start, datetime.min.time())
    dt_end = datetime.strptime(end, "%Y-%m-%d").replace(hour=23, minute=59) if end else datetime.now()

    rows = db.query(
        Transaction.processor,
        func.count(Transaction.id).label("count"),
        func.sum(Transaction.amount_gross).label("gross"),
    ).filter(
        Transaction.date.between(dt_start, dt_end),
        Transaction.is_first_purchase.is_(True),
    ).group_by(Transaction.processor).all()

    return [{"processor": r.processor, "count": r.count, "gross": float(r.gross or 0)} for r in rows]


@router.get("/subscription-health")
def subscription_health(db: Session = Depends(get_db), _=Dep):
    today = date.today()
    mrr_net_per = 50.42 / (1 + settings.b2c_vat_rate)

    # MRR trend: last 12 months (estimate from new members - churned)
    from app.date_utils import months_ago, month_end
    months = []
    for i in range(11, -1, -1):
        m_start = months_ago(today, i)
        m_end_day = month_end(m_start)
        monthly = db.query(func.count(Member.id)).filter(
            Member.tier == "core_monthly",
            Member.first_purchase_date <= datetime.combine(m_end_day, datetime.max.time()),
            Member.status == "active",
        ).scalar() or 0
        months.append({"month": m_start.strftime("%Y-%m"), "active_monthly": monthly, "mrr": round(monthly * mrr_net_per, 2)})

    active_monthly = db.query(func.count(Member.id)).filter(Member.tier == "core_monthly", Member.status == "active").scalar() or 0
    active_annual = db.query(func.count(Member.id)).filter(Member.tier == "core_annual", Member.status == "active").scalar() or 0
    founding = db.query(func.count(Member.id)).filter(Member.tier == "founding", Member.status == "active").scalar() or 0

    mrr = active_monthly * mrr_net_per
    annual_net = 605 / (1 + settings.b2c_vat_rate)
    arr = mrr * 12 + active_annual * annual_net + founding * (1500 / (1 + settings.b2c_vat_rate))

    return {
        "active_monthly": active_monthly,
        "active_annual": active_annual,
        "founding": founding,
        "mrr": round(mrr, 2),
        "arr": round(arr, 2),
        "mrr_trend": months,
    }


@router.get("/members")
def list_members(
    limit: int = Query(50, le=200),
    offset: int = Query(0),
    status: Optional[str] = Query(None),
    tier: Optional[str] = Query(None),
    source: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    _=Dep,
):
    q = db.query(Member)
    if status:
        q = q.filter(Member.status == status)
    if tier:
        q = q.filter(Member.tier == tier)
    if source:
        q = q.filter(Member.first_purchase_source == source)
    total = q.count()
    members = q.order_by(Member.first_purchase_date.desc()).offset(offset).limit(limit).all()
    return {
        "total": total,
        "items": [
            {
                "id": m.id,
                "email": m.email,
                "tier": m.tier,
                "status": m.status,
                "source": m.first_purchase_source,
                "processor": m.first_purchase_processor,
                "country": m.country,
                "joined": m.first_purchase_date.isoformat() if m.first_purchase_date else None,
            }
            for m in members
        ],
    }


@router.get("/transactions")
def list_transactions(
    limit: int = Query(50, le=200),
    offset: int = Query(0),
    start: Optional[str] = Query(None),
    end: Optional[str] = Query(None),
    processor: Optional[str] = Query(None),
    db: Session = Depends(get_db),
    _=Dep,
):
    q = db.query(Transaction)
    if start:
        q = q.filter(Transaction.date >= datetime.strptime(start, "%Y-%m-%d"))
    if end:
        q = q.filter(Transaction.date <= datetime.strptime(end, "%Y-%m-%d").replace(hour=23, minute=59))
    if processor:
        q = q.filter(Transaction.processor == processor)
    total = q.count()
    rows = q.order_by(Transaction.date.desc()).offset(offset).limit(limit).all()
    return {
        "total": total,
        "items": [
            {
                "id": t.id,
                "email": t.email,
                "date": t.date.isoformat(),
                "processor": t.processor,
                "category": t.category,
                "amount_gross": t.amount_gross,
                "amount_net": t.amount_net,
                "currency": t.currency,
                "is_first": t.is_first_purchase,
                "is_renewal": t.is_renewal,
                "is_refund": t.is_refund,
            }
            for t in rows
        ],
    }