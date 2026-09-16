"""AI 助手的 agent 循环。

一轮对话 = 用户发一条消息 → 模型可能多次请求工具 → 直到给出自然语言回答。
工具全部是只读的（见 tools.py），所以这个 agent 只能"看"，不能改 IDA 里的任何东西。
"""
from __future__ import annotations

import json
from typing import Any

from ..config import get_settings
from ..reverse.client import ReverseService
from ..reverse.mcp_client import IdaMcpError
from .deepseek import AiError, DeepSeekClient
from .tools import HANDLERS, TOOL_LABELS, TOOL_SPECS

SYSTEM_PROMPT = """你是一个 Minecraft 基岩版服务端（BDS）的逆向分析助手，嵌在一个仿 IDA 的网页工作台里。

规则：
1. **先查再答**。涉及具体地址、函数名、反编译内容时，必须调用工具取得真实数据；
   绝不凭函数名猜测实现、绝不编造地址或伪代码。
2. 工具返回的是原始数据（伪代码、汇编、引用列表）。你要做的是**解释它**，
   用中文讲清楚这段代码在做什么，而不是把原文照抄回去。
3. 拿不准就说不确定，并说明还需要查什么。
4. 用户帖的伪代码里 /*0xADDR*/ 形式的是行内地址，可用于指出具体行。
5. 你只能查询，不能修改（改名、打补丁都不行）。如果用户要求修改，
   说明需要 admin 权限在工作台里手动操作。

回答用简洁的中文，必要时用短列表；代码片段保持原样。"""


def _clip_history(messages: list[dict[str, Any]], max_messages: int,
                  max_chars: int) -> list[dict[str, Any]]:
    """保留最近的若干条消息，并控制总字符数，避免把上下文撑爆。"""
    recent = messages[-max_messages:]
    total = 0
    kept: list[dict[str, Any]] = []
    for message in reversed(recent):
        size = len(str(message.get("content") or ""))
        if kept and total + size > max_chars:
            break
        total += size
        kept.append(message)
    kept.reverse()
    return kept


def _workspace_context(context: dict[str, Any] | None) -> str:
    """把前端当前的工作台状态写成一段上下文，省得模型每次都先问"你在看哪个函数"。"""
    if not context:
        return ""
    parts: list[str] = []
    if context.get("module"):
        parts.append(f"当前二进制：{context['module']}")
    if context.get("base_address"):
        parts.append(f"基址：{context['base_address']}")
    if context.get("selected_name"):
        addr = context.get("selected_addr") or ""
        parts.append(f"用户当前选中的函数：{context['selected_name']}（{addr}）")
    if context.get("total_functions"):
        parts.append(f"函数总数：{context['total_functions']}")
    if not parts:
        return ""
    return "[工作台当前状态]\n" + "\n".join(f"- {p}" for p in parts)


def _public_history(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """挑出可以回传给前端的消息：去掉服务端自己拼的 system 消息。

    前端把这份历史存进 localStorage，下一轮原样传回来；schema 只接受
    user / assistant / tool 三种角色，混进 system 会直接 422。
    """
    return [m for m in messages if m.get("role") != "system"]


class AiAgent:
    def __init__(self, client: DeepSeekClient, service: ReverseService) -> None:
        self.client = client
        self.service = service

    async def run(
        self,
        user_message: str,
        history: list[dict[str, Any]] | None = None,
        context: dict[str, Any] | None = None,
        port: int | None = None,
    ) -> dict[str, Any]:
        """跑完一轮，返回 {reply, messages, tool_calls}。

        - reply：模型的最终自然语言回答
        - messages：完整对话（含工具调用），前端存下来下次一起回传
        - tool_calls：本次用到的工具名，供前端展示"查了什么"
        """
        settings = get_settings()
        messages: list[dict[str, Any]] = [{"role": "system", "content": SYSTEM_PROMPT}]
        messages.extend(_clip_history(history or [], settings.ai_max_messages, settings.ai_max_chars))

        # 工作台上下文放在 user 消息**之前**的独立 system 消息里，
        # 不拼进用户那句话——否则前端把历史原样显示时，用户的提问气泡里会
        # 混进一大段"[工作台当前状态]…"，很难看。
        workspace = _workspace_context(context)
        if workspace:
            messages.append({"role": "system", "content": workspace})
        messages.append({"role": "user", "content": user_message})

        used_tools: list[dict[str, Any]] = []

        for round_index in range(settings.ai_max_tool_rounds):
            message = await self.client.chat(messages, tools=TOOL_SPECS)
            tool_calls = message.get("tool_calls") or []

            if not tool_calls:
                reply = (message.get("content") or "").strip()
                messages.append({"role": "assistant", "content": reply})
                return {
                    "reply": reply or "（模型没有返回内容）",
                    # 只回传对话双方的可见消息：system 是服务端拼的，
                    # 前端既不需要存也别再传回来（schema 只收 user/assistant/tool）。
                    "messages": _public_history(messages),
                    "tool_calls": used_tools,
                    "rounds": round_index,
                    "truncated": False,
                }

            # 把 assistant 的 tool_calls 消息原样放回历史（协议要求）
            messages.append({
                "role": "assistant",
                "content": message.get("content") or "",
                "tool_calls": tool_calls,
            })

            for call in tool_calls:
                name = (call.get("function") or {}).get("name") or ""
                args = DeepSeekClient.parse_tool_arguments((call.get("function") or {}).get("arguments"))
                result_text, ok = await self._execute(name, args, port)
                used_tools.append({
                    "name": name,
                    "label": TOOL_LABELS.get(name, name),
                    "args": args,
                    "ok": ok,
                })
                messages.append({
                    "role": "tool",
                    "tool_call_id": call.get("id") or name,
                    "content": result_text,
                })

        # 工具调用轮数用尽：如实告知，不假装给出了结论
        return {
            "reply": "分析步骤太多，这一轮没能得出结论。可以把问题问得更具体（例如直接指定函数名），"
                     "或者在工作台里先选中目标函数再问我。",
            "messages": _public_history(messages),
            "tool_calls": used_tools,
            "rounds": settings.ai_max_tool_rounds,
            "truncated": True,
        }

    async def _execute(self, name: str, args: dict[str, Any],
                       port: int | None) -> tuple[str, bool]:
        handler = HANDLERS.get(name)
        if handler is None:
            # 模型可能会"发明"不存在的工具名，明确拒绝而不是崩溃
            return json.dumps({"error": f"没有这个工具：{name}"}, ensure_ascii=False), False
        try:
            result = await handler(self.service, args, port)
            return json.dumps(result, ensure_ascii=False, default=str), True
        except IdaMcpError as exc:
            return json.dumps({"error": str(exc)}, ensure_ascii=False), False
        except Exception as exc:  # noqa: BLE001 —— 单个工具失败不该毁掉整轮对话
            return json.dumps({"error": f"工具执行失败：{exc}"}, ensure_ascii=False), False
