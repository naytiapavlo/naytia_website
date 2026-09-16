"""工具箱收藏：按账号隔离（01 文档第 6 节）。

tool_id 的合法集合由前端工具注册表定义（src/modules/toolbox/registry.ts）；
服务端先按 slug 格式把关，上线时再与注册表快照比对。
"""
import re

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session as DBSession

from ..db import get_db
from ..deps import require_account
from ..models import Account, ToolFavorite
from ..schemas import FavoriteList

router = APIRouter(prefix="/api/favorites", tags=["favorites"])

_TOOL_ID_RE = re.compile(r"^[a-z0-9-]{1,64}$")


def _validate_tool_id(tool_id: str) -> None:
    if not _TOOL_ID_RE.fullmatch(tool_id):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "bad_tool_id", "message": "工具 ID 格式不合法"},
        )


@router.get("", response_model=FavoriteList)
def list_favorites(db: DBSession = Depends(get_db),
                   account: Account = Depends(require_account)) -> FavoriteList:
    rows = db.scalars(
        select(ToolFavorite.tool_id)
        .where(ToolFavorite.account_id == account.id)
        .order_by(ToolFavorite.created_at.asc())
    ).all()
    return FavoriteList(tools=list(rows))


@router.put("/{tool_id}", response_model=FavoriteList)
def add_favorite(tool_id: str, db: DBSession = Depends(get_db),
                 account: Account = Depends(require_account)) -> FavoriteList:
    _validate_tool_id(tool_id)
    exists = db.get(ToolFavorite, (account.id, tool_id))
    if not exists:
        db.add(ToolFavorite(account_id=account.id, tool_id=tool_id))
        db.commit()
    return list_favorites(db=db, account=account)


@router.delete("/{tool_id}", response_model=FavoriteList)
def remove_favorite(tool_id: str, db: DBSession = Depends(get_db),
                    account: Account = Depends(require_account)) -> FavoriteList:
    _validate_tool_id(tool_id)
    row = db.get(ToolFavorite, (account.id, tool_id))
    if row:
        db.delete(row)
        db.commit()
    return list_favorites(db=db, account=account)
