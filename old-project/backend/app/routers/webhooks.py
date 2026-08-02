from __future__ import annotations
import json
import logging
from fastapi import APIRouter, BackgroundTasks, Header, HTTPException, Request
from sqlalchemy.orm import Session
from fastapi import Depends
from app.database import get_db
from app.services import stripe_service, tap_service, hubspot_service, slack_service

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/webhooks", tags=["webhooks"])


@router.post("/stripe")
async def stripe_webhook(
    request: Request,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    stripe_signature: str = Header(None, alias="stripe-signature"),
):
    payload = await request.body()
    if not stripe_service.verify_signature(payload, stripe_signature):
        raise HTTPException(status_code=400, detail="Invalid Stripe signature")
    try:
        event = json.loads(payload)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    result = stripe_service.process_event(db, event)

    # Fire new-member Slack announcement in background
    if result.get("is_new_member"):
        background.add_task(
            _announce_member_from_stripe, db, result, event
        )
    return {"received": True}


def _announce_member_from_stripe(db, result, event):
    try:
        obj = event.get("data", {}).get("object", {})
        email = obj.get("customer_email", "")
        meta = obj.get("metadata") or {}
        category = meta.get("category", "unknown")
        amount = (obj.get("amount_total") or 0) / 100
        slack_service.announce_new_member(email, category, "stripe", amount)
    except Exception as e:
        logger.warning("Slack announcement failed: %s", e)


@router.post("/tap")
async def tap_webhook(
    request: Request,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    x_tap_signature: str = Header(None, alias="x-tap-signature"),
):
    payload = await request.body()
    if not tap_service.verify_signature(payload, x_tap_signature):
        raise HTTPException(status_code=400, detail="Invalid Tap signature")
    try:
        event = json.loads(payload)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    result = tap_service.process_event(db, event)

    if result.get("is_new_member"):
        charge = event.get("object") or event
        email = (charge.get("customer", {}).get("email") or "").lower().strip()
        amount = float(charge.get("amount", 0))
        background.add_task(slack_service.announce_new_member, email, "unknown", "tap", amount)

    return {"received": True}


@router.post("/hubspot")
async def hubspot_webhook(
    request: Request,
    db: Session = Depends(get_db),
    x_hubspot_signature_v3: str = Header(None, alias="x-hubspot-signature-v3"),
    x_hubspot_request_timestamp: str = Header(None, alias="x-hubspot-request-timestamp"),
):
    payload = await request.body()
    if not hubspot_service.verify_signature(
        payload,
        x_hubspot_signature_v3,
        method=request.method,
        uri=str(request.url),
        timestamp=x_hubspot_request_timestamp or "",
    ):
        raise HTTPException(status_code=401, detail="Invalid HubSpot signature")
    try:
        events = json.loads(payload)
        if isinstance(events, dict):
            events = [events]
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    result = hubspot_service.process_webhook(db, events)
    return result


def _verify_slack_signature(payload: bytes, timestamp: str, signature: str) -> bool:
    """Slack signing: v0=hex(HMAC-SHA256(secret, 'v0:{ts}:{body}')), 5-min replay window."""
    import hashlib
    import hmac
    import time as _time
    from app.config import settings

    if not settings.slack_signing_secret:
        if settings.debug:
            return True  # explicit dev mode only
        logger.error("SLACK_SIGNING_SECRET not set — rejecting Slack event (fail closed)")
        return False
    if not timestamp or not signature:
        return False
    try:
        if abs(_time.time() - int(timestamp)) > 60 * 5:
            return False
    except (TypeError, ValueError):
        return False
    basestring = f"v0:{timestamp}:".encode() + payload
    expected = "v0=" + hmac.new(
        settings.slack_signing_secret.encode(), basestring, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, signature)


@router.post("/slack/events")
async def slack_events(
    request: Request,
    db: Session = Depends(get_db),
    x_slack_request_timestamp: str = Header(None, alias="x-slack-request-timestamp"),
    x_slack_signature: str = Header(None, alias="x-slack-signature"),
):
    """
    Receives Slack Event API payloads.
    Used for summit tracker updates posted to the summit channel.
    """
    payload = await request.body()
    if not _verify_slack_signature(payload, x_slack_request_timestamp or "", x_slack_signature or ""):
        raise HTTPException(status_code=401, detail="Invalid Slack signature")

    body = json.loads(payload)

    # URL verification challenge
    if body.get("type") == "url_verification":
        return {"challenge": body.get("challenge")}

    event = body.get("event", {})
    event_type = event.get("type", "")
    channel = event.get("channel", "")
    text = event.get("text", "")

    from app.config import settings
    # Only process human messages posted in the configured summit channel.
    # If no channel ID is configured, process nothing (fail closed).
    if (
        event_type == "message"
        and not event.get("bot_id")
        and settings.slack_summit_channel_id
        and channel == settings.slack_summit_channel_id
    ):
        parsed = slack_service.parse_summit_update(text)
        if parsed:
            _save_summit_update(db, parsed)

    return {"ok": True}


def _save_summit_update(db, data: dict):
    from datetime import date
    from app.models.financial import SummitTracker
    today = date.today()
    tracker = db.query(SummitTracker).filter(SummitTracker.snapshot_date == today).first()
    if tracker is None:
        tracker = SummitTracker(snapshot_date=today)
        db.add(tracker)
    for field, value in data.items():
        if hasattr(tracker, field):
            setattr(tracker, field, value)
    tracker.updated_by = "slack"
    db.commit()
    logger.info("Summit tracker updated from Slack: %s", data)
