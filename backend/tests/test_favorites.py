"""工具箱收藏：登录门槛与按账号隔离。

工具 ID 用当前实际存在的工具（`mcstructure-editor`）。服务端对 tool_id 只做格式校验
（见 routers/favorites.py），但测试用真实 ID 更贴近实际，也能在工具改名时提醒我们更新。
"""
from fastapi.testclient import TestClient

from tests.conftest import register

TOOL = "mcstructure-editor"


def test_favorites_require_login(client: TestClient):
    assert client.get("/api/favorites").status_code == 401
    assert client.put(f"/api/favorites/{TOOL}").status_code == 401


def test_favorite_add_remove(client: TestClient):
    register(client, "玩家甲")
    assert client.put(f"/api/favorites/{TOOL}").json()["tools"] == [TOOL]
    # 重复添加不产生副本
    assert client.put(f"/api/favorites/{TOOL}").json()["tools"] == [TOOL]
    assert client.delete(f"/api/favorites/{TOOL}").json()["tools"] == []


def test_favorite_multiple_tools_keep_order(client: TestClient):
    """收藏按加入顺序返回；这里用两个 ID 验证顺序与删除语义。"""
    register(client, "玩家甲")
    client.put(f"/api/favorites/{TOOL}")
    client.put("/api/favorites/second-tool")
    assert client.get("/api/favorites").json()["tools"] == [TOOL, "second-tool"]
    assert client.delete(f"/api/favorites/{TOOL}").json()["tools"] == ["second-tool"]


def test_favorites_isolated_between_accounts(client: TestClient):
    register(client, "玩家甲")
    client.put(f"/api/favorites/{TOOL}")
    client.post("/api/auth/logout")
    register(client, "玩家乙")
    assert client.get("/api/favorites").json()["tools"] == []


def test_bad_tool_id_rejected(client: TestClient):
    register(client, "玩家甲")
    res = client.put("/api/favorites/BAD_ID!")
    assert res.status_code == 400
    assert res.json()["detail"]["code"] == "bad_tool_id"
