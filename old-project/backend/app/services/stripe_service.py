from __future__ import annotations
"""
Stripe webhook processor.

Handles:
  - checkout.session.completed
  - customer.subscription.created
  - payment_intent.succeeded
  - invoice.payment_succeeded  (flags renewals)
  - charge.refunded
"""
import hashlib
import hmac
import logging
from datetime import datetime
from typing import Optional

import stripe
from sqlalchemy.orm import Session

from app.config import settings
from app.models.members import Member, Transaction
from app.services.deduplication import (
    build_fingerprint, gross_to_net, is_duplicate, is_existing_member,
    resolve_category, resolve_category_any,
)

logger = logging.getLogger(__name__)

stripe.api_key = settings.stripe_api_key



def verify_signature(payload: bytes, sig_header: str) -> bool:
    try:
        stripe.WebhookSignature.verify_header(
            payload.decode("utf-8"), sig_header, settings.stripe_webhook_secret
        )
        return True
    except stripe.error.SignatureVerificationError:
        return False


def process_event(db: Session, event: dict) -> dict:
    event_type = event.get("type", "")
    obj = event.get("data", {}).get("object", {})

    handlers = {
        "checkout.session.completed":    _handle_checkout,
        "invoice.payment_succeeded":     _handle_invoice,
        "payment_intent.succeeded":      _handle_payment_intent,
        "charge.refunded":               _handle_refund,
    }

    handler = handlers.get(event_type)
    if handler:
        return handler(db, obj)
    return {"status": "ignored", "event_type": event_type}


# ── Handlers ──────────────────────────────────────────────────────────────────

def _handle_checkout(db: Session, session: dict) -> dict:
    email = (session.get("customer_email") or "").lower().strip()
    amount_total = session.get("amount_total", 0)           # in cents
    currency = (session.get("currency") or "usd").upper()
    session_id = session.get("id", "")
    metadata = session.get("metadata") or {}
    line_items = session.get("line_items", {})              # may need expansion via API

    if not email:
        return {"status": "skipped", "reason": "no_email"}

    from app.currency import to_usd
    amount_gross, currency = to_usd(amount_total / 100.0, currency)
    ts = datetime.utcfromtimestamp(session.get("created", 0))

    # Resolve product from metadata or line item
    price_id, product_id = _extract_price_and_product(session)
    price_id = metadata.get("price_id") or price_id
    category, grants_core = resolve_category_any(db, "stripe", [price_id, product_id])

    fingerprint = build_fingerprint(email, amount_gross, category, ts)
    is_dup, reason = is_duplicate(db, processor_transaction_id=session_id, fingerprint=fingerprint, transaction_at=ts)
    if is_dup:
        logger.info("Stripe checkout duplicate: %s", reason)
        return {"status": "duplicate", "reason": reason}

    is_renewal = bool(session.get("mode") == "subscription" and _is_renewal(db, email))
    is_first = not is_existing_member(db, email) and grants_core and not is_renewal

    txn = Transaction(
        email=email,
        date=ts,
        processor="stripe",
        processor_transaction_id=session_id,
        product_id=price_id,
        product_name=metadata.get("product_name"),
        category=category,
        amount_gross=amount_gross,
        amount_net=gross_to_net(amount_gross),
        vat_amount=round(amount_gross - gross_to_net(amount_gross), 2),
        currency=currency,
        is_first_purchase=is_first,
        is_renewal=is_renewal,
        source=metadata.get("source"),
        dedup_fingerprint=fingerprint,
    )
    db.add(txn)

    if is_first:
        member = Member(
            email=email,
            first_purchase_date=ts,
            first_purchase_source=category,
            first_purchase_processor="stripe",
            tier=_tier_from_category(category),
            status="active",
        )
        db.add(member)
        db.flush()  # populate member.id before linking
        txn.member_id = member.id

    db.commit()
    db.refresh(txn)
    logger.info("Stripe checkout processed: %s %s %.2f %s first=%s", email, category, amount_gross, currency, is_first)
    return {"status": "ok", "transaction_id": txn.id, "is_new_member": is_first}


