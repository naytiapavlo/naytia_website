"""IDA Pro MCP 客户端：JSON-RPC over HTTP（Streamable HTTP 传输）。

设计要点（docs/plans/07）：
- **不引入 MCP SDK 依赖**：ida-pro-mcp 暴露的是标准 JSON-RPC POST 端点，
  直接发请求比引入一整套客户端依赖更可控，也更容易测试。
- **带会话**：`initialize` 返回 `Mcp-Session-Id`，后续请求必须带上；
  会话失效（4xx）时自动重新初始化一次。
- **串行化**：IDA 侧的 `select_instance` 是全局状态。工具调用与实例切换
  必须在同一把锁里完成，否则并发请求会互相切走实例，返回别的二进制的结果。
- **只读白名单**：本模块默认只允许调用查看类工具；写入类（patch/py_eval 等）
  必须显式走 `call_write`，由路由层的权限检查负责放行。
"""
from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx

from ..config import get_settings

# 只读工具白名单：前端能触达的全部 MCP 工具都在这里，
# 不在名单里的名字一律拒绝，避免请求参数被用来调用任意 MCP 工具。
READ_ONLY_TOOLS: frozenset[str] = frozenset({
    "server_health",
    "list_instances",
    "list_funcs",
    "func_query",
    "lookup_funcs",
    "decompile",
    "disasm",
    "xrefs_to",
    "xref_query",
    "callees",
    "basic_blocks",
    "find_regex",
    "search_text",
    "survey_binary",
    "analyze_function",
    "get_string",
    "get_bytes",
    "get_int",
    "stack_frame",
    "type_inspect",
    "search_structs",
    "imports",
    "imports_query",
    "list_globals",
})

# 写入工具白名单：仅 admin 及以上可调用，且首版只开放「沉淀分析成果」这一类。
# patch / py_eval / put_int / undefine 等具有任意代码执行或破坏性的工具**刻意不开放**。
WRITE_TOOLS: frozenset[str] = frozenset({
    "rename",
    "set_comments",
    "append_comments",
    "set_type",
    "declare_type",
    "enum_upsert",
})


class IdaMcpError(RuntimeError):
    """MCP 调用失败。由路由层转成结构化 HTTP 错误。"""

    def __init__(self, message: str, *, code: str = "ida_error", status: int = 502) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


