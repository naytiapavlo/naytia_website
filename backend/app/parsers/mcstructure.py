"""基岩版结构文件（.mcstructure）解析器 —— 纯领域逻辑，不依赖 FastAPI。

格式依据（2026-09-16 核对 https://wiki.bedrock.dev/nbt/mcstructure ）：
- 根复合标签：`format_version`(int)、`size`(list<int>[3])、`structure`(compound)。
- `structure.block_indices`：恰好两个子列表（主层 / 次层），每个长度 = sizeX*sizeY*sizeZ，
  按 **ZYX 顺序** 排列（从结构底部西北角开始）。值 -1 表示「结构空位」（void）。
  两层共用同一个调色板，用来存放共位方块（如水下的水+水草）。
- `structure.palette.default.block_palette`：方块排列列表，每项含
  `name`（如 minecraft:stone）、`states`（方块状态，值类型随状态而变）、`version`。
- `structure.palette.default.block_position_data`：以**位置下标字符串**为键，
  值为 `{block_entity_data, tick_queue_data}`——这就是方块实体（箱子内容、告示牌文字等）NBT。
- `structure.entities`：实体列表，每项 `{block_position:[x,y,z], data:{...}}`，
  data 是完整实体 NBT（含 identifier、Pos、UniqueID 等）。
- `structure.structure_world_origin`：结构被保存时的世界原点。

诚实边界（01 文档第 3 节：不虚构数据）：
本模块只解码与统计文件里**确实存在**的东西。方块实体、实体 NBT 一律原样透出，
不做「猜测字段含义」的推断；未知字段保留在 structured_nbt 里而不是丢掉。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterator

from ..nbt_le import NbtError, NbtFormatError, parse_nbt

# 与 01 文档第 6 节口径一致：单次分析的体素上限，超限明确报错而不是把内存打满
MAX_VOXELS = 16 * 1024 * 1024
# 调色板条目上限（正常情况下最多几百个）
MAX_PALETTE = 65536
# 实体 / 方块实体条目上限
MAX_ENTITIES = 200_000
# 单个实体的 NBT 展开为 JSON 后的节点上限，防止病态文件拖垮响应
MAX_NBT_NODES = 20_000

# 「空气」类方块。真实文件里 air 常常就躺在调色板里、block_indices 也确实引用它，
# 但那等于「这一格什么都没有」。材料清单要的是「得准备多少块方块」，
# 3D 预览也不该画出看不见的方块——所以这两处都按「缺席」处理，
# 但**原始统计口径不变**（`count_blocks` 照样把 air 算进去，与解析接口一致），
# 需要区分的地方单独给字段，不做静默改写。
AIR_BLOCKS = frozenset({"minecraft:air", "minecraft:void_air"})


def is_air_block(name: str) -> bool:
    return name in AIR_BLOCKS


class McStructureError(Exception):
    """结构化错误基类：message 供人读，code 供程序分支（03 文档第 5 节风格）。"""

    code = "mcstructure_error"

    def __init__(self, message: str, *, detail: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.detail = detail


class McStructureFormatError(McStructureError):
    """不是有效的 .mcstructure（缺少必需字段、字段类型不对等）。"""

    code = "invalid_structure"


class McStructureLimitError(McStructureError):
    """超出资源上限。"""

    code = "structure_too_large"


def _require_compound(value: Any, path: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise McStructureFormatError(f"{path} 应该是复合标签（compound）")
    return value


def _require_int(value: Any, path: str) -> int:
    # NBT 整数标签在解码后都是 Python int；bool 是 int 的子类，要排除
    if isinstance(value, bool) or not isinstance(value, int):
        raise McStructureFormatError(f"{path} 应该是整数")
    return value


def _require_string(value: Any, path: str) -> str:
    if not isinstance(value, str):
        raise McStructureFormatError(f"{path} 应该是字符串")
    return value


def _require_int_list(value: Any, path: str, length: int) -> list[int]:
    if not isinstance(value, list):
        raise McStructureFormatError(f"{path} 应该是列表")
    if len(value) != length:
        raise McStructureFormatError(f"{path} 应该有 {length} 个元素，实际 {len(value)} 个")
    return [_require_int(item, f"{path}[{i}]") for i, item in enumerate(value)]


@dataclass
class BlockState:
    """调色板里的一个方块排列。states 的值类型随状态而变，原样保留。"""

    index: int
    name: str
    states: dict[str, Any] = field(default_factory=dict)
    version: int | None = None


@dataclass
class BlockEntityEntry:
    """block_position_data 里的一条：方块实体 NBT 与计划刻队列。"""

    position_index: int
    position: tuple[int, int, int]
    block_entity_data: dict[str, Any] | None = None
    tick_queue_data: list[Any] = field(default_factory=list)
    identifier: str | None = None


@dataclass
class EntityEntry:
    """structure.entities 里的一条。data 是完整实体 NBT。"""

    index: int
    block_position: tuple[int, int, int] | None
    data: dict[str, Any] = field(default_factory=dict)
    identifier: str | None = None


@dataclass
class BlockCount:
    """某一种方块排列（调色板条目）在结构里出现的次数。

    注意统计单位是**调色板条目**而不是方块名：同一个 `minecraft:oak_stairs`
    带不同 `weirdo_direction` 是两个条目，材料清单里也应当分开列——
    玩家要的是「这份图纸到底要多少块什么朝向的楼梯」，不是模糊的名字汇总。
    """

    index: int
    name: str
    states: dict[str, Any]
    count: int
    ratio: float


@dataclass
class LayerFill:
    """某一层的填充情况。"""

    layer: int
    filled: int
    void: int
    fill_ratio: float


@dataclass
class ParsedStructure:
    """解析结果。纯数据，便于测试与序列化。"""

    format_version: int | None
    size: tuple[int, int, int]
    world_origin: tuple[int, int, int] | None
    palette: list[BlockState]
    # 逐层索引：layers[层][位置下标] = 调色板下标（-1 表示 void）
    layers: list[list[int]]
    block_entities: list[BlockEntityEntry]
    entities: list[EntityEntry]
    compression: str | None = None
    # 结构原点取自哪里：'root'（真实文件）/ 'structure'（文档口径）/ None（文件未记录）
    world_origin_source: str | None = None
    # 未知/未消费的根字段，原样保留（不丢数据）
    extra_root_fields: dict[str, Any] = field(default_factory=dict)

    # ---- 派生量 ----

    @property
    def voxel_count(self) -> int:
        x, y, z = self.size
        return x * y * z

    @property
    def layer_count(self) -> int:
        return len(self.layers)

    def block_position(self, index: int) -> tuple[int, int, int]:
        """位置下标 → (x, y, z)。按文档的 ZYX 顺序：先 X 再 Y 再 Z。"""
        x, y, z = self.size
        plane = y * z
        return (
            index // plane,
            (index % plane) // z,
            index % z,
        )

    def palette_index_at(self, layer: int, index: int) -> int:
        return self.layers[layer][index]

    def iter_layer(self, layer: int) -> Iterator[tuple[int, tuple[int, int, int], int]]:
        """遍历一层的 (位置下标, 坐标, 调色板下标)，跳过 void(-1)。"""
        for index, palette_index in enumerate(self.layers[layer]):
            if palette_index == -1:
                continue
            yield index, self.block_position(index), palette_index


def parse_mcstructure(
    data: bytes,
    *,
    max_voxels: int = MAX_VOXELS,
) -> tuple[ParsedStructure, dict[str, Any]]:
    """解析 .mcstructure。

    返回 (解析结果, 原始根 NBT)。原始 NBT 一并返回，便于调用方按需透出未建模字段。
    失败一律抛 McStructureError / nbt_le.NbtError。
    """
    try:
        root, compression = parse_nbt(data)
    except NbtError as exc:
        # 底层 NBT 错误统一包装成领域错误，保留原始信息
        raise McStructureFormatError(str(exc), detail=type(exc).__name__) from exc

    format_version = root.get("format_version")
    if format_version is not None:
        format_version = _require_int(format_version, "format_version")

    if "size" not in root:
        raise McStructureFormatError("缺少必需字段 size")
    size_list = _require_int_list(root["size"], "size", 3)
    size_x, size_y, size_z = size_list
    if min(size_x, size_y, size_z) <= 0:
        raise McStructureFormatError(f"size 必须为正数，实际 {size_list}")

    voxel_count = size_x * size_y * size_z
    if voxel_count > max_voxels:
        raise McStructureLimitError(
            f"结构体积 {size_x}×{size_y}×{size_z} = {voxel_count:,} 格，"
            f"超过单次解析上限 {max_voxels:,} 格"
        )

    if "structure" not in root:
        raise McStructureFormatError("缺少必需字段 structure")
    structure = _require_compound(root["structure"], "structure")

    # ---- 结构原点 ----
    # 格式偏差（2026-09-16 用真实 Structure Block 导出的文件核对时发现）：
    # bedrock.dev 文档把 structure_world_origin 写在 structure 复合体内部，
    # 但真实文件把它放在**根层级**（与 format_version / size 同级）。
    # 两处都探测：先看根（真实文件的口径），再看 structure（文档口径），
    # 并记录来源（world_origin_source），便于使用方判断与对照。
    world_origin = None
    world_origin_source: str | None = None
    if "structure_world_origin" in root:
        origin = _require_int_list(
            root["structure_world_origin"], "structure_world_origin", 3
        )
        world_origin = (origin[0], origin[1], origin[2])
        world_origin_source = "root"
    elif "structure_world_origin" in structure:
        origin = _require_int_list(
            structure["structure_world_origin"], "structure.structure_world_origin", 3
        )
        world_origin = (origin[0], origin[1], origin[2])
        world_origin_source = "structure"

    # ---- 调色板 ----
    palette_raw = _require_compound(structure.get("palette", {}), "structure.palette")
    default_palette = _require_compound(palette_raw.get("default", {}), "palette.default")
    if "default" not in palette_raw:
        # 文档：default 调色板不存在时游戏不放置任何方块，这里同样视为无效结构
        raise McStructureFormatError("palette 里缺少 default（游戏加载时不会放置任何方块）")

    raw_palette = default_palette.get("block_palette", [])
    if not isinstance(raw_palette, list):
        raise McStructureFormatError("block_palette 应该是列表")
    if len(raw_palette) > MAX_PALETTE:
        raise McStructureLimitError(f"调色板有 {len(raw_palette)} 项，超过上限 {MAX_PALETTE}")

    palette: list[BlockState] = []
    for i, item in enumerate(raw_palette):
        entry = _require_compound(item, f"block_palette[{i}]")
        name = _require_string(entry.get("name", ""), f"block_palette[{i}].name")
        states = entry.get("states", {})
        states = dict(states) if isinstance(states, dict) else {}
        version = entry.get("version")
        palette.append(
            BlockState(
                index=i,
                name=name,
                states=states,
                version=version if isinstance(version, int) and not isinstance(version, bool) else None,
            )
        )

    # ---- 方块索引（两层） ----
    raw_indices = structure.get("block_indices")
    if not isinstance(raw_indices, list):
        raise McStructureFormatError("缺少 block_indices 或它不是列表")
    if len(raw_indices) != 2:
        raise McStructureFormatError(
            f"block_indices 应该恰好有 2 个子列表（主层/次层），实际 {len(raw_indices)} 个"
        )
    layers: list[list[int]] = []
    for layer_no, raw_layer in enumerate(raw_indices):
        if not isinstance(raw_layer, list):
            raise McStructureFormatError(f"block_indices[{layer_no}] 应该是列表")
        if len(raw_layer) != voxel_count:
            raise McStructureFormatError(
                f"block_indices[{layer_no}] 有 {len(raw_layer)} 项，"
                f"应等于 size 的乘积 {voxel_count}"
            )
        layer: list[int] = []
        for value in raw_layer:
            # 文档：非 int 标签一律当 0；超出调色板范围按空气处理。这里保持原始值，
            # 由统计阶段决定如何归类，避免静默改写用户数据。
            layer.append(value if isinstance(value, int) and not isinstance(value, bool) else 0)
        layers.append(layer)

    # ---- 方块位置数据（方块实体 NBT） ----
    block_entities: list[BlockEntityEntry] = []
    raw_position_data = default_palette.get("block_position_data", {})
    if isinstance(raw_position_data, dict):
        for key, value in raw_position_data.items():
            try:
                position_index = int(key)
            except (TypeError, ValueError):
                raise McStructureFormatError(
                    f"block_position_data 的键应该是位置下标，实际为 {key!r}"
                ) from None
            if not 0 <= position_index < voxel_count:
                raise McStructureFormatError(
                    f"block_position_data 的位置下标 {position_index} 超出结构范围"
                )
            entry = value if isinstance(value, dict) else {}
            bed = entry.get("block_entity_data")
            bed = dict(bed) if isinstance(bed, dict) else None
            tick = entry.get("tick_queue_data", [])
            tick = list(tick) if isinstance(tick, list) else []
            identifier = None
            if bed is not None and isinstance(bed.get("id"), str):
                identifier = bed["id"]
            block_entities.append(
                BlockEntityEntry(
                    position_index=position_index,
                    position=(
                        position_index // (size_y * size_z),
                        (position_index % (size_y * size_z)) // size_z,
                        position_index % size_z,
                    ),
                    block_entity_data=bed,
                    tick_queue_data=tick,
                    identifier=identifier,
                )
            )

    # ---- 实体 ----
    entities: list[EntityEntry] = []
    raw_entities = structure.get("entities", [])
    if not isinstance(raw_entities, list):
        raise McStructureFormatError("structure.entities 应该是列表")
    if len(raw_entities) > MAX_ENTITIES:
        raise McStructureLimitError(f"实体数量 {len(raw_entities)} 超过上限 {MAX_ENTITIES}")
    for i, raw in enumerate(raw_entities):
        item = _require_compound(raw, f"entities[{i}]")
        block_position = None
        if "block_position" in item:
            bp = _require_int_list(item["block_position"], f"entities[{i}].block_position", 3)
            block_position = (bp[0], bp[1], bp[2])
        data = item.get("data", {})
        data = dict(data) if isinstance(data, dict) else {}
        identifier = data.get("identifier")
        entities.append(
            EntityEntry(
                index=i,
                block_position=block_position,
                data=data,
                identifier=identifier if isinstance(identifier, str) else None,
            )
        )

    known_root = {"format_version", "size", "structure", "structure_world_origin"}
    extra = {k: v for k, v in root.items() if k not in known_root}

    parsed = ParsedStructure(
        format_version=format_version,
        size=(size_x, size_y, size_z),
        world_origin=world_origin,
        world_origin_source=world_origin_source,
        palette=palette,
        layers=layers,
        block_entities=block_entities,
        entities=entities,
        compression=compression,
        extra_root_fields=extra,
    )
    return parsed, root


# ---------------------------------------------------------------- 派生统计
#
# 统计口径只在这里实现一次，`routers/mcstructure.py` 与论坛的材料清单都调用它们。
# 「每个接口各算一套」是这个项目明确要避免的（同一个文件在两个页面上显示
# 不同的方块总数，是比崩溃更难查的问题）。

def count_blocks(parsed: ParsedStructure) -> tuple[list[BlockCount], int, int]:
    """统计各方块数量。

    返回 (按数量降序的统计, 非 void 总数, 越界下标数)。

    两层都算：次层里的水草、水流也是玩家要准备的材料。越界下标按游戏口径
    视为空气，因此**不计入**任何方块，但单独计数返回，不静默吞掉。
    """
    palette_size = len(parsed.palette)
    counts: dict[int, int] = {}
    out_of_range = 0
    for layer in parsed.layers:
        for palette_index in layer:
            if palette_index == -1:
                continue
            if palette_index >= palette_size:
                out_of_range += 1
                continue
            counts[palette_index] = counts.get(palette_index, 0) + 1

    filled = sum(counts.values()) + out_of_range
    entries: list[BlockCount] = []
    for palette_index, count in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])):
        block = parsed.palette[palette_index]
        entries.append(
            BlockCount(
                index=palette_index,
                name=block.name,
                states=block.states,
                count=count,
                ratio=(count / filled) if filled else 0.0,
            )
        )
    return entries, filled, out_of_range


def layer_fills(parsed: ParsedStructure) -> list[LayerFill]:
    """每一层的填充/空位数。"""
    total = parsed.voxel_count
    stats: list[LayerFill] = []
    for number, layer in enumerate(parsed.layers):
        filled = sum(1 for value in layer if value != -1)
        stats.append(
            LayerFill(
                layer=number,
                filled=filled,
                void=total - filled,
                fill_ratio=(filled / total) if total else 0.0,
            )
        )
    return stats


def visible_palette_index(parsed: ParsedStructure, index: int) -> int:
    """某一格**用于渲染**的调色板下标；该格没有可见方块返回 -1。

    两层共位时以主层为准（主层才是玩家放的那个方块），主层是 void 或空气而
    次层有方块时才用次层——这正是「只有水、没有方块」这种情况。
    越界下标按游戏口径视为空气。空气方块按「没有」处理（见 `AIR_BLOCKS`）。
    """
    palette_size = len(parsed.palette)
    for layer in parsed.layers:
        value = layer[index]
        if value == -1 or not 0 <= value < palette_size:
            continue
        if is_air_block(parsed.palette[value].name):
            continue
        return value
    return -1


def has_air(parsed: ParsedStructure, index: int) -> bool:
    """某一格是否「放了东西但那些东西全是空气」。"""
    palette_size = len(parsed.palette)
    for layer in parsed.layers:
        value = layer[index]
        if value == -1 or not 0 <= value < palette_size:
            continue
        if not is_air_block(parsed.palette[value].name):
            return False
    return True
