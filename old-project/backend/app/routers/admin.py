from __future__ import annotations
from datetime import datetime
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from app.auth import get_current_user, get_username
from app.config import settings
from app.database import get_db
from app.models.members import IBANEntry, Member, Transaction
from app.models.config_models import AuditLog, ProductMapping, Target
from app.services.deduplication import build_fingerprint, gross_to_net, is_duplicate, is_existing_member

router = APIRouter(prefix="/api/admin", tags=["admin"])
Dep = Depends(get_current_user)


class IBANRequest(BaseModel):
    email: str
    amount_gross: float
    currency: str = "USD"
    transfer_date: str  # YYYY-MM-DD
    product_name: Optional[str] = None
    category: Optional[str] = "core_monthly"
    notes: Optional[str] = None


@router.post("/iban")
def create_iban_entry(
    body: IBANRequest,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    ts = datetime.strptime(body.transfer_date, "%Y-%m-%d")
    email = body.email.lower().strip()
    # Manual IBAN entries may be typed in BHD (or any supported currency) —
    # convert to USD so the transactions table stays single-currency.
    from app.currency import to_usd
    amount_gross, currency = to_usd(body.amount_gross, body.currency)
    amount_net = gross_to_net(amount_gross)
    fingerprint = build_fingerprint(email, amount_gross, body.category or "unknown", ts)

    is_dup, reason = is_duplicate(db, fingerprint=fingerprint, transaction_at=ts)
    if is_dup:
        raise HTTPException(status_code=409, detail=f"Duplicate detected: {reason}")

    is_first = not is_existing_member(db, email)
    grants_core = body.category not in ("unknown",) if body.category else False

    txn = Transaction(
        email=email,
        date=ts,
        processor="iban",
        product_name=body.product_name,
        category=body.category,
        amount_gross=amount_gross,
        amount_net=amount_net,
        vat_amount=round(amount_gross - amount_net, 2),
        currency=currency,
        is_first_purchase=is_first and grants_core,
        is_renewal=not is_first,
        dedup_fingerprint=fingerprint,
    )
    db.add(txn)

    if is_first and grants_core:
        member = Member(
            email=email,
            first_purchase_date=ts,
            first_purchase_source=body.category,
            first_purchase_processor="iban",
            tier=body.category or "core_monthly",
            status="active",
        )
        db.add(member)
        db.flush()  # populate member.id before linking
        txn.member_id = member.id

    db.flush()  # populate txn.id before linking the IBAN entry
    iban_entry = IBANEntry(
        email=email,
        amount_gross=body.amount_gross,
        amount_net=amount_net,
        currency=body.currency,
        transfer_date=ts,
        product_name=body.product_name,
        category=body.category,
        notes=body.notes,
        entered_by=user.get("sub"),
        transaction_id=txn.id,
    )
    db.add(iban_entry)

    _log(db, user.get("sub"), "iban_entry", {"email": email, "amount": body.amount_gross, "category": body.category})
    db.commit()

    return {
        "status": "ok",
        "transaction_id": txn.id,
        "is_new_member": is_first and grants_core,
    }


@router.get("/products")
def list_products(db: Session = Depends(get_db), _=Dep):
    return db.query(ProductMapping).filter(ProductMapping.active.is_(True)).all()

class ProductMappingRequest(BaseModel):
    processor: str
    processor_product_id: str
    internal_category: str  # core_monthly | core_annual | founding | etc.
    display_name: Optional[str] = None
    amount_gross: Optional[float] = None
    grants_core_access: bool = True
    active: bool = True


@router.post("/products")
def upsert_product(data: ProductMappingRequest, db: Session = Depends(get_db), user: dict = Depends(get_current_user)):
    payload = data.model_dump()
    existing = db.query(ProductMapping).filter(
        ProductMapping.processor == data.processor,
        ProductMapping.processor_product_id == data.processor_product_id,
    ).first()
    if existing:
        for k, v in payload.items():
            setattr(existing, k, v)
    else:
        db.add(ProductMapping(**payload))
    _log(db, user.get("sub"), "product_mapping_update", payload)
    db.commit()
    return {"status": "ok"}


@router.get("/targets")
def get_targets(db: Session = Depends(get_db), _=Dep):
    db_targets = {f"{t.period}:{t.metric}": t.target_value for t in db.query(Target).all()}
    return {
        "fy_revenue": db_targets.get("2026:revenue_total", settings.target_fy_revenue),
        "fy_b2b": db_targets.get("2026:revenue_b2b", settings.target_fy_b2b),
        "fy_b2c": db_targets.get("2026:revenue_b2c", settings.target_fy_b2c),
        "fy_other": db_targets.get("2026:revenue_other", settings.target_fy_other),
        "q1": db_targets.get("2026-Q1:revenue_total", settings.target_q1_revenue),
        "q2": db_targets.get("2026-Q2:revenue_total", settings.target_q2_revenue),
        "q3": db_targets.get("2026-Q3:revenue_total", settings.target_q3_revenue),
        "q4": db_targets.get("2026-Q4:revenue_total", settings.target_q4_revenue),
        "b2c_daily_members": db_targets.get("2026:members_daily", settings.b2c_member_daily_target),
    }


@router.put("/targets")
def update_targets(data: dict, db: Session = Depends(get_db), user: dict = Depends(get_current_user)):
    mapping = {
        "fy_revenue": ("2026", "revenue_total"),
        "fy_b2b": ("2026", "revenue_b2b"),
        "fy_b2c": ("2026", "revenue_b2c"),
        "fy_other": ("2026", "revenue_other"),
        "q1": ("2026-Q1", "revenue_total"),
        "q2": ("2026-Q2", "revenue_total"),
        "q3": ("2026-Q3", "revenue_total"),
        "q4": ("2026-Q4", "revenue_total"),
        "b2c_daily_members": ("2026", "members_daily"),
    }
    for key, (period, metric) in mapping.items():
        if key in data:
            t = db.query(Target).filter(Target.period == period, Target.metric == metric).first()
            if t:
                t.target_value = float(data[key])
            else:
                db.add(Target(period=period, metric=metric, target_value=float(data[key]), updated_by=user.get("sub")))
    _log(db, user.get("sub"), "targets_update", data)
    db.commit()
    return {"status": "ok"}


@router.post("/hubspot/sync")
def manual_hubspot_sync(
    days_back: int = 7,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    from app.services.hubspot_service import full_sync

    result = full_sync(db, days_back=days_back)
    _log(db, user.get("sub"), "hubspot_manual_sync", result)
    return result


@router.post("/stripe/sync")
def manual_stripe_sync(
    days_back: int = 3650,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    from app.tasks.reconciliation import reconcile_stripe

    result = reconcile_stripe(db, days_back=days_back)
    _log(db, user.get("sub"), "stripe_manual_sync", result)
    return result

@router.post("/backfill")
def run_historical_backfill(
    data: dict,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    """
    One-shot historical import. Body: {"since": "2026-02-01", "dry_run": true|false,
    "skip_stripe": false, "skip_hubspot": false}.
    Idempotent — safe to re-run; uses the same dedup gate as the webhooks.
    NOTE: runs synchronously and can take a few minutes for large windows;
    prefer the CLI (python -m app.tasks.backfill) for very large imports.
    """
    from datetime import datetime as _dt
    from app.tasks.backfill import run_backfill
    try:
        since = _dt.strptime(data.get("since", ""), "%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=422, detail="since must be YYYY-MM-DD")
    result = run_backfill(
        db, since,
        dry_run=bool(data.get("dry_run", False)),
        skip_stripe=bool(data.get("skip_stripe", False)),
        skip_hubspot=bool(data.get("skip_hubspot", False)),
    )
    _log(db, user.get("sub"), "backfill", result)
    return result


@router.get("/status")
def integration_status(db: Session = Depends(get_db), _=Dep):
    from app.models.members import Transaction
    from app.models.b2b import B2BDeal
    stripe_last = db.query(Transaction).filter(Transaction.processor == "stripe").order_by(Transaction.created_at.desc()).first()
    tap_last = db.query(Transaction).filter(Transaction.processor == "tap").order_by(Transaction.created_at.desc()).first()
    hs_last = db.query(B2BDeal).order_by(B2BDeal.synced_at.desc()).first()

    return {
        "stripe": {"last_event": stripe_last.created_at.isoformat() if stripe_last else None, "configured": bool(settings.stripe_api_key)},
        "tap": {"last_event": tap_last.created_at.isoformat() if tap_last else None, "configured": bool(settings.tap_api_key)},
        "hubspot": {"last_sync": hs_last.synced_at.isoformat() if hs_last else None, "configured": bool(settings.hubspot_api_key)},
        "zoho": {"sync_enabled": settings.zoho_sync_enabled, "configured": bool(settings.zoho_refresh_token)},
        "slack": {"configured": bool(settings.slack_bot_token)},
        "drive": {"configured": bool(settings.google_drive_credentials_path)},
        "email": {"configured": bool(settings.zoho_smtp_password)},
    }


@router.get("/audit")
def audit_log(
    limit: int = 50,
    db: Session = Depends(get_db),
    _=Dep,
):
    rows = db.query(AuditLog).order_by(AuditLog.timestamp.desc()).limit(limit).all()
    return [{"timestamp": r.timestamp.isoformat(), "user": r.user, "action": r.action, "details": r.details} for r in rows]


def _log(db: Session, user: Optional[str], action: str, details):
    import json
    db.add(AuditLog(user=user, action=action, details=json.dumps(details) if not isinstance(details, str) else details))
