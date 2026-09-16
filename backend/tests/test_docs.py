"""文档树（docs 模块）：公开读取门槛、管理员提交、超管审核发布。

覆盖的关键规则（开发日志 docs/plans/09）：
- 访客只读已发布 + visibility=public 的内容；草稿、会员/员工限定内容不可见。
- admin 能上传与提交，但**不能**自己发布：提交单在超管批准前不进目录树。
- 超管审核通过即发布；驳回不改动线上内容；批准时目标冲突则转成 rejected。
- 只收文本类型；分片上传要校验连续性、大小与声明值。
- 草稿文件的下载走同一套可见性判定（否则等于开了后门）。
"""
from fastapi.testclient import TestClient

from tests.conftest import login, logout, make_staff, register


def _bootstrap(client: TestClient) -> None:
    """首个注册账号自动成为 superadmin（ADR-002）。"""
    assert register(client, "站长").json()["role"] == "superadmin"
    logout(client)


def _upload(client: TestClient, name: str, content: str) -> dict:
    res = client.post(
        "/api/docs/uploads/direct",
        files={"file": (name, content.encode("utf-8"), "text/plain")},
    )
    assert res.status_code == 200, res.text
    return res.json()


def _submit(client: TestClient, **payload) -> dict:
    res = client.post("/api/docs/submissions", json=payload)
    assert res.status_code == 201, res.text
    return res.json()


def _approve(client: TestClient, submission_id: int) -> dict:
    res = client.post(f"/api/docs/review/{submission_id}?decision=approve")
    assert res.status_code == 200, res.text
    return res.json()


def _publish_document(client: TestClient, title: str, body: str, **extra) -> int:
    """管理员上传 + 提交，超管批准，返回文档 id。用最少的来回搭出已发布内容。"""
    uploaded = _upload(client, f"{title}.md", body)
    submission = _submit(client, action="create_doc", title=title,
                         file_id=uploaded["file"]["id"], **extra)
    logout(client)
    login(client, "站长")
    approved = _approve(client, submission["id"])
    assert approved["status"] == "approved", approved
    return int(approved["applied_document_id"])


# ----------------------------------------------------------------- 访客与会员

def test_visitor_sees_empty_tree(client: TestClient) -> None:
    _bootstrap(client)
    res = client.get("/api/docs/tree")
    assert res.status_code == 200
    body = res.json()
    assert body["root"]["documents"] == []
    assert body["viewer_role"] is None
    assert body["stats"]["documents"] == 0


def test_visitor_cannot_upload_or_submit(client: TestClient) -> None:
    _bootstrap(client)
    res = client.post(
        "/api/docs/uploads/direct",
        files={"file": ("a.md", b"# hi", "text/plain")},
    )
    assert res.status_code == 401
    assert res.json()["detail"]["code"] == "auth_required"
    res = client.post("/api/docs/submissions", json={"action": "create_folder", "name": "x"})
    assert res.status_code == 401


def test_member_reads_public_but_cannot_upload(client: TestClient) -> None:
    _bootstrap(client)
    make_staff(client)
    doc_id = _publish_document(client, "公开笔记", "会员和访客都能读这段")
    logout(client)

    # 访客（未登录）先确认能读到
    assert client.get(f"/api/docs/documents/{doc_id}").json()["body"] == "会员和访客都能读这段"

    register(client, "路人")
    assert client.get(f"/api/docs/documents/{doc_id}").json()["body"] == "会员和访客都能读这段"
    res = client.post(
        "/api/docs/uploads/direct",
        files={"file": ("a.md", b"# hi", "text/plain")},
    )
    assert res.status_code == 403
    assert res.json()["detail"]["code"] == "forbidden"
    perms = client.get("/api/docs/permissions").json()
    assert perms["role"] == "member"
    assert perms["can_upload"] is False and perms["can_review"] is False


def test_info_is_public(client: TestClient) -> None:
    _bootstrap(client)
    body = client.get("/api/docs/info").json()
    assert ".md" in body["allowed_extensions"]
    assert ".json" in body["allowed_extensions"] and ".txt" in body["allowed_extensions"]
    assert body["review_required"] is True
    assert body["max_bytes"] > 0


# ----------------------------------------------------------------- 管理员提交

