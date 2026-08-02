from __future__ import annotations
"""
One-shot historical backfill.

Imports past activity that webhooks (forward-looking) and the nightly
reconciliation (2-3 day window) can never capture:

  * Stripe: charges via the Charges API (NOT the Events API, which only
    retains ~30 days). Handles renewals, first purchases, member creation,
    and refunds. Processes oldest-first so is_first_purchase is correct.
  * HubSpot: delegates to hubspot_service.full_sync with a wide window
    (search API; note HubSpot caps search results at 10,000 deals).

Idempotent: every row goes through the same dedup gate the webhooks use
(processor_transaction_id + content fingerprint), and the canonical
transaction IDs are chosen to MATCH what the webhook handlers store
(invoice id for renewals, checkout-session id for checkouts), so running
this after webhooks have been live will not double-count.

Usage (CLI, recommended — run from backend/):
    python -m app.tasks.backfill --since 2026-02-01
    python -m app.tasks.backfill --since 2026-02-01 --dry-run
    python -m app.tasks.backfill --since 2026-02-01 --skip-hubspot

Or via the admin endpoint: POST /api/admin/backfill {"since": "2026-02-01"}
"""
import logging
import time
from datetime import datetime, timezone
from typing import Optional

import stripe
from sqlalchemy.orm import Session

from app.config import settings
from app.models.members import Member, Transaction
from app.services.deduplication import (
    build_fingerprint, gross_to_net, is_duplicate, is_existing_member, resolve_category_any,
)

logger = logging.getLogger(__name__)


# ── Stripe ────────────────────────────────────────────────────────────────────

