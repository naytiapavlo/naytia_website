"""超管的直接操作：移动、重命名、删除——**不走提交单，立即生效**。

为什么单独一个文件：提交单是「提案」，这里是「执行」。两者都调用
`review_flow` 里同一批路径操作函数（`move_document` / `move_folder` /
`rename_document` / `rename_folder` / `rewrite_folder_paths`），所以
「管理员提交后由超管批准」与「超管自己动手」走的是完全一样的代码路径，
不会出现「审核通过的行为和超管直接改的行为不一致」这种最难查的偏差。

依据需求原话：「管理员不需要做编辑界面，只需要给他们上传文件的权限，
提交合并请求给超级管理员审核」。所以：
- 管理员：移动 / 删除 → 提交单（待审）
- 超级管理员：同样的按钮，但直接执行；页面会明确告诉他是「立即生效」
"""
from __future__ import annotations

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session as DBSession

from .models import (
    VISIBILITIES,
    Account,
    DocDocument,
    DocFolder,
    DocSubmission,
    next_path_key,
    utcnow,
)
from .review_flow import (
    MAX_CASCADE_DOCUMENTS,
    _conflict,
    move_document,
    move_folder,
    rename_document,
    rename_folder,
    subtree_folder_ids,
    unique_doc_slug,
)
from .schemas_docs import DirectActionOut


def _not_found(code: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND, detail={"code": code, "message": message}
    )


def _record_audit(
    db: DBSession,
    operator: Account,
    *,
    action: str,
    target_kind: str,
    target_id: int | None,
    parent_id: int | None,
    title: str,
    name: str,
    note: str,
    target_path: str | None = None,
) -> None:
    """超管直接操作也留一条已批准的提交单。

    理由：目录树是多人共用的东西，「谁在什么时候把这 40 篇文档挪走了」必须能查。
    没有这条记录，超管的操作就是无痕的——出了问题只能靠猜。
    """
    db.add(
        DocSubmission(
            action=action,
            target_kind=target_kind,
            target_id=target_id,
            parent_id=parent_id,
            title=title,
            name=name,
            note=note or "超级管理员直接执行",
            # payload 只放「列表里要显示、但列上没有」的东西：目标路径
            payload={"direct": True, "target_path": target_path} if target_path else {"direct": True},
            status="approved",  # 状态取 approved：审计语义就是「已生效」
            submitted_by=operator.id,
            reviewed_by=operator.id,
            review_note="直接执行（超管）",
            reviewed_at=utcnow(),
        )
    )


def count_subtree_documents(db: DBSession, folder_ids: list[int]) -> int:
    if not folder_ids:
        return 0
    return int(
        db.scalar(
            select(func.count())
            .select_from(DocDocument)
            .where(DocDocument.parent_id.in_(folder_ids))
        )
        or 0
    )


# ----------------------------------------------------------------- 文档

def move_document_direct(
    db: DBSession, operator: Account, document_id: int, target_parent_id: int | None, note: str
) -> DirectActionOut:
    doc = db.get(DocDocument, document_id)
    if doc is None:
        raise _not_found("document_not_found", "文档不存在")
    path = move_document(db, doc, target_parent_id)
    _record_audit(
        db, operator,
        action="move_doc", target_kind="document", target_id=doc.id,
        parent_id=target_parent_id, title=doc.title, name="", note=note,
        target_path=path or "（根目录）",
    )
    return DirectActionOut(
        ok=True,
        message=f"《{doc.title}》已移动到 {path or '根目录'}",
        document_id=doc.id,
        path=path,
    )


def rename_document_direct(
    db: DBSession, operator: Account, document_id: int, title: str, note: str
) -> DirectActionOut:
    doc = db.get(DocDocument, document_id)
    if doc is None:
        raise _not_found("document_not_found", "文档不存在")
    old = doc.title
    rename_document(db, doc, title)
    _record_audit(
        db, operator,
        action="update_doc", target_kind="document", target_id=doc.id,
        parent_id=doc.parent_id, title=doc.title, name="", note=note or f"标题：{old} → {doc.title}",
    )
    return DirectActionOut(
        ok=True, message=f"标题已改为《{doc.title}》", document_id=doc.id, path=doc.path_key
    )


