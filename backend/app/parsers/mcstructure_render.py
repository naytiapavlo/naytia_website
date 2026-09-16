"""把解析结果压成「浏览器能直接画」的轻量渲染载荷 —— 纯领域逻辑，不依赖 FastAPI。

## 为什么需要这一层

论坛帖子要把别人的结构在网页上渲染出来，两边都不能接受的做法是：

- **原样发 block_indices**：那是完整方块数组（64×256×64 就是 104 万格、两层 208 万个
  整数），JSON 化十几 MB。一个帖子页不该背这个量级，而且其中绝大多数是空气。
- **只发服务端算好的可见面**：那样旋转、分层、剖面这些交互就全废了——每动一下
  都要再回一次服务器，社区里「看一眼别人盖的房子」就变成了每帧一次请求。

折中方案是发一层**无损的中间表示**，把「画什么」交给浏览器：

1. `occupancy`：整卷的占用位图，1 格 1 位（空气不占空间，且极好压缩）；
2. `indices`：按位置下标升序排列的调色板下标，每个非空格子一个 8 位或 16 位整数。

浏览器拿到这两样就能自己剔除隐藏面、按层切开、旋转投影，而重复请求为零。
代价是多了一个需要两侧对齐的二进制小协议，所以这里把布局写死并配了对照测试。

## 载荷布局（version 1）

位图按位置下标的顺序编号（位置下标本身是 ZYX 顺序，见 `mcstructure.positionToIndex`）：

- `occupancy`：`ceil(voxel_count / 8)` 字节。第 i 格有方块 ⟺
  `occupancy[i >> 3] >> (i & 7) & 1`（即 LSB-first，与 `bitarray` 默认口径一致）。
- `indices`：长度 = 非空格子数。第 k 个非空格子的调色板下标写在
  `indices[k * (index_bits // 8) : ...]`，**小端**无符号整数。
  `index_bits` 取 8 或 16（调色板超过 256 项时才升到 16）。

调用方遍历位图时若维护一个自增游标 k，就能与 `indices` 对齐——这比再发一份
坐标数组省一半以上体积，而且顺序天然确定，不需要额外排序。

## 资源上限

载荷超过 `max_payload_bytes`（默认 8 MiB，压缩前）时**不生成载荷**，只返回原因。
宁可如实说「这个结构太大，没生成预览」，也不要发一个几十 MB 的响应把对方浏览器
拖死；材料清单不受影响，照样给。
"""
from __future__ import annotations

import base64
from dataclasses import dataclass
from typing import Any

from .mcstructure import (
    BlockCount,
    ParsedStructure,
    count_blocks,
    is_air_block,
    layer_fills,
)

# 载荷格式版本：布局变化时递增，前端按它判断能不能解（不认识就退回二维摘要）
RENDER_VERSION = 1
# 压缩前的载荷上限。8 MiB 的位图 + 下标，gzip 后通常在几十到几百 KB
DEFAULT_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024
# 材料清单最多列多少条。调色板上限 65536，但真实结构几百条就到顶了；
# 超出时按数量降序截断并如实标记，不假装列全了
DEFAULT_MATERIAL_LIMIT = 2000

# 位图里每个字节覆盖的格子数
_BITS_PER_BYTE = 8


@dataclass(frozen=True)
class RenderPayload:
    """可以直接发给浏览器的渲染载荷（字节形态，未做 base64）。"""

    version: int
    size: tuple[int, int, int]
    solid_count: int
    palette_size: int
    index_bits: int
    occupancy: bytes
    indices: bytes
    # 服务端算出「格子太多、面太多」时给前端的提示（不是错误，预览照样能出）
    note: str | None = None

    @property
    def raw_bytes(self) -> int:
        return len(self.occupancy) + len(self.indices)

    def palette_names(self, parsed: ParsedStructure) -> list[str]:
        return [block.name for block in parsed.palette]

    def to_json(self, parsed: ParsedStructure) -> dict[str, Any]:
        """转成响应 JSON。两个大数组用 base64（标准字母表，带 padding）。"""
        return {
            "version": self.version,
            "size": {"x": self.size[0], "y": self.size[1], "z": self.size[2]},
            "voxel_count": self.size[0] * self.size[1] * self.size[2],
            "solid_count": self.solid_count,
            "index_bits": self.index_bits,
            "palette": self.palette_names(parsed),
            "occupancy": base64.b64encode(self.occupancy).decode("ascii"),
            "indices": base64.b64encode(self.indices).decode("ascii"),
            "note": self.note,
        }


