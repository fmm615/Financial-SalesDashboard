from __future__ import annotations
import uuid
from datetime import datetime
from sqlalchemy import (
    Boolean, Column, DateTime, Float, ForeignKey,
    Integer, String, Text, UniqueConstraint,
)
from app.database import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.utcnow()


class Member(Base):
    """
    Unique B2C member — deduplicated by email.
    Created only on first-ever purchase.
    """
    __tablename__ = "members"

    id = Column(String, primary_key=True, default=_uuid)
    email = Column(String, nullable=False, unique=True, index=True)
    first_purchase_date = Column(DateTime, nullable=False)
    first_purchase_source = Column(String, nullable=True)   # direct_core_monthly | direct_core_annual | direct_fm | summit_ticket | summit_gala | judge | moderator
    first_purchase_processor = Column(String, nullable=True)  # stripe | tap | iban
    tier = Column(String, nullable=True)                    # core_monthly | core_annual | founding
    country = Column(String, nullable=True)
    status = Column(String, nullable=False, default="active")  # active | churned | refunded
    created_at = Column(DateTime, default=_now)
    updated_at = Column(DateTime, default=_now, onupdate=_now)


class Transaction(Base):
    """
    Every payment event — including renewals and refunds.
    Not all transactions create a Member (e.g. renewals, existing member summit).
    """
    __tablename__ = "transactions"

    id = Column(String, primary_key=True, default=_uuid)
    member_id = Column(String, ForeignKey("members.id"), nullable=True, index=True)
    email = Column(String, nullable=False, index=True)
    date = Column(DateTime, nullable=False, index=True)
    processor = Column(String, nullable=False)               # stripe | tap | iban
    processor_transaction_id = Column(String, nullable=True, unique=True, index=True)
    product_id = Column(String, nullable=True)
    product_name = Column(String, nullable=True)
    category = Column(String, nullable=True)                 # core_monthly | core_annual | founding | summit_ticket | summit_gala | judge | moderator
    amount_gross = Column(Float, nullable=False)             # charged amount (VAT-inclusive)
    amount_net = Column(Float, nullable=False)               # gross / 1.10
    vat_amount = Column(Float, nullable=False, default=0)
    currency = Column(String, nullable=False, default="USD")
    is_first_purchase = Column(Boolean, nullable=False, default=False)
    is_renewal = Column(Boolean, nullable=False, default=False)
    is_refund = Column(Boolean, nullable=False, default=False)
    source = Column(String, nullable=True)                   # acquisition source
    dedup_fingerprint = Column(String, nullable=True, index=True)
    created_at = Column(DateTime, default=_now)


class IBANEntry(Base):
    """Manual IBAN payment entries submitted via the dashboard form."""
    __tablename__ = "iban_entries"

    id = Column(String, primary_key=True, default=_uuid)
    email = Column(String, nullable=False, index=True)
    amount_gross = Column(Float, nullable=False)
    amount_net = Column(Float, nullable=False)
    currency = Column(String, nullable=False, default="USD")
    transfer_date = Column(DateTime, nullable=False)
    product_name = Column(String, nullable=True)
    category = Column(String, nullable=True)
    notes = Column(Text, nullable=True)
    entered_by = Column(String, nullable=True)
    transaction_id = Column(String, ForeignKey("transactions.id"), nullable=True)
    created_at = Column(DateTime, default=_now)
