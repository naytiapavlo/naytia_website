"""真实游戏导出文件的回归测试（`tests/fixtures/real/`）。

与 `test_mcstructure.py` 的分工：
- 那边用手工夹具覆盖**边界与畸形输入**（截断、超大长度、压缩膨胀、非法 UTF-8…）。
- 这边用真实文件覆盖**「文档与真实实现是否一致」**——手工夹具做不到这一点。

真实文件必须原样读取，不能用代码重新生成，否则它就退化成另一个手工夹具，
也就无法再发现格式偏差。文件来源与校验值见 `fixtures/real/README.md`。
"""
import hashlib
import pathlib

import pytest

from app.parsers.mcstructure import parse_mcstructure

REAL_DIR = pathlib.Path(__file__).parent / "fixtures" / "real"

STICKY_PISTON = REAL_DIR / "sticky-piston-1x1x1.mcstructure"
STICKY_PISTON_SHA256 = "c73bea3fcf741b29356918cc8e1eeb97fbc40ff9d0b6d5f3737977a78bd7cac8"

# 该真实文件里的已知取值（用游戏内 Structure Block 导出，见 README）
EXPECTED_ORIGIN = (72, 59, -10)


def load(path: pathlib.Path) -> bytes:
    if not path.exists():
        pytest.skip(f"真实夹具不存在：{path}")
    return path.read_bytes()


class TestStickyPistonRealFile:
    def test_文件未被改动(self):
        """先锁文件本身：内容变了后面的断言就失去意义。"""
        data = load(STICKY_PISTON)
        assert hashlib.sha256(data).hexdigest() == STICKY_PISTON_SHA256
        assert len(data) == 515

    def test_基本结构(self):
        parsed, _ = parse_mcstructure(load(STICKY_PISTON))
        assert parsed.format_version == 1
        assert parsed.size == (1, 1, 1)
        assert parsed.voxel_count == 1
        assert parsed.layer_count == 2
        assert parsed.compression is None

    def test_原点在根层级_这是文档没写对的地方(self):
        """真实文件把 structure_world_origin 放在根层级，不是 structure 内部。

        这条断言就是「文档偏差」的回归锁：旧实现只查 structure，
        会把原点静默读成 None（不报错，所以更容易漏）。
        """
        parsed, raw = parse_mcstructure(load(STICKY_PISTON))
        assert "structure_world_origin" in raw, "真实文件的根层级应含该字段"
        assert "structure_world_origin" not in raw["structure"], "不应同时在 structure 内部"
        assert parsed.world_origin == EXPECTED_ORIGIN
        assert parsed.world_origin_source == "root"
        # 已经消费掉的字段不能再被当成「未建模字段」重复报告
        assert parsed.extra_root_fields == {}

    def test_调色板与方块状态(self):
        parsed, _ = parse_mcstructure(load(STICKY_PISTON))
        assert len(parsed.palette) == 1
        block = parsed.palette[0]
        assert block.name == "minecraft:sticky_piston"
        assert block.states == {"facing_direction": 2}
        assert block.version == 18168865

    def test_两层索引_次层为_void(self):
        parsed, _ = parse_mcstructure(load(STICKY_PISTON))
        assert parsed.layers[0] == [0]
        assert parsed.layers[1] == [-1]
        assert parsed.layers[1][0] == -1  # 结构空位

    def test_方块实体完整解析(self):
        parsed, _ = parse_mcstructure(load(STICKY_PISTON))
        assert len(parsed.block_entities) == 1
        be = parsed.block_entities[0]
        assert be.identifier == "PistonArm"
        assert be.position_index == 0
        assert be.position == (0, 0, 0)  # 结构内坐标是相对的
        assert be.tick_queue_data == []

        nbt = be.block_entity_data
        assert nbt is not None
        # 交叉验证：方块实体里的绝对世界坐标 == 结构原点
        assert (nbt["x"], nbt["y"], nbt["z"]) == EXPECTED_ORIGIN
        assert nbt["id"] == "PistonArm"
        assert nbt["isMovable"] == 1
        assert nbt["Sticky"] == 1
        assert nbt["State"] == 0
        assert nbt["NewState"] == 0
        assert nbt["BlockEntityVersion"] == 0
        # 浮点保持浮点
        assert nbt["Progress"] == 0.0
        assert isinstance(nbt["Progress"], float)
        assert nbt["LastProgress"] == 0.0
        # 空数组保持数组
        assert nbt["AttachedBlocks"] == []
        assert nbt["BreakBlocks"] == []

    def test_无实体(self):
        parsed, _ = parse_mcstructure(load(STICKY_PISTON))
        assert parsed.entities == []

    def test_把真实文件当成未知字段的_回归(self):
        """确保没有字段被悄悄丢掉：根与 structure 的所有键都被消费或明确保留。"""
        parsed, raw = parse_mcstructure(load(STICKY_PISTON))
        assert set(raw.keys()) == {
            "format_version", "size", "structure", "structure_world_origin",
        }
        assert set(raw["structure"].keys()) == {"block_indices", "entities", "palette"}
        assert set(raw["structure"]["palette"]["default"].keys()) == {
            "block_palette", "block_position_data",
        }


class TestRealFileViaApi:
    """同样的真实文件走 HTTP 接口（multipart 全链路）。"""

    def test_上传真实文件并解析(self, client):
        res = client.post(
            "/api/mcstructure/parse",
            files={
                "file": (
                    "sticky-piston-1x1x1.mcstructure",
                    load(STICKY_PISTON),
                    "application/octet-stream",
                )
            },
            params={"include_voxels": "true"},
        )
        assert res.status_code == 200, res.text
        body = res.json()

        assert body["layout"]["size"] == {"x": 1, "y": 1, "z": 1}
        assert body["layout"]["world_origin"] == {"x": 72, "y": 59, "z": -10}
        assert body["layout"]["world_origin_source"] == "root"
        assert body["file_bytes"] == 515
        assert body["extra_root_fields"] == []

        assert [p["name"] for p in body["palette"]] == ["minecraft:sticky_piston"]
        assert body["stats"]["blocks"][0]["count"] == 1
        assert body["stats"]["primary_filled"] == 1
        assert body["stats"]["secondary_filled"] == 0

        be = body["block_entities"][0]
        assert be["identifier"] == "PistonArm"
        assert be["block_entity_data"]["Sticky"] == 1
        assert be["block_entity_data"]["Progress"] == 0.0

        assert body["voxels"][0]["indices"] == [0]
        assert body["voxels"][1]["indices"] == [-1]

    def test_真实文件的坐标互查(self, client):
        res = client.post(
            "/api/mcstructure/position",
            files={"file": ("p.mcstructure", load(STICKY_PISTON),
                            "application/octet-stream")},
            params={"x": 0, "y": 0, "z": 0},
        )
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["index"] == 0
        layers = {item["layer"]: item for item in body["layers"]}
        assert layers[0]["name"] == "minecraft:sticky_piston"
        assert layers[1]["palette_index"] == -1
        assert layers[1]["name"] is None  # void：没有对应方块