@dataclass(frozen=True)
class StructureReport:
    """一次上传的全部派生结果：库里存的摘要 + 可选渲染载荷。"""

    summary: dict[str, Any]
    payload: RenderPayload | None


@dataclass(frozen=True)
class SolidScan:
    """一趟扫描的全部产出。

    为什么合并成一趟：结构可能有上百万格，而 `build_report` 既要位图又要
    「有方块的格子数 / 共位数 / 空气格数」。分两趟扫等于把这个循环写两遍、
    跑两遍，在 1M 格的结构上就是白扔几百毫秒。
    """

    occupancy: bytes
    solid_indices: list[int]
    solid_cells: int
    coincident_cells: int
    air_cells: int


def scan_solid(parsed: ParsedStructure) -> SolidScan:
    """一趟扫出占用位图、非空格子的调色板下标，以及共位/空气统计。

    空气按「缺席」处理（见 `mcstructure.AIR_BLOCKS`）：占了索引但没有可见方块
    的格子不计入 `solid_cells`，而是计入 `air_cells`。这样位图里就不会出现
    看不见的方块，前端的遮挡剔除也不用再判一次空气。
    """
    voxel_count = parsed.voxel_count
    palette_size = len(parsed.palette)
    names = [block.name for block in parsed.palette]
    occupancy = bytearray((voxel_count + _BITS_PER_BYTE - 1) // _BITS_PER_BYTE)
    indices: list[int] = []
    coincident = 0
    air_cells = 0

    layers = parsed.layers
    for index in range(voxel_count):
        chosen = -1
        present = 0
        for layer in layers:
            value = layer[index]
            if value == -1 or not 0 <= value < palette_size:
                continue
            present += 1
            if chosen < 0 and not is_air_block(names[value]):
                chosen = value
        if present > 1:
            # 共位按「两层都写了东西」算，与其中是不是空气无关：
            # 空气也在 block_indices 里占了一层，这就是共位结构的一种。
            coincident += 1
        if chosen < 0:
            if present:
                air_cells += 1
            continue
        occupancy[index >> 3] |= 1 << (index & 7)
        indices.append(chosen)

    return SolidScan(
        occupancy=bytes(occupancy),
        solid_indices=indices,
        solid_cells=len(indices),
        coincident_cells=coincident,
        air_cells=air_cells,
    )


def _encode_indices(values: list[int], index_bits: int) -> bytes:
    if index_bits == 8:
        return bytes(values)
    out = bytearray(len(values) * 2)
    for position, value in enumerate(values):
        out[position * 2] = value & 0xFF
        out[position * 2 + 1] = (value >> 8) & 0xFF
    return bytes(out)


def payload_from_scan(
    parsed: ParsedStructure,
    scan: SolidScan,
    *,
    max_payload_bytes: int = DEFAULT_MAX_PAYLOAD_BYTES,
    max_faces_hint: int = 400_000,
) -> tuple[RenderPayload | None, str | None]:
    """把扫描结果封成渲染载荷。

    返回 `(载荷, 未生成的原因)`，两者互斥：要么载荷非空，要么原因是人话。
    """
    palette_size = len(parsed.palette)
    if palette_size == 0:
        return None, "调色板是空的，没有可渲染的方块"

    if not scan.solid_indices:
        # 全空结构：给一个合法但空的载荷，前端会显示「这个结构里没有方块」
        return (
            RenderPayload(
                version=RENDER_VERSION,
                size=parsed.size,
                solid_count=0,
                palette_size=palette_size,
                index_bits=8,
                occupancy=scan.occupancy,
                indices=b"",
                note=None,
            ),
            None,
        )

    index_bits = 8 if palette_size <= 256 else 16
    indices = _encode_indices(scan.solid_indices, index_bits)
    payload_bytes = len(scan.occupancy) + len(indices)
    if payload_bytes > max_payload_bytes:
        return None, (
            f"结构的预览载荷有 {payload_bytes / (1024 * 1024):.1f} MB，"
            f"超过上限 {max_payload_bytes:,} 字节，未生成 3D 预览"
            "（材料清单仍然可用）"
        )

    # 面数只是一个提示：真实可见面数由浏览器按遮挡关系算，这里给的是上界估计
    faces_hint = scan.solid_cells * 6
    note = None
    if faces_hint > max_faces_hint:
        note = (
            f"结构有 {scan.solid_cells:,} 个方块（不重复面最多 {faces_hint:,} 个），"
            "预览会只画外表面以保持流畅"
        )

    return (
        RenderPayload(
            version=RENDER_VERSION,
            size=parsed.size,
            solid_count=scan.solid_cells,
            palette_size=palette_size,
            index_bits=index_bits,
            occupancy=scan.occupancy,
            indices=indices,
            note=note,
        ),
        None,
    )


def build_payload(
    parsed: ParsedStructure,
    *,
    max_payload_bytes: int = DEFAULT_MAX_PAYLOAD_BYTES,
    max_faces_hint: int = 400_000,
) -> tuple[RenderPayload | None, str | None]:
    """构建渲染载荷（自己扫一遍）。已经有了扫描结果时用 `payload_from_scan`。"""
    return payload_from_scan(
        parsed,
        scan_solid(parsed),
        max_payload_bytes=max_payload_bytes,
        max_faces_hint=max_faces_hint,
    )


def _material_rows(materials: list[BlockCount], limit: int) -> list[dict[str, Any]]:
    """材料清单行。

    `ratio` 在这里**按材料总数重算**，而不是沿用 `BlockCount.ratio`
    （那是以「含空气的非 void 总数」为分母的，是解析接口的口径）。
    材料清单上列出来的比例必须加起来等于 1，否则「石头占 33% + 楼梯占 22%」
    会让读者以为剩下 45% 是别的东西，而其实全是空气。
    """
    total = sum(item.count for item in materials)
    rows: list[dict[str, Any]] = []
    for entry in materials[:limit]:
        rows.append(
            {
                "index": entry.index,
                "name": entry.name,
                # 方块状态是 NBT 原始值，类型随状态而变（字符串/整数/字节），
                # 原样透出交给前端展示，不在服务端做「翻译成中文」的推断
                "states": entry.states,
                "count": entry.count,
                "ratio": (entry.count / total) if total else 0.0,
            }
        )
    return rows


def build_report(
    parsed: ParsedStructure,
    *,
    file_bytes: int,
    material_limit: int = DEFAULT_MATERIAL_LIMIT,
    max_payload_bytes: int = DEFAULT_MAX_PAYLOAD_BYTES,
) -> StructureReport:
    """把解析结果整理成「库里存的摘要 + 渲染载荷」。

    摘要里的每一个数字都来自文件本身，没有补零也没有猜测；算不出来的（例如
    调色板越界）单独列字段，不混进方块总数里。
    """
    materials, placed_blocks, out_of_range = count_blocks(parsed)
    fills = layer_fills(parsed)
    scan = scan_solid(parsed)

    # 材料清单去掉空气：真实文件的调色板里常常就躺着 minecraft:air，
    # 而「要准备 4 块空气」对玩家毫无意义。原始口径不变——
    # placed_blocks 照样包含空气，air_cells 单独列出来，没有任何数字被藏起来。
    real_materials = [item for item in materials if not is_air_block(item.name)]
    air_blocks = placed_blocks - sum(item.count for item in real_materials)

    payload, render_reason = payload_from_scan(
        parsed, scan, max_payload_bytes=max_payload_bytes
    )

    summary: dict[str, Any] = {
        "format_version": parsed.format_version,
        "compression": parsed.compression,
        "file_bytes": file_bytes,
        "size": {"x": parsed.size[0], "y": parsed.size[1], "z": parsed.size[2]},
        "voxel_count": parsed.voxel_count,
        "world_origin": list(parsed.world_origin) if parsed.world_origin else None,
        "world_origin_source": parsed.world_origin_source,
        "layer_count": len(parsed.layers),
        "layers": [
            {
                "layer": item.layer,
                "filled": item.filled,
                "void": item.void,
                "fill_ratio": item.fill_ratio,
            }
            for item in fills
        ],
        # solid_cells = 会在 3D 预览里出现的格子；placed_blocks = 真正放了多少块方块
        # （含空气，与 /api/mcstructure/parse 口径一致）；air_cells = 其中按空气处理的格子
        "solid_cells": scan.solid_cells,
        "placed_blocks": placed_blocks,
        "air_cells": scan.air_cells,
        "air_blocks": air_blocks,
        "coincident_cells": scan.coincident_cells,
        "out_of_range_indices": out_of_range,
        "palette_size": len(parsed.palette),
        "materials": _material_rows(real_materials, material_limit),
        "materials_total": len(real_materials),
        "materials_truncated": len(real_materials) > material_limit,
        "block_entities": len(parsed.block_entities),
        "entities": len(parsed.entities),
        "extra_root_fields": sorted(parsed.extra_root_fields),
        "render": {
            "available": payload is not None,
            "reason": render_reason,
            "version": RENDER_VERSION if payload is not None else None,
            "bytes": payload.raw_bytes if payload is not None else None,
            "note": payload.note if payload is not None else None,
        },
    }
    return StructureReport(summary=summary, payload=payload)
