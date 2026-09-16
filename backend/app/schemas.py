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
    # 超级管理员引导邀请码（可选；见 config.superadmin_code）
    code: str | None = Field(default=None, max_length=64)


class RoleUpdate(BaseModel):
    role: str = Field(pattern="^(member|admin|superadmin)$")


class BackgroundConfig(BaseModel):
    """主页背景：image 模式直接用 URL，支持 GIF/WebP/APNG 等动图格式（ADR-002）。"""

    mode: str = Field(default="none", pattern="^(none|image)$")
    url: str | None = Field(default=None, max_length=2048)
    # 遮罩不透明度：动图背景上压一层暗色保证文字可读
    overlay: float = Field(default=0.35, ge=0, le=0.9)

    @field_validator("url")
    @classmethod
    def url_https_only(cls, v: str | None) -> str | None:
        if v is not None and not v.lower().startswith(("http://", "https://")):
            raise ValueError("背景/头像地址必须是 http(s) 链接")
        return v


class SiteConfigUpdate(BaseModel):
    """超级管理员可修改的主页内容；None 字段表示不修改。"""

    display_name: str | None = Field(default=None, min_length=1, max_length=24)
    intro: str | None = Field(default=None, max_length=400)
    avatar_url: str | None = Field(default=None, max_length=2048)
    background: BackgroundConfig | None = None

    @field_validator("avatar_url")
    @classmethod
    def avatar_https_only(cls, v: str | None) -> str | None:
        if v is not None and not v.lower().startswith(("http://", "https://")):
            raise ValueError("头像地址必须是 http(s) 链接")
        return v


class LoginRequest(BaseModel):
    username: str
    password: str


class AccountSummary(BaseModel):
    id: int
    username: str
    role: str
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
