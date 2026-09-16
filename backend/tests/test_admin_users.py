"""账号管理接口：超管搜索账号、授予/收回管理员（ADR-009）。

对应界面 `/admin/users/`（前端 `src/modules/admin-users/`）。
这里守的是权限边界：搜索只对超管开放、管理员开关不接受 superadmin、
自己与最后一个超管都不能被降级。
"""
from fastapi.testclient import TestClient

from tests.conftest import login, logout, register, make_staff


def _superadmin(client: TestClient) -> None:
    """首个注册账号即超管（ADR-002 引导规则）。"""
    assert register(client, "站长").json()["role"] == "superadmin"


def _add_member(client: TestClient, username: str) -> int:
    logout(client)
    res = register(client, username)
    assert res.status_code == 201, res.text
    return res.json()["id"]


def _as_superadmin(client: TestClient) -> None:
    logout(client)
    login(client, "站长")


def _roles(client: TestClient) -> dict[str, str]:
    rows = client.get("/api/admin/accounts").json()
    return {row["username"]: row["role"] for row in rows}


# --------------------------------------------------------------- 搜索

def test_search_matches_username_substring(client: TestClient):
    _superadmin(client)
    _add_member(client, "帕芙洛")
    _add_member(client, "帕芙洛的粉丝")
    _add_member(client, "路人甲")
    _as_superadmin(client)

    names = [row["username"] for row in client.get("/api/admin/accounts?q=帕芙洛").json()]
    assert names == ["帕芙洛", "帕芙洛的粉丝"]


def test_search_is_case_insensitive_and_ascii_only_word(client: TestClient):
    _superadmin(client)
    _add_member(client, "Naytia")
    _as_superadmin(client)

    assert [r["username"] for r in client.get("/api/admin/accounts?q=nayt").json()] == ["Naytia"]
    assert [r["username"] for r in client.get("/api/admin/accounts?q=NAYTIA").json()] == ["Naytia"]


def test_search_without_match_returns_empty_list(client: TestClient):
    _superadmin(client)
    _add_member(client, "路人甲")
    _as_superadmin(client)

    assert client.get("/api/admin/accounts?q=不存在的人").json() == []


def test_search_does_not_treat_wildcards_as_pattern(client: TestClient):
    """`_` 与 `%` 是 LIKE 的通配符，必须被转义。

    不转义的话搜一个下划线会把**所有**账号都返回（`_` 匹配任意单字符），
    管理界面里就成了「搜什么都有」，看起来像搜索结果错了。
    """
    _superadmin(client)
    _add_member(client, "a_b")
    _add_member(client, "axb")
    _as_superadmin(client)

    assert [r["username"] for r in client.get("/api/admin/accounts?q=_").json()] == ["a_b"]
    assert client.get("/api/admin/accounts?q=%").json() == []


def test_empty_query_lists_everyone_in_id_order(client: TestClient):
    """不传 q 时语义不变（前端靠它做「清空搜索」），注册最早的排在最前。"""
    _superadmin(client)
    _add_member(client, "路人甲")
    _as_superadmin(client)

    rows = client.get("/api/admin/accounts").json()
    assert [r["username"] for r in rows] == ["站长", "路人甲"]
    assert rows[0]["role"] == "superadmin"


def test_search_is_superadmin_only(client: TestClient):
    assert client.get("/api/admin/accounts?q=站").status_code == 401

    _superadmin(client)
    logout(client)
    register(client, "路人甲")
    assert client.get("/api/admin/accounts?q=站").status_code == 403

    # 管理员同样不行：账号管理是超管的能力，不是审核能力
    make_staff(client, "admin")
    assert client.get("/api/admin/accounts?q=站").status_code == 403


# --------------------------------------------------------------- 授予 / 收回

def test_grant_and_revoke_admin(client: TestClient):
    _superadmin(client)
    member_id = _add_member(client, "路人甲")
    _as_superadmin(client)

    granted = client.put(f"/api/admin/accounts/{member_id}/admin", json={"enabled": True})
    assert granted.status_code == 200
    assert granted.json()["role"] == "admin"
    assert _roles(client)["路人甲"] == "admin"

    revoked = client.put(f"/api/admin/accounts/{member_id}/admin", json={"enabled": False})
    assert revoked.status_code == 200
    assert revoked.json()["role"] == "member"


def test_granted_admin_can_moderate(client: TestClient):
    """提权的实际效果：能删别人的帖子（与 /role 接口同一条效用路径）。"""
    _superadmin(client)
    thread_id = client.post(
        "/api/forum/threads",
        json={"title": "站长的帖子", "category": "机制研究", "body": "正文内容。"},
    ).json()["id"]

    member_id = _add_member(client, "路人甲")
    _as_superadmin(client)
    client.put(f"/api/admin/accounts/{member_id}/admin", json={"enabled": True})

    logout(client)
    login(client, "路人甲")
    assert client.delete(f"/api/forum/threads/{thread_id}").status_code == 204


def test_toggle_is_superadmin_only(client: TestClient):
    _superadmin(client)
    member_id = _add_member(client, "路人甲")
    _as_superadmin(client)

    logout(client)
    login(client, "路人甲")
    res = client.put(f"/api/admin/accounts/{member_id}/admin", json={"enabled": True})
    assert res.status_code == 403


