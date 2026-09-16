"""测试夹具：手工构造小端（Bedrock）NBT 字节。

用途
- 生成合法/畸形/截断的 .mcstructure 字节流，供解析器测试使用（04 文档第 3 节：
  「空文件、损坏/截断、错误版本、超大声明长度、压缩膨胀和编码差异」都要覆盖）。
- 夹具由**独立于被测代码**的写入器生成：解析器与生成器若共用同一套代码，
  两边同时写错就会互相掩盖，测不出问题。

编码约定（只有两条规则，务必遵守）
1. `v_xxx(...)` 返回「标签的值字节」，**不含**类型与名字。
   只能用在值的位置：`(类型, 名字, v_xxx(...))` 的第三项，或 `v_list` 的元素。
2. `named(tag_id, name, value)` 返回「完整的命名标签」= 类型 + 名字 + 值。
   `v_compound(fields)` 返回「复合标签的值」= 若干命名标签 + TAG_End。

在值的位置误用 named()（多出一个类型字节 + 名字）会让解析器错位，
典型症状是「在某个偏移处报出一个荒谬的字符串长度」。改这个文件后请务必跑
`python tests/fixtures/mcstructure_fixtures.py --check`（用 nbtlib 独立复读校验）。
"""
from __future__ import annotations

import struct
from typing import Any

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

# 调色板下标哨兵，用于构造「索引越界」的畸形文件
OUT_OF_RANGE = 2**31 - 1

# 字段元组：(标签类型, 名字, 值字节)
Field = tuple[int, str, bytes]


# ---------------------------------------------------------------- 基础编码

def _name(text: str) -> bytes:
    raw = text.encode("utf-8")
    return struct.pack("<H", len(raw)) + raw


def named(tag_id: int, name: str, value: bytes) -> bytes:
    """完整的命名标签：类型 + 名字 + 值。"""
    return bytes([tag_id]) + _name(name) + value


# ---- 值编码（小端），不含类型与名字 ----

def v_string(value: str) -> bytes:
    raw = value.encode("utf-8")
    return struct.pack("<H", len(raw)) + raw


def v_byte(value: int) -> bytes:
    return struct.pack("<b", value)


def v_short(value: int) -> bytes:
    return struct.pack("<h", value)


def v_int(value: int) -> bytes:
    return struct.pack("<i", value)


def v_long(value: int) -> bytes:
    return struct.pack("<q", value)


def v_float(value: float) -> bytes:
    return struct.pack("<f", value)


def v_double(value: float) -> bytes:
    return struct.pack("<d", value)


def v_byte_array(values: list[int]) -> bytes:
    return struct.pack("<i", len(values)) + bytes(b & 0xFF for b in values)


def v_int_array(values: list[int]) -> bytes:
    return struct.pack("<i", len(values)) + b"".join(struct.pack("<i", v) for v in values)


def v_long_array(values: list[int]) -> bytes:
    return struct.pack("<i", len(values)) + b"".join(struct.pack("<q", v) for v in values)


def v_list(element_id: int, elements: list[bytes]) -> bytes:
    """TAG_List 的值：元素类型 + 个数 + 各元素的值字节（元素不带名字）。"""
    return bytes([element_id]) + struct.pack("<i", len(elements)) + b"".join(elements)


def v_compound(fields: list[Field]) -> bytes:
    """TAG_Compound 的值：命名标签序列 + TAG_End。不含自身的类型与名字。"""
    return b"".join(named(t, name, value) for t, name, value in fields) + bytes([TAG_END])


def root(fields: list[Field]) -> bytes:
    """NBT 文件根：TAG_Compound + 空名字 + 字段 + TAG_End。"""
    return named(TAG_COMPOUND, "", v_compound(fields))


# ---------------------------------------------------------------- .mcstructure

_STONE = "minecraft:stone"
_AIR = "minecraft:air"
_VERSION = 18168865
_ALL_LAYER = -1


def palette_entry(name: str, states: list[Field] | None = None) -> bytes:
    """调色板里的一个方块排列。返回值（v_compound），可直接当列表元素。"""
    return v_compound([
        (TAG_STRING, "name", v_string(name)),
        (TAG_COMPOUND, "states", v_compound(states or [])),
        (TAG_INT, "version", v_int(_VERSION)),
    ])


def _file(*, size: tuple[int, int, int], structure: bytes,
          extra: list[Field] | None = None) -> bytes:
    """把 structure 复合体的**值**包成完整的 .mcstructure 文件。"""
    x, y, z = size
    fields: list[Field] = [
        (TAG_INT, "format_version", v_int(1)),
        (TAG_LIST, "size", v_list(TAG_INT, [v_int(x), v_int(y), v_int(z)])),
        (TAG_COMPOUND, "structure", structure),
    ]
    if extra:
        fields.extend(extra)
    return root(fields)


