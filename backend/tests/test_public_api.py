"""开放工具 API（v1）对照测试。

数值样例与前端 tests/tools.test.ts 的边界用例一致（-17/-16/-1/0/15/16 等），
保证「同一规则集、同一输入 → 两端同一结果」的移植契约。
"""
import pytest
from fastapi.testclient import TestClient

from tests.conftest import register


@pytest.fixture(autouse=True)
def _reset_rate_limiter():
    from app.public_api.ratelimit import rate_limiter

    rate_limiter.reset()
    yield
    rate_limiter.reset()


def _run(client: TestClient, tool_id: str, tool_input: dict, **kwargs):
    return client.post(f"/api/v1/tools/{tool_id}/run",
                       json={"input": tool_input, **kwargs})


def test_catalog_lists_stable_tools(client: TestClient):
    res = client.get("/api/v1/tools")
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    ids = {t["id"] for t in body["data"]["tools"]}
    assert {"chunk-coordinates", "material-counter"} <= ids


def test_tool_detail_contains_schema_and_examples(client: TestClient):
    res = client.get("/api/v1/tools/chunk-coordinates")
    assert res.status_code == 200
    data = res.json()["data"]
    assert data["input_schema"]["properties"]["x"]["minimum"] == -29_999_999
    assert data["examples"] and "input" in data["examples"][0]
    assert data["run"]["path"] == "/api/v1/tools/chunk-coordinates/run"


def test_unknown_tool_404_envelope(client: TestClient):
    res = client.get("/api/v1/tools/no-such-tool")
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "tool_not_found"


def test_chunk_negative_floor_parity(client: TestClient):
    """-17 → 区块 -2、区块内 15；-1 → 区块 -1（floor 语义，非截断）。"""
    res = _run(client, "chunk-coordinates", {"x": -17, "z": -1})
    assert res.status_code == 200
    data = res.json()["data"]
    assert data["chunk"] == {"x": -2, "z": -1}
    assert data["offset"] == {"x": 15, "z": 15}
    assert data["chunkOrigin"] == {"x": -32, "z": -16}
    assert res.json()["meta"]["ruleset_id"] == "chunk-16-v1"


def test_chunk_boundary_cases(client: TestClient):
    cases = {
        (-16, 0): {"chunk": {"x": -1, "z": 0}, "offset": {"x": 0, "z": 0}},
        (15, 16): {"chunk": {"x": 0, "z": 1}, "offset": {"x": 15, "z": 0}},
    }
    for (x, z), expected in cases.items():
        res = _run(client, "chunk-coordinates", {"x": x, "z": z})
        assert res.status_code == 200
        data = res.json()["data"]
        assert data["chunk"] == expected["chunk"]
        assert data["offset"] == expected["offset"]


def test_chunk_region_and_boundary_warning(client: TestClient):
    res = _run(client, "chunk-coordinates", {"x": -17, "z": -16})
    data = res.json()["data"]
    assert data["region"] == {"x": -1, "z": -1, "localIndex": 1022}
    assert any("区块边界" in w for w in res.json()["warnings"])  # z=16 → offset 0


def test_chunk_nether_conversion(client: TestClient):
    res = _run(client, "chunk-coordinates", {"x": 800, "z": -1600, "dimension": "overworld"})
    related = res.json()["data"]["related"]
    assert related[0]["label"] == "主世界 → 下界"
    assert related[0]["x"] == 100 and related[0]["z"] == -200


def test_chunk_invalid_dimension_rejected(client: TestClient):
    res = _run(client, "chunk-coordinates", {"x": 0, "z": 0, "dimension": "moon"})
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "invalid_dimension"


def test_chunk_out_of_range(client: TestClient):
    res = _run(client, "chunk-coordinates", {"x": 30_000_000, "z": 0})
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "out_of_range"
    assert res.json()["error"]["field"] == "x"


def test_material_mixed_stacks_and_container(client: TestClient):
    res = _run(client, "material-counter", {
        "entries": [
            {"name": "石子", "count": 64, "stackSize": 64},
            {"name": "木头", "count": 65, "stackSize": 64},
            {"name": "工具", "count": 3, "stackSize": 1},
        ],
        "containerSlots": 27,
        "containerLabel": "潜影盒",
    })
    assert res.status_code == 200
    data = res.json()["data"]
    assert data["lines"][1] == {
        "name": "木头", "count": 65, "stackSize": 64,
        "fullStacks": 1, "remainder": 1, "slots": 2,
    }
    assert data["totals"] == {"kinds": 3, "count": 132, "fullStacks": 5, "slots": 6}
    assert data["container"] == {
        "label": "潜影盒", "slots": 27, "need": 1,
        "capacity": 27, "spare": 21, "exact": False,
    }
    assert any("堆叠上限为 1" in w for w in res.json()["warnings"])


def test_material_empty_and_zero_rows_skipped(client: TestClient):
    res = _run(client, "material-counter", {
        "entries": [{"name": "a", "count": ""}, {"name": "b", "count": 0}]
    })
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "empty_list"


def test_material_too_many_entries(client: TestClient):
    res = _run(client, "material-counter", {
        "entries": [{"name": f"m{i}", "count": 1} for i in range(41)]
    })
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "too_many_entries"


def test_ruleset_pinning(client: TestClient):
    ok_res = _run(client, "chunk-coordinates", {"x": 1, "z": 1},
                  ruleset_id="chunk-16-v1")
    assert ok_res.status_code == 200
    bad_res = _run(client, "chunk-coordinates", {"x": 1, "z": 1},
                   ruleset_id="chunk-16-v0")
    assert bad_res.status_code == 400
    assert bad_res.json()["error"]["code"] == "unsupported_ruleset"


def test_rate_limit_anonymous_30_per_minute(client: TestClient):
    for _ in range(30):
        res = _run(client, "chunk-coordinates", {"x": 1, "z": 1})
        assert res.status_code == 200
    res = _run(client, "chunk-coordinates", {"x": 1, "z": 1})
    assert res.status_code == 429
    assert res.json()["error"]["code"] == "rate_limited"
    assert "retry-after" in {k.lower() for k in res.headers}


def test_api_key_higher_tier(client: TestClient):
    register(client, "站长")  # 首个账号 = 超管
    created = client.post("/api/admin/api-keys", json={"name": "外部开发者"})
    assert created.status_code == 201
    key = created.json()["data"]["key"]
    assert key.startswith("nk_")

    headers = {"Authorization": f"Bearer {key}"}
    res = client.post("/api/v1/tools/chunk-coordinates/run",
                      json={"input": {"x": 1, "z": 1}}, headers=headers)
    assert res.status_code == 200
    assert res.headers["X-RateLimit-Limit"] == "300"

    # 列表不泄露明文；密钥可被停用
    listed = client.get("/api/admin/api-keys").json()["data"]["keys"]
    assert listed and "key" not in listed[0]
    key_id = listed[0]["id"]
    client.delete(f"/api/admin/api-keys/{key_id}")
    res = client.post("/api/v1/tools/chunk-coordinates/run",
                      json={"input": {"x": 1, "z": 1}}, headers=headers)
    assert res.status_code == 403
    assert res.json()["error"]["code"] == "api_key_disabled"


def test_bad_api_key_rejected(client: TestClient):
    res = client.post("/api/v1/tools/chunk-coordinates/run",
                      json={"input": {"x": 1, "z": 1}},
                      headers={"Authorization": "Bearer nk_wrong"})
    assert res.status_code == 401
    assert res.json()["error"]["code"] == "invalid_api_key"
