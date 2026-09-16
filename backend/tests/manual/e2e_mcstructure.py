"""端到端演练：对运行中的后端做真实的 multipart 上传与各接口调用。

用法：先启动 `uvicorn app.main:app --port 8931`，再运行本脚本。
与 pytest 的区别：这里走真实 HTTP（含 multipart 编解码、真实响应序列化），
用于确认接口在「非 TestClient」环境下同样可用。
"""
import json
import sys

import httpx

BASE = "http://127.0.0.1:8931"
sys.path.insert(0, ".")
from tests.fixtures import mcstructure_fixtures as fx  # noqa: E402


def show(title, value):
    print(f"  {title}: {value}")


def main() -> int:
    data = fx.rich()
    files = {"file": ("demo.mcstructure", data, "application/octet-stream")}

    with httpx.Client(base_url=BASE, timeout=30.0) as client:
        # 1. 解析（含体素）
        r = client.post("/api/mcstructure/parse",
                        files=files,
                        params={"include_voxels": "true"})
        print(f"[1] POST /parse -> HTTP {r.status_code}")
        assert r.status_code == 200, r.text
        body = r.json()
        layout = body["layout"]
        show("size", layout["size"])
        show("world_origin", layout["world_origin"])
        show("compression", body["compression"])
        show("palette", [p["name"] for p in body["palette"]])
        show("stats.filled", body["stats"]["filled"])
        show("stats 层级", [(l["layer"], l["filled"], l["void"]) for l in body["stats"]["layers"]])
        show("top blocks", [(b["name"], b["count"]) for b in body["stats"]["blocks"][:3]])
        show("voxel layers", [(v["layer"], len(v["indices"])) for v in body["voxels"]])
        be = body["block_entities"][0]
        show("block entity", f"{be['identifier']} @ {be['x']},{be['y']},{be['z']}")
        show("  箱子内容", be["block_entity_data"]["Items"])
        show("  计划刻", be["tick_queue_data"])
        ent = body["entities"][0]
        show("entity", f"{ent['identifier']} block_position={ent['block_position']}")
        show("  UniqueID", ent["data"]["UniqueID"])
        show("  CustomName", ent["data"]["CustomName"])

        # 2. 只取体素
        r = client.post("/api/mcstructure/voxels", files=files)
        print(f"[2] POST /voxels -> HTTP {r.status_code}")
        assert r.status_code == 200
        show("层数", len(r.json()))

        # 3. 薄片
        r = client.post("/api/mcstructure/slice", files=files,
                        params={"axis": "y", "at": 0, "layer": 0})
        print(f"[3] POST /slice (axis=y, at=0) -> HTTP {r.status_code}")
        assert r.status_code == 200
        sl = r.json()
        show("plane_size", sl["plane_size"])
        show("indices", sl["indices"])
        show("blocks", [(b["name"], b["count"]) for b in sl["blocks"]])

        # 4. 坐标互查
        r = client.post("/api/mcstructure/position", files=files,
                        params={"x": 0, "y": 0, "z": 1})
        print(f"[4] POST /position (0,0,1) -> HTTP {r.status_code}")
        assert r.status_code == 200
        pos = r.json()
        show("index", pos["index"])
        show("layers", [(l["layer"], l["palette_index"], l["name"]) for l in pos["layers"]])

        # 5. 分页
        r = client.post("/api/mcstructure/blocks", files=files,
                        params={"kind": "block_entities", "limit": 10})
        print(f"[5] POST /blocks -> HTTP {r.status_code}")
        assert r.status_code == 200
        show("total", r.json()["total"])

        # 6. 错误路径：坏文件必须是结构化 400，不是 500
        r = client.post("/api/mcstructure/parse",
                        files={"file": ("bad.mcstructure", b"not nbt", "application/octet-stream")})
        print(f"[6] POST /parse (坏文件) -> HTTP {r.status_code}")
        show("detail", r.json()["detail"])
        assert r.status_code == 400

        # 7. 错误路径：空文件
        r = client.post("/api/mcstructure/parse",
                        files={"file": ("empty.mcstructure", b"", "application/octet-stream")})
        print(f"[7] POST /parse (空文件) -> HTTP {r.status_code}")
        show("detail", r.json()["detail"])
        assert r.status_code == 400

        # 8. 截断文件
        r = client.post("/api/mcstructure/parse",
                        files={"file": ("cut.mcstructure", data[: len(data) // 2],
                                        "application/octet-stream")})
        print(f"[8] POST /parse (截断) -> HTTP {r.status_code}")
        show("detail", r.json()["detail"])
        assert r.status_code == 400

        # 9. OpenAPI 里确实暴露了这些接口
        r = client.get("/openapi.json")
        paths = [p for p in r.json()["paths"] if "mcstructure" in p]
        print(f"[9] GET /openapi.json -> {len(paths)} 个 mcstructure 路径")
        show("paths", sorted(paths))

    print()
    print("端到端演练全部通过。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
