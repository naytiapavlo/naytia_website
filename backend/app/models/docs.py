"""文档树模块的表：文件夹、文档文件、变更提交与版本（归属 docs 模块）。

设计要点（开发日志见 docs/plans/09-开发日志-文档树工具.md）：
- **树形结构用邻接表**（`parent_id` + `path_key` 物化路径），因为首版要按路径唯一、
  要能按目录前缀搜索，也不引入递归 CTE；树规模是「一个人写的文档」，邻接表足够。
- **正文留在库里**（`doc_revisions.body`）：正文是可搜索的文本，SQLite 的 LIKE
  对几 MB 文本完全够用；二进制大文件走 `storage_path` 落盘，库里只留元数据。
- **草稿与已发布是同一张表上的开关**（`is_published`），而不是两张表：
  审核发布只是一次状态翻转，不需要在两张表之间搬正文。
- **变更走提交单**（`doc_submissions`）：管理员不直接改线上内容，
  提交单被超管批准后才写进 folders/documents/revisions（见 docs/plans/09 第 4 节）。
"""
from datetime import datetime
from typing import Any, Literal

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..db import Base
from .account import utcnow

# 可见性：公开（含未登录访客）/ 仅登录会员 / 仅管理员及以上
VISIBILITIES = ("public", "members", "staff")

# 提交动作与目标
ACTIONS = (
    "create_doc",
    "update_doc",
    "move_doc",
    "create_folder",
    "move_folder",
    "delete_doc",
    "delete_folder",
)
TARGET_KINDS = ("document", "folder")

# 审核状态：待审 / 已通过 / 已驳回 / 已撤回（提交人自己撤销）
SUBMISSION_STATUSES = ("pending", "approved", "rejected", "withdrawn")


class DocFolder(Base):
    """文档树里的文件夹。根目录不存在于表中，用 `parent_id IS NULL` 表示。"""

    __tablename__ = "doc_folders"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    parent_id: Mapped[int | None] = mapped_column(
        ForeignKey("doc_folders.id", ondelete="CASCADE"), nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(String(120))
    # 物化路径：'/' 拼接的各级文件夹名（不含根）。用来做同级唯一与前缀搜索。
    path_key: Mapped[str] = mapped_column(String(512), unique=True, index=True)
    visibility: Mapped[str] = mapped_column(String(16), default="public", index=True)
    # 排序权重；同权重按 name 排，保证目录顺序稳定可复现
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    is_published: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    created_by: Mapped[int | None] = mapped_column(
        ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )


class DocFile(Base):
    """上传的实体文件。首版只落盘 md/json/txt；非文本一律拒绝（见 storage.is_allowed_text）。"""

    __tablename__ = "doc_files"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    original_name: Mapped[str] = mapped_column(String(255))
    content_type: Mapped[str] = mapped_column(String(128), default="text/plain")
    doc_format: Mapped[str] = mapped_column(String(16), default="txt")
    byte_size: Mapped[int] = mapped_column(Integer, default=0)
    sha256: Mapped[str] = mapped_column(String(64), default="", index=True)
    # 相对 storage_root 的路径；不对外暴露（下载走 /api/docs/files/{id}/download）
    storage_path: Mapped[str] = mapped_column(String(512))
    text_content: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_text: Mapped[bool] = mapped_column(Boolean, default=True)
    uploaded_by: Mapped[int | None] = mapped_column(
        ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class DocDocument(Base):
    """文档树里的一篇文档。正文在 DocRevision，本表只存指针与元数据。"""

    __tablename__ = "doc_documents"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    parent_id: Mapped[int | None] = mapped_column(
        ForeignKey("doc_folders.id", ondelete="CASCADE"), nullable=True, index=True
    )
    slug: Mapped[str] = mapped_column(String(160), index=True)
    # 同级唯一键：'<父路径>/<slug>'
    path_key: Mapped[str] = mapped_column(String(640), unique=True, index=True)
    title: Mapped[str] = mapped_column(String(200))
    summary: Mapped[str] = mapped_column(String(500), default="")
    doc_format: Mapped[str] = mapped_column(String(16), default="md")
    visibility: Mapped[str] = mapped_column(String(16), default="public", index=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    is_published: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    current_revision_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    current_file_id: Mapped[int | None] = mapped_column(
        ForeignKey("doc_files.id", ondelete="SET NULL"), nullable=True
    )
    created_by: Mapped[int | None] = mapped_column(
        ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow
    )


class DocRevision(Base):
    """文档的一次内容版本。每次发布落一条，正文存库以便全文检索与回溯。"""

    __tablename__ = "doc_revisions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    document_id: Mapped[int] = mapped_column(
        ForeignKey("doc_documents.id", ondelete="CASCADE"), index=True
    )
    revision_no: Mapped[int] = mapped_column(Integer, default=1)
    title: Mapped[str] = mapped_column(String(200), default="")
    body: Mapped[str] = mapped_column(Text, default="")
    doc_format: Mapped[str] = mapped_column(String(16), default="md")
    byte_size: Mapped[int] = mapped_column(Integer, default=0)
    file_id: Mapped[int | None] = mapped_column(
        ForeignKey("doc_files.id", ondelete="SET NULL"), nullable=True
    )
    note: Mapped[str] = mapped_column(String(500), default="")
    edited_by: Mapped[int | None] = mapped_column(
        ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class DocSubmission(Base):
    """管理员提交的变更单：超管批准后才真正写进 folders/documents/revisions。

    提交单保存的是**提案快照**（`payload` 里存 file_id / 标题 / 理由等），
    所以批准时会重新校验一次目标是否还存在、路径是否冲突——两次提交抢同一个
    路径时不至于写坏树，而是把后一条标成 rejected 并给出原因。
    """

    __tablename__ = "doc_submissions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    action: Mapped[str] = mapped_column(String(24), index=True)
    target_kind: Mapped[str] = mapped_column(String(16))
    target_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    parent_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    title: Mapped[str] = mapped_column(String(200), default="")
    name: Mapped[str] = mapped_column(String(120), default="")
    summary: Mapped[str] = mapped_column(String(500), default="")
    visibility: Mapped[str] = mapped_column(String(16), default="public")
    file_id: Mapped[int | None] = mapped_column(
        ForeignKey("doc_files.id", ondelete="SET NULL"), nullable=True
    )
    note: Mapped[str] = mapped_column(String(500), default="")
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    submitted_by: Mapped[int | None] = mapped_column(
        ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True, index=True
    )
    reviewed_by: Mapped[int | None] = mapped_column(
        ForeignKey("accounts.id", ondelete="SET NULL"), nullable=True
    )
    review_note: Mapped[str] = mapped_column(String(500), default="")
    reviewed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    applied_document_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    applied_folder_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    file: Mapped[DocFile | None] = relationship()


def next_path_key(parent_path: str, segment: str) -> str:
    """拼出同级唯一键；根目录下就是段名本身。"""
    return f"{parent_path}/{segment}" if parent_path else segment


Visibility = Literal["public", "members", "staff"]
Action = Literal["create_doc", "update_doc", "create_folder", "delete_doc", "delete_folder"]
SubmissionStatus = Literal["pending", "approved", "rejected", "withdrawn"]
