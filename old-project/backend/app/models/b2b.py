from __future__ import annotations
import uuid
from datetime import datetime
from sqlalchemy import Boolean, Column, DateTime, Date, Float, ForeignKey, Integer, String, Text
from app.database import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.utcnow()


class B2BDeal(Base):
    __tablename__ = "b2b_deals"

    id = Column(String, primary_key=True, default=_uuid)
    hubspot_deal_id = Column(String, nullable=False, unique=True, index=True)
    company_name = Column(String, nullable=True)
    deal_name = Column(String, nullable=True)
    amount = Column(Float, nullable=True)
    currency = Column(String, nullable=False, default="USD")
    stage = Column(String, nullable=True, index=True)
    deal_type = Column(String, nullable=True)
    source = Column(String, nullable=True)
    owner_name = Column(String, nullable=True)
    owner_email = Column(String, nullable=True)
    created_at = Column(DateTime, nullable=True)
    close_date_expected = Column(Date, nullable=True)
    close_date_actual = Column(Date, nullable=True, index=True)
    contract_start_date = Column(Date, nullable=True)
    contract_end_date = Column(Date, nullable=True)
    status = Column(String, nullable=False, default="open", index=True)  # open | won | lost
    last_activity_date = Column(DateTime, nullable=True)
    stage_entered_at = Column(DateTime, nullable=True)
    days_in_current_stage = Column(Integer, nullable=True)
    synced_at = Column(DateTime, default=_now, onupdate=_now)


class B2BDealHistory(Base):
    __tablename__ = "b2b_deal_history"

    id = Column(String, primary_key=True, default=_uuid)
    deal_id = Column(String, ForeignKey("b2b_deals.id"), nullable=False, index=True)
    timestamp = Column(DateTime, default=_now, nullable=False)
    field_changed = Column(String, nullable=False)
    old_value = Column(Text, nullable=True)
    new_value = Column(Text, nullable=True)


class B2BWeeklySnapshot(Base):
    __tablename__ = "b2b_weekly_snapshots"

    id = Column(String, primary_key=True, default=_uuid)
    snapshot_date = Column(Date, nullable=False, unique=True)
    total_pipeline_value = Column(Float, nullable=True)
    open_deal_count = Column(Integer, nullable=True)
    bookings_wtd = Column(Float, nullable=True)
    bookings_qtd = Column(Float, nullable=True)
    win_rate_90d = Column(Float, nullable=True)
    created_at = Column(DateTime, default=_now)
