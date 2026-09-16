"""首版文档导入：把本机资料目录（默认 Minecraft\\doc）里的 md/json/txt 收进文档树。

用法（在 backend/ 目录下执行）：

    python scripts/import_docs.py                 # 用默认资料目录
    python scripts/import_docs.py --root "D:\\资料"  # 换目录
    python scripts/import_docs.py --dry-run       # 只列出会导入什么，不写库
    python scripts/import_docs.py --imported-by 站长

脚本只做三件事，顺序固定：

1. **目录先建**：先按磁盘目录结构建出文件夹（含父级），再放文档——这样
   每一篇文档的父目录一定已经存在，不需要「边建边找父级」。
2. **内容按 sha256 去重**：库里已有同摘要的文件记录就复用，不重复占磁盘。
3. **已发布的直接进线上**：导入由站长（superadmin）执行，等价于「超管审核通过」——
   目录树里直接可见。管理员之后上传的内容仍然要走提交单审核（见 routers/docs.py）。

脚本是**幂等**的：再次运行不会产生重复文档（按 `path_key` 匹配），
只有源文件内容变了才会追加一个新版本。
"""
from __future__ import annotations

import argparse
import sys
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path

# 允许直接 `python scripts/import_docs.py`：把 backend/ 放进 sys.path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import func, select  # noqa: E402
from sqlalchemy.orm import Session as DBSession  # noqa: E402

from app import docs_storage as storage  # noqa: E402
from app.config import get_settings  # noqa: E402
from app.db import Base, SessionLocal, engine  # noqa: E402
from app.models import (  # noqa: E402
    Account,
    DocDocument,
    DocFile,
    DocFolder,
    DocRevision,
    next_path_key,
    utcnow,
)

DEFAULT_SOURCE = Path(r"C:\Users\Administrator\Desktop\Minecraft\doc")
ALLOWED_SUFFIXES = tuple(storage.ALLOWED_EXTENSIONS)


@dataclass
class Report:
    folders_created: int = 0
    documents_created: int = 0
    documents_updated: int = 0
    documents_unchanged: int = 0
    bytes_stored: int = 0
    skipped: list[str] = field(default_factory=list)

    def lines(self) -> Iterator[str]:
        yield f"新建文件夹   : {self.folders_created}"
        yield f"新建文档     : {self.documents_created}"
        yield f"更新文档     : {self.documents_updated}（源文件内容有变化）"
        yield f"内容未变跳过 : {self.documents_unchanged}"
        yield f"新落盘字节   : {storage.format_bytes(self.bytes_stored)}"
        if self.skipped:
            yield f"跳过的文件   : {len(self.skipped)}"
            for item in self.skipped[:12]:
                yield f"    - {item}"
            if len(self.skipped) > 12:
                yield f"    … 以及另外 {len(self.skipped) - 12} 个"


def title_of(path: Path, text: str) -> str:
    """标题优先取正文里的一级标题，其次用文件名；两者都可能很脏，所以都做清洗。"""
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            candidate = stripped[2:].strip()
            if candidate:
                return candidate[:200]
        if stripped and not stripped.startswith("---"):
            break  # 只在前言里找标题，避免把正文段落当标题
    stem = path.stem.replace("_", " ").strip()
    return (stem or path.name)[:200]


def summary_of(text: str, limit: int = 160) -> str:
    """摘要取首个非空正文行（跳过标题与 frontmatter 分隔线）。"""
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or stripped in {"---", "```"}:
            continue
        plain = stripped.lstrip(">-*+ ").strip()
        if plain:
            return plain[:limit]
    return ""


def iter_source_files(root: Path, report: Report) -> Iterator[Path]:
    for entry in sorted(root.rglob("*")):
        if entry.is_dir():
            continue
        if entry.suffix.lower() not in ALLOWED_SUFFIXES:
            report.skipped.append(f"{entry.relative_to(root)}（扩展名不在收录范围）")
            continue
        if entry.name.startswith(".") or entry.name.endswith(".bak"):
            report.skipped.append(f"{entry.relative_to(root)}（备份/隐藏文件）")
            continue
        yield entry


