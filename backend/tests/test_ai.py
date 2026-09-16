"""AI 助手的测试：配额、只读工具、agent 循环、未配置降级。

全部用 httpx.MockTransport 假扮 DeepSeek，**不消耗真实额度**。
对照数据按官方契约的真实结构写（choices[0].message / tool_calls），
不用实现自己推导期望值。
"""
from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from app.ai.agent import AiAgent
from app.ai.deepseek import AiError, DeepSeekClient
from app.ai.ratelimit import RateLimiter
from app.ai.tools import HANDLERS, TOOL_SPECS
from app.reverse.client import ReverseService
from app.reverse.mcp_client import IdaMcpClient

from .conftest import register


def run(coro):
    return asyncio.run(coro)


# ---------- 假 DeepSeek ----------


class FakeDeepSeek:
    """按顺序返回预置的 message，并记录收到的请求体。"""

    def __init__(self, replies: list[dict], *, status: int = 200) -> None:
        self.replies = list(replies)
        self.status = status
        self.requests: list[dict] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode("utf-8"))
        self.requests.append(body)
        if self.status != 200:
            return httpx.Response(self.status, json={"error": {"message": "boom"}})
        reply = self.replies.pop(0) if self.replies else {"role": "assistant", "content": "（默认回复）"}
        return httpx.Response(200, json={"choices": [{"message": reply}]})


def make_client(fake: FakeDeepSeek, **kwargs) -> DeepSeekClient:
    return DeepSeekClient(api_key="test-key", base_url="http://fake",
                          transport=httpx.MockTransport(fake.handler), **kwargs)


class FakeIda:
    """假 IDA MCP：让 agent 的工具调用有东西可返回。"""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode("utf-8"))
        method = body.get("method")
        if method == "initialize":
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": body.get("id"), "result": {}},
                                  headers={"Mcp-Session-Id": "s"})
        if method == "notifications/initialized":
            return httpx.Response(202)
        params = body.get("params", {})
        tool = params.get("name", "")
        args = params.get("arguments", {})
        self.calls.append((tool, args))
        payloads = {
            "select_instance": {"success": True, "port": args.get("port")},
            "survey_binary": {
                "metadata": {"module": "bedrock_server.exe", "arch": "64",
                             "base_address": "0x7ff6870d0000"},
                "statistics": {"total_functions": 171396, "total_strings": 49232},
                "segments": [],
            },
            "decompile": {"addr": args.get("addr"), "code": "int main()\n{\n  return 0;\n}"},
            "disasm": {"addr": args.get("addr"),
                       "asm": {"lines": [{"addr": "1000", "instruction": "retn"}], "stack_frame": []}},
            "xrefs_to": [{"addr": args.get("addrs", [""])[0] if isinstance(args.get("addrs"), list) else "",
                          "xrefs": [{"addr": "0x7ff6871d2f10", "type": "code",
                                     "fn": "0x7ff6871d2f10", "fn_name": "DedicatedServer::run"}],
                          "more": False}],
            "callees": [{"addr": "", "callees": [{"addr": "0x7ff687189a70", "name": "std::string::_Construct",
                                                  "type": "internal"}], "more": False}],
            "basic_blocks": [{"addr": "", "blocks": [{"start": "0x1000", "end": "0x1010", "size": 16,
                                                      "type": 0, "successors": [], "predecessors": []}],
                              "total_blocks": 1}],
            "list_funcs": [{"data": [{"addr": "0x7ff6871d3b90", "name": "main", "size": "0x1f4a"}],
                            "next_offset": None}],
            "lookup_funcs": [{"query": "main", "fn": {"addr": "0x7ff6871d3b90", "name": "main", "size": "0x1f4a"},
                              "error": None}],
            "find_regex": {"n": 1, "matches": [{"addr": "0x7ff689c9c950", "string": "server.properties"}]},
            "search_text": {"hits": [{"addr": "0x1000", "text": "mov eax, 1"}]},
        }
        return httpx.Response(200, json={
            "jsonrpc": "2.0", "id": body.get("id"),
            "result": {"content": [{"type": "text", "text": json.dumps(payloads.get(tool, {}))}]},
        })


