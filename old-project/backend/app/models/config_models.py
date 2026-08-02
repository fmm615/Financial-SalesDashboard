from __future__ import annotations
import uuid
from datetime import datetime
from sqlalchemy import Boolean, Column, DateTime, Float, String, Text
from app.database import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.utcnow()


class Target(Base):
    """
    Configurable targets stored in DB (override .env defaults via admin UI).
    period examples: "2026", "2026-Q2", "2026-05"
    metric examples: "revenue_total", "revenue_b2c", "revenue_b2b", "members_daily"
    """
    __tablename__ = "targets"

    id = Column(String, primary_key=True, default=_uuid)
    period = Column(String, nullable=False, index=True)
    metric = Column(String, nullable=False, index=True)
    target_value = Column(Float, nullable=False)
    notes = Column(Text, nullable=True)
    updated_by = Column(String, nullable=True)
    updated_at = Column(DateTime, default=_now, onupdate=_now)


class ProductMapping(Base):
    """
    Maps processor-specific product/price IDs to internal categories.
    Determines whether a purchase grants Core access (= new member).
    """
    __tablename__ = "product_mapping"

    id = Column(String, primary_key=True, default=_uuid)
    processor = Column(String, nullable=False)              # stripe | tap | iban
    processor_product_id = Column(String, nullable=False)   # price_xxx or product name
    internal_category = Column(String, nullable=False)      # core_monthly | core_annual | founding | etc.
    display_name = Column(String, nullable=True)
    amount_gross = Column(Float, nullable=True)             # canonical gross price USD
    grants_core_access = Column(Boolean, nullable=False, default=True)
    active = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, default=_now)


class AuditLog(Base):
    """Every manual action — IBAN entry, summit updates, config changes."""
    __tablename__ = "audit_log"

    id = Column(String, primary_key=True, default=_uuid)
    timestamp = Column(DateTime, default=_now, nullable=False, index=True)
    user = Column(String, nullable=True)
    action = Column(String, nullable=False)
    details = Column(Text, nullable=True)  # JSON
    ip_address = Column(String, nullable=True)
