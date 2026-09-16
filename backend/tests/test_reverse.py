"""逆向工作台的单元测试：MCP 客户端、形状归一化、读取白名单。

用 httpx.MockTransport 假扮 ida-pro-mcp，所以**不需要真的开着 IDA**，
也不会碰真实 IDB。对照数据取自 2026-09-16 对真实实例的探测结果
（见 docs/plans/07 第 4 节），保留真实字段名，避免用实现自己推导期望值。
"""
from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from app.reverse import schemas as s
from app.reverse.client import ReverseService
from app.reverse.mcp_client import WRITE_TOOLS, IdaMcpClient, IdaMcpError

from .conftest import register

# ---------- 假 MCP 服务 ----------


def _ok_result(payload: object) -> dict:
    """把返回值包成 MCP tools/call 的 content 形状。"""
    return {"content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}]}


class FakeMcp:
    """记录收到的请求，并按工具名返回预置形状。"""

    def __init__(self, responses: dict[str, object] | None = None,
                 *, fail_init: bool = False, unreachable: bool = False) -> None:
        self.responses = responses or {}
        self.fail_init = fail_init
        self.unreachable = unreachable
        self.calls: list[tuple[str, dict]] = []
        self.init_count = 0
        self.selected_ports: list[int] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        if self.unreachable:
            raise httpx.ConnectError("connection refused", request=request)
        body = json.loads(request.content.decode("utf-8"))
        method = body.get("method")

        if method == "initialize":
            self.init_count += 1
            if self.fail_init:
                return httpx.Response(500, json={"error": {"message": "boom"}})
            return httpx.Response(
                200,
                json={"jsonrpc": "2.0", "id": body.get("id"),
                      "result": {"serverInfo": {"name": "ida-pro-mcp", "version": "1.0.0"}}},
                headers={"Mcp-Session-Id": "fake-session"},
            )
        if method == "notifications/initialized":
            return httpx.Response(202)

        if method == "tools/call":
            params = body.get("params", {})
            tool = params.get("name", "")
            args = params.get("arguments", {})
            self.calls.append((tool, args))
            if tool == "select_instance":
                port = args.get("port")
                if port == 9999:  # 约定：这个端口视为不可用
                    return httpx.Response(200, json={
                        "jsonrpc": "2.0", "id": body.get("id"),
                        "result": _ok_result({"success": False, "message": "实例不可用"}),
                    })
                self.selected_ports.append(port)
                return httpx.Response(200, json={
                    "jsonrpc": "2.0", "id": body.get("id"),
                    "result": _ok_result({"success": True, "port": port}),
                })
            payload = self.responses.get(tool)
            if payload is None:
                return httpx.Response(200, json={
                    "jsonrpc": "2.0", "id": body.get("id"),
                    "error": {"message": f"未知工具 {tool}"},
                })
            return httpx.Response(200, json={
                "jsonrpc": "2.0", "id": body.get("id"), "result": _ok_result(payload),
            })
        return httpx.Response(400, json={"error": {"message": "unsupported"}})


def make_client(fake: FakeMcp) -> IdaMcpClient:
    """带假传输的客户端。transport 注入是生产代码里为可测试性留的钩子。"""
    return IdaMcpClient(url="http://fake/mcp", timeout=5.0,
                        transport=httpx.MockTransport(fake.handler))


def run(coro):
    return asyncio.run(coro)


# ---------- 传输与会话 ----------


def test_initialize_establishes_session():
    fake = FakeMcp({"server_health": {"status": "ok"}})
    client = make_client(fake)

    result = run(client.call("server_health"))

    assert result == {"status": "ok"}
    assert fake.init_count == 1, "首次调用应建立一次 MCP 会话"
    assert client._session_id == "fake-session"


def test_unreachable_mcp_returns_graceful_status():
    fake = FakeMcp(unreachable=True)
    client = make_client(fake)

    status = run(client.health())

    assert status["reachable"] is False
    assert status["code"] == "ida_unreachable"


def test_read_only_whitelist_rejects_unknown_tool():
    fake = FakeMcp()
    client = make_client(fake)

    with pytest.raises(IdaMcpError) as excinfo:
        run(client.call("py_eval", {"code": "import os; os.system('calc')"}))

    assert excinfo.value.code == "tool_not_allowed"
    assert excinfo.value.status == 403
    assert fake.calls == [], "被拒绝的工具不应真的发到 MCP"


def test_dangerous_tools_are_not_in_write_whitelist():
    """patch / py_eval / put_int 这类等价于任意执行的工具，必须不在任何白名单里。"""
    for dangerous in ("patch", "py_eval", "py_exec_file", "put_int", "undefine", "patch_asm"):
        assert dangerous not in WRITE_TOOLS, f"{dangerous} 不应出现在写入白名单"


def test_write_tool_requires_write_path():
    fake = FakeMcp({"rename": {"ok": True}})
    client = make_client(fake)

    # 用只读入口调用写入工具应被拒
    with pytest.raises(IdaMcpError) as excinfo:
        run(client.call("rename", {"batch": {}}))
    assert excinfo.value.code == "tool_not_allowed"

    # 写入入口可以用
    assert run(client.call_write("rename", {"batch": {}})) == {"ok": True}


def test_instance_switch_is_cached():
    fake = FakeMcp({"list_funcs": [{"data": [], "next_offset": None}]})
    client = make_client(fake)

    run(client.call("list_funcs", {"queries": [{}]}, port=13337))
    run(client.call("list_funcs", {"queries": [{}]}, port=13337))
    assert fake.selected_ports == [13337], "同一实例不应重复切换"

    run(client.call("list_funcs", {"queries": [{}]}, port=13338))
    assert fake.selected_ports == [13337, 13338]


def test_instance_unavailable_is_reported():
    fake = FakeMcp({"list_funcs": [{"data": [], "next_offset": None}]})
    client = make_client(fake)

    with pytest.raises(IdaMcpError) as excinfo:
        run(client.call("list_funcs", {"queries": [{}]}, port=9999))
    assert excinfo.value.code == "instance_unavailable"


def test_session_retry_on_invalid_session():
    """会话失效（400）后应重新 initialize 并重试一次。"""
    state = {"calls": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode("utf-8"))
        if body.get("method") == "initialize":
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": body.get("id"),
                                             "result": {}},
                                  headers={"Mcp-Session-Id": "s2"})
        if body.get("method") == "notifications/initialized":
            return httpx.Response(202)
        state["calls"] += 1
        if state["calls"] == 1:
            return httpx.Response(400, json={"error": {"message": "session expired"}})
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": body.get("id"),
                                         "result": _ok_result({"status": "ok"})})

    client = IdaMcpClient(url="http://fake/mcp", timeout=5.0,
                          transport=httpx.MockTransport(handler))

    assert run(client.call("server_health")) == {"status": "ok"}
    assert state["calls"] == 2