def make_service(fake_ida: FakeIda) -> ReverseService:
    return ReverseService(IdaMcpClient(url="http://fake-ida/mcp", timeout=5.0,
                                       transport=httpx.MockTransport(fake_ida.handler)))


# ---------- 限流 ----------


def test_limiter_allows_three_then_blocks():
    now = [0.0]
    limiter = RateLimiter(limit=3, window_seconds=100, clock=lambda: now[0])

    for i in range(3):
        allowed, snap = limiter.consume("ip:1.2.3.4")
        assert allowed, f"第 {i + 1} 轮应当放行"
        assert snap["remaining"] == 2 - i

    allowed, snap = limiter.consume("ip:1.2.3.4")
    assert allowed is False
    assert snap["remaining"] == 0
    assert snap["reset_in"] == pytest.approx(100.0)


def test_limiter_window_recovers():
    now = [0.0]
    limiter = RateLimiter(limit=3, window_seconds=100, clock=lambda: now[0])
    for _ in range(3):
        limiter.consume("k")
    assert limiter.consume("k")[0] is False

    now[0] = 101.0          # 最早那次滑出窗口
    allowed, snap = limiter.consume("k")
    assert allowed is True
    assert snap["used"] == 1


def test_limiter_keys_are_isolated():
    """两个访客互不影响——这是按 IP/账号分桶的意义。"""
    limiter = RateLimiter(limit=1, window_seconds=100, clock=lambda: 0.0)
    assert limiter.consume("ip:a")[0] is True
    assert limiter.consume("ip:a")[0] is False
    assert limiter.consume("ip:b")[0] is True


def test_limiter_snapshot_does_not_consume():
    limiter = RateLimiter(limit=3, window_seconds=100, clock=lambda: 0.0)
    before = limiter.snapshot("k")
    assert before["used"] == 0 and before["remaining"] == 3
    limiter.snapshot("k")
    assert limiter.snapshot("k")["remaining"] == 3, "只读配额不该扣次数"


# ---------- 工具集是只读的 ----------


def test_every_declared_tool_has_a_handler():
    assert set(HANDLERS) == {s["function"]["name"] for s in TOOL_SPECS}


def test_no_write_tool_is_exposed_to_the_agent():
    """agent 绝不能拿到改名/打补丁这类工具。"""
    names = set(HANDLERS)
    for forbidden in ("rename", "patch", "patch_asm", "py_eval", "py_exec_file",
                      "put_int", "undefine", "define_func", "set_type", "set_comments"):
        assert forbidden not in names, f"{forbidden} 不应暴露给 agent"


def test_tool_specs_are_openai_function_shape():
    for spec in TOOL_SPECS:
        assert spec["type"] == "function"
        fn = spec["function"]
        assert fn["name"] and fn["description"]
        assert fn["parameters"]["type"] == "object"


# ---------- agent 循环 ----------


def test_agent_returns_reply_without_tools():
    fake = FakeDeepSeek([{"role": "assistant", "content": "这是一个直接回答。"}])
    agent = AiAgent(make_client(fake), make_service(FakeIda()))

    result = run(agent.run("你好"))

    assert result["reply"] == "这是一个直接回答。"
    assert result["tool_calls"] == []
    assert result["truncated"] is False
    # 系统提示必须带上，否则模型不知道要"先查再答"
    assert fake.requests[0]["messages"][0]["role"] == "system"
    assert "先查再答" in fake.requests[0]["messages"][0]["content"]


