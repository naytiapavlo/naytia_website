"""小端 NBT 读取器与 .mcstructure 解析器的测试。

夹具由 tests/fixtures/mcstructure_fixtures.py 生成——独立的写入器，
与被测的读取器不共用代码，避免两边同错互相掩盖。

覆盖 04 文档第 3 节要求：「空文件、损坏/截断、错误版本、超大声明长度、压缩膨胀和编码差异」。

写「恶意字节」时的注意事项：手工拼字节很容易把长度字段写错（尤其是小端短整型）。
下面凡是构造畸形输入的用例，一律用 `_evil_string_field` / `_evil_list_field` 这类
辅助函数，把「值字节」交给 `v_string`/`v_list` 之类的既有编码器生成，不再手写长度。
"""
import gzip
import struct
import zlib

import pytest

from app.nbt_le import (
    NbtFormatError,
    NbtLimitError,
    NbtLimits,
    NbtTruncatedError,
    TAG_BYTE,
    TAG_COMPOUND,
    TAG_END,
    TAG_INT,
    TAG_LIST,
    TAG_STRING,
    parse_nbt,
)
from app.parsers.mcstructure import (
    McStructureFormatError,
    McStructureLimitError,
    parse_mcstructure,
)
from tests.fixtures import mcstructure_fixtures as fx


# ---------------------------------------------------------------- 恶意输入辅助

def _evil_string_field(value_length: int, *, name: str = "S", tail: int = 8192) -> bytes:
    """一个根复合体，里面有一个「声明了 value_length 字节」的字符串字段。

    注意：字段名长度也要用 `fx._name`（小端）生成。手写 `\\x00\\x01` 是大端写法，
    会被读成 256 而不是 1 —— 这类字节序错误极易发生，所以一律走编码器。
    """
    return (
        bytes([TAG_COMPOUND]) + struct.pack("<H", 0)
        + bytes([TAG_STRING]) + fx._name(name)
        + struct.pack("<H", value_length)
        + b"A" * tail
    )


def _evil_list_field(declared_count: int, *, name: str = "L", tail: int = 4096) -> bytes:
    """一个根复合体，里面有一个「声明了 declared_count 个元素」的整型列表。"""
    return (
        bytes([TAG_COMPOUND]) + struct.pack("<H", 0)
        + bytes([TAG_LIST]) + fx._name(name)
        + bytes([TAG_INT])
        + struct.pack("<i", declared_count)
        + b"\x00" * tail
    )


# ---------------------------------------------------------------- 底层 NBT

