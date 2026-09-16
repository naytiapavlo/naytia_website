"""对真实 .mcstructure 文件做端到端 HTTP 演练。

用法：先启动 `uvicorn app.main:app --port 8932`，再运行本脚本。
真实夹具在 tests/fixtures/real/，见该目录 README 的来源与校验值说明。
"""
import pathlib

import httpx

BASE = "http://127.0.0.1:8932"
REAL = pathlib.Path(__file__).parent.parent / "fixtures" / "real" / "sticky-piston-1x1x1.mcstructure"


def main() -> int:
    if not REAL.exists():
        print(f"缺少真实夹具：{REAL}")
        return 1
    data = REAL.read_bytes()
    files = {"file": (REAL.name, data, "application/octet-stream")}

    with httpx.Client(base_url=BASE, timeout=30.0) as client:
        r = client.post("/api/mcstructure/parse", files=files,
                        params={"include_voxels": "true", "include_raw": "true"})
        print(f"[1] POST /parse 真实文件 -> HTTP {r.status_code}")
        assert r.status_code == 200, r.text
        b = r.json()

        layout = b["layout"]
        print(f"    size            {layout['size']}")
        print(f"    world_origin    {layout['world_origin']}")
        print(f"    origin 来源     {layout['world_origin_source']}")
        print(f"    文件字节        {b['file_bytes']}")
        print(f"    format_version  {b['format_version']}")
        print(f"    压缩            {b['compression']}")
        print(f"    调色板          {[(x['name'], x['states']) for x in b['palette']]}")
        print(f"    未建模根字段    {b['extra_root_fields']}")

        s = b["stats"]
        print(f"    统计            total={s['total_voxels']} filled={s['filled']} "
              f"primary={s['primary_filled']} secondary={s['secondary_filled']}")
        print(f"    逐层            {[(l['layer'], l['filled'], l['void']) for l in s['layers']]}")
        print(f"    方块统计        {[(x['name'], x['count']) for x in s['blocks']]}")

        be = b["block_entities"][0]
        nbt = be["block_entity_data"]
        print(f"    方块实体        {be['identifier']} 结构内坐标={be['x']},{be['y']},{be['z']}")
        print(f"      绝对坐标      {nbt['x']},{nbt['y']},{nbt['z']}  (应等于 world_origin)")
        print(f"      Sticky        {nbt['Sticky']}")
        print(f"      Progress      {nbt['Progress']} ({type(nbt['Progress']).__name__})")
        print(f"      AttachedBlocks {nbt['AttachedBlocks']}")

        print(f"    体素            {[(v['layer'], v['indices']) for v in b['voxels']]}")

        origin = (layout["world_origin"]["x"], layout["world_origin"]["y"],
                  layout["world_origin"]["z"])
        assert (nbt["x"], nbt["y"], nbt["z"]) == origin, "绝对坐标与结构原点不一致"
        print("    [OK] 方块实体绝对坐标 == 结构原点，两处读取互相印证")

        r = client.post("/api/mcstructure/position", files=files,
                        params={"x": 0, "y": 0, "z": 0})
        print(f"[2] POST /position -> HTTP {r.status_code}")
        assert r.status_code == 200
        p = r.json()
        print(f"    index={p['index']} "
              f"layers={[(l['layer'], l['palette_index'], l['name']) for l in p['layers']]}")

        r = client.post("/api/mcstructure/slice", files=files,
                        params={"axis": "y", "at": 0, "layer": 0})
        print(f"[3] POST /slice -> HTTP {r.status_code}")
        assert r.status_code == 200
        sl = r.json()
        print(f"    plane={sl['plane_size']} indices={sl['indices']} "
              f"blocks={[(x['name'], x['count']) for x in sl['blocks']]}")

        r = client.post("/api/mcstructure/blocks", files=files,
                        params={"kind": "block_entities"})
        print(f"[4] POST /blocks -> HTTP {r.status_code}")
        assert r.status_code == 200
        print(f"    total={r.json()['total']}")

    print()
    print("真实文件端到端演练全部通过。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