def test_agent_executes_tool_then_answers():
    fake = FakeDeepSeek([
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "call_1", "type": "function",
             "function": {"name": "survey_binary", "arguments": "{}"}},
        ]},
        {"role": "assistant", "content": "这个二进制是 bedrock_server.exe，共 171396 个函数。"},
    ])
    ida = FakeIda()
    agent = AiAgent(make_client(fake), make_service(ida))

    result = run(agent.run("我在看什么？"))

    assert "bedrock_server.exe" in result["reply"]
    assert [t["name"] for t in result["tool_calls"]] == ["survey_binary"]
    assert result["tool_calls"][0]["ok"] is True
    assert result["tool_calls"][0]["label"] == "读取二进制概览"
    # 工具确实被打了（服务层会给 survey_binary 补 detail_level），且第二轮请求里
    # 带回了 assistant.tool_calls 与 tool 结果消息
    assert any(t == "survey_binary" for (t, _a) in ida.calls)
    second = fake.requests[1]["messages"]
    assert any(m.get("tool_calls") for m in second), "缺少 assistant.tool_calls 回传"
    assert any(m.get("role") == "tool" for m in second), "缺少 tool 结果消息"


def test_agent_parses_tool_arguments():
    fake = FakeDeepSeek([
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "c1", "type": "function",
             "function": {"name": "decompile", "arguments": '{"addr": "0x7ff6871d3b90"}'}},
        ]},
        {"role": "assistant", "content": "main 的伪代码很简单。"},
    ])
    ida = FakeIda()
    agent = AiAgent(make_client(fake), make_service(ida))

    run(agent.run("反编译 main"))

    # 服务层会补上 include_addresses=True（伪代码里的行内地址），这里只看关键参数
    called = [a for (t, a) in ida.calls if t == "decompile"]
    assert called and called[0]["addr"] == "0x7ff6871d3b90"


def test_agent_handles_broken_tool_arguments():
    """模型偶尔给出坏 JSON —— 不能因此崩掉整个对话。"""
    fake = FakeDeepSeek([
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "c1", "type": "function",
             "function": {"name": "survey_binary", "arguments": "这不是 JSON"}},
        ]},
        {"role": "assistant", "content": "好的。"},
    ])
    agent = AiAgent(make_client(fake), make_service(FakeIda()))

    result = run(agent.run("随便看看"))

    assert result["reply"] == "好的。"
    assert result["tool_calls"][0]["args"] == {}


def test_agent_rejects_unknown_tool_name():
    """模型可能"发明"工具名：如实记成失败，而不是抛异常。"""
    fake = FakeDeepSeek([
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "c1", "type": "function",
             "function": {"name": "rename_function", "arguments": '{"addr":"0x1","name":"x"}'}},
        ]},
        {"role": "assistant", "content": "我没有改名权限。"},
    ])
    agent = AiAgent(make_client(fake), make_service(FakeIda()))

    result = run(agent.run("把这个函数改名"))

    assert result["tool_calls"][0]["ok"] is False
    assert result["reply"] == "我没有改名权限。"


def test_agent_stops_at_tool_round_limit():
    """模型一直要工具时要能停下，并如实说明没得出结论。"""
    looping = {"role": "assistant", "content": "", "tool_calls": [
        {"id": "c", "type": "function",
         "function": {"name": "survey_binary", "arguments": "{}"}},
    ]}
    fake = FakeDeepSeek([dict(looping) for _ in range(20)])
    agent = AiAgent(make_client(fake), make_service(FakeIda()))

    result = run(agent.run("一直查"))

    assert result["truncated"] is True
    assert "没能得出结论" in result["reply"]
    assert len(fake.requests) <= 6 + 1, "工具轮数上限没有生效"