def backfill_stripe(db: Session, since: datetime, dry_run: bool = False) -> dict:
    """Import all succeeded Stripe charges created on/after `since`."""
    if not settings.stripe_api_key:
        return {"status": "skipped", "reason": "no_api_key"}
    stripe.api_key = settings.stripe_api_key

    since_ts = int(since.replace(tzinfo=timezone.utc).timestamp())
    logger.info("Stripe backfill: fetching charges since %s (dry_run=%s)", since.date(), dry_run)

    # 1. Collect all charges (paginated), then sort oldest-first so that
    #    member creation / is_first_purchase resolves in true order.
    charges: list = []
    params = {
        "created": {"gte": since_ts},
        "limit": 100,
        "expand": ["data.customer", "data.invoice", "data.refunds"],
    }
    try:
        for ch in stripe.Charge.list(**params).auto_paging_iter():
            charges.append(ch)
    except Exception as e:
        logger.error("Stripe backfill: charge listing failed: %s", e)
        return {"status": "error", "error": str(e), "fetched": len(charges)}

    charges.sort(key=lambda c: c.get("created", 0))
    logger.info("Stripe backfill: %d charges fetched", len(charges))

    imported = 0
    refunds = 0
    duplicates = 0
    skipped = 0
    new_members = 0
    session_cache: dict[str, Optional[dict]] = {}

    for idx, ch in enumerate(charges):
        if idx and idx % 50 == 0:
            logger.info("Stripe backfill progress: %d/%d (imported=%d dup=%d)",
                        idx, len(charges), imported, duplicates)
            time.sleep(0.2)  # be polite to the API (session lookups below)

        if ch.get("status") != "succeeded" or not ch.get("paid"):
            skipped += 1
            continue

        email = _charge_email(ch)
        if not email:
            skipped += 1
            logger.warning("Stripe backfill: charge %s has no email — skipped", ch.get("id"))
            continue

        ts = datetime.utcfromtimestamp(ch.get("created", 0))
        from app.currency import to_usd
        amount_gross, currency = to_usd(
            (ch.get("amount") or 0) / 100.0,
            (ch.get("currency") or "usd").upper(),
        )

        # Canonical ID + price id — chosen to MATCH what webhooks store:
        canonical_id, price_id, product_id, is_renewal_hint = _canonical_ids(ch, session_cache)

        category, grants_core = resolve_category_any(db, "stripe", [price_id, product_id])
        fingerprint = build_fingerprint(email, amount_gross, category, ts)
        dup, reason = is_duplicate(
            db, processor_transaction_id=canonical_id, fingerprint=fingerprint, transaction_at=ts
        )
        if dup:
            duplicates += 1
        else:
            already_member = is_existing_member(db, email)
            is_renewal = is_renewal_hint or (already_member and grants_core and _has_first(db, email))
            is_first = grants_core and not already_member and not is_renewal

            txn = Transaction(
                email=email,
                date=ts,
                processor="stripe",
                processor_transaction_id=canonical_id,
                product_id=price_id,
                category=category,
                amount_gross=amount_gross,
                amount_net=gross_to_net(amount_gross),
                vat_amount=round(amount_gross - gross_to_net(amount_gross), 2),
                currency=currency,
                is_first_purchase=is_first,
                is_renewal=is_renewal,
                source="backfill",
                dedup_fingerprint=fingerprint,
            )
            if not dry_run:
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
                    db.flush()
                    txn.member_id = member.id
                db.commit()
            if is_first:
                new_members += 1
            imported += 1

        # Refunds on this charge (full or partial) — mirror the webhook handler
        amount_refunded, _rcur = to_usd(
            (ch.get("amount_refunded") or 0) / 100.0,
            (ch.get("currency") or "usd").upper(),
        )
        if amount_refunded > 0:
            refund_id = f"refund_{ch.get('id')}"
            r_dup, _ = is_duplicate(db, processor_transaction_id=refund_id)
            if not r_dup:
                refund_ts = _latest_refund_ts(ch) or ts
                refund_net = gross_to_net(amount_refunded)
                if not dry_run:
                    db.add(Transaction(
                        email=email,
                        date=refund_ts,
                        processor="stripe",
                        processor_transaction_id=refund_id,
                        category=category,
                        amount_gross=-amount_refunded,
                        amount_net=-refund_net,
                        vat_amount=-round(amount_refunded - refund_net, 2),
                        currency=currency,
                        is_refund=True,
                        source="backfill",
                        dedup_fingerprint=build_fingerprint(email, amount_refunded, "refund", refund_ts),
                    ))
                    # Mirror the webhook handler: full refund of a first
                    # purchase deactivates the membership
                    orig = db.query(Transaction).filter(
                        Transaction.processor_transaction_id == canonical_id
                    ).first()
                    if orig and orig.is_first_purchase and amount_refunded >= orig.amount_gross:
                        member = db.query(Member).filter(Member.email == email).first()
                        if member:
                            member.status = "refunded"
                    db.commit()
                refunds += 1

    result = {
        "status": "ok" if not dry_run else "dry_run",
        "fetched": len(charges),
        "imported": imported,
        "new_members": new_members,
        "refunds": refunds,
        "duplicates_skipped": duplicates,
        "skipped": skipped,
    }
    logger.info("Stripe backfill done: %s", result)
    return result


def _charge_email(ch: dict) -> str:
    email = (ch.get("billing_details") or {}).get("email") or ch.get("receipt_email") or ""
    if not email:
        cust = ch.get("customer")
        if isinstance(cust, dict):
            email = cust.get("email") or ""
    return email.lower().strip()


def _price_and_product(price: dict) -> tuple[Optional[str], Optional[str]]:
    product = (price or {}).get("product")
    product_id = product.get("id") if isinstance(product, dict) else product
    return (price or {}).get("id"), product_id


