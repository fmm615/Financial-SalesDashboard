from __future__ import annotations
import uuid
from datetime import datetime
from sqlalchemy import Boolean, Column, Date, DateTime, String, Text
from app.database import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.utcnow()


class Report(Base):
    __tablename__ = "reports"

    id = Column(String, primary_key=True, default=_uuid)
    report_type = Column(String, nullable=False, index=True)  # monthly | quarterly | yearly | adhoc
    period_label = Column(String, nullable=False)
    period_start = Column(Date, nullable=False)
    period_end = Column(Date, nullable=False)
    status = Column(String, nullable=False, default="pending")  # pending | generating | done | failed
    error_message = Column(Text, nullable=True)
    pdf_path = Column(String, nullable=True)
    zip_path = Column(String, nullable=True)
    drive_pdf_id = Column(String, nullable=True)
    drive_zip_id = Column(String, nullable=True)
    drive_pdf_url = Column(String, nullable=True)
    drive_zip_url = Column(String, nullable=True)
    email_sent = Column(Boolean, default=False)
    email_sent_at = Column(DateTime, nullable=True)
    generated_by = Column(String, nullable=True)
    created_at = Column(DateTime, default=_now)
    completed_at = Column(DateTime, nullable=True)
