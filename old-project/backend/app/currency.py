from __future__ import annotations
"""
Currency conversion to USD — the dashboard's house currency.

Both relevant currencies are hard-pegged to USD, so conversion uses
constants (overridable via env vars), not an FX feed:
  * BHD: 1 BHD = 2.6596 USD (pegged since 2001) — Zoho Books
  * AED: 1 USD = 3.6725 AED (pegged since 1997) — Stripe charges

Everything is converted at import/webhook time and STORED in USD.
Human-entered values (targets, summit figures, manual entries) are
USD by convention.
"""
import logging

from app.config import settings

logger = logging.getLogger(__name__)


def to_usd(amount: float, currency_code: str) -> tuple[float, str]:
    """
    Convert an amount to USD. Returns (converted_amount, stored_currency).
    Unknown currencies are imported unconverted with a warning, keeping
    their original code so they are findable later.
    """
    code = (currency_code or "USD").upper()
    if code == "USD":
        return round(amount, 2), "USD"
    if code == "BHD":
        return round(amount * settings.bhd_usd_rate, 2), "USD"
    if code == "AED":
        return round(amount * settings.aed_usd_rate, 2), "USD"
    if code == "GBP":
        # floating rate — approximate, configurable via GBP_USD_RATE
        return round(amount * settings.gbp_usd_rate, 2), "USD"
    logger.warning("Unhandled currency %s — importing amount unconverted", code)
    return round(amount, 2), code