class TestLittleEndianNbt:
    def test_读回手工构造的全部标量类型(self):
        data = fx.root([
            (TAG_STRING, "s", fx.v_string("hello 世界")),
            (TAG_BYTE, "b", fx.v_byte(-7)),
            (fx.TAG_SHORT, "sh", fx.v_short(-300)),
            (TAG_INT, "i", fx.v_int(-70000)),
            (fx.TAG_LONG, "l", fx.v_long(9007199254740993)),  # > 2^53，必须精确
            (fx.TAG_FLOAT, "f", fx.v_float(0.5)),
            (fx.TAG_DOUBLE, "d", fx.v_double(0.1)),
        ])
        root, compression = parse_nbt(data)
        assert compression is None
        assert root["s"] == "hello 世界"
        assert root["b"] == -7
        assert root["sh"] == -300
        assert root["i"] == -70000
        # 关键：小端 64 位整数不能经过浮点丢失精度
        assert root["l"] == 9007199254740993
        assert root["f"] == 0.5
        assert root["d"] == pytest.approx(0.1)

    def test_小端字节序被真正遵守_而不是按大端读(self):
        """同一串字节按大端解释会得到不同结果，用来证明实现没有偷偷按大端解析。"""
        little = fx.root([(TAG_INT, "i", fx.v_int(1))])
        big = fx.root([(TAG_INT, "i", (1).to_bytes(4, "big"))])
        assert parse_nbt(little)[0]["i"] == 1
        assert parse_nbt(big)[0]["i"] == 16777216

    def test_数组与列表(self):
        data = fx.root([
            (fx.TAG_BYTE_ARRAY, "ba", fx.v_byte_array([0, 127, 255])),
            (fx.TAG_INT_ARRAY, "ia", fx.v_int_array([-1, 0, 2**31 - 1])),
            (fx.TAG_LONG_ARRAY, "la", fx.v_long_array([-2**63, 2**63 - 1])),
            (TAG_LIST, "li", fx.v_list(TAG_INT, [fx.v_int(1), fx.v_int(2)])),
            (TAG_LIST, "empty", fx.v_list(TAG_END, [])),
        ])
        root, _ = parse_nbt(data)
        assert root["ba"] == [0, 127, 255]
        assert root["ia"] == [-1, 0, 2**31 - 1]
        assert root["la"] == [-2**63, 2**63 - 1]
        assert root["li"] == [1, 2]
        assert root["empty"] == []

    def test_嵌套复合与列表中的复合(self):
        inner = fx.v_compound([(TAG_INT, "deep", fx.v_int(9))])
        data = fx.root([
            (TAG_COMPOUND, "outer", fx.v_compound([
                (TAG_COMPOUND, "inner", inner),
            ])),
            (TAG_LIST, "items", fx.v_list(TAG_COMPOUND, [
                fx.v_compound([(TAG_INT, "x", fx.v_int(1))]),
                fx.v_compound([(TAG_INT, "x", fx.v_int(2))]),
            ])),
        ])
        root, _ = parse_nbt(data)
        assert root["outer"]["inner"]["deep"] == 9
        assert [item["x"] for item in root["items"]] == [1, 2]

    # ---- 失败路径 ----

    def test_空文件(self):
        with pytest.raises(NbtTruncatedError):
            parse_nbt(b"")

    def test_截断的字节流(self):
        full = fx.slab(x=2, y=2, z=2)
        for cut in (5, 20, len(full) // 2, len(full) - 1):
            with pytest.raises(NbtTruncatedError):
                parse_nbt(full[:cut])

    def test_根标签不是复合(self):
        with pytest.raises(NbtFormatError):
            parse_nbt(fx.wrong_root_tag())

    def test_未知标签类型(self):
        data = bytes([0x7F]) + b"\x00\x00" + bytes([TAG_END])
        with pytest.raises(NbtFormatError):
            parse_nbt(data)

    def test_列表声明长度过大时报上限(self):
        """声明 20 亿个元素：必须报上限，而不是先尝试分配内存。"""
        with pytest.raises(NbtLimitError):
            parse_nbt(_evil_list_field(2_000_000_000))

    def test_列表声明负长度时报格式错误(self):
        with pytest.raises(NbtFormatError):
            parse_nbt(_evil_list_field(-5))

    def test_字符串声明长度过大时报上限(self):
        """声明 60000 字节的字符串：必须在读取之前按上限拒绝。"""
        with pytest.raises(NbtLimitError):
            parse_nbt(_evil_string_field(60000), NbtLimits(max_string_length=1024))

    def test_字符串内容不是合法_utf8(self):
        """字符串内容不是合法 UTF-8：报格式错误，而不是让 UnicodeDecodeError 冒出去。

        字段名与值的长度一律用 fx._name / struct 的小端编码生成。
        """
        value = b"\xff\xfe"
        data = (
            bytes([TAG_COMPOUND]) + struct.pack("<H", 0)
            + bytes([TAG_STRING]) + fx._name("S")
            + struct.pack("<H", len(value)) + value
            + bytes([TAG_END])
        )
        with pytest.raises(NbtFormatError) as exc:
            parse_nbt(data)
        assert "UTF-8" in str(exc.value)

    def test_嵌套过深时报上限(self):
        payload = fx.v_compound([])
        for _ in range(80):
            payload = fx.v_compound([(TAG_COMPOUND, "n", payload)])
        data = fx.root([(TAG_COMPOUND, "deep", payload)])
        with pytest.raises(NbtLimitError):
            parse_nbt(data, NbtLimits(max_depth=16))

    def test_非空列表的元素类型不能是_End(self):
        data = fx.root([(TAG_LIST, "bad", bytes([TAG_END]) + struct.pack("<i", 3))])
        with pytest.raises(NbtFormatError):
            parse_nbt(data)

    # ---- 压缩 ----

    def test_gzip_与_zlib_自动识别(self):
        plain = fx.slab(x=2, y=1, z=2)
        for blob, kind in ((gzip.compress(plain), "gzip"), (zlib.compress(plain), "zlib")):
            root, compression = parse_nbt(blob)
            assert compression == kind
            assert root["size"] == [2, 1, 2]

    def test_压缩膨胀炸弹被上限拦住(self):
        """20 MB 的零字节压缩后很小：必须在解压过程中按输出上限停止。"""
        bomb = zlib.compress(b"\x00" * (20 * 1024 * 1024), 9)
        with pytest.raises((NbtLimitError, NbtFormatError)):
            parse_nbt(bomb, NbtLimits(max_bytes=1024 * 1024))

    def test_损坏的压缩流报错而不是崩溃(self):
        """截断的 gzip 流：解压失败或数据不足，两者都必须是结构化错误。"""
        broken = gzip.compress(fx.slab(x=2, y=1, z=2))[:40]
        with pytest.raises((NbtFormatError, NbtTruncatedError)):
            parse_nbt(broken)


# ------------------------------------------------------- .mcstructure 语义

class TestMcStructureParsing:
    def test_基本结构与尺寸(self):
        parsed, raw = parse_mcstructure(fx.rich(x=2, y=2, z=2))
        assert parsed.format_version == 1
        assert parsed.size == (2, 2, 2)
        assert parsed.voxel_count == 8
        assert parsed.world_origin == (100, 64, -200)
        assert parsed.layer_count == 2
        assert all(len(layer) == 8 for layer in parsed.layers)
        assert "unknown_root_field" in parsed.extra_root_fields

    def test_位置下标按_ZYX_顺序换算(self):
        """文档：sublist 按 ZYX 顺序，从底部西北角到顶部东南角。2×3×4 为例。"""
        parsed, _ = parse_mcstructure(fx.slab(x=2, y=3, z=4))
        assert parsed.block_position(0) == (0, 0, 0)
        assert parsed.block_position(1) == (0, 0, 1)
        assert parsed.block_position(3) == (0, 0, 3)
        assert parsed.block_position(4) == (0, 1, 0)
        assert parsed.block_position(11) == (0, 2, 3)
        assert parsed.block_position(12) == (1, 0, 0)
        assert parsed.block_position(23) == (1, 2, 3)

    def test_调色板解析含三种状态值类型(self):
        parsed, _ = parse_mcstructure(fx.rich())
        assert [b.name for b in parsed.palette] == [
            "minecraft:stone", "minecraft:oak_stairs", "minecraft:air",
        ]
        stairs = parsed.palette[1]
        assert stairs.states["weirdo_direction"] == "north"
        assert stairs.states["upside_down_bit"] == 1
        assert stairs.states["open_bit"] == 1
        assert stairs.version == 18168865

    def test_方块实体_nbt_完整透出(self):
        parsed, _ = parse_mcstructure(fx.rich())
        assert len(parsed.block_entities) == 1
        be = parsed.block_entities[0]
        assert be.position_index == 1
        assert be.position == (0, 0, 1)
        assert be.identifier == "Chest"
        assert be.block_entity_data is not None
        assert be.block_entity_data["isMovable"] == 1
        # 箱子内容原样保留，不做语义猜测
        items = be.block_entity_data["Items"]
        assert len(items) == 1
        assert items[0]["Name"] == "minecraft:apple"
        assert items[0]["Count"] == 3
        assert items[0]["Damage"] == 0
        assert items[0]["Slot"] == 0
        # 计划刻队列
        assert be.tick_queue_data == [{"tick_delay": 2}]

    def test_实体_nbt_完整透出(self):
        parsed, _ = parse_mcstructure(fx.rich())
        assert len(parsed.entities) == 1
        ent = parsed.entities[0]
        assert ent.block_position == (0, 0, 0)
        assert ent.identifier == "minecraft:armor_stand"
        assert ent.data["identifier"] == "minecraft:armor_stand"
        assert ent.data["Pos"] == [0.5, 0.0, 0.5]
        assert ent.data["Yaw"] == 90.0
        assert ent.data["Health"] == 20.0
        # 负的长整型 UniqueID 必须精确保留
        assert ent.data["UniqueID"] == -4611686018427387904
        assert ent.data["CustomName"] == "测试盔甲架"

    def test_两层共位方块与_void(self):
        parsed, _ = parse_mcstructure(fx.rich())
        # 次层只有下标 1 有值，其余都是 -1（void）
        assert parsed.layers[1][1] == 2
        assert parsed.layers[1][0] == -1
        assert sum(1 for v in parsed.layers[1] if v != -1) == 1
        # iter_layer 跳过 void，只产出真实方块
        assert [idx for idx, _, _ in parsed.iter_layer(1)] == [1]

    def test_压缩文件也能解析(self):
        plain = fx.slab(x=2, y=1, z=2)
        parsed, _ = parse_mcstructure(gzip.compress(plain))
        assert parsed.compression == "gzip"
        assert parsed.size == (2, 1, 2)

    # ---- 失败路径 ----

    def test_空文件(self):
        with pytest.raises(McStructureFormatError):
            parse_mcstructure(b"")

    def test_截断文件(self):
        full = fx.rich()
        with pytest.raises(McStructureFormatError):
            parse_mcstructure(full[: len(full) // 2])

    def test_缺少_size(self):
        with pytest.raises(McStructureFormatError) as exc:
            parse_mcstructure(fx.missing_size())
        assert "size" in str(exc.value)

    def test_block_indices_长度与_size_不符(self):
        with pytest.raises(McStructureFormatError) as exc:
            parse_mcstructure(fx.size_mismatch())
        assert "block_indices" in str(exc.value)

    def test_超大体积被上限拦下(self):
        with pytest.raises(McStructureLimitError):
            parse_mcstructure(fx.oversized_voxels())

    def test_根标签错误时报领域错误(self):
        with pytest.raises(McStructureFormatError):
            parse_mcstructure(fx.wrong_root_tag())

    def test_越界调色板下标不崩溃(self):
        """文档：下标 >= 调色板长度按空气处理。解析器保留原值，不静默改写也不抛异常。"""
        parsed, _ = parse_mcstructure(fx.out_of_range_indices())
        assert parsed.layers[0][0] == fx.OUT_OF_RANGE
        assert parsed.voxel_count == 8

    def test_缺少_default_调色板(self):
        """文档：default 不存在时游戏不放置任何方块，因此视为无效结构。"""
        with pytest.raises(McStructureFormatError) as exc:
            parse_mcstructure(fx.no_default_palette())
        assert "default" in str(exc.value)

    def test_size_为非正数时报错(self):
        data = fx._file(
            size=(0, 1, 1),
            structure=fx.v_compound([]),
        )
        with pytest.raises(McStructureFormatError):
            parse_mcstructure(data)


class TestWorldOriginPlacement:
    """structure_world_origin 的位置差异（真实文件 vs 文档）。

    2026-09-16 用真实 Structure Block 导出的 pis.mcstructure 核对发现：
    文档说它在 structure 复合体内部，真实文件却放在根层级。解析器两处都要认。
    这是最容易「静默丢数据」的一类问题——解析不报错，但原点变成 None。
    """

    def test_真实文件口径_原点在根层级(self):
        parsed, _ = parse_mcstructure(fx.real_world_single_block(origin_at_root=True))
        assert parsed.world_origin == fx.REAL_WORLD_ORIGIN
        assert parsed.world_origin_source == "root"
        # 已消费的字段不该再出现在「未建模字段」里
        assert "structure_world_origin" not in parsed.extra_root_fields

    def test_文档口径_原点在_structure_内部(self):
        parsed, _ = parse_mcstructure(fx.real_world_single_block(origin_at_root=False))
        assert parsed.world_origin == fx.REAL_WORLD_ORIGIN
        assert parsed.world_origin_source == "structure"
        assert "structure_world_origin" not in parsed.extra_root_fields

    def test_两种口径解析出相同的原点与方块(self):
        """位置差异不应影响解析结果本身。"""
        a, _ = parse_mcstructure(fx.real_world_single_block(origin_at_root=True))
        b, _ = parse_mcstructure(fx.real_world_single_block(origin_at_root=False))
        assert a.world_origin == b.world_origin
        assert a.size == b.size == (1, 1, 1)
        assert [x.name for x in a.palette] == [x.name for x in b.palette]
        assert a.layers == b.layers

    def test_两种都不在时原点为_None_且不再当作未建模字段(self):
        # slab 之外的极简结构：没有 origin 字段
        parsed, _ = parse_mcstructure(fx.slab(x=1, y=1, z=1))
        # slab 自己带 origin=(0,0,0)，这里换一个真正没有该字段的结构
        assert parsed.world_origin is not None  # slab 有 origin

        data = fx._file(
            size=(1, 1, 1),
            structure=fx.v_compound([
                (TAG_LIST, "block_indices", fx.v_list(TAG_LIST, [
                    fx.v_list(TAG_INT, [fx.v_int(0)]),
                    fx.v_list(TAG_INT, [fx.v_int(-1)]),
                ])),
                (TAG_COMPOUND, "palette", fx.v_compound([
                    (TAG_COMPOUND, "default", fx._default_palette(
                        fx.v_list(TAG_COMPOUND, [fx.palette_entry("minecraft:stone")]),
                    )),
                ])),
            ]),
        )
        no_origin, _ = parse_mcstructure(data)
        assert no_origin.world_origin is None
        assert no_origin.world_origin_source is None

    def test_原点元素个数不对时报格式错误(self):
        bad = fx._file(
            size=(1, 1, 1),
            structure=fx.v_compound([]),
            extra=[(TAG_LIST, "structure_world_origin",
                    fx.v_list(TAG_INT, [fx.v_int(1), fx.v_int(2)]))],
        )
        with pytest.raises(McStructureFormatError):
            parse_mcstructure(bad)

    def test_方块实体坐标与原点一致_复刻真实文件的交叉校验(self):
        """真实文件里 PistonArm 的 x/y/z 就是该方块的绝对世界坐标，等于结构原点。

        这条断言把「原点读错」和「方块实体 NBT 读错」变成互相印证的关系：
        两边都错成同一个值几乎不可能。
        """
        parsed, _ = parse_mcstructure(fx.real_world_single_block())
        ox, oy, oz = fx.REAL_WORLD_ORIGIN
        assert parsed.world_origin == (ox, oy, oz)

        assert len(parsed.block_entities) == 1
        nbt = parsed.block_entities[0].block_entity_data
        assert nbt is not None
        assert (nbt["x"], nbt["y"], nbt["z"]) == (ox, oy, oz)
        assert parsed.block_entities[0].identifier == "PistonArm"
        # 结构内坐标是相对原点，恒为 (0,0,0)
        assert parsed.block_entities[0].position == (0, 0, 0)

    def test_方块实体里的浮点与数组字段完整保留(self):
        parsed, _ = parse_mcstructure(fx.real_world_single_block())
        nbt = parsed.block_entities[0].block_entity_data
        assert nbt is not None
        assert nbt["Progress"] == 0.0
        assert isinstance(nbt["Progress"], float)
        assert nbt["Sticky"] == 1
        assert nbt["isMovable"] == 1
        assert nbt["AttachedBlocks"] == []
        assert nbt["BreakBlocks"] == []
        assert nbt["State"] == 0
        assert nbt["BlockEntityVersion"] == 0
        # 调色板里的方块状态
        assert parsed.palette[0].name == "minecraft:sticky_piston"
        assert parsed.palette[0].states == {"facing_direction": 2}
