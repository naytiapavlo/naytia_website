"""AI 助手路由（docs/plans/11）。

给谁用：**所有访客**（含未登录）。与逆向工作台"访客可只看"的定位一致。
配额：每 5 小时 3 轮，登录按账号、未登录按 IP（见 ratelimit.py）。

为什么必须限流：这个接口每次调用都会**消耗真实费用**（DeepSeek 计费），
且背后是"agent 循环 + 访问本机 IDA"。不限流等于把钱包和 IDA 一起开放。
"""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, status

from ..config import AI_ROUNDS_PER_WINDOW
from ..deps import get_current_account
from ..models import Account
from ..reverse.client import ReverseService, get_reverse_service
from ..reverse.mcp_client import IdaMcpError
from .agent import AiAgent
from .deepseek import AiError, DeepSeekClient
from .ratelimit import RateLimiter, get_rate_limiter
from .schemas import ChatRequest, ChatResponse, QuotaInfo, ToolCallInfo

router = APIRouter(prefix="/api/ai", tags=["ai"])


def _identity(request: Request,
              account: Account | None) -> tuple[str, Literal["account", "ip"]]:
    """配额身份：登录用账号、未登录用 IP。返回 (限流键, 身份类型)。"""
    if account is not None:
        return f"account:{account.id}", "account"
    # 反代后面要拿真实 IP：需要显式信任代理头。
    # 这里保守地取 client.host；部署到反代后应改为读取可信代理头，并记进 ADR。
    host = request.client.host if request.client else "unknown"
    return f"ip:{host}", "ip"


def _quota_payload(snapshot: dict, identifier: Literal["account", "ip"],
                   configured: bool) -> QuotaInfo:
    return QuotaInfo(
        configured=configured,
        limit=int(snapshot["limit"]),
        used=int(snapshot["used"]),
        remaining=int(snapshot["remaining"]),
        reset_in=float(snapshot["reset_in"]),
        identity=identifier,
    )


def get_ai_client() -> DeepSeekClient:
    return DeepSeekClient()


@router.get("/quota", response_model=QuotaInfo)
def quota(
    request: Request,
    account: Account | None = Depends(get_current_account),
    limiter: RateLimiter = Depends(get_rate_limiter),
    client: DeepSeekClient = Depends(get_ai_client),
) -> QuotaInfo:
    """当前还剩几轮。前端进页面就调一次，用来显示配额与"未配置"状态。"""
    key, identifier = _identity(request, account)
    return _quota_payload(limiter.snapshot(key), identifier, client.configured)


@router.post("/chat", response_model=ChatResponse)
async def chat(
    payload: ChatRequest,
    request: Request,
    account: Account | None = Depends(get_current_account),
    limiter: RateLimiter = Depends(get_rate_limiter),
    client: DeepSeekClient = Depends(get_ai_client),
    service: ReverseService = Depends(get_reverse_service),
) -> ChatResponse:
    if not client.configured:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"code": "ai_not_configured",
                    "message": "站点还没有配置 DeepSeek API key，AI 助手暂不可用"},
        )

    key, identifier = _identity(request, account)
    allowed, snapshot = limiter.consume(key)
    if not allowed:
        minutes = max(1, int(snapshot["reset_in"] // 60) + 1)
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "code": "ai_quota_exceeded",
                "message": f"每 {AI_ROUNDS_PER_WINDOW} 轮 / 5 小时的额度已用完，约 {minutes} 分钟后恢复",
                "quota": {
                    "limit": snapshot["limit"],
                    "used": snapshot["used"],
                    "remaining": 0,
                    "reset_in": snapshot["reset_in"],
                },
            },
        )

    history = [m.model_dump(exclude_none=True) for m in payload.history]
    agent = AiAgent(client, service)
    try:
        result = await agent.run(
            payload.message.strip(),
            history=history,
            context=payload.context.model_dump() if payload.context else None,
            port=payload.port,
        )
    except AiError as exc:
        raise HTTPException(
            status_code=exc.status,
            detail={"code": exc.code, "message": str(exc)},
        ) from exc
    except IdaMcpError as exc:
        raise HTTPException(
            status_code=exc.status,
            detail={"code": exc.code, "message": str(exc)},
        ) from exc

    return ChatResponse(
        reply=result["reply"],
        messages=result["messages"],
        tool_calls=[ToolCallInfo(**t) for t in result["tool_calls"]],
        remaining=int(snapshot["remaining"]),
        limit=int(snapshot["limit"]),
        reset_in=float(snapshot["reset_in"]),
        truncated=bool(result["truncated"]),
    )