def test_admin_folder_submission_waits_for_review(client: TestClient) -> None:
    _bootstrap(client)
    make_staff(client)

    created = _submit(client, action="create_folder", name="漏洞bug分析", note="首版目录")
    assert created["status"] == "pending"
    assert created["submitted_by_name"] == "临时管理员"

    # 管理员看到的线上目录树里还没有这个文件夹（草稿只在管理面板里）
    assert client.get("/api/docs/tree").json()["root"]["children"] == []

    logout(client)
    assert client.get("/api/docs/tree").json()["root"]["children"] == []

    login(client, "站长")
    result = _approve(client, created["id"])
    assert result["status"] == "approved"
    tree = client.get("/api/docs/tree").json()
    assert [node["name"] for node in tree["root"]["children"]] == ["漏洞bug分析"]
    assert tree["root"]["children"][0]["path"] == "漏洞bug分析"

    logout(client)
    assert client.get("/api/docs/tree").json()["stats"]["folders"] == 1


def test_admin_document_submission_publishes_body(client: TestClient) -> None:
    _bootstrap(client)
    make_staff(client)
    uploaded = _upload(client, "01_速查卡.md", "# 速查卡\n\n二十条核心事实。\n")
    assert uploaded["doc_format"] == "md"
    assert uploaded["text_content"].startswith("# 速查卡")

    submission = _submit(
        client,
        action="create_doc",
        title="01 速查卡",
        summary="二十条核心事实",
        file_id=uploaded["file"]["id"],
    )
    logout(client)
    assert client.get("/api/docs/tree").json()["stats"]["documents"] == 0

    login(client, "站长")
    approved = _approve(client, submission["id"])
    doc_id = approved["applied_document_id"]
    detail = client.get(f"/api/docs/documents/{doc_id}").json()
    assert detail["title"] == "01 速查卡"
    assert "二十条核心事实" in detail["body"]
    assert detail["revision_no"] == 1
    assert detail["published"] is True

    logout(client)
    assert client.get(f"/api/docs/documents/{doc_id}").json()["body"].startswith("# 速查卡")
    hits = client.get("/api/docs/search", params={"q": "核心事实"}).json()
    assert hits["total"] == 1 and hits["hits"][0]["id"] == doc_id
    download = client.get(f"/api/docs/files/{detail['file']['id']}/download")
    assert download.status_code == 200
    assert "attachment" in download.headers["content-disposition"]
    assert download.content == "# 速查卡\n\n二十条核心事实。\n".encode("utf-8")


def test_document_in_folder_appears_under_it(client: TestClient) -> None:
    _bootstrap(client)
    make_staff(client)
    folder = _submit(client, action="create_folder", name="代码机制分析")
    logout(client)
    login(client, "站长")
    assert _approve(client, folder["id"])["status"] == "approved"

    folder_id = client.get("/api/docs/tree").json()["root"]["children"][0]["id"]
    logout(client)
    login(client, "临时管理员")
    uploaded = _upload(client, "13_发布与邻域推进规则.md", "邻域推进规则正文")
    submission = _submit(
        client, action="create_doc", parent_id=folder_id, title="13 发布与邻域推进规则",
        file_id=uploaded["file"]["id"],
    )
    logout(client)
    login(client, "站长")
    _approve(client, submission["id"])

    node = client.get("/api/docs/tree").json()["root"]["children"][0]
    assert [doc["title"] for doc in node["documents"]] == ["13 发布与邻域推进规则"]
    assert node["documents"][0]["slug"].startswith("13")


def test_reject_keeps_content_offline(client: TestClient) -> None:
    _bootstrap(client)
    make_staff(client)
    submission = _submit(client, action="create_folder", name="临时目录")

    logout(client)
    login(client, "站长")
    res = client.post(f"/api/docs/review/{submission['id']}?decision=reject&note=命名不合适")
    assert res.status_code == 200
    assert res.json()["status"] == "rejected"
    assert res.json()["review_note"] == "命名不合适"
    assert client.get("/api/docs/tree").json()["root"]["children"] == []

    again = client.post(f"/api/docs/review/{submission['id']}?decision=approve")
    assert again.status_code == 409
    assert again.json()["detail"]["code"] == "submission_closed"


def test_member_cannot_review(client: TestClient) -> None:
    _bootstrap(client)
    register(client, "路人")
    assert client.post("/api/docs/review/1?decision=approve").status_code == 403