def ensure_folder(db: DBSession, names: list[str], cache: dict[tuple[str, ...], DocFolder],
                  operator: Account, report: Report) -> DocFolder | None:
    """按路径段逐级建目录，返回最末一级。cache 以路径元组为键，避免重复查库。"""
    parent: DocFolder | None = None
    parent_path = ""
    for depth, name in enumerate(names):
        key = tuple(names[: depth + 1])
        cached = cache.get(key)
        if cached is not None:
            parent, parent_path = cached, cached.path_key
            continue
        path_key = next_path_key(parent_path, name)
        found = db.scalar(select(DocFolder).where(DocFolder.path_key == path_key))
        if found is None:
            found = DocFolder(
                parent_id=parent.id if parent else None,
                name=name,
                path_key=path_key,
                visibility="public",
                is_published=True,
                created_by=operator.id,
            )
            db.add(found)
            db.flush()
            report.folders_created += 1
        cache[key] = found
        parent, parent_path = found, found.path_key
    return parent


def upsert_document(
    db: DBSession,
    parent: DocFolder | None,
    path: Path,
    body: str,
    doc_format: str,
    operator: Account,
    report: Report,
    *,
    dry_run: bool,
) -> DocDocument | None:
    parent_path = parent.path_key if parent else ""
    slug = storage.slugify(path.stem, fallback="doc")
    path_key = next_path_key(parent_path, slug)
    title = title_of(path, body)
    summary = summary_of(body)

    existing = db.scalar(select(DocDocument).where(DocDocument.path_key == path_key))
    digest = (
        storage.save_bytes(path.name, body.encode("utf-8"), stored_as=path.name)
        if not dry_run
        else None
    )

    if existing is not None:
        current = db.get(DocFile, existing.current_file_id) if existing.current_file_id else None
        if current is not None and digest is not None and current.sha256 == digest.sha256:
            report.documents_unchanged += 1
            return existing
        report.documents_updated += 1
        if dry_run:
            return existing
        file_row = _persist_file(db, digest, path.name, operator, report)
        revision = _new_revision(db, existing, file_row, title, body, doc_format, operator)
        existing.title = title
        existing.summary = summary
        existing.current_revision_id = revision.id
        existing.current_file_id = file_row.id
        existing.doc_format = doc_format
        existing.is_published = True
        existing.updated_at = revision.created_at
        db.flush()
        return existing

    report.documents_created += 1
    if dry_run:
        return None
    file_row = _persist_file(db, digest, path.name, operator, report)
    document = DocDocument(
        parent_id=parent.id if parent else None,
        slug=slug,
        path_key=path_key,
        title=title,
        summary=summary,
        doc_format=doc_format,
        visibility="public",
        is_published=True,
        current_file_id=file_row.id,
        created_by=operator.id,
    )
    db.add(document)
    db.flush()
    revision = _new_revision(db, document, file_row, title, body, doc_format, operator)
    document.current_revision_id = revision.id
    db.flush()
    return document