def test_agent_passes_workspace_context():
    fake = FakeDeepSeek([{"role": "assistant", "content": "好的。"}])
    agent = AiAgent(make_client(fake), make_service(FakeIda()))

    run(agent.run("这个函数做什么", context={
        "module": "bedrock_server.exe",
        "selected_name": "main",
        "selected_addr": "0x7ff6871d3b90",
    }))

    messages = fake.requests[0]["messages"]
    # 上下文要单独作为一条 system 消息，**不能**拼进用户的提问
    context_msgs = [m for m in messages if m["role"] == "system" and "工作台当前状态" in m["content"]]
    assert context_msgs, "缺少工作台上下文"
    assert "main" in context_msgs[0]["content"]
    assert "0x7ff6871d3b90" in context_msgs[0]["content"]

    user_msg = [m for m in messages if m["role"] == "user"][-1]["content"]
    assert user_msg == "这个函数做什么", f"用户消息被污染了：{user_msg!r}"
    assert "工作台当前状态" not in user_msg


def test_agent_clips_long_history():
    fake = FakeDeepSeek([{"role": "assistant", "content": "好的。"}])
    agent = AiAgent(make_client(fake), make_service(FakeIda()))
    history = [{"role": "user", "content": "x" * 3000} for _ in range(40)]

    run(agent.run("继续", history=history))

    sent = fake.requests[0]["messages"]
    assert len(sent) <= 24 + 2, "历史条数没有被截断"


# ---------- 未配置 / 上游错误 ----------


def test_client_reports_unconfigured():
    client = DeepSeekClient(api_key="")
    assert client.configured is False
    with pytest.raises(AiError) as excinfo:
        run(client.chat([{"role": "user", "content": "hi"}]))
    assert excinfo.value.code == "ai_not_configured"
    assert excinfo.value.status == 503


def test_client_surfaces_bad_key():
    fake = FakeDeepSeek([], status=401)
    client = make_client(fake)
    with pytest.raises(AiError) as excinfo:
        run(client.chat([{"role": "user", "content": "hi"}]))
    assert excinfo.value.code == "ai_bad_key"


def test_client_surfaces_upstream_rate_limit():
    fake = FakeDeepSeek([], status=429)
    client = make_client(fake)
    with pytest.raises(AiError) as excinfo:
        run(client.chat([{"role": "user", "content": "hi"}]))
    assert excinfo.value.code == "ai_upstream_rate_limited"
    assert excinfo.value.status == 429


def test_client_sends_tools_and_model():
    fake = FakeDeepSeek([{"role": "assistant", "content": "ok"}])
    client = make_client(fake, model="deepseek-chat")
    run(client.chat([{"role": "user", "content": "hi"}], tools=TOOL_SPECS))
    body = fake.requests[0]
    assert body["model"] == "deepseek-chat"
    assert body["stream"] is False
    assert body["tools"] and body["tool_choice"] == "auto"


# ---------- 路由：权限与配额 ----------
#
# 注意：FastAPI 在**装饰时**就捕获了 Depends() 里的函数对象，所以
# monkeypatch.setattr(模块, "get_ai_client", …) 对这种依赖不起作用，
# 必须用 app.dependency_overrides（FastAPI 官方推荐的测试做法）。


def override_deps(client, *, limiter=None, deepseek=None, service=None):
    """按需覆盖路由依赖；只覆盖传了的那些。"""
    from app.ai.router import get_ai_client, get_rate_limiter
    from app.reverse.client import get_reverse_service

    overrides = client.app.dependency_overrides
    if limiter is not None:
        overrides[get_rate_limiter] = lambda: limiter
    if deepseek is not None:
        overrides[get_ai_client] = lambda: deepseek
    if service is not None:
        overrides[get_reverse_service] = lambda: service


def test_quota_endpoint_is_public(client):
    override_deps(client,
                  limiter=RateLimiter(limit=3, window_seconds=100, clock=lambda: 0.0),
                  deepseek=DeepSeekClient(api_key="k"))
    res = client.get("/api/ai/quota")
    assert res.status_code == 200
    body = res.json()
    assert body["limit"] == 3 and body["remaining"] == 3
    assert body["identity"] == "ip", "未登录应按 IP 计"
    assert body["configured"] is True


