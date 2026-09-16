"""AI 助手能调用的工具集。

**只读**：这里列的每个工具都只查询，不改任何东西。
底层的 `IdaMcpClient.call()` 本身还有一层只读白名单，写工具必须走 `call_write`
（只有 admin 的重命名路由会用），所以 agent 在结构上就不可能改名或 patch。

新增工具时两件事一起做：加 `spec()` 定义 + 在 `HANDLERS` 里加实现。
"""
from __future__ import annotations

from typing import Any, Awaitable, Callable

from ..reverse.client import ReverseService


def _fn(name: str, description: str, properties: dict[str, Any],
        required: list[str] | None = None) -> dict[str, Any]:
    """OpenAI / DeepSeek function calling 的工具定义。"""
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": required or [],
                "additionalProperties": False,
            },
        },
    }


TOOL_SPECS: list[dict[str, Any]] = [
    _fn(
        "survey_binary",
        "获取当前 IDB 的概览：模块名、架构、基址、段、函数总数、字符串总数。"
        "不确定自己在看什么二进制时先调它。",
        {},
    ),
    _fn(
        "list_functions",
        "按名字列函数（支持 * 通配）。用于浏览函数列表或找某类函数。",
        {
            "filter": {"type": "string", "description": "名称过滤，例如 *Player* 或 DedicatedServer*"},
            "offset": {"type": "integer", "description": "起始下标，默认 0"},
            "count": {"type": "integer", "description": "返回条数，默认 50，最大 200"},
        },
    ),
    _fn(
        "lookup_function",
        "把一个地址或函数名解析成函数条目（拿到它的地址与名字）。"
        "用于确认某个地址属于哪个函数。",
        {
            "target": {"type": "string", "description": "地址（0x…）或函数名"},
        },
        ["target"],
    ),
    _fn(
        "decompile",
        "反编译一个函数，返回 Hex-Rays 伪代码。分析函数逻辑时的首选工具。"
        "伪代码里的 /*0xADDR*/ 是行内地址。",
        {
            "addr": {"type": "string", "description": "函数地址（0x…）或函数名"},
        },
        ["addr"],
    ),
    _fn(
        "disassemble",
        "反汇编一个函数，返回汇编指令与栈帧变量。伪代码看不懂或需要确认细节时用。",
        {
            "addr": {"type": "string", "description": "函数地址或函数名"},
            "max_instructions": {"type": "integer", "description": "最多返回多少条指令，默认 400"},
        },
        ["addr"],
    ),
    _fn(
        "xrefs_to",
        "查谁引用了这个地址/函数（调用者）。用于顺着调用链往上找。",
        {
            "addr": {"type": "string", "description": "地址或函数名"},
            "limit": {"type": "integer", "description": "最多返回多少条，默认 50"},
        },
        ["addr"],
    ),
    _fn(
        "callees",
        "查这个函数调用了哪些函数。用于顺着调用链往下找。",
        {
            "addr": {"type": "string", "description": "地址或函数名"},
            "limit": {"type": "integer", "description": "最多返回多少条，默认 50"},
        },
        ["addr"],
    ),
    _fn(
        "basic_blocks",
        "取函数的基本块（CFG）。用于理解分支结构与循环。",
        {
            "addr": {"type": "string", "description": "地址或函数名"},
            "max_blocks": {"type": "integer", "description": "最多多少块，默认 100"},
        },
        ["addr"],
    ),
    _fn(
        "search_strings",
        "按正则搜索二进制里的字符串。找配置项名、报错信息、协议字段时很有用。",
        {
            "pattern": {"type": "string", "description": "正则，例如 player\\.permission"},
            "limit": {"type": "integer", "description": "最多返回多少条，默认 30"},
        },
        ["pattern"],
    ),
    _fn(
        "search_text",
        "在反汇编清单里做全文搜索（IDA 原生文本搜索）。找指令或注释里的字面量时用。",
        {
            "pattern": {"type": "string", "description": "要搜索的文本"},
            "limit": {"type": "integer", "description": "最多返回多少条，默认 30"},
        },
        ["pattern"],
    ),
]


