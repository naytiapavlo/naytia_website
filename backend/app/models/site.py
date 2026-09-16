"""站点配置模块的表：超级管理员可编辑的主页内容（ADR-002）。

单行键值设计：key='site'，data 为 JSON 文本（只存覆盖项，
默认值由前端 defaults 提供，保证静态站离线可用）。
"""
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from .account import utcnow
from ..db import Base


class SiteConfigEntry(Base):
    __tablename__ = "site_config"

    key: Mapped[str] = mapped_column(String(32), primary_key=True)
    data: Mapped[str] = mapped_column(Text)
    updated_by: Mapped[int | None] = mapped_column(
        ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True
    )
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
