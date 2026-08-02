from __future__ import annotations
from datetime import timedelta
from fastapi import APIRouter, Depends, HTTPException, Response, status
from fastapi.security import OAuth2PasswordRequestForm
from app.auth import authenticate_user, create_access_token, get_current_user
from app.config import settings

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/token")
def login(response: Response, form: OAuth2PasswordRequestForm = Depends()):
    if not authenticate_user(form.username, form.password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    token = create_access_token(
        {"sub": form.username},
        expires_delta=timedelta(minutes=settings.access_token_expire_minutes),
    )
    response.set_cookie("access_token", token, httponly=True, samesite="lax", max_age=settings.access_token_expire_minutes * 60)
    return {"access_token": token, "token_type": "bearer"}


@router.post("/logout")
def logout(response: Response):
    response.delete_cookie("access_token")
    return {"status": "ok"}


@router.get("/me")
def me(user: dict = Depends(get_current_user)):
    return {"username": user.get("sub")}
