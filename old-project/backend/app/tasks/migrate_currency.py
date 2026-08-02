from __future__ import annotations
"""
One-time migration: convert existing Transaction rows stored in AED/BHD
to USD (the backfill and webhooks stored raw processor amounts before
currency conversion existed).

Idempotent: only touches rows where currency != 'USD', and converted rows
are relabeled USD, so a second run finds nothing to do.

Usage (Railway console):
    /opt/venv/bin/python -m app.tasks.migrate_currency --dry-run
    /opt/venv/bin/python -m app.tasks.migrate_currency
"""
import argparse
import logging

from app.currency import to_usd
from app.database import SessionLocal, init_db
from app.models.members import Transaction
from app.services.deduplication import build_fingerprint

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


def migrate(dry_run: bool = False) -> dict:
    init_db()
    db = SessionLocal()
    try:
        rows = db.query(Transaction).filter(Transaction.currency != "USD").all()
        by_currency: dict[str, int] = {}
        converted = 0
        for t in rows:
            new_gross, new_code = to_usd(t.amount_gross, t.currency)
            if new_code != "USD":
                # unknown currency — left alone, logged by to_usd
                continue
            by_currency[t.currency] = by_currency.get(t.currency, 0) + 1
            if not dry_run:
                ratio = (new_gross / t.amount_gross) if t.amount_gross else 0
                t.amount_gross = new_gross
                t.amount_net = round(t.amount_net * ratio, 2)
                t.vat_amount = round(t.vat_amount * ratio, 2)
                t.currency = "USD"
                # keep the near-duplicate check coherent with future USD events
                t.dedup_fingerprint = build_fingerprint(
                    t.email, t.amount_gross,
                    "refund" if t.is_refund else t.category,
                    t.date,
                )
            converted += 1
        if not dry_run:
            db.commit()
        result = {
            "status": "dry_run" if dry_run else "ok",
            "converted": converted,
            "by_currency": by_currency,
        }
        logger.info("%s", result)
        return result
    finally:
        db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    print(migrate(dry_run=args.dry_run))