def test_cannot_revoke_own_admin(client: TestClient):
    """超管不能把自己降级：降完就没有人能再提权（邀请码只在注册时生效）。"""
    _superadmin(client)
    own_id = client.get("/api/auth/me").json()["id"]

    res = client.put(f"/api/admin/accounts/{own_id}/admin", json={"enabled": False})
    assert res.status_code == 400
    assert res.json()["detail"]["code"] == "self_role_change"
    assert _roles(client)["站长"] == "superadmin"


def test_toggle_does_not_touch_superadmin_tier(client: TestClient):
    """这条路径只映射到 admin / member 两档，不能把别人提成超管。

    超管档位只能由引导规则或注册邀请码产生——一个「给不给管理员」的开关
    不该顺手拥有提超管的能力（同理，它也不能把超管降下来）。
    """
    _superadmin(client)
    member_id = _add_member(client, "路人甲")
    _as_superadmin(client)

    client.put(f"/api/admin/accounts/{member_id}/admin", json={"enabled": True})
    assert _roles(client)["路人甲"] == "admin"

    # 对一个已经是超管的账号取消管理员：角色保持 superadmin，不会被降成 member
    own_id = client.get("/api/auth/me").json()["id"]
    res = client.put(f"/api/admin/accounts/{own_id}/admin", json={"enabled": False})
    assert res.status_code == 400  # 先撞上「不能改自己」
    assert _roles(client)["站长"] == "superadmin"


def test_toggle_unknown_account_is_404(client: TestClient):
    _superadmin(client)
    res = client.put("/api/admin/accounts/9999/admin", json={"enabled": True})
    assert res.status_code == 404
    assert res.json()["detail"]["code"] == "account_not_found"


def test_toggle_requires_real_boolean(client: TestClient):
    """`enabled` 必须是真正的布尔。

    字符串 `"false"` 在 Python 里是真值：若让 pydantic 做宽松转换，
    `/admin` 会收到 `"false"` 却把 `enabled` 当成 True——即「取消管理员」
    变成「设为管理员」。所以这里用 strict=True 让它在契约层就失败。
    """
    _superadmin(client)
    member_id = _add_member(client, "路人甲")
    _as_superadmin(client)

    for bad in ("false", "true", 0, 1, None):
        res = client.put(f"/api/admin/accounts/{member_id}/admin", json={"enabled": bad})
        assert res.status_code == 422, bad
    assert _roles(client)["路人甲"] == "member"  # 一次都没有被改动


# --------------------------------------------------------------- 最后一个超管

def test_superadmin_cannot_demote_self_at_all(client: TestClient):
    """超管不能通过任何路径把自己从超管档位拿下来。

    这条规则**同时**就是「最后一个超管」保护：`_writable_target` 先拦住「改自己」，
    所以场上永远至少留着一个超管（admin.py 里 `_superadmin_count` 那道判断是同一件事
    的第二层兜底，只有将来放开「超管可以改自己」时才会真正被走到）。

    不这么设计的话有个真实的死局：降完自己就没有人能再提权了——邀请码只在**注册**
    时生效，站上没有任何「自助恢复超管」的入口。
    """
    _superadmin(client)
    own_id = client.get("/api/auth/me").json()["id"]

    for role in ("member", "admin"):
        res = client.put(f"/api/admin/accounts/{own_id}/role", json={"role": role})
        assert res.status_code == 400, role
        assert res.json()["detail"]["code"] == "self_role_change"
    assert _roles(client)["站长"] == "superadmin"


def test_admin_toggle_leaves_superadmin_tier_alone(client: TestClient):
    """`/admin` 这条路径只映射 admin ↔ member：既不提超管，也不降超管。

    超管档位只能由引导规则或注册邀请码产生——一个「给不给管理员」的开关
    不该顺手拥有提超管的能力。
    """
    _superadmin(client)
    member_id = _add_member(client, "路人甲")
    second = _add_member(client, "助理")
    _as_superadmin(client)
    assert client.put(f"/api/admin/accounts/{second}/role",
                      json={"role": "superadmin"}).status_code == 200

    # 普通会员「设为管理员」只到 admin，永远到不了 superadmin
    assert client.put(f"/api/admin/accounts/{member_id}/admin",
                      json={"enabled": True}).json()["role"] == "admin"
    assert _roles(client)["路人甲"] == "admin"

    # 对已是超管的账号「取消管理员」→ 拒绝，而不是把它降成 member
    res = client.put(f"/api/admin/accounts/{second}/admin", json={"enabled": False})
    assert res.status_code == 400
    assert res.json()["detail"]["code"] == "is_superadmin"
    assert _roles(client)["助理"] == "superadmin"


def test_another_superadmin_may_demote_a_superadmin(client: TestClient):
    """有人在场时，超管可以被别人降级——守卫按「会不会把最后一个拿掉」判断，
    而不是一律禁止碰超管。"""
    _superadmin(client)
    second = _add_member(client, "助理")
    _as_superadmin(client)
    assert client.put(f"/api/admin/accounts/{second}/role",
                      json={"role": "superadmin"}).status_code == 200

    logout(client)
    login(client, "助理")
    boss_id = client.get("/api/admin/accounts").json()[0]["id"]
    res = client.put(f"/api/admin/accounts/{boss_id}/role", json={"role": "admin"})
    assert res.status_code == 200
    assert _roles(client)["站长"] == "admin"
    assert _roles(client)["助理"] == "superadmin"
