"""探测 IDA MCP 服务：列出全部工具及其输入 schema。

这是开发期的一次性探测脚本（放在 tests/manual/ 下），用途是拿到真实接口清单，
而不是照抄文档猜测。用法：python tests/manual/probe_ida_mcp.py
"""
from __future__ import annotations

import json
import sys
import urllib.request

MCP_URL = "http://127.0.0.1:13337/mcp"


def rpc(method: str, params: dict | None = None, req_id: int = 1,
        session: str | None = None) -> tuple[dict, str | None]:
    payload = {"jsonrpc": "2.0", "id": req_id, "method": method}
    if params is not None:
        payload["params"] = params
    data = json.dumps(payload).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    if session:
        headers["Mcp-Session-Id"] = session
    req = urllib.request.Request(MCP_URL, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read().decode("utf-8")
        new_session = resp.headers.get("Mcp-Session-Id")
    # 服务端可能返回 SSE 或纯 JSON
    if raw.lstrip().startswith("event:") or "\ndata: " in raw or raw.startswith("data: "):
        for line in raw.splitlines():
            if line.startswith("data: "):
                return json.loads(line[6:]), new_session
        raise RuntimeError(f"无法解析 SSE 响应: {raw[:200]}")
    return json.loads(raw), new_session


def main() -> int:
    init, session = rpc("initialize", {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "naytia-probe", "version": "1.0"},
    })
    info = init.get("result", {}).get("serverInfo", {})
    print(f"服务: {info.get('name')} v{info.get('version')}  会话: {session}")

    # 通知已初始化（部分实现要求）
    try:
        rpc("notifications/initialized", None, session=session)
    except Exception as exc:  # noqa: BLE001
        print(f"(initialized 通知被忽略: {exc})", file=sys.stderr)

    tools_resp, _ = rpc("tools/list", {}, req_id=2, session=session)
    tools = tools_resp.get("result", {}).get("tools", [])
    print(f"\n共 {len(tools)} 个工具：\n")
    for tool in tools:
        name = tool.get("name")
        desc = (tool.get("description") or "").strip().splitlines()[0]
        schema = tool.get("inputSchema", {})
        props = schema.get("properties", {})
        required = set(schema.get("required", []))
        args = ", ".join(
            f"{k}{'*' if k in required else ''}:{v.get('type', '?')}"
            for k, v in props.items()
        ) or "(无参数)"
        print(f"- {name}({args})")
        if desc:
            print(f"    {desc}")
    with open("tests/manual/ida_mcp_tools.json", "w", encoding="utf-8") as fh:
        json.dump(tools, fh, ensure_ascii=False, indent=2)
    print("\n完整 schema 已写入 tests/manual/ida_mcp_tools.json")

    # 顺带探测当前 IDA 实例与已加载的二进制状态
    print("\n=== 实例与当前 IDB 状态 ===")
    for label, method, params in (
        ("list_instances", "tools/call", {"name": "list_instances", "arguments": {}}),
        ("server_health", "tools/call", {"name": "server_health", "arguments": {}}),
    ):
        try:
            resp, _ = rpc(method, params, req_id=10, session=session)
            content = resp.get("result", {}).get("content", [])
            for item in content:
                if item.get("type") == "text":
                    print(f"--- {label} ---\n{item['text'][:1500]}")
        except Exception as exc:  # noqa: BLE001
            print(f"--- {label} 失败: {exc}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