def delete_document_direct(
    db: DBSession, operator: Account, document_id: int, note: str
) -> DirectActionOut:
    doc = db.get(DocDocument, document_id)
    if doc is None:
        raise _not_found("document_not_found", "文档不存在")
    title, path_key, parent_id = doc.title, doc.path_key, doc.parent_id
    # target_id 留空：文档马上就不存在了，指过去的外键只会让人以为还能点开。
    # 目标是什么靠 title + 审计说明记住（这条记录本身就是为了「查得到」）。
    _record_audit(
        db, operator,
        action="delete_doc", target_kind="document", target_id=None,
        parent_id=parent_id, title=title, name="", note=note or f"删除路径：{path_key}",
    )
    db.delete(doc)  # 修订随 ondelete=CASCADE 一起走；文件按内容寻址保留，避免影响别处引用
    db.flush()
    return DirectActionOut(
        ok=True, message=f"已删除《{title}》", path=path_key, affected_documents=1
    )


# ----------------------------------------------------------------- 文件夹

def move_folder_direct(
    db: DBSession, operator: Account, folder_id: int, target_parent_id: int | None, note: str
) -> DirectActionOut:
    folder = db.get(DocFolder, folder_id)
    if folder is None:
        raise _not_found("folder_not_found", "文件夹不存在")
    path = move_folder(db, folder, target_parent_id)
    _record_audit(
        db, operator,
        action="move_folder", target_kind="folder", target_id=folder.id,
        parent_id=target_parent_id, title="", name=folder.name, note=note,
    )
    return DirectActionOut(
        ok=True, message=f"文件夹「{folder.name}」已移动到 {path or '根目录'}",
        folder_id=folder.id, path=path,
    )


def rename_folder_direct(
    db: DBSession, operator: Account, folder_id: int, name: str, note: str
) -> DirectActionOut:
    folder = db.get(DocFolder, folder_id)
    if folder is None:
        raise _not_found("folder_not_found", "文件夹不存在")
    old = folder.name
    path = rename_folder(db, folder, name)
    _record_audit(
        db, operator,
        action="move_folder", target_kind="folder", target_id=folder.id,
        parent_id=folder.parent_id, title="", name=folder.name,
        note=note or f"重命名：{old} → {folder.name}",
    )
    return DirectActionOut(
        ok=True, message=f"文件夹已重命名为「{folder.name}」（路径 {path}）",
        folder_id=folder.id, path=path,
    )


def delete_folder_direct(
    db: DBSession, operator: Account, folder_id: int, note: str
) -> DirectActionOut:
    folder = db.get(DocFolder, folder_id)
    if folder is None:
        raise _not_found("folder_not_found", "文件夹不存在")
    subtree = subtree_folder_ids(db, folder.id)
    doc_count = count_subtree_documents(db, subtree)
    if doc_count > MAX_CASCADE_DOCUMENTS:
        raise _conflict(
            "cascade_too_large",
            f"「{folder.name}」下有 {doc_count} 篇文档，超过一次删除上限 "
            f"({MAX_CASCADE_DOCUMENTS})；请先分批清理",
        )
    name, path_key, parent_id = folder.name, folder.path_key, folder.parent_id
    _record_audit(
        db, operator,
        action="delete_folder", target_kind="folder", target_id=None,
        parent_id=parent_id, title="", name=name,
        note=note or f"连带删除 {doc_count} 篇文档（原路径 {path_key}）",
    )
    for fid in sorted(subtree, reverse=True):
        node = db.get(DocFolder, fid)
        if node is not None:
            db.delete(node)
    db.flush()
    return DirectActionOut(
        ok=True,
        message=f"已删除文件夹「{name}」" + (f"（连带 {doc_count} 篇文档）" if doc_count else ""),
        path=path_key,
        affected_documents=doc_count,
    )
