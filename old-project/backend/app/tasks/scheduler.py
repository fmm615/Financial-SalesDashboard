from __future__ import annotations
"""
APScheduler jobs. Registered in app lifespan via start_scheduler().
All times in Asia/Bahrain (UTC+3).
"""
import logging
from datetime import date, timedelta
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
import pytz

logger = logging.getLogger(__name__)
BHT = pytz.timezone("Asia/Bahrain")


# ─── Job functions ────────────────────────────────────────────────────────────

def job_daily_b2c_summary():
    from datetime import datetime
    from sqlalchemy import func
    from app.database import SessionLocal
    from app.config import settings
    from app.models.members import Member, Transaction
    from app.models.b2b import B2BDeal
    from app.models.financial import CashPosition, FinancialRecord
    from app.services.slack_service import post_daily_summary
    db = SessionLocal()
    try:
        today = date.today()
        month_start = today.replace(day=1)
        day_start = datetime.combine(today, datetime.min.time())

        new_members = db.query(func.count(Member.id)).filter(
            Member.first_purchase_date >= day_start
        ).scalar() or 0
        mtd_members = db.query(func.count(Member.id)).filter(
            Member.first_purchase_date >= datetime.combine(month_start, datetime.min.time())
        ).scalar() or 0
        b2c_gross = float(db.query(func.coalesce(func.sum(Transaction.amount_gross), 0)).filter(
            Transaction.date >= day_start, Transaction.is_refund.is_(False)
        ).scalar() or 0)
        b2b_val = float(db.query(func.coalesce(func.sum(B2BDeal.amount), 0)).filter(
            B2BDeal.status == "won", B2BDeal.close_date_actual >= today
        ).scalar() or 0)

        latest_cash = db.query(CashPosition).order_by(CashPosition.date.desc()).first()
        cash = float(latest_cash.balance) if latest_cash else None
        expenses_3m = float(db.query(func.coalesce(func.sum(FinancialRecord.amount), 0)).filter(
            FinancialRecord.category.like("expense_%"),
            FinancialRecord.date >= today - timedelta(days=90),
        ).scalar() or 0)
        burn = expenses_3m / 3.0 if expenses_3m > 0 else None
        runway = (cash / burn) if (cash is not None and burn and burn > 0) else None

        try:
            summit_dt = date.fromisoformat(settings.summit_date)
            days_to_summit = (summit_dt - today).days
        except ValueError:
            days_to_summit = None

        post_daily_summary({
            "date": today.isoformat(),
            "new_members_count": new_members,
            "mtd_members": mtd_members,
            "b2c_revenue_gross": b2c_gross,
            "b2b_bookings_value": b2b_val,
            "cash_position": cash,
            "runway_months": runway,
            "days_to_summit": days_to_summit,
        })
    except Exception as e:
        logger.error("daily_b2c_summary failed: %s", e)
    finally:
        db.close()


def job_weekly_digest():
    from datetime import datetime
    from sqlalchemy import func
    from app.database import SessionLocal
    from app.config import settings
    from app.models.members import Member, Transaction
    from app.models.b2b import B2BDeal
    from app.services.slack_service import post_weekly_digest
    db = SessionLocal()
    try:
        today = date.today()
        week_start = today - timedelta(days=today.weekday())  # Monday
        ws = datetime.combine(week_start, datetime.min.time())
        ago_90 = today - timedelta(days=90)

        new_members_wtd = db.query(func.count(Member.id)).filter(
            Member.first_purchase_date >= ws
        ).scalar() or 0
        b2c_rev_wtd = float(db.query(func.coalesce(func.sum(Transaction.amount_gross), 0)).filter(
            Transaction.date >= ws, Transaction.is_refund.is_(False)
        ).scalar() or 0)
        pipeline = float(db.query(func.coalesce(func.sum(B2BDeal.amount), 0)).filter(
            B2BDeal.status == "open"
        ).scalar() or 0)
        bookings_wtd = float(db.query(func.coalesce(func.sum(B2BDeal.amount), 0)).filter(
            B2BDeal.status == "won", B2BDeal.close_date_actual >= week_start
        ).scalar() or 0)
        won_90 = db.query(func.count(B2BDeal.id)).filter(B2BDeal.status == "won", B2BDeal.close_date_actual >= ago_90).scalar() or 0
        lost_90 = db.query(func.count(B2BDeal.id)).filter(B2BDeal.status == "lost", B2BDeal.close_date_actual >= ago_90).scalar() or 0
        win_rate = (won_90 / (won_90 + lost_90) * 100) if (won_90 + lost_90) > 0 else 0
        active_monthly = db.query(func.count(Member.id)).filter(
            Member.tier == "core_monthly", Member.status == "active"
        ).scalar() or 0
        mrr = active_monthly * (50.42 / (1 + settings.b2c_vat_rate))

        post_weekly_digest({
            "week": f"w/c {week_start.isoformat()}",
            "new_members_wtd": new_members_wtd,
            "b2c_revenue_wtd": b2c_rev_wtd,
            "pipeline_value": pipeline,
            "bookings_wtd": bookings_wtd,
            "win_rate": win_rate,
            "mrr": mrr,
        })
    except Exception as e:
        logger.error("weekly_digest failed: %s", e)
    finally:
        db.close()


