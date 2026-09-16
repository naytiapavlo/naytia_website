"""开放 API 路由（/api/v1）：目录、详情、执行；信封与限流见 09 标准文档。"""
import hashlib
import secrets
import time
from typing import Any

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DBSession

from ..db import get_db
from ..deps import require_superadmin
from ..models import Account, ApiKey
from ..security import token_digest
from . import engines
from .catalog import TOOLS, TOOL_IDS
from .errors import PublicApiError, public_api_error_handler
from .ratelimit import rate_limiter

router = APIRouter(prefix="/api/v1", tags=["public-v1"])
admin_router = APIRouter(prefix="/api/admin/api-keys", tags=["public-v1-admin"])

MAX_BODY_BYTES = 65_536


def _meta(tool_id: str, started: float, module: engines.EngineModule) -> dict[str, Any]:
    return {
        "tool_id": tool_id,
        "implementation_version": module.implementation_version,
        "input_schema_version": module.input_schema_version,
        "ruleset_id": module.ruleset_id,
        "duration_ms": round((time.perf_counter() - started) * 1000, 2),
    }


def _limit(request: Request, response: Response, key: str | None, tier: str) -> None:
    identity = f"key:{hashlib.sha256(key.encode()).hexdigest()[:16]}" if key else f"ip:{request.client.host if request.client else 'unknown'}"
    allowed, limit, remaining, retry_after = rate_limiter.check(identity, tier)
    response.headers["X-RateLimit-Limit"] = str(limit)
    response.headers["X-RateLimit-Remaining"] = str(remaining)
    if not allowed:
        retry = str(int(retry_after) + 1)
        raise PublicApiError(
            429,
            "rate_limited",
            f"请求过于频繁，{retry} 秒后重试；携带 API 密钥可获得更高限额",
            retryable=True,
            headers={"Retry-After": retry},
        )


def _key_tier(request: Request, db: DBSession) -> str | None:
    """校验 Bearer 密钥；返回 tier。密钥相关错误直接抛信封错误。"""
    auth = request.headers.get("authorization", "")
    if not auth:
        return None
    if not auth.startswith("Bearer "):
        raise PublicApiError(401, "invalid_api_key", "Authorization 头需为 Bearer <api-key>")
    presented = auth.removeprefix("Bearer ").strip()
    if not presented:
        raise PublicApiError(401, "invalid_api_key", "API 密钥为空")
    row = db.scalar(select(ApiKey).where(ApiKey.key_hash == token_digest(presented)))
    if row is None:
        raise PublicApiError(401, "invalid_api_key", "API 密钥不存在或已失效")
    if not row.enabled:
        raise PublicApiError(403, "api_key_disabled", "该 API 密钥已被停用")
    return row.tier


def _tool_or_404(tool_id: str) -> dict[str, Any]:
    if tool_id not in TOOL_IDS:
        raise PublicApiError(404, "tool_not_found", f"工具不存在：{tool_id}")
    return next(t for t in TOOLS if t["id"] == tool_id)


@router.get("/tools")
def list_tools(response: Response, request: Request,
               db: DBSession = Depends(get_db)) -> dict[str, Any]:
    _limit(request, response, None, "anonymous")  # 目录本身按匿名档限流
    return {
        "ok": True,
        "data": {
            "version": "v1",
            "tools": [
                {k: t[k] for k in ("id", "slug", "title", "summary", "category", "tags", "status")}
                for t in TOOLS
            ],
        },
    }


@router.get("/tools/{tool_id}")
def get_tool(tool_id: str, response: Response, request: Request,
             db: DBSession = Depends(get_db)) -> dict[str, Any]:
    _limit(request, response, None, "anonymous")
    tool = _tool_or_404(tool_id)
    module = engines.ENGINES[tool_id]
    return {
        "ok": True,
        "data": {
            **{k: tool[k] for k in ("id", "slug", "title", "summary", "category", "tags", "status")},
            "implementation_version": module.implementation_version,
            "input_schema_version": module.input_schema_version,
            "ruleset_ids": [module.ruleset_id],
            "input_schema": tool["input_schema"],
            "examples": tool["examples"],
            "run": {
                "method": "POST",
                "path": f"/api/v1/tools/{tool_id}/run",
                "body": {"input": tool["examples"][0]["input"], "ruleset_id": module.ruleset_id},
            },
        },
    }


