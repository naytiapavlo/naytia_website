"""变更提交单的发布流程（审核通过后真正写库的那一步）。

为什么单独一个文件：`routers/docs.py` 负责 HTTP 契约，这里负责「把一条提交单
变成目录树上的真实改动」这件事本身——导入脚本、将来的 CLI 审核工具、
以及 pytest 都希望直接调用它，而不是绕一遍 HTTP。

批准时的**二次校验**是刻意的：提交单可能在队列里躺几天，期间目标文档可能被删、
父目录可能被改、同名路径可能被另一次提交占掉。这些情况在这里翻译成
结构化 409/400，由调用方把提交单标成 rejected 并写明原因，而不是写坏目录树。
"""
from __future__ import annotations

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session as DBSession

from . import docs_storage as storage
from .models import (
    Account,
    DocDocument,
    DocFile,
    DocFolder,
    DocRevision,
    DocSubmission,
    next_path_key,
)
from .schemas_docs import DocumentOut, FileRefOut, SubmissionOut

# 一次批准最多连带删除多少篇文档。防止「删掉一个根级文件夹」在没人注意时清空整个知识库。
MAX_CASCADE_DOCUMENTS = 200


def _conflict(code: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT, detail={"code": code, "message": message}
    )


def _file_out(file: DocFile | None) -> FileRefOut | None:
    if file is None:
        return None
    return FileRefOut(
        id=file.id,
        name=file.original_name,
        doc_format=file.doc_format if file.doc_format in {"md", "txt", "json"} else "txt",
        byte_size=file.byte_size,
        sha256=file.sha256,
        created_at=file.created_at,
    )


# ----------------------------------------------------------------- 提交单 -> 响应

def _folder_path(db: DBSession, folder_id: int | None) -> str | None:
    if folder_id is None:
        return None
    folders = {f.id: f for f in db.scalars(select(DocFolder))}
    return folder_path_of(folders, folder_id)


def folder_path_of(folders: dict[int, DocFolder], folder_id: int | None) -> str | None:
    """把邻接表还原成显示路径（'漏洞bug分析/Naytia'）。根目录返回 None。

    只走一遍父链，不做全表扫描——目录层级是个位数，但这段会被提交单列表
    每行调用一次，别让它变成 N 次全表查。
    """
    if folder_id is None:
        return None
    parts: list[str] = []
    cursor = folders.get(folder_id)
    seen: set[int] = set()
    while cursor is not None and cursor.id not in seen:
        seen.add(cursor.id)
        parts.append(cursor.name)
        cursor = folders.get(cursor.parent_id) if cursor.parent_id else None
    return "/".join(reversed(parts)) or None


def submission_to_out(db: DBSession, row: DocSubmission) -> SubmissionOut:
    """把提交单转成前端契约。附带提交人/审核人名称与正文预览，省一次往返。"""
    submitter = db.get(Account, row.submitted_by) if row.submitted_by else None
    reviewer = db.get(Account, row.reviewed_by) if row.reviewed_by else None
    file_row = db.get(DocFile, row.file_id) if row.file_id else None
    body = (row.payload or {}).get("body") or ""
    preview = " ".join(str(body).split())
    if len(preview) > 240:
        preview = preview[:239] + "…"
    target_preview = ""
    if row.action in {"update_doc", "move_doc"} and row.target_id:
        current = db.get(DocDocument, row.target_id)
        if current is not None:
            target_preview = current.title

    # 移动类提交单要写清「移到哪里」，否则待审队列里只有一句「移动文档」没法判断
    target_path: str | None = None
    if row.action in {"move_doc", "move_folder"}:
        folders = {f.id: f for f in db.scalars(select(DocFolder))}
        target_path = folder_path_of(folders, row.parent_id) or "（根目录）"

    return SubmissionOut(
        id=row.id,
        action=row.action,  # type: ignore[arg-type]
        status=row.status,  # type: ignore[arg-type]
        target_kind=row.target_kind,
        document_id=row.target_id if row.target_kind == "document" else None,
        folder_id=row.target_id if row.target_kind == "folder" else None,
        parent_id=row.parent_id,
        parent_path=_folder_path(db, row.parent_id),
        target_path=target_path,
        title=row.title or target_preview,
        name=row.name,
        summary=row.summary,
        visibility=row.visibility,  # type: ignore[arg-type]
        note=row.note,
        file=_file_out(file_row),
        body_preview=preview,
        submitted_by=row.submitted_by,
        submitted_by_name=submitter.username if submitter else None,
        created_at=row.created_at,
        reviewed_by=row.reviewed_by,
        reviewed_by_name=reviewer.username if reviewer else None,
        review_note=row.review_note,
        reviewed_at=row.reviewed_at,
        applied_document_id=row.applied_document_id,
        applied_folder_id=row.applied_folder_id,
    )


