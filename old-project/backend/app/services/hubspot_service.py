from __future__ import annotations
"""
HubSpot Enterprise integration.
Webhook handler + full sync + reconciliation.
"""
import hashlib
import hmac
import logging
import time
from datetime import date, datetime, timedelta
from typing import Optional

import httpx
from sqlalchemy.orm import Session

from app.config import settings
from app.models.b2b import B2BDeal, B2BDealHistory

logger = logging.getLogger(__name__)

HUBSPOT_API = "https://api.hubapi.com"
HEADERS = lambda: {"Authorization": f"Bearer {settings.hubspot_api_key}", "Content-Type": "application/json"}  # noqa: E731


# ── Signature verification ────────────────────────────────────────────────────

def verify_signature(
    payload: bytes,
    sig_header: str,
    *,
    method: str = "POST",
    uri: str = "",
    timestamp: str = "",
) -> bool:
    """
    HubSpot v3 signature: base64( HMAC-SHA256( secret, method + uri + body + timestamp ) )
    sent in X-HubSpot-Signature-v3, with X-HubSpot-Request-Timestamp.
    Rejects requests older than 5 minutes (replay protection).
    """
    if not settings.hubspot_webhook_secret:
        if settings.debug:
            return True  # explicit dev mode only
        logger.error("HUBSPOT_WEBHOOK_SECRET not set — rejecting webhook (fail closed)")
        return False
    if not sig_header or not timestamp:
        return False
    try:
        ts_ms = int(timestamp)
    except (TypeError, ValueError):
        return False
    if abs(time.time() * 1000 - ts_ms) > 5 * 60 * 1000:
        logger.warning("HubSpot webhook timestamp outside 5-minute window — rejected")
        return False
    import base64
    message = f"{method}{uri}".encode() + payload + timestamp.encode()
    expected = base64.b64encode(
        hmac.new(settings.hubspot_webhook_secret.encode(), message, hashlib.sha256).digest()
    ).decode()
    return hmac.compare_digest(expected, sig_header)


# ── API helpers ───────────────────────────────────────────────────────────────

DEAL_PROPS = [
    "dealname", "amount", "dealstage", "closedate", "createdate",
    "hubspot_owner_id", "hs_lastmodifieddate", "hs_closed_won_date",
    "contract_start_date", "contract_end_date",
    settings.hubspot_prop_deal_type,
    settings.hubspot_prop_source,
]


def _fetch_owner(owner_id: str) -> dict:
    try:
        r = httpx.get(f"{HUBSPOT_API}/crm/v3/owners/{owner_id}", headers=HEADERS(), timeout=10)
        if r.status_code == 200:
            d = r.json()
            return {"name": f"{d.get('firstName','')} {d.get('lastName','')}".strip(), "email": d.get("email", "")}
    except Exception:
        pass
    return {"name": "", "email": ""}


def _fetch_company(deal_id: str) -> str:
    try:
        r = httpx.get(
            f"{HUBSPOT_API}/crm/v3/objects/deals/{deal_id}/associations/companies",
            headers=HEADERS(), timeout=10,
        )
        if r.status_code == 200:
            results = r.json().get("results", [])
            if results:
                company_id = results[0]["id"]
                cr = httpx.get(
                    f"{HUBSPOT_API}/crm/v3/objects/companies/{company_id}?properties=name",
                    headers=HEADERS(), timeout=10,
                )
                if cr.status_code == 200:
                    return cr.json().get("properties", {}).get("name", "")
    except Exception:
        pass
    return ""


def _normalise_deal(raw: dict, owner_cache: dict) -> dict:
    props = raw.get("properties", {})
    deal_id = raw.get("id", "")

    owner_id = props.get("hubspot_owner_id", "")
    if owner_id and owner_id not in owner_cache:
        owner_cache[owner_id] = _fetch_owner(owner_id)
    owner = owner_cache.get(owner_id, {})

    stage = (props.get("dealstage") or "").lower()
    won_stages = {"closedwon"}
    lost_stages = {"closedlost"}
    status = "won" if stage in won_stages else "lost" if stage in lost_stages else "open"

    def _date(v):
        if not v:
            return None
        try:
            return datetime.fromisoformat(v.replace("Z", "+00:00")).date()
        except Exception:
            return None

    return {
        "hubspot_deal_id": deal_id,
        "deal_name": props.get("dealname"),
        "amount": float(props.get("amount") or 0) or None,
        "currency": "USD",
        "stage": props.get("dealstage"),
        "deal_type": props.get(settings.hubspot_prop_deal_type),
        "source": props.get(settings.hubspot_prop_source),
        "owner_name": owner.get("name"),
        "owner_email": owner.get("email"),
        "created_at": _ts(props.get("createdate")),
        "close_date_expected": _date(props.get("closedate")),
        "close_date_actual": _date(props.get("hs_closed_won_date") or (props.get("closedate") if status == "won" else None)),
        "contract_end_date": _date(props.get("contract_end_date")),
        "last_activity_date": _ts(props.get("hs_lastmodifieddate")),
        "status": status,
    }


