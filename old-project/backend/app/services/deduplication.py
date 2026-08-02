from __future__ import annotations
"""
Deduplication logic for B2C transactions.

Two-layer approach:
  1. Processor transaction ID uniqueness (exact duplicate)
  2. SHA-256 content fingerprint (email + amount_cents + category + day_bucket)
     within a 48-hour window (catches cross-processor duplicates)
"""
import hashlib
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy.orm import Session
from app.models.members import Transaction


def gross_to_net(gross: float) -> float:
    from app.config import settings
    return round(gross / (1 + settings.b2c_vat_rate), 2)


def build_fingerprint(email: str, amount_gross: float, category: str, ts: datetime) -> str:
    amount_cents = round(amount_gross * 100)
    bucket = ts.date().isoformat()
    raw = f"{email.lower().strip()}|{amount_cents}|{category}|{bucket}"
    return hashlib.sha256(raw.encode()).hexdigest()


def is_duplicate(
    db: Session,
    *,
    processor_transaction_id: Optional[str] = None,
    fingerprint: Optional[str] = None,
    transaction_at: Optional[datetime] = None,
) -> tuple[bool, str]:
    """
    Returns (is_dup, reason).
    Check provider ID first; then fingerprint within 48h.
    """
    if processor_transaction_id:
        exists = db.query(Transaction).filter(
            Transaction.processor_transaction_id == processor_transaction_id
        ).first()
        if exists:
            return True, f"provider_id:{processor_transaction_id}"

    if fingerprint and transaction_at:
        window_start = transaction_at - timedelta(hours=48)
        exists = db.query(Transaction).filter(
            Transaction.dedup_fingerprint == fingerprint,
            Transaction.date >= window_start,
        ).first()
        if exists:
            return True, f"fingerprint:{fingerprint[:16]}"

    return False, ""


def is_existing_member(db: Session, email: str) -> bool:
    from app.models.members import Member
    return db.query(Member).filter(Member.email == email.lower().strip()).first() is not None


# ── Product catalogue ────────────────────────────────────────────────────────
# Canonical gross USD prices (VAT-inclusive at 10%)
PRODUCTS = {
    # category → (display_name, grants_core_access, gross_usd)
    "core_monthly":  ("Core Monthly",          True,  50.42),
    "core_annual":   ("Core Annual",            True,  605.00),
    "founding":      ("Founding Membership",    True,  1500.00),
    "summit_ticket": ("Summit Ticket",          True,  273.90),
    "summit_gala":   ("Summit + Gala",          True,  499.00),
    "judge":         ("Judge Slot",             True,  350.00),
    "moderator":     ("Moderator Slot",         True,  350.00),
}

# Stripe price ID → internal category (seed; operator updates via admin UI)
STRIPE_PRICE_MAP: dict[str, str] = {
    # populated from env / product_mapping table at runtime
}

# Tap product name → internal category
TAP_PRODUCT_MAP: dict[str, str] = {
    # populated from env / product_mapping table at runtime
}


def resolve_category(
    db: Session,
    processor: str,
    processor_product_id: str,
) -> tuple[str, bool]:
    """
    Returns (internal_category, grants_core_access).
    Falls back to 'unknown' if not found in product_mapping table.
    """
    from app.models.config_models import ProductMapping
    mapping = db.query(ProductMapping).filter(
        ProductMapping.processor == processor,
        ProductMapping.processor_product_id == processor_product_id,
        ProductMapping.active.is_(True),
    ).first()
    if mapping:
        return mapping.internal_category, mapping.grants_core_access
    return "unknown", False


def resolve_category_any(
    db: Session,
    processor: str,
    candidate_ids: list,
) -> tuple[str, bool]:
    """
    Try each candidate ID in order (e.g. Stripe price_... then its parent
    prod_...) and return the first mapping hit. Mappings may be keyed by
    either, so both are checked.
    """
    for cid in candidate_ids:
        if not cid:
            continue
        category, grants = resolve_category(db, processor, cid)
        if category != "unknown":
            return category, grants
    return "unknown", False
