"""依赖项：数据库会话与当前登录账号（权限在服务端判定，01 文档第 7 节）。"""
from datetime import datetime, timezone

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.orm import Session as DBSession

from .db import get_db
from .models import Account, AuthSession
from .security import SESSION_COOKIE, token_digest


def get_current_account(
    request: Request, db: DBSession = Depends(get_db)
) -> Account | None:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        return None
    session = db.get(AuthSession, token_digest(token))
    if session is None:
        return None
    if session.expires_at.replace(tzinfo=timezone.utc) < datetime.now(timezone.utc):
        db.delete(session)
        db.commit()
        return None
    return db.get(Account, session.account_id)


def require_account(account: Account | None = Depends(get_current_account)) -> Account:
    if account is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "auth_required", "message": "请先登录"},
        )
    return account


def require_role(*roles: str):
    """权限一律服务端判定（01 文档第 7 节）；roles 取 models.account.ROLES 子集。"""

    def dep(account: Account = Depends(require_account)) -> Account:
        if account.role not in roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={"code": "forbidden", "message": "权限不足"},
            )
        return account

    return dep


require_staff = require_role("admin", "superadmin")
require_superadmin = require_role("superadmin")
