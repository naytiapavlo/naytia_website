"""逆向工作台的服务层：把 MCP 调用 + 形状归一化包成一个方法。

路由层只调用本模块，不直接碰 MCP 细节，也不自己处理返回形状差异。
"""
from __future__ import annotations

from typing import Any

from . import schemas as s
from .mcp_client import IdaMcpClient, get_ida_client


class ReverseService:
    def __init__(self, client: IdaMcpClient | None = None) -> None:
        self._client = client

    @property
    def client(self) -> IdaMcpClient:
        return self._client or get_ida_client()

    # ---------- 状态与实例 ----------

    async def status(self) -> s.IdaStatus:
        return s.normalize_status(await self.client.health())

    async def instances(self) -> list[s.IdaInstance]:
        raw = await self.client.list_instances()
        return [s.normalize_instance(item) for item in raw]

    async def overview(self, port: int | None = None) -> s.BinaryOverview:
        raw = await self.client.call("survey_binary", {"detail_level": "minimal"}, port=port)
        return s.normalize_overview(raw)

    # ---------- 读取 ----------

    async def list_functions(self, *, offset: int, count: int, filter_text: str | None,
                             port: int | None = None) -> s.FunctionPage:
        query: dict[str, Any] = {"offset": offset, "count": count}
        if filter_text:
            query["filter"] = filter_text
        raw = await self.client.call("list_funcs", {"queries": [query]}, port=port)
        return s.normalize_function_page(raw)

    async def lookup_functions(self, targets: list[str],
                               port: int | None = None) -> list[s.FunctionSummary]:
        raw = await self.client.call("lookup_funcs", {"queries": targets}, port=port)
        return s.normalize_lookup(raw)

    async def decompile(self, addr: str, include_addresses: bool = True,
                        port: int | None = None) -> s.Pseudocode:
        raw = await self.client.call(
            "decompile", {"addr": addr, "include_addresses": include_addresses}, port=port
        )
        return s.normalize_pseudocode(raw, addr)

    async def disassemble(self, addr: str, *, offset: int = 0, max_instructions: int = 2000,
                          port: int | None = None) -> s.Disassembly:
        raw = await self.client.call("disasm", {
            "addr": addr,
            "offset": offset,
            "max_instructions": max_instructions,
            "include_total": True,
        }, port=port)
        return s.normalize_disassembly(raw, addr)

    async def xrefs_to(self, addrs: list[str], limit: int = 100,
                       port: int | None = None) -> list[s.XrefGroup]:
        raw = await self.client.call("xrefs_to", {"addrs": addrs, "limit": limit}, port=port)
        return s.normalize_xrefs(raw)

    async def xrefs_of(self, addr: str, *, direction: str = "both", count: int = 200,
                       port: int | None = None) -> list[s.XrefGroup]:
        raw = await self.client.call("xref_query", {"queries": [{
            "addr": addr,
            "direction": direction,
            "count": count,
            "include_fn": True,
        }]}, port=port)
        return s.normalize_xrefs(raw)

    async def callees(self, addrs: list[str], limit: int = 200,
                      port: int | None = None) -> list[s.CalleeGroup]:
        raw = await self.client.call("callees", {"addrs": addrs, "limit": limit}, port=port)
        return s.normalize_callees(raw)

    async def basic_blocks(self, addrs: list[str], max_blocks: int = 1000,
                           port: int | None = None) -> list[s.BlockGroup]:
        raw = await self.client.call("basic_blocks", {
            "addrs": addrs, "max_blocks": max_blocks,
        }, port=port)
        return s.normalize_blocks(raw)

    async def search_strings(self, pattern: str, *, limit: int = 50, offset: int = 0,
                             port: int | None = None) -> s.StringSearchResult:
        raw = await self.client.call("find_regex", {
            "pattern": pattern, "limit": limit, "offset": offset,
        }, port=port)
        return s.normalize_string_search(raw)

    async def search_text(self, pattern: str, *, limit: int = 50, start: str | None = None,
                          regex: bool = False, port: int | None = None) -> s.TextSearchResult:
        args: dict[str, Any] = {
            "pattern": pattern,
            "limit": limit,
            "regex": regex,
            "include": "all",
            "code_only": True,
        }
        if start:
            args["start"] = start
        raw = await self.client.call("search_text", args, port=port)
        return s.normalize_text_search(raw)

    # ---------- 写入（调用方必须先鉴权） ----------

    async def rename_function(self, addr: str, name: str, *,
                              dry_run: bool = False,
                              port: int | None = None) -> Any:
        return await self.client.call_write("rename", {
            "batch": {"func": [{"addr": addr, "name": name}], "dry_run": dry_run},
        }, port=port)


def get_reverse_service() -> ReverseService:
    return ReverseService()
