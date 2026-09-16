"""探测 IDA MCP 的返回形状与延迟（决定前端渲染契约）。

用法：python tests/manual/probe_ida_shapes.py [样本地址]
"""
from __future__ import annotations

import json
import sys
import time

sys.path.insert(0, "tests/manual")
from probe_ida_mcp import rpc  # noqa: E402

SAMPLE = sys.argv[1] if len(sys.argv) > 1 else "0x7ff6870d1010"


def call(name: str, arguments: dict, session: str, req_id: int) -> tuple[object, float]:
    started = time.perf_counter()
    resp, _ = rpc("tools/call", {"name": name, "arguments": arguments},
                  req_id=req_id, session=session)
    elapsed = time.perf_counter() - started
    if "error" in resp:
        return {"__rpc_error": resp["error"]}, elapsed
    content = resp.get("result", {}).get("content", [])
    texts = [c.get("text", "") for c in content if c.get("type") == "text"]
    payload = texts[0] if len(texts) == 1 else texts
    try:
        return (json.loads(payload) if isinstance(payload, str) else payload), elapsed
    except (json.JSONDecodeError, TypeError):
        return payload, elapsed


def show(label: str, value: object, elapsed: float, limit: int = 1100) -> None:
    text = json.dumps(value, ensure_ascii=False, indent=1)
    print(f"\n{'=' * 70}\n### {label}   [{elapsed * 1000:.0f} ms]\n{'=' * 70}")
    print(text[:limit] + ("\n… (截断)" if len(text) > limit else ""))


def main() -> int:
    _, session = rpc("initialize", {
        "protocolVersion": "2025-06-18", "capabilities": {},
        "clientInfo": {"name": "naytia-shape-probe", "version": "1.0"},
    })
    req = 200
    sel, ms = call("select_instance", {"port": 13337}, session, req := req + 1)
    show("select_instance(13337)", sel, ms)

    for label, name, args in (
        (f"decompile({SAMPLE})", "decompile", {"addr": SAMPLE, "include_addresses": True}),
        (f"disasm({SAMPLE}) 前 3 条", "disasm", {"addr": SAMPLE, "max_instructions": 3}),
        (f"xrefs_to({SAMPLE})", "xrefs_to", {"addrs": [SAMPLE], "limit": 3}),
        (f"callees({SAMPLE})", "callees", {"addrs": [SAMPLE], "limit": 3}),
        (f"basic_blocks({SAMPLE})", "basic_blocks", {"addrs": [SAMPLE], "max_blocks": 2}),
        ("lookup_funcs 按名", "lookup_funcs", {"queries": ["_dynamic_initializer_for__Direction::FROM_STRING_MAP__"]}),
    ):
        value, elapsed = call(name, args, session, req := req + 1)
        show(label, value, elapsed)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
