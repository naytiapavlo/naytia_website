"""DeepSeek 客户端：OpenAI 兼容的 /chat/completions，支持 function calling。

为什么用 httpx 而不是 openai SDK：本项目依赖清单是显式锁定的
（04 文档第 1 节第 3 条），`openai` 不在其中；而 httpx 已随逆向工作台
进入运行期依赖，测试里还能用 MockTransport 假扮接口，不依赖真实额度。

接口契约（2026-09-16 核对官方文档 https://api-docs.deepseek.com/guides/tool_calls/）：
- POST {base}/chat/completions，Authorization: Bearer <key>
- 请求：{model, messages, tools, tool_choice, temperature, max_tokens}
- 响应：choices[0].message，可能含 tool_calls[{id, function:{name, arguments}}]
- 执行完工具后，把结果以 {"role":"tool", "tool_call_id":…, "content":…} 追加，
  并把 assistant 的 tool_calls 消息原样放回历史，再次请求。
"""
from __future__ import annotations

import json
from typing import Any

import httpx

from ..config import get_settings


class AiError(RuntimeError):
    """AI 调用失败。由路由层转成结构化 HTTP 错误。"""

    def __init__(self, message: str, *, code: str = "ai_error", status: int = 502) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


class DeepSeekClient:
    def __init__(self, api_key: str | None = None, base_url: str | None = None,
                 model: str | None = None, timeout: float | None = None,
                 transport: httpx.AsyncBaseTransport | None = None) -> None:
        settings = get_settings()
        self.api_key = api_key if api_key is not None else settings.deepseek_api_key
        self.base_url = (base_url or settings.deepseek_base_url).rstrip("/")
        self.model = model or settings.deepseek_model
        self.timeout = timeout or settings.deepseek_timeout
        # 仅为可测试性保留：测试注入 MockTransport
        self._transport = transport

    @property
    def configured(self) -> bool:
        return bool(self.api_key.strip())

    async def chat(
        self,
        messages: list[dict[str, Any]],
        *,
        tools: list[dict[str, Any]] | None = None,
        temperature: float = 0.2,
        max_tokens: int = 2048,
    ) -> dict[str, Any]:
        """调一次 /chat/completions，返回 message 对象。"""
        if not self.configured:
            raise AiError(
                "站点还没有配置 DeepSeek API key，AI 助手暂不可用",
                code="ai_not_configured",
                status=503,
            )

        payload: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": False,
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        try:
            async with httpx.AsyncClient(timeout=self.timeout,
                                         transport=self._transport) as client:
                resp = await client.post(
                    f"{self.base_url}/chat/completions", json=payload, headers=headers
                )
        except httpx.TimeoutException as exc:
            raise AiError("AI 响应超时，请稍后重试或把问题问得更具体",
                          code="ai_timeout", status=504) from exc
        except httpx.HTTPError as exc:
            raise AiError(f"连接不上 AI 服务：{exc}", code="ai_unreachable", status=502) from exc

        if resp.status_code == 401:
            raise AiError("DeepSeek API key 无效或已过期", code="ai_bad_key", status=502)
        if resp.status_code == 429:
            raise AiError("AI 服务限流，请稍后重试", code="ai_upstream_rate_limited", status=429)
        if resp.status_code >= 400:
            detail = resp.text[:300]
            raise AiError(f"AI 服务返回 {resp.status_code}：{detail}", code="ai_upstream_error")

        try:
            body = resp.json()
        except ValueError as exc:
            raise AiError("AI 服务返回了无法解析的内容", code="ai_bad_response") from exc

        choices = body.get("choices") or []
        if not choices:
            raise AiError("AI 服务没有返回任何回复", code="ai_empty_response")
        return choices[0].get("message") or {}

    @staticmethod
    def parse_tool_arguments(raw: Any) -> dict[str, Any]:
        """工具参数是 JSON 字符串；模型偶尔给出空串或坏 JSON，这里一律容错成空参数。"""
        if isinstance(raw, dict):
            return raw
        if not isinstance(raw, str) or not raw.strip():
            return {}
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