# ---------- 形状归一化（断真实字段名，不用实现推导） ----------


def test_normalize_function_page():
    page = s.normalize_function_page([{
        "data": [
            {"addr": "0x7ff6870d1000", "name": "_dynamic_initializer_for__Core", "size": "0xc"},
            {"addr": "0x7ff6870d1010", "name": "Direction::FROM_STRING_MAP", "size": "0x185"},
        ],
        "next_offset": 3,
    }])
    assert len(page.items) == 2
    assert page.items[0].addr == "0x7ff6870d1000"
    assert page.items[0].size == "0xc"
    assert page.next_offset == 3


def test_normalize_function_page_tolerates_empty():
    page = s.normalize_function_page([{"data": [], "next_offset": None}])
    assert page.items == []
    assert page.next_offset is None


def test_normalize_pseudocode_keeps_code_and_error():
    good = s.normalize_pseudocode(
        {"addr": "0x10", "code": "int f()\n{\n  return 1;\n}"}, "0x10")
    assert good.addr == "0x10" and "return 1;" in good.code and good.error is None

    bad = s.normalize_pseudocode([{"addr": "0x10", "error": "decompilation failed"}], "0x10")
    assert bad.error == "decompilation failed"


def test_normalize_disassembly_lines_and_stack():
    disasm = s.normalize_disassembly({
        "addr": "0x7ff6870d1010",
        "asm": {
            "name": "_dynamic_initializer_for__Direction::FROM_STRING_MAP__",
            "start_ea": "0x7ff6870d1010",
            "segment": ".text",
            "lines": [
                {"addr": "7ff6870d1010", "instruction": "push rbx",
                 "label": "_dynamic_initializer_for__Direction"},
                {"addr": "7ff6870d1012", "instruction": "sub rsp, 0C0h"},
            ],
            "stack_frame": [{"name": "var_A8", "offset": "0x20", "size": "0x10", "type": "_OWORD"}],
        },
    }, "0x7ff6870d1010")

    assert disasm.name.startswith("_dynamic_initializer")
    assert disasm.segment == ".text"
    assert [line.instruction for line in disasm.lines] == ["push rbx", "sub rsp, 0C0h"]
    assert disasm.lines[0].label is not None
    assert disasm.stack_frame[0].name == "var_A8"


