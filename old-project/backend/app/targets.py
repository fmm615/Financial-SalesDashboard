from __future__ import annotations
"""Effective targets: values saved via the admin UI (Target table) override the
env-var defaults in settings. Previously the dashboard read settings only, which
made PUT /api/admin/targets a no-op."""
from sqlalchemy.orm import Session

from app.config import settings
from app.models.config_models import Target


def effective_targets(db: Session) -> dict:
    overrides = {f"{t.period}:{t.metric}": t.target_value for t in db.query(Target).all()}
    return {
        "fy_revenue": overrides.get("2026:revenue_total", settings.target_fy_revenue),
        "fy_b2b": overrides.get("2026:revenue_b2b", settings.target_fy_b2b),
        "fy_b2c": overrides.get("2026:revenue_b2c", settings.target_fy_b2c),
        "fy_other": overrides.get("2026:revenue_other", settings.target_fy_other),
        "q1": overrides.get("2026-Q1:revenue_total", settings.target_q1_revenue),
        "q2": overrides.get("2026-Q2:revenue_total", settings.target_q2_revenue),
        "q3": overrides.get("2026-Q3:revenue_total", settings.target_q3_revenue),
        "q4": overrides.get("2026-Q4:revenue_total", settings.target_q4_revenue),
        "b2c_daily_members": overrides.get("2026:members_daily", settings.b2c_member_daily_target),
    }


def quarterly_target(db: Session, quarter: int) -> float:
    return effective_targets(db)[f"q{quarter}"]
