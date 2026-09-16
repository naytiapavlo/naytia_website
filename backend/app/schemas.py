"""Pydantic schema：API 请求/响应契约，是 OpenAPI → 前端 TS 类型的来源（ADR-001）。"""
from datetime import datetime

from pydantic import BaseModel, Field, field_validator

from .config import BODY_MAX, FORUM_CATEGORIES, PASSWORD_MIN, TITLE_MAX, USERNAME_MAX

USERNAME_PATTERN = r"^[A-Za-z0-9_\u4e00-\u9fa5]{2,16}$"


class AccountCreate(BaseModel):
    username: str = Field(
        pattern=USERNAME_PATTERN,
        min_length=2,
        max_length=USERNAME_MAX,
        description="2-16 位字母、数字、下划线或中文",
    )
    password: str = Field(min_length=PASSWORD_MIN, max_length=128)


class LoginRequest(BaseModel):
    username: str
    password: str


class AccountSummary(BaseModel):
    id: int
    username: str
    created_at: datetime


class ReplySummary(BaseModel):
    id: int
    author: str
    body: str
    created_at: datetime


class ThreadCreate(BaseModel):
    category: str
    title: str = Field(min_length=2, max_length=TITLE_MAX)
    body: str = Field(min_length=2, max_length=BODY_MAX)

    @field_validator("category")
    @classmethod
    def category_known(cls, v: str) -> str:
        if v not in FORUM_CATEGORIES:
            raise ValueError(f"未知版块：{v}")
        return v


class ReplyCreate(BaseModel):
    body: str = Field(min_length=2, max_length=BODY_MAX)


class ThreadSummary(BaseModel):
    id: int
    category: str
    title: str
    author: str
    reply_count: int
    created_at: datetime
    last_activity_at: datetime


class ThreadDetail(ThreadSummary):
    body: str
    replies: list[ReplySummary]


class PageResult(BaseModel):
    """稳定分页语义（03 文档第 3 节）。"""

    items: list[ThreadSummary]
    next_cursor: str | None = None


class FavoriteList(BaseModel):
    tools: list[str]


class ApiError(BaseModel):
    """结构化错误（03 文档第 5 节 ToolError 风格）。"""

    code: str
    message: str
