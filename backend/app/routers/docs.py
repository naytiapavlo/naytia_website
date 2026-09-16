"""文档树的公开读取与管理员提交接口。

权限矩阵（服务端强制，前端隐藏按钮只是界面便利）：
| 身份 | 能力 |
| --- | --- |
| 访客（未登录） | 读已发布且 visibility=public 的目录、正文、搜索 |
| 登录会员 | 同上（visibility=members 也对会员开放） |
| 管理员 admin | 会员能力 + 上传文件、新建文件夹、提交变更单、看自己的草稿 |
| 超级管理员 superadmin | 上述全部 + 直接发布（上传即公开）+ 审核他人提交单 |

关键约定：
- 管理员**不能**直接改动线上内容：写操作一律走 `doc_submissions`，
  由超管在 `/api/docs/review/*` 批准后才写进 folders/documents/revisions。
- 正文不会随目录树下发（`/tree` 只给元数据），进详情页才拉 `/documents/{id}`。
- 提交单不能叠加：同一目标已有待审提交单时返回 409，避免批准时互相覆盖。
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import Response
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session as DBSession

from .. import docs_storage as storage
from ..config import get_settings
from ..db import get_db
from ..deps import get_current_account, require_staff
from ..direct_actions import (
    count_subtree_documents,
    delete_document_direct,
    delete_folder_direct,
    move_document_direct,
    move_folder_direct,
    rename_document_direct,
    rename_folder_direct,
)
from ..models import (
    VISIBILITIES,
    Account,
    DocDocument,
    DocFile,
    DocFolder,
    DocRevision,
    DocSubmission,
    utcnow,
)
from ..schemas_docs import (
    DirectActionOut,
    DocsInfo,
    DocsPermissions,
    DocumentDetail,
    DocumentOut,
    FileRefOut,
    FolderNode,
    MoveIn,
    RenameIn,
    SearchHit,
    SearchResponse,
    SubmissionListOut,
    SubmissionOut,
    SubmitIn,
    TreeResponse,
    TreeStats,
    UploadChunkOut,
    UploadInitIn,
    UploadInitOut,
    FileUploadOut,
)
from ..review_flow import (
    apply_submission,
    folder_is_self_or_descendant,
    submission_to_out,
    subtree_folder_ids,
)

router = APIRouter(prefix="/api/docs", tags=["docs"])

READ_CHUNK = 1 << 20
PREVIEW_LINES = 60


# ----------------------------------------------------------------- 小工具

def _bad(code: str, message: str, status_code: int = status.HTTP_400_BAD_REQUEST) -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


@dataclass(frozen=True)
class Viewer:
    """当前观察者：用于过滤目录树里的草稿与受限内容。"""

    account: Account | None

    @property
    def role(self) -> str | None:
        return self.account.role if self.account else None

    @property
    def is_staff(self) -> bool:
        return self.role in {"admin", "superadmin"}

    @property
    def can_publish(self) -> bool:
        return self.role == "superadmin"

    def sees_drafts_of(self, owner_id: int | None) -> bool:
        """staff 看全部草稿（他们是审稿人）；提交人看自己的草稿。"""
        if self.is_staff:
            return True
        return self.account is not None and owner_id == self.account.id

    def allows(self, visibility: str) -> bool:
        if visibility == "public":
            return True
        if visibility == "members":
            return self.account is not None
        return self.is_staff  # staff


def current_viewer(account: Account | None = Depends(get_current_account)) -> Viewer:
    return Viewer(account=account)


def _file_out(file: DocFile) -> FileRefOut:
    return FileRefOut(
        id=file.id,
        name=file.original_name,
        doc_format=file.doc_format if file.doc_format in {"md", "txt", "json"} else "txt",
        byte_size=file.byte_size,
        sha256=file.sha256,
        created_at=file.created_at,
    )


def _document_out(
    doc: DocDocument,
    file: DocFile,
    folders: dict[int, DocFolder],
) -> DocumentOut:
    return DocumentOut(
        id=doc.id,
        parent_id=doc.parent_id,
        slug=doc.slug,
        title=doc.title,
        summary=doc.summary,
        doc_format=doc.doc_format if doc.doc_format in {"md", "txt", "json"} else "txt",
        visibility=doc.visibility,
        updated_at=doc.updated_at,
        published=doc.is_published,
        file=_file_out(file),
    )


def _folder_path(folder: DocFolder | None, folders: dict[int, DocFolder]) -> str:
    """把邻接表还原成显示路径（'a/b'）。表很小，逐级回溯足够。"""
    if folder is None:
        return ""
    parts: list[str] = []
    cursor: DocFolder | None = folder
    seen: set[int] = set()
    while cursor is not None and cursor.id not in seen:
        seen.add(cursor.id)
        parts.append(cursor.name)
        cursor = folders.get(cursor.parent_id) if cursor.parent_id else None
    return "/".join(reversed(parts))


def _body_preview(body: str, limit: int = 240) -> str:
    text = " ".join(body.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _submission_snapshot(
    db: DBSession, payload: SubmitIn
) -> tuple[dict[str, object], dict[str, object]]:
    """把提交请求规范化成 (列字段, payload)。

    为什么拆两半：`doc_submissions` 的列用于列表展示与冲突检测（可索引、可排序），
    payload 只放「不便建列」的数据（正文）。批准时需要的每个字段都能在列里找到，
    否则就会出现「file_id 只留在 payload、发布时读不到」这类静默错误。
    """
    if payload.action == "create_folder":
        name = (payload.name or "").strip()
        if not name:
            raise _bad("name_required", "新建文件夹需要填写名称")
        if "/" in name or "\\" in name:
            raise _bad("bad_name", "文件夹名称不能包含斜杠")
        parent = db.get(DocFolder, payload.parent_id) if payload.parent_id else None
        if payload.parent_id and parent is None:
            raise _bad("parent_not_found", "目标文件夹不存在")
        return {"name": name, "parent_id": parent.id if parent else None}, {}

    if payload.action == "create_doc":
        if payload.file_id is None and not (payload.body or "").strip():
            raise _bad("content_required", "请上传文件或填写正文")
        parent = db.get(DocFolder, payload.parent_id) if payload.parent_id else None
        if payload.parent_id and parent is None:
            raise _bad("parent_not_found", "目标文件夹不存在")
        file_row = db.get(DocFile, payload.file_id) if payload.file_id else None
        if payload.file_id and file_row is None:
            raise _bad("file_not_found", "上传的文件不存在")
        title = (payload.title or "").strip()
        if not title:
            title = _title_from_file(file_row.original_name) if file_row else "未命名文档"
        return (
            {
                "title": title,
                "parent_id": parent.id if parent else None,
                "file_id": file_row.id if file_row else None,
            },
            {"body": payload.body or ""},
        )

    if payload.action in {"update_doc", "delete_doc", "move_doc"}:
        doc = db.get(DocDocument, payload.document_id) if payload.document_id else None
        if doc is None:
            raise _bad("document_not_found", "文档不存在")
        columns: dict[str, object] = {"document_id": doc.id, "title": doc.title}
        if payload.action in {"delete_doc", "move_doc"}:
            if payload.action == "move_doc":
                parent = db.get(DocFolder, payload.parent_id) if payload.parent_id else None
                if payload.parent_id and parent is None:
                    raise _bad("parent_not_found", "目标文件夹不存在")
                if doc.parent_id == (parent.id if parent else None):
                    raise _bad("same_parent", "这篇文档已经在这个文件夹里了")
                columns["parent_id"] = parent.id if parent else None
            return columns, {}

        extra: dict[str, object] = {}
        if payload.file_id is not None:
            file_row = db.get(DocFile, payload.file_id)
            if file_row is None:
                raise _bad("file_not_found", "上传的文件不存在")
            columns["file_id"] = file_row.id
        if payload.body is not None:
            extra["body"] = payload.body
        if payload.title:
            columns["title"] = payload.title.strip()
        if "file_id" not in columns and "body" not in extra:
            raise _bad("content_required", "更新文档需要新文件或新正文")
        return columns, extra

    if payload.action == "move_folder":
        folder = db.get(DocFolder, payload.folder_id) if payload.folder_id else None
        if folder is None:
            raise _bad("folder_not_found", "文件夹不存在")
        parent = db.get(DocFolder, payload.parent_id) if payload.parent_id else None
        if payload.parent_id and parent is None:
            raise _bad("parent_not_found", "目标文件夹不存在")
        if folder.parent_id == (parent.id if parent else None):
            raise _bad("same_parent", "这个文件夹已经在这个位置了")
        if parent is not None and folder_is_self_or_descendant(db, folder.id, parent.id):
            raise _bad("move_into_self", "不能把文件夹移动到它自己或它的子目录里")
        return {
            "folder_id": folder.id,
            "name": folder.name,
            "parent_id": parent.id if parent else None,
        }, {}

    if payload.action == "delete_folder":
        folder = db.get(DocFolder, payload.folder_id) if payload.folder_id else None
        if folder is None:
            raise _bad("folder_not_found", "文件夹不存在")
        doc_count = count_subtree_documents(db, subtree_folder_ids(db, folder.id))
        return {"folder_id": folder.id, "name": folder.name,
                "cascade_documents": doc_count}, {}

    raise _bad("unknown_action", "未知的提交动作")


def _title_from_file(name: str) -> str:
    """从文件名推标题：去掉扩展名与日期/序号前缀，保留可读部分。"""
    stem = name.rsplit(".", 1)[0]
    for prefix in ("cv",):
        if stem.startswith(prefix) and stem[len(prefix):len(prefix) + 8].isdigit():
            stem = stem[len(prefix) + 8:].lstrip("_ -")
            break
    return stem.replace("_", " ").strip() or name


# ----------------------------------------------------------------- 公开读取

@router.get("/info", response_model=DocsInfo, summary="接口能力与限制（公开）")
def info() -> DocsInfo:
    settings = get_settings()
    limit = settings.docs_max_bytes
    return DocsInfo(
        allowed_extensions=sorted(storage.ALLOWED_EXTENSIONS),
        max_bytes=limit,
        max_bytes_label=storage.format_bytes(limit),
        storage_dir=str(settings.docs_storage_dir),
        search_limit=settings.docs_search_limit,
        review_required=True,
        notes=[
            "上传内容落盘保存并由站内服务提供下载；不向任何第三方转发。",
            "管理员上传与新建的内容默认是草稿，必须由超级管理员审核通过后才对访客开放。",
            "首版只接受文本类文件（md/json/txt）：访客可直接阅读，非文本一律拒收。",
            "搜索在服务端对已发布正文做子串匹配，只返回访客有权看到的条目。",
        ],
    )


@router.get("/permissions", response_model=DocsPermissions, summary="当前账号在本工具的能力")
def permissions(viewer: Viewer = Depends(current_viewer)) -> DocsPermissions:
    return DocsPermissions(
        role=viewer.role,
        can_read_drafts=viewer.account is not None,
        can_upload=viewer.is_staff,
        can_submit=viewer.is_staff,
        can_review=viewer.can_publish,
        can_publish_directly=viewer.can_publish,
        # 整理目录（移动/重命名）与删除都要求 staff：管理员提交单，超管直接生效
        can_organize=viewer.is_staff,
        can_delete=viewer.is_staff,
    )


@router.get("/tree", response_model=TreeResponse, summary="目录树（公开只给已发布内容）")
def tree(
    db: DBSession = Depends(get_db), viewer: Viewer = Depends(current_viewer)
) -> TreeResponse:
    folders = list(db.scalars(select(DocFolder).order_by(DocFolder.sort_order, DocFolder.name)))
    rows = db.execute(
        select(DocDocument, DocFile).join(DocFile, DocDocument.current_file_id == DocFile.id)
    ).all()

    folder_by_id = {f.id: f for f in folders}
    visible_folders = [
        f
        for f in folders
        if viewer.allows(f.visibility)
        and (f.is_published or viewer.sees_drafts_of(f.created_by))
    ]
    visible_ids = {f.id for f in visible_folders}

    # 父目录不可见的子目录也一并隐藏：否则树里会冒出孤儿节点
    def chain_visible(folder: DocFolder) -> bool:
        cursor: DocFolder | None = folder
        while cursor is not None:
            if cursor.id not in visible_ids:
                return False
            cursor = folder_by_id.get(cursor.parent_id) if cursor.parent_id else None
        return True

    visible_folders = [f for f in visible_folders if chain_visible(f)]
    visible_ids = {f.id for f in visible_folders}

    documents: list[tuple[DocDocument, DocFile]] = []
    for doc, file in rows:
        if not viewer.allows(doc.visibility):
            continue
        if not doc.is_published and not viewer.sees_drafts_of(doc.created_by):
            continue
        if doc.parent_id is not None and doc.parent_id not in visible_ids:
            continue
        documents.append((doc, file))

    children: dict[int | None, list[DocFolder]] = {}
    for folder in visible_folders:
        children.setdefault(folder.parent_id, []).append(folder)
    docs_by_parent: dict[int | None, list[tuple[DocDocument, DocFile]]] = {}
    for doc, file in documents:
        docs_by_parent.setdefault(doc.parent_id, []).append((doc, file))

    def build(folder: DocFolder | None) -> FolderNode:
        node_id = folder.id if folder else None
        path = _folder_path(folder, folder_by_id)
        return FolderNode(
            id=folder.id if folder else 0,
            parent_id=folder.parent_id if folder else None,
            name=folder.name if folder else "全部文档",
            path=path,
            visibility=(folder.visibility if folder else "public"),
            updated_at=folder.updated_at if folder else _epoch(),
            created_at=folder.created_at if folder else _epoch(),
            published=folder.is_published if folder else True,
            children=[
                build(child)
                for child in sorted(
                    children.get(node_id, []), key=lambda f: (f.sort_order, f.name)
                )
            ],
            documents=[
                _document_out(doc, file, folder_by_id)
                for doc, file in sorted(
                    docs_by_parent.get(node_id, []), key=lambda pair: (pair[0].sort_order, pair[0].title)
                )
            ],
        )

    published_count = sum(1 for doc, _ in documents if doc.is_published)
    return TreeResponse(
        root=build(None),
        stats=TreeStats(
            folders=len(visible_folders),
            documents=len(documents),
            published_documents=published_count,
            total_bytes=sum(file.byte_size for _, file in documents),
        ),
        viewer_role=viewer.role,
    )


def _epoch() -> datetime:
    return datetime.fromtimestamp(0, tz=timezone.utc)


@router.get("/search", response_model=SearchResponse, summary="全文搜索（只搜有权阅读的内容）")
def search(
    q: str = Query(min_length=1, max_length=100, description="关键词"),
    limit: int = Query(default=0, ge=0, le=200),
    db: DBSession = Depends(get_db),
    viewer: Viewer = Depends(current_viewer),
) -> SearchResponse:
    settings = get_settings()
    cap = min(limit or settings.docs_search_limit, 200)
    pattern = f"%{q}%"
    stmt = (
        select(DocDocument, DocFile, DocRevision)
        .join(DocFile, DocDocument.current_file_id == DocFile.id)
        .join(DocRevision, DocDocument.current_revision_id == DocRevision.id)
        .where(or_(DocDocument.title.like(pattern), DocRevision.body.like(pattern)))
        .order_by(DocDocument.title)
    )
    folders = {f.id: f for f in db.scalars(select(DocFolder))}
    hits: list[SearchHit] = []
    total = 0
    for doc, file, revision in db.execute(stmt).all():
        if not viewer.allows(doc.visibility):
            continue
        if not doc.is_published and not viewer.sees_drafts_of(doc.created_by):
            continue
        total += 1
        if len(hits) >= cap:
            continue
        hits.append(
            SearchHit(
                id=doc.id,
                title=doc.title,
                path=_folder_path(folders.get(doc.parent_id), folders),
                doc_format=doc.doc_format if doc.doc_format in {"md", "txt", "json"} else "txt",
                snippet=_snippet(revision.body, q),
            )
        )
    return SearchResponse(query=q, total=total, truncated=total > len(hits), hits=hits)


def _snippet(body: str, query: str, width: int = 120) -> str:
    index = body.lower().find(query.lower())
    if index < 0:
        return _body_preview(body, width)
    start = max(0, index - width // 3)
    end = min(len(body), index + len(query) + width)
    piece = " ".join(body[start:end].split())
    return ("…" if start > 0 else "") + piece + ("…" if end < len(body) else "")


@router.get("/documents/{document_id}", response_model=DocumentDetail, summary="读取正文")
def read_document(
    document_id: int,
    db: DBSession = Depends(get_db),
    viewer: Viewer = Depends(current_viewer),
) -> DocumentDetail:
    doc = db.get(DocDocument, document_id)
    if doc is None or not viewer.allows(doc.visibility):
        raise _bad("document_not_found", "文档不存在或你没有阅读权限", status.HTTP_404_NOT_FOUND)
    if not doc.is_published and not viewer.sees_drafts_of(doc.created_by):
        raise _bad("document_not_found", "文档不存在或你没有阅读权限", status.HTTP_404_NOT_FOUND)
    folders = {f.id: f for f in db.scalars(select(DocFolder))}
    file_row = db.get(DocFile, doc.current_file_id) if doc.current_file_id else None
    revision = db.get(DocRevision, doc.current_revision_id) if doc.current_revision_id else None

    if file_row is None:
        # 极少数情况：磁盘文件记录被清掉。不 500，而是给出可用信息。
        raise _bad("document_broken", "这篇文档缺少文件记录，请联系管理员", status.HTTP_409_CONFLICT)

    body = revision.body if revision else (file_row.text_content or "")
    base = _document_out(doc, file_row, folders)
    return DocumentDetail(
        **base.model_dump(),
        body=body,
        revision_no=revision.revision_no if revision else 0,
        revision_at=revision.created_at if revision else None,
        byte_size=len(body.encode("utf-8")),
    )


@router.get("/files/{file_id}/download", summary="下载原始文件")
def download_file(
    file_id: int,
    db: DBSession = Depends(get_db),
    viewer: Viewer = Depends(current_viewer),
) -> Response:
    """下载走这里而不是静态目录：先判定这篇文件是否挂在某篇可读文档上。

    固定 `application/octet-stream` + `attachment`：下载就是下载，
    不在这个响应里给浏览器「顺便渲染一下」的机会。
    """
    file_row = _readable_file(db, file_id, viewer)
    try:
        data = storage.resolve(file_row.storage_path).read_bytes()
    except storage.DocStorageError as exc:
        raise _bad(exc.code, exc.message, status.HTTP_410_GONE) from exc
    except OSError as exc:
        raise _bad("file_unreadable", "文件读取失败", status.HTTP_500_INTERNAL_SERVER_ERROR) from exc

    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": _content_disposition(file_row.original_name, "attachment"),
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get(
    "/files/{file_id}/content",
    summary="内联读取原始文件（txt/json 的原始查看；按可见性判定）",
)
def file_content(
    file_id: int,
    disposition: str = Query(default="attachment", pattern="^(attachment|inline)$"),
    db: DBSession = Depends(get_db),
    viewer: Viewer = Depends(current_viewer),
) -> Response:
    """读取原始文件字节。

    默认 `attachment`（下载）；`inline` 用于 txt/json 的「原始文本」视图——
    前端仍以 `<pre>` 纯文本展示，不把服务端返回的内容当 HTML 执行，
    并且这里固定带上 `nosniff`，避免浏览器把内容嗅探成可执行类型。
    """
    file_row = _readable_file(db, file_id, viewer)
    try:
        data = storage.resolve(file_row.storage_path).read_bytes()
    except storage.DocStorageError as exc:
        raise _bad(exc.code, exc.message, status.HTTP_410_GONE) from exc
    except OSError as exc:
        raise _bad("file_unreadable", "文件读取失败", status.HTTP_500_INTERNAL_SERVER_ERROR) from exc

    media_type = {
        "md": "text/markdown; charset=utf-8",
        "txt": "text/plain; charset=utf-8",
        "json": "text/plain; charset=utf-8",
    }.get(file_row.doc_format, "application/octet-stream")
    return Response(
        content=data,
        media_type=media_type,
        headers={
            "Content-Disposition": _content_disposition(file_row.original_name, disposition),
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, max-age=60",
        },
    )


def _readable_file(db: DBSession, file_id: int, viewer: Viewer) -> DocFile:
    """文件可见性：必须挂在一篇「当前观察者能读」的文档上。"""
    file_row = db.get(DocFile, file_id)
    if file_row is None:
        raise _bad("file_not_found", "文件不存在", status.HTTP_404_NOT_FOUND)
    doc = db.scalar(select(DocDocument).where(DocDocument.current_file_id == file_id))
    if doc is None or not viewer.allows(doc.visibility) or (
        not doc.is_published and not viewer.sees_drafts_of(doc.created_by)
    ):
        raise _bad("file_not_found", "文件不存在或你没有访问权限", status.HTTP_404_NOT_FOUND)
    return file_row


def _content_disposition(name: str, disposition: str) -> str:
    """Content-Disposition 只用清洗过的文件名与安全字符（防头注入）。

    同时给 ASCII 回退名与 RFC 5987 的 `filename*`：中文文件名在旧浏览器里
    也能落到一个可用的名字上。
    """
    from urllib.parse import quote

    cleaned = storage.sanitize_name(name)
    ascii_name = cleaned.encode("ascii", "ignore").decode("ascii").strip() or "document.txt"
    return f"{disposition}; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(cleaned)}"


# ----------------------------------------------------------------- 管理员写入

@router.post("/uploads", response_model=UploadInitOut, summary="开始一次分块上传（staff）")
def init_upload(
    payload: UploadInitIn, operator: Account = Depends(require_staff)
) -> UploadInitOut:
    try:
        doc_format = storage.doc_format_of(payload.filename)
    except storage.DocStorageError as exc:
        raise _bad(exc.code, exc.message) from exc
    limit = storage.max_bytes()
    if payload.total_bytes is not None and payload.total_bytes > limit:
        raise _bad(
            "file_too_large",
            f"文件超过 {storage.format_bytes(limit)} 上限",
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
        )
    chunk_size = payload.chunk_size or (1 << 20)
    return UploadInitOut(
        upload_id=uuid.uuid4().hex,
        chunk_size=max(64 * 1024, min(chunk_size, 8 << 20)),
        max_bytes=limit,
        doc_format=doc_format,  # type: ignore[arg-type]
    )


@router.post("/uploads/{upload_id}/chunks", response_model=UploadChunkOut, summary="上传一个分片")
async def upload_chunk(
    upload_id: str,
    index: int = Query(ge=0, le=100_000),
    chunk: UploadFile = File(description="分片内容"),
    _: Account = Depends(require_staff),
) -> UploadChunkOut:
    """写入第 index 片。同一分片重传时直接覆盖，拼接顺序由文件名保证。"""
    try:
        directory = storage.upload_dir(upload_id)
        others = sum(
            part.stat().st_size
            for part in directory.glob("*.part")
            if part.name != f"{index:06d}.part"
        )
        written = 0
        limit = storage.max_bytes()
        with (directory / f"{index:06d}.part").open("wb") as handle:
            while True:
                block = await chunk.read(READ_CHUNK)
                if not block:
                    break
                written += len(block)
                if others + written > limit:
                    handle.close()
                    (directory / f"{index:06d}.part").unlink(missing_ok=True)
                    storage.discard_upload(upload_id)
                    raise _bad(
                        "file_too_large",
                        f"文件超过 {storage.format_bytes(limit)} 上限",
                        status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    )
                handle.write(block)
    except storage.DocStorageError as exc:
        raise _bad(exc.code, exc.message) from exc
    return UploadChunkOut(
        upload_id=upload_id,
        received_bytes=storage.received_bytes(upload_id),
        chunks=len(list(storage.upload_dir(upload_id).glob("*.part"))),
    )


@router.post("/uploads/{upload_id}/finish", response_model=FileUploadOut, summary="完成上传")
def finish_upload(
    upload_id: str,
    filename: str = Form(description="原始文件名"),
    total_bytes: int | None = Form(default=None),
    db: DBSession = Depends(get_db),
    operator: Account = Depends(require_staff),
) -> FileUploadOut:
    try:
        stored = storage.finalize_upload(upload_id, filename, total_bytes)
    except storage.DocStorageError as exc:
        raise _bad(exc.code, exc.message) from exc

    row = DocFile(
        original_name=storage.sanitize_name(filename),
        content_type="text/plain",
        doc_format=stored.doc_format,
        byte_size=stored.byte_size,
        sha256=stored.sha256,
        storage_path=stored.storage_path,
        text_content=stored.text_content,
        is_text=True,
        uploaded_by=operator.id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    text = stored.text_content or ""
    return FileUploadOut(
        file=_file_out(row),
        doc_format=stored.doc_format,  # type: ignore[arg-type]
        text_content=text,
        preview_lines=min(PREVIEW_LINES, text.count("\n") + 1),
    )


@router.post(
    "/uploads/direct", response_model=FileUploadOut, summary="一次性上传（小文件，staff）"
)
async def upload_direct(
    file: UploadFile = File(description="md / json / txt 文件"),
    db: DBSession = Depends(get_db),
    operator: Account = Depends(require_staff),
) -> FileUploadOut:
    """给脚本与小文件用的简化入口：不分块，直接整体落盘。"""
    chunks: list[bytes] = []
    total = 0
    while True:
        block = await file.read(READ_CHUNK)
        if not block:
            break
        total += len(block)
        if total > storage.max_bytes():
            raise _bad(
                "file_too_large",
                f"文件超过 {storage.format_bytes(storage.max_bytes())} 上限",
                status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            )
        chunks.append(block)
    try:
        stored = storage.save_bytes(file.filename or "document.txt", b"".join(chunks))
    except storage.DocStorageError as exc:
        raise _bad(exc.code, exc.message) from exc

    row = DocFile(
        original_name=storage.sanitize_name(file.filename or "document.txt"),
        content_type="text/plain",
        doc_format=stored.doc_format,
        byte_size=stored.byte_size,
        sha256=stored.sha256,
        storage_path=stored.storage_path,
        text_content=stored.text_content,
        is_text=True,
        uploaded_by=operator.id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    text = stored.text_content or ""
    return FileUploadOut(
        file=_file_out(row),
        doc_format=stored.doc_format,  # type: ignore[arg-type]
        text_content=text,
        preview_lines=min(PREVIEW_LINES, text.count("\n") + 1),
    )


@router.post(
    "/submissions",
    response_model=SubmissionOut,
    status_code=status.HTTP_201_CREATED,
    summary="提交变更单（staff）",
)
def create_submission(
    payload: SubmitIn,
    db: DBSession = Depends(get_db),
    operator: Account = Depends(require_staff),
) -> SubmissionOut:
    if payload.visibility not in VISIBILITIES:
        raise _bad("bad_visibility", "未知的可见性")
    columns, extra = _submission_snapshot(db, payload)

    # 同一目标不叠加提交单：否则两条都批准时后一条会覆盖前一条
    if payload.action in {"update_doc", "delete_doc"} and payload.document_id:
        clash = db.scalar(
            select(DocSubmission).where(
                DocSubmission.status == "pending",
                DocSubmission.target_id == payload.document_id,
                DocSubmission.target_kind == "document",
            )
        )
        if clash is not None:
            raise _bad(
                "submission_conflict",
                f"这篇文档已有一条待审提交单（#{clash.id}），等超管处理后再提交",
                status.HTTP_409_CONFLICT,
            )
    if payload.action == "delete_folder" and payload.folder_id:
        clash = db.scalar(
            select(DocSubmission).where(
                DocSubmission.status == "pending",
                DocSubmission.target_id == payload.folder_id,
                DocSubmission.target_kind == "folder",
            )
        )
        if clash is not None:
            raise _bad(
                "submission_conflict",
                f"这个文件夹已有一条待审提交单（#{clash.id}）",
                status.HTTP_409_CONFLICT,
            )

    target_kind = "folder" if columns.get("folder_id") else "document"
    row = DocSubmission(
        action=payload.action,
        target_kind=target_kind,
        target_id=columns.get("document_id") or columns.get("folder_id"),  # type: ignore[arg-type]
        parent_id=columns.get("parent_id"),  # type: ignore[arg-type]
        title=str(columns.get("title") or ""),
        name=str(columns.get("name") or ""),
        summary=payload.summary or "",
        visibility=payload.visibility,
        file_id=columns.get("file_id"),  # type: ignore[arg-type]
        note=payload.note,
        payload=extra,
        status="pending",
        submitted_by=operator.id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return submission_to_out(db, row)


@router.get("/submissions", response_model=SubmissionListOut, summary="我的提交单 / 待审列表")
def list_submissions(
    scope: str = Query(default="mine", pattern="^(mine|pending)$"),
    db: DBSession = Depends(get_db),
    operator: Account = Depends(require_staff),
) -> SubmissionListOut:
    """scope=mine 看自己提交的；scope=pending 看全部待审（超管；admin 只看自己的）。"""
    stmt = select(DocSubmission).order_by(DocSubmission.created_at.desc()).limit(200)
    if scope == "pending":
        stmt = stmt.where(DocSubmission.status == "pending")
        if operator.role != "superadmin":
            stmt = stmt.where(DocSubmission.submitted_by == operator.id)
    else:
        stmt = stmt.where(DocSubmission.submitted_by == operator.id)
    rows = list(db.scalars(stmt))
    pending_total = db.scalar(
        select(func.count()).select_from(DocSubmission).where(DocSubmission.status == "pending")
    )
    return SubmissionListOut(
        items=[submission_to_out(db, row) for row in rows],
        pending_total=int(pending_total or 0),
    )


@router.post("/submissions/{submission_id}/withdraw", response_model=SubmissionOut,
             summary="撤回自己的待审提交单")
def withdraw_submission(
    submission_id: int,
    db: DBSession = Depends(get_db),
    operator: Account = Depends(require_staff),
) -> SubmissionOut:
    row = db.get(DocSubmission, submission_id)
    if row is None:
        raise _bad("submission_not_found", "提交单不存在", status.HTTP_404_NOT_FOUND)
    if row.status != "pending":
        raise _bad("submission_closed", "这条提交单已经被处理过了", status.HTTP_409_CONFLICT)
    if row.submitted_by != operator.id and operator.role != "superadmin":
        raise _bad("forbidden", "只能撤回自己提交的单子", status.HTTP_403_FORBIDDEN)
    row.status = "withdrawn"
    db.commit()
    db.refresh(row)
    return submission_to_out(db, row)


# ----------------------------------------------------------------- 超管审核

@router.post("/review/{submission_id}", response_model=SubmissionOut, summary="审核（超管）")
def review_submission(
    submission_id: int,
    decision: str = Query(pattern="^(approve|reject)$"),
    note: str = Query(default="", max_length=500),
    db: DBSession = Depends(get_db),
    operator: Account = Depends(require_staff),
) -> SubmissionOut:
    """批准后立刻发布；批准时目标可能已被别人改动，此时标成 rejected 并说明原因。"""
    if operator.role != "superadmin":
        raise _bad("forbidden", "只有超级管理员可以审核发布", status.HTTP_403_FORBIDDEN)
    row = db.get(DocSubmission, submission_id)
    if row is None:
        raise _bad("submission_not_found", "提交单不存在", status.HTTP_404_NOT_FOUND)
    if row.status != "pending":
        raise _bad("submission_closed", "这条提交单已经被处理过了", status.HTTP_409_CONFLICT)

    if decision == "reject":
        row.status = "rejected"
        row.review_note = note
        row.reviewed_by = operator.id
        row.reviewed_at = utcnow()
        db.commit()
        db.refresh(row)
        return submission_to_out(db, row)

    try:
        apply_submission(db, row)
    except HTTPException as exc:
        db.rollback()
        detail = exc.detail if isinstance(exc.detail, dict) else {}
        row = db.get(DocSubmission, submission_id)
        row.status = "rejected"  # type: ignore[union-attr]
        row.review_note = f"发布时校验失败：{detail.get('message', exc.detail)}"  # type: ignore[union-attr]
        row.reviewed_by = operator.id  # type: ignore[union-attr]
        row.reviewed_at = utcnow()  # type: ignore[union-attr]
        db.commit()
        db.refresh(row)  # type: ignore[arg-type]
        return submission_to_out(db, row)  # type: ignore[arg-type]

    row.status = "approved"
    row.review_note = note
    row.reviewed_by = operator.id
    row.reviewed_at = utcnow()
    db.commit()
    db.refresh(row)
    return submission_to_out(db, row)


# ----------------------------------------------------------------- 超管直接操作

def _require_superadmin(operator: Account) -> None:
    """直接改动目录树（移动 / 重命名 / 删除）只对超级管理员开放。

    管理员走同名的提交单入口（POST /submissions + 审核）——两条路径最终调用
    `review_flow` 里同一批函数，所以行为一致，差别只在「要不要等审核」。
    """
    if operator.role != "superadmin":
        raise _bad(
            "forbidden",
            "只有超级管理员可以直接改动目录树；管理员请提交变更单等审核",
            status.HTTP_403_FORBIDDEN,
        )


@router.post("/documents/{document_id}/move", response_model=DirectActionOut,
             summary="移动文档到某个文件夹（超管，立即生效）")
def move_document_now(
    document_id: int,
    payload: MoveIn,
    db: DBSession = Depends(get_db),
    operator: Account = Depends(require_staff),
) -> DirectActionOut:
    _require_superadmin(operator)
    result = move_document_direct(db, operator, document_id, payload.parent_id, payload.note)
    db.commit()
    return result


@router.post("/documents/{document_id}/rename", response_model=DirectActionOut,
             summary="改文档标题（超管，立即生效）")
def rename_document_now(
    document_id: int,
    payload: RenameIn,
    db: DBSession = Depends(get_db),
    operator: Account = Depends(require_staff),
) -> DirectActionOut:
    _require_superadmin(operator)
    if not payload.title:
        raise _bad("title_required", "请填写新的标题")
    result = rename_document_direct(db, operator, document_id, payload.title, payload.note)
    db.commit()
    return result


@router.delete("/documents/{document_id}", response_model=DirectActionOut,
               summary="删除文档（超管，立即生效）")
def delete_document_now(
    document_id: int,
    note: str = Query(default="", max_length=500),
    db: DBSession = Depends(get_db),
    operator: Account = Depends(require_staff),
) -> DirectActionOut:
    _require_superadmin(operator)
    result = delete_document_direct(db, operator, document_id, note)
    db.commit()
    return result


@router.post("/folders/{folder_id}/move", response_model=DirectActionOut,
             summary="移动文件夹（连同子树，超管，立即生效）")
def move_folder_now(
    folder_id: int,
    payload: MoveIn,
    db: DBSession = Depends(get_db),
    operator: Account = Depends(require_staff),
) -> DirectActionOut:
    _require_superadmin(operator)
    result = move_folder_direct(db, operator, folder_id, payload.parent_id, payload.note)
    db.commit()
    return result


@router.post("/folders/{folder_id}/rename", response_model=DirectActionOut,
             summary="重命名文件夹（连同子树的路径，超管，立即生效）")
def rename_folder_now(
    folder_id: int,
    payload: RenameIn,
    db: DBSession = Depends(get_db),
    operator: Account = Depends(require_staff),
) -> DirectActionOut:
    _require_superadmin(operator)
    if not payload.name:
        raise _bad("name_required", "请填写新的文件夹名称")
    result = rename_folder_direct(db, operator, folder_id, payload.name, payload.note)
    db.commit()
    return result


@router.delete("/folders/{folder_id}", response_model=DirectActionOut,
               summary="删除文件夹及其内容（超管，立即生效）")
def delete_folder_now(
    folder_id: int,
    note: str = Query(default="", max_length=500),
    db: DBSession = Depends(get_db),
    operator: Account = Depends(require_staff),
) -> DirectActionOut:
    _require_superadmin(operator)
    result = delete_folder_direct(db, operator, folder_id, note)
    db.commit()
    return result
