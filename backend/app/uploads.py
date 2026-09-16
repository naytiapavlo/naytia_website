"""上传文件的共用规则：文件名清洗、体积格式化、带上限的读取。

只放「确实有了第二个使用者」的东西（02 文档：shared 只放确需复用的能力）。
目前的三个使用者：

- 文档树（`docs_storage`）与论坛结构附件（`forum_storage`）都要把用户给的
  文件名洗成安全、可展示的基名——各写一份迟早漂移，而这里漂移的后果是
  路径穿越或响应头注入，不是样式问题。
- `.mcstructure` 解析接口（`routers/mcstructure`）与论坛发帖附件
  （`routers/forum`）都要「边读边数、超限立刻中止」，且必须报同一个错误码。
"""
from __future__ import annotations

import re
import unicodedata
from pathlib import PurePosixPath

from fastapi import HTTPException, UploadFile, status

# 首版接受的文本扩展名 -> 前端展示格式
ALLOWED_TEXT_EXTENSIONS: dict[str, str] = {
    ".md": "md",
    ".markdown": "md",
    ".txt": "txt",
    ".json": "json",
}

# 读上传内容的分块大小：避免一次性把超大文件读进内存又立刻超过上限
READ_CHUNK = 1 << 20


def sanitize_name(name: str) -> str:
    """清洗上传文件名：只保留基名，去掉控制字符与头注入字符。

    注意：这里清洗的是**用户看到的原名**，落盘路径另行生成随机名，
    所以即使原名里全是奇怪字符也不会影响磁盘布局。
    """
    base = PurePosixPath(name.replace("\\", "/")).name
    base = unicodedata.normalize("NFC", base)
    base = re.sub(r'[\x00-\x1f\x7f"\\/]', "", base).strip(" .")
    if not base:
        base = "document.txt"
    return base[:180]


def format_bytes(size: int) -> str:
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    return f"{size / (1024 * 1024):.2f} MB"


async def read_upload_limited(file: UploadFile, max_bytes: int, *, label: str = "文件") -> bytes:
    """分块读取上传内容，超过上限立刻中止（不把超大文件读满内存）。

    超限报 413 + `file_too_large`：两个上传入口（结构解析、论坛附件）必须
    给出同一个错误码，否则前端要为同一件事写两套判断。
    """
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(READ_CHUNK)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail={
                    "code": "file_too_large",
                    "message": f"{label}超过 {format_bytes(max_bytes)} 上限",
                },
            )
        chunks.append(chunk)
    return b"".join(chunks)
