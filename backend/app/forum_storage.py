"""论坛附件的落盘层：内容寻址、受控目录、只暴露 id。

管两类附件，共用同一套规则（内容寻址 + 白名单路径 + 只暴露帖子 id）：

| 目录 | 内容 | 上限 |
| --- | --- | --- |
| `structures/` | `.mcstructure` 原文件 + 它的 gzip 3D 预览载荷 | `NAYTIA_FORUM_STRUCTURE_MAX_BYTES`（10 MB） |
| `covers/` | 帖子封面的图片原文件 | `NAYTIA_FORUM_COVER_MAX_BYTES`（5 MB） |

边界（安全相关，务必保持）：

- **对外只暴露帖子 id，不暴露路径**。`storage_path` 是相对 `storage_root` 的
  sha256 路径，永远不出现在 API 响应里；下载走
  `/api/forum/threads/{id}/structure/file`、封面走 `/…/cover`。
- **内容寻址**：落盘名由文件内容的 sha256 决定，与用户给的文件名无关。
  同一份内容被两个人分别发帖时磁盘上只有一份，而原始文件名各自记在数据库里
  （它只用于展示与 `Content-Disposition`，入库前经 `sanitize_name` 清洗）。
- **先落盘再入库**：解析/校验失败的字节不会留下记录；落盘成功但入库失败时留下的是
  一个没有引用的孤儿文件，不会造成数据不一致（下次同样内容上传会直接复用）。
- **删除要数引用**：内容寻址意味着多个帖子可能指向同一个 blob，
  所以 `remove_files` 只能在该 sha 不再被任何记录引用时调用，由路由层判断。
- **封面类型必须来自字节**，不能来自文件名：调用方先过 `parsers/image_info`，
  把它的 `extension` 传进来，绝不用用户给的扩展名拼路径。

与 `docs_storage` 的关系：同样是「受控目录 + 内容寻址」，但文档树要分块上传、
要存文本正文，这里是一次性读入字节后立刻解析/校验，所以没有复用它的分块逻辑，
只复用 `uploads` 里的文件名清洗与体积格式化。
"""
from __future__ import annotations

import gzip
import hashlib
import re
import shutil
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from .config import get_settings
from .parsers.image_info import ALLOWED_EXTENSIONS as COVER_EXTENSIONS
from .uploads import format_bytes, sanitize_name

# 论坛只接受这一种结构文件（ADR-003 的解析器口径）
STRUCTURE_EXTENSION = ".mcstructure"
_SUBDIR = "structures"
_COVER_SUBDIR = "covers"
# 相对路径的白名单形状。封面只允许 image_info 认得出的四种扩展名——
# 路径里不可能出现 .html / .svg，即使有人绕过校验也拼不出危险的名字。
_PATH_RE = re.compile(
    r"^(?:structures/[0-9a-f]{2}/[0-9a-f]{64}\.(?:mcstructure|render\.json\.gz)"
    r"|covers/[0-9a-f]{2}/[0-9a-f]{64}\.(?:png|jpg|gif|webp))$"
)

# 上传体量上限（单文件），由 NAYTIA_FORUM_STRUCTURE_MAX_BYTES / _COVER_MAX_BYTES 覆盖
_DEFAULT_MAX_BYTES = 10 * 1024 * 1024
_DEFAULT_COVER_MAX_BYTES = 5 * 1024 * 1024


