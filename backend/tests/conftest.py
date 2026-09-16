"""测试夹具：每个测试用独立的临时 SQLite，不碰真实数据。"""
import os
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("NAYTIA_SQLITE_PATH", "data/test.db")

from app import db as db_module  # noqa: E402
from app.deps import get_db  # noqa: E402
from app.main import create_app  # noqa: E402


@pytest.fixture()
def client(tmp_path, monkeypatch) -> Iterator[TestClient]:
    test_db = tmp_path / "test.db"
    monkeypatch.setenv("NAYTIA_SQLITE_PATH", str(test_db))

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


def register(client: TestClient, username: str, password: str = "secret123"):
    return client.post("/api/auth/register",
                       json={"username": username, "password": password})
