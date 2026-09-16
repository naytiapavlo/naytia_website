"""论坛结构附件：上传解析、材料清单、渲染载荷、权限与边界（docs/plans/10）。

这一组测试要守住的东西按重要性排序：

1. **材料清单算得对**——它是这个功能对用户的主要价值，算错了没人会一眼看出来。
   预期值全部由夹具的**确定性内容**手推得到（见 `tests/fixtures/mcstructure_fixtures.py`
   里 `rich` / `slab` 的构造），不是从被测代码反推的。
2. **渲染载荷两端对得上**——占用位图与下标数组是自定的小二进制协议，
   解码出来必须能还原出夹具里那几格方块。
3. **边界明确**——超 10 MB、非 .mcstructure、损坏文件、未登录，
   各自报什么错都有断言，不能只是「没 500」。
4. **不泄露内部路径**——`storage_path` / `render_path` 是模块内部字段，
   任何响应里都不该出现。
"""
import base64
import hashlib

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from tests.conftest import register
from tests.fixtures import mcstructure_fixtures as fx

THREAD_PATH = "/api/forum/threads/with-attachments"


def upload(
    client: TestClient,
    data: bytes,
    *,
    name: str = "小屋.mcstructure",
    title: str = "分享一个小木屋",
    category: str = "作品展示",
    body: str = "材料清单见附件，欢迎照着搭一个。",
):
    """发帖并带结构文件。

    端点是 `with-attachments` 而不是最初的 `with-structure`：加了封面之后
    一个帖子可以有「只带结构 / 只带封面 / 都带」三种组合，拆成多个端点会让
    前端按组合去猜该调哪个。字段名也从 `file` 改成了 `structure`——
    两个可选文件放在一起时，`file` 这个名字就说不清是哪一个了。
    """
    return client.post(
        THREAD_PATH,
        data={"category": category, "title": title, "body": body},
        files={"structure": (name, data, "application/octet-stream")},
    )


def decode_payload(client: TestClient, thread_id: int) -> dict:
    res = client.get(f"/api/forum/threads/{thread_id}/structure/render")
    assert res.status_code == 200, res.text
    return res.json()


def solid_cells(payload: dict) -> dict[int, int]:
    """把载荷还原成 {位置下标: 调色板下标}，用于与夹具内容对照。

    这一步故意不复用前端的解码实现：后端测试要独立验证协议本身，
    两边共用一个解码器的话，协议写错了两边会一起错。
    """
    occupancy = base64.b64decode(payload["occupancy"])
    indices = base64.b64decode(payload["indices"])
    step = payload["index_bits"] // 8
    assert len(indices) == payload["solid_count"] * step

    cells: dict[int, int] = {}
    cursor = 0
    for byte_index, byte in enumerate(occupancy):
        for bit in range(8):
            index = byte_index * 8 + bit
            if index >= payload["voxel_count"]:
                break
            if not (byte >> bit) & 1:
                continue
            raw = indices[cursor * step : (cursor + 1) * step]
            cells[index] = int.from_bytes(raw, "little")
            cursor += 1
    assert cursor == payload["solid_count"]
    return cells