def document_out(db: DBSession, doc: DocDocument) -> DocumentOut:
    file_row = db.get(DocFile, doc.current_file_id) if doc.current_file_id else None
    return DocumentOut(
        id=doc.id,
        parent_id=doc.parent_id,
        slug=doc.slug,
        title=doc.title,
        summary=doc.summary,
        doc_format=doc.doc_format if doc.doc_format in {"md", "txt", "json"} else "txt",
        visibility=doc.visibility,  # type: ignore[arg-type]
        updated_at=doc.updated_at,
        published=doc.is_published,
        file=_file_out(file_row),  # type: ignore[arg-type]
    )


# ----------------------------------------------------------------- 发布

def apply_submission(db: DBSession, row: DocSubmission) -> tuple[int | None, int | None]:
    """把提交单写进目录树。返回 (document_id, folder_id)，失败抛 HTTPException。"""
    if row.action == "create_folder":
        return _apply_create_folder(db, row)
    if row.action == "create_doc":
        return _apply_create_doc(db, row)
    if row.action == "update_doc":
        return _apply_update_doc(db, row)
    if row.action == "move_doc":
        return _apply_move_doc(db, row)
    if row.action == "move_folder":
        return _apply_move_folder(db, row)
    if row.action == "delete_doc":
        return _apply_delete_doc(db, row)
    if row.action == "delete_folder":
        return _apply_delete_folder(db, row)
    raise _conflict("unknown_action", "未知的提交动作")


# ------------------------------------------------------- 路径操作（发布 / 超管直接执行共用）

def unique_doc_slug(
    db: DBSession, parent_path: str, base: str, *, exclude_document_id: int | None = None
) -> str:
    """同层 slug 去重：第二次同名文档变成 `name-2`，不覆盖已有文档。

    `exclude_document_id` 用于「移动到别处」：被移动的那篇自己要排除，
    否则移到根目录时会跟「它现在这条路径」撞上。
    """
    candidate = base
    suffix = 2
    while True:
        found = db.scalar(
            select(DocDocument).where(
                DocDocument.path_key == next_path_key(parent_path, candidate)
            )
        )
        if found is None or found.id == exclude_document_id:
            return candidate
        candidate = f"{base}-{suffix}"
        suffix += 1


def folder_is_self_or_descendant(db: DBSession, folder_id: int, candidate_parent: int) -> bool:
    """`candidate_parent` 是否就是 `folder_id` 自己或它的子孙。

    把文件夹移进自己的子目录会让子树成为孤岛：显示路径算不出来、递归遍历会死循环。
    """
    if folder_id == candidate_parent:
        return True
    return candidate_parent in subtree_folder_ids(db, folder_id)


