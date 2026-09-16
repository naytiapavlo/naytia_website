"""测试夹具：每个测试用独立的临时 SQLite 与临时文件存储，不碰真实数据。"""
import os
import shutil
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("NAYTIA_SQLITE_PATH", "data/test.db")
# 测试客户端走的是明文 http，而部署用的 backend/.env 里 NAYTIA_COOKIE_SECURE=true
# （站点在 HTTPS 隧道后面）。浏览器（以及 httpx）不会把 Secure Cookie 回传给 http，
# 那会让**每一个**登录后的用例都变成 401——看起来像权限体系坏了，其实只是夹具环境
# 与部署配置不一致。环境变量的优先级高于 .env（pydantic-settings），所以这里显式钉成
# false；用 setdefault 是给「确实想测 Secure 那一支」留个出口。
os.environ.setdefault("NAYTIA_COOKIE_SECURE", "false")

from app import db as db_module  # noqa: E402
from app.config import get_settings  # noqa: E402
from app.deps import get_db  # noqa: E402
from app.main import create_app  # noqa: E402


@pytest.fixture(autouse=True)
def storage_root(tmp_path_factory, monkeypatch) -> Iterator[Path]:
    """把上传落盘目录指到临时目录。

    为什么是 autouse：docs 模块与论坛结构附件的存储根目录都走 `get_settings()`，
    而配置是 `lru_cache` 的——不显式清缓存的话，测试会把文件写进
    backend/data/docs 与 backend/data/forum（真实数据目录）。这里统一隔离，
    顺带保证「清缓存 + 重新读环境变量」这条路径本身被测到。
    """
    root = tmp_path_factory.mktemp("docs-storage")
    forum_root = tmp_path_factory.mktemp("forum-structures")
    monkeypatch.setenv("NAYTIA_DOCS_STORAGE_DIR", str(root))
    monkeypatch.setenv("NAYTIA_FORUM_STORAGE_DIR", str(forum_root))
    get_settings.cache_clear()
    yield root
    get_settings.cache_clear()
    shutil.rmtree(root, ignore_errors=True)
    shutil.rmtree(forum_root, ignore_errors=True)


@pytest.fixture()
def client(tmp_path, monkeypatch) -> Iterator[TestClient]:
    test_db = tmp_path / "test.db"
    monkeypatch.setenv("NAYTIA_SQLITE_PATH", str(test_db))
    get_settings.cache_clear()

    test_engine = db_module.create_engine(
        f"sqlite:///{test_db}", connect_args={"check_same_thread": False}
    )
    db_module.Base.metadata.create_all(bind=test_engine)
    TestSession = db_module.sessionmaker(bind=test_engine, autoflush=False,
                                         expire_on_commit=False)

    app = create_app()

    def override_get_db():
        session = TestSession()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = override_get_db

    with TestClient(app) as c:
        yield c

    app.dependency_overrides.clear()
    test_engine.dispose()
    get_settings.cache_clear()


def register(client: TestClient, username: str, password: str = "secret123"):
    return client.post("/api/auth/register",
                       json={"username": username, "password": password})


def login(client: TestClient, username: str, password: str = "secret123") -> None:
    res = client.post("/api/auth/login", json={"username": username, "password": password})
    assert res.status_code == 200, res.text


def logout(client: TestClient) -> None:
    client.post("/api/auth/logout")


def make_staff(client: TestClient, role: str = "admin") -> TestClient:
    """再建一个账号并提升为 admin；返回时已用该账号登录。

    超管是「首个注册账号」（ADR-002），所以这里先确保有个超管叫「站长」，
    再注册「临时管理员」并让站长把他提权。
    """
    from app.models import Account

    logout(client)
    boss = client.post("/api/auth/login", json={"username": "站长", "password": "secret123"})
    if boss.status_code != 200:
        assert register(client, "站长").json()["role"] == "superadmin"
    else:
        logout(client)

    created = register(client, "临时管理员")
    assert created.status_code == 201, created.text
    account_id = created.json()["id"]
    logout(client)

    login(client, "站长")
    res = client.put(f"/api/admin/accounts/{account_id}/role", json={"role": role})
    assert res.status_code == 200, res.text
    logout(client)

    login(client, "临时管理员")
    assert client.get("/api/auth/me").json()["role"] == role
    return client
