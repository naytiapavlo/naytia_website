"""角色体系（ADR-002）：首个账号 bootstrap、权限矩阵、角色管理。"""
from fastapi.testclient import TestClient

from tests.conftest import register


def _logout(client: TestClient):
    client.post("/api/auth/logout")


def test_first_account_becomes_superadmin(client: TestClient):
    res = register(client, "站长")
    assert res.json()["role"] == "superadmin"


def test_second_account_is_member(client: TestClient):
    register(client, "站长")
    _logout(client)
    res = register(client, "路人")
    assert res.json()["role"] == "member"


def test_visitor_cannot_read_admin_accounts(client: TestClient):
    res = client.get("/api/admin/accounts")
    assert res.status_code == 401


def test_member_forbidden_for_site_config_write(client: TestClient):
    register(client, "站长")
    _logout(client)
    register(client, "路人")
    res = client.put("/api/site-config", json={"display_name": "被篡改"})
    assert res.status_code == 403


def test_member_cannot_change_roles(client: TestClient):
    register(client, "站长")
    _logout(client)
    register(client, "路人")
    res = client.put("/api/admin/accounts/1/role", json={"role": "admin"})
    assert res.status_code == 403


def test_superadmin_cannot_change_own_role(client: TestClient):
    res = register(client, "站长")
    own_id = res.json()["id"]
    res = client.put(f"/api/admin/accounts/{own_id}/role", json={"role": "member"})
    assert res.status_code == 400
    assert res.json()["detail"]["code"] == "self_role_change"


def test_admin_promotion_enables_moderation(client: TestClient):
    register(client, "站长")
    thread = client.post(
        "/api/forum/threads",
        json={"title": "站长的帖子", "category": "机制研究", "body": "正文内容。"},
    ).json()
    thread_id = thread["id"]

    _logout(client)
    member_id = register(client, "路人").json()["id"]
    # member 删别人的帖 → 403
    assert client.delete(f"/api/forum/threads/{thread_id}").status_code == 403

    # 超管把路人提升为 admin
    _logout(client)
    login = client.post("/api/auth/login",
                        json={"username": "站长", "password": "secret123"})
    assert login.status_code == 200
    res = client.put(f"/api/admin/accounts/{member_id}/role", json={"role": "admin"})
    assert res.status_code == 200 and res.json()["role"] == "admin"

    # admin 现在可以审核删除任何帖子
    _logout(client)
    client.post("/api/auth/login", json={"username": "路人", "password": "secret123"})
    assert client.delete(f"/api/forum/threads/{thread_id}").status_code == 204