def rewrite_folder_paths(db: DBSession, folder: DocFolder, new_parent_path: str) -> DocFolder:
    """把 `folder` 及整棵子树的 `path_key` 按新的父路径重写。

    这是邻接表 + 物化路径方案的代价所在：移动/重命名文件夹必须连带改写子孙，
    否则子树里的文档 path_key 会指向一条已经不存在的路径（表现为「导入脚本
    认不出这些文档、再导一次就多出一份」）。所以只此一处实现，且必须整体调用。
    """
    folders = {f.id: f for f in db.scalars(select(DocFolder))}
    old_root_path = folder.path_key
    new_root_path = next_path_key(new_parent_path, folder.name)

    if new_root_path != old_root_path:
        # 目标位置已经有同名文件夹时不猜、不自动改名：文件夹改名是用户的决定
        clash = db.scalar(select(DocFolder).where(DocFolder.path_key == new_root_path))
        if clash is not None and clash.id != folder.id:
            raise _conflict("folder_exists", f"目标位置已有同名文件夹（{new_root_path}）")

        for node in folders.values():
            if node.id == folder.id or node.path_key == old_root_path:
                node.path_key = new_root_path
            elif node.path_key.startswith(old_root_path + "/"):
                node.path_key = new_root_path + node.path_key[len(old_root_path):]
        folder.path_key = new_root_path
        db.flush()
    return folder


def move_document(db: DBSession, doc: DocDocument, target_parent_id: int | None) -> str:
    """把文档移到目标目录，返回新的显示路径。同名冲突时自动加 `-2` 后缀。"""
    if doc.parent_id == target_parent_id:
        return folder_path_of({f.id: f for f in db.scalars(select(DocFolder))}, target_parent_id) or ""
    parent = db.get(DocFolder, target_parent_id) if target_parent_id else None
    if target_parent_id and parent is None:
        raise _conflict("parent_not_found", "目标文件夹不存在")
    parent_path = parent.path_key if parent else ""
    slug = unique_doc_slug(db, parent_path, doc.slug, exclude_document_id=doc.id)
    doc.parent_id = parent.id if parent else None
    doc.slug = slug
    doc.path_key = next_path_key(parent_path, slug)
    db.flush()
    return folder_path_of({f.id: f for f in db.scalars(select(DocFolder))}, target_parent_id) or ""


def move_folder(db: DBSession, folder: DocFolder, target_parent_id: int | None) -> str:
    """把文件夹（连同子树）移到目标目录，返回新的显示路径。"""
    if target_parent_id is not None and folder_is_self_or_descendant(db, folder.id, target_parent_id):
        raise _conflict(
            "move_into_self",
            "不能把一个文件夹移动到它自己或它的子目录里——那会让子树变成孤岛",
        )
    parent = db.get(DocFolder, target_parent_id) if target_parent_id else None
    if target_parent_id and parent is None:
        raise _conflict("parent_not_found", "目标文件夹不存在")
    folder.parent_id = parent.id if parent else None
    db.flush()
    rewrite_folder_paths(db, folder, parent.path_key if parent else "")
    return folder.path_key


def rename_document(db: DBSession, doc: DocDocument, new_title: str) -> None:
    """改标题。slug 保持不变：URL/路径稳定优先，标题只是显示名。"""
    title = new_title.strip()
    if not title:
        raise _conflict("title_required", "标题不能为空")
    doc.title = title
    db.flush()


def rename_folder(db: DBSession, folder: DocFolder, new_name: str) -> str:
    """改文件夹名，并连带改写整棵子树的 path_key。返回新路径。"""
    name = new_name.strip()
    if not name:
        raise _conflict("name_required", "文件夹名称不能为空")
    if "/" in name or "\\" in name:
        raise _conflict("bad_name", "文件夹名称不能包含斜杠")
    folders = {f.id: f for f in db.scalars(select(DocFolder))}
    parent_path = folders[folder.parent_id].path_key if folder.parent_id in folders else ""
    folder.name = name
    db.flush()
    rewrite_folder_paths(db, folder, parent_path)
    return folder.path_key


