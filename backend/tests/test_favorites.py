"""工具箱收藏：登录门槛与按账号隔离。"""
from fastapi.testclient import TestClient

from tests.conftest import register


def test_favorites_require_login(client: TestClient):
    assert client.get("/api/favorites").status_code == 401
    assert client.put("/api/favorites/chunk-coordinates").status_code == 401


def test_favorite_add_remove(client: TestClient):
    register(client, "玩家甲")
    assert client.put("/api/favorites/chunk-coordinates").json()["tools"] == [
        "chunk-coordinates"
    ]
    client.put("/api/favorites/material-counter")
    assert client.put("/api/favorites/chunk-coordinates").json()["tools"] == [
        "chunk-coordinates",
        "material-counter",
    ]  # 重复添加不产生副本
    assert client.delete("/api/favorites/chunk-coordinates").json()["tools"] == [
        "material-counter"
    ]


def test_favorites_isolated_between_accounts(client: TestClient):
    register(client, "玩家甲")
    client.put("/api/favorites/chunk-coordinates")
    client.post("/api/auth/logout")
    register(client, "玩家乙")
    assert client.get("/api/favorites").json()["tools"] == []


def test_bad_tool_id_rejected(client: TestClient):
    register(client, "玩家甲")
    res = client.put("/api/favorites/BAD_ID!")
    assert res.status_code == 400
    assert res.json()["detail"]["code"] == "bad_tool_id"