class ForumStorageError(Exception):
    """存储层错误。`code` 供路由翻译成结构化 HTTP 错误。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class StoredStructure:
    """落盘结果：相对路径 + 体积 + 摘要 + 清洗后的原名。"""

    storage_path: str
    byte_size: int
    sha256: str
    original_name: str


def storage_root() -> Path:
    """存储根目录（首次调用时创建）。"""
    root = get_settings().forum_storage_dir
    root.mkdir(parents=True, exist_ok=True)
    return root


def max_bytes() -> int:
    return get_settings().forum_structure_max_bytes or _DEFAULT_MAX_BYTES


def cover_max_bytes() -> int:
    return get_settings().forum_cover_max_bytes or _DEFAULT_COVER_MAX_BYTES


def check_extension(name: str) -> None:
    """只接受 .mcstructure。抛 ForumStorageError 而不是猜用户想传什么。"""
    ext = PurePosixPath(sanitize_name(name)).suffix.lower()
    if ext != STRUCTURE_EXTENSION:
        raise ForumStorageError(
            "unsupported_type",
            f"帖子附件只接受基岩版结构文件（{STRUCTURE_EXTENSION}），"
            f"收到的是 {ext or '无扩展名'}",
        )


def _relative(sha256: str, suffix: str, subdir: str = _SUBDIR) -> PurePosixPath:
    return PurePosixPath(subdir) / sha256[:2] / f"{sha256}{suffix}"


def structure_relpath(sha256: str) -> str:
    return _relative(sha256, STRUCTURE_EXTENSION).as_posix()


def render_relpath(sha256: str) -> str:
    return _relative(sha256, ".render.json.gz").as_posix()


def cover_relpath(sha256: str, extension: str) -> str:
    """封面路径。

    `extension` 必须来自 `parsers/image_info`（由字节判定），**不能**是用户给的
    扩展名——那是这个函数唯一能被用错的地方，所以它不接受任意字符串：
    白名单外的值直接拒绝，而不是「拼出来再说」。
    """
    normalised = extension.lower()
    if normalised not in COVER_EXTENSIONS:
        raise ForumStorageError(
            "unsupported_image", f"不支持的封面扩展名：{extension}"
        )
    return _relative(sha256, normalised, _COVER_SUBDIR).as_posix()


def resolve(storage_path: str) -> Path:
    """把相对路径解析成绝对路径，并确认没有逃出存储根目录。

    先按白名单正则校验形状，再做一次 `resolve()` 兜底——两道都要，
    正则挡的是「形状不对的输入」，`resolve()` 挡的是「符号链接之类把路径拐出去」。
    """
    normalised = PurePosixPath(storage_path.replace("\\", "/")).as_posix()
    if not _PATH_RE.match(normalised):
        raise ForumStorageError("bad_path", "存储路径不合法")
    root = storage_root().resolve()
    target = (root / normalised).resolve()
    if root != target and root not in target.parents:
        raise ForumStorageError("bad_path", "存储路径不合法")
    return target


def save_structure(data: bytes, original_name: str) -> StoredStructure:
    """保存结构文件字节，返回内容寻址的相对路径。

    上限先校验再写盘：超过 10 MB 的文件不会在磁盘上留下任何东西。
    """
    limit = max_bytes()
    if not data:
        raise ForumStorageError("empty_file", "文件是空的")
    if len(data) > limit:
        raise ForumStorageError(
            "file_too_large",
            f"文件 {format_bytes(len(data))} 超过 {format_bytes(limit)} 上限",
        )
    clean_name = sanitize_name(original_name)
    if PurePosixPath(clean_name).suffix.lower() != STRUCTURE_EXTENSION:
        # 走 check_extension 拿到统一的错误文案
        check_extension(clean_name)
        clean_name = f"structure{STRUCTURE_EXTENSION}"

    sha256 = hashlib.sha256(data).hexdigest()
    relative = structure_relpath(sha256)
    target = resolve(relative)
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        # 先写临时文件再改名：两个请求同时上传同一份内容时，
        # 不会有一个读到写了一半的文件（内容寻址下两个请求的字节必然相同）
        staging = target.with_suffix(target.suffix + ".tmp")
        staging.write_bytes(data)
        staging.replace(target)
    return StoredStructure(
        storage_path=relative,
        byte_size=len(data),
        sha256=sha256,
        original_name=clean_name if clean_name else f"structure{STRUCTURE_EXTENSION}",
    )


def save_render(sha256: str, payload_json: bytes) -> tuple[str, int]:
    """把渲染载荷 gzip 后落盘，返回 (相对路径, 压缩后字节数)。

    为什么要**预先**压缩存盘：论坛帖子会被反复打开，而载荷里的位图与下标数组
    高度重复（大段空气、大段同一种方块），gzip 通常能压到 1/10 以下。
    存压缩后的字节 = 每次浏览都省掉一次压缩，磁盘上也只有一份。
    """
    relative = render_relpath(sha256)
    target = resolve(relative)
    target.parent.mkdir(parents=True, exist_ok=True)
    # mtime=0：同样的内容必须产出同样的字节，否则「内容寻址」就名不副实，
    # 也没法用哈希对照两次生成结果
    packed = gzip.compress(payload_json, compresslevel=6, mtime=0)
    if not target.exists():
        staging = target.with_suffix(target.suffix + ".tmp")
        staging.write_bytes(packed)
        staging.replace(target)
    else:
        packed = target.read_bytes()
    return relative, len(packed)


def read_render_gz(render_path: str) -> bytes:
    path = resolve(render_path)
    if not path.is_file():
        raise ForumStorageError("file_missing", "预览数据已不在磁盘上，请重新上传结构文件")
    return path.read_bytes()


def read_structure(storage_path: str) -> bytes:
    path = resolve(storage_path)
    if not path.is_file():
        raise ForumStorageError("file_missing", "文件已不在磁盘上，请联系管理员重新上传")
    return path.read_bytes()


def save_cover(data: bytes, original_name: str, extension: str) -> StoredStructure:
    """保存封面图片字节，返回内容寻址的相对路径。

    与 `save_structure` 的两点不同，都是安全上的必要区别：

    - 体量上限走 `cover_max_bytes()`（封面是给人看的缩略图，不需要 10 MB）；
    - 落盘扩展名由**调用方从字节判定后传进来**（`parsers/image_info`），
      不看用户给的文件名。用户把 `shot.png` 改名成 `shot.html` 也不会影响结果。
    """
    limit = cover_max_bytes()
    if not data:
        raise ForumStorageError("empty_file", "文件是空的")
    if len(data) > limit:
        raise ForumStorageError(
            "file_too_large",
            f"封面 {format_bytes(len(data))} 超过 {format_bytes(limit)} 上限",
        )
    clean_name = sanitize_name(original_name) or f"cover{extension}"
    sha256 = hashlib.sha256(data).hexdigest()
    relative = cover_relpath(sha256, extension)
    target = resolve(relative)
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        staging = target.with_suffix(target.suffix + ".tmp")
        staging.write_bytes(data)
        staging.replace(target)
    return StoredStructure(
        storage_path=relative,
        byte_size=len(data),
        sha256=sha256,
        original_name=clean_name,
    )


def read_cover(storage_path: str) -> bytes:
    path = resolve(storage_path)
    if not path.is_file():
        raise ForumStorageError("file_missing", "封面已不在磁盘上，请联系管理员重新上传")
    return path.read_bytes()


def remove_files(*relative_paths: str | None) -> None:
    """删除落盘文件。失败不抛：文件缺失不算错误。

    调用方负责确认「这个 sha 已经没有任何记录在引用」——内容寻址下
    多个帖子可能共用同一个 blob（见模块开头的边界说明）。
    """
    for relative in relative_paths:
        if not relative:
            continue
        try:
            path = resolve(relative)
        except ForumStorageError:
            continue
        try:
            path.unlink(missing_ok=True)
        except OSError:
            continue
        # 顺手清掉空掉的 <sha[:2]> 目录；非空时会抛 OSError，忽略即可
        try:
            path.parent.rmdir()
        except OSError:
            pass


def purge_all() -> None:
    """清空整个结构附件目录（仅供运维脚本/测试使用，不暴露成接口）。"""
    shutil.rmtree(storage_root(), ignore_errors=True)