def _apply_create_folder(db: DBSession, row: DocSubmission) -> tuple[None, int]:
    name = (row.name or "").strip()
    if not name:
        raise _conflict("name_required", "提交单没有填写文件夹名称")
    if "/" in name or "\\" in name:
        raise _conflict("bad_name", "文件夹名称不能包含斜杠")
    parent = db.get(DocFolder, row.parent_id) if row.parent_id else None
    if row.parent_id and parent is None:
        raise _conflict("parent_not_found", "目标文件夹在审核期间被删除了")
    parent_path = parent.path_key if parent else ""
    path_key = next_path_key(parent_path, name)
    existing = db.scalar(select(DocFolder).where(DocFolder.path_key == path_key))
    if existing is not None:
        raise _conflict("folder_exists", f"同名文件夹已存在（{path_key}）")
    folder = DocFolder(
        parent_id=parent.id if parent else None,
        name=name,
        path_key=path_key,
        visibility=row.visibility,
        is_published=True,
        created_by=row.submitted_by,
    )
    db.add(folder)
    db.flush()
    row.applied_folder_id = folder.id
    db.flush()
    return None, folder.id


def _apply_create_doc(db: DBSession, row: DocSubmission) -> tuple[int, None]:
    parent = db.get(DocFolder, row.parent_id) if row.parent_id else None
    if row.parent_id and parent is None:
        raise _conflict("parent_not_found", "目标文件夹在审核期间被删除了")
    file_row = db.get(DocFile, row.file_id) if row.file_id else None
    if row.file_id and file_row is None:
        raise _conflict("file_not_found", "上传的文件记录已丢失，请重新上传")

    title = (row.title or "").strip() or "未命名文档"
    base_slug = storage.slugify(title, fallback="doc")
    parent_path = parent.path_key if parent else ""
    slug = unique_doc_slug(db, parent_path, base_slug)

    # 有文件就以文件正文为准：提交单里那份 body 是上传时的预览，可能被截断/改写
    payload = row.payload or {}
    body = file_row.text_content if file_row else (payload.get("body") or "")
    body = body or ""
    doc_format = file_row.doc_format if file_row else "md"
    revision = DocRevision(
        document_id=0,
        revision_no=1,
        title=title,
        body=body,
        doc_format=doc_format,
        byte_size=len(body.encode("utf-8")),
        file_id=file_row.id if file_row else None,
        note=row.note or "审核通过后发布",
        edited_by=row.reviewed_by or row.submitted_by,
    )
    doc = DocDocument(
        parent_id=parent.id if parent else None,
        slug=slug,
        path_key=next_path_key(parent_path, slug),
        title=title,
        summary=row.summary,
        doc_format=doc_format,
        visibility=row.visibility,
        is_published=True,
        current_file_id=file_row.id if file_row else None,
        created_by=row.submitted_by,
    )
    db.add(doc)
    db.flush()
    revision.document_id = doc.id
    db.add(revision)
    db.flush()
    doc.current_revision_id = revision.id
    row.applied_document_id = doc.id
    db.flush()
    return doc.id, None


def _apply_update_doc(db: DBSession, row: DocSubmission) -> tuple[int, None]:
    doc = db.get(DocDocument, row.target_id) if row.target_id else None
    if doc is None:
        raise _conflict("document_not_found", "这篇文档在审核期间被删除了")
    payload = row.payload or {}
    # 新文件记在列上（row.file_id），不在 payload 里——列是发布时唯一可靠的来源
    new_file = db.get(DocFile, row.file_id) if row.file_id else None
    if row.file_id and new_file is None:
        raise _conflict("file_not_found", "上传的文件记录已丢失，请重新上传")

    if new_file is not None:
        body = new_file.text_content or ""
    elif payload.get("body") is not None:
        body = str(payload["body"])
    else:
        current = db.get(DocFile, doc.current_file_id) if doc.current_file_id else None
        if current is None:
            raise _conflict("file_not_found", "这篇文档的原文件记录已丢失")
        body = current.text_content or storage.read_text(current.storage_path)
    # row.title 在提交时就写进了新标题（没改标题时存的是旧标题），所以以它为准
    title = str(row.title or doc.title)
    if payload.get("title"):
        title = str(payload["title"])
    last = db.scalar(
        select(func.max(DocRevision.revision_no)).where(DocRevision.document_id == doc.id)
    )
    revision = DocRevision(
        document_id=doc.id,
        revision_no=int(last or 0) + 1,
        title=title,
        body=body,
        doc_format=new_file.doc_format if new_file else doc.doc_format,
        byte_size=len(body.encode("utf-8")),
        file_id=new_file.id if new_file else doc.current_file_id,
        note=row.note or "审核通过后更新",
        edited_by=row.reviewed_by or row.submitted_by,
    )
    db.add(revision)
    db.flush()
    doc.current_revision_id = revision.id
    doc.title = title
    if row.summary:
        doc.summary = row.summary
    if new_file is not None:
        doc.current_file_id = new_file.id
        doc.doc_format = new_file.doc_format
    doc.is_published = True
    doc.updated_at = revision.created_at
    row.applied_document_id = doc.id
    db.flush()
    return doc.id, None


