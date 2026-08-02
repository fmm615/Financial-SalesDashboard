from __future__ import annotations
"""
Zoho Books integration — Phase 2 placeholder.

When ZOHO_SYNC_ENABLED=true, this module:
  1. Refreshes the OAuth access token using the refresh token.
  2. Pulls invoices, expenses, and P&L from Zoho Books API.
  3. Upserts into financial_records table.

Phase 1: all methods return {"status": "zoho_sync_disabled"}.
"""
import logging
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy.orm import Session
from app.config import settings

logger = logging.getLogger(__name__)

_access_token: Optional[str] = None
_token_expiry: Optional[datetime] = None

ZOHO_TOKEN_URL = "https://accounts.zoho.com/oauth/v2/token"
ZOHO_BOOKS_API = "https://www.zohoapis.com/books/v3"


def _refresh_token() -> Optional[str]:
    global _access_token, _token_expiry
    if _access_token and _token_expiry and datetime.utcnow() < _token_expiry:
        return _access_token
    if not all([settings.zoho_client_id, settings.zoho_client_secret, settings.zoho_refresh_token]):
        return None
    try:
        import httpx
        r = httpx.post(ZOHO_TOKEN_URL, data={
            "grant_type": "refresh_token",
            "client_id": settings.zoho_client_id,
            "client_secret": settings.zoho_client_secret,
            "refresh_token": settings.zoho_refresh_token,
        }, timeout=15)
        r.raise_for_status()
        d = r.json()
        _access_token = d.get("access_token")
        _token_expiry = datetime.utcnow() + timedelta(seconds=d.get("expires_in", 3600) - 60)
        logger.info("Zoho token refreshed, expires at %s", _token_expiry)
        return _access_token
    except Exception as e:
        logger.error("Zoho token refresh failed: %s", e)
        return None


def sync_financial_data(db: Session, days_back: int = 30) -> dict:
    """Daily sync of Zoho Books financial data."""
    if not settings.zoho_sync_enabled:
        return {"status": "zoho_sync_disabled", "message": "Set ZOHO_SYNC_ENABLED=true to activate"}

    token = _refresh_token()
    if not token:
        return {"status": "error", "message": "Could not obtain Zoho access token"}

    results = {}
    results["invoices"] = _sync_invoices(db, token, days_back)
    results["expenses"] = _sync_expenses(db, token, days_back)
    results["cash"] = _sync_cash_position(db, token)
    return {"status": "ok", "results": results}


def _zoho_get(token: str, path: str, params: dict) -> dict:
    import httpx
    params = {"organization_id": settings.zoho_org_id, **params}
    r = httpx.get(
        f"{ZOHO_BOOKS_API}{path}",
        params=params,
        headers={"Authorization": f"Zoho-oauthtoken {token}"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def _sync_invoices(db: Session, token: str, days_back: int) -> dict:
    # Deliberately not synced: B2C revenue comes from Stripe/Tap and B2B from
    # HubSpot. Importing Zoho invoices as revenue records would double-count
    # in the dashboard trend. Revisit only for revenue streams that exist
    # solely in Zoho (map those to revenue_other with care).
    return {"status": "skipped_by_design", "reason": "revenue already sourced from Stripe/HubSpot"}


# Zoho expense account name → internal expense category (keyword heuristic;
# unmatched accounts fall through to expense_operating)
_EXPENSE_KEYWORDS = [
    (("summit", "event", "venue"), "expense_summit"),
    (("marketing", "advertis", "campaign", "promo"), "expense_marketing"),
    (("salar", "payroll", "wage", "personnel", "staff", "contractor"), "expense_personnel"),
]


from app.currency import to_usd as _shared_to_usd


def _to_usd(amount: float, currency_code: str) -> tuple[float, str]:
    # Zoho amounts with no currency code are the org base currency: BHD
    return _shared_to_usd(amount, currency_code or "BHD")


def _categorize_expense(account_name: str) -> str:
    name = (account_name or "").lower()
    for keywords, category in _EXPENSE_KEYWORDS:
        if any(k in name for k in keywords):
            return category
    return "expense_operating"


def _sync_expenses(db: Session, token: str, days_back: int) -> dict:
    from datetime import date as _date
    from app.models.financial import FinancialRecord

    end = _date.today()
    start = end - timedelta(days=days_back)
    created = 0
    updated = 0
    page = 1

    while True:
        data = _zoho_get(token, "/expenses", {
            "date_start": start.isoformat(),
            "date_end": end.isoformat(),
            "page": page,
            "per_page": 200,
        })
        for exp in data.get("expenses", []):
            if exp.get("status") == "voided":
                continue
            zoho_id = f"exp_{exp['expense_id']}"
            amount, currency = _to_usd(float(exp.get("total") or 0), exp.get("currency_code"))
            exp_date = datetime.strptime(exp["date"], "%Y-%m-%d").date()
            category = _categorize_expense(exp.get("account_name", ""))

            row = db.query(FinancialRecord).filter(
                FinancialRecord.zoho_transaction_id == zoho_id
            ).first()
            if row:
                row.date = exp_date
                row.amount = amount
                row.currency = currency
                row.category = category
                row.account_name = exp.get("account_name")
                row.description = exp.get("description") or exp.get("reference_number")
                updated += 1
            else:
                db.add(FinancialRecord(
                    date=exp_date,
                    category=category,
                    subcategory=exp.get("account_name"),
                    account_name=exp.get("account_name"),
                    amount=amount,
                    currency=currency,
                    description=exp.get("description") or exp.get("reference_number"),
                    source="zoho",
                    zoho_transaction_id=zoho_id,
                ))
                created += 1

        if not data.get("page_context", {}).get("has_more_page"):
            break
        page += 1

    db.commit()
    logger.info("Zoho expenses sync: %d created, %d updated (window %s → %s)", created, updated, start, end)
    return {"status": "ok", "created": created, "updated": updated}


def _sync_cash_position(db: Session, token: str) -> dict:
    from datetime import date as _date
    from app.models.financial import CashPosition

    data = _zoho_get(token, "/bankaccounts", {})
    accounts = [
        a for a in data.get("bankaccounts", [])
        if a.get("is_active", True) and a.get("account_type") in ("bank", "cash")
    ]
    total = round(sum(
        _to_usd(float(a.get("balance") or 0), a.get("currency_code"))[0]
        for a in accounts
    ), 2)

    today = _date.today()
    row = db.query(CashPosition).filter(
        CashPosition.date == today, CashPosition.source == "zoho"
    ).first()
    if row:
        row.balance = total
    else:
        db.add(CashPosition(
            date=today, balance=total, source="zoho",
            notes=f"{len(accounts)} bank/cash accounts (converted to USD)",
        ))
    db.commit()
    logger.info("Zoho cash position: %.2f across %d accounts", total, len(accounts))
    return {"status": "ok", "balance": total, "accounts": len(accounts)}


def get_pl_summary(start_date: str, end_date: str) -> Optional[dict]:
    """Fetch P&L from Zoho for a date range. Returns None in Phase 1."""
    if not settings.zoho_sync_enabled:
        return None
    token = _refresh_token()
    if not token:
        return None
    # Phase 2: implement
    return None
