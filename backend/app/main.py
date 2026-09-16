"""FastAPI 应用工厂（ADR-001：Python + FastAPI + SQLite）。"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .db import Base, engine
# AI 助手（逆向工作台的浮动窗口，docs/plans/11）
from .ai import router as ai_router
# 挂载 v1 路由 + 密钥管理路由 + 信封异常处理都在 public_api/router.py 的 register(app) 里。
# 必须 import 子模块本身：`from .public_api import router` 拿到的是包 __init__ 导出的
# APIRouter 实例（同名遮盖了子模块），调用 register 会直接 AttributeError。
from .public_api.router import register as register_public_api
from .routers import admin, auth, docs, favorites, forum, mcstructure, site_config
from .reverse import router as reverse_router

settings = get_settings()


def create_app() -> FastAPI:
    Base.metadata.create_all(bind=engine)
    app = FastAPI(
        title="Naytia 像素小站 API",
        version="0.1.0",
        description="账号 / 论坛 / 工具箱收藏。契约见 docs/plans/03。",
        # 站点的 /docs/ 是访客看的文档树页面，后端的接口文档因此挪到 /api/docs，
        # 否则同源部署时两者会抢同一个 URL（见 docs/plans/14 第 2 节）。
        docs_url="/api/docs",
        redoc_url="/api/redoc",
        openapi_url="/api/openapi.json",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(auth.router)
    app.include_router(forum.router)
    app.include_router(favorites.router)
    app.include_router(admin.router)
    app.include_router(site_config.router)
    app.include_router(mcstructure.router)
    app.include_router(docs.router)
    app.include_router(reverse_router.router)
    app.include_router(ai_router.router)
    register_public_api(app)

    @app.get("/api/health", tags=["meta"])
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