def _handle_invoice(db: Session, invoice: dict) -> dict:
    if invoice.get("billing_reason") not in ("subscription_cycle", "subscription_update"):
        return {"status": "ignored", "reason": "not_renewal_invoice"}
    customer_email = (invoice.get("customer_email") or "").lower().strip()
    if not customer_email:
        return {"status": "skipped", "reason": "no_email"}

    invoice_id = invoice.get("id", "")
    from app.currency import to_usd
    amount_paid, currency = to_usd(
        invoice.get("amount_paid", 0) / 100.0,
        (invoice.get("currency") or "usd").upper(),
    )
    ts = datetime.utcfromtimestamp(invoice.get("created", 0))
    price_id, product_id = _extract_price_and_product_from_invoice(invoice)
    category, _ = resolve_category_any(db, "stripe", [price_id, product_id])
    fingerprint = build_fingerprint(customer_email, amount_paid, category, ts)
    is_dup, reason = is_duplicate(db, processor_transaction_id=invoice_id, fingerprint=fingerprint, transaction_at=ts)
    if is_dup:
        return {"status": "duplicate", "reason": reason}

    txn = Transaction(
        email=customer_email,
        date=ts,
        processor="stripe",
        processor_transaction_id=invoice_id,
        product_id=price_id,
        category=category,
        amount_gross=amount_paid,
        amount_net=gross_to_net(amount_paid),
        vat_amount=round(amount_paid - gross_to_net(amount_paid), 2),
        currency=currency,
        is_renewal=True,
        is_first_purchase=False,
        dedup_fingerprint=fingerprint,
    )
    db.add(txn)
    db.commit()
    return {"status": "ok", "transaction_id": txn.id, "is_renewal": True}


def _handle_payment_intent(db: Session, pi: dict) -> dict:
    # Payment intents are often covered by checkout.session.completed;
    # only process standalone (no checkout session parent)
    if pi.get("metadata", {}).get("checkout_session_id"):
        return {"status": "ignored", "reason": "covered_by_checkout"}
    return {"status": "ignored", "reason": "standalone_pi_not_processed"}


def _handle_refund(db: Session, charge: dict) -> dict:
    charge_id = charge.get("id", "")

    # Our transactions store checkout-session IDs (cs_...) or invoice IDs (in_...),
    # but charge.refunded events carry a charge ID (ch_...). Resolve the parent:
    candidate_ids = [charge_id]
    if charge.get("invoice"):
        candidate_ids.append(charge["invoice"])
    payment_intent = charge.get("payment_intent")
    if payment_intent and settings.stripe_api_key:
        try:
            sessions = stripe.checkout.Session.list(payment_intent=payment_intent, limit=1)
            if sessions.data:
                candidate_ids.append(sessions.data[0].id)
        except Exception as e:
            logger.warning("Could not resolve checkout session for refund %s: %s", charge_id, e)

    txn = db.query(Transaction).filter(
        Transaction.processor_transaction_id.in_(candidate_ids)
    ).first()
    if not txn:
        logger.warning("Refund %s: no matching transaction (tried %s)", charge_id, candidate_ids)
        return {"status": "not_found", "charge_id": charge_id}

    # Use the actual refunded amount (supports partial refunds), fall back to full txn
    from app.currency import to_usd
    amount_refunded, _cur = to_usd(
        (charge.get("amount_refunded") or 0) / 100.0,
        (charge.get("currency") or "usd").upper(),
    )
    if amount_refunded <= 0:
        amount_refunded = txn.amount_gross
    refund_net = gross_to_net(amount_refunded)

    refund_txn = Transaction(
        email=txn.email,
        date=datetime.utcnow(),
        processor="stripe",
        processor_transaction_id=f"refund_{charge_id}",
        category=txn.category,
        amount_gross=-amount_refunded,
        amount_net=-refund_net,
        vat_amount=-round(amount_refunded - refund_net, 2),
        currency=txn.currency,
        is_refund=True,
        dedup_fingerprint=build_fingerprint(txn.email, amount_refunded, "refund", datetime.utcnow()),
    )
    db.add(refund_txn)

    # Only deactivate membership on a full refund of the first purchase
    if txn.is_first_purchase and amount_refunded >= txn.amount_gross:
        member = db.query(Member).filter(Member.email == txn.email).first()
        if member:
            member.status = "refunded"

    db.commit()
    return {"status": "ok", "refund_recorded": True, "amount": amount_refunded}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _extract_price_and_product(session: dict) -> tuple[Optional[str], Optional[str]]:
    lines = session.get("line_items", {})
    if isinstance(lines, dict):
        data = lines.get("data", [])
        if data:
            price = data[0].get("price") or {}
            product = price.get("product")
            product_id = product.get("id") if isinstance(product, dict) else product
            return price.get("id"), product_id
    return None, None


def _extract_price_id(session: dict) -> Optional[str]:
    return _extract_price_and_product(session)[0]


def _extract_price_and_product_from_invoice(invoice: dict) -> tuple[Optional[str], Optional[str]]:
    lines = invoice.get("lines", {}).get("data", [])
    if lines:
        price = lines[0].get("price") or {}
        product = price.get("product")
        product_id = product.get("id") if isinstance(product, dict) else product
        return price.get("id"), product_id
    return None, None


def _extract_price_id_from_invoice(invoice: dict) -> Optional[str]:
    return _extract_price_and_product_from_invoice(invoice)[0]


def _is_renewal(db: Session, email: str) -> bool:
    return db.query(Transaction).filter(
        Transaction.email == email, Transaction.is_first_purchase.is_(True)
    ).first() is not None


def _tier_from_category(category: str) -> str:
    if category == "founding":
        return "founding"
    if category == "core_annual":
        return "core_annual"
    return "core_monthly"
