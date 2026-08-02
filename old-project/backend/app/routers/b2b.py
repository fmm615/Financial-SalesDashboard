from __future__ import annotations
from datetime import date, datetime, timedelta
from typing import Optional
from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, and_, case
from sqlalchemy.orm import Session
from app.auth import get_current_user
from app.config import settings
from app.database import get_db
from app.models.b2b import B2BDeal, B2BDealHistory

router = APIRouter(prefix="/api/b2b", tags=["b2b"])
Dep = Depends(get_current_user)


def _quarter_bounds(d: date) -> tuple[date, date]:
    q = (d.month - 1) // 3
    q_start = date(d.year, q * 3 + 1, 1)
    q_end_month = q_start.month + 2
    q_end_year = q_start.year + (1 if q_end_month > 12 else 0)
    q_end_month = q_end_month % 12 or 12
    last_day = (date(q_end_year, q_end_month % 12 + 1, 1) - timedelta(days=1)) if q_end_month < 12 else date(q_end_year, 12, 31)
    return q_start, last_day


@router.get("/metrics")
def b2b_metrics(db: Session = Depends(get_db), _=Dep):
    today = date.today()
    q_start, q_end = _quarter_bounds(today)
    month_start = today.replace(day=1)
    ago_90 = today - timedelta(days=90)
    ago_7 = today - timedelta(days=7)
    ago_14 = today - timedelta(days=14)

    open_pipeline = db.query(func.coalesce(func.sum(B2BDeal.amount), 0)).filter(
        B2BDeal.status == "open"
    ).scalar() or 0

    open_count = db.query(func.count(B2BDeal.id)).filter(B2BDeal.status == "open").scalar() or 0

    bookings_qtd = db.query(func.coalesce(func.sum(B2BDeal.amount), 0)).filter(
        B2BDeal.status == "won",
        B2BDeal.close_date_actual >= q_start,
        B2BDeal.close_date_actual <= q_end,
    ).scalar() or 0

    bookings_qtd_count = db.query(func.count(B2BDeal.id)).filter(
        B2BDeal.status == "won",
        B2BDeal.close_date_actual >= q_start,
        B2BDeal.close_date_actual <= q_end,
    ).scalar() or 0

    bookings_mtd = db.query(func.coalesce(func.sum(B2BDeal.amount), 0)).filter(
        B2BDeal.status == "won",
        B2BDeal.close_date_actual >= month_start,
    ).scalar() or 0

    # Win rate rolling 90d
    won_90 = db.query(func.count(B2BDeal.id)).filter(
        B2BDeal.status == "won", B2BDeal.close_date_actual >= ago_90
    ).scalar() or 0
    lost_90 = db.query(func.count(B2BDeal.id)).filter(
        B2BDeal.status == "lost", B2BDeal.close_date_actual >= ago_90
    ).scalar() or 0
    win_rate = (won_90 / (won_90 + lost_90) * 100) if (won_90 + lost_90) > 0 else None

    # Pipeline added last 7d vs prior 7d
    new_7d = db.query(func.coalesce(func.sum(B2BDeal.amount), 0)).filter(
        B2BDeal.created_at >= datetime.combine(ago_7, datetime.min.time())
    ).scalar() or 0
    new_prev_7d = db.query(func.coalesce(func.sum(B2BDeal.amount), 0)).filter(
        B2BDeal.created_at >= datetime.combine(ago_14, datetime.min.time()),
        B2BDeal.created_at < datetime.combine(ago_7, datetime.min.time()),
    ).scalar() or 0

    # Top deal closed this quarter
    top_deal = db.query(B2BDeal).filter(
        B2BDeal.status == "won",
        B2BDeal.close_date_actual >= q_start,
    ).order_by(B2BDeal.amount.desc()).first()

    # Quarter label
    q_num = (today.month - 1) // 3 + 1
    q_label = f"Q{q_num} {today.year}"
    q_target = settings.quarterly_targets.get(f"Q{q_num}", 0)

    return {
        "open_pipeline_value": float(open_pipeline),
        "open_deal_count": open_count,
        "bookings_qtd": float(bookings_qtd),
        "bookings_qtd_count": bookings_qtd_count,
        "bookings_mtd": float(bookings_mtd),
        "win_rate_90d": round(win_rate, 1) if win_rate is not None else None,
        "pipeline_added_7d": float(new_7d),
        "pipeline_added_prev_7d": float(new_prev_7d),
        "quarter_label": q_label,
        "quarter_target": q_target,
        "top_deal_qtd": {
            "company": top_deal.company_name,
            "amount": top_deal.amount,
        } if top_deal else None,
    }