def test_normalize_xrefs_and_more_flag():
    groups = s.normalize_xrefs([{
        "addr": "0x7ff6870d1010",
        "xrefs": [{"addr": "0x7ff689c3e438", "type": "data", "fn": None}],
        "more": False,
    }])
    assert len(groups) == 1
    assert groups[0].xrefs[0].type == "data"
    assert groups[0].more is False


def test_normalize_overview_reads_metadata_and_statistics():
    overview = s.normalize_overview({
        "metadata": {"module": "bedrock_server.exe", "arch": "64",
                     "base_address": "0x7ff6870d0000", "image_size": "0x36d1000"},
        "statistics": {"total_functions": 171396, "named_functions": 165546,
                       "library_functions": 959, "unnamed_functions": 4891,
                       "total_strings": 49232, "total_segments": 6},
        "segments": [{"name": ".text", "start": "0x7ff6870d1000",
                      "end": "0x7ff689c3d000", "size": "0x2b6c000", "permissions": "rx"}],
    })
    assert overview.total_functions == 171396
    assert overview.module == "bedrock_server.exe"
    assert overview.segments[0].name == ".text"


def test_normalize_string_search():
    result = s.normalize_string_search({
        "n": 5,
        "matches": [{"addr": "0x7ff689c9c970", "string": "Could not load server.properties file"}],
    })
    assert result.total == 5
    assert result.matches[0].addr == "0x7ff689c9c970"


def test_normalize_text_search_accepts_multiple_shapes():
    """不同版本可能用 hits/results/matches，三种都要能读。"""
    for key in ("hits", "results", "matches"):
        result = s.normalize_text_search({key: [{"addr": "0x1000", "text": "mov eax, 1"}]})
        assert len(result.hits) == 1, f"{key} 形状未被识别"
        assert result.hits[0].text == "mov eax, 1"


def test_normalize_blocks_with_pagination():
    groups = s.normalize_blocks([{
        "addr": "0x7ff6870d1010",
        "blocks": [{"start": "0x7ff6870d1010", "end": "0x7ff6870d1195", "size": 389,
                    "type": 0, "successors": ["0x7ff689adb970"], "predecessors": []}],
        "count": 2, "total_blocks": 9, "cursor": {"next": 2},
    }])
    assert groups[0].count == 2
    assert groups[0].total_blocks == 9
    assert groups[0].blocks[0].successors == ["0x7ff689adb970"]


def test_normalize_status_unreachable_keeps_error():
    status = s.normalize_status({"reachable": False, "error": "连接不上", "code": "ida_unreachable"})
    assert status.reachable is False
    assert status.code == "ida_unreachable"


# ---------- 服务层 ----------


def test_service_decompile_passes_addresses_flag():
    fake = FakeMcp({"decompile": {"addr": "0x10", "code": "int f(){return 1;}"}})
    service = ReverseService(make_client(fake))

    result = run(service.decompile("0x10", include_addresses=False))

    assert result.code == "int f(){return 1;}"
    called = dict(fake.calls)
    assert called["decompile"] == {"addr": "0x10", "include_addresses": False}


def test_service_list_functions_omits_empty_filter():
    fake = FakeMcp({"list_funcs": [{"data": [], "next_offset": None}]})
    service = ReverseService(make_client(fake))

    run(service.list_functions(offset=0, count=50, filter_text=None))

    _, args = fake.calls[-1]
    assert args["queries"][0] == {"offset": 0, "count": 50}


def test_service_list_functions_includes_filter():
    fake = FakeMcp({"list_funcs": [{"data": [], "next_offset": None}]})
    service = ReverseService(make_client(fake))

    run(service.list_functions(offset=100, count=50, filter_text="*Player*"))

    _, args = fake.calls[-1]
    assert args["queries"][0]["filter"] == "*Player*"
    assert args["queries"][0]["offset"] == 100


def test_service_rename_uses_write_path():
    fake = FakeMcp({"rename": {"applied": 1}})
    service = ReverseService(make_client(fake))

    result = run(service.rename_function("0x10", "MyFunc", dry_run=True))

    assert result == {"applied": 1}
    _, args = fake.calls[-1]
    assert args["batch"]["func"] == [{"addr": "0x10", "name": "MyFunc"}]
    assert args["batch"]["dry_run"] is True


