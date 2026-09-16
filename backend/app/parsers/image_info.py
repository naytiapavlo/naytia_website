"""图片的**字节级**识别与尺寸读取 —— 纯标准库，不依赖 Pillow。

## 为什么不能只看扩展名

用户上传的封面会由本站的 origin 直接提供（`/api/forum/threads/{id}/cover`）。
如果只信文件名，一个叫 `cover.png` 的 HTML 或 SVG 就会被浏览器当成网页执行，
变成存储型 XSS。所以**判定完全基于文件头字节**，用户给的扩展名只用来显示：

- 认不出魔数 → 拒绝，不做「猜一个类型」的尝试；
- 认出来了但头部读不出尺寸 → 也拒绝（说明文件损坏或根本不是那个格式）。

**SVG 一律拒绝**：它确实是图片，但可以内嵌脚本与外部引用，
浏览器把它当文档渲染时就是一段可执行内容。要支持得先做消毒，那是另一个量级的工作，
而截图/照片本来就不该是 SVG。

## 支持的格式

只支持四种浏览器普遍能直接渲染的位图格式：PNG / JPEG / GIF / WebP。
不支持就把话说清楚（当前状态里的每一张截图都是 PNG，够用）。
"""
from __future__ import annotations

from dataclasses import dataclass

# 魔数 -> (MIME 类型, 落盘用的扩展名)
PNG = ("image/png", ".png")
JPEG = ("image/jpeg", ".jpg")
GIF = ("image/gif", ".gif")
WEBP = ("image/webp", ".webp")

SUPPORTED = (PNG, JPEG, GIF, WEBP)
ALLOWED_MIME = frozenset(mime for mime, _ in SUPPORTED)
ALLOWED_EXTENSIONS = frozenset(ext for _, ext in SUPPORTED)


class ImageFormatError(Exception):
    """不是受支持的图片。`code` 供路由翻译成结构化 HTTP 错误。"""

    def __init__(self, message: str, *, code: str = "unsupported_image") -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class ImageInfo:
    """识别结果：MIME、扩展名、像素尺寸。"""

    mime: str
    extension: str
    width: int
    height: int


def _read_int(data: bytes, offset: int, length: int) -> int:
    """大端读取（PNG 与 JPEG 都是网络字节序）。"""
    return int.from_bytes(data[offset : offset + length], "big")


# ---------------------------------------------------------------- PNG

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def _png_size(data: bytes) -> tuple[int, int]:
    # 签名 8 字节 + IHDR 的长度/类型 8 字节 = 16，宽高各 4 字节大端
    if len(data) < 24:
        raise ImageFormatError("PNG 文件头不完整", code="invalid_image")
    if data[12:16] != b"IHDR":
        raise ImageFormatError("PNG 的第一个数据块不是 IHDR，文件可能已损坏",
                               code="invalid_image")
    return _read_int(data, 16, 4), _read_int(data, 20, 4)


# ---------------------------------------------------------------- GIF

def _gif_size(data: bytes) -> tuple[int, int]:
    # 6 字节签名 + 逻辑屏幕宽高各 2 字节小端
    if len(data) < 10:
        raise ImageFormatError("GIF 文件头不完整", code="invalid_image")
    return int.from_bytes(data[6:8], "little"), int.from_bytes(data[8:10], "little")


# ---------------------------------------------------------------- WebP

def _webp_size(data: bytes) -> tuple[int, int]:
    """WebP 有三种容器：VP8（有损）、VP8L（无损）、VP8X（扩展）。三处都要认。

    长度检查必须**按分支各查各的**：最小的 VP8 文件只有 28 字节、
    VP8L 只有 26 字节，用一个统一的「至少 30 字节」卡在前面会把它们误判成损坏文件。
    """
    chunk = data[12:16]
    if chunk == b"VP8X":
        # 扩展格式：1 字节标志 + 3 字节保留 + 24 位小端的 (宽-1) 与 (高-1)
        if len(data) < 30:
            raise ImageFormatError("WebP(VP8X) 文件头不完整", code="invalid_image")
        width = int.from_bytes(data[24:27], "little") + 1
        height = int.from_bytes(data[27:30], "little") + 1
        return width, height
    if chunk == b"VP8L":
        if len(data) < 25:
            raise ImageFormatError("WebP(VP8L) 文件头不完整", code="invalid_image")
        if data[20] != 0x2F:
            raise ImageFormatError("WebP(VP8L) 数据块格式不对", code="invalid_image")
        bits = int.from_bytes(data[21:25], "little")
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    if chunk == b"VP8 ":
        # 有损格式：帧头里先是 3 字节起始码 0x9d 0x01 0x2a，然后是 16 位宽高（各 14 位有效）
        if len(data) < 30:
            raise ImageFormatError("WebP(VP8) 文件头不完整", code="invalid_image")
        if data[23:26] != b"\x9d\x01\x2a":
            raise ImageFormatError("WebP(VP8) 帧头不对", code="invalid_image")
        width = int.from_bytes(data[26:28], "little") & 0x3FFF
        height = int.from_bytes(data[28:30], "little") & 0x3FFF
        return width, height
    raise ImageFormatError("无法识别的 WebP 数据块，文件可能已损坏", code="invalid_image")


