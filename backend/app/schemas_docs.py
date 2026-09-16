"""文档树接口的 pydantic 契约（OpenAPI 的单一事实源，见 docs/plans/03）。

前端不手写重复字段：`src/modules/docs/api.ts` 的接口形状与本文件一一对应，
字段变更时两边一起改（`npm run api:types` 可重新生成全量类型）。
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

Visibility = Literal["public", "members", "staff"]
DocFormat = Literal["md", "txt", "json"]
SubmissionAction = Literal[
    "create_doc",
    "update_doc",
    "move_doc",
    "create_folder",
    "move_folder",
    "delete_doc",
    "delete_folder",
]
SubmissionStatus = Literal["pending", "approved", "rejected", "withdrawn"]


# ----------------------------------------------------------------- 读取（公开）

class FileRefOut(BaseModel):
    """上传文件的可公开元数据。storage_path 永不外泄，只给下载用的 id。"""

    id: int
    name: str
    doc_format: DocFormat
    byte_size: int
    sha256: str
    created_at: datetime


class DocumentOut(BaseModel):
    id: int
    parent_id: int | None
    slug: str
    title: str
    summary: str
    doc_format: DocFormat
    visibility: Visibility
    updated_at: datetime
    published: bool
    file: FileRefOut


class FolderOut(BaseModel):
    id: int
    parent_id: int | None
    name: str
    path: str
    visibility: Visibility
    created_at: datetime
    updated_at: datetime
    published: bool


class FolderNode(FolderOut):
    """目录树节点：children 是子文件夹，documents 是本层文档（不含正文）。"""

    children: list["FolderNode"] = Field(default_factory=list)
    documents: list[DocumentOut] = Field(default_factory=list)


class TreeStats(BaseModel):
    folders: int
    documents: int
    published_documents: int
    total_bytes: int


class TreeResponse(BaseModel):
    """目录树。visitor 是「你现在以什么身份看这份树」，用于前端提示。"""

    root: FolderNode
    stats: TreeStats
    viewer_role: str | None


class DocumentDetail(DocumentOut):
    """文档详情：多出正文与版本信息。"""

    body: str
    revision_no: int
    revision_at: datetime | None
    byte_size: int


class SearchHit(BaseModel):
    id: int
    title: str
    path: str
    doc_format: DocFormat
    snippet: str


class SearchResponse(BaseModel):
    query: str
    total: int
    truncated: bool
    hits: list[SearchHit]


class DocsPermissions(BaseModel):
    """当前账号在本工具里的能力。前端据此决定显示哪些按钮；服务端另有强制校验。"""

    role: str | None
    can_read_drafts: bool
    can_upload: bool
    can_submit: bool
    can_review: bool
    can_publish_directly: bool
    # 移动 / 重命名 / 删除：管理员走提交单（can_submit），超管直接生效（can_publish_directly）
    can_organize: bool
    can_delete: bool


class DocsInfo(BaseModel):
    """能力边界与限制，便于界面如实交代「我们做了什么、没做什么」。"""

    allowed_extensions: list[str]
    max_bytes: int
    max_bytes_label: str
    storage_dir: str
    search_limit: int
    review_required: bool
    notes: list[str]


# ----------------------------------------------------------------- 管理员写入

class UploadInitIn(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    total_bytes: int | None = Field(default=None, ge=0)
    chunk_size: int | None = Field(default=None, ge=1)


class UploadInitOut(BaseModel):
    upload_id: str
    chunk_size: int
    max_bytes: int
    doc_format: DocFormat


class UploadChunkOut(BaseModel):
    upload_id: str
    received_bytes: int
    chunks: int


class FileUploadOut(BaseModel):
    file: FileRefOut
    doc_format: DocFormat
    text_content: str | None
    preview_lines: int


class SubmitIn(BaseModel):
    """一次变更提交。

    - action=create_doc：需要 `file_id` 或 `body`，`parent_id` 指定目录（None=根）
    - action=create_folder：需要 `name`
    - action=move_doc / move_folder：需要 `document_id` / `folder_id` 与目标 `parent_id`
      （`parent_id=None` 表示移到根目录）
    - action=update_doc / delete_doc / delete_folder：需要 `document_id` / `folder_id`
    """

    action: SubmissionAction
    parent_id: int | None = None
    document_id: int | None = None
    folder_id: int | None = None
    title: str | None = Field(default=None, max_length=200)
    name: str | None = Field(default=None, max_length=120)
    summary: str | None = Field(default=None, max_length=500)
    visibility: Visibility = "public"
    file_id: int | None = None
    body: str | None = None
    note: str = Field(default="", max_length=500)


class MoveIn(BaseModel):
    """把文档或文件夹移到另一个目录。`parent_id=None` 表示移到根目录。"""

    document_id: int | None = None
    folder_id: int | None = None
    parent_id: int | None = None
    note: str = Field(default="", max_length=500)


class RenameIn(BaseModel):
    """重命名文档标题 / 文件夹名称（路径键会跟着更新，并连带改写子树）。"""

    title: str | None = Field(default=None, max_length=200)
    name: str | None = Field(default=None, max_length=120)
    note: str = Field(default="", max_length=500)


class DirectActionOut(BaseModel):
    """超管直接执行的结果。`submission` 为 null 表示没有走提交单（直接生效）。"""

    ok: bool
    message: str
    document_id: int | None = None
    folder_id: int | None = None
    path: str | None = None
    affected_documents: int = 0


class SubmissionOut(BaseModel):
    id: int
    action: SubmissionAction
    status: SubmissionStatus
    target_kind: str
    document_id: int | None
    folder_id: int | None
    parent_id: int | None
    parent_path: str | None
    # 目标位置的显示路径（移动类提交单用）：'漏洞bug分析/8848yyds' 或 '（根目录）'
    target_path: str | None
    title: str
    name: str
    summary: str
    visibility: Visibility
    note: str
    file: FileRefOut | None
    body_preview: str
    submitted_by: int | None
    submitted_by_name: str | None
    created_at: datetime
    reviewed_by: int | None
    reviewed_by_name: str | None
    review_note: str
    reviewed_at: datetime | None
    applied_document_id: int | None
    applied_folder_id: int | None


class SubmissionListOut(BaseModel):
    items: list[SubmissionOut]
    pending_total: int


class ReviewIn(BaseModel):
    decision: Literal["approve", "reject"]
    note: str = Field(default="", max_length=500)


class ReviewOut(BaseModel):
    submission: SubmissionOut
    message: str
