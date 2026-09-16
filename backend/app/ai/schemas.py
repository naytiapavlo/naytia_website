"""AI 助手的 API 契约。"""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

MAX_MESSAGE_CHARS = 4000


class WorkspaceContext(BaseModel):
    """前端把当前工作台状态一起传上来，模型就能直接用，不用先问"你在看哪个函数"。"""

    module: str | None = Field(default=None, max_length=200)
    base_address: str | None = Field(default=None, max_length=40)
    selected_name: str | None = Field(default=None, max_length=400)
    selected_addr: str | None = Field(default=None, max_length=40)
    total_functions: int | None = None


class ChatMessage(BaseModel):
    """对话历史里的一条。tool 角色的消息由服务端生成，前端只需原样回传。"""

    role: Literal["user", "assistant", "tool"]
    content: str = Field(default="", max_length=20000)
    tool_calls: list[dict[str, Any]] | None = None
    tool_call_id: str | None = None


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=MAX_MESSAGE_CHARS,
                         description="用户这一轮的问题")
    history: list[ChatMessage] = Field(default_factory=list, max_length=40,
                                       description="之前的对话（原样回传，服务端会截断）")
    context: WorkspaceContext | None = None
    port: int | None = Field(default=None, description="IDA 实例端口；省略则用当前实例")


class ToolCallInfo(BaseModel):
    name: str
    label: str
    args: dict[str, Any] = Field(default_factory=dict)
    ok: bool = True


class ChatResponse(BaseModel):
    reply: str
    messages: list[ChatMessage] = Field(default_factory=list,
                                        description="更新后的对话历史，前端存下来下次回传")
    tool_calls: list[ToolCallInfo] = Field(default_factory=list)
    remaining: int = Field(description="本窗口内还剩几轮")
    limit: int = Field(description="窗口内的总轮数上限")
    reset_in: float = Field(description="最早一次使用还有多少秒出窗口")
    truncated: bool = Field(default=False, description="是否因工具调用轮数用尽而中断")


class QuotaInfo(BaseModel):
    configured: bool = Field(description="服务端是否配了 DeepSeek API key")
    limit: int
    used: int
    remaining: int
    reset_in: float
    identity: Literal["account", "ip"]
