"""认证流程：注册、重复注册、登录、登出、会话保持。"""
from fastapi.testclient import TestClient

from tests.conftest import register


def test_register_then_me(client: TestClient):
    res = register(client, "小明")
    assert res.status_code == 201
    assert res.json()["username"] == "小明"
    me = client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json()["username"] == "小明"


def test_register_duplicate_rejected(client: TestClient):
    register(client, "tester")
    client.post("/api/auth/logout")
    res = register(client, "TESTER")  # 大小写不敏感判重
    assert res.status_code == 409
    assert res.json()["detail"]["code"] == "username_taken"


def test_register_invalid_username(client: TestClient):
    res = register(client, "a")  # 少于 2 位
    assert res.status_code == 422


def test_login_wrong_password(client: TestClient):
    register(client, "tester", "secret123")
    client.post("/api/auth/logout")
    res = client.post("/api/auth/login",
                      json={"username": "tester", "password": "wrong!"})
    assert res.status_code == 401
    assert res.json()["detail"]["code"] == "bad_credentials"


def test_login_logout_flow(client: TestClient):
    register(client, "tester", "secret123")
    client.post("/api/auth/logout")
    assert client.get("/api/auth/me").json() is None
    res = client.post("/api/auth/login",
                      json={"username": "tester", "password": "secret123"})
    assert res.status_code == 200
    assert client.get("/api/auth/me").json()["username"] == "tester"


def test_short_password_rejected_at_login(client: TestClient):
    register(client, "tester", "secret123")
    client.post("/api/auth/logout")
    res = client.post("/api/auth/login", json={"username": "tester", "password": "abc"})
    assert res.status_code == 401
