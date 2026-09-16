"""逆向工作台路由（docs/plans/07）。

权限边界：
- 访客 / 登录用户：只读查看（状态、实例列表、函数列表、伪代码、反汇编、引用、搜索）
- admin / superadmin：额外可切换实例、重命名函数

刻意**不开放** patch / py_eval / put_int / undefine 等工具：
它们等价于在 IDA 进程内任意执行代码或破坏数据库，
不因为调用方是 superadmin 就变成安全操作（见 07 文档安全边界）。
"""
from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from ..deps import get_current_account, require_staff
from ..models import Account
from ..reverse import schemas as s
from ..reverse.client import ReverseService, get_reverse_service
from ..reverse.mcp_client import IdaMcpError

router = APIRouter(prefix="/api/reverse", tags=["reverse"])

Service = Annotated[ReverseService, Depends(get_reverse_service)]


def _handle(exc: IdaMcpError) -> HTTPException:
    """把 MCP 异常翻成结构化 HTTP 错误（沿用 03 文档的错误形状）。"""
    return HTTPException(
        status_code=exc.status,
        detail={"code": exc.code, "message": str(exc)},
    )


class RenameRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    dry_run: bool = False


# ---------- 状态与实例 ----------

@router.get("/status", response_model=s.IdaStatus)
async def get_status(service: Service) -> s.IdaStatus:
    """MCP 不可达时返回 reachable=False，而不是报错——前端据此显示降级提示。"""
    return await service.status()


@router.get("/instances", response_model=list[s.IdaInstance])
async def list_instances(service: Service) -> list[s.IdaInstance]:
    try:
        return await service.instances()
    except IdaMcpError as exc:
        raise _handle(exc) from exc


@router.get("/overview", response_model=s.BinaryOverview)
async def get_overview(
    service: Service,
    port: int | None = Query(default=None, description="IDA 实例端口；省略则用当前实例"),
) -> s.BinaryOverview:
    try:
        return await service.overview(port)
    except IdaMcpError as exc:
        raise _handle(exc) from exc


# ---------- 只读：函数、伪代码、反汇编、引用、搜索 ----------

@router.get("/functions", response_model=s.FunctionPage)
async def list_functions(
    service: Service,
    offset: int = Query(default=0, ge=0),
    count: int = Query(default=100, ge=1, le=1000),
    filter: str | None = Query(default=None, max_length=200, description="名称 glob，如 *Player*"),
    port: int | None = Query(default=None),
) -> s.FunctionPage:
    try:
        return await service.list_functions(
            offset=offset, count=count, filter_text=filter, port=port
        )
    except IdaMcpError as exc:
        raise _handle(exc) from exc


@router.get("/functions/lookup", response_model=list[s.FunctionSummary])
async def lookup_functions(
    service: Service,
    q: list[str] = Query(min_length=1, max_length=50, description="地址或函数名，可重复"),
    port: int | None = Query(default=None),
) -> list[s.FunctionSummary]:
    try:
        return await service.lookup_functions(q, port=port)
    except IdaMcpError as exc:
        raise _handle(exc) from exc


@router.get("/decompile", response_model=s.Pseudocode)
async def decompile(
    service: Service,
    addr: str = Query(min_length=1, max_length=200, description="函数地址或名称"),
    include_addresses: bool = Query(default=True),
    port: int | None = Query(default=None),
) -> s.Pseudocode:
    try:
        return await service.decompile(addr, include_addresses, port=port)
    except IdaMcpError as exc:
        raise _handle(exc) from exc


@router.get("/disasm", response_model=s.Disassembly)
async def disasm(
    service: Service,
    addr: str = Query(min_length=1, max_length=200),
    offset: int = Query(default=0, ge=0),
    max_instructions: int = Query(default=2000, ge=1, le=50000),
    port: int | None = Query(default=None),
) -> s.Disassembly:
    try:
        return await service.disassemble(
            addr, offset=offset, max_instructions=max_instructions, port=port
        )
    except IdaMcpError as exc:
        raise _handle(exc) from exc


@router.get("/xrefs", response_model=list[s.XrefGroup])
async def xrefs(
    service: Service,
    addr: str = Query(min_length=1, max_length=200),
    direction: str = Query(default="to", pattern="^(to|from|both)$"),
    limit: int = Query(default=100, ge=1, le=1000),
    port: int | None = Query(default=None),
) -> list[s.XrefGroup]:
    try:
        if direction == "to":
            return await service.xrefs_to([addr], limit=limit, port=port)
        return await service.xrefs_of(addr, direction=direction, count=limit, port=port)
    except IdaMcpError as exc:
        raise _handle(exc) from exc


@router.get("/callees", response_model=list[s.CalleeGroup])
async def callees(
    service: Service,
    addr: str = Query(min_length=1, max_length=200),
    limit: int = Query(default=200, ge=1, le=500),
    port: int | None = Query(default=None),
) -> list[s.CalleeGroup]:
    try:
        return await service.callees([addr], limit=limit, port=port)
    except IdaMcpError as exc:
        raise _handle(exc) from exc


@router.get("/blocks", response_model=list[s.BlockGroup])
async def blocks(
    service: Service,
    addr: str = Query(min_length=1, max_length=200),
    max_blocks: int = Query(default=500, ge=1, le=10000),
    port: int | None = Query(default=None),
) -> list[s.BlockGroup]:
    try:
        return await service.basic_blocks([addr], max_blocks=max_blocks, port=port)
    except IdaMcpError as exc:
        raise _handle(exc) from exc


@router.get("/search/strings", response_model=s.StringSearchResult)
async def search_strings(
    service: Service,
    pattern: str = Query(min_length=1, max_length=200),
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    port: int | None = Query(default=None),
) -> s.StringSearchResult:
    try:
        return await service.search_strings(pattern, limit=limit, offset=offset, port=port)
    except IdaMcpError as exc:
        raise _handle(exc) from exc


@router.get("/search/text", response_model=s.TextSearchResult)
async def search_text(
    service: Service,
    pattern: str = Query(min_length=2, max_length=200),
    limit: int = Query(default=50, ge=1, le=500),
    start: str | None = Query(default=None, max_length=200),
    regex: bool = Query(default=False),
    port: int | None = Query(default=None),
) -> s.TextSearchResult:
    try:
        return await service.search_text(
            pattern, limit=limit, start=start, regex=regex, port=port
        )
    except IdaMcpError as exc:
        raise _handle(exc) from exc


# ---------- 写入：仅 admin / superadmin ----------

@router.post("/functions/rename", response_model=dict)
async def rename_function(
    payload: RenameRequest,
    service: Service,
    addr: str = Query(min_length=1, max_length=200),
    account: Account = Depends(require_staff),
    port: int | None = Query(default=None),
) -> dict:
    """重命名函数。权限在服务端判定（01 文档第 7 节）；前端隐藏按钮不算权限控制。"""
    try:
        result = await service.rename_function(
            addr, payload.name, dry_run=payload.dry_run, port=port
        )
    except IdaMcpError as exc:
        raise _handle(exc) from exc
    return {
        "addr": addr,
        "name": payload.name,
        "dry_run": payload.dry_run,
        "operator": account.username,
        "result": result,
    }


@router.get("/permissions", response_model=dict)
async def permissions(account: Account | None = Depends(get_current_account)) -> dict:
    """前端据此决定是否显示编辑类控件；真正的拦截仍在各写入路由上。"""
    role = account.role if account else None
    return {
        "role": role,
        "can_write": role in ("admin", "superadmin"),
    }
