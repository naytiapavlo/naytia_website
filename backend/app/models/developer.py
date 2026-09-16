"""开发者 API 模块的表：API 密钥（开放工具 API，见 docs/plans/08）。

只存密钥的 SHA-256，明文仅在签发响应里出现一次。
"""
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from .account import utcnow
from ..db import Base


class ApiKey(Base):
    __tablename__ = "api_keys"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    key_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(64))
    # anonymous / standard：standard 为持有密钥的更高限额档
    tier: Mapped[str] = mapped_column(String(16), default="standard")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_by: Mapped[int | None] = mapped_column(
        ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