def test_pending_submission_blocks_second_edit(client: TestClient) -> None:
    _bootstrap(client)
    make_staff(client)
    doc_id = _publish_document(client, "会被连续修改的文档", "原始正文")

    logout(client)
    login(client, "临时管理员")
    payload = {"action": "update_doc", "document_id": doc_id, "body": "第一次修改"}
    assert client.post("/api/docs/submissions", json=payload).status_code == 201
    clash = client.post("/api/docs/submissions", json=payload)
    assert clash.status_code == 409
    assert clash.json()["detail"]["code"] == "submission_conflict"


def test_duplicate_folder_name_rejected_at_approval(client: TestClient) -> None:
    _bootstrap(client)
    make_staff(client)
    first = _submit(client, action="create_folder", name="重复目录")
    second = _submit(client, action="create_folder", name="重复目录")
    logout(client)
    login(client, "站长")
    assert _approve(client, first["id"])["status"] == "approved"
    clash = _approve(client, second["id"])
    assert clash["status"] == "rejected"
    assert "同名文件夹已存在" in clash["review_note"]


def test_approving_into_deleted_parent_is_reported(client: TestClient) -> None:
    """提交单在队列里躺着时父目录被删：批准必须安全失败，而不是写坏目录树。"""
    _bootstrap(client)
    make_staff(client)
    folder = _submit(client, action="create_folder", name="临时父目录")
    logout(client)
    login(client, "站长")
    folder_id = _approve(client, folder["id"])["applied_folder_id"]

    logout(client)
    login(client, "临时管理员")
    uploaded = _upload(client, "child.md", "子文档正文")
    child = _submit(
        client, action="create_doc", parent_id=folder_id, title="子文档",
        file_id=uploaded["file"]["id"],
    )
    removal = _submit(client, action="delete_folder", folder_id=folder_id)

    logout(client)
    login(client, "站长")
    assert _approve(client, removal["id"])["status"] == "approved"
    result = _approve(client, child["id"])
    assert result["status"] == "rejected"
    assert "目标文件夹" in result["review_note"]


def test_update_document_creates_new_revision(client: TestClient) -> None:
    _bootstrap(client)
    make_staff(client)
    doc_id = _publish_document(client, "会变的文档", "第一版正文")

    logout(client)
    login(client, "临时管理员")
    newer = _upload(client, "v2.md", "第二版正文")
    update = _submit(
        client, action="update_doc", document_id=doc_id, file_id=newer["file"]["id"],
        title="改过标题",
    )
    logout(client)
    login(client, "站长")
    _approve(client, update["id"])

    detail = client.get(f"/api/docs/documents/{doc_id}").json()
    assert detail["body"] == "第二版正文"
    assert detail["title"] == "改过标题"
    assert detail["revision_no"] == 2

    logout(client)
    assert client.get("/api/docs/search", params={"q": "第一版"}).json()["total"] == 0


def test_delete_submission_removes_document(client: TestClient) -> None:
    _bootstrap(client)
    make_staff(client)
    doc_id = _publish_document(client, "待删文档", "很快会被删掉")

    logout(client)
    login(client, "临时管理员")
    propose = _submit(client, action="delete_doc", document_id=doc_id, note="内容已过期")

    logout(client)
    login(client, "站长")
    assert _approve(client, propose["id"])["status"] == "approved"
    assert client.get(f"/api/docs/documents/{doc_id}").status_code == 404
    assert client.get("/api/docs/tree").json()["stats"]["documents"] == 0


# ----------------------------------------------------------------- 移动（提交单）

def _publish_folder(client: TestClient, name: str) -> int:
    """建一个已发布的文件夹，返回 id。"""
    submission = _submit(client, action="create_folder", name=name)
    logout(client)
    login(client, "站长")
    return int(_approve(client, submission["id"])["applied_folder_id"])


def _doc_ids_in(client: TestClient, folder_name: str) -> list[int]:
    tree = client.get("/api/docs/tree").json()
    node = tree["root"]["children"][0] if tree["root"]["children"] else None
    assert node is not None and node["name"] == folder_name, tree["root"]["children"]
    return [doc["id"] for doc in node["documents"]]