def _default_palette(block_palette: bytes, position_data: bytes | None = None) -> bytes:
    """palette.default 的值。block_palette 与 position_data 都是值字节。"""
    return v_compound([
        (TAG_LIST, "block_palette", block_palette),
        (TAG_COMPOUND, "block_position_data", position_data or v_compound([])),
    ])


def slab(*, x: int, y: int, z: int) -> bytes:
    """尺寸 x×y×z 的简单结构：主层全为石头，次层全为 void。

    用最少的字段生成「合法且内容确定」的文件，便于断言下标换算与统计。
    """
    total = x * y * z
    structure = v_compound([
        (TAG_LIST, "block_indices", v_list(TAG_LIST, [
            v_list(TAG_INT, [v_int(0) for _ in range(total)]),
            v_list(TAG_INT, [v_int(_ALL_LAYER) for _ in range(total)]),
        ])),
        (TAG_LIST, "entities", v_list(TAG_END, [])),
        (TAG_COMPOUND, "palette", v_compound([
            (TAG_COMPOUND, "default", _default_palette(
                v_list(TAG_COMPOUND, [palette_entry(_STONE), palette_entry(_AIR)]),
            )),
        ])),
        (TAG_LIST, "structure_world_origin",
         v_list(TAG_INT, [v_int(0), v_int(0), v_int(0)])),
    ])
    return _file(size=(x, y, z), structure=structure)


# 真实文件（Structure Block 导出）核对得到的口径：
# - structure_world_origin 在**根层级**，不在 structure 复合体里（bedrock.dev 文档写的是后者）
# - 方块实体的 x/y/z 是绝对世界坐标，与 structure_world_origin 一致
# 下面两个常量就是 2026-09-16 那份真实文件里读到的值。
REAL_WORLD_ORIGIN = (72, 59, -10)


def real_world_single_block(*, origin_at_root: bool = True) -> bytes:
    """复刻真实 Structure Block 导出的单方块结构（粘性活塞 + PistonArm 方块实体）。

    origin_at_root=True 复刻真实文件（原点在根层级）；False 复刻文档口径
    （原点在 structure 内部）。解析器两种都要支持。
    """
    ox, oy, oz = REAL_WORLD_ORIGIN
    # 方块实体的 x/y/z 用绝对世界坐标，与原点相同 —— 这是真实文件里的实际取值
    piston_arm = v_compound([
        (TAG_STRING, "id", v_string("PistonArm")),
        (TAG_BYTE, "isMovable", v_byte(1)),
        (TAG_BYTE, "Sticky", v_byte(1)),
        (TAG_INT, "State", v_int(0)),
        (TAG_INT, "NewState", v_int(0)),
        (TAG_FLOAT, "Progress", v_float(0.0)),
        (TAG_FLOAT, "LastProgress", v_float(0.0)),
        (TAG_INT, "BlockEntityVersion", v_int(0)),
        (TAG_LIST, "AttachedBlocks", v_list(TAG_END, [])),
        (TAG_LIST, "BreakBlocks", v_list(TAG_END, [])),
        (TAG_INT, "x", v_int(ox)),
        (TAG_INT, "y", v_int(oy)),
        (TAG_INT, "z", v_int(oz)),
    ])
    position_data = v_compound([
        (TAG_COMPOUND, "0", v_compound([
            (TAG_COMPOUND, "block_entity_data", piston_arm),
        ])),
    ])

    structure_fields: list[Field] = [
        (TAG_LIST, "block_indices", v_list(TAG_LIST, [
            v_list(TAG_INT, [v_int(0)]),
            v_list(TAG_INT, [v_int(_ALL_LAYER)]),
        ])),
        (TAG_LIST, "entities", v_list(TAG_END, [])),
        (TAG_COMPOUND, "palette", v_compound([
            (TAG_COMPOUND, "default", _default_palette(
                v_list(TAG_COMPOUND, [palette_entry(
                    "minecraft:sticky_piston",
                    [(TAG_INT, "facing_direction", v_int(2))],
                )]),
                position_data,
            )),
        ])),
    ]
    origin_field: Field = (
        TAG_LIST, "structure_world_origin",
        v_list(TAG_INT, [v_int(ox), v_int(oy), v_int(oz)]),
    )

    if origin_at_root:
        # 真实文件口径：origin 与 format_version / size 同级
        return _file(size=(1, 1, 1), structure=v_compound(structure_fields),
                     extra=[origin_field])
    structure_fields.append(origin_field)
    return _file(size=(1, 1, 1), structure=v_compound(structure_fields))


