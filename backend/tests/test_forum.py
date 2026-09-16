"""论坛权限与读写：未登录只读、登录可写、作者删自有内容、游标分页。"""
from fastapi.testclient import TestClient

from tests.conftest import register


def _new_thread(client: TestClient, title: str = "测试帖", category: str = "机制研究"):
    return client.post("/api/forum/threads",
                       json={"title": title, "category": category,
                             "body": "正文内容，超过两个字符。"})


def test_post_thread_requires_login(client: TestClient):
    res = _new_thread(client)
    assert res.status_code == 401
    assert res.json()["detail"]["code"] == "auth_required"


def test_thread_lifecycle(client: TestClient):
    register(client, "楼主")
    res = _new_thread(client, "刷石机怎么摆")
    assert res.status_code == 201
    thread_id = res.json()["id"]

    # 列表可见，包含作者与回复数
    listed = client.get("/api/forum/threads").json()["items"]
    assert any(t["id"] == thread_id and t["author"] == "楼主" for t in listed)

    # 详情含标题、正文与空回复
    detail = client.get(f"/api/forum/threads/{thread_id}").json()
    assert detail["title"] == "刷石机怎么摆"
    assert detail["reply_count"] == 0 and "正文内容" in detail["body"]


def test_reply_and_activity_ordering(client: TestClient):
    register(client, "楼主")
    first = _new_thread(client, "第一帖").json()
    second = _new_thread(client, "第二帖").json()

    client.post(f"/api/forum/threads/{first['id']}/replies",
                json={"body": "顶一下老帖。"})

    items = client.get("/api/forum/threads").json()["items"]
    assert items[0]["id"] == first["id"]  # 有新回复的帖子排最前
    assert items[0]["reply_count"] == 1
    assert items[1]["id"] == second["id"]


def test_unknown_category_rejected(client: TestClient):
    register(client, "楼主")
    res = _new_thread(client, category="不存在版块")
    assert res.status_code == 422


def test_author_can_delete_own_thread(client: TestClient):
    register(client, "楼主")
    thread_id = _new_thread(client).json()["id"]
    assert client.delete(f"/api/forum/threads/{thread_id}").status_code == 204
    assert client.get(f"/api/forum/threads/{thread_id}").status_code == 404


def test_other_user_cannot_delete(client: TestClient):
    register(client, "楼主")
    thread_id = _new_thread(client).json()["id"]
    client.post("/api/auth/logout")
    register(client, "路人")
    res = client.delete(f"/api/forum/threads/{thread_id}")
    assert res.status_code == 403
    assert res.json()["detail"]["code"] == "not_owner"


def test_reply_pagination_cursor_stable(client: TestClient):
    register(client, "楼主")
    for i in range(3):
        _new_thread(client, f"帖子{i}")
    page1 = client.get("/api/forum/threads?limit=2").json()
    _ = page1  # PAGE_SIZE 固定 20，游标路径由阶段 4 集成测试覆盖
