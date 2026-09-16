"""管理员路由：超级管理员管理账号角色（ADR-002、ADR-009）。

权限矩阵：
- 访客（未登录）：只读
- member：论坛读写自己的内容
- admin：论坛内容审核（可删任何帖子/回复）
- superadmin：admin 的全部能力 + 站点配置 + 账号管理（/admin/users/ 那一页的后端）
"""
from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session as DBSession

from ..db import get_db
from ..deps import require_superadmin
from ..models import Account, ROLES
from ..schemas import AccountSummary, RoleToggle, RoleUpdate

router = APIRouter(prefix="/api/admin", tags=["admin"])

# 用户名搜索的匹配串。`username_key` 在注册时就已转小写，而 SQLite 的 `lower()`
# 只处理 ASCII——中文没有大小写，不受影响，所以统一在服务端补 `_` / `%` 的转义后
# 直接对它做 LIKE。转义掉这两个通配符是必须的：否则搜 `_` 会匹配到所有账号。
LIKE_ESCAPE = "\\"


def _like_pattern(username: str) -> str:
    escaped = (username.strip().lower()
               .replace(LIKE_ESCAPE, LIKE_ESCAPE * 2)
               .replace("%", f"{LIKE_ESCAPE}%")
               .replace("_", f"{LIKE_ESCAPE}_"))
    return f"%{escaped}%"


def _writable_target(db: DBSession, account_id: int, operator: Account,
                     *, allow_superadmin: bool = False) -> Account:
    """取出可改角色的目标账号；自己不能改自己，超管档位默认不接受改动。

    为什么连「改自己」也拦：超管把自己降成 member 之后，场上就没有人
    能再把人提回来了（邀请码只在**注册**时生效）——这是不可自助恢复的死局。
    两条改角色的路径（admin 开关与 role 接口）共用这一段，避免其中一条漏判。

    `allow_superadmin=False`（默认）时，`/admin` 那个「给不给管理员」的开关
    碰到超管账号会直接拒绝，而不是把它降成 member——超管本来就拥有管理员的全部
    能力，把这一档降下来是纯粹的权限损失，只可能来自误操作。真的要调整超管档位
    走 `/role` 接口（`allow_superadmin=True`），那里有「最后一个超管」的第二层兜底。
    """
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
    if target.role == "superadmin" and not allow_superadmin:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "is_superadmin",
                    "message": "超级管理员的管理员身份不能在这里取消；"
                               "超管档位只能由引导规则或注册邀请码产生"},
        )
    return target


def _superadmin_count(db: DBSession) -> int:
    return db.scalar(
        select(func.count(Account.id)).where(Account.role == "superadmin")
    ) or 0


@router.get("/accounts", response_model=list[AccountSummary])
def list_accounts(q: str | None = Query(default=None, max_length=64),
                  db: DBSession = Depends(get_db),
                  _: Account = Depends(require_superadmin)) -> list[AccountSummary]:
    """账号列表，可选按用户名模糊搜索（`q`，大小写不敏感的子串匹配）。

    搜索放在服务端而不是前端过滤：这一页是**管理**界面，账号数会随时间增长，
    而「搜不到」在管理场景下是错误结论（以为这个人不存在）。用 SQL 过滤，
    前端拿到的永远是与搜索词匹配的那一批，不依赖已加载的那一页。

    不传 `q` 时仍然按 id 升序返回全部——注册最早的账号排在最前，
    也就是超管自己（引导规则，ADR-002）在最上面。

    `max_length` 给得比用户名上限宽：搜索词比任何用户名都长时结果自然为空，
    那是个正常结果，不该回一个 422 让使用者去猜自己做错了什么。
    """
    stmt = select(Account)
    if q is not None:
        stmt = stmt.where(
            Account.username_key.like(_like_pattern(q), escape=LIKE_ESCAPE)
        )
    rows = db.scalars(stmt.order_by(Account.id)).all()
    return [AccountSummary(id=a.id, username=a.username, role=a.role,
                           created_at=a.created_at) for a in rows]


@router.put("/accounts/{account_id}/admin", response_model=AccountSummary)
def toggle_admin(account_id: int, payload: RoleToggle,
                 db: DBSession = Depends(get_db),
                 operator: Account = Depends(require_superadmin)) -> AccountSummary:
    """授予 / 收回管理员（admin ↔ member）。

    单独开一个接口而不是让前端去调 `role` 那个：`role` 接口按契约收任何角色，
    一个只该「开关管理员」的界面不该顺手拥有把别人提成超管的能力。
    超管档位只由引导规则与邀请码产生（ADR-002）。
    """
    target = _writable_target(db, account_id, operator)
    target.role = "admin" if payload.enabled else "member"
    db.commit()
    return AccountSummary(id=target.id, username=target.username,
                          role=target.role, created_at=target.created_at)


@router.put("/accounts/{account_id}/role", response_model=AccountSummary)
def update_role(account_id: int, payload: RoleUpdate,
                db: DBSession = Depends(get_db),
                operator: Account = Depends(require_superadmin)) -> AccountSummary:
    if payload.role not in ROLES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "bad_role", "message": "未知角色"},
        )
    target = _writable_target(db, account_id, operator, allow_superadmin=True)
    if (target.role == "superadmin" and payload.role != "superadmin"
            and _superadmin_count(db) <= 1):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "last_superadmin",
                    "message": "这是最后一个超级管理员；降级后将没有人能管理站点"},
        )
    target.role = payload.role
    db.commit()
    return AccountSummary(id=target.id, username=target.username,
                          role=target.role, created_at=target.created_at)