# 富结构的固定内容，便于测试断言
CHEST_ITEMS = [{"name": "minecraft:apple", "count": 3, "slot": 0}]
ENTITY_ID = "minecraft:armor_stand"


def _chest_block_entity() -> bytes:
    """箱子方块实体的 NBT 值（含 Items 列表）。"""
    return v_compound([
        (TAG_STRING, "id", v_string("Chest")),
        (TAG_BYTE, "isMovable", v_byte(1)),
        (TAG_INT, "x", v_int(1)),
        (TAG_INT, "y", v_int(0)),
        (TAG_INT, "z", v_int(0)),
        (TAG_LIST, "Items", v_list(TAG_COMPOUND, [
            v_compound([
                (TAG_BYTE, "Count", v_byte(3)),
                (TAG_SHORT, "Damage", v_short(0)),
                (TAG_STRING, "Name", v_string("minecraft:apple")),
                (TAG_BYTE, "Slot", v_byte(0)),
            ]),
        ])),
    ])


def _armor_stand_entity() -> bytes:
    """实体列表的一个元素值：block_position + data（完整实体 NBT）。"""
    entity_data = v_compound([
        (TAG_STRING, "identifier", v_string(ENTITY_ID)),
        (TAG_LIST, "Pos", v_list(TAG_FLOAT, [v_float(0.5), v_float(0.0), v_float(0.5)])),
        (TAG_FLOAT, "Yaw", v_float(90.0)),
        (TAG_LONG, "UniqueID", v_long(-4611686018427387904)),
        (TAG_DOUBLE, "Health", v_double(20.0)),
        (TAG_STRING, "CustomName", v_string("测试盔甲架")),
    ])
    return v_compound([
        (TAG_LIST, "block_position", v_list(TAG_INT, [v_int(0), v_int(0), v_int(0)])),
        (TAG_COMPOUND, "data", entity_data),
    ])


def rich(*, x: int = 2, y: int = 2, z: int = 2) -> bytes:
    """带方块实体、实体、两层共位方块与未知根字段的结构，覆盖完整解析路径。"""
    total = x * y * z

    block_palette = v_list(TAG_COMPOUND, [
        palette_entry(_STONE),
        # 覆盖 string / int / byte 三种方块状态值类型
        palette_entry("minecraft:oak_stairs", [
            (TAG_STRING, "weirdo_direction", v_string("north")),
            (TAG_INT, "upside_down_bit", v_int(1)),
            (TAG_BYTE, "open_bit", v_byte(1)),
        ]),
        palette_entry(_AIR),
    ])

    # 主层：下标 0 是石头，其余按 i % 3 混合；次层：仅下标 1 有一个共位方块
    primary_values = [0] + [
        1 if i % 3 == 0 else (2 if i % 3 == 1 else 0) for i in range(1, total)
    ]
    secondary_values = [_ALL_LAYER] * total
    secondary_values[1] = 2

    # block_position_data：键是「位置下标的字符串形式」，值是复合体
    position_data = v_compound([
        (TAG_COMPOUND, "1", v_compound([
            (TAG_COMPOUND, "block_entity_data", _chest_block_entity()),
            (TAG_LIST, "tick_queue_data", v_list(TAG_COMPOUND, [
                v_compound([(TAG_INT, "tick_delay", v_int(2))]),
            ])),
        ])),
    ])

    structure = v_compound([
        (TAG_LIST, "block_indices", v_list(TAG_LIST, [
            v_list(TAG_INT, [v_int(v) for v in primary_values]),
            v_list(TAG_INT, [v_int(v) for v in secondary_values]),
        ])),
        (TAG_LIST, "entities", v_list(TAG_COMPOUND, [_armor_stand_entity()])),
        (TAG_COMPOUND, "palette", v_compound([
            (TAG_COMPOUND, "default", _default_palette(block_palette, position_data)),
        ])),
        (TAG_LIST, "structure_world_origin",
         v_list(TAG_INT, [v_int(100), v_int(64), v_int(-200)])),
    ])
    return _file(size=(x, y, z), structure=structure,
                 extra=[(TAG_STRING, "unknown_root_field", v_string("keep me"))])


# ---------------------------------------------------------------- 畸形夹具

def wrong_root_tag() -> bytes:
    """根标签不是 TAG_Compound（把 .dat 之类文件误传进来时的典型情况）。"""
    return named(TAG_LIST, "", v_list(TAG_INT, [v_int(1)]))


def missing_size() -> bytes:
    return named(TAG_COMPOUND, "", v_compound([
        (TAG_INT, "format_version", v_int(1)),
    ]))