def _apply_move_doc(db: DBSession, row: DocSubmission) -> tuple[int, None]:
    doc = db.get(DocDocument, row.target_id) if row.target_id else None
    if doc is None:
        raise _conflict("document_not_found", "这篇文档在审核期间被删除了")
    # 目标目录可能在队列里躺着的这几天被删了：move_document 会报 parent_not_found
    move_document(db, doc, row.parent_id)
    row.applied_document_id = doc.id
    db.flush()
    return doc.id, None


def _apply_move_folder(db: DBSession, row: DocSubmission) -> tuple[None, int]:
    folder = db.get(DocFolder, row.target_id) if row.target_id else None
    if folder is None:
        raise _conflict("folder_not_found", "这个文件夹在审核期间被删除了")
    move_folder(db, folder, row.parent_id)
    row.applied_folder_id = folder.id
    db.flush()
    return None, folder.id


def _apply_delete_doc(db: DBSession, row: DocSubmission) -> tuple[int, None]:
    doc = db.get(DocDocument, row.target_id) if row.target_id else None
    if doc is None:
        raise _conflict("document_not_found", "这篇文档已经被删除了")
    document_id = doc.id
    db.delete(doc)
    db.flush()
    return document_id, None


def _apply_delete_folder(db: DBSession, row: DocSubmission) -> tuple[None, int]:
    folder_id = row.target_id
    folder = db.get(DocFolder, folder_id) if folder_id else None
    if folder is None:
        raise _conflict("folder_not_found", "这个文件夹已经被删除了")

    subtree = subtree_folder_ids(db, folder.id)
    doc_count = int(
        db.scalar(
            select(func.count())
            .select_from(DocDocument)
            .where(DocDocument.parent_id.in_(subtree))
        )
        or 0
    )
    if doc_count > MAX_CASCADE_DOCUMENTS:
        raise _conflict(
            "cascade_too_large",
            f"这个文件夹下有 {doc_count} 篇文档，超过一次删除上限 "
            f"({MAX_CASCADE_DOCUMENTS})；请先分批清理",
        )
    for fid in sorted(subtree, reverse=True):
        node = db.get(DocFolder, fid)
        if node is not None:
            db.delete(node)
    db.flush()
    row.applied_folder_id = folder.id
    db.flush()
    return None, folder.id


def subtree_folder_ids(db: DBSession, root_id: int) -> list[int]:
    """广度优先收集子树里的所有文件夹 id（含自己）。

    删除、移动、重命名三处都要用，所以是公开函数：各写一份的话，
    「移动时忘了排除子树」这类缺陷会在某个入口悄悄漏掉。
    """
    children: dict[int | None, list[int]] = {}
    for folder in db.scalars(select(DocFolder)):
        children.setdefault(folder.parent_id, []).append(folder.id)
    out = [root_id]
    queue = [root_id]
    while queue:
        current = queue.pop(0)
        for child in children.get(current, []):
            out.append(child)
            queue.append(child)
    return out
