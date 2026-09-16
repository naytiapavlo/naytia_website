"""文档树的落盘层：受控目录、文件名清洗、分块上传。

边界（安全相关，务必保持）：
- **对外只暴露文件 id，不暴露路径**。`storage_path` 是相对 `storage_root` 的
  随机路径，永远不出现在 API 响应里；下载走 `/api/docs/files/{id}/download`。
- **原始文件名只作为显示与 Content-Disposition 用**：入库前经 `sanitize_name`
  去掉路径分隔符与控制字符，避免 `../` 与头注入。
- **分块上传**：客户端按 1 MiB 切片顺序上传，服务端边收边写 `.part` 文件，
  收完再拼接并计算 sha256。服务端不会把整个文件读进内存。
"""
from __future__ import annotations

import hashlib
import re
import shutil
import unicodedata
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from .config import get_settings
from .uploads import ALLOWED_TEXT_EXTENSIONS as ALLOWED_EXTENSIONS
from .uploads import format_bytes, sanitize_name

# 首版接受的文本扩展名 -> 前端展示格式（定义在 uploads.py，与论坛附件共用清洗规则）

# 上传体量上限（单文件），由 NAYTIA_DOCS_MAX_BYTES 覆盖
_DEFAULT_MAX_BYTES = 8 * 1024 * 1024
_CHUNK_NAME = re.compile(r"^(\d{6})\.part$")