def _single_block_structure(*, indices_per_layer: int,
                            declared: tuple[int, int, int]) -> bytes:
    """构造 block_indices 长度与 size 不符、或体积超限的文件。"""
    structure = v_compound([
        (TAG_LIST, "block_indices", v_list(TAG_LIST, [
            v_list(TAG_INT, [v_int(0)] * indices_per_layer),
            v_list(TAG_INT, [v_int(_ALL_LAYER)] * indices_per_layer),
        ])),
        (TAG_COMPOUND, "palette", v_compound([
            (TAG_COMPOUND, "default", _default_palette(
                v_list(TAG_COMPOUND, [palette_entry(_STONE)]),
            )),
        ])),
    ])
    return _file(size=declared, structure=structure)


def size_mismatch() -> bytes:
    """block_indices 长度与 size 乘积不符（文档列出的典型加载失败）。

    声明 3×3×3 = 27 格，但每层只给 8 个索引。
    """
    return _single_block_structure(indices_per_layer=8, declared=(3, 3, 3))


def oversized_voxels() -> bytes:
    """声明巨大 size，但只给很短的索引：必须在分配内存之前被上限拦下。"""
    return _single_block_structure(indices_per_layer=1, declared=(4096, 4096, 4096))


def out_of_range_indices() -> bytes:
    """调色板下标超出范围（文档：游戏按空气处理）。"""
    total = 8
    structure = v_compound([
        (TAG_LIST, "block_indices", v_list(TAG_LIST, [
            v_list(TAG_INT, [v_int(OUT_OF_RANGE)] + [v_int(0)] * (total - 1)),
            v_list(TAG_INT, [v_int(_ALL_LAYER)] * total),
        ])),
        (TAG_COMPOUND, "palette", v_compound([
            (TAG_COMPOUND, "default", _default_palette(
                v_list(TAG_COMPOUND, [palette_entry(_STONE)]),
            )),
        ])),
    ])
    return _file(size=(2, 2, 2), structure=structure)


def no_default_palette() -> bytes:
    """palette 里缺少 default（游戏加载时不会放置任何方块）。"""
    structure = v_compound([
        (TAG_LIST, "block_indices", v_list(TAG_LIST, [
            v_list(TAG_INT, [v_int(0)]),
            v_list(TAG_INT, [v_int(_ALL_LAYER)]),
        ])),
        (TAG_COMPOUND, "palette", v_compound([])),
    ])
    return _file(size=(1, 1, 1), structure=structure)


def big_palette(count: int, *, last_name: str | None = None) -> bytes:
    """1 格结构，但调色板有 `count` 项，那一格用最后一项。

    存在的理由：`10 MB 以内` 的真实结构塞不下 300 种方块，而「调色板超过
    256 项时调色板下标要从 8 位升到 16 位」这条分支必须被测到——
    升位写错的话，第 257 项之后的方块全会被渲染成别的方块，
    而小结构上永远看不出来。
    """
    entries = [
        palette_entry(last_name if (last_name and i == count - 1) else f"minecraft:block_{i}")
        for i in range(count)
    ]
    structure = v_compound([
        (TAG_LIST, "block_indices", v_list(TAG_LIST, [
            v_list(TAG_INT, [v_int(count - 1)]),
            v_list(TAG_INT, [v_int(_ALL_LAYER)]),
        ])),
        (TAG_LIST, "entities", v_list(TAG_END, [])),
        (TAG_COMPOUND, "palette", v_compound([
            (TAG_COMPOUND, "default", _default_palette(v_list(TAG_COMPOUND, entries))),
        ])),
    ])
    return _file(size=(1, 1, 1), structure=structure)


# ---------------------------------------------------------------- 小屋夹具

# 固定内容：材质与计数被测试锁死，改这里必须同步改断言
HOUSE_SIZE = (7, 5, 7)
HOUSE_STONE = "minecraft:stone"
HOUSE_PLANKS = "minecraft:oak_planks"
HOUSE_GLASS = "minecraft:glass"
HOUSE_AIR = "minecraft:air"
# 石头地板 7×7=49；木板 = 每层墙 24 格 × 3 层，减去 8 格窗户，再加屋顶 7×7=49
HOUSE_COUNTS = {HOUSE_STONE: 49, HOUSE_PLANKS: 113, HOUSE_GLASS: 8}


