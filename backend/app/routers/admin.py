"""管理员路由：超级管理员管理账号角色（ADR-002）。

权限矩阵：
- 访客（未登录）：只读
- member：论坛读写自己的内容
- admin：论坛内容审核（可删任何帖子/回复）
- superadmin：admin 的全部能力 + 站点配置 + 角色管理
"""
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session as DBSession

from ..db import get_db
from ..deps import require_superadmin
from ..models import Account, ROLES
from ..schemas import AccountSummary, RoleUpdate

router = APIRouter(prefix="/api/admin", tags=["admin"])


@router.get("/accounts", response_model=list[AccountSummary])
def list_accounts(db: DBSession = Depends(get_db),
                  _: Account = Depends(require_superadmin)) -> list[AccountSummary]:
    rows = db.scalars(select(Account).order_by(Account.id)).all()
    return [AccountSummary(id=a.id, username=a.username, role=a.role,
                           created_at=a.created_at) for a in rows]


@router.put("/accounts/{account_id}/role", response_model=AccountSummary)
def update_role(account_id: int, payload: RoleUpdate,
                db: DBSession = Depends(get_db),
                operator: Account = Depends(require_superadmin)) -> AccountSummary:
    if payload.role not in ROLES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "bad_role", "message": "未知角色"},
        )
    if account_id == operator.id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "self_role_change", "message": "不能修改自己的角色"},
        )
    target = db.get(Account, account_id)
    if target is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "account_not_found", "message": "账号不存在"},
        )
    target.role = payload.role
    db.commit()
    return AccountSummary(id=target.id, username=target.username,
                          role=target.role, created_at=target.created_at)