class RunRequest(BaseModel):
    input: dict[str, Any] = Field(default_factory=dict)
    ruleset_id: str | None = Field(default=None, max_length=64)


@router.post("/tools/{tool_id}/run")
def run_tool(tool_id: str, payload: RunRequest, request: Request, response: Response,
             db: DBSession = Depends(get_db)) -> dict[str, Any]:
    if request.headers.get("content-length", "").isdigit() and int(request.headers["content-length"]) > MAX_BODY_BYTES:
        raise PublicApiError(413, "payload_too_large", "请求体超过 64KB 上限")
    tier = _key_tier(request, db) or "anonymous"
    _limit(request, response, None if tier == "anonymous" else _presented_key(request), tier)

    tool = _tool_or_404(tool_id)
    if tool["status"] not in ("stable", "experimental"):
        raise PublicApiError(
            404, "tool_not_available", f"工具 {tool_id} 当前状态为 {tool['status']}，未开放计算"
        )
    module = engines.ENGINES[tool_id]
    if payload.ruleset_id and payload.ruleset_id != module.ruleset_id:
        raise PublicApiError(
            400,
            "unsupported_ruleset",
            f"工具 {tool_id} 支持的规则集：{module.ruleset_id}（收到 {payload.ruleset_id}）",
        )

    started = time.perf_counter()
    validated = module.validate(payload.input)
    data, warnings = module.run(validated)
    return {
        "ok": True,
        "data": data,
        "warnings": warnings,
        "meta": _meta(tool_id, started, module),
    }


def _presented_key(request: Request) -> str:
    return request.headers.get("authorization", "").removeprefix("Bearer ").strip()


def register(app) -> None:
    """挂载 v1 路由、密钥管理路由与信封异常处理（main.py 只加一行）。"""
    app.include_router(router)
    app.include_router(admin_router)
    app.add_exception_handler(PublicApiError, public_api_error_handler)


# ---------- 密钥管理（超级管理员） ----------


class ApiKeyCreate(BaseModel):
    name: str = Field(min_length=1, max_length=64)


def _key_summary(row: ApiKey) -> dict[str, Any]:
    return {
        "id": row.id,
        "name": row.name,
        "tier": row.tier,
        "enabled": row.enabled,
        "created_at": row.created_at.isoformat(),
    }


@admin_router.post("", status_code=201)
def create_key(payload: ApiKeyCreate, db: DBSession = Depends(get_db),
               admin: Account = Depends(require_superadmin)) -> dict[str, Any]:
    secret = "nk_" + secrets.token_urlsafe(24)
    row = ApiKey(
        key_hash=token_digest(secret),
        name=payload.name,
        tier="standard",
        created_by=admin.id,
    )
    db.add(row)
    db.commit()
    return {"ok": True, "data": {**_key_summary(row), "key": secret,
                                 "note": "密钥明文仅此一次返回，请立即保存"}}


@admin_router.get("")
def list_keys(db: DBSession = Depends(get_db),
              _: Account = Depends(require_superadmin)) -> dict[str, Any]:
    rows = db.scalars(select(ApiKey).order_by(ApiKey.id)).all()
    return {"ok": True, "data": {"keys": [_key_summary(r) for r in rows]}}


@admin_router.delete("/{key_id}", status_code=204)
def disable_key(key_id: int, db: DBSession = Depends(get_db),
                _: Account = Depends(require_superadmin)) -> None:
    row = db.get(ApiKey, key_id)
    if row is not None:
        row.enabled = False
        db.commit()
