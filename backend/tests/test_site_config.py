"""站点配置 API（ADR-002）：公开读、超管写、覆盖项浅合并、URL 协议校验。"""
from fastapi.testclient import TestClient

from tests.conftest import register


def test_get_site_config_public_and_empty(client: TestClient):
    res = client.get("/api/site-config")
    assert res.status_code == 200
    assert res.json() == {"overrides": {}, "updated_at": None}


def test_superadmin_put_and_merge(client: TestClient):
    register(client, "站长")
    res = client.put("/api/site-config", json={
        "display_name": "帕芙洛 2.0",
        "avatar_url": "https://cdn.example.com/avatar.gif",
        "background": {"mode": "image",
                       "url": "https://cdn.example.com/bg.gif",
                       "overlay": 0.4},
    })
    assert res.status_code == 200
    overrides = res.json()["overrides"]
    assert overrides["display_name"] == "帕芙洛 2.0"

    # 浅合并：第二次只改 intro，不影响其他字段
    res2 = client.put("/api/site-config", json={"intro": "新的介绍文字。"})
    got = res2.json()["overrides"]
    assert got["intro"] == "新的介绍文字。"
    assert got["avatar_url"] == "https://cdn.example.com/avatar.gif"
    assert got["background"]["url"] == "https://cdn.example.com/bg.gif"

    # 未登录也能读到覆盖项
    client.post("/api/auth/logout")
    public = client.get("/api/site-config").json()["overrides"]
    assert public["display_name"] == "帕芙洛 2.0"


def test_site_config_rejects_non_http_url(client: TestClient):
    register(client, "站长")
    res = client.put("/api/site-config", json={"avatar_url": "javascript:alert(1)"})
    assert res.status_code == 422
    res2 = client.put("/api/site-config", json={
        "background": {"mode": "image", "url": "data:image/gif;base64,xxxx"}})
    assert res2.status_code == 422


def test_site_config_background_none_mode(client: TestClient):
    register(client, "站长")
    res = client.put("/api/site-config", json={"background": {"mode": "none"}})
    assert res.status_code == 200
    assert res.json()["overrides"]["background"]["mode"] == "none"
