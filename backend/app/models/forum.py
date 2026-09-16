"""论坛模块的表：帖子、回复与结构附件（归属 forum 模块）。"""
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
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
    structure: Mapped["ForumStructure | None"] = relationship(
        back_populates="thread", cascade="all, delete-orphan", uselist=False
    )
    cover: Mapped["ForumCover | None"] = relationship(
        back_populates="thread", cascade="all, delete-orphan", uselist=False
    )


class ForumStructure(Base):
    """帖子附带的一个 .mcstructure 结构文件（一个帖子最多一个）。

    为什么单独一张表而不是给 ForumThread 加几列：附件的字段全是
    「解析结果的快照」，会随解析器口径变化；放进帖子表会让每次调整
    摘要结构都动到论坛主表。一对一关系表达得更准确，删除帖子级联清掉即可。

    路径不出库、更不出接口：`storage_path` / `render_path` 只在本模块内使用，
    对外一律用帖子 id 换（见 routers/forum.py 的下载与预览路由）。
    """

    __tablename__ = "forum_structures"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    thread_id: Mapped[int] = mapped_column(
        ForeignKey("forum_threads.id", ondelete="CASCADE"), unique=True, index=True
    )

    # 用户看到的原始文件名（已清洗）；落盘名与它无关，见 forum_storage
    original_name: Mapped[str] = mapped_column(String(180))
    byte_size: Mapped[int] = mapped_column(Integer)
    # 内容摘要，用于内容寻址与「同一个文件是否已被引用」的判定
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    storage_path: Mapped[str] = mapped_column(String(255))
    # gzip 后的 3D 预览载荷；解析时判定「太大不生成预览」则为 NULL
    render_path: Mapped[str | None] = mapped_column(String(255), default=None)
    render_bytes: Mapped[int] = mapped_column(Integer, default=0)
    render_available: Mapped[bool] = mapped_column(Boolean, default=False)

    # 内置解析器（parsers/mcstructure.py）算出来的摘要：尺寸、材料清单、统计。
    # 存 JSON 文本而不是拆成几十列：这些字段是**快照**，解析器口径升级后
    # 旧记录保持原样即可读，拆列反而要做迁移。展示所需的最小集合另有显式列
    # （上面的 byte_size / render_available），不必解析 JSON 就能列表页过滤。
    summary_json: Mapped[str] = mapped_column(Text)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    thread: Mapped[ForumThread] = relationship(back_populates="structure")


class ForumCover(Base):
    """帖子封面：一张图片（一个帖子最多一张）。

    为什么又单开一张表而不是给 `forum_threads` 加几列：`Base.metadata.create_all`
    **只建新表，不会给已有的表加列**。往 `forum_threads` 加列会让所有已经存在的
    数据库（包括开发者本机的 `data/app.db`）在第一次查询时报「no such column」，
    而这个项目没有迁移工具。新表则是不动旧数据就能生效的。

    图片的**类型与尺寸来自字节本身**（`parsers/image_info`），不是文件名：
    用户可以随便改名，`content_type` / `extension` 都是识别出来的结果。
    """

    __tablename__ = "forum_covers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    thread_id: Mapped[int] = mapped_column(
        ForeignKey("forum_threads.id", ondelete="CASCADE"), unique=True, index=True
    )

    # 用户看到的原始文件名（已清洗）；落盘名与它无关，见 forum_storage
    original_name: Mapped[str] = mapped_column(String(180))
    byte_size: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    storage_path: Mapped[str] = mapped_column(String(255))

    # 由字节判定：image/png 等；扩展名同样是判定结果，用于展示与落盘
    content_type: Mapped[str] = mapped_column(String(32))
    extension: Mapped[str] = mapped_column(String(8))
    width: Mapped[int] = mapped_column(Integer)
    height: Mapped[int] = mapped_column(Integer)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    thread: Mapped[ForumThread] = relationship(back_populates="cover")


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
