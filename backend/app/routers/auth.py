"""账号路由：注册 / 登录 / 登出 / 当前用户。"""
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session as DBSession

from ..config import PASSWORD_MIN, get_settings
from ..db import get_db
from ..deps import get_current_account
from ..models import Account, AuthSession
from ..schemas import AccountCreate, AccountSummary, LoginRequest
from ..security import (
    SESSION_COOKIE,
    hash_password,
    new_session_token,
    session_expiry,
    token_digest,
    verify_password,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _set_session_cookie(response: Response, db: DBSession, account_id: int) -> None:
    token = new_session_token()
    settings = get_settings()
    db.add(AuthSession(token_hash=token_digest(token), account_id=account_id,
                       expires_at=session_expiry()))
    db.commit()
    response.set_cookie(
        SESSION_COOKIE,
        token,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        max_age=settings.session_days * 24 * 3600,
        path="/",
    )


@router.post("/register", response_model=AccountSummary,
             status_code=status.HTTP_201_CREATED)
def register(payload: AccountCreate, response: Response,
             db: DBSession = Depends(get_db)) -> AccountSummary:
    key = payload.username.lower()
    exists = db.scalar(select(Account).where(Account.username_key == key))
    if exists:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "username_taken", "message": "这个用户名已经被注册了"},
        )
    account = Account(
        username=payload.username,
        username_key=key,
        password_hash=hash_password(payload.password),
    )
    db.add(account)
    db.flush()
    _set_session_cookie(response, db, account.id)
    return AccountSummary(id=account.id, username=account.username,
                          created_at=account.created_at)


@router.post("/login", response_model=AccountSummary)
def login(payload: LoginRequest, response: Response,
          db: DBSession = Depends(get_db)) -> AccountSummary:
    key = payload.username.strip().lower()
    account = db.scalar(select(Account).where(Account.username_key == key))
    # 密码长度下限以下直接判定失败，避免对短输入做无谓哈希
    if (account is None or len(payload.password) < PASSWORD_MIN
            or not verify_password(account.password_hash, payload.password)):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "bad_credentials", "message": "用户名或密码不正确"},
        )
    _set_session_cookie(response, db, account.id)
    return AccountSummary(id=account.id, username=account.username,
                          created_at=account.created_at)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(request: Request, response: Response,
           db: DBSession = Depends(get_db)) -> None:
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        session = db.get(AuthSession, token_digest(token))
        if session:
            db.delete(session)
            db.commit()
    response.delete_cookie(SESSION_COOKIE, path="/")


@router.get("/me", response_model=AccountSummary | None)
def me(account: Account | None = Depends(get_current_account)) -> AccountSummary | None:
    if account is None:
        return None
    return AccountSummary(id=account.id, username=account.username,
                          created_at=account.created_at)
