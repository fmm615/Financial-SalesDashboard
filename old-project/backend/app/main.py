from __future__ import annotations
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pathlib import Path

from app.config import settings
from app.database import init_db

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Start-up
    
    # ── Security guard: never run with the known default secret ──────────────
    if settings.secret_key == "dev-secret-change-me":
        import secrets as _secrets
        settings.secret_key = _secrets.token_hex(32)
        logger.critical(
            "SECRET_KEY env var not set — generated an ephemeral secret for this "
            "process. Tokens will invalidate on every restart. Set SECRET_KEY in "
            "the environment to fix this."
        )
    if settings.admin_password in ("changeme", "change-me"):
        logger.critical(
            "ADMIN_PASSWORD is still the default value — anyone can log in. "
            "Set ADMIN_PASSWORD in the environment immediately."
        )

    init_db()
    logger.info("Database initialised")

    from app.tasks.scheduler import start_scheduler
    start_scheduler()

    yield

    # Shut-down
    from app.tasks.scheduler import stop_scheduler
    stop_scheduler()


app = FastAPI(
    title="PLAYBOOK FOS",
    description="Financial Operating System — API",
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
)

# ─── CORS ─────────────────────────────────────────────────────────────────────
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── Routers ──────────────────────────────────────────────────────────────────
from app.routers import auth, webhooks, b2c, b2b, financial, cockpit, reports, admin

app.include_router(auth.router)
app.include_router(webhooks.router)
app.include_router(b2c.router)
app.include_router(b2b.router)
app.include_router(financial.router)
app.include_router(cockpit.router)
app.include_router(reports.router)
app.include_router(admin.router)

# ─── Health check ─────────────────────────────────────────────────────────────
@app.get("/health", tags=["health"])
def health():
    return {"status": "ok"}


# ─── Static files (if serving frontend from here) ─────────────────────────────
_static_dir = Path(__file__).parent.parent.parent / "frontend" / "dist"
if _static_dir.exists():
    app.mount("/", StaticFiles(directory=str(_static_dir), html=True), name="frontend")
else:
    @app.get("/")
    def root():
        return {"service": "PLAYBOOK FOS API", "docs": "/api/docs"}