def test_admin_move_submission_moves_document(client: TestClient) -> None:
    _bootstrap(client)
    make_staff(client)
    doc_id = _publish_document(client, "会被移走的文档", "正文")
    folder_id = _publish_folder(client, "目标目录")

    logout(client)
    login(client, "临时管理员")
    submission = _submit(
        client, action="move_doc", document_id=doc_id, parent_id=folder_id, note="归到机制目录下"
    )
    assert submission["status"] == "pending"
    assert submission["action"] == "move_doc"
    # 队列里必须写清「移到哪里」，否则超管没法判断
    assert submission["target_path"] == "目标目录"

    # 批准前文档仍在根目录
    assert client.get("/api/docs/tree").json()["root"]["documents"][0]["id"] == doc_id

    logout(client)
    login(client, "站长")
    approved = _approve(client, submission["id"])
    assert approved["status"] == "approved"
    tree = client.get("/api/docs/tree").json()
    assert tree["root"]["documents"] == []
    assert _doc_ids_in(client, "目标目录") == [doc_id]
    assert client.get(f"/api/docs/documents/{doc_id}").json()["parent_id"] == folder_id


def test_move_document_back_to_root(client: TestClient) -> None:
    _bootstrap(client)
    make_staff(client)
    doc_id = _publish_document(client, "回到根目录", "正文")
    folder_id = _publish_folder(client, "临时归属")

    logout(client)
    login(client, "临时管理员")
    _submit(client, action="move_doc", document_id=doc_id, parent_id=folder_id)
    logout(client)
    login(client, "站长")
    pending = client.get("/api/docs/submissions", params={"scope": "pending"}).json()["items"][0]
    _approve(client, pending["id"])
    assert _doc_ids_in(client, "临时归属") == [doc_id]

    logout(client)
    login(client, "临时管理员")
    back = _submit(client, action="move_doc", document_id=doc_id, parent_id=None, note="放回根目录")
    assert back["target_path"] == "（根目录）"
    logout(client)
    login(client, "站长")
    _approve(client, back["id"])
    assert client.get("/api/docs/tree").json()["root"]["documents"][0]["id"] == doc_id


def test_move_to_same_parent_is_rejected(client: TestClient) -> None:
    _bootstrap(client)
    make_staff(client)
    doc_id = _publish_document(client, "原地不动的文档", "正文")
    logout(client)
    login(client, "临时管理员")
    res = client.post(
        "/api/docs/submissions",
        json={"action": "move_doc", "document_id": doc_id, "parent_id": None},
    )
    assert res.status_code == 400
    assert res.json()["detail"]["code"] == "same_parent"


def test_move_folder_into_itself_is_rejected(client: TestClient) -> None:
    _bootstrap(client)
    make_staff(client)
    parent_id = _publish_folder(client, "父目录")
    logout(client)
    login(client, "临时管理员")
    child = _submit(client, action="create_folder", name="子目录", parent_id=parent_id)
    logout(client)
    login(client, "站长")
    child_id = int(_approve(client, child["id"])["applied_folder_id"])

    logout(client)
    login(client, "临时管理员")
    res = client.post(
        "/api/docs/submissions",
        json={"action": "move_folder", "folder_id": parent_id, "parent_id": child_id},
    )
    assert res.status_code == 400
    assert res.json()["detail"]["code"] == "move_into_self"


def test_move_into_occupied_slug_gets_suffix(client: TestClient) -> None:
    """目标目录里已有同 slug 的文档时，搬过去的那篇加后缀，不覆盖、不报错。"""
    _bootstrap(client)
    make_staff(client)
    folder_id = _publish_folder(client, "同名收集处")
    first = _publish_document(client, "同名文档", "第一份")

    logout(client)
    login(client, "临时管理员")
    uploaded = _upload(client, "同名文档.md", "第二份")
    second = _submit(
        client, action="create_doc", parent_id=folder_id, title="同名文档",
        file_id=uploaded["file"]["id"],
    )
    logout(client)
    login(client, "站长")
    second_id = int(_approve(client, second["id"])["applied_document_id"])

    logout(client)
    login(client, "临时管理员")
    move = _submit(client, action="move_doc", document_id=first, parent_id=folder_id)
    logout(client)
    login(client, "站长")
    assert _approve(client, move["id"])["status"] == "approved"

    tree = client.get("/api/docs/tree").json()
    node = next(item for item in tree["root"]["children"] if item["name"] == "同名收集处")
    ids = sorted(doc["id"] for doc in node["documents"])
    assert ids == sorted([first, second_id]), node["documents"]
    slugs = {doc["id"]: doc["slug"] for doc in node["documents"]}
    assert slugs[first] != slugs[second_id], slugs
    # 两篇正文都没有被覆盖
    assert client.get(f"/api/docs/documents/{first}").json()["body"] == "第一份"
    assert client.get(f"/api/docs/documents/{second_id}").json()["body"] == "第二份"


