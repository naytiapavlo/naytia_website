"""工具箱模块的表：收藏（归属 toolbox 模块）。"""
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from .account import utcnow
from ..db import Base


class ToolFavorite(Base):
    """工具箱收藏（按账号隔离，01 文档第 6 节）。"""

    __tablename__ = "tool_favorites"

    account_id: Mapped[int] = mapped_column(
        ForeignKey("accounts.id", ondelete="CASCADE"), primary_key=True
    )
    tool_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