class TestUploadAndParse:
    def test_未登录不能带结构发帖(self, client: TestClient):
        res = upload(client, fx.slab(x=2, y=2, z=2))
        assert res.status_code == 401
        assert res.json()["detail"]["code"] == "auth_required"

    def test_发帖并解析出材料清单(self, client: TestClient):
        register(client, "楼主")
        res = upload(client, fx.slab(x=2, y=2, z=2))
        assert res.status_code == 201, res.text
        body = res.json()

        assert body["has_structure"] is True
        st = body["structure"]
        assert st["original_name"] == "小屋.mcstructure"
        assert st["size"] == {"x": 2, "y": 2, "z": 2}
        assert st["voxel_count"] == 8
        # slab 夹具：主层 8 格全是石头，次层全 void
        assert st["solid_cells"] == 8
        assert st["placed_blocks"] == 8
        assert st["air_cells"] == 0
        assert st["air_blocks"] == 0
        # 材料清单：只有石头，8 块，占 100%
        assert [m["name"] for m in st["materials"]] == ["minecraft:stone"]
        assert st["materials"][0]["count"] == 8
        assert st["materials"][0]["ratio"] == 1.0
        assert st["materials_total"] == 1
        assert st["materials_truncated"] is False
        assert len(st["sha256"]) == 64
        assert st["byte_size"] == len(fx.slab(x=2, y=2, z=2))

    def test_空气不进材料清单但计数单列(self, client: TestClient):
        """rich 夹具：主层 8 格（下标 0/1/2），次层 1 格，其中下标 2 是空气。"""
        register(client, "楼主")
        st = upload(client, fx.rich()).json()["structure"]

        # 主层 [0,2,0,1,2,0,1,2] + 次层 [-1,2,...] = 9 个非 void 索引，其中 4 个是空气
        assert st["placed_blocks"] == 9
        assert st["air_blocks"] == 4
        # 有可见方块的格子：0/2/3/5/6 共 5 格；另 3 格只有空气
        assert st["solid_cells"] == 5
        assert st["air_cells"] == 3
        # 材料清单里没有 minecraft:air，比例按材料总数（5）算，加起来等于 1
        names = [m["name"] for m in st["materials"]]
        assert "minecraft:air" not in names
        assert names == ["minecraft:stone", "minecraft:oak_stairs"]
        assert [m["count"] for m in st["materials"]] == [3, 2]
        assert sum(m["ratio"] for m in st["materials"]) == pytest.approx(1.0)

    def test_方块状态原样透出(self, client: TestClient):
        register(client, "楼主")
        st = upload(client, fx.rich()).json()["structure"]
        stairs = next(m for m in st["materials"] if m["name"] == "minecraft:oak_stairs")
        # 三种值类型（字符串 / 整数 / 字节）都要在，且不被翻译或改型
        assert stairs["states"] == {
            "weirdo_direction": "north",
            "upside_down_bit": 1,
            "open_bit": 1,
        }

    def test_结构与实体数量透出(self, client: TestClient):
        register(client, "楼主")
        st = upload(client, fx.rich()).json()["structure"]
        assert st["block_entities"] == 1
        assert st["entities"] == 1
        assert st["layer_count"] == 2
        assert st["world_origin"] == [100, 64, -200]
        assert st["world_origin_source"] == "structure"

    def test_列表页带结构徽标(self, client: TestClient):
        register(client, "楼主")
        with_structure = upload(client, fx.slab(x=1, y=1, z=1)).json()["id"]
        client.post(
            "/api/forum/threads",
            json={"category": "机制研究", "title": "纯文字帖", "body": "只是聊聊天。"},
        )
        items = {t["id"]: t for t in client.get("/api/forum/threads").json()["items"]}
        assert items[with_structure]["has_structure"] is True
        assert any(t["has_structure"] is False for t in items.values())

    def test_纯文字帖没有结构字段(self, client: TestClient):
        register(client, "楼主")
        res = client.post(
            "/api/forum/threads",
            json={"category": "机制研究", "title": "纯文字帖", "body": "只是聊聊天。"},
        )
        assert res.status_code == 201
        assert res.json()["has_structure"] is False
        assert res.json()["structure"] is None
        assert client.get(
            f"/api/forum/threads/{res.json()['id']}/structure"
        ).status_code == 404

    def test_版块清单接口(self, client: TestClient):
        res = client.get("/api/forum/categories")
        assert res.status_code == 200
        assert "作品展示" in res.json()["categories"]