def test_move_folder_rewrites_subtree_paths(client: TestClient) -> None:
    """移动文件夹必须连带改写子树的 path_key，否则子树里的文档会被「甩掉」。"""
    _bootstrap(client)
    make_staff(client)
    outer_id = _publish_folder(client, "外层")
    logout(client)
    login(client, "临时管理员")
    inner = _submit(client, action="create_folder", name="内层", parent_id=outer_id)
    logout(client)
    login(client, "站长")
    inner_id = int(_approve(client, inner["id"])["applied_folder_id"])

    logout(client)
    login(client, "临时管理员")
    uploaded = _upload(client, "深处文档.md", "深层正文")
    doc = _submit(
        client, action="create_doc", parent_id=inner_id, title="深处文档",
        file_id=uploaded["file"]["id"],
    )
    logout(client)
    login(client, "站长")
    doc_id = int(_approve(client, doc["id"])["applied_document_id"])

    # 把「内层」从「外层」挪到根目录
    logout(client)
    login(client, "临时管理员")
    move = _submit(client, action="move_folder", folder_id=inner_id, parent_id=None)
    logout(client)
    login(client, "站长")
    assert _approve(client, move["id"])["status"] == "approved"

    tree = client.get("/api/docs/tree").json()
    names = [node["name"] for node in tree["root"]["children"]]
    assert "内层" in names, names
    inner_node = next(node for node in tree["root"]["children"] if node["name"] == "内层")
    assert inner_node["path"] == "内层"
    assert [d["id"] for d in inner_node["documents"]] == [doc_id]
    # 文档的 path_key 跟着父目录改了：重复导入不会再造出第二份
    assert client.get(f"/api/docs/documents/{doc_id}").json()["parent_id"] == inner_id


def test_approving_move_into_deleted_folder_is_reported(client: TestClient) -> None:
    _bootstrap(client)
    make_staff(client)
    doc_id = _publish_document(client, "无家可归", "正文")
    folder_id = _publish_folder(client, "很快消失的目录")

    logout(client)
    login(client, "临时管理员")
    move = _submit(client, action="move_doc", document_id=doc_id, parent_id=folder_id)
    removal = _submit(client, action="delete_folder", folder_id=folder_id)

    logout(client)
    login(client, "站长")
    assert _approve(client, removal["id"])["status"] == "approved"
    result = _approve(client, move["id"])
    assert result["status"] == "rejected"
    assert "目标文件夹" in result["review_note"]
    # 文档没被搬走，也没有消失
    assert client.get(f"/api/docs/documents/{doc_id}").status_code == 200


# ----------------------------------------------------------------- 超管直接操作

def test_admin_cannot_use_direct_endpoints(client: TestClient) -> None:
    _bootstrap(client)
    make_staff(client)
    doc_id = _publish_document(client, "管理员动不了的文档", "正文")
    folder_id = _publish_folder(client, "管理员动不了的目录")

    logout(client)
    login(client, "临时管理员")
    for method, path, payload in (
        ("post", f"/api/docs/documents/{doc_id}/move", {"parent_id": None}),
        ("post", f"/api/docs/documents/{doc_id}/rename", {"title": "改名"}),
        ("delete", f"/api/docs/documents/{doc_id}", None),
        ("post", f"/api/docs/folders/{folder_id}/rename", {"name": "改名"}),
        ("delete", f"/api/docs/folders/{folder_id}", None),
    ):
        call = getattr(client, method)
        res = call(path, json=payload) if payload is not None else call(path)
        assert res.status_code == 403, f"{method} {path} → {res.status_code}"
        assert res.json()["detail"]["code"] == "forbidden"
    # 文档与目录都还在
    assert client.get(f"/api/docs/documents/{doc_id}").status_code == 200