# ---------- 路由级权限（权限一律服务端判定，01 文档第 7 节） ----------
#
# 这些用例不需要真实 IDA：403 在鉴权阶段就返回了，根本走不到 MCP 调用。
# 反过来这也证明「前端隐藏按钮」不是权限控制——绕过界面直接打接口同样被拒。


def test_rename_requires_login(client):
    res = client.post("/api/reverse/functions/rename?addr=0x10", json={"name": "X"})
    assert res.status_code == 401
    assert res.json()["detail"]["code"] == "auth_required"


def test_rename_rejected_for_ordinary_member(client):
    # 注意：库里第一个注册账号会被 bootstrap 成 superadmin（ADR-002），
    # 所以要先占掉第一个名额，第二个注册的才是普通 member。
    register(client, "占位超管")
    client.post("/api/auth/logout")
    register(client, "逆向路人")
    res = client.post("/api/reverse/functions/rename?addr=0x10", json={"name": "X"})
    assert res.status_code == 403
    assert res.json()["detail"]["code"] == "forbidden"


def test_rename_allowed_for_first_bootstrap_admin(client, monkeypatch):
    """首个注册账号（superadmin）应能通过鉴权并真正触达 MCP 调用。"""
    register(client, "站长")
    fake = FakeMcp({"rename": {"applied": 1}})

    from app.reverse import mcp_client as module

    monkeypatch.setattr(module, "_client",
                        IdaMcpClient(url="http://fake/mcp", timeout=5.0,
                                     transport=httpx.MockTransport(fake.handler)))

    res = client.post("/api/reverse/functions/rename?addr=0x7ff6870d1010",
                      json={"name": "MyRenamedFunc", "dry_run": True})

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["name"] == "MyRenamedFunc"
    assert body["dry_run"] is True
    assert body["operator"] == "站长"
    _, args = fake.calls[-1]
    assert args["batch"]["func"] == [
        {"addr": "0x7ff6870d1010", "name": "MyRenamedFunc"}
    ]


def test_permissions_reports_can_write(client):
    anon = client.get("/api/reverse/permissions").json()
    assert anon == {"role": None, "can_write": False}

    # 首个账号是 bootstrap 超管，可写
    register(client, "超管甲")
    admin = client.get("/api/reverse/permissions").json()
    assert admin == {"role": "superadmin", "can_write": True}

    # 第二个账号是普通 member，只读
    client.post("/api/auth/logout")
    register(client, "普通会员")
    member = client.get("/api/reverse/permissions").json()
    assert member == {"role": "member", "can_write": False}


def test_read_endpoints_are_public_but_degrade_when_ida_offline(client, monkeypatch):
    """访客可读；IDA 没开时返回结构化错误而不是 500。"""
    from app.reverse import mcp_client as module

    monkeypatch.setattr(module, "_client",
                        IdaMcpClient(url="http://fake/mcp", timeout=5.0,
                                     transport=httpx.MockTransport(FakeMcp(unreachable=True).handler)))

    status_res = client.get("/api/reverse/status")
    assert status_res.status_code == 200
    assert status_res.json()["reachable"] is False
    assert status_res.json()["code"] == "ida_unreachable"

    funcs = client.get("/api/reverse/functions?count=10")
    assert funcs.status_code == 503
    assert funcs.json()["detail"]["code"] == "ida_unreachable"


def test_decompile_passes_through_to_mcp(client, monkeypatch):
    from app.reverse import mcp_client as module

    fake = FakeMcp({"decompile": {"addr": "0x7ff6870d1010",
                                  "code": "int f()\n{\n  return 1;\n}"}})
    monkeypatch.setattr(module, "_client",
                        IdaMcpClient(url="http://fake/mcp", timeout=5.0,
                                     transport=httpx.MockTransport(fake.handler)))

    res = client.get("/api/reverse/decompile?addr=0x7ff6870d1010&include_addresses=false")

    assert res.status_code == 200
    assert "return 1;" in res.json()["code"]
    assert res.json()["addr"] == "0x7ff6870d1010"
    _, args = fake.calls[-1]
    assert args["include_addresses"] is False


def test_functions_rejects_oversized_count(client, monkeypatch):
    """count 有上限，避免一次把 17 万个函数全拉下来。"""
    res = client.get("/api/reverse/functions?count=99999")
    assert res.status_code == 422