def test_quota_reports_unconfigured(client):
    override_deps(client,
                  limiter=RateLimiter(limit=3, window_seconds=100, clock=lambda: 0.0),
                  deepseek=DeepSeekClient(api_key=""))
    body = client.get("/api/ai/quota").json()
    assert body["configured"] is False, "前端靠这个字段显示「未配置」而不是报错"


def test_chat_returns_503_when_key_missing(client):
    override_deps(client,
                  limiter=RateLimiter(limit=3, window_seconds=100, clock=lambda: 0.0),
                  deepseek=DeepSeekClient(api_key=""))
    res = client.post("/api/ai/chat", json={"message": "你好"})
    assert res.status_code == 503
    assert res.json()["detail"]["code"] == "ai_not_configured"


def test_chat_blocks_after_quota_exhausted(client):
    limiter = RateLimiter(limit=3, window_seconds=100, clock=lambda: 0.0)
    fake = FakeDeepSeek([{"role": "assistant", "content": "回答"} for _ in range(10)])
    override_deps(client, limiter=limiter, deepseek=make_client(fake),
                  service=make_service(FakeIda()))

    for i in range(3):
        res = client.post("/api/ai/chat", json={"message": f"第 {i + 1} 轮"})
        assert res.status_code == 200, res.text
        assert res.json()["remaining"] == 2 - i

    blocked = client.post("/api/ai/chat", json={"message": "第四轮"})
    assert blocked.status_code == 429
    assert blocked.json()["detail"]["code"] == "ai_quota_exceeded"
    assert blocked.json()["detail"]["quota"]["remaining"] == 0
    # 被拒的那次不该消耗额度
    assert limiter.snapshot("ip:testclient")["used"] == 3


def test_chat_uses_account_identity_when_logged_in(client):
    limiter = RateLimiter(limit=3, window_seconds=100, clock=lambda: 0.0)
    fake = FakeDeepSeek([{"role": "assistant", "content": "回答"}])
    override_deps(client, limiter=limiter, deepseek=make_client(fake),
                  service=make_service(FakeIda()))

    register(client, "ai测试员")          # 首个账号 bootstrap 成 superadmin
    res = client.post("/api/ai/chat", json={"message": "你好"})
    assert res.status_code == 200, res.text
    assert limiter.snapshot("account:1")["used"] == 1, "登录后应按账号计配额"


def test_chat_success_shape(client):
    limiter = RateLimiter(limit=3, window_seconds=100, clock=lambda: 0.0)
    fake = FakeDeepSeek([
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "c1", "type": "function",
             "function": {"name": "survey_binary", "arguments": "{}"}},
        ]},
        {"role": "assistant", "content": "这是 bedrock_server.exe。"},
    ])
    override_deps(client, limiter=limiter, deepseek=make_client(fake),
                  service=make_service(FakeIda()))

    res = client.post("/api/ai/chat", json={
        "message": "我在看什么",
        "context": {"module": "bedrock_server.exe", "selected_name": "main",
                    "selected_addr": "0x7ff6871d3b90"},
    })

    assert res.status_code == 200, res.text
    body = res.json()
    assert "bedrock_server.exe" in body["reply"]
    assert body["tool_calls"][0]["name"] == "survey_binary"
    assert body["tool_calls"][0]["label"] == "读取二进制概览"
    assert body["limit"] == 3 and body["remaining"] == 2
    assert body["truncated"] is False
    # messages 回传给前端存续，且不含 system
    assert body["messages"][0]["role"] == "user"
    assert all(m["role"] != "system" for m in body["messages"])


def test_chat_validates_message_length(client):
    res = client.post("/api/ai/chat", json={"message": "x" * 5000})
    assert res.status_code == 422


def test_chat_rejects_empty_message(client):
    res = client.post("/api/ai/chat", json={"message": ""})
    assert res.status_code == 422