def _canonical_ids(ch: dict, session_cache: dict) -> tuple[str, Optional[str], Optional[str], bool]:
    """
    Returns (canonical_transaction_id, price_id, product_id, is_renewal_hint).

    Renewal invoices → invoice id (what _handle_invoice stores).
    Checkout charges → checkout session id (what _handle_checkout stores).
    Fallback        → raw charge id.
    """
    invoice = ch.get("invoice")
    if invoice:
        inv = invoice if isinstance(invoice, dict) else None
        inv_id = inv["id"] if inv else invoice
        price_id = product_id = None
        is_renewal = False
        if inv:
            lines = (inv.get("lines") or {}).get("data") or []
            if lines:
                price_id, product_id = _price_and_product(lines[0].get("price"))
            is_renewal = inv.get("billing_reason") in ("subscription_cycle", "subscription_update")
        return inv_id, price_id, product_id, is_renewal

    pi = ch.get("payment_intent")
    pi_id = pi.get("id") if isinstance(pi, dict) else pi
    if pi_id:
        if pi_id not in session_cache:
            try:
                sessions = stripe.checkout.Session.list(
                    payment_intent=pi_id, limit=1, expand=["data.line_items"]
                )
                session_cache[pi_id] = sessions.data[0] if sessions.data else None
            except Exception as e:
                logger.warning("Session lookup failed for %s: %s", pi_id, e)
                session_cache[pi_id] = None
        session = session_cache[pi_id]
        if session:
            price_id = product_id = None
            items = (session.get("line_items") or {}).get("data") or []
            if items:
                price_id, product_id = _price_and_product(items[0].get("price"))
            if not price_id:
                price_id = (session.get("metadata") or {}).get("price_id")
            return session["id"], price_id, product_id, False

    return ch.get("id", ""), None, None, False


def _latest_refund_ts(ch: dict) -> Optional[datetime]:
    data = (ch.get("refunds") or {}).get("data") or []
    if data:
        created = max((r.get("created") or 0) for r in data)
        if created:
            return datetime.utcfromtimestamp(created)
    return None


def _has_first(db: Session, email: str) -> bool:
    return db.query(Transaction).filter(
        Transaction.email == email, Transaction.is_first_purchase.is_(True)
    ).first() is not None


def _tier_from_category(category: str) -> str:
    if category == "founding":
        return "founding"
    if category == "core_annual":
        return "core_annual"
    return "core_monthly"


# ── HubSpot ───────────────────────────────────────────────────────────────────

def backfill_hubspot(db: Session, since: datetime) -> dict:
    """Delegates to full_sync with a wide window (search API supports history)."""
    from app.services.hubspot_service import full_sync
    days_back = max((datetime.utcnow() - since).days + 1, 1)
    logger.info("HubSpot backfill: full_sync days_back=%d", days_back)
    return full_sync(db, days_back=days_back)


# ── Entry points ──────────────────────────────────────────────────────────────

def run_backfill(
    db: Session,
    since: datetime,
    dry_run: bool = False,
    skip_stripe: bool = False,
    skip_hubspot: bool = False,
    include_zoho: bool = False,
) -> dict:
    results: dict = {"since": since.date().isoformat(), "dry_run": dry_run}
    if not skip_stripe:
        results["stripe"] = backfill_stripe(db, since, dry_run=dry_run)
    if not skip_hubspot:
        results["hubspot"] = backfill_hubspot(db, since) if not dry_run else {"status": "skipped_in_dry_run"}
    if include_zoho:
        if dry_run:
            results["zoho"] = {"status": "skipped_in_dry_run"}
        else:
            from app.services.zoho_service import sync_financial_data
            days_back = max((datetime.utcnow() - since).days + 1, 1)
            results["zoho"] = sync_financial_data(db, days_back=days_back)
    return results


if __name__ == "__main__":
    import argparse

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    parser = argparse.ArgumentParser(description="Historical backfill for Stripe + HubSpot")
    parser.add_argument("--since", required=True, help="Start date, YYYY-MM-DD (e.g. 2026-02-01)")
    parser.add_argument("--dry-run", action="store_true", help="Count what would be imported; write nothing")
    parser.add_argument("--skip-stripe", action="store_true")
    parser.add_argument("--skip-hubspot", action="store_true")
    parser.add_argument("--include-zoho", action="store_true", help="Also pull Zoho Books expenses + cash for the window")
    args = parser.parse_args()

    since_dt = datetime.strptime(args.since, "%Y-%m-%d")

    from app.database import SessionLocal, init_db
    init_db()
    session = SessionLocal()
    try:
        out = run_backfill(
            session, since_dt,
            dry_run=args.dry_run,
            skip_stripe=args.skip_stripe,
            skip_hubspot=args.skip_hubspot,
            include_zoho=args.include_zoho,
        )
        print(out)
    finally:
        session.close()
