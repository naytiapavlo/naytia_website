"""论坛模块的表：帖子与回复（归属 forum 模块）。"""
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .account import utcnow
from ..db import Base


class ForumThread(Base):
    __tablename__ = "forum_threads"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    category_id: Mapped[str] = mapped_column(String(32), index=True)
    title: Mapped[str] = mapped_column(String(128))
    body: Mapped[str] = mapped_column(String(8000))
    author_id: Mapped[int] = mapped_column(
        ForeignKey("accounts.id", ondelete="CASCADE"), index=True
    )
    # published / deleted；软删除保留审计线索
    status: Mapped[str] = mapped_column(String(16), default="published")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_activity_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow
    )

    author: Mapped["Account"] = relationship()
    replies: Mapped[list["ForumReply"]] = relationship(
        back_populates="thread", cascade="all, delete-orphan"
    )


class ForumReply(Base):
    __tablename__ = "forum_replies"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    thread_id: Mapped[int] = mapped_column(
        ForeignKey("forum_threads.id", ondelete="CASCADE"), index=True
    )
    author_id: Mapped[int] = mapped_column(
        ForeignKey("accounts.id", ondelete="CASCADE"), index=True
    )
    body: Mapped[str] = mapped_column(String(8000))
    status: Mapped[str] = mapped_column(String(16), default="published")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    thread: Mapped[ForumThread] = relationship(back_populates="replies")
    author: Mapped["Account"] = relationship()


# 列表页排序键：按最近活动倒序的稳定 keyset 分页
Index("ix_threads_activity", ForumThread.last_activity_at, ForumThread.id)
