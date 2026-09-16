"""站点配置路由（ADR-002）：
- GET /api/site-config 公开返回已保存的覆盖项（前端与内置默认值合并；
  后端不可用时前端回退默认值，静态站保持可用）。
- PUT /api/site-config 仅超级管理员；只存覆盖项，不整页替换。
"""
import json

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session as DBSession

from ..db import get_db
from ..deps import require_superadmin
from ..models import Account, SiteConfigEntry
from ..schemas import SiteConfigUpdate

router = APIRouter(prefix="/api/site-config", tags=["site-config"])

_SITE_KEY = "site"


def _read_entry(db: DBSession) -> SiteConfigEntry | None:
    return db.get(SiteConfigEntry, _SITE_KEY)


@router.get("")
def get_site_config(db: DBSession = Depends(get_db)) -> dict:
    entry = _read_entry(db)
    if entry is None:
        return {"overrides": {}, "updated_at": None}
    return {"overrides": json.loads(entry.data), "updated_at": entry.updated_at.isoformat()}


@router.put("")
def put_site_config(payload: SiteConfigUpdate, db: DBSession = Depends(get_db),
                    admin: Account = Depends(require_superadmin)) -> dict:
    patch = payload.model_dump(exclude_none=True, exclude_unset=True)
    # background 内层 None 字段同样剔除，避免覆盖前端已有的 url
    if "background" in patch and isinstance(patch["background"], dict):
        patch["background"] = {k: v for k, v in patch["background"].items()
                               if v is not None}
    entry = _read_entry(db)
    if entry is None:
        entry = SiteConfigEntry(key=_SITE_KEY, data=json.dumps(patch, ensure_ascii=False))
        db.add(entry)
    else:
        current = json.loads(entry.data)
        current.update(patch)  # 浅合并：只更新本次提交的字段
        entry.data = json.dumps(current, ensure_ascii=False)
    entry.updated_by = admin.id
    db.commit()
    return {"overrides": json.loads(entry.data),
            "updated_at": entry.updated_at.isoformat()}
