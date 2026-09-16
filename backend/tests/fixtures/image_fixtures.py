"""测试夹具：手工构造最小但**合法**的图片字节（PNG / JPEG / GIF / WebP）。

存在的理由（与 mcstructure 夹具同一条道理）：

1. 封面校验完全基于文件头，所以必须有「头部正确、尾部无关」的最小样本，
   才能单独验证「能不能认出来」而不被解码器干扰；
2. 更要有**长得像但不是图片**的样本——改名的 HTML、内嵌脚本的 SVG、
   头部合法但尺寸读不出来的截断文件。这些是真正要防的攻击面，
   靠「拿一张真截图试试」是测不到的；
3. 不引入 Pillow：夹具用纯标准库拼字节，被测代码也不需要图像库，
   两边都没有新依赖。

生成的字节只保证**头部结构合法**，不保证任何解码器能还原出像素——
被测代码只读文件头，这个精度正合适。
"""
from __future__ import annotations

import struct
import zlib
from typing import Any

# ---------------------------------------------------------------- PNG

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def png(width: int = 64, height: int = 48) -> bytes:
    """一张真正能被解码的最小 PNG（纯色），顺带验证 zlib/CRC 路径。"""
    # IHDR：宽、高、位深 8、颜色类型 2（真彩）、压缩/滤波/隔行都是 0
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    # 每行 1 字节滤波类型 + width 个 RGB 像素
    raw = b"".join(
        b"\x00" + bytes([(row * 7) % 256, 64, 160]) * width for row in range(height)
    )

    def chunk(kind: bytes, payload: bytes) -> bytes:
        body = kind + payload
        return struct.pack(">I", len(payload)) + body + struct.pack(
            ">I", zlib.crc32(body) & 0xFFFFFFFF
        )

    return (
        _PNG_SIGNATURE
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 6))
        + chunk(b"IEND", b"")
    )


def png_with_declared_size(width: int, height: int) -> bytes:
    """只把 IHDR 里的宽高写成指定值，其余照旧（用于验证宽度解析）。"""
    data = bytearray(png(1, 1))
    data[16:20] = struct.pack(">I", width)
    data[20:24] = struct.pack(">I", height)
    # 改了 IHDR 就要重算它的 CRC，否则严格解码器会拒；被测代码只读宽高，
    # 但夹具本身保持「结构自洽」，免得将来换成真解码器时这个夹具失效
    crc = zlib.crc32(bytes(data[12:29])) & 0xFFFFFFFF
    data[29:33] = struct.pack(">I", crc)
    return bytes(data)


# ---------------------------------------------------------------- GIF

def gif(width: int = 32, height: int = 16) -> bytes:
    """GIF89a 头 + 逻辑屏幕描述符 + 结束块。"""
    header = b"GIF89a"
    screen = struct.pack("<HH", width, height) + bytes([0xF0, 0x00, 0x00])
    # 一个 2 色的全局调色板
    palette = bytes([255, 255, 255, 0, 0, 0])
    trailer = b"\x3b"
    return header + screen + palette + trailer


# ---------------------------------------------------------------- WebP

def _riff(payload: bytes, kind: bytes = b"WEBP") -> bytes:
    body = kind + payload
    return b"RIFF" + struct.pack("<I", len(body)) + body


def _chunk(fourcc: bytes, payload: bytes) -> bytes:
    # RIFF 块长度按偶数字节对齐
    padding = b"\x00" if len(payload) % 2 else b""
    return fourcc + struct.pack("<I", len(payload)) + payload + padding


def webp_lossless(width: int = 40, height: int = 30) -> bytes:
    """VP8L：5 字节头 + 14 位宽 + 14 位高（都是「值 - 1」）。"""
    bits = ((width - 1) & 0x3FFF) | (((height - 1) & 0x3FFF) << 14)
    payload = b"\x2f" + struct.pack("<I", bits)
    return _riff(_chunk(b"VP8L", payload))


def webp_lossy(width: int = 40, height: int = 30) -> bytes:
    """VP8：3 字节帧标签 + 3 字节起始码 0x9d 0x01 0x2a + 16 位宽高（各 14 位有效）。

    帧标签不能省：没有它的「3 字节起始码」会落在错误的偏移上，
    这正是被测代码要按固定偏移读的那个位置，夹具写错就会两边一起错。
    """
    frame_tag = b"\x00\x00\x00"  # 关键帧、版本 0、首分区长度 0
    frame = frame_tag + b"\x9d\x01\x2a" + struct.pack("<HH", width & 0x3FFF, height & 0x3FFF)
    return _riff(_chunk(b"VP8 ", frame))


