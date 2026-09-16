"""小端 NBT 读取器 —— 基岩版结构文件（.mcstructure）的底层解码。

为什么自己写这一层（2026-09-16 调研结论，见 docs/plans/decisions/ADR-003）：
- Bedrock 的 NBT 是小端，Java 是大端。两者字节序不同，不能共用一个默认实现。
- 环境里已装的 `rapidnbt` 经实测 `to_binary_nbt()` 输出大端（`0a0000 03 01 00 61 01 00 00 00 00`），
  且其 pybind11 版 `NbtFile` 没有公开构造函数、无法指定 LITTLE_ENDIAN 文件格式；
  随它一起装的 Bedrock 封装 `bedrock_protocol.nbt` 在当前版本下 import 即失败
  （`ImportError: cannot import name 'Int64Tag'`）。两者都不能用于 .mcstructure。
- 本项目接受的外部编辑器/工具（Structure Block 导出）产生的 .mcstructure 都是未压缩小端 NBT，
  自实现读取器是约 200 行的确定问题，且能精确控制资源上限与错误分类（04 文档第 3 节要求
  「损坏/截断、超大声明长度」必须有明确行为）。

本模块只做「字节 → Python 原生对象」这一件事，不含任何 .mcstructure 语义；
结构语义在 backend/app/parsers/mcstructure.py。领域层不依赖 FastAPI。
"""
from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass

# NBT 标签类型编号（官方协议定义，Java/Bedrock 一致；差别只在数值字节序）
TAG_END = 0
TAG_BYTE = 1
TAG_SHORT = 2
TAG_INT = 3
TAG_LONG = 4
TAG_FLOAT = 5
TAG_DOUBLE = 6
TAG_BYTE_ARRAY = 7
TAG_STRING = 8
TAG_LIST = 9
TAG_COMPOUND = 10
TAG_INT_ARRAY = 11
TAG_LONG_ARRAY = 12

TAG_NAMES: dict[int, str] = {
    TAG_END: "TAG_End", TAG_BYTE: "TAG_Byte", TAG_SHORT: "TAG_Short", TAG_INT: "TAG_Int",
    TAG_LONG: "TAG_Long", TAG_FLOAT: "TAG_Float", TAG_DOUBLE: "TAG_Double",
    TAG_BYTE_ARRAY: "TAG_Byte_Array", TAG_STRING: "TAG_String", TAG_LIST: "TAG_List",
    TAG_COMPOUND: "TAG_Compound", TAG_INT_ARRAY: "TAG_Int_Array",
    TAG_LONG_ARRAY: "TAG_Long_Array",
}


class NbtError(Exception):
    """NBT 解码失败的基类。上层据此返回结构化错误，不抛 500。"""


class NbtTruncatedError(NbtError):
    """数据在中途结束：文件被截断或不是 NBT。"""


class NbtFormatError(NbtError):
    """字节结构合法但不构成有效 NBT（未知标签类型等）。"""


class NbtLimitError(NbtError):
    """超出资源上限：数组/列表声明长度过大或元素过多。

    这是「压缩膨胀炸弹」与「超大声明长度」的防线：声明长度在一开始就校验，
    不会先分配再发现过大（04 文档第 3 节明确要求覆盖这种情况）。
    """


@dataclass(frozen=True)
class NbtLimits:
    """解析资源上限。默认值面向 .mcstructure 的实际规模，均可在调用处收紧。"""

    max_bytes: int = 64 * 1024 * 1024
    max_depth: int = 64
    max_array_length: int = 16 * 1024 * 1024
    max_list_length: int = 16 * 1024 * 1024
    max_string_length: int = 1024 * 1024


DEFAULT_LIMITS = NbtLimits()


def _detect_compression(data: bytes) -> str | None:
    """按魔数识别压缩方式。.mcstructure 官方为未压缩，但用户常拿到 gzip/zlib 副本。"""
    if len(data) >= 2 and data[0] == 0x1F and data[1] == 0x8B:
        return "gzip"
    if len(data) >= 2 and data[0] == 0x78:
        # zlib 头：CMF 0x78，FLG 需满足 (CMF*256+FLG) % 31 == 0
        if (data[0] * 256 + data[1]) % 31 == 0:
            return "zlib"
    return None


def decompress_if_needed(data: bytes, limits: NbtLimits = DEFAULT_LIMITS) -> tuple[bytes, str | None]:
    """返回 (未压缩字节, 使用的压缩方式或 None)。

    解压时限制输出上限，避免小文件膨胀成超大内存（gzip/zlib 的 decompressobj 按块读）。
    """
    kind = _detect_compression(data)
    if kind is None:
        return data, None

    if kind == "gzip":
        obj = zlib.decompressobj(16 + zlib.MAX_WBITS)
    else:
        obj = zlib.decompressobj()

    out = bytearray()
    try:
        for chunk_start in range(0, len(data), 1 << 20):
            out += obj.decompress(data[chunk_start:chunk_start + (1 << 20)],
                                  limits.max_bytes - len(out))
            if len(out) > limits.max_bytes:
                raise NbtLimitError(
                    f"解压后超过 {limits.max_bytes // (1024 * 1024)} MB 上限"
                )
        out += obj.flush()
    except NbtLimitError:
        raise
    except zlib.error as exc:
        raise NbtFormatError(f"{kind} 解压失败：{exc}") from exc

    if len(out) > limits.max_bytes:
        raise NbtLimitError(f"解压后超过 {limits.max_bytes // (1024 * 1024)} MB 上限")
    return bytes(out), kind


