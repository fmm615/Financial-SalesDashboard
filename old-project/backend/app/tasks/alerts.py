from __future__ import annotations
"""
Anomaly detection and Slack alerting.
Called daily by the scheduler. Thresholds are env-configurable.
"""
import logging
from datetime import date, datetime, timedelta

logger = logging.getLogger(__name__)


def run_alerts(db=None) -> dict:
    close_db = False
    if db is None:
        from app.database import SessionLocal
        db = SessionLocal()
        close_db = True
    try:
        alerts_fired = []
        alerts_fired += _check_b2c(db)
        alerts_fired += _check_b2b(db)
        alerts_fired += _check_financial(db)
        return {"alerts_fired": len(alerts_fired), "details": alerts_fired}
    finally:
        if close_db:
            db.close()


def _check_b2c(db) -> list:
    from sqlalchemy import func
    from app.config import settings
    from app.models.members import Member
    from app.services.slack_service import alert_b2c_anomaly

    today = date.today()
    alerts = []

    # Consecutive days below 50% of daily target
    threshold = settings.b2c_member_daily_target * 0.5
    for look_back in range(1, 4):
        d = today - timedelta(days=look_back)
        count = db.query(func.count(Member.id)).filter(
            Member.first_purchase_date >= datetime.combine(d, datetime.min.time()),
            Member.first_purchase_date < datetime.combine(d + timedelta(days=1), datetime.min.time()),
        ).scalar() or 0
        if count >= threshold:
            break  # not consecutive, don't fire
    else:
        msg = f"B2C alert: 3 consecutive days below 50% new-member target (< {threshold:.0f}/day)"
        logger.warning(msg)
        try:
            alert_b2c_anomaly(msg)
        except Exception as e:
            logger.error("Slack alert failed: %s", e)
        alerts.append({"type": "b2c_low_conversion", "message": msg})

    return alerts


def _check_b2b(db) -> list:
    from sqlalchemy import func
    from app.config import settings
    from app.models.b2b import B2BDeal
    from app.services.slack_service import alert_b2b_anomaly

    today = date.today()
    alerts = []

    # Large deal lost in last 24h
    yesterday = today - timedelta(days=1)
    large_lost = db.query(B2BDeal).filter(
        B2BDeal.status == "lost",
        B2BDeal.synced_at >= datetime.combine(yesterday, datetime.min.time()),
        B2BDeal.amount >= 100_000,
    ).all()
    for deal in large_lost:
        msg = f"B2B alert: Large deal lost — {deal.company_name} (${float(deal.amount):,.0f})"
        try:
            alert_b2b_anomaly(msg)
        except Exception as e:
            logger.error("Slack alert failed: %s", e)
        alerts.append({"type": "b2b_large_deal_lost", "message": msg})

    # Stuck deals (no stage movement)
    stuck = db.query(B2BDeal).filter(
        B2BDeal.status == "open",
        B2BDeal.days_in_current_stage >= settings.b2b_stuck_deal_days,
    ).order_by(B2BDeal.amount.desc()).all()
    if stuck:
        names = ", ".join(f"{d.company_name or 'Unknown'} ({d.days_in_current_stage}d)" for d in stuck[:3])
        msg = f"B2B alert: {len(stuck)} deal(s) stuck > {settings.b2b_stuck_deal_days} days: {names}"
        try:
            alert_b2b_anomaly(msg)
        except Exception as e:
            logger.error("Slack alert failed: %s", e)
        alerts.append({"type": "b2b_stuck_deals", "message": msg})

    # Significant pipeline drop (week-over-week)
    week_ago = today - timedelta(days=7)
    from app.models.b2b import B2BWeeklySnapshot
    snap_now  = db.query(B2BWeeklySnapshot).order_by(B2BWeeklySnapshot.snapshot_date.desc()).first()
    snap_prev = db.query(B2BWeeklySnapshot).filter(
        B2BWeeklySnapshot.snapshot_date <= week_ago,
    ).order_by(B2BWeeklySnapshot.snapshot_date.desc()).first()
    if snap_now and snap_prev and snap_prev.total_pipeline_value and snap_prev.total_pipeline_value > 0:
        drop_pct = (snap_prev.total_pipeline_value - snap_now.total_pipeline_value) / snap_prev.total_pipeline_value
        if drop_pct >= 0.20:
            msg = f"B2B alert: Pipeline dropped {drop_pct*100:.0f}% week-over-week (${snap_prev.total_pipeline_value:,.0f} → ${snap_now.total_pipeline_value:,.0f})"
            try:
                alert_b2b_anomaly(msg)
            except Exception as e:
                logger.error("Slack alert failed: %s", e)
            alerts.append({"type": "b2b_pipeline_drop", "message": msg})

    return alerts


def _check_financial(db) -> list:
    from app.config import settings
    from app.models.financial import CashPosition
    from app.models.financial import FinancialRecord
    from sqlalchemy import func
    from app.services.slack_service import alert_financial_anomaly

    today = date.today()
    alerts = []

    latest_cash = db.query(CashPosition).order_by(CashPosition.date.desc()).first()
    if not latest_cash:
        return alerts

    cash = float(latest_cash.balance)
    three_months_ago = today - timedelta(days=90)
    total_expenses = float(db.query(func.coalesce(func.sum(FinancialRecord.amount), 0)).filter(
        FinancialRecord.category.like("expense_%"),
        FinancialRecord.date >= three_months_ago,
    ).scalar() or 0)
    monthly_burn = total_expenses / 3.0

    if monthly_burn > 0:
        runway = cash / monthly_burn
        if runway < settings.cash_runway_critical_months:
            msg = f"Financial alert: CRITICAL runway {runway:.1f} months (< {settings.cash_runway_critical_months} threshold)"
            try:
                alert_financial_anomaly(msg)
            except Exception as e:
                logger.error("Slack alert failed: %s", e)
            alerts.append({"type": "cash_critical", "message": msg})
        elif runway < settings.cash_runway_warn_months:
            msg = f"Financial alert: Runway below warning threshold — {runway:.1f} months"
            try:
                alert_financial_anomaly(msg)
            except Exception as e:
                logger.error("Slack alert failed: %s", e)
            alerts.append({"type": "cash_warn", "message": msg})

    return alerts