class IdaMcpClient:
    """对 ida-pro-mcp 的薄封装。一个进程内共享一个实例（见 get_ida_client）。"""

    def __init__(self, url: str | None = None, timeout: float | None = None,
                 transport: httpx.AsyncBaseTransport | None = None) -> None:
        settings = get_settings()
        self.url = url or settings.ida_mcp_url
        self.timeout = timeout or settings.ida_mcp_timeout
        # 仅为可测试性保留：测试注入 httpx.MockTransport，生产走默认
        self._transport = transport
        self._session_id: str | None = None
        self._req_id = 0
        # 保护「切换实例 + 调用工具」这个复合操作，以及会话初始化
        self._lock = asyncio.Lock()
        self._active_port: int | None = None

    # ---------- 传输层 ----------

    def _next_id(self) -> int:
        self._req_id += 1
        return self._req_id

    async def _post(self, payload: dict[str, Any]) -> tuple[dict[str, Any], str | None]:
        headers = {
            "Content-Type": "application/json",
            # Streamable HTTP 要求客户端同时接受两种响应
            "Accept": "application/json, text/event-stream",
        }
        if self._session_id:
            headers["Mcp-Session-Id"] = self._session_id
        try:
            async with httpx.AsyncClient(timeout=self.timeout,
                                         transport=self._transport) as client:
                resp = await client.post(self.url, json=payload, headers=headers)
        except httpx.ConnectError as exc:
            raise IdaMcpError(
                "连接不上 IDA MCP 服务（请确认 IDA 已打开且 MCP 插件在运行）",
                code="ida_unreachable",
                status=503,
            ) from exc
        except httpx.TimeoutException as exc:
            raise IdaMcpError(
                "IDA MCP 调用超时（函数可能过大，可减少指令数后重试）",
                code="ida_timeout",
                status=504,
            ) from exc

        if resp.status_code >= 400:
            # 会话过期：清掉会话号，由调用方决定是否重试
            if resp.status_code in (400, 404, 410):
                self._session_id = None
            raise IdaMcpError(
                f"IDA MCP 返回 {resp.status_code}",
                code="ida_bad_session" if resp.status_code in (400, 404, 410) else "ida_error",
                status=502,
            )

        new_session = resp.headers.get("Mcp-Session-Id")
        if new_session:
            self._session_id = new_session
        return self._parse_body(resp.text), new_session

    @staticmethod
    def _parse_body(raw: str) -> dict[str, Any]:
        """服务端可能返回纯 JSON 或 SSE（event: message / data: {...}）。"""
        text = raw.strip()
        if not text:
            return {}
        if text.startswith("{") or text.startswith("["):
            return json.loads(text)
        for line in text.splitlines():
            if line.startswith("data: "):
                return json.loads(line[6:])
        raise IdaMcpError("无法解析 IDA MCP 响应", code="ida_bad_response")

    async def _rpc(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        payload: dict[str, Any] = {"jsonrpc": "2.0", "id": self._next_id(), "method": method}
        if params is not None:
            payload["params"] = params
        body, _ = await self._post(payload)
        if "error" in body:
            err = body["error"]
            raise IdaMcpError(
                err.get("message") or "IDA MCP 返回错误",
                code="ida_jsonrpc_error",
            )
        return body.get("result", {})

    async def ensure_session(self) -> None:
        """建立 MCP 会话；已建立则直接返回。

        注意：**不加锁**。调用方（_call_serialized）已经持有串行化锁，
        asyncio.Lock 不可重入，在这里再加锁会直接死锁。
        """
        if self._session_id is not None:
            return
        await self._rpc("initialize", {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "naytia-reverse", "version": "0.1.0"},
        })
        # initialized 是通知（无 id），失败也不影响后续调用
        try:
            await self._post({
                "jsonrpc": "2.0",
                "method": "notifications/initialized",
            })
        except IdaMcpError:
            pass

    # ---------- 工具调用 ----------

    async def call(self, tool: str, arguments: dict[str, Any] | None = None,
                   *, port: int | None = None) -> Any:
        """调用只读工具。port 用于先把 MCP 切到目标实例，再执行调用。"""
        if tool not in READ_ONLY_TOOLS:
            raise IdaMcpError(f"不允许调用的工具：{tool}", code="tool_not_allowed", status=403)
        return await self._call_serialized(tool, arguments or {}, port)

    async def call_write(self, tool: str, arguments: dict[str, Any] | None = None,
                         *, port: int | None = None) -> Any:
        """调用写入工具。**调用方必须先做权限检查**（本方法不做鉴权）。"""
        if tool not in WRITE_TOOLS:
            raise IdaMcpError(f"未开放的写入工具：{tool}", code="tool_not_allowed", status=403)
        return await self._call_serialized(tool, arguments or {}, port)

    async def _call_serialized(self, tool: str, arguments: dict[str, Any],
                               port: int | None) -> Any:
        # port 为 None 表示「沿用 MCP 服务当前选中的实例」，不强行切换；
        # 只有前端明确指定了实例才去切。
        async with self._lock:
            await self.ensure_session()
            try:
                await self._ensure_instance(port)
                return await self._invoke(tool, arguments)
            except IdaMcpError as exc:
                # 会话失效：重连一次再试
                if exc.code != "ida_bad_session":
                    raise
                self._session_id = None
                self._active_port = None
                await self.ensure_session()
                await self._ensure_instance(port)
                return await self._invoke(tool, arguments)

    async def _ensure_instance(self, port: int | None) -> None:
        if port is None or port == self._active_port:
            return
        result = await self._invoke("select_instance", {"port": port})
        if isinstance(result, dict) and result.get("success") is False:
            raise IdaMcpError(
                result.get("message") or f"无法切换到实例 {port}",
                code="instance_unavailable",
                status=404,
            )
        self._active_port = port

    async def _invoke(self, tool: str, arguments: dict[str, Any]) -> Any:
        result = await self._rpc("tools/call", {"name": tool, "arguments": arguments})
        content = result.get("content") or []
        texts = [c.get("text", "") for c in content if c.get("type") == "text"]
        if not texts:
            return None
        payload = texts[0] if len(texts) == 1 else texts
        if isinstance(payload, str):
            try:
                return json.loads(payload)
            except json.JSONDecodeError:
                # 少数工具返回纯文本（如 py_eval 输出），原样返回
                return payload
        return payload

    async def health(self) -> dict[str, Any]:
        """探测 MCP 与当前 IDB 状态；失败时返回 reachable=False 而不抛异常。"""
        try:
            data = await self.call("server_health")
        except IdaMcpError as exc:
            return {"reachable": False, "error": str(exc), "code": exc.code}
        if not isinstance(data, dict):
            return {"reachable": False, "error": "响应格式异常", "code": "ida_bad_response"}
        return {"reachable": True, **data}

    async def list_instances(self) -> list[dict[str, Any]]:
        data = await self.call("list_instances")
        if not isinstance(data, list):
            return []
        settings = get_settings()
        allowed = settings.ida_allowed_port_list
        out: list[dict[str, Any]] = []
        for item in data:
            if not isinstance(item, dict):
                continue
            port = item.get("port")
            if not isinstance(port, int):
                continue
            if allowed and port not in allowed:
                continue
            out.append(item)
        return out

    def reset_session(self) -> None:
        """丢弃当前会话与实例记忆，用于连接异常后的强制重连。"""
        self._session_id = None
        self._active_port = None


_client: IdaMcpClient | None = None


def get_ida_client() -> IdaMcpClient:
    """进程内单例：会话与实例选择都是全局状态，必须共享同一个客户端。"""
    global _client
    if _client is None:
        _client = IdaMcpClient()
    return _client
