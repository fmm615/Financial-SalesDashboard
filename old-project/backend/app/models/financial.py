from __future__ import annotations
import uuid
from datetime import datetime, date
from sqlalchemy import Boolean, Column, Date, DateTime, Float, Integer, String, Text
from app.database import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.utcnow()


REVENUE_CATEGORIES = ("revenue_b2c", "revenue_b2b", "revenue_other")
EXPENSE_CATEGORIES = (
    "expense_operating", "expense_summit", "expense_marketing",
    "expense_personnel", "expense_other",
)
ALL_CATEGORIES = REVENUE_CATEGORIES + EXPENSE_CATEGORIES


class FinancialRecord(Base):
    """
    Income and expense records — pulled from Zoho Books (Phase 2)
    or entered manually in Phase 1.

    category ∈ {revenue_b2c, revenue_b2b, revenue_other,
                 expense_operating, expense_summit, expense_marketing,
                 expense_personnel, expense_other}
    """
    __tablename__ = "financial_records"

    id = Column(String, primary_key=True, default=_uuid)
    date = Column(Date, nullable=False, index=True)
    category = Column(String, nullable=False, index=True)
    subcategory = Column(String, nullable=True)
    account_name = Column(String, nullable=True)
    amount = Column(Float, nullable=False)          # positive for revenue, positive for expense
    currency = Column(String, nullable=False, default="USD")
    description = Column(Text, nullable=True)
    source = Column(String, nullable=False, default="manual")  # zoho | manual
    zoho_transaction_id = Column(String, nullable=True, unique=True)
    created_at = Column(DateTime, default=_now)


class SummitTracker(Base):
    """Weekly snapshot of summit KPIs. Updated manually via Slack or dashboard form."""
    __tablename__ = "summit_tracker"

    id = Column(String, primary_key=True, default=_uuid)
    snapshot_date = Column(Date, nullable=False, unique=True, index=True)
    ticket_registrations = Column(Integer, nullable=True)
    ticket_target = Column(Integer, nullable=True)
    judges_confirmed = Column(Integer, nullable=True)
    judges_target = Column(Integer, nullable=True)
    mou_signed = Column(Integer, nullable=True)
    mou_target = Column(Integer, nullable=True)
    booths_sold = Column(Integer, nullable=True)
    moderators_confirmed = Column(Integer, nullable=True)
    pitching_confirmed = Column(Integer, nullable=True)
    b2b_partners_confirmed = Column(Integer, nullable=True)
    gap_to_breakeven = Column(Float, nullable=True)
    total_summit_costs = Column(Float, nullable=True)
    revenue_raised_to_date = Column(Float, nullable=True)
    notes = Column(Text, nullable=True)
    updated_by = Column(String, nullable=True)
    created_at = Column(DateTime, default=_now)


class DailySnapshot(Base):
    """End-of-day snapshot captured by scheduler at 23:45 BHT."""
    __tablename__ = "daily_snapshots"

    date = Column(Date, primary_key=True)
    new_members_count = Column(Integer, nullable=True)
    b2c_revenue_gross = Column(Float, nullable=True)
    b2c_revenue_net = Column(Float, nullable=True)
    b2b_bookings_count = Column(Integer, nullable=True)
    b2b_bookings_value = Column(Float, nullable=True)
    b2b_revenue_recognized = Column(Float, nullable=True)
    summit_tickets_sold = Column(Integer, nullable=True)
    total_active_members = Column(Integer, nullable=True)
    mrr_estimate = Column(Float, nullable=True)
    acquisition_breakdown = Column(Text, nullable=True)  # JSON
    cash_position = Column(Float, nullable=True)
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime, default=_now)


class CashPosition(Base):
    """Monthly cash position records — from Zoho Books or manual entry."""
    __tablename__ = "cash_positions"

    id = Column(String, primary_key=True, default=_uuid)
    date = Column(Date, nullable=False, index=True)
    balance = Column(Float, nullable=False)
    source = Column(String, nullable=False, default="manual")  # zoho | manual
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime, default=_now)