def webp_extended(width: int = 40, height: int = 30) -> bytes:
    """VP8X：1 字节标志 + 3 字节保留 + 3 字节 (宽-1) + 3 字节 (高-1)，共 10 字节。"""
    payload = bytes([0x00, 0x00, 0x00, 0x00])
    payload += struct.pack("<I", (width - 1) & 0xFFFFFF)[:3]
    payload += struct.pack("<I", (height - 1) & 0xFFFFFF)[:3]
    return _riff(_chunk(b"VP8X", payload))


# ---------------------------------------------------------------- JPEG

def jpeg(width: int = 48, height: int = 36, *, exif_bytes: int = 0) -> bytes:
    """JPEG：SOI + 一个（可选的、很长的）APP1/EXIF 段 + SOF0 + EOI。

    `exif_bytes` 用来构造「元数据很长」的情况——真实手机照片的 EXIF 缩略图
    可以有几万字节，宽高不在固定偏移上，只有沿段链走才找得到。
    这正是定点读取会踩的坑，所以夹具必须能造出这种样本。
    """
    out = bytearray(b"\xff\xd8")  # SOI
    if exif_bytes:
        # 段长度字段包含它自己那 2 字节，再加上 "Exif\0\0" 这 6 字节
        payload = b"Exif\x00\x00" + b"\x00" * exif_bytes
        out += b"\xff\xe1" + struct.pack(">H", len(payload) + 2) + payload
    # SOF0：长度(2)=8+3*分量数，精度(1)，高(2)，宽(2)，分量数(1)
    out += b"\xff\xc0" + struct.pack(">HBHHB", 8 + 3, 8, height, width, 1)
    out += b"\x01\x11\x00"
    out += b"\xff\xd9"  # EOI
    return bytes(out)


# ---------------------------------------------------------------- 恶意/畸形样本

def fake_png_html() -> bytes:
    """扩展名是 .png，内容是 HTML——只信文件名的实现会把它当图片存下来。"""
    return b"<!DOCTYPE html><html><body><script>alert(1)</script></body></html>"


def svg_with_script() -> bytes:
    """内嵌脚本的 SVG。它确实是图片，但浏览器按文档渲染时就是可执行内容。"""
    return (
        b'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">'
        b'<script>alert(document.domain)</script>'
        b'<rect width="100" height="100" fill="red"/></svg>'
    )


def svg_xml_declaration() -> bytes:
    """带 XML 声明的 SVG（另一种常见开头，识别逻辑两处都要覆盖）。"""
    return (
        b'<?xml version="1.0" encoding="UTF-8"?>\n'
        b'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'
        b'<script>alert(1)</script></svg>'
    )


def truncated_png() -> bytes:
    """PNG 签名正确，但后面被截断——认出格式却读不出尺寸，必须拒绝。"""
    return _PNG_SIGNATURE + b"\x00\x00\x00\x0dIHDR"


def png_bad_first_chunk() -> bytes:
    """签名正确，第一个数据块不是 IHDR（长度够长所以不是「截断」）。"""
    return _PNG_SIGNATURE + struct.pack(">I", 13) + b"IDAT" + b"\x00" * 20


def truncated_jpeg() -> bytes:
    """SOI 之后就断了：JPEG 里找不到帧头。"""
    return b"\xff\xd8\xff\xe0"


def zero_size_gif() -> bytes:
    """宽高都是 0 的 GIF：结构合法但尺寸不合法。"""
    return b"GIF89a" + struct.pack("<HH", 0, 0) + bytes([0xF0, 0x00, 0x00])


# ---------------------------------------------------------------- CLI

BUILDERS: dict[str, Any] = {
    "png": png,
    "gif": gif,
    "jpeg": jpeg,
    "webp_lossless": webp_lossless,
    "webp_lossy": webp_lossy,
    "webp_extended": webp_extended,
    "png_wide": lambda: png_with_declared_size(1280, 720),
    "not_image": fake_png_html,
    "svg_script": svg_with_script,
}


def _main() -> int:
    import argparse
    import pathlib

    parser = argparse.ArgumentParser(description="生成封面测试夹具")
    parser.add_argument("--out", type=pathlib.Path, help="输出文件路径")
    parser.add_argument("--kind", default="png", choices=sorted(BUILDERS))
    args = parser.parse_args()

    data = BUILDERS[args.kind]()
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_bytes(data)
        print(f"已写入 {args.out}（{len(data)} 字节）")
    else:
        print(f"{args.kind}: {len(data)} 字节")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
