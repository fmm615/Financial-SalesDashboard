from __future__ import annotations
"""
Reconciliation task: pulls last 48h from Stripe, Tap, and HubSpot to catch
any webhooks that were missed (network issues, downtime, replay needed).
"""
import logging
from datetime import datetime, timedelta, timezone

logger = logging.getLogger(__name__)


def reconcile_stripe(db, days_back: int = 2) -> dict:
    from app.config import settings

    if not settings.stripe_api_key:
        return {"skipped": True, "reason": "no stripe key"}

    try:
        import stripe

        stripe.api_key = settings.stripe_api_key

        since = int(
            (datetime.now(timezone.utc) - timedelta(days=days_back)).timestamp()
        )

        new = 0
        dup = 0

        for event in stripe.Event.list(
            created={"gte": since},
            limit=100,
            types=[
                "checkout.session.completed",
                "invoice.payment_succeeded",
                "charge.refunded",
            ],
        ).auto_paging_iter():

            from app.services.stripe_service import process_event

            result = process_event(db, event.to_dict())

            if result.get("status") == "ok":
                new += 1
            elif result.get("status") in ("duplicate", "skipped"):
                dup += 1

        return {
            "new": new,
            "duplicates": dup,
        }

    except Exception as e:
        logger.error("Stripe reconciliation error: %s", e)
        return {"error": str(e)}


def reconcile_hubspot(db) -> dict:
    from app.config import settings
    if not settings.hubspot_api_key:
        return {"skipped": True, "reason": "no hubspot key"}
    try:
        from app.services.hubspot_service import full_sync
        return full_sync(db, days_back=3)
    except Exception as e:
        logger.error("HubSpot reconciliation error: %s", e)
        return {"error": str(e)}


def run_reconciliation(db=None) -> dict:
    close_db = False
    if db is None:
        from app.database import SessionLocal
        db = SessionLocal()
        close_db = True
    try:
        logger.info("Starting 48h reconciliation pass")
        result = {
            "stripe": reconcile_stripe(db),
            "tap": reconcile_tap(db),
            "hubspot": reconcile_hubspot(db),
        }
        logger.info("Reconciliation complete: %s", result)
        return result
    finally:
        if close_db:
            db.close()
