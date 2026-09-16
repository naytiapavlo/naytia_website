"""解析器层：把外部文件格式解码成纯领域数据。

- `nbt_le`：小端 NBT 底层读取（Bedrock 口径）。
- `mcstructure`：基岩版结构文件的语义解析。

只依赖标准库；不导入 FastAPI，便于单独测试与复用。
"""
from ..nbt_le import (
    NbtError,
    NbtFormatError,
    NbtLimitError,
    NbtLimits,
    NbtTruncatedError,
    parse_nbt,
)
from .mcstructure import (
    MAX_VOXELS,
    BlockEntityEntry,
    BlockState,
    EntityEntry,
    McStructureError,
    McStructureFormatError,
    McStructureLimitError,
    ParsedStructure,
    parse_mcstructure,
)

__all__ = [
    "NbtError",
    "NbtFormatError",
    "NbtLimitError",
    "NbtLimits",
    "NbtTruncatedError",
    "parse_nbt",
    "MAX_VOXELS",
    "BlockEntityEntry",
    "BlockState",
    "EntityEntry",
    "McStructureError",
    "McStructureFormatError",
    "McStructureLimitError",
    "ParsedStructure",
    "parse_mcstructure",
]