def house() -> bytes:
    """7×5×7 的小屋：石头地板 + 木板墙与屋顶 + 四面各两格玻璃窗。

    存在的理由：前面那些夹具都是「单一材质、规则形状」，验证不了两件真正
    要紧的事——**多材质的材料清单**（三种方块、数量各不相同、还要按数量降序）
    和**有内部空腔的形状**（3D 预览要靠面剔除才能看出这是个屋子而不是实心块）。
    人工构造的期望值直接写在 `HOUSE_COUNTS` 里，测试据此断言。
    """
    sx, sy, sz = HOUSE_SIZE
    total = sx * sy * sz
    primary = [_ALL_LAYER] * total

    def put(x: int, y: int, z: int, value: int) -> None:
        primary[x * (sy * sz) + y * sz + z] = value

    for x in range(sx):
        for z in range(sz):
            put(x, 0, z, 0)  # 地板
            put(x, sy - 1, z, 1)  # 屋顶
    for y in range(1, sy - 1):
        for x in range(sx):
            for z in range(sz):
                if 0 < x < sx - 1 and 0 < z < sz - 1:
                    put(x, y, z, 3)  # 室内：空气
                else:
                    put(x, y, z, 1)  # 墙
    # 四面墙在 y=2 各开两格窗（南北墙沿 x 方向，东西墙沿 z 方向）
    for x in (2, 4):
        put(x, 2, 0, 2)
        put(x, 2, sz - 1, 2)
    for z in (2, 4):
        put(0, 2, z, 2)
        put(sx - 1, 2, z, 2)

    structure = v_compound([
        (TAG_LIST, "block_indices", v_list(TAG_LIST, [
            v_list(TAG_INT, [v_int(v) for v in primary]),
            v_list(TAG_INT, [v_int(_ALL_LAYER) for _ in range(total)]),
        ])),
        (TAG_LIST, "entities", v_list(TAG_END, [])),
        (TAG_COMPOUND, "palette", v_compound([
            (TAG_COMPOUND, "default", _default_palette(
                v_list(TAG_COMPOUND, [
                    palette_entry(HOUSE_STONE),
                    palette_entry(HOUSE_PLANKS),
                    palette_entry(HOUSE_GLASS),
                    palette_entry(HOUSE_AIR),
                ]),
            )),
        ])),
    ])
    return _file(
        size=HOUSE_SIZE,
        structure=structure,
        extra=[(TAG_LIST, "structure_world_origin",
                v_list(TAG_INT, [v_int(0), v_int(64), v_int(0)]))],
    )


# ---------------------------------------------------------------- CLI

BUILDERS: dict[str, Any] = {
    "rich": rich,
    "house": house,
    "slab": lambda: slab(x=2, y=2, z=2),
    "big_palette": lambda: big_palette(300),
    "missing_size": missing_size,
    "size_mismatch": size_mismatch,
    "oversized_voxels": oversized_voxels,
    "out_of_range": out_of_range_indices,
    "no_default_palette": no_default_palette,
}


def _main() -> int:
    import argparse
    import pathlib

    parser = argparse.ArgumentParser(description="生成 .mcstructure 测试夹具")
    parser.add_argument("--out", type=pathlib.Path, help="输出文件路径")
    parser.add_argument("--kind", default="rich", choices=sorted(BUILDERS),
                        help="要生成的夹具种类")
    parser.add_argument("--check", action="store_true",
                        help="用 nbtlib 独立校验生成的字节是合法小端 NBT")
    args = parser.parse_args()

    data = BUILDERS[args.kind]()

    if args.check:
        import io

        try:
            import nbtlib
        except ImportError:
            print(
                "自校验需要 nbtlib（只用于验证夹具，被测代码不依赖它）：\n"
                "  pip install -r requirements-dev.txt\n"
                "若 PyPI 直连不通：\n"
                "  pip install -i https://mirrors.aliyun.com/pypi/simple nbtlib"
            )
            return 2

        parsed = dict(nbtlib.File.parse(io.BytesIO(data), byteorder="little"))
        print(f"nbtlib 校验通过：根字段 = {sorted(parsed.keys())}")
        if "size" in parsed:
            print(f"size = {[int(v) for v in parsed['size']]}")
        structure = parsed.get("structure")
        if structure is not None:
            print(f"structure 字段 = {sorted(structure.keys())}")
            for index, layer in enumerate(structure.get("block_indices", [])):
                print(f"  block_indices[{index}] 长度 = {len(layer)}")
            default = structure.get("palette", {}).get("default")
            if default is not None:
                print(f"  调色板条目 = {len(default.get('block_palette', []))}")
                print(f"  方块位置数据条目 = {len(default.get('block_position_data', {}))}")
            print(f"  实体数 = {len(structure.get('entities', []))}")

    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_bytes(data)
        print(f"已写入 {args.out}（{len(data)} 字节）")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