def job_b2b_weekly_snapshot():
    from app.database import SessionLocal
    from sqlalchemy import func
    from app.models.b2b import B2BDeal, B2BWeeklySnapshot
    db = SessionLocal()
    try:
        total_value = float(db.query(func.coalesce(func.sum(B2BDeal.amount), 0)).filter(B2BDeal.status == "open").scalar() or 0)
        deal_count  = db.query(func.count(B2BDeal.id)).filter(B2BDeal.status == "open").scalar() or 0
        snap = B2BWeeklySnapshot(
            snapshot_date=date.today(),
            total_pipeline_value=total_value,
            open_deal_count=deal_count,
        )
        db.add(snap)
        db.commit()
    except Exception as e:
        logger.error("b2b_weekly_snapshot failed: %s", e)
    finally:
        db.close()


def job_reconciliation():
    from app.tasks.reconciliation import run_reconciliation
    run_reconciliation()


def job_daily_alerts():
    from app.tasks.alerts import run_alerts
    run_alerts()


def job_hubspot_daily_sync():
    from app.database import SessionLocal
    from app.services.hubspot_service import full_sync
    db = SessionLocal()
    try:
        full_sync(db, days_back=2)
    except Exception as e:
        logger.error("hubspot_daily_sync failed: %s", e)
    finally:
        db.close()


def job_zoho_daily_sync():
    from app.config import settings
    if not settings.zoho_sync_enabled:
        return
    from app.database import SessionLocal
    from app.services.zoho_service import sync_financial_data
    db = SessionLocal()
    try:
        sync_financial_data(db)
    except Exception as e:
        logger.error("zoho_daily_sync failed: %s", e)
    finally:
        db.close()


def _trigger_report(report_type: str, period_start: date, period_end: date, label: str):
    from app.config import settings
    if not settings.report_autodelivery_enabled:
        logger.info("Auto-delivery disabled — skipping %s report", report_type)
        return
    from app.database import SessionLocal
    from app.routers.reports import _create_and_launch
    db = SessionLocal()
    try:
        _create_and_launch(db, report_type, label, period_start, period_end, send_email=True, generated_by="scheduler")
    except Exception as e:
        logger.error("trigger_report(%s) failed: %s", report_type, e)
    finally:
        db.close()


def job_monthly_report():
    today = date.today()
    prev_month_end = today.replace(day=1) - timedelta(days=1)
    prev_month_start = prev_month_end.replace(day=1)
    label = prev_month_start.strftime("%B %Y")
    _trigger_report("monthly", prev_month_start, prev_month_end, label)


def job_quarterly_report():
    today = date.today()
    # First day of current month is first day of new quarter → report on previous quarter
    q_end = today.replace(day=1) - timedelta(days=1)
    q_num = (q_end.month - 1) // 3 + 1
    q_start_month = (q_num - 1) * 3 + 1
    q_start = q_end.replace(month=q_start_month, day=1)
    label = f"Q{q_num} {q_end.year}"
    _trigger_report("quarterly", q_start, q_end, label)


def job_annual_report():
    today = date.today()
    prev_year = today.year - 1
    year_start = date(prev_year, 1, 1)
    year_end   = date(prev_year, 12, 31)
    label = f"FY {prev_year}"
    _trigger_report("yearly", year_start, year_end, label)


