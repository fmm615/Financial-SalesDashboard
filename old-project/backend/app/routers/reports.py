from __future__ import annotations
import threading
from datetime import date, datetime
from pathlib import Path
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session
from app.auth import get_current_user
from app.database import get_db
from app.models.reports import Report

router = APIRouter(prefix="/api/reports", tags=["reports"])
Dep = Depends(get_current_user)


class AdhocRequest(BaseModel):
    period_start: date
    period_end: date
    period_label: Optional[str] = None
    send_email: bool = False


@router.get("")
def list_reports(
    report_type: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    _=Dep,
):
    q = db.query(Report)
    if report_type:
        q = q.filter(Report.report_type == report_type)
    if status:
        q = q.filter(Report.status == status)
    items = q.order_by(Report.created_at.desc()).offset(offset).limit(limit).all()
    return [_to_dict(r) for r in items]


@router.post("", status_code=202)
def generate_adhoc(
    body: AdhocRequest,
    db: Session = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    if body.period_start > body.period_end:
        raise HTTPException(400, "period_start must be before period_end")
    label = body.period_label or f"{body.period_start:%b %d} – {body.period_end:%b %d, %Y}"
    username = user.get("sub", "admin")
    report = _create_and_launch(db, "adhoc", label, body.period_start, body.period_end, body.send_email, username)
    return _to_dict(report)


@router.get("/{report_id}")
def get_report(report_id: str, db: Session = Depends(get_db), _=Dep):
    r = db.query(Report).filter(Report.id == report_id).first()
    if not r:
        raise HTTPException(404, "Report not found")
    return _to_dict(r)


@router.get("/{report_id}/download/pdf")
def download_pdf(report_id: str, db: Session = Depends(get_db), _=Dep):
    r = db.query(Report).filter(Report.id == report_id).first()
    if not r:
        raise HTTPException(404)
    if r.status != "done":
        raise HTTPException(409, f"Not ready: {r.status}")
if not r.pdf_path or not Path(r.pdf_path).exists():
    raise HTTPException(404, "PDF file not on disk")

pdf_file = Path(r.pdf_path)

print("PDF PATH:", pdf_file)
print("PDF EXISTS:", pdf_file.exists())
print("PDF SIZE:", pdf_file.stat().st_size)

return FileResponse(
    pdf_file,
    media_type="application/pdf",
    filename=pdf_file.name
)


@router.get("/{report_id}/download/zip")
def download_zip(report_id: str, db: Session = Depends(get_db), _=Dep):
    r = db.query(Report).filter(Report.id == report_id).first()
    if not r:
        raise HTTPException(404)
    if r.status != "done":
        raise HTTPException(409, f"Not ready: {r.status}")
    if not r.zip_path or not Path(r.zip_path).exists():
        raise HTTPException(404, "ZIP file not on disk")
    return FileResponse(r.zip_path, media_type="application/zip", filename=Path(r.zip_path).name)


@router.delete("/{report_id}", status_code=204)
def delete_report(report_id: str, db: Session = Depends(get_db), _=Dep):
    r = db.query(Report).filter(Report.id == report_id).first()
    if not r:
        raise HTTPException(404)
    if r.status == "generating":
        raise HTTPException(409, "Cannot delete while generating")
    for attr in ("pdf_path", "zip_path"):
        p = getattr(r, attr, None)
        if p and Path(p).exists():
            Path(p).unlink(missing_ok=True)
    db.delete(r)
    db.commit()


def _create_and_launch(db, report_type, label, period_start, period_end, send_email, generated_by) -> Report:
    import uuid
    report = Report(
        id=str(uuid.uuid4()),
        report_type=report_type,
        period_label=label,
        period_start=period_start,
        period_end=period_end,
        generated_by=generated_by,
        status="pending",
    )
    db.add(report)
    db.commit()
    db.refresh(report)
    t = threading.Thread(
        target=_run_generation,
        args=(report.id, send_email),
        daemon=True,
    )
    t.start()
    return report


def _run_generation(report_id: str, send_email: bool):
    from app.database import SessionLocal
    from reports.generator import generate_report
    db = SessionLocal()
    try:
        generate_report(report_id, send_email=send_email, db=db)
    except Exception as e:
        import logging
        logging.getLogger(__name__).exception("Report %s generation failed", report_id)
        try:
            r = db.query(Report).filter(Report.id == report_id).first()
            if r:
                r.status = "failed"
                r.error_message = str(e)[:2000]
                db.commit()
        except Exception:
            db.rollback()
    finally:
        db.close()


def _to_dict(r: Report) -> dict:
    return {
        "id": r.id,
        "report_type": r.report_type,
        "period_label": r.period_label,
        "period_start": r.period_start.isoformat(),
        "period_end": r.period_end.isoformat(),
        "status": r.status,
        "error_message": r.error_message,
        "has_pdf": bool(r.pdf_path and Path(r.pdf_path).exists()),
        "has_zip": bool(r.zip_path and Path(r.zip_path).exists()),
        "drive_pdf_url": r.drive_pdf_url,
        "drive_zip_url": r.drive_zip_url,
        "email_sent": r.email_sent,
        "email_sent_at": r.email_sent_at.isoformat() if r.email_sent_at else None,
        "generated_by": r.generated_by,
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "completed_at": r.completed_at.isoformat() if r.completed_at else None,
    }
