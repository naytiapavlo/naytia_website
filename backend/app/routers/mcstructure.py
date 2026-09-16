"""基岩版结构文件（.mcstructure）解析 API。

设计取舍（docs/plans/03 第 3 节 + 04 第 5 节）：
- 上传即解析，不落盘、不记录内容；返回后内存里只留解析结果。响应里不回显文件名以外的
  任何上传元数据，日志也不打印正文（04 文档：不记录完整用户输入）。
- 「索引」与「体素」分开：NBT 结构文件的 block_indices 是完整方块数组，
  64×256×64 的结构就是 100 万个数。默认只返回索引与统计，调用方需要时再显式
  请求 include_voxels，或用 /voxels 拉全量、/slice 只取一层。
- 不提供「下载原文件」或任何写回能力：本接口是只读解析器。
- 坐标换算只此一处实现（_position_to_index），避免每个接口各写一遍 ZYX 公式。
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status

from ..config import get_settings
from ..parsers.mcstructure import (
    McStructureError,
    McStructureFormatError,
    McStructureLimitError,
    ParsedStructure,
    count_blocks,
    layer_fills,
    parse_mcstructure,
)
from ..schemas_mcstructure import (
    BlockCountEntry,
    BlockEntityEntry,
    BlockEntityPage,
    BlockStateEntry,
    EntityEntry,
    LayerStats,
    PositionLookup,
    StructureIndex,
    StructureLayout,
    StructureResponse,
    StructureSize,
    StructureStats,
    VoxelLayer,
    VoxelSlice,
)
from ..uploads import read_upload_limited

router = APIRouter(prefix="/api/mcstructure", tags=["mcstructure"])


def _bad_request(code: str, message: str) -> HTTPException:
    """结构化错误（03 文档第 5 节 ToolError 风格：code 供程序分支）。"""
    return HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail={"code": code, "message": message},
    )


async def read_upload(file: UploadFile, max_bytes: int) -> bytes:
    """分块读取上传内容，超过上限立刻中止。

    实现移到 `app.uploads`：论坛发帖附件走同一条路径，两处必须给出
    同一个错误码与同一份上限判断。
    """
    return await read_upload_limited(file, max_bytes)


async def load_structure(file: UploadFile) -> tuple[ParsedStructure, dict[str, Any], int]:
    """读取并解析上传的文件，把领域错误翻译成结构化 HTTP 错误。

    返回 (解析结果, 原始根 NBT, 文件字节数)。原始根一并带出，
    这样 include_raw 不需要再读一遍上传内容。
    """
    settings = get_settings()
    data = await read_upload(file, settings.mcstructure_max_bytes)
    if not data:
        raise _bad_request("empty_file", "文件是空的")
    try:
        parsed, root = parse_mcstructure(data, max_voxels=settings.mcstructure_max_voxels)
    except McStructureLimitError as exc:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail={"code": exc.code, "message": exc.message},
        ) from exc
    except McStructureFormatError as exc:
        raise _bad_request(exc.code, exc.message) from exc
    except McStructureError as exc:  # 兜底，避免漏掉新增的错误类型
        raise _bad_request(exc.code, exc.message) from exc
    return parsed, root, len(data)


# ----------------------------------------------------------------- 坐标换算

def _position_to_index(parsed: ParsedStructure, x: int, y: int, z: int) -> int:
    """坐标 -> 位置下标。文档口径：下标按 ZYX 顺序展开，即 x*(sy*sz) + y*sz + z。"""
    _, sy, sz = parsed.size
    return x * (sy * sz) + y * sz + z


def _size_of(parsed: ParsedStructure) -> StructureSize:
    x, y, z = parsed.size
    return StructureSize(x=x, y=y, z=z)


# ----------------------------------------------------------------- 统计

def _count_blocks(parsed: ParsedStructure) -> tuple[list[BlockCountEntry], int, int]:
    """统计各方块数量。返回 (按数量降序的统计, 非 void 总数, 越界下标数)。

    算法在 `parsers.mcstructure.count_blocks`（论坛的材料清单复用同一份口径），
    这里只把纯数据映射成响应模型。
    """
    entries, filled, out_of_range = count_blocks(parsed)
    return (
        [
            BlockCountEntry(
                index=entry.index,
                name=entry.name,
                states=entry.states,
                count=entry.count,
                ratio=entry.ratio,
            )
            for entry in entries
        ],
        filled,
        out_of_range,
    )


def _layer_stats(parsed: ParsedStructure) -> list[LayerStats]:
    return [
        LayerStats(
            layer=item.layer,
            filled=item.filled,
            void=item.void,
            fill_ratio=item.fill_ratio,
        )
        for item in layer_fills(parsed)
    ]


def _build_index(parsed: ParsedStructure, file_bytes: int) -> StructureIndex:
    blocks, filled, out_of_range = _count_blocks(parsed)
    primary = parsed.layers[0] if parsed.layers else []
    primary_filled = sum(1 for value in primary if value != -1)
    stats = StructureStats(
        total_voxels=parsed.voxel_count,
        filled=filled,
        void_slots=parsed.voxel_count - primary_filled,
        primary_filled=primary_filled,
        secondary_filled=sum(
            1 for layer in parsed.layers[1:] for value in layer if value != -1
        ),
        out_of_range_indices=out_of_range,
        palette_used=len(blocks),
        blocks=blocks,
        layers=_layer_stats(parsed),
    )
    return StructureIndex(
        layout=StructureLayout(
            size=_size_of(parsed),
            voxel_count=parsed.voxel_count,
            world_origin=StructureSize(x=parsed.world_origin[0], y=parsed.world_origin[1],
                                       z=parsed.world_origin[2])
            if parsed.world_origin
            else None,
            world_origin_source=parsed.world_origin_source,
        ),
        format_version=parsed.format_version,
        compression=parsed.compression,
        file_bytes=file_bytes,
        palette=[
            BlockStateEntry(index=b.index, name=b.name, states=b.states, version=b.version)
            for b in parsed.palette
        ],
        block_entities=[
            BlockEntityEntry(
                index=e.position_index,
                x=e.position[0],
                y=e.position[1],
                z=e.position[2],
                identifier=e.identifier,
                block_entity_data=e.block_entity_data,
                tick_queue_data=e.tick_queue_data,
            )
            for e in parsed.block_entities
        ],
        entities=[
            EntityEntry(
                index=e.index,
                block_position=StructureSize(x=e.block_position[0], y=e.block_position[1],
                                             z=e.block_position[2])
                if e.block_position
                else None,
                identifier=e.identifier,
                data=e.data,
            )
            for e in parsed.entities
        ],
        stats=stats,
        extra_root_fields=sorted(parsed.extra_root_fields),
        layer_sizes=[len(layer) for layer in parsed.layers],
    )


# ----------------------------------------------------------------- 路由

@router.get("/info", summary="接口说明与当前限制")
def info() -> dict[str, object]:
    """返回本接口的能力边界，便于前端显示「我们到底做了什么、没做什么」。"""
    settings = get_settings()
    return {
        "format": ".mcstructure（Minecraft 基岩版结构文件）",
        "endianness": "little（Bedrock NBT）",
        "compression": ["none", "gzip", "zlib"],
        "index_order": "zyx（从结构底部西北角开始：先 Z，再 Y，最后 X）",
        "index_formula": "index = x * (sizeY * sizeZ) + y * sizeZ + z",
        "limits": {
            "max_file_bytes": settings.mcstructure_max_bytes,
            "max_voxels": settings.mcstructure_max_voxels,
        },
        "endpoints": {
            "POST /api/mcstructure/parse": "上传并解析，返回索引 + 统计（可选体素）",
            "POST /api/mcstructure/voxels": "只取完整方块索引数组",
            "POST /api/mcstructure/slice": "只取某一层薄片（axis + at）",
            "POST /api/mcstructure/position": "坐标 ↔ 位置下标互查+该格方块",
            "POST /api/mcstructure/blocks": "方块实体 / 实体分页列表",
        },
        "notes": [
            "只读解析：不上传内容到任何第三方，也不提供写回/下载能力。",
            "上传内容不落盘、不写日志；解析在请求内完成。",
            "未知字段保留（raw_nbt / extra_root_fields），不做静默丢弃。",
            "越界调色板下标按游戏口径视为空气，并在统计里单列计数。",
        ],
    }


@router.post("/parse", response_model=StructureResponse,
             summary="上传 .mcstructure 并解析")
async def parse_structure(
    file: UploadFile = File(description=".mcstructure 文件"),
    include_voxels: bool = Query(default=False, description="是否返回完整方块索引数组"),
    include_raw: bool = Query(default=False, description="是否返回完整根 NBT"),
) -> StructureResponse:
    parsed, root, file_bytes = await load_structure(file)
    index = _build_index(parsed, file_bytes)

    voxels = None
    if include_voxels:
        voxels = [
            VoxelLayer(layer=number, indices=layer)
            for number, layer in enumerate(parsed.layers)
        ]

    # 用 model_dump 展开索引区再补两个可选字段；raw_nbt 已在索引里，
    # 必须显式覆盖而不是重复传参（同名关键字会直接 TypeError）。
    payload = index.model_dump()
    payload["voxels"] = voxels
    payload["raw_nbt"] = root if include_raw else None
    return StructureResponse(**payload)


@router.post("/voxels", response_model=list[VoxelLayer],
             summary="只取完整方块索引数组")
async def get_voxels(file: UploadFile = File(description=".mcstructure 文件")) -> list[VoxelLayer]:
    parsed, _root, _file_bytes = await load_structure(file)
    return [
        VoxelLayer(layer=number, indices=layer)
        for number, layer in enumerate(parsed.layers)
    ]


@router.post("/slice", response_model=VoxelSlice, summary="取某一层薄片")
async def get_slice(
    file: UploadFile = File(description=".mcstructure 文件"),
    axis: str = Query(default="y", pattern="^[xyz]$", description="切片轴"),
    at: int = Query(description="该轴上的坐标（结构内坐标，从 0 开始）"),
    layer: int = Query(default=0, ge=0, description="层号：0 主层 / 1 次层"),
) -> VoxelSlice:
    parsed, _root, file_bytes = await load_structure(file)
    sx, sy, sz = parsed.size
    extent = {"x": sx, "y": sy, "z": sz}[axis]
    if not 0 <= at < extent:
        raise _bad_request("slice_out_of_range", f"{axis} 需在 0 ~ {extent - 1} 之间")
    if layer >= parsed.layer_count:
        raise _bad_request("layer_out_of_range", f"该结构只有 {parsed.layer_count} 层")

    indices: list[int] = []
    for x in range(sx):
        for y in range(sy):
            for z in range(sz):
                if {"x": x, "y": y, "z": z}[axis] != at:
                    continue
                indices.append(parsed.layers[layer][_position_to_index(parsed, x, y, z)])

    # 薄片内统计：复用统一口径，避免各接口各算一套
    counts: dict[int, int] = {}
    for palette_index in indices:
        if palette_index == -1:
            continue
        counts[palette_index] = counts.get(palette_index, 0) + 1
    non_void = sum(counts.values())
    blocks = [
        BlockCountEntry(
            index=palette_index,
            name=parsed.palette[palette_index].name,
            states=parsed.palette[palette_index].states,
            count=count,
            ratio=(count / non_void) if non_void else 0.0,
        )
        for palette_index, count in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
        if palette_index < len(parsed.palette)
    ]

    plane = {"x": StructureSize(x=1, y=sy, z=sz),
             "y": StructureSize(x=sx, y=1, z=sz),
             "z": StructureSize(x=sx, y=sy, z=1)}[axis]
    return VoxelSlice(
        axis=axis, layer=layer, at=at, plane_size=plane, indices=indices, blocks=blocks
    )


@router.post("/position", response_model=PositionLookup, summary="坐标 ↔ 位置下标互查")
async def lookup_position(
    file: UploadFile = File(description=".mcstructure 文件"),
    x: int = Query(description="结构内 X（从 0 开始）"),
    y: int = Query(description="结构内 Y（从 0 开始）"),
    z: int = Query(description="结构内 Z（从 0 开始）"),
) -> PositionLookup:
    parsed, _root, _file_bytes = await load_structure(file)
    sx, sy, sz = parsed.size
    if not (0 <= x < sx and 0 <= y < sy and 0 <= z < sz):
        raise _bad_request(
            "position_out_of_range",
            f"坐标需在结构范围内：X 0~{sx - 1}、Y 0~{sy - 1}、Z 0~{sz - 1}",
        )
    index = _position_to_index(parsed, x, y, z)
    layers = [
        {
            "layer": number,
            "palette_index": layer_values[index],
            "name": parsed.palette[layer_values[index]].name
            if 0 <= layer_values[index] < len(parsed.palette)
            else None,
        }
        for number, layer_values in enumerate(parsed.layers)
    ]
    return PositionLookup(x=x, y=y, z=z, index=index, size=_size_of(parsed), layers=layers)


@router.post("/blocks", response_model=BlockEntityPage, summary="方块实体 / 实体分页列表")
async def list_blocks(
    file: UploadFile = File(description=".mcstructure 文件"),
    kind: str = Query(default="block_entities", pattern="^(block_entities|entities)$",
                      description="block_entities = 方块实体；entities = 实体"),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=1000),
) -> BlockEntityPage:
    parsed, _root, file_bytes = await load_structure(file)
    index = _build_index(parsed, file_bytes)
    items = index.block_entities if kind == "block_entities" else index.entities
    page = items[offset:offset + limit]
    return BlockEntityPage(
        total=len(items),
        offset=offset,
        limit=limit,
        items=[item.model_dump() for item in page],
    )
