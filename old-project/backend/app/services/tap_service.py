from __future__ import annotations
"""
Tap Payments webhook processor.
Same conversion rules as Stripe — only the payload shape differs.
"""
import hashlib
import hmac
import logging
from datetime import datetime

from sqlalchemy.orm import Session

from app.config import settings
from app.models.members import Member, Transaction
from app.services.deduplication import (
    build_fingerprint, gross_to_net, is_duplicate, is_existing_member, resolve_category
)

logger = logging.getLogger(__name__)


def verify_signature(payload: bytes, sig_header: str) -> bool:
    """Tap sends HMAC-SHA256 in x-tap-signature header."""
    if not settings.tap_webhook_secret:
        if settings.debug:
            return True  # explicit dev mode only
        logger.error("TAP_WEBHOOK_SECRET not set — rejecting webhook (fail closed)")
        return False
    expected = hmac.new(
        settings.tap_webhook_secret.encode(), payload, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, sig_header or "")


def process_event(db: Session, event: dict) -> dict:
    status = event.get("status", "")
    if status not in ("CAPTURED", "AUTHORIZED"):
        return {"status": "ignored", "tap_status": status}

    charge = event.get("object") or event
    charge_id = charge.get("id", "")
    email = (
        charge.get("customer", {}).get("email")
        or charge.get("receipt", {}).get("email")
        or ""
    ).lower().strip()

    if not email:
        return {"status": "skipped", "reason": "no_email"}

    amount_gross = float(charge.get("amount", 0))
    currency = (charge.get("currency") or "USD").upper()
    ts = datetime.utcfromtimestamp(charge.get("created") / 1000
                                   if charge.get("created", 0) > 1e10
                                   else charge.get("created", 0))

    product_id = (
        charge.get("reference", {}).get("payment")
        or charge.get("description", "")
        or "unknown"
    )
    category, grants_core = resolve_category(db, "tap", product_id)

    fingerprint = build_fingerprint(email, amount_gross, category, ts)
    is_dup, reason = is_duplicate(db, processor_transaction_id=charge_id, fingerprint=fingerprint, transaction_at=ts)
    if is_dup:
        return {"status": "duplicate", "reason": reason}

    already_member = is_existing_member(db, email)
    is_first = not already_member and grants_core

    txn = Transaction(
        email=email,
        date=ts,
        processor="tap",
        processor_transaction_id=charge_id,
        product_id=product_id,
        category=category,
        amount_gross=amount_gross,
        amount_net=gross_to_net(amount_gross),
        vat_amount=round(amount_gross - gross_to_net(amount_gross), 2),
        currency=currency,
        is_first_purchase=is_first,
        is_renewal=already_member and grants_core,
        dedup_fingerprint=fingerprint,
    )
    db.add(txn)

    if is_first:
        member = Member(
            email=email,
            first_purchase_date=ts,
            first_purchase_source=category,
            first_purchase_processor="tap",
            tier=category,
            status="active",
        )
        db.add(member)
        db.flush()  # populate member.id before linking
        txn.member_id = member.id

    db.commit()
    db.refresh(txn)
    logger.info("Tap charge processed: %s %s %.2f %s first=%s", email, category, amount_gross, currency, is_first)
    return {"status": "ok", "transaction_id": txn.id, "is_new_member": is_first}
