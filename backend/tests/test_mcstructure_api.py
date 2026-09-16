"""结构文件解析 API 的测试（backend/app/routers/mcstructure.py）。

夹具复用 tests/fixtures/mcstructure_fixtures.py 生成的小端 NBT 字节，
通过 multipart 上传，走的路径与真实前端完全一致。
"""
import gzip
import io

import pytest

from tests.fixtures import mcstructure_fixtures as fx


def upload(client, data: bytes, *, filename: str = "demo.mcstructure", **params):
    """按 multipart 上传一个结构文件。"""
    return client.post(
        "/api/mcstructure/parse",
        files={"file": (filename, io.BytesIO(data), "application/octet-stream")},
        params=params,
    )


def post_file(client, path: str, data: bytes, *, filename: str = "demo.mcstructure", **params):
    return client.post(
        path,
        files={"file": (filename, io.BytesIO(data), "application/octet-stream")},
        params=params,
    )


class TestParseEndpoint:
    def test_解析富结构返回索引与统计(self, client):
        res = upload(client, fx.rich())
        assert res.status_code == 200, res.text
        body = res.json()

        assert body["format_version"] == 1
        assert body["layout"]["size"] == {"x": 2, "y": 2, "z": 2}
        assert body["layout"]["voxel_count"] == 8
        assert body["layout"]["world_origin"] == {"x": 100, "y": 64, "z": -200}
        assert body["layout"]["coordinate_order"] == "zyx"
        assert body["compression"] is None
        assert body["file_bytes"] > 0

        # 调色板三种状态值类型都保留
        palette = {b["name"]: b for b in body["palette"]}
        assert palette["minecraft:oak_stairs"]["states"]["weirdo_direction"] == "north"
        assert palette["minecraft:oak_stairs"]["states"]["upside_down_bit"] == 1
        assert palette["minecraft:oak_stairs"]["states"]["open_bit"] == 1

        # 统计：两层共 8 + 1 个非 void 方块
        stats = body["stats"]
        assert stats["total_voxels"] == 8
        assert stats["filled"] == 9
        assert stats["primary_filled"] == 8
        assert stats["secondary_filled"] == 1
        assert stats["out_of_range_indices"] == 0
        assert [layer["layer"] for layer in stats["layers"]] == [0, 1]
        assert stats["layers"][1]["filled"] == 1
        assert stats["layers"][1]["void"] == 7
        # blocks 按数量降序
        counts = [b["count"] for b in stats["blocks"]]
        assert counts == sorted(counts, reverse=True)
        assert sum(counts) == 9

    def test_方块实体与实体_nbt_完整返回(self, client):
        body = upload(client, fx.rich()).json()

        assert len(body["block_entities"]) == 1
        be = body["block_entities"][0]
        assert be["identifier"] == "Chest"
        assert (be["x"], be["y"], be["z"]) == (0, 0, 1)
        assert be["index"] == 1
        assert be["block_entity_data"]["isMovable"] == 1
        assert be["block_entity_data"]["Items"][0]["Name"] == "minecraft:apple"
        assert be["block_entity_data"]["Items"][0]["Count"] == 3
        assert be["tick_queue_data"] == [{"tick_delay": 2}]

        assert len(body["entities"]) == 1
        ent = body["entities"][0]
        assert ent["identifier"] == "minecraft:armor_stand"
        assert ent["block_position"] == {"x": 0, "y": 0, "z": 0}
        assert ent["data"]["Pos"] == [0.5, 0.0, 0.5]
        assert ent["data"]["UniqueID"] == -4611686018427387904
        assert ent["data"]["CustomName"] == "测试盔甲架"

    def test_默认不返回体素_显式请求才返回(self, client):
        plain = upload(client, fx.rich()).json()
        assert plain["voxels"] is None

        with_voxels = upload(client, fx.rich(), include_voxels=True).json()
        assert with_voxels["voxels"] is not None
        assert len(with_voxels["voxels"]) == 2
        assert with_voxels["voxels"][0]["layer"] == 0
        assert len(with_voxels["voxels"][0]["indices"]) == 8
        # 次层只有下标 1 是真实方块，其余 -1
        secondary = with_voxels["voxels"][1]["indices"]
        assert secondary[1] == 2
        assert secondary[0] == -1

    def test_include_raw_返回完整根_nbt(self, client):
        raw = upload(client, fx.rich(), include_raw=True).json()["raw_nbt"]
        assert set(raw) >= {"format_version", "size", "structure"}
        assert raw["structure"]["palette"]["default"]["block_palette"][0]["name"] == "minecraft:stone"

    def test_未知根字段被保留而不是丢弃(self, client):
        body = upload(client, fx.rich()).json()
        assert "unknown_root_field" in body["extra_root_fields"]
        assert body["raw_nbt"] is None

    def test_压缩文件也能上传(self, client):
        body = upload(client, gzip.compress(fx.rich())).json()
        assert body["compression"] == "gzip"
        assert body["layout"]["size"]["x"] == 2

    # ---- 失败路径 ----

    def test_空文件报结构化错误(self, client):
        res = upload(client, b"")
        assert res.status_code == 400
        assert res.json()["detail"]["code"] == "empty_file"

    def test_非_nbt_文件报结构化错误(self, client):
        res = upload(client, b"this is not an nbt file at all")
        assert res.status_code == 400
        detail = res.json()["detail"]
        assert detail["code"] == "invalid_structure"
        assert detail["message"]

    def test_根标签错误报结构化错误(self, client):
        res = upload(client, fx.wrong_root_tag())
        assert res.status_code == 400
        assert res.json()["detail"]["code"] == "invalid_structure"

    def test_截断文件报结构化错误而不是_500(self, client):
        full = fx.rich()
        res = upload(client, full[: len(full) // 2])
        assert res.status_code == 400
        assert res.json()["detail"]["code"] == "invalid_structure"

    def test_缺少_size报结构化错误(self, client):
        res = upload(client, fx.missing_size())
        assert res.status_code == 400
        assert "size" in res.json()["detail"]["message"]

    def test_体积超限返回_413(self, client):
        res = upload(client, fx.oversized_voxels())
        assert res.status_code == 413
        assert res.json()["detail"]["code"] == "structure_too_large"

    def test_缺少文件字段时返回_422(self, client):
        assert client.post("/api/mcstructure/parse").status_code == 422


class TestRealWorldFileShape:
    """复刻真实 Structure Block 导出文件的回归用例。

    发现经过：用真实文件 pis.mcstructure 核对时，`structure_world_origin` 出现在
    **根层级**（文档说在 structure 内部），旧实现只查 structure，导致原点被静默丢成 None。
    这里锁死两种位置都要能解析。
    """

    def parse(self, client, data):
        res = upload(client, data)
        assert res.status_code == 200, res.text
        return res.json()

    def test_真实口径_原点在根层级也能解析(self, client):
        body = self.parse(client, fx.real_world_single_block(origin_at_root=True))
        assert body["layout"]["world_origin"] == {"x": 72, "y": 59, "z": -10}
        assert body["layout"]["world_origin_source"] == "root"
        assert body["extra_root_fields"] == []

    def test_文档口径_原点在_structure_内也支持(self, client):
        body = self.parse(client, fx.real_world_single_block(origin_at_root=False))
        assert body["layout"]["world_origin"] == {"x": 72, "y": 59, "z": -10}
        assert body["layout"]["world_origin_source"] == "structure"

    def test_单方块结构与方块实体完整返回(self, client):
        body = self.parse(client, fx.real_world_single_block())
        assert body["layout"]["size"] == {"x": 1, "y": 1, "z": 1}
        assert [p["name"] for p in body["palette"]] == ["minecraft:sticky_piston"]
        assert body["palette"][0]["states"] == {"facing_direction": 2}
        assert body["palette"][0]["version"] == 18168865

        assert len(body["block_entities"]) == 1
        be = body["block_entities"][0]
        assert be["identifier"] == "PistonArm"
        # 结构内坐标是相对的；绝对坐标在 NBT 里
        assert (be["x"], be["y"], be["z"]) == (0, 0, 0)
        nbt = be["block_entity_data"]
        assert (nbt["x"], nbt["y"], nbt["z"]) == (72, 59, -10)
        assert nbt["Sticky"] == 1
        assert nbt["Progress"] == 0.0
        assert nbt["AttachedBlocks"] == []

        # 两层：主层有 1 个方块，次层是 void
        assert body["stats"]["primary_filled"] == 1
        assert body["stats"]["secondary_filled"] == 0
        assert body["stats"]["blocks"] == [
            {
                "index": 0,
                "name": "minecraft:sticky_piston",
                "states": {"facing_direction": 2},
                "count": 1,
                "ratio": 1.0,
            }
        ]

    def test_层统计里_void_被正确计数(self, client):
        body = self.parse(client, fx.real_world_single_block())
        layers = {layer["layer"]: layer for layer in body["stats"]["layers"]}
        assert layers[0]["filled"] == 1
        assert layers[0]["void"] == 0
        assert layers[1]["filled"] == 0
        assert layers[1]["void"] == 1


class TestVoxelsAndSlice:
    def test_取完整体素(self, client):
        res = post_file(client, "/api/mcstructure/voxels", fx.rich())
        assert res.status_code == 200
        layers = res.json()
        assert len(layers) == 2
        assert len(layers[0]["indices"]) == 8

    def test_取_y_轴薄片(self, client):
        # rich 是 2×2×2：y=0 的薄片含 4 格
        res = post_file(client, "/api/mcstructure/slice", fx.rich(), axis="y", at=0)
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["axis"] == "y"
        assert body["at"] == 0
        assert body["layer"] == 0
        assert body["plane_size"] == {"x": 2, "y": 1, "z": 2}
        assert len(body["indices"]) == 4
        assert body["blocks"]

    def test_薄片坐标越界报错(self, client):
        res = post_file(client, "/api/mcstructure/slice", fx.rich(), axis="y", at=99)
        assert res.status_code == 400
        assert res.json()["detail"]["code"] == "slice_out_of_range"

    def test_薄片层号越界报错(self, client):
        res = post_file(client, "/api/mcstructure/slice", fx.rich(), axis="y", at=0, layer=5)
        assert res.status_code == 400
        assert res.json()["detail"]["code"] == "layer_out_of_range"

    def test_非法轴名被参数校验拦下(self, client):
        res = post_file(client, "/api/mcstructure/slice", fx.rich(), axis="w", at=0)
        assert res.status_code == 422


class TestPositionLookup:
    def test_坐标反查下标与方块(self, client):
        # 下标 1 -> (0,0,1)。rich 的主层在该格是调色板 2、次层放了共位方块 2
        res = post_file(client, "/api/mcstructure/position", fx.rich(), x=0, y=0, z=1)
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["index"] == 1
        assert body["size"] == {"x": 2, "y": 2, "z": 2}
        layers = {item["layer"]: item for item in body["layers"]}
        assert layers[0]["palette_index"] == 2
        assert layers[0]["name"] == "minecraft:air"
        assert layers[1]["palette_index"] == 2
        assert layers[1]["name"] == "minecraft:air"

    def test_坐标越界报错(self, client):
        res = post_file(client, "/api/mcstructure/position", fx.rich(), x=9, y=0, z=0)
        assert res.status_code == 400
        assert res.json()["detail"]["code"] == "position_out_of_range"

    def test_下标换算公式与_ZYX_一致(self, client):
        """size 为 2×3×4 时，下标 = x*(3*4) + y*4 + z。"""
        data = fx.slab(x=2, y=3, z=4)
        for x, y, z, expected in ((0, 0, 0, 0), (0, 0, 3, 3), (0, 1, 0, 4),
                                  (0, 2, 3, 11), (1, 0, 0, 12), (1, 2, 3, 23)):
            res = post_file(client, "/api/mcstructure/position", data, x=x, y=y, z=z)
            assert res.status_code == 200
            assert res.json()["index"] == expected, f"({x},{y},{z})"


class TestBlocksPaging:
    def test_方块实体分页(self, client):
        res = post_file(client, "/api/mcstructure/blocks", fx.rich(),
                        kind="block_entities", offset=0, limit=10)
        assert res.status_code == 200
        body = res.json()
        assert body["total"] == 1
        assert body["items"][0]["identifier"] == "Chest"

    def test_实体分页_offset_生效(self, client):
        first = post_file(client, "/api/mcstructure/blocks", fx.rich(),
                          kind="entities", offset=0, limit=10).json()
        assert first["total"] == 1

        empty = post_file(client, "/api/mcstructure/blocks", fx.rich(),
                          kind="entities", offset=5, limit=10).json()
        assert empty["total"] == 1
        assert empty["items"] == []

    def test_非法_kind_被参数校验拦下(self, client):
        res = post_file(client, "/api/mcstructure/blocks", fx.rich(), kind="nope")
        assert res.status_code == 422


class TestInfoEndpoint:
    def test_说明接口公开可读(self, client):
        body = client.get("/api/mcstructure/info").json()
        assert body["endianness"] == "little（Bedrock NBT）"
        assert "zyx" in body["index_order"]
        assert "index = x * (sizeY * sizeZ) + y * sizeZ + z" == body["index_formula"]
        assert body["limits"]["max_voxels"] > 0
        assert "/api/mcstructure/parse" in " ".join(body["endpoints"].keys())

    def test_接口出现在_openapi_里(self, client):
        # 契约地址是 /api/openapi.json：站点自己的 /docs/ 是访客看的文档树，
        # FastAPI 的接口文档整体挪到了 /api 下（ADR-009）。
        schema = client.get("/api/openapi.json").json()
        paths = schema["paths"]
        for path in ("/api/mcstructure/parse", "/api/mcstructure/voxels",
                     "/api/mcstructure/slice", "/api/mcstructure/position",
                     "/api/mcstructure/blocks", "/api/mcstructure/info"):
            assert path in paths, f"OpenAPI 缺少 {path}"