def _persist_file(
    db: DBSession, stored, source_name: str, operator: Account, report: Report
) -> DocFile:
    """内容寻址去重：同摘要**且同格式**、且磁盘上文件还在的记录才可以复用。

    为什么要带 doc_format：同一段文本可能是 .md 也可能是 .txt，落盘会存成两个
    不同扩展名的文件，对应两条记录才对得上。
    为什么要检查磁盘：库里有一条同摘要的记录、但文件被人删了（清理存储、
    换机器、恢复备份不全），这时复用那条记录会得到一条打不开的文档——
    所以这里必须确认文件真的在，不在就重新落盘。
    `source_name` 是用户在目录树里看到的原始文件名——落盘名是 sha256，不能拿来当显示名。
    """
    found = db.scalar(
        select(DocFile)
        .where(DocFile.sha256 == stored.sha256, DocFile.doc_format == stored.doc_format)
        .order_by(DocFile.id)
    )
    if found is not None and _blob_exists(found.storage_path):
        return found
    report.bytes_stored += stored.byte_size
    row = DocFile(
        original_name=storage.sanitize_name(source_name),
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
    db.flush()
    return row


def _blob_exists(storage_path: str) -> bool:
    try:
        return storage.resolve(storage_path).is_file()
    except storage.DocStorageError:
        return False


def _new_revision(
    db: DBSession,
    document: DocDocument,
    file_row: DocFile,
    title: str,
    body: str,
    doc_format: str,
    operator: Account,
) -> DocRevision:
    last = db.scalar(
        select(func.max(DocRevision.revision_no)).where(DocRevision.document_id == document.id)
    )
    revision = DocRevision(
        document_id=document.id,
        revision_no=int(last or 0) + 1,
        title=title,
        body=body,
        doc_format=doc_format,
        byte_size=len(body.encode("utf-8")),
        file_id=file_row.id,
        note="首版资料导入" if not last else "源文件更新后重新导入",
        edited_by=operator.id,
    )
    db.add(revision)
    db.flush()
    return revision


def run(root: Path, operator_name: str, *, dry_run: bool, limit: int | None) -> int:
    # 运行中的后端进程可能还是旧进程（没建 docs 的表），这里保证表已存在
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    report = Report()
    try:
        operator = db.scalar(select(Account).where(Account.username == operator_name))
        if operator is None:
            operator = db.scalar(
                select(Account).where(Account.role == "superadmin").order_by(Account.id)
            )
        if operator is None:
            print("找不到可用于署名的超管账号：请先在站上注册首个账号（自动成为超管）。")
            return 2
        if not root.is_dir():
            print(f"资料目录不存在：{root}")
            return 2

        print(f"资料来源：{root}")
        print(f"署名账号：{operator.username}（{operator.role}）")
        print("-" * 60)

        cache: dict[tuple[str, ...], DocFolder] = {}
        stored = 0
        for path in iter_source_files(root, report):
            if limit is not None and stored >= limit:
                report.skipped.append("（达到 --limit 上限，其余未处理）")
                break
            relative = path.relative_to(root)
            names = [part for part in relative.parts[:-1]]
            try:
                raw = path.read_bytes()
            except OSError as exc:
                report.skipped.append(f"{relative}（读取失败：{exc}）")
                continue
            text = storage.decode_text_lossy(raw)
            if text is None:
                report.skipped.append(f"{relative}（含二进制内容）")
                continue
            doc_format = storage.doc_format_of(path.name)

            parent = ensure_folder(db, names, cache, operator, report)
            document = upsert_document(
                db, parent, path, text, doc_format, operator, report, dry_run=dry_run
            )
            stored += 1
            prefix = "  " if document is None else "✓ "
            where = "/".join(names) if names else "（根目录）"
            print(f"{prefix}{where}/{path.name}  [{doc_format}] {storage.format_bytes(len(raw))}")

        if dry_run:
            db.rollback()
            print("-" * 60)
            print("--dry-run：以上改动已回滚，没有写入数据库与磁盘。")
        else:
            db.commit()
            print("-" * 60)
        for line in report.lines():
            print(line)
        return 0
    finally:
        db.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="把本机资料目录导入文档树")
    parser.add_argument("--root", type=Path, default=DEFAULT_SOURCE, help="资料来源目录")
    parser.add_argument("--imported-by", default="站长", help="署名账号用户名（默认取首个超管）")
    parser.add_argument("--dry-run", action="store_true", help="只预演，不写库")
    parser.add_argument("--limit", type=int, default=None, help="最多处理多少个文件（调试用）")
    args = parser.parse_args()

    settings = get_settings()
    print(f"数据库  ：{settings.sqlite_path.resolve()}")
    print(f"文件存储：{settings.docs_storage_dir.resolve()}")
    return run(args.root, args.imported_by, dry_run=args.dry_run, limit=args.limit)


if __name__ == "__main__":
    raise SystemExit(main())