class _Reader:
    """小端 NBT 游标。所有多字节数值按小端读取（Bedrock 口径）。"""

    __slots__ = ("_b", "_i", "_limits")

    def __init__(self, data: bytes, limits: NbtLimits):
        self._b = data
        self._i = 0
        self._limits = limits

    @property
    def pos(self) -> int:
        return self._i

    @property
    def remaining(self) -> int:
        return len(self._b) - self._i

    def _take(self, n: int) -> bytes:
        if n < 0:
            raise NbtFormatError(f"非法长度 {n}")
        end = self._i + n
        if end > len(self._b):
            raise NbtTruncatedError(
                f"数据在第 {self._i} 字节处提前结束（需要 {n} 字节，只剩 {len(self._b) - self._i}）"
            )
        chunk = self._b[self._i:end]
        self._i = end
        return chunk

    def u8(self) -> int:
        return self._take(1)[0]

    def i8(self) -> int:
        return struct.unpack_from("<b", self._take(1))[0]

    def i16(self) -> int:
        return struct.unpack("<h", self._take(2))[0]

    def u16(self) -> int:
        return struct.unpack("<H", self._take(2))[0]

    def i32(self) -> int:
        return struct.unpack("<i", self._take(4))[0]

    def i64(self) -> int:
        return struct.unpack("<q", self._take(8))[0]

    def f32(self) -> float:
        return struct.unpack("<f", self._take(4))[0]

    def f64(self) -> float:
        return struct.unpack("<d", self._take(8))[0]

    def string(self) -> str:
        length = self.u16()
        # 先校验声明长度再看数据够不够：超大声明长度必须报「超限」而不是「截断」，
        # 否则一个坏文件会伪装成被截断的文件（04 文档第 3 节要求的错误分类）。
        if length > self._limits.max_string_length:
            raise NbtLimitError(f"字符串长度 {length} 超过上限 {self._limits.max_string_length}")
        raw = self._take(length)
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise NbtFormatError(f"字符串不是合法 UTF-8（第 {self._i - length} 字节起）") from exc

    def _count(self, kind: str, limit: int) -> int:
        n = self.i32()
        if n < 0:
            raise NbtFormatError(f"{kind} 长度为负数：{n}")
        if n > limit:
            raise NbtLimitError(f"{kind} 长度 {n} 超过上限 {limit}")
        return n

    def payload(self, tag_id: int, depth: int) -> object:
        """读取 tag_id 对应的「值」。调用方必须已经消费掉 tag_id 本身。"""
        if depth > self._limits.max_depth:
            raise NbtLimitError(f"嵌套深度超过 {self._limits.max_depth} 层")

        if tag_id == TAG_BYTE:
            return self.i8()
        if tag_id == TAG_SHORT:
            return self.i16()
        if tag_id == TAG_INT:
            return self.i32()
        if tag_id == TAG_LONG:
            return self.i64()
        if tag_id == TAG_FLOAT:
            return self.f32()
        if tag_id == TAG_DOUBLE:
            return self.f64()
        if tag_id == TAG_STRING:
            return self.string()
        if tag_id == TAG_BYTE_ARRAY:
            n = self._count("TAG_Byte_Array", self._limits.max_array_length)
            return list(self._take(n))
        if tag_id == TAG_INT_ARRAY:
            n = self._count("TAG_Int_Array", self._limits.max_array_length)
            return [self.i32() for _ in range(n)]
        if tag_id == TAG_LONG_ARRAY:
            n = self._count("TAG_Long_Array", self._limits.max_array_length)
            return [self.i64() for _ in range(n)]
        if tag_id == TAG_LIST:
            element_id = self.u8()
            n = self._count("TAG_List", self._limits.max_list_length)
            # 空列表允许元素类型为 TAG_End（Java 习惯）；非空则必须是合法类型
            if n > 0 and element_id == TAG_END:
                raise NbtFormatError("非空 TAG_List 的元素类型不能是 TAG_End")
            return [self.payload(element_id, depth + 1) for _ in range(n)]
        if tag_id == TAG_COMPOUND:
            return self.compound_body(depth + 1)
        raise NbtFormatError(f"未知的标签类型编号：{tag_id}")

    def compound_body(self, depth: int) -> dict[str, object]:
        """读取命名标签直到 TAG_End。复合标签自身的 tag_id 已被调用方消费。"""
        if depth > self._limits.max_depth:
            raise NbtLimitError(f"嵌套深度超过 {self._limits.max_depth} 层")
        out: dict[str, object] = {}
        while True:
            child_id = self.u8()
            if child_id == TAG_END:
                return out
            name = self.string()
            out[name] = self.payload(child_id, depth + 1)


def parse_nbt(
    data: bytes,
    limits: NbtLimits = DEFAULT_LIMITS,
) -> tuple[dict[str, object], str | None]:
    """把（可能是压缩的）小端 NBT 字节解码成 (根复合标签, 压缩方式)。

    根标签必须是 TAG_Compound。解析失败抛 NbtError 的子类，调用方负责转成
    结构化错误；本函数不打印、不记录任何用户数据。
    """
    if not data:
        raise NbtTruncatedError("文件是空的")

    raw, compression = decompress_if_needed(data, limits)
    if len(raw) > limits.max_bytes:
        raise NbtLimitError(f"数据超过 {limits.max_bytes // (1024 * 1024)} MB 上限")

    reader = _Reader(raw, limits)
    root_id = reader.u8()
    if root_id != TAG_COMPOUND:
        raise NbtFormatError(
            f"根标签应是 TAG_Compound(10)，实际是 {TAG_NAMES.get(root_id, root_id)}"
        )
    reader.string()  # 根名恒为空串，读掉即可
    root = reader.compound_body(0)
    return root, compression