def test_superadmin_moves_document_immediately(client: TestClient) -> None:
    _bootstrap(client)
    make_staff(client)
    doc_id = _publish_document(client, "立刻搬家", "正文")
    folder_id = _publish_folder(client, "新家")

    logout(client)
    login(client, "站长")
    res = client.post(
        f"/api/docs/documents/{doc_id}/move",
        json={"document_id": doc_id, "parent_id": folder_id, "note": "整理目录结构"},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["ok"] is True and body["path"] == "新家"
    assert _doc_ids_in(client, "新家") == [doc_id]

    # 留了一条审计记录：谁挪的、挪到哪、为什么
    history = client.get("/api/docs/submissions", params={"scope": "mine"}).json()["items"]
    audit = next(item for item in history if item["action"] == "move_doc")
    assert audit["status"] == "approved"
    assert audit["review_note"] == "直接执行（超管）"
    assert audit["target_path"] == "新家"


def test_superadmin_deletes_document_immediately(client: TestClient) -> None:
    _bootstrap(client)
    make_staff(client)
    doc_id = _publish_document(client, "立刻删除", "正文")
    logout(client)
    login(client, "站长")
    res = client.delete(f"/api/docs/documents/{doc_id}", params={"note": "重复内容"})
    assert res.status_code == 200, res.text
    assert res.json()["affected_documents"] == 1
    assert client.get(f"/api/docs/documents/{doc_id}").status_code == 404
    assert client.get("/api/docs/tree").json()["stats"]["documents"] == 0


def test_superadmin_renames_folder_and_rewrites_paths(client: TestClient) -> None:
    _bootstrap(client)
    make_staff(client)
    folder_id = _publish_folder(client, "旧名字")
    logout(client)
    login(client, "临时管理员")
    uploaded = _upload(client, "在旧名字里.md", "正文")
    doc = _submit(
        client, action="create_doc", parent_id=folder_id, title="在旧名字里",
        file_id=uploaded["file"]["id"],
    )
    logout(client)
    login(client, "站长")
    doc_id = int(_approve(client, doc["id"])["applied_document_id"])

    res = client.post(f"/api/docs/folders/{folder_id}/rename", json={"name": "新名字"})
    assert res.status_code == 200, res.text
    assert res.json()["path"] == "新名字"
    tree = client.get("/api/docs/tree").json()
    node = tree["root"]["children"][0]
    assert node["name"] == "新名字" and node["path"] == "新名字"
    assert [d["id"] for d in node["documents"]] == [doc_id]

    # 重名文件夹要被拦下，而不是悄悄合并
    other = _publish_folder(client, "另一个目录")
    clash = client.post(f"/api/docs/folders/{other}/rename", json={"name": "新名字"})
    assert clash.status_code == 409
    assert clash.json()["detail"]["code"] == "folder_exists"


def test_superadmin_delete_folder_reports_cascade(client: TestClient) -> None:
    _bootstrap(client)
    make_staff(client)
    folder_id = _publish_folder(client, "整包删除")
    logout(client)
    login(client, "临时管理员")
    for index in range(2):
        uploaded = _upload(client, f"第{index}篇.md", f"正文 {index}")
        submission = _submit(
            client, action="create_doc", parent_id=folder_id, title=f"第{index}篇",
            file_id=uploaded["file"]["id"],
        )
        logout(client)
        login(client, "站长")
        _approve(client, submission["id"])
        logout(client)
        login(client, "临时管理员")

    logout(client)
    login(client, "站长")
    res = client.delete(f"/api/docs/folders/{folder_id}")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["affected_documents"] == 2
    assert "2 篇文档" in body["message"]
    assert client.get("/api/docs/tree").json()["stats"]["documents"] == 0


# ----------------------------------------------------------------- 上传边界

def test_unsupported_file_type_rejected(client: TestClient) -> None:
    _bootstrap(client)
    make_staff(client)
    res = client.post(
        "/api/docs/uploads/direct",
        files={"file": ("binary.png", b"\x89PNG\r\n\x1a\n", "image/png")},
    )
    assert res.status_code == 400
    assert res.json()["detail"]["code"] == "unsupported_type"


def test_chunked_upload_roundtrip(client: TestClient) -> None:
    _bootstrap(client)
    make_staff(client)
    init = client.post(
        "/api/docs/uploads",
        json={"filename": "big.txt", "total_bytes": 10, "chunk_size": 4},
    )
    assert init.status_code == 200, init.text
    upload_id = init.json()["upload_id"]
    last = None
    for index, piece in enumerate([b"0123", b"4567", b"89"]):
        last = client.post(
            f"/api/docs/uploads/{upload_id}/chunks",
            params={"index": index},
            files={"chunk": (f"part-{index}", piece, "application/octet-stream")},
        )
        assert last.status_code == 200, last.text
    assert last.json()["received_bytes"] == 10

    done = client.post(
        f"/api/docs/uploads/{upload_id}/finish",
        data={"filename": "big.txt", "total_bytes": "10"},
    )
    assert done.status_code == 200, done.text
    assert done.json()["text_content"] == "0123456789"
    assert done.json()["file"]["byte_size"] == 10


def test_chunk_gap_detected(client: TestClient) -> None:
    _bootstrap(client)
    make_staff(client)
    upload_id = client.post(
        "/api/docs/uploads", json={"filename": "gap.txt"}
    ).json()["upload_id"]
    client.post(
        f"/api/docs/uploads/{upload_id}/chunks",
        params={"index": 1},
        files={"chunk": ("p1", b"later", "application/octet-stream")},
    )
    res = client.post(f"/api/docs/uploads/{upload_id}/finish", data={"filename": "gap.txt"})
    assert res.status_code == 400
    assert res.json()["detail"]["code"] == "chunk_gap"


def test_size_mismatch_detected(client: TestClient) -> None:
    _bootstrap(client)
    make_staff(client)
    upload_id = client.post(
        "/api/docs/uploads", json={"filename": "size.txt"}
    ).json()["upload_id"]
    client.post(
        f"/api/docs/uploads/{upload_id}/chunks",
        params={"index": 0},
        files={"chunk": ("p0", b"short", "application/octet-stream")},
    )
    res = client.post(
        f"/api/docs/uploads/{upload_id}/finish",
        data={"filename": "size.txt", "total_bytes": "999"},
    )
    assert res.status_code == 400
    assert res.json()["detail"]["code"] == "size_mismatch"


def test_download_of_unpublished_document_is_hidden(client: TestClient) -> None:
    """草稿文件的下载也要走同一套可见性判定，否则等于开了后门。"""
    _bootstrap(client)
    make_staff(client)
    uploaded = _upload(client, "draft.md", "草稿内容")
    file_id = uploaded["file"]["id"]

    logout(client)
    assert client.get(f"/api/docs/files/{file_id}/download").status_code == 404


def test_members_only_document_is_hidden_from_visitor(client: TestClient) -> None:
    _bootstrap(client)
    make_staff(client)
    _publish_document(client, "内部笔记", "仅会员可见的正文", visibility="members")

    logout(client)
    assert client.get("/api/docs/tree").json()["stats"]["documents"] == 0
    assert client.get("/api/docs/search", params={"q": "仅会员可见"}).json()["total"] == 0

    register(client, "路人")
    assert client.get("/api/docs/tree").json()["stats"]["documents"] == 1


def test_withdraw_own_submission(client: TestClient) -> None:
    _bootstrap(client)
    make_staff(client)
    submission = _submit(client, action="create_folder", name="待撤回")
    res = client.post(f"/api/docs/submissions/{submission['id']}/withdraw")
    assert res.status_code == 200
    assert res.json()["status"] == "withdrawn"

    mine = client.get("/api/docs/submissions", params={"scope": "mine"}).json()
    assert mine["items"][0]["status"] == "withdrawn"
    assert mine["pending_total"] == 0


def test_pending_scope_visibility(client: TestClient) -> None:
    _bootstrap(client)
    make_staff(client)
    _submit(client, action="create_folder", name="待审目录")

    admin_view = client.get("/api/docs/submissions", params={"scope": "pending"}).json()
    assert len(admin_view["items"]) == 1
    assert admin_view["items"][0]["submitted_by_name"] == "临时管理员"

    logout(client)
    login(client, "站长")
    boss_view = client.get("/api/docs/submissions", params={"scope": "pending"}).json()
    assert len(boss_view["items"]) == 1