def job_daily_snapshot():
    """Persist a DailySnapshot row (end-of-day B2C metrics) for trend charts."""
    from app.database import SessionLocal
    from sqlalchemy import func
    from app.models.members import Member, Transaction
    from app.models.financial import DailySnapshot
    from datetime import datetime
    db = SessionLocal()
    try:
        today = date.today()
        month_start = today.replace(day=1)

        new_today = db.query(func.count(Member.id)).filter(
            Member.first_purchase_date >= datetime.combine(today, datetime.min.time()),
        ).scalar() or 0
        active_members = db.query(func.count(Member.id)).filter(Member.status == "active").scalar() or 0
        revenue_net_today = float(db.query(func.coalesce(func.sum(Transaction.amount_net), 0)).filter(
            Transaction.date >= datetime.combine(today, datetime.min.time()),
            Transaction.is_refund.is_(False),
        ).scalar() or 0)

        snap = DailySnapshot(date=today)
        snap.new_members_count = new_today
        snap.total_active_members = active_members
        snap.b2c_revenue_net = revenue_net_today
        db.merge(snap)
        db.commit()
    except Exception as e:
        logger.error("daily_snapshot failed: %s", e)
    finally:
        db.close()


# ─── Scheduler lifecycle ─────────────────────────────────────────────────────

_scheduler: BackgroundScheduler | None = None


def start_scheduler():
    global _scheduler
    if _scheduler and _scheduler.running:
        return
    _scheduler = BackgroundScheduler(timezone=BHT)

    _scheduler.add_job(job_daily_b2c_summary,   CronTrigger(hour=8,  minute=0,  timezone=BHT), id="daily_b2c_summary",   replace_existing=True, misfire_grace_time=300)
    _scheduler.add_job(job_weekly_digest,        CronTrigger(day_of_week="mon", hour=8, minute=30, timezone=BHT), id="weekly_digest", replace_existing=True, misfire_grace_time=300)
    _scheduler.add_job(job_b2b_weekly_snapshot,  CronTrigger(day_of_week="mon", hour=1, minute=0,  timezone=BHT), id="b2b_weekly_snapshot", replace_existing=True, misfire_grace_time=300)
    _scheduler.add_job(job_reconciliation,       CronTrigger(hour="2,14", minute=0, timezone=BHT), id="reconciliation", replace_existing=True, misfire_grace_time=300)
    _scheduler.add_job(job_daily_alerts,         CronTrigger(hour=9, minute=0, timezone=BHT), id="daily_alerts", replace_existing=True, misfire_grace_time=300)
    _scheduler.add_job(job_hubspot_daily_sync,   CronTrigger(hour=3, minute=0, timezone=BHT), id="hubspot_daily_sync", replace_existing=True, misfire_grace_time=300)
    _scheduler.add_job(job_zoho_daily_sync,      CronTrigger(hour=3, minute=30, timezone=BHT), id="zoho_daily_sync", replace_existing=True, misfire_grace_time=300)
    _scheduler.add_job(job_daily_snapshot,       CronTrigger(hour=23, minute=55, timezone=BHT), id="daily_snapshot", replace_existing=True, misfire_grace_time=300)

    # Reports (fire on day=1 of month = previous period complete)
    _scheduler.add_job(job_monthly_report,   CronTrigger(day=1, hour=6, minute=0,  timezone=BHT), id="monthly_report",   replace_existing=True, misfire_grace_time=600)
    _scheduler.add_job(job_quarterly_report, CronTrigger(month="1,4,7,10", day=1, hour=6, minute=15, timezone=BHT), id="quarterly_report", replace_existing=True, misfire_grace_time=600)
    _scheduler.add_job(job_annual_report,    CronTrigger(month=1, day=1, hour=6, minute=30, timezone=BHT), id="annual_report", replace_existing=True, misfire_grace_time=600)

    _scheduler.start()
    logger.info("Scheduler started with %d jobs", len(_scheduler.get_jobs()))


def stop_scheduler():
    global _scheduler
    if _scheduler and _scheduler.running:
        _scheduler.shutdown(wait=False)
        logger.info("Scheduler stopped")