# ---------------------------------------------------------------- JPEG

# JPEG 的帧起始标记（SOF0..SOF15），其中 C4/C8/CC 是其它用途，不是帧头
_SOF_MARKERS = {
    0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
    0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF,
}


def _jpeg_size(data: bytes) -> tuple[int, int]:
    """沿 JPEG 的段链走到第一个 SOF 段。

    不能像 PNG 那样定点读：JPEG 的元数据段长度不定（EXIF 缩略图可以有几十 KB），
    宽高在哪个偏移只有走完前面所有段才知道。上限步数防止畸形文件把循环拖住。
    """
    offset = 2  # 跳过 SOI
    total = len(data)
    for _ in range(1024):
        if offset + 4 > total:
            raise ImageFormatError("JPEG 里找不到帧头（可能已截断）", code="invalid_image")
        if data[offset] != 0xFF:
            raise ImageFormatError("JPEG 段结构不对（缺少 0xFF 标记）", code="invalid_image")
        marker = data[offset + 1]
        # 填充字节：0xFF 可以连续出现
        if marker == 0xFF:
            offset += 1
            continue
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            offset += 2  # 无长度字段的标记
            continue
        if marker == 0xD9:  # EOI：走到结尾都没见到 SOF
            raise ImageFormatError("JPEG 里找不到帧头", code="invalid_image")
        segment_length = _read_int(data, offset + 2, 2)
        if segment_length < 2:
            raise ImageFormatError("JPEG 段长度非法", code="invalid_image")
        if marker in _SOF_MARKERS:
            if offset + 9 > total:
                raise ImageFormatError("JPEG 帧头不完整", code="invalid_image")
            # SOF：长度(2) + 精度(1) + 高(2) + 宽(2)
            height = _read_int(data, offset + 5, 2)
            width = _read_int(data, offset + 7, 2)
            return width, height
        offset += 2 + segment_length
    raise ImageFormatError("JPEG 段过多，无法定位帧头", code="invalid_image")


# ---------------------------------------------------------------- 入口

def inspect_image(data: bytes) -> ImageInfo:
    """识别图片格式并读出像素尺寸；不是受支持的图片就抛 ImageFormatError。"""
    if not data:
        raise ImageFormatError("文件是空的", code="empty_file")
    if len(data) < 12:
        # 12 是「至少要装得下 4 字节魔数 + 一个长度字段」的下限。
        # 再往上不放统一门槛：最小的合法 GIF 只有 19 字节、JPEG 只有 17 字节，
        # 用一个看起来更安全的数字卡在这里，会把结构完全正常的文件判成损坏。
        # 各分支自己按需要的偏移做长度检查。
        raise ImageFormatError("文件太小，不像任何图片格式", code="invalid_image")

    if data.startswith(_PNG_SIGNATURE):
        width, height = _png_size(data)
        mime, extension = PNG
    elif data.startswith(b"\xff\xd8\xff"):
        width, height = _jpeg_size(data)
        mime, extension = JPEG
    elif data[:6] in (b"GIF87a", b"GIF89a"):
        width, height = _gif_size(data)
        mime, extension = GIF
    elif data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        width, height = _webp_size(data)
        mime, extension = WEBP
    else:
        # SVG 单独给一句：它确实是图片，但可以内嵌脚本，不能当封面收
        head = data[:400].lstrip()
        if head.startswith(b"<?xml") and b"<svg" in data[:2048] or head.startswith(b"<svg"):
            raise ImageFormatError(
                "不支持 SVG 封面：它可以内嵌脚本，浏览器按文档渲染时就是可执行内容。"
                "请导出为 PNG / JPEG / WebP 再上传。",
                code="unsupported_image",
            )
        raise ImageFormatError(
            "认不出这个图片格式。当前支持 PNG / JPEG / GIF / WebP，"
            "不接受 SVG。",
            code="unsupported_image",
        )

    if width <= 0 or height <= 0:
        raise ImageFormatError(
            f"图片尺寸不合法（{width}×{height}），文件可能已损坏", code="invalid_image"
        )
    return ImageInfo(mime=mime, extension=extension, width=width, height=height)


def matches_extension(info: ImageInfo, declared_name: str) -> bool:
    """用户给的扩展名是否与实际格式一致。

    不一致**不拒绝**（很多人直接把截图改名），但记录下来供界面提示：
    真正决定 Content-Type 的永远是字节，不是文件名。
    """
    dot = declared_name.rfind(".")
    if dot < 0:
        return False
    return declared_name[dot:].lower() == info.extension
