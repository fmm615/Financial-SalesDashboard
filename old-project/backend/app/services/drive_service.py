from __future__ import annotations
import io
import logging
from pathlib import Path
from typing import Optional
from app.config import settings

logger = logging.getLogger(__name__)

_folder_cache: dict[str, str] = {}


def _build_service():
    import json
    from google.oauth2.service_account import Credentials
    from googleapiclient.discovery import build

    scopes = ["https://www.googleapis.com/auth/drive"]

    # Preferred on Railway: the service-account JSON provided directly in the
    # GOOGLE_DRIVE_CREDENTIALS env var (no file on disk needed)
    if settings.google_drive_credentials:
        try:
            info = json.loads(settings.google_drive_credentials)
        except json.JSONDecodeError as e:
            raise RuntimeError(f"GOOGLE_DRIVE_CREDENTIALS is not valid JSON: {e}")
        creds = Credentials.from_service_account_info(info, scopes=scopes)
        return build("drive", "v3", credentials=creds, cache_discovery=False)

    creds_path = settings.google_drive_credentials_path
    if not creds_path or not Path(creds_path).exists():
        raise RuntimeError(
            "Google Drive not configured: set GOOGLE_DRIVE_CREDENTIALS (JSON content) "
            "or GOOGLE_DRIVE_CREDENTIALS_PATH (file path)"
        )
    creds = Credentials.from_service_account_file(creds_path, scopes=scopes)
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def _ensure_folder(service, name: str, parent_id: Optional[str] = None) -> str:
    cache_key = f"{parent_id}/{name}"
    if cache_key in _folder_cache:
        return _folder_cache[cache_key]

    q = f"mimeType='application/vnd.google-apps.folder' and name='{name}' and trashed=false"
    if parent_id:
        q += f" and '{parent_id}' in parents"
    results = service.files().list(
        q=q, fields="files(id,name)", pageSize=1,
        supportsAllDrives=True, includeItemsFromAllDrives=True,
    ).execute()
    items = results.get("files", [])
    if items:
        fid = items[0]["id"]
    else:
        meta = {"name": name, "mimeType": "application/vnd.google-apps.folder"}
        if parent_id:
            meta["parents"] = [parent_id]
        f = service.files().create(body=meta, fields="id", supportsAllDrives=True).execute()
        fid = f["id"]

    _folder_cache[cache_key] = fid
    return fid


def upload_report(
    pdf_path: Optional[str] = None,
    zip_path: Optional[str] = None,
    report_type: str = "adhoc",
    year: int = 2026,
) -> dict:
    if not settings.google_drive_credentials and not settings.google_drive_credentials_path:
        logger.warning("Drive not configured — skipping upload.")
        return {"pdf_url": None, "zip_url": None}

    try:
        from googleapiclient.http import MediaFileUpload
        service = _build_service()

        # Anchor everything under GOOGLE_DRIVE_ROOT_FOLDER_ID — required in
        # practice, since service accounts have no storage of their own:
        # point it at a Shared Drive (or a folder inside one).
        root = _ensure_folder(service, "PLAYBOOK", settings.google_drive_root_folder_id or None)
        reports_root = _ensure_folder(service, "Reports", root)
        year_folder = _ensure_folder(service, str(year), reports_root)
        type_map = {"monthly": "Monthly", "quarterly": "Quarterly", "yearly": "Annual", "adhoc": "Ad-hoc"}
        type_folder = _ensure_folder(service, type_map.get(report_type, "Other"), year_folder)

        def _upload(local_path: str, mime: str) -> Optional[str]:
            if not local_path or not Path(local_path).exists():
                return None
            media = MediaFileUpload(local_path, mimetype=mime, resumable=False)
            f = service.files().create(
                body={"name": Path(local_path).name, "parents": [type_folder]},
                media_body=media,
                fields="id,webViewLink",
                supportsAllDrives=True,
            ).execute()
            try:
                service.permissions().create(
                    fileId=f["id"],
                    body={"type": "anyone", "role": "reader"},
                    supportsAllDrives=True,
                ).execute()
            except Exception as pe:
                # Shared-drive admin policy may forbid link-sharing; members
                # of the drive can still open the file.
                logger.warning("Could not set link-sharing on %s: %s", f.get("id"), pe)
            return f.get("webViewLink")

        pdf_url = _upload(pdf_path, "application/pdf") if pdf_path else None
        zip_url = _upload(zip_path, "application/zip") if zip_path else None

        return {"pdf_url": pdf_url, "zip_url": zip_url}
    except Exception as e:
        logger.error("Drive upload failed: %s", e)
        return {"pdf_url": None, "zip_url": None}