def _ts(v):
    if not v:
        return None
    try:
        return datetime.fromisoformat(v.replace("Z", "+00:00")).replace(tzinfo=None)
    except Exception:
        return None


# ── Sync logic ────────────────────────────────────────────────────────────────

def sync_deal(db: Session, data: dict, company_name: str = "") -> tuple[B2BDeal, bool]:
    """Upsert a deal. Returns (deal, is_new)."""
    deal = db.query(B2BDeal).filter(B2BDeal.hubspot_deal_id == data["hubspot_deal_id"]).first()
    is_new = deal is None

    if is_new:
        deal = B2BDeal(hubspot_deal_id=data["hubspot_deal_id"], company_name=company_name)
        db.add(deal)

    track_fields = ["stage", "amount", "status", "owner_name"]
    for field in track_fields:
        old_val = getattr(deal, field, None)
        new_val = data.get(field)
        if old_val is not None and str(old_val) != str(new_val):
            history = B2BDealHistory(
                deal_id=deal.id if not is_new else "",
                field_changed=field,
                old_value=str(old_val),
                new_value=str(new_val),
            )
            db.add(history)

    for k, v in data.items():
        if hasattr(deal, k) and k != "hubspot_deal_id":
            setattr(deal, k, v)
    if company_name:
        deal.company_name = company_name

    # Update stage duration
    now = datetime.utcnow()
    if deal.stage_entered_at and deal.stage == data.get("stage"):
        deal.days_in_current_stage = (now - deal.stage_entered_at).days
    else:
        deal.stage_entered_at = now
        deal.days_in_current_stage = 0

    deal.synced_at = now
    db.commit()
    return deal, is_new


def full_sync(db: Session, days_back: int = 7) -> dict:
    """Pull all deals modified in the last N days from HubSpot."""
    if not settings.hubspot_api_key:
        return {"status": "skipped", "reason": "no_api_key"}

    modified_after_ms = int((datetime.utcnow() - timedelta(days=days_back)).timestamp() * 1000)
    owner_cache: dict = {}
    processed = 0
    new_deals = 0
    after = None

    while True:
        body = {
            "filterGroups": [{
                "filters": [{
                    "propertyName": "hs_lastmodifieddate",
                    "operator": "GTE",
                    "value": str(modified_after_ms),
                }]
            }],
            "properties": DEAL_PROPS,
            "limit": 100,
        }
        if after:
            body["after"] = after

        try:
            r = httpx.post(
                f"{HUBSPOT_API}/crm/v3/objects/deals/search",
                headers=HEADERS(), json=body, timeout=30,
            )
            r.raise_for_status()
        except Exception as e:
            logger.error("HubSpot sync error: %s", e)
            break

        data = r.json()
        results = data.get("results", [])
        if not results:
            break

        for raw in results:
            try:
                company = _fetch_company(raw["id"])
                normalised = _normalise_deal(raw, owner_cache)
                _, is_new = sync_deal(db, normalised, company)
                processed += 1
                if is_new:
                    new_deals += 1
            except Exception as e:
                logger.warning("Failed to sync deal %s: %s", raw.get("id"), e)

        paging = data.get("paging", {})
        after = paging.get("next", {}).get("after")
        if not after:
            break
        time.sleep(0.1)

    logger.info("HubSpot sync: %d processed, %d new", processed, new_deals)
    return {"status": "ok", "processed": processed, "new": new_deals}


def process_webhook(db: Session, events: list) -> dict:
    """Process HubSpot webhook payload (array of events)."""
    if not settings.hubspot_api_key:
        return {"status": "skipped"}

    owner_cache: dict = {}
    processed = 0

    for event in events:
        subscription_type = event.get("subscriptionType", "")
        if "deal" not in subscription_type:
            continue
        deal_id = str(event.get("objectId", ""))
        if not deal_id:
            continue
        try:
            r = httpx.get(
                f"{HUBSPOT_API}/crm/v3/objects/deals/{deal_id}",
                params={"properties": ",".join(DEAL_PROPS)},
                headers=HEADERS(), timeout=10,
            )
            if r.status_code == 200:
                company = _fetch_company(deal_id)
                normalised = _normalise_deal(r.json(), owner_cache)
                sync_deal(db, normalised, company)
                processed += 1
        except Exception as e:
            logger.warning("Webhook deal sync failed %s: %s", deal_id, e)

    return {"status": "ok", "processed": processed}