def _trim(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[:limit] + f"\n…（已截断，原文 {len(text)} 字符）"


async def _survey_binary(svc: ReverseService, args: dict[str, Any], port: int | None) -> Any:
    overview = await svc.overview(port)
    return overview.model_dump()


async def _list_functions(svc: ReverseService, args: dict[str, Any], port: int | None) -> Any:
    count = min(int(args.get("count") or 50), 200)
    offset = max(int(args.get("offset") or 0), 0)
    page = await svc.list_functions(
        offset=offset, count=count, filter_text=args.get("filter") or None, port=port
    )
    return {
        "items": [f.model_dump() for f in page.items],
        "next_offset": page.next_offset,
    }


async def _lookup_function(svc: ReverseService, args: dict[str, Any], port: int | None) -> Any:
    found = await svc.lookup_functions([str(args.get("target") or "")], port=port)
    return [f.model_dump() for f in found] or "未找到该地址/名字对应的函数"


async def _decompile(svc: ReverseService, args: dict[str, Any], port: int | None) -> Any:
    result = await svc.decompile(str(args.get("addr") or ""), port=port)
    if result.error:
        return {"error": result.error}
    return {"addr": result.addr, "code": _trim(result.code, 6000)}


async def _disassemble(svc: ReverseService, args: dict[str, Any], port: int | None) -> Any:
    limit = min(int(args.get("max_instructions") or 400), 2000)
    result = await svc.disassemble(str(args.get("addr") or ""), max_instructions=limit, port=port)
    if not result.lines:
        return {"error": "该地址没有反汇编输出"}
    return {
        "addr": result.addr,
        "name": result.name,
        "segment": result.segment,
        "lines": [f"{l.addr}  {l.instruction}" for l in result.lines],
        "stack_frame": [v.model_dump() for v in result.stack_frame],
    }


async def _xrefs_to(svc: ReverseService, args: dict[str, Any], port: int | None) -> Any:
    limit = min(int(args.get("limit") or 50), 500)
    groups = await svc.xrefs_to([str(args.get("addr") or "")], limit=limit, port=port)
    if not groups:
        return []
    return [x.model_dump() for x in groups[0].xrefs]


async def _callees(svc: ReverseService, args: dict[str, Any], port: int | None) -> Any:
    limit = min(int(args.get("limit") or 50), 500)
    groups = await svc.callees([str(args.get("addr") or "")], limit=limit, port=port)
    if not groups:
        return []
    return [c.model_dump() for c in groups[0].callees]


async def _basic_blocks(svc: ReverseService, args: dict[str, Any], port: int | None) -> Any:
    max_blocks = min(int(args.get("max_blocks") or 100), 2000)
    groups = await svc.basic_blocks([str(args.get("addr") or "")], max_blocks=max_blocks, port=port)
    if not groups:
        return []
    group = groups[0]
    return {
        "total_blocks": group.total_blocks,
        "blocks": [b.model_dump() for b in group.blocks],
    }


async def _search_strings(svc: ReverseService, args: dict[str, Any], port: int | None) -> Any:
    limit = min(int(args.get("limit") or 30), 200)
    result = await svc.search_strings(str(args.get("pattern") or ""), limit=limit, port=port)
    return {"total": result.total, "matches": [m.model_dump() for m in result.matches]}


async def _search_text(svc: ReverseService, args: dict[str, Any], port: int | None) -> Any:
    limit = min(int(args.get("limit") or 30), 200)
    result = await svc.search_text(str(args.get("pattern") or ""), limit=limit, port=port)
    return {"hits": [h.model_dump() for h in result.hits]}


Handler = Callable[[ReverseService, dict[str, Any], "int | None"], Awaitable[Any]]

HANDLERS: dict[str, Handler] = {
    "survey_binary": _survey_binary,
    "list_functions": _list_functions,
    "lookup_function": _lookup_function,
    "decompile": _decompile,
    "disassemble": _disassemble,
    "xrefs_to": _xrefs_to,
    "callees": _callees,
    "basic_blocks": _basic_blocks,
    "search_strings": _search_strings,
    "search_text": _search_text,
}

# 工具名 → 面向用户的短标签（前端在对话里显示"正在调用…"）
TOOL_LABELS: dict[str, str] = {
    "survey_binary": "读取二进制概览",
    "list_functions": "列出函数",
    "lookup_function": "解析函数地址",
    "decompile": "反编译函数",
    "disassemble": "反汇编函数",
    "xrefs_to": "查询调用者",
    "callees": "查询被调用函数",
    "basic_blocks": "读取基本块",
    "search_strings": "搜索字符串",
    "search_text": "搜索反汇编文本",
}

# 与 TOOL_SPECS 必须一一对应，否则模型可能调到一个没有实现的工具
assert set(HANDLERS) == {s["function"]["name"] for s in TOOL_SPECS}, "工具定义与实现不匹配"
