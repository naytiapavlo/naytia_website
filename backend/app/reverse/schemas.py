"""IDA MCP 原始返回 → 前端契约（pydantic 模型）。

为什么要这一层：MCP 的返回形状是给 LLM 看的（字段名短、有时是文本块、
分页游标散落在各处）。前端需要的是稳定、显式、可版本化的结构。
所有形状都按 2026-09-16 对真实实例的探测结果写（见 docs/plans/07 第 4 节），
并保留对缺失字段的容错，避免 IDA 版本差异直接打崩界面。
"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class IdaInstance(BaseModel):
    host: str
    port: int
    pid: int | None = None
    binary: str | None = None
    idb_path: str | None = None
    started_at: str | None = None
    reachable: bool = False
    active: bool = False


class IdaStatus(BaseModel):
    """工作台顶栏状态。MCP 不可达时 reachable=False，其余字段为 None。"""

    reachable: bool
    error: str | None = None
    code: str | None = None
    idb_path: str | None = None
    module: str | None = None
    input_path: str | None = None
    imagebase: str | None = None
    auto_analysis_ready: bool | None = None
    hexrays_ready: bool | None = None
    strings_cache_ready: bool | None = None
    uptime_sec: float | None = None


class BinaryOverview(BaseModel):
    """survey_binary 的归一化结果。"""

    module: str | None = None
    path: str | None = None
    arch: str | None = None
    base_address: str | None = None
    image_size: str | None = None
    total_functions: int | None = None
    named_functions: int | None = None
    library_functions: int | None = None
    unnamed_functions: int | None = None
    total_strings: int | None = None
    total_segments: int | None = None
    segments: list["SegmentInfo"] = Field(default_factory=list)


class SegmentInfo(BaseModel):
    name: str
    start: str
    end: str
    size: str
    permissions: str | None = None


class FunctionSummary(BaseModel):
    addr: str
    name: str
    size: str | None = None


class FunctionPage(BaseModel):
    items: list[FunctionSummary] = Field(default_factory=list)
    next_offset: int | None = None
    total: int | None = None


class DisasmLine(BaseModel):
    addr: str
    instruction: str
    label: str | None = None


class StackVar(BaseModel):
    name: str
    offset: str | None = None
    size: str | None = None
    type: str | None = None


class Disassembly(BaseModel):
    addr: str
    name: str | None = None
    start_ea: str | None = None
    segment: str | None = None
    lines: list[DisasmLine] = Field(default_factory=list)
    stack_frame: list[StackVar] = Field(default_factory=list)
    total: int | None = None


class XrefItem(BaseModel):
    addr: str
    type: str | None = None
    fn: str | None = None
    fn_name: str | None = None


class XrefGroup(BaseModel):
    addr: str
    xrefs: list[XrefItem] = Field(default_factory=list)
    more: bool = False
    error: str | None = None


class CalleeItem(BaseModel):
    addr: str
    name: str | None = None
    type: str | None = None


class CalleeGroup(BaseModel):
    addr: str
    callees: list[CalleeItem] = Field(default_factory=list)
    more: bool = False
    error: str | None = None


class BasicBlock(BaseModel):
    start: str
    end: str | None = None
    size: int | None = None
    type: int | None = None
    successors: list[str] = Field(default_factory=list)
    predecessors: list[str] = Field(default_factory=list)


class BlockGroup(BaseModel):
    addr: str
    blocks: list[BasicBlock] = Field(default_factory=list)
    count: int | None = None
    total_blocks: int | None = None
    error: str | None = None


class Pseudocode(BaseModel):
    addr: str
    code: str = ""
    error: str | None = None


class StringMatch(BaseModel):
    addr: str
    string: str


class StringSearchResult(BaseModel):
    total: int = 0
    matches: list[StringMatch] = Field(default_factory=list)


class TextSearchHit(BaseModel):
    addr: str
    text: str
    kind: str | None = None


class TextSearchResult(BaseModel):
    hits: list[TextSearchHit] = Field(default_factory=list)
    next_start: str | None = None


# ---------- 归一化函数 ----------
# MCP 返回可能是 dict / list / 单元素 list，字段名在不同工具间也不完全一致，
# 所以统一在这里做「取第一个可用形状 + 字段容错」，路由层不再关心这些差异。


def _as_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, list) and value and isinstance(value[0], dict):
        return value[0]
    return {}


def _as_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if value is None:
        return []
    return [value]


def _text(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    return str(value)


def normalize_instance(raw: dict[str, Any]) -> IdaInstance:
    return IdaInstance(
        host=_text(raw.get("host")) or "127.0.0.1",
        port=int(raw.get("port") or 0),
        pid=raw.get("pid") if isinstance(raw.get("pid"), int) else None,
        binary=_text(raw.get("binary")),
        idb_path=_text(raw.get("idb_path")),
        started_at=_text(raw.get("started_at")),
        reachable=bool(raw.get("reachable", False)),
        active=bool(raw.get("active", False)),
    )


def normalize_status(raw: dict[str, Any]) -> IdaStatus:
    if not raw.get("reachable"):
        return IdaStatus(reachable=False, error=_text(raw.get("error")), code=_text(raw.get("code")))
    return IdaStatus(
        reachable=True,
        idb_path=_text(raw.get("idb_path")),
        module=_text(raw.get("module")),
        input_path=_text(raw.get("input_path")),
        imagebase=_text(raw.get("imagebase")),
        auto_analysis_ready=raw.get("auto_analysis_ready"),
        hexrays_ready=raw.get("hexrays_ready"),
        strings_cache_ready=raw.get("strings_cache_ready"),
        uptime_sec=raw.get("uptime_sec") if isinstance(raw.get("uptime_sec"), (int, float)) else None,
    )


def normalize_overview(raw: Any) -> BinaryOverview:
    data = _as_dict(raw)
    meta = _as_dict(data.get("metadata"))
    stats = _as_dict(data.get("statistics"))
    segments = [
        SegmentInfo(
            name=_text(s.get("name")) or "?",
            start=_text(s.get("start")) or "",
            end=_text(s.get("end")) or "",
            size=_text(s.get("size")) or "",
            permissions=_text(s.get("permissions")),
        )
        for s in _as_list(data.get("segments"))
        if isinstance(s, dict)
    ]
    return BinaryOverview(
        module=_text(meta.get("module")),
        path=_text(meta.get("path")),
        arch=_text(meta.get("arch")),
        base_address=_text(meta.get("base_address")),
        image_size=_text(meta.get("image_size")),
        total_functions=stats.get("total_functions"),
        named_functions=stats.get("named_functions"),
        library_functions=stats.get("library_functions"),
        unnamed_functions=stats.get("unnamed_functions"),
        total_strings=stats.get("total_strings"),
        total_segments=stats.get("total_segments"),
        segments=segments,
    )


def normalize_function_page(raw: Any) -> FunctionPage:
    """list_funcs / func_query 返回 [{data:[...], next_offset}]。"""
    block = _as_dict(raw)
    items = [
        FunctionSummary(
            addr=_text(f.get("addr")) or "",
            name=_text(f.get("name")) or "",
            size=_text(f.get("size")),
        )
        for f in _as_list(block.get("data"))
        if isinstance(f, dict)
    ]
    next_offset = block.get("next_offset")
    total = block.get("total")
    return FunctionPage(
        items=items,
        next_offset=next_offset if isinstance(next_offset, int) else None,
        total=total if isinstance(total, int) else None,
    )


def normalize_lookup(raw: Any) -> list[FunctionSummary]:
    """lookup_funcs 返回 [{query, fn:{...}, error}]。"""
    out: list[FunctionSummary] = []
    for item in _as_list(raw):
        if not isinstance(item, dict):
            continue
        fn = item.get("fn")
        if isinstance(fn, dict) and fn.get("addr"):
            out.append(FunctionSummary(
                addr=_text(fn.get("addr")) or "",
                name=_text(fn.get("name")) or "",
                size=_text(fn.get("size")),
            ))
    return out


def normalize_pseudocode(raw: Any, fallback_addr: str) -> Pseudocode:
    data = _as_dict(raw)
    return Pseudocode(
        addr=_text(data.get("addr")) or fallback_addr,
        code=_text(data.get("code")) or "",
        error=_text(data.get("error")),
    )


def normalize_disassembly(raw: Any, fallback_addr: str) -> Disassembly:
    data = _as_dict(raw)
    asm = _as_dict(data.get("asm"))
    lines = [
        DisasmLine(
            addr=_text(line.get("addr")) or "",
            instruction=_text(line.get("instruction")) or "",
            label=_text(line.get("label")),
        )
        for line in _as_list(asm.get("lines"))
        if isinstance(line, dict)
    ]
    stack = [
        StackVar(
            name=_text(v.get("name")) or "",
            offset=_text(v.get("offset")),
            size=_text(v.get("size")),
            type=_text(v.get("type")),
        )
        for v in _as_list(asm.get("stack_frame"))
        if isinstance(v, dict)
    ]
    return Disassembly(
        addr=_text(data.get("addr")) or fallback_addr,
        name=_text(asm.get("name")) or _text(data.get("name")),
        start_ea=_text(asm.get("start_ea")),
        segment=_text(asm.get("segment")),
        lines=lines,
        stack_frame=stack,
        total=data.get("total") if isinstance(data.get("total"), int) else None,
    )


def normalize_xrefs(raw: Any) -> list[XrefGroup]:
    groups: list[XrefGroup] = []
    for item in _as_list(raw):
        if not isinstance(item, dict):
            continue
        groups.append(XrefGroup(
            addr=_text(item.get("addr")) or "",
            xrefs=[
                XrefItem(
                    addr=_text(x.get("addr")) or "",
                    type=_text(x.get("type")),
                    fn=_text(x.get("fn")),
                    fn_name=_text(x.get("fn_name")),
                )
                for x in _as_list(item.get("xrefs"))
                if isinstance(x, dict)
            ],
            more=bool(item.get("more", False)),
            error=_text(item.get("error")),
        ))
    return groups


def normalize_callees(raw: Any) -> list[CalleeGroup]:
    groups: list[CalleeGroup] = []
    for item in _as_list(raw):
        if not isinstance(item, dict):
            continue
        groups.append(CalleeGroup(
            addr=_text(item.get("addr")) or "",
            callees=[
                CalleeItem(
                    addr=_text(c.get("addr")) or "",
                    name=_text(c.get("name")),
                    type=_text(c.get("type")),
                )
                for c in _as_list(item.get("callees"))
                if isinstance(c, dict)
            ],
            more=bool(item.get("more", False)),
            error=_text(item.get("error")),
        ))
    return groups


def normalize_blocks(raw: Any) -> list[BlockGroup]:
    groups: list[BlockGroup] = []
    for item in _as_list(raw):
        if not isinstance(item, dict):
            continue
        groups.append(BlockGroup(
            addr=_text(item.get("addr")) or "",
            blocks=[
                BasicBlock(
                    start=_text(b.get("start")) or "",
                    end=_text(b.get("end")),
                    size=b.get("size") if isinstance(b.get("size"), int) else None,
                    type=b.get("type") if isinstance(b.get("type"), int) else None,
                    successors=[_text(s) or "" for s in _as_list(b.get("successors"))],
                    predecessors=[_text(p) or "" for p in _as_list(b.get("predecessors"))],
                )
                for b in _as_list(item.get("blocks"))
                if isinstance(b, dict)
            ],
            count=item.get("count") if isinstance(item.get("count"), int) else None,
            total_blocks=item.get("total_blocks") if isinstance(item.get("total_blocks"), int) else None,
            error=_text(item.get("error")),
        ))
    return groups


def normalize_string_search(raw: Any) -> StringSearchResult:
    data = _as_dict(raw)
    matches = [
        StringMatch(addr=_text(m.get("addr")) or "", string=_text(m.get("string")) or "")
        for m in _as_list(data.get("matches"))
        if isinstance(m, dict)
    ]
    total = data.get("n")
    return StringSearchResult(
        total=total if isinstance(total, int) else len(matches),
        matches=matches,
    )


def normalize_text_search(raw: Any) -> TextSearchResult:
    """search_text 的返回在版本间有差异：兼容 hits/results 两种键。"""
    data = _as_dict(raw)
    raw_hits = data.get("hits") or data.get("results") or data.get("matches")
    hits = [
        TextSearchHit(
            addr=_text(h.get("addr")) or _text(h.get("ea")) or "",
            text=_text(h.get("text")) or _text(h.get("line")) or "",
            kind=_text(h.get("kind")) or _text(h.get("type")),
        )
        for h in _as_list(raw_hits)
        if isinstance(h, dict)
    ]
    return TextSearchResult(
        hits=hits,
        next_start=_text(data.get("next_start")) or _text(data.get("next")),
    )


BinaryOverview.model_rebuild()
