from __future__ import annotations
import logging
import smtplib
import ssl
from email.mime.application import MIMEApplication
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path
from typing import Optional
from app.config import settings

logger = logging.getLogger(__name__)


def send_report_email(
    period_label: str,
    report_type: str,
    summary_bullets: list[str],
    pdf_path: Optional[str] = None,
    zip_path: Optional[str] = None,
    pdf_url: Optional[str] = None,
    zip_url: Optional[str] = None,
) -> bool:
    use_resend = settings.email_provider.strip().lower() == "resend"

    if use_resend and not settings.resend_api_key:
        logger.error("EMAIL_PROVIDER=resend but RESEND_API_KEY is not set — skipping email.")
        return False
    if not use_resend and not settings.smtp_password:
        logger.warning("Email not configured (set SMTP_PASSWORD/GMAIL_SMTP_*/ZOHO_SMTP_* vars) — skipping email.")
        return False

    type_label = {"monthly": "Monthly Report", "quarterly": "Quarterly Report", "yearly": "Annual Report", "adhoc": "Ad-hoc Report"}.get(report_type, "Report")
    subject = f"PLAYBOOK {type_label}: {period_label}"
    to_addr = settings.report_primary_recipient
    cc_addrs = settings.report_cc_list

    msg = MIMEMultipart("mixed")
    msg["Subject"] = subject
    msg["From"] = settings.smtp_user
    msg["To"] = to_addr
    if cc_addrs:
        msg["Cc"] = ", ".join(cc_addrs)

    bullets_html = "".join(f"<li>{b}</li>" for b in summary_bullets)
    drive_links = ""
    if pdf_url:
        drive_links += f'<a href="{pdf_url}" style="color:#2A004C;">View PDF on Drive</a>'
    if zip_url:
        sep = " &nbsp;|&nbsp; " if pdf_url else ""
        drive_links += f'{sep}<a href="{zip_url}" style="color:#2A004C;">Download CSV ZIP</a>'

    html = f"""<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;color:#1a1a1a;max-width:640px;margin:0 auto;padding:24px;">
<div style="background:#2A004C;padding:24px 32px;border-radius:8px 8px 0 0;">
  <span style="font-size:24px;font-weight:bold;color:#C8FF00;letter-spacing:0.08em;">PLAYBOOK</span>
</div>
<div style="border:1px solid #e0e0e0;border-top:none;padding:32px;border-radius:0 0 8px 8px;">
  <h2 style="color:#2A004C;margin-top:0;">{type_label}: {period_label}</h2>
  <h3 style="color:#2A004C;font-size:15px;">Highlights</h3>
  <ul style="color:#333;font-size:14px;line-height:1.7;">{bullets_html}</ul>
  {"<p>" + drive_links + "</p>" if drive_links else ""}
  <hr style="border:none;border-top:1px solid #eee;margin:32px 0;">
  <p style="color:#999;font-size:11px;">{settings.report_footer_text}</p>
</div></body></html>"""

    alt = MIMEMultipart("alternative")
    alt.attach(MIMEText(html, "html", "utf-8"))
    msg.attach(alt)

    for path, subtype in [(pdf_path, "pdf"), (zip_path, "zip")]:
        if path and Path(path).exists():
            with open(path, "rb") as f:
                part = MIMEApplication(f.read(), _subtype=subtype)
            part.add_header("Content-Disposition", "attachment", filename=Path(path).name)
            msg.attach(part)

    # ── Resend HTTP API — only when explicitly enabled via EMAIL_PROVIDER=resend
    if use_resend:
        return _send_via_resend(subject, html, to_addr, cc_addrs, pdf_path, zip_path, period_label)

    # ── Default: plain SMTP
    try:
        ctx = ssl.create_default_context()
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port) as s:
            s.ehlo(); s.starttls(context=ctx); s.login(settings.smtp_user, settings.smtp_password)
            s.sendmail(settings.smtp_user, [to_addr] + cc_addrs, msg.as_bytes())
        logger.info("Report email sent for '%s'", period_label)
        return True
    except Exception as e:
        logger.error("Report email failed: %s", e)
        return False


def _send_via_resend(
    subject: str,
    html: str,
    to_addr: str,
    cc_addrs: list[str],
    pdf_path: Optional[str],
    zip_path: Optional[str],
    period_label: str,
) -> bool:
    import base64
    import httpx

    from_addr = settings.report_from_address or settings.smtp_user
    if not from_addr:
        logger.error("Resend configured but no sender address: set REPORT_FROM_ADDRESS")
        return False

    attachments = []
    for p in (pdf_path, zip_path):
        if p and Path(p).exists():
            attachments.append({
                "filename": Path(p).name,
                "content": base64.b64encode(Path(p).read_bytes()).decode(),
            })

    payload = {
        "from": f"PLAYBOOK Reports <{from_addr}>",
        "to": [to_addr],
        "subject": subject,
        "html": html,
    }
    if cc_addrs:
        payload["cc"] = cc_addrs
    if attachments:
        payload["attachments"] = attachments

    try:
        r = httpx.post(
            "https://api.resend.com/emails",
            json=payload,
            headers={"Authorization": f"Bearer {settings.resend_api_key}"},
            timeout=30,
        )
        if r.status_code in (200, 201):
            logger.info("Report email sent via Resend for '%s' (id=%s)", period_label, r.json().get("id"))
            return True
        logger.error("Resend send failed (%s): %s", r.status_code, r.text[:500])
        return False
    except Exception as e:
        logger.error("Resend send failed: %s", e)
        return False