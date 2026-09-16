"""Pydantic 契约：.mcstructure 解析 API（OpenAPI 单一事实源，ADR-001）。

字段命名沿用 NBT 的原始名字（id/identifier/Count/Name/Slot 等），不擅自改成
驼峰或中文——这些是游戏自有的键名，改名会让前端无法与存档/其它工具对照。
解释性文案放在 description 里，不占用字段名。
"""
from typing import Any

from pydantic import BaseModel, Field


class StructureSize(BaseModel):
    x: int = Field(description="X 方向尺寸（方块数）")
    y: int = Field(description="Y 方向尺寸（方块数）")
    z: int = Field(description="Z 方向尺寸（方块数）")


class BlockStateEntry(BaseModel):
    """调色板里的一个方块排列（block_palette 的一项）。"""

    index: int = Field(description="在调色板中的下标；block_indices 里的值就是它")
    name: str = Field(description="方块标识，如 minecraft:stone")
    states: dict[str, Any] = Field(
        default_factory=dict,
        description="方块状态。值类型随状态而定：字符串 / 整数 / 字节（布尔）",
    )
    version: int | None = Field(default=None, description="该方块的兼容版本号")


class BlockEntityEntry(BaseModel):
    """block_position_data 的一条：方块实体 NBT 与计划刻队列。"""

    index: int = Field(description="位置下标（ZYX 顺序）；用 /position 可换算成坐标")
    x: int
    y: int
    z: int
    identifier: str | None = Field(default=None, description="block_entity_data.id")
    block_entity_data: dict[str, Any] | None = Field(
        default=None, description="方块实体 NBT 原文（箱子内容、告示牌文字等）"
    )
    tick_queue_data: list[Any] = Field(
        default_factory=list, description="计划刻队列（如珊瑚死亡、水流更新）"
    )


class EntityEntry(BaseModel):
    """structure.entities 的一条：完整实体 NBT。"""

    index: int = Field(description="在 entities 列表中的序号")
    block_position: StructureSize | None = Field(
        default=None,
        description="保存时的方块坐标（相对结构）；Pos 是绝对世界坐标，加载时会被替换",
    )
    identifier: str | None = Field(default=None, description="实体标识，如 minecraft:armor_stand")
    data: dict[str, Any] = Field(
        default_factory=dict, description="实体 NBT 原文，含 Pos / UniqueID / 自定义字段"
    )


class BlockCountEntry(BaseModel):
    index: int = Field(description="调色板下标")
    name: str
    states: dict[str, Any] = Field(default_factory=dict)
    count: int = Field(description="出现次数（含所有层）")
    ratio: float = Field(description="占非 void 方块总数的比例，0~1")


class LayerStats(BaseModel):
    layer: int = Field(description="0 = 主层，1 = 次层（共位方块，如水下的水+水草）")
    filled: int = Field(description="该层中非 void 的方块数")
    void: int = Field(description="该层中 void(-1) 的数量")
    fill_ratio: float = Field(description="filled / 总格数，0~1")


class StructureStats(BaseModel):
    total_voxels: int = Field(description="size 的乘积，等于每层的格数")
    filled: int = Field(description="非 void 方块总数（含两层，可能大于格数）")
    void_slots: int = Field(description="主层的 void 数量")
    primary_filled: int
    secondary_filled: int
    out_of_range_indices: int = Field(
        default=0,
        description="越界调色板下标数量。游戏加载时按空气处理，这里如实计数",
    )
    palette_used: int = Field(description="实际被引用到的调色板条目数")
    # 下面几项在构造时一定会被填充，所以声明为必填：OpenAPI 生成的 TS 类型
    # 就不会是可选的，前端不必到处写空值判断（契约里「一定有」就该是必填）。
    blocks: list[BlockCountEntry] = Field(description="按数量降序")
    layers: list[LayerStats]


class VoxelLayer(BaseModel):
    """一层的方块索引数组（值 = 调色板下标，-1 表示 void）。"""

    layer: int
    indices: list[int] = Field(
        description="长度 = size 的乘积，按 ZYX 顺序（从底部西北角到顶部东南角）"
    )


class StructureLayout(BaseModel):
    size: StructureSize
    voxel_count: int = Field(description="size 的乘积")
    world_origin: StructureSize | None = Field(
        default=None, description="structure_world_origin：保存时的世界原点"
    )
    world_origin_source: str | None = Field(
        default=None,
        description=(
            "原点取自哪里。真实文件放在根层级（'root'），"
            "bedrock.dev 文档写在 structure 内部（'structure'）；缺失时为 null"
        ),
    )
    coordinate_order: str = Field(
        default="zyx",
        description="位置下标的排列顺序；换算公式见 /position 接口说明",
    )


class StructureIndex(BaseModel):
    """索引区：不含大体量数据，便于先看规模再决定要不要拉 voxels。"""

    layout: StructureLayout
    format_version: int | None = None
    compression: str | None = Field(
        default=None, description="检测到的压缩方式：null / gzip / zlib"
    )
    file_bytes: int = Field(description="上传文件字节数")
    palette: list[BlockStateEntry]
    block_entities: list[BlockEntityEntry]
    entities: list[EntityEntry]
    stats: StructureStats
    extra_root_fields: list[str] = Field(
        description="未建模但已保留的根字段名（不丢数据）"
    )
    raw_nbt: dict[str, Any] | None = Field(
        default=None, description="完整根 NBT（?include_raw=true 时返回）"
    )
    layer_sizes: list[int] = Field(
        description="各层的格数，供 /voxels 分页判断"
    )


class StructureResponse(StructureIndex):
    """/parse 的响应：索引 + 可选的完整体素数组。"""

    voxels: list[VoxelLayer] | None = Field(
        default=None,
        description="完整方块索引。默认不返回；?include_voxels=true 时返回",
    )


class VoxelSlice(BaseModel):
    """一次薄片查询的结果。坐标为结构内坐标（从 0 开始）。"""

    axis: str = Field(description="切片轴：x / y / z")
    layer: int = Field(description="层号：0 主层 / 1 次层")
    at: int = Field(description="该轴上的坐标")
    plane_size: StructureSize = Field(description="薄片的尺寸（该轴恒为 1）")
    indices: list[int] = Field(
        description="按 ZYX 顺序展开的调色板下标；-1 表示 void"
    )
    blocks: list[BlockCountEntry] = Field(default_factory=list, description="该薄片的方块统计")


class PositionLookup(BaseModel):
    """坐标 <-> 位置下标互查结果。"""

    x: int
    y: int
    z: int
    index: int = Field(description="位置下标 = x*(sy*sz) + y*sz + z")
    size: StructureSize
    layers: list[dict[str, Any]] = Field(
        default_factory=list,
        description="每层在这一格的方块：layer 与调色板下标；-1 表示 void",
    )


class BlockEntityPage(BaseModel):
    """方块实体 / 实体列表的分页结果（大结构里可能有上万条）。"""

    total: int
    offset: int
    limit: int
    items: list[dict[str, Any]]