@router.get("/pipeline")
def b2b_pipeline(db: Session = Depends(get_db), _=Dep):
    stage_order = settings.hubspot_stage_list
    rows = db.query(
        B2BDeal.stage,
        func.count(B2BDeal.id).label("count"),
        func.coalesce(func.sum(B2BDeal.amount), 0).label("value"),
    ).filter(B2BDeal.status == "open").group_by(B2BDeal.stage).all()

    by_stage = {r.stage: {"count": r.count, "value": float(r.value)} for r in rows}
    result = []
    for stage in stage_order:
        if stage in ("closedwon", "closedlost"):
            continue
        d = by_stage.get(stage, {"count": 0, "value": 0.0})
        result.append({"stage": stage, "count": d["count"], "value": d["value"]})
    return result


@router.get("/velocity")
def b2b_velocity(db: Session = Depends(get_db), _=Dep):
    """Average days spent in each stage across all deals."""
    rows = db.query(
        B2BDeal.stage,
        func.avg(B2BDeal.days_in_current_stage).label("avg_days"),
        func.count(B2BDeal.id).label("count"),
    ).filter(
        B2BDeal.days_in_current_stage.isnot(None),
        B2BDeal.status == "open",
    ).group_by(B2BDeal.stage).all()

    return [{"stage": r.stage, "avg_days": round(float(r.avg_days or 0), 1), "count": r.count} for r in rows]


@router.get("/deals")
def b2b_deals(
    status: Optional[str] = Query(None),
    stage: Optional[str] = Query(None),
    deal_type: Optional[str] = Query(None),
    owner: Optional[str] = Query(None),
    limit: int = Query(50, le=200),
    offset: int = Query(0),
    db: Session = Depends(get_db),
    _=Dep,
):
    q = db.query(B2BDeal)
    if status:
        q = q.filter(B2BDeal.status == status)
    if stage:
        q = q.filter(B2BDeal.stage == stage)
    if deal_type:
        q = q.filter(B2BDeal.deal_type == deal_type)
    if owner:
        q = q.filter(B2BDeal.owner_name.ilike(f"%{owner}%"))
    total = q.count()
    deals = q.order_by(B2BDeal.amount.desc().nullslast()).offset(offset).limit(limit).all()
    return {
        "total": total,
        "items": [
            {
                "id": d.id,
                "company": d.company_name,
                "name": d.deal_name,
                "amount": d.amount,
                "stage": d.stage,
                "status": d.status,
                "deal_type": d.deal_type,
                "source": d.source,
                "owner": d.owner_name,
                "close_date_expected": d.close_date_expected.isoformat() if d.close_date_expected else None,
                "close_date_actual": d.close_date_actual.isoformat() if d.close_date_actual else None,
                "contract_end_date": d.contract_end_date.isoformat() if d.contract_end_date else None,
                "days_in_stage": d.days_in_current_stage,
                "last_activity": d.last_activity_date.isoformat() if d.last_activity_date else None,
            }
            for d in deals
        ],
    }


@router.get("/breakdowns")
def b2b_breakdowns(db: Session = Depends(get_db), _=Dep):
    """By type, by source, by owner — all open deals."""

    def _breakdown(col):
        rows = db.query(col, func.count(B2BDeal.id), func.coalesce(func.sum(B2BDeal.amount), 0)).filter(
            B2BDeal.status == "open"
        ).group_by(col).order_by(func.sum(B2BDeal.amount).desc().nullslast()).all()
        return [{"label": r[0] or "Unknown", "count": r[1], "value": float(r[2])} for r in rows]

    return {
        "by_type": _breakdown(B2BDeal.deal_type),
        "by_source": _breakdown(B2BDeal.source),
        "by_owner": _breakdown(B2BDeal.owner_name),
    }


@router.get("/renewals")
def b2b_renewals(db: Session = Depends(get_db), _=Dep):
    today = date.today()
    buckets = {
        "30d": today + timedelta(days=30),
        "60d": today + timedelta(days=60),
        "90d": today + timedelta(days=90),
    }
    result = {}
    for label, cutoff in buckets.items():
        deals = db.query(B2BDeal).filter(
            B2BDeal.contract_end_date >= today,
            B2BDeal.contract_end_date <= cutoff,
            B2BDeal.status == "won",
        ).order_by(B2BDeal.contract_end_date).all()
        result[label] = [
            {
                "company": d.company_name,
                "amount": d.amount,
                "end_date": d.contract_end_date.isoformat(),
                "days_away": (d.contract_end_date - today).days,
            }
            for d in deals
        ]
    has_data = any(result.values())
    return {"has_data": has_data, "buckets": result}


@router.get("/activity")
def b2b_activity(
    limit: int = Query(20, le=100),
    db: Session = Depends(get_db),
    _=Dep,
):
    rows = db.query(B2BDealHistory).order_by(B2BDealHistory.timestamp.desc()).limit(limit).all()
    deals = {d.id: d for d in db.query(B2BDeal).filter(
        B2BDeal.id.in_([r.deal_id for r in rows])
    ).all()}
    return [
        {
            "timestamp": r.timestamp.isoformat(),
            "deal_id": r.deal_id,
            "company": deals.get(r.deal_id, type("", (), {"company_name": ""})()).company_name,
            "field": r.field_changed,
            "old_value": r.old_value,
            "new_value": r.new_value,
        }
        for r in rows
    ]
