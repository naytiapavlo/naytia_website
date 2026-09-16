"""工具目录：对外元数据快照。

与前端 src/tools/*-manifest.ts 保持同一 id / 版本 / 规则集；
字段以本文件为服务端权威快照，前端 manifest 变更时同步此处（09 标准第 2 节）。
status 仅公开 stable / experimental 的工具；planned / deprecated 不进入 v1。
"""
from typing import Any

CHUNK_INPUT_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["x", "z"],
    "properties": {
        "x": {
            "type": "integer",
            "minimum": -29_999_999,
            "maximum": 29_999_999,
            "description": "方块 X 坐标",
        },
        "z": {
            "type": "integer",
            "minimum": -29_999_999,
            "maximum": 29_999_999,
            "description": "方块 Z 坐标",
        },
        "dimension": {
            "type": "string",
            "enum": ["overworld", "nether", "end"],
            "default": "overworld",
            "description": "维度；非法值将被拒绝（API 不静默默认）",
        },
    },
}

MATERIAL_INPUT_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["entries"],
    "properties": {
        "entries": {
            "type": "array",
            "maxItems": 40,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "name": {"type": "string", "maxLength": 40, "description": "材料名称，留空记为「未命名材料」"},
                    "count": {
                        "anyOf": [{"type": "integer", "minimum": 0, "maximum": 1_000_000_000}, {"type": "string"}],
                        "description": "数量；0 或留空的行会被忽略",
                    },
                    "stackSize": {
                        "anyOf": [{"type": "integer", "minimum": 1, "maximum": 64}, {"type": "string"}],
                        "default": 64,
                        "description": "堆叠上限 1~64",
                    },
                },
            },
            "description": "材料列表；全部行为空时拒绝",
        },
        "containerSlots": {"type": "integer", "minimum": 0, "default": 0, "description": "容器容量（格）；0 = 不换算容器"},
        "containerLabel": {"type": "string", "maxLength": 20, "default": "容器", "description": "容器名称（展示用）"},
    },
}

TOOLS: list[dict[str, Any]] = [
    {
        "id": "chunk-coordinates",
        "slug": "chunk-coordinates",
        "title": "区块与坐标助手",
        "summary": "方块坐标换区块坐标、区块内坐标与区域文件下标，含主世界↔下界换算。",
        "category": "坐标与定位",
        "tags": ["坐标", "区块", "区域文件", "传送门"],
        "status": "stable",
        "execution_mode": "server",
        "input_schema": CHUNK_INPUT_JSON_SCHEMA,
        "examples": [
            {
                "name": "负坐标边界（floor 语义）",
                "input": {"x": -17, "z": -1, "dimension": "overworld"},
            },
            {
                "name": "主世界转下界",
                "input": {"x": 800, "z": -1600, "dimension": "overworld"},
            },
        ],
    },
    {
        "id": "material-counter",
        "slug": "material-counter",
        "title": "材料清单助手",
        "summary": "按各自堆叠上限换算组数、余量与占用格数，并折算容器数量。",
        "category": "材料与整理",
        "tags": ["材料", "堆叠", "容器"],
        "status": "stable",
        "execution_mode": "server",
        "input_schema": MATERIAL_INPUT_JSON_SCHEMA,
        "examples": [
            {
                "name": "多种材料 + 潜影盒",
                "input": {
                    "entries": [
                        {"name": "石子", "count": 64, "stackSize": 64},
                        {"name": "木头", "count": 65, "stackSize": 64},
                        {"name": "工具", "count": 3, "stackSize": 1},
                    ],
                    "containerSlots": 27,
                    "containerLabel": "潜影盒",
                },
            }
        ],
    },
]

TOOL_IDS = {tool["id"] for tool in TOOLS}
