"""区块与坐标助手 · Python 移植（与前端 src/tools/chunk-coordinates/engine.ts 同规格）。

对照基准（09 标准：服务端实现是同一规则集的移植，测试用例与前端一致）：
- 区块编号 = floor(方块坐标 / 16)，负坐标向下取整：-1 属于区块 -1。
- 区块内坐标 = ((坐标 % 16) + 16) % 16，恒为 0~15。
- 区域文件 32×32 区块，下标 = (chunkX mod 32) + (chunkZ mod 32) * 32。
- 主世界 ↔ 下界按 8:1 换算，向下取整。
"""
import math
from typing import Any

CHUNK_SIZE = 16
REGION_CHUNKS = 32
IMPLEMENTATION_VERSION = "1.0.0"
INPUT_SCHEMA_VERSION = 1
RULESET_ID = "chunk-16-v1"

MIN_BOUND = -29_999_999
MAX_BOUND = 29_999_999
EDGE_WARN = 29_999_989

DIMENSIONS = {
    "overworld": "主世界",
    "nether": "下界",
    "end": "末地",
}


def floor_div(value: int, divisor: int) -> int:
    return value // divisor


def positive_mod(value: int, modulus: int) -> int:
    return value % modulus


def validate(raw: dict[str, Any]) -> dict[str, Any]:
    """严格校验（比前端表单严格：dimension 非法直接拒绝，不静默默认）。"""
    from ..errors import PublicApiError

    dimension = raw.get("dimension", "overworld")
    if dimension not in DIMENSIONS:
        raise PublicApiError(
            422, "invalid_dimension", f"dimension 必须是 {'/'.join(DIMENSIONS)}", field="dimension"
        )
    coords: dict[str, int] = {}
    for name in ("x", "z"):
        value = raw.get(name)
        if isinstance(value, bool) or not isinstance(value, (int, str)):
            raise PublicApiError(
                422, "not_an_integer", f"{name} 必须是整数", field=name
            )
        parsed = int(value) if isinstance(value, str) else value
        try:
            parsed = int(str(value)) if isinstance(value, str) else value
        except ValueError as exc:
            raise PublicApiError(422, "not_an_integer", f"{name} 必须是整数", field=name) from exc
        if not (MIN_BOUND <= parsed <= MAX_BOUND):
            raise PublicApiError(
                422,
                "out_of_range",
                f"{name} 超出世界范围（{MIN_BOUND} ~ {MAX_BOUND}）",
                field=name,
            )
        coords[name] = parsed
    return {"x": coords["x"], "z": coords["z"], "dimension": dimension}


def run(inp: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    x: int = inp["x"]
    z: int = inp["z"]
    dimension: str = inp["dimension"]
    label = DIMENSIONS[dimension]

    chunk_x = floor_div(x, CHUNK_SIZE)
    chunk_z = floor_div(z, CHUNK_SIZE)
    offset_x = positive_mod(x, CHUNK_SIZE)
    offset_z = positive_mod(z, CHUNK_SIZE)
    region_x = floor_div(chunk_x, REGION_CHUNKS)
    region_z = floor_div(chunk_z, REGION_CHUNKS)
    local_index = positive_mod(chunk_x, REGION_CHUNKS) + positive_mod(chunk_z, REGION_CHUNKS) * REGION_CHUNKS

    related: list[dict[str, Any]] = []
    if dimension in ("overworld", "nether"):
        to_nether = dimension == "overworld"
        target = "下界" if to_nether else "主世界"
        scale = 1 / 8 if to_nether else 8
        related.append(
            {
                "label": f"{label} → {target}",
                "x": math.floor(x * scale),
                "z": math.floor(z * scale),
                "note": (
                    "主世界坐标除以 8：该处对应的下界传送门位置（取整会有 1 格内的偏差）"
                    if to_nether
                    else "下界坐标乘以 8：该处对应的主世界位置"
                ),
            }
        )

    warnings: list[str] = []
    if offset_x == 0 or offset_z == 0:
        warnings.append("该方块位于区块边界上（区块内坐标含 0），相邻区块紧邻这一列。")
    if abs(x) > EDGE_WARN or abs(z) > EDGE_WARN:
        warnings.append("坐标接近世界边界，粘贴式建筑、传送门等机制在边界附近可能异常。")

    def offset_text(chunk: int, value: int) -> str:
        offset = positive_mod(value, CHUNK_SIZE)
        if value >= 0:
            return f"区块内第 {offset} 格"
        return f"区块内第 {offset} 格（距区块最小坐标 {value - chunk * CHUNK_SIZE} 格）"

    data = {
        "input": {"x": x, "z": z, "dimension": dimension, "dimensionLabel": label},
        "chunk": {"x": chunk_x, "z": chunk_z},
        "offset": {"x": offset_x, "z": offset_z},
        "region": {"x": region_x, "z": region_z, "localIndex": local_index},
        "chunkOrigin": {"x": chunk_x * CHUNK_SIZE, "z": chunk_z * CHUNK_SIZE},
        "related": related,
        "notes": [
            f"本方块在区块内的位置：X {offset_text(chunk_x, x)}，Z {offset_text(chunk_z, z)}。",
            f"所在区块覆盖方块 X {chunk_x * CHUNK_SIZE} ~ {chunk_x * CHUNK_SIZE + CHUNK_SIZE - 1}、Z {chunk_z * CHUNK_SIZE} ~ {chunk_z * CHUNK_SIZE + CHUNK_SIZE - 1}。",
            "区块编号与区域下标是按公式推导的确定值；存档工具显示的编号口径若不同，以工具自身说明为准。",
        ],
    }
    return data, warnings