class DocStorageError(Exception):
    """存储层错误。`code` 供路由翻译成结构化 HTTP 错误。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class StoredFile:
    """落盘结果：相对路径 + 体积 + 摘要 + 正文（文本才有）。"""

    storage_path: str
    byte_size: int
    sha256: str
    text_content: str | None
    doc_format: str


def storage_root() -> Path:
    """存储根目录（首次调用时创建）。"""
    root = get_settings().docs_storage_dir
    root.mkdir(parents=True, exist_ok=True)
    return root


def max_bytes() -> int:
    return get_settings().docs_max_bytes or _DEFAULT_MAX_BYTES


def doc_format_of(name: str) -> str:
    """扩展名 -> 展示格式；不支持的扩展名抛 DocStorageError。"""
    ext = PurePosixPath(sanitize_name(name)).suffix.lower()
    fmt = ALLOWED_EXTENSIONS.get(ext)
    if fmt is None:
        allowed = "、".join(sorted(ALLOWED_EXTENSIONS))
        raise DocStorageError(
            "unsupported_type",
            f"首版只接受文本文件（{allowed}），收到的是 {ext or '无扩展名'}",
        )
    return fmt


def slugify(title: str, fallback: str = "doc") -> str:
    """标题 -> URL 友好的 slug。

    中文标题没有 ASCII 可折，此时保留中文字符本身（URL 里会被百分号编码），
    只把分隔类字符压成连字符——这样路径仍然可读，也不会撞车。
    """
    text = unicodedata.normalize("NFC", title).strip().lower()
    out: list[str] = []
    for char in text:
        if char.isalnum() or char == "-":
            out.append(char)
        elif char in {" ", "_", ".", "/", "\\", "|", ":", ";", ",", "(", ")", "[", "]"}:
            out.append("-")
    slug = re.sub(r"-{2,}", "-", "".join(out)).strip("-")
    return (slug or fallback)[:120]


def decode_text(data: bytes) -> str:
    """按 UTF-8 解码，失败退回 UTF-8 宽松模式（不丢字、不抛错）。"""
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("utf-8", errors="replace")


def decode_text_lossy(data: bytes) -> str | None:
    """解码为文本；含 NUL 字节的当作二进制，返回 None。"""
    if b"\x00" in data:
        return None
    return decode_text(data)


def resolve(storage_path: str) -> Path:
    """把相对路径解析成绝对路径，并确认没有逃出存储根目录。"""
    root = storage_root().resolve()
    target = (root / storage_path).resolve()
    if root != target and root not in target.parents:
        raise DocStorageError("bad_path", "存储路径不合法")
    return target


def read_text(storage_path: str) -> str:
    path = resolve(storage_path)
    if not path.is_file():
        raise DocStorageError("file_missing", "文件已不在磁盘上，请联系管理员重新上传")
    return decode_text(path.read_bytes())


def delete_blob(storage_path: str) -> None:
    """删除落盘文件（用于替换内容后清理旧文件）。失败不抛：文件缺失不算错误。"""
    try:
        path = resolve(storage_path)
    except DocStorageError:
        return
    try:
        path.unlink(missing_ok=True)
    except OSError:
        return


# ----------------------------------------------------------------- 分块上传

def upload_dir(upload_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,64}", upload_id):
        raise DocStorageError("bad_upload_id", "上传标识不合法")
    path = storage_root() / "uploads" / upload_id
    path.mkdir(parents=True, exist_ok=True)
    return path


def write_chunk(upload_id: str, index: int, data: bytes) -> int:
    """写入第 index 片，返回该片字节数。分片按序号命名，拼接顺序由文件名保证。"""
    path = upload_dir(upload_id) / f"{index:06d}.part"
    with path.open("wb") as handle:
        handle.write(data)
    return len(data)


def received_bytes(upload_id: str) -> int:
    directory = upload_dir(upload_id)
    return sum(part.stat().st_size for part in sorted(directory.glob("*.part")))


def finalize_upload(upload_id: str, original_name: str, declared_size: int | None) -> StoredFile:
    """把分片拼成完整文件，落到 documents/<hash 前两位>/<hash>.<ext>。

    校验：分片序号必须是 0..n-1 连续；总字节数不能超过上限；
    如果创建会话时声明了大小，拼接结果必须一致（防止漏传分片）。
    """
    directory = upload_dir(upload_id)
    parts: list[tuple[int, Path]] = []
    for entry in directory.glob("*.part"):
        match = _CHUNK_NAME.match(entry.name)
        if match:
            parts.append((int(match.group(1)), entry))
    if not parts:
        raise DocStorageError("empty_upload", "没有收到任何分片，请重试上传")
    parts.sort()
    expected = list(range(len(parts)))
    if [index for index, _ in parts] != expected:
        raise DocStorageError("chunk_gap", "上传分片不连续，请重新上传这个文件")

    total = sum(path.stat().st_size for _, path in parts)
    limit = max_bytes()
    if total > limit:
        shutil.rmtree(directory, ignore_errors=True)
        raise DocStorageError(
            "file_too_large", f"文件超过 {format_bytes(limit)} 上限（当前 {format_bytes(total)}）"
        )
    if declared_size is not None and declared_size != total:
        raise DocStorageError(
            "size_mismatch",
            f"声明大小 {declared_size} 字节与实际收到 {total} 字节不一致，请重新上传",
        )
    if total == 0:
        shutil.rmtree(directory, ignore_errors=True)
        raise DocStorageError("empty_upload", "文件是空的")

    digest = hashlib.sha256()
    clean_name = sanitize_name(original_name)
    doc_format = doc_format_of(clean_name)
    suffix = PurePosixPath(clean_name).suffix.lower()

    # 先写临时文件再改名：中途失败不会留下半个正式文件
    staging = directory / "merged.tmp"
    with staging.open("wb") as out:
        for _, path in parts:
            with path.open("rb") as part:
                for block in iter(lambda: part.read(1 << 20), b""):
                    digest.update(block)
                    out.write(block)

    sha256 = digest.hexdigest()
    relative = PurePosixPath("documents") / sha256[:2] / f"{sha256}{suffix}"
    target = storage_root() / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():  # 内容相同的重复上传：复用已有文件，仍算成功
        staging.unlink(missing_ok=True)
    else:
        staging.replace(target)

    text_content = decode_text_lossy(target.read_bytes())
    shutil.rmtree(directory, ignore_errors=True)
    return StoredFile(
        storage_path=relative.as_posix(),
        byte_size=total,
        sha256=sha256,
        text_content=text_content,
        doc_format=doc_format,
    )


def discard_upload(upload_id: str) -> None:
    shutil.rmtree(upload_dir(upload_id), ignore_errors=True)


def save_bytes(original_name: str, data: bytes, *, stored_as: str | None = None) -> StoredFile:
    """一次性保存（导入脚本用）：与分块上传落到同样的内容寻址路径。

    `original_name` 是给用户看的名字，决定格式与 Content-Disposition；
    `stored_as` 是落盘用的名字，默认与 `original_name` 相同。导入脚本会显式
    区分两者——否则「磁盘上的文件名」会被当成原名写进库里（早期版本就是这样错的）。
    """
    limit = max_bytes()
    if len(data) > limit:
        raise DocStorageError("file_too_large", f"文件超过 {format_bytes(limit)} 上限")
    if not data:
        raise DocStorageError("empty_upload", "文件是空的")
    clean_name = sanitize_name(original_name)
    stored_name = sanitize_name(stored_as or clean_name)
    doc_format = doc_format_of(stored_name)
    suffix = PurePosixPath(stored_name).suffix.lower()
    sha256 = hashlib.sha256(data).hexdigest()
    relative = PurePosixPath("documents") / sha256[:2] / f"{sha256}{suffix}"
    target = storage_root() / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        target.write_bytes(data)
    text_content = decode_text_lossy(data)
    return StoredFile(
        storage_path=relative.as_posix(),
        byte_size=len(data),
        sha256=sha256,
        text_content=text_content,
        doc_format=doc_format,
    )
