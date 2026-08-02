from __future__ import annotations
from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings
from typing import Optional
import pytz


class Settings(BaseSettings):
    # App
    secret_key: str = "dev-secret-change-me"
    database_url: str = "sqlite:///./playbook_fos.db"
    timezone: str = "Asia/Bahrain"
    debug: bool = False
    cors_origins_str: str = "http://localhost:5173,http://localhost:3000"

    @property
    def cors_origins(self) -> list[str]:
        return [o.strip() for o in self.cors_origins_str.split(",") if o.strip()]

    # Auth
    admin_username: str = "admin@get-playbook.com"
    admin_password: str = "changeme"
    access_token_expire_minutes: int = 480

    # Stripe
    stripe_api_key: str = ""
    stripe_webhook_secret: str = ""

    # Tap
    tap_api_key: str = ""
    tap_webhook_secret: str = ""
    tap_public_key: str = ""

    # HubSpot
    hubspot_api_key: str = ""
    hubspot_portal_id: str = ""
    hubspot_prop_deal_type: str = "deal_type"
    hubspot_prop_source: str = "deal_source"
    hubspot_prop_contract_end_date: str = "contract_end_date"
    hubspot_webhook_secret: str = ""
    hubspot_deal_stages: str = "prospecting,qualification,proposal,negotiation,closedwon,closedlost"

    # Zoho Books (Phase 2)
    zoho_client_id: str = ""
    zoho_client_secret: str = ""
    zoho_refresh_token: str = ""
    zoho_org_id: str = ""
    zoho_sync_enabled: bool = False

    # Slack
    slack_bot_token: str = ""
    slack_signing_secret: str = ""
    slack_summit_channel_id: str = ""  # channel ID (C0123...) — events are only processed from this channel
    slack_daily_channel: str = "#development"
    slack_members_channel: str = "#development"
    slack_alerts_channel: str = "#development"
    slack_summit_channel: str = "#development"

    # Which method to send report emails with: "smtp" (default) or "resend".
    # This is the ONLY thing that decides the send path — a RESEND_API_KEY
    # being present is no longer enough to switch to Resend on its own.
    email_provider: str = "smtp"

    # Resend (HTTP email API) — only used when EMAIL_PROVIDER=resend.
    resend_api_key: str = ""
    report_from_address: str = ""  # verified sender for Resend; falls back to smtp_user

    # SMTP (accepts SMTP_*, GMAIL_SMTP_*, or ZOHO_SMTP_* env names)
    smtp_host: str = Field(
        "smtp.gmail.com",
        validation_alias=AliasChoices("SMTP_HOST", "GMAIL_SMTP_HOST", "ZOHO_SMTP_HOST"),
    )
    smtp_port: int = Field(
        587, validation_alias=AliasChoices("SMTP_PORT", "GMAIL_SMTP_PORT", "ZOHO_SMTP_PORT")
    )
    smtp_user: str = Field(
        "", validation_alias=AliasChoices("SMTP_USER", "GMAIL_SMTP_USER", "ZOHO_SMTP_USER")
    )
    smtp_password: str = Field(
        "", validation_alias=AliasChoices("SMTP_PASSWORD", "GMAIL_SMTP_PASSWORD", "ZOHO_SMTP_PASSWORD")
    )
    report_primary_recipient: str = "accounts@get-playbook.com"
    report_cc_recipients: str = "wafa@get-playbook.com,nada@get-playbook.com,shreya@get-playbook.com"

    # Google Drive — either the service-account JSON *content* (preferred on
    # Railway/containers) or a path to a JSON file on disk
    google_drive_credentials: str = ""
    google_drive_credentials_path: str = ""
    google_drive_root_folder_id: str = ""

    # Reports
    generated_reports_dir: str = "generated_reports"
    report_autodelivery_enabled: bool = False
    report_footer_text: str = "Confidential — PLAYBOOK Internal"

    # FY 2026 Targets
    target_fy_revenue: float = 980_000
    target_fy_b2b: float = 620_000
    target_fy_b2c: float = 180_000
    target_fy_other: float = 180_000
    target_q1_revenue: float = 185_827
    target_q2_revenue: float = 215_000
    target_q3_revenue: float = 255_000
    target_q4_revenue: float = 324_173
    target_b2c_members_daily: float = 3.0

    # B2C
    b2c_vat_rate: float = 0.10
    b2c_anomaly_drop_pct: float = 30.0
    b2c_member_daily_target: float = 3.0

    # B2B
    b2b_anomaly_pipeline_drop_pct: float = 15.0
    b2b_stuck_deal_days: int = 45
    b2b_critical_lost_threshold: float = 100_000

    # Financial
    cash_runway_warn_months: float = 12.0
    cash_runway_critical_months: float = 6.0
    burn_spike_pct: float = 20.0

    # Currency — Zoho Books runs in BHD; the dashboard reports USD.
    # BHD is pegged to USD (1 BHD = 2.6596 USD, fixed since 2001).
    bhd_usd_rate: float = 2.6595745
    # AED is pegged to USD (1 USD = 3.6725 AED, fixed since 1997) — Stripe charges in AED
    aed_usd_rate: float = 0.2722941
    # GBP FLOATS (no peg). This is an approximation for converting the small
    # number of historical GBP charges — override GBP_USD_RATE with the
    # average rate for the period if precision matters.
    gbp_usd_rate: float = 1.34

    # Summit
    summit_date: str = "2026-09-28"
    summit_total_cost_target: float = 255_553
    summit_ticket_target: int = 200
    summit_judge_target: int = 10
    summit_mou_target: int = 5
    summit_booth_target: int = 10

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"

    @property
    def tz(self):
        return pytz.timezone(self.timezone)

    @property
    def hubspot_stage_list(self) -> list[str]:
        return [s.strip() for s in self.hubspot_deal_stages.split(",")]

    @property
    def report_cc_list(self) -> list[str]:
        return [e.strip() for e in self.report_cc_recipients.split(",") if e.strip()]

    @property
    def quarterly_targets(self) -> dict[str, float]:
        return {
            "Q1": self.target_q1_revenue,
            "Q2": self.target_q2_revenue,
            "Q3": self.target_q3_revenue,
            "Q4": self.target_q4_revenue,
        }


settings = Settings()