from __future__ import annotations
"""
Slack notifications.
All posts are best-effort — failures are logged but never crash the caller.
"""
import logging
import re
from datetime import date, datetime
from typing import Optional

from app.config import settings

logger = logging.getLogger(__name__)

_client = None


def _get_client():
    global _client
    if _client is None and settings.slack_bot_token:
        from slack_sdk import WebClient
        _client = WebClient(token=settings.slack_bot_token)
    return _client


def _post(channel: str, text: str, blocks: Optional[list] = None) -> bool:
    client = _get_client()
    if not client:
        logger.debug("Slack not configured — suppressing message to %s", channel)
        return False
    try:
        kwargs = {"channel": channel, "text": text}
        if blocks:
            kwargs["blocks"] = blocks
        client.chat_postMessage(**kwargs)
        return True
    except Exception as e:
        logger.error("Slack post failed to %s: %s", channel, e)
        return False


# ── Member announcement ────────────────────────────────────────────────────────

def announce_new_member(email: str, category: str, processor: str, amount_gross: float) -> bool:
    cat_labels = {
        "core_monthly":  "Core Monthly",
        "core_annual":   "Core Annual",
        "founding":      "Founding Membership",
        "summit_ticket": "Summit Ticket",
        "summit_gala":   "Summit + Gala",
        "judge":         "Judge Slot",
        "moderator":     "Moderator Slot",
    }
    label = cat_labels.get(category, category)
    processor_label = processor.upper()
    text = f"🎉 New PLAYBOOK member: *{email}* joined via *{label}* · ${amount_gross:,.2f} · {processor_label}"
    return _post(settings.slack_members_channel, text)


# ── Daily summary ─────────────────────────────────────────────────────────────

def post_daily_summary(snapshot: dict) -> bool:
    today = snapshot.get("date", date.today().isoformat())
    new_members = snapshot.get("new_members_count", 0) or 0
    target = int(settings.b2c_member_daily_target)
    b2c_rev = snapshot.get("b2c_revenue_gross", 0) or 0
    b2b_val = snapshot.get("b2b_bookings_value", 0) or 0
    mtd_members = snapshot.get("mtd_members", 0) or 0
    cash = snapshot.get("cash_position")
    runway = snapshot.get("runway_months")
    days_to_summit = snapshot.get("days_to_summit")

    status = "✅" if new_members >= target else ("⚠️" if new_members >= target * 0.5 else "🔴")
    text = (
        f"*PLAYBOOK Daily — {today}*\n"
        f"B2C: {new_members} new members {status} (target: {target}) · ${b2c_rev:,.0f} revenue\n"
        f"B2C MTD: {mtd_members} members\n"
        f"B2B bookings: ${b2b_val:,.0f}\n"
    )
    if cash is not None:
        text += f"Cash: ${cash:,.0f}"
    if runway is not None:
        text += f" · Runway: {runway:.1f} months"
    if days_to_summit is not None:
        text += f"\nDays to summit: {days_to_summit}"

    return _post(settings.slack_daily_channel, text)


# ── Weekly digest ─────────────────────────────────────────────────────────────

def post_weekly_digest(summary: dict) -> bool:
    week = summary.get("week", "")
    text = (
        f"*PLAYBOOK Weekly Digest — {week}*\n"
        f"B2C: {summary.get('new_members_wtd', 0)} new members · ${summary.get('b2c_revenue_wtd', 0):,.0f}\n"
        f"B2B pipeline: ${summary.get('pipeline_value', 0):,.0f} open · ${summary.get('bookings_wtd', 0):,.0f} booked\n"
        f"Win rate (90d): {summary.get('win_rate', 0):.0f}%\n"
        f"MRR estimate: ${summary.get('mrr', 0):,.0f}"
    )
    return _post(settings.slack_daily_channel, text)


# ── Anomaly alerts ─────────────────────────────────────────────────────────────

def alert_b2c_anomaly(message: str) -> bool:
    return _post(settings.slack_alerts_channel, f"🚨 *B2C Anomaly* — {message}")


def alert_b2b_anomaly(message: str) -> bool:
    return _post(settings.slack_alerts_channel, f"🚨 *B2B Anomaly* — {message}")


def alert_financial_anomaly(message: str) -> bool:
    return _post(settings.slack_alerts_channel, f"🚨 *Financial Alert* — {message}")


def alert_tech(message: str) -> bool:
    return _post(settings.slack_alerts_channel, f"⚠️ *Tech Alert* — {message}")


# ── Summit tracker (Slack integration) ────────────────────────────────────────
# Parses a structured summit update posted by Sara Hammad in the summit channel.
# Expected format:
#   @PLAYBOOK summit update
#   tickets: 45
#   judges: 7
#   mou: 2
#   booths: 3
#   moderators: 4
#   revenue: 12500
#   costs: 255553
#   notes: Waiting on two MoUs from sponsors

SUMMIT_FIELDS = {
    "tickets":     "ticket_registrations",
    "judges":      "judges_confirmed",
    "mou":         "mou_signed",
    "booths":      "booths_sold",
    "moderators":  "moderators_confirmed",
    "pitching":    "pitching_confirmed",
    "b2b_partners": "b2b_partners_confirmed",
    "revenue":     "revenue_raised_to_date",
    "costs":       "total_summit_costs",
    "notes":       "notes",
}


def parse_summit_update(text: str) -> Optional[dict]:
    """
    Parse a summit update message from Slack.
    Returns dict of field → value, or None if not a summit update.
    """
    lower = text.lower()
    if "summit update" not in lower and "summit:" not in lower:
        return None

    result: dict = {}
    for line in text.splitlines():
        line = line.strip()
        for key, field in SUMMIT_FIELDS.items():
            pattern = rf"(?i){key}\s*[:=]\s*(.+)"
            m = re.search(pattern, line)
            if m:
                raw = m.group(1).strip()
                if field == "notes":
                    result[field] = raw
                else:
                    try:
                        result[field] = float(raw.replace(",", "").replace("$", ""))
                    except ValueError:
                        pass
    return result if result else None