class TestValidation:
    def test_扩展名不对报结构化错误(self, client: TestClient):
        register(client, "楼主")
        res = upload(client, fx.slab(x=1, y=1, z=1), name="存档.mcworld")
        assert res.status_code == 400
        assert res.json()["detail"]["code"] == "unsupported_type"
        # 失败的帖子不该留下
        assert client.get("/api/forum/threads").json()["items"] == []

    def test_空文件被拒(self, client: TestClient):
        register(client, "楼主")
        res = upload(client, b"")
        assert res.status_code == 400
        assert res.json()["detail"]["code"] == "empty_file"

    def test_损坏文件报结构化错误且不建帖(self, client: TestClient):
        register(client, "楼主")
        full = fx.slab(x=2, y=2, z=2)
        res = upload(client, full[: len(full) // 2])
        assert res.status_code == 400
        assert res.json()["detail"]["code"] == "invalid_structure"
        assert client.get("/api/forum/threads").json()["items"] == []

    def test_超过10MB被拒(self, client: TestClient):
        """10 MB 是需求给的硬边界。用零字节灌到 10 MB + 1 即可触发，不必是真结构。"""
        register(client, "楼主")
        res = upload(client, b"\x00" * (10 * 1024 * 1024 + 1))
        assert res.status_code == 413
        assert res.json()["detail"]["code"] == "file_too_large"
        assert "10.00 MB" in res.json()["detail"]["message"]
        assert client.get("/api/forum/threads").json()["items"] == []

    def test_标题太短被拒(self, client: TestClient):
        register(client, "楼主")
        res = upload(client, fx.slab(x=1, y=1, z=1), title="短")
        assert res.status_code == 422

    def test_未知版块被拒(self, client: TestClient):
        register(client, "楼主")
        res = upload(client, fx.slab(x=1, y=1, z=1), category="不存在版块")
        assert res.status_code == 422

    def test_响应里不出现内部落盘路径(self, client: TestClient):
        register(client, "楼主")
        res = upload(client, fx.slab(x=1, y=1, z=1))
        raw = res.text
        assert "storage_path" not in raw
        assert "render_path" not in raw
        assert "structures/" not in raw
        assert "data/" not in raw

    def test_越界下标不混进材料清单(self, client: TestClient):
        """越界调色板下标按游戏口径是空气：不计入任何材料，但单独计数。"""
        register(client, "楼主")
        st = upload(client, fx.out_of_range_indices()).json()["structure"]
        assert st["out_of_range_indices"] == 1
        # 2×2×2 = 8 格，其中 1 格越界 → 7 块石头
        assert [m["count"] for m in st["materials"]] == [7]
        assert st["solid_cells"] == 7


class TestRenderPayload:
    def test_载荷还原出夹具内容(self, client: TestClient):
        register(client, "楼主")
        thread_id = upload(client, fx.rich()).json()["id"]
        payload = decode_payload(client, thread_id)

        assert payload["version"] == 1
        assert payload["size"] == {"x": 2, "y": 2, "z": 2}
        assert payload["voxel_count"] == 8
        assert payload["solid_count"] == 5
        assert payload["index_bits"] == 8
        assert payload["palette"] == [
            "minecraft:stone",
            "minecraft:oak_stairs",
            "minecraft:air",
        ]

        # ZYX 顺序：index = x*(sy*sz) + y*sz + z
        # 主层 [0,2,0,1,2,0,1,2]（2 = 空气），次层只有下标 1 有值（也是空气）
        cells = solid_cells(payload)
        assert cells == {0: 0, 2: 0, 3: 1, 5: 0, 6: 1}

    def test_位图位数与体素数一致(self, client: TestClient):
        register(client, "楼主")
        thread_id = upload(client, fx.slab(x=3, y=2, z=4)).json()["id"]
        payload = decode_payload(client, thread_id)
        occupancy = base64.b64decode(payload["occupancy"])
        assert len(occupancy) == (3 * 2 * 4 + 7) // 8
        assert len(solid_cells(payload)) == 24

    def test_大调色板用16位下标(self, client: TestClient):
        """调色板超过 256 项时下标升到 16 位；解码端必须跟着走。"""
        register(client, "楼主")
        thread_id = upload(client, fx.big_palette(300)).json()["id"]
        payload = decode_payload(client, thread_id)
        assert payload["index_bits"] == 16
        assert payload["palette"][299] == "minecraft:block_299"
        # 每格都放的是第 299 号方块
        assert solid_cells(payload) == {0: 299}

    def test_载荷响应带缓存头与gzip(self, client: TestClient):
        register(client, "楼主")
        thread_id = upload(client, fx.slab(x=2, y=2, z=2)).json()["id"]
        res = client.get(f"/api/forum/threads/{thread_id}/structure/render")
        assert res.status_code == 200
        assert res.headers["content-encoding"] == "gzip"
        assert res.headers["x-content-type-options"] == "nosniff"
        assert res.headers["cache-control"].startswith("public")
        assert res.headers["etag"].startswith('"')

    def test_载荷太大时不生成预览但保留材料清单(self, client: TestClient, monkeypatch):
        """把载荷上限压到 1 字节：预览不可用，材料清单照给。"""
        monkeypatch.setenv("NAYTIA_FORUM_RENDER_MAX_BYTES", "1")
        get_settings.cache_clear()
        register(client, "楼主")
        res = upload(client, fx.slab(x=2, y=2, z=2))
        assert res.status_code == 201, res.text
        st = res.json()["structure"]

        assert st["render"]["available"] is False
        assert st["render"]["version"] is None
        assert "上限" in st["render"]["reason"]
        # 材料清单与统计不受影响
        assert [m["count"] for m in st["materials"]] == [8]
        assert st["solid_cells"] == 8
        # 预览接口如实报 404 + 原因
        denied = client.get(f"/api/forum/threads/{res.json()['id']}/structure/render")
        assert denied.status_code == 404
        assert denied.json()["detail"]["code"] == "render_unavailable"

    def test_全空结构也能出载荷(self, client: TestClient):
        """调色板里全是空气：载荷合法但没有任何格子，前端据此显示空状态。"""
        register(client, "楼主")
        thread_id = upload(client, fx.big_palette(1, last_name="minecraft:air")).json()["id"]
        payload = decode_payload(client, thread_id)
        assert payload["solid_count"] == 0
        assert solid_cells(payload) == {}


class TestMultiMaterialStructure:
    """小屋夹具：多材质 + 有内部空腔，材料清单与外壳统计的联合验证。

    期望值来自 `fixtures.HOUSE_COUNTS`（人工构造时就算好的），不是从实现反推。
    """

    def test_材料清单按数量降序且比例相加为1(self, client: TestClient):
        register(client, "楼主")
        st = upload(client, fx.house()).json()["structure"]

        assert st["size"] == {"x": 7, "y": 5, "z": 7}
        assert st["voxel_count"] == 245
        rows = {m["name"]: m for m in st["materials"]}
        assert {name: row["count"] for name, row in rows.items()} == fx.HOUSE_COUNTS
        # 降序：木板 113 > 石头 49 > 玻璃 8
        assert [m["name"] for m in st["materials"]] == [
            fx.HOUSE_PLANKS,
            fx.HOUSE_STONE,
            fx.HOUSE_GLASS,
        ]
        assert sum(m["ratio"] for m in st["materials"]) == pytest.approx(1.0)
        assert st["materials_total"] == 3
        assert st["materials_truncated"] is False

    def test_室内空气不进清单也不进预览(self, client: TestClient):
        register(client, "楼主")
        st = upload(client, fx.house()).json()["structure"]
        # 室内是 5×5 的洞，共 3 层 = 75 格空气
        assert st["air_cells"] == 75
        assert st["air_blocks"] == 75
        # 有实心方块的格子 = 245 - 75
        assert st["solid_cells"] == 170
        assert st["placed_blocks"] == 245

    def test_预览载荷覆盖全部实心格子(self, client: TestClient):
        register(client, "楼主")
        thread_id = upload(client, fx.house()).json()["id"]
        payload = decode_payload(client, thread_id)
        assert payload["solid_count"] == 170
        cells = solid_cells(payload)
        assert len(cells) == 170

        # 地板：y=0 整层 49 格都是石头（调色板 0）
        floor = [index for index, value in cells.items() if value == 0]
        assert len(floor) == 49
        assert all(indexToPositionY(payload["size"], index) == 0 for index in floor)

        # 玻璃窗：8 格，都在 y=2，且在四面墙的中段
        glass = [index for index, value in cells.items() if value == 2]
        assert len(glass) == 8
        assert all(indexToPositionY(payload["size"], index) == 2 for index in glass)

        # 屋顶：y=4 整层 49 格都是木板
        roof = [
            index
            for index, value in cells.items()
            if value == 1 and indexToPositionY(payload["size"], index) == 4
        ]
        assert len(roof) == 49


class TestDownload:
    def test_下载字节与原文件一致(self, client: TestClient):
        register(client, "楼主")
        data = fx.rich()
        thread_id = upload(client, data).json()["id"]
        res = client.get(f"/api/forum/threads/{thread_id}/structure/file")
        assert res.status_code == 200
        assert res.content == data
        assert res.headers["content-type"] == "application/octet-stream"
        assert res.headers["x-content-type-options"] == "nosniff"
        # 中文文件名要能正确还原（filename* 走 RFC 5987）
        assert "filename*=UTF-8''" in res.headers["content-disposition"]
        assert res.headers["etag"].strip('"') == hashlib.sha256(data).hexdigest()

    def test_未登录也能下载(self, client: TestClient):
        register(client, "楼主")
        thread_id = upload(client, fx.slab(x=1, y=1, z=1)).json()["id"]
        client.post("/api/auth/logout")
        assert client.get(
            f"/api/forum/threads/{thread_id}/structure/file"
        ).status_code == 200

    def test_删除后的帖子下载返回404(self, client: TestClient):
        register(client, "楼主")
        thread_id = upload(client, fx.slab(x=1, y=1, z=1)).json()["id"]
        assert client.delete(f"/api/forum/threads/{thread_id}").status_code == 204
        assert client.get(
            f"/api/forum/threads/{thread_id}/structure/file"
        ).status_code == 404


class TestStorageLifecycle:
    def test_相同内容不重复占盘(self, client: TestClient):
        """内容寻址：同一个结构被两个帖子带上时，磁盘上只应有一份文件。"""
        register(client, "楼主")
        data = fx.slab(x=2, y=2, z=2)
        first = upload(client, data, title="第一份").json()["structure"]
        second = upload(client, data, title="第二份").json()["structure"]
        assert first["sha256"] == second["sha256"]

        root = get_settings().forum_storage_dir
        blobs = list(root.rglob("*.mcstructure"))
        renders = list(root.rglob("*.render.json.gz"))
        assert len(blobs) == 1
        assert len(renders) == 1

    def test_删掉其中一个帖子不影响另一个(self, client: TestClient):
        register(client, "楼主")
        data = fx.slab(x=2, y=2, z=2)
        first = upload(client, data, title="第一份").json()["id"]
        second = upload(client, data, title="第二份").json()["id"]
        assert client.delete(f"/api/forum/threads/{first}").status_code == 204
        # 另一个帖子仍然能下载与预览——这是内容寻址最容易踩的坑
        assert client.get(
            f"/api/forum/threads/{second}/structure/file"
        ).status_code == 200
        assert client.get(
            f"/api/forum/threads/{second}/structure/render"
        ).status_code == 200

    def test_删掉最后一个引用时清理磁盘(self, client: TestClient):
        register(client, "楼主")
        data = fx.slab(x=2, y=2, z=2)
        thread_id = upload(client, data).json()["id"]
        root = get_settings().forum_storage_dir
        assert list(root.rglob("*.mcstructure"))

        assert client.delete(f"/api/forum/threads/{thread_id}").status_code == 204
        assert list(root.rglob("*.mcstructure")) == []
        assert list(root.rglob("*.render.json.gz")) == []

    def test_摘要解析失败不产生残留文件(self, client: TestClient):
        register(client, "楼主")
        root = get_settings().forum_storage_dir
        res = upload(client, b"\x00" * 4096)
        assert res.status_code == 400
        assert list(root.rglob("*")) == []


class TestDiscussion:
    def test_带结构的帖子可以正常回复(self, client: TestClient):
        register(client, "楼主")
        thread_id = upload(client, fx.slab(x=2, y=2, z=2)).json()["id"]
        res = client.post(
            f"/api/forum/threads/{thread_id}/replies", json={"body": "这个结构真不错。"}
        )
        assert res.status_code == 201
        detail = client.get(f"/api/forum/threads/{thread_id}").json()
        assert detail["reply_count"] == 1
        # 有回复之后结构摘要仍然完整
        assert detail["structure"]["solid_cells"] == 8
        assert detail["has_structure"] is True


class TestTimestamps:
    """回归：所有对外时间必须带 UTC 标记。

    发现经过：浏览器端到端验证时，**刚发的帖子显示成「8 小时前」**。
    根因是 SQLite 不保存时区——刚写入时对象是 tz-aware 的（序列化带 Z），
    重新查一次走的是「字符串读回」路径，tzinfo 没了，接口吐出
    `2026-09-16T13:01:51.626175` 这种没有 Z 的串，浏览器按**本地时间**解析，
    于是在东八区差了 8 小时。

    这类 bug 不会报错、也不影响排序，只会让人看到错误的时间，
    所以必须在契约层锁死。
    """

    def test_创建与列表两条路径都带UTC标记(self, client: TestClient):
        register(client, "楼主")
        created = upload(client, fx.slab(x=1, y=1, z=1), title="时间戳帖子").json()

        # 创建响应来自内存对象（tz-aware）
        assert has_utc_marker(created["created_at"]), created["created_at"]
        assert has_utc_marker(created["structure"]["created_at"])

        # 列表与详情走 SQLite 读回路径，这里才是真正出问题的地方
        listed = client.get("/api/forum/threads").json()["items"][0]
        assert has_utc_marker(listed["created_at"]), listed["created_at"]
        assert has_utc_marker(listed["last_activity_at"]), listed["last_activity_at"]

        detail = client.get(f"/api/forum/threads/{created['id']}").json()
        assert has_utc_marker(detail["created_at"])
        assert has_utc_marker(detail["structure"]["created_at"])

    def test_回复时间同样带UTC标记(self, client: TestClient):
        register(client, "楼主")
        thread_id = upload(client, fx.slab(x=1, y=1, z=1)).json()["id"]
        client.post(f"/api/forum/threads/{thread_id}/replies", json={"body": "回一条。"})
        detail = client.get(f"/api/forum/threads/{thread_id}").json()
        assert has_utc_marker(detail["replies"][0]["created_at"])


# ---------------------------------------------------------------- 辅助

def has_utc_marker(value: str) -> bool:
    """ISO 串必须能明确表达 UTC：以 Z 结尾或带 +00:00 偏移。"""
    return value.endswith("Z") or value.endswith("+00:00")


def indexToPositionY(size: dict, index: int) -> int:
    """位置下标 -> Y 坐标（ZYX 顺序：index = x*(sy*sz) + y*sz + z）。"""
    return (index % (size["y"] * size["z"])) // size["z"]
