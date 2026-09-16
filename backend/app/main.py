"""FastAPI 应用工厂（ADR-001：Python + FastAPI + SQLite）。"""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .db import Base, engine
from .routers import auth, favorites, forum

settings = get_settings()


def create_app() -> FastAPI:
    Base.metadata.create_all(bind=engine)
    app = FastAPI(
        title="Naytia 像素小站 API",
        version="0.1.0",
        description="账号 / 论坛 / 工具箱收藏。契约见 docs/plans/03。",
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

    @app.get("/api/health", tags=["meta"])
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app


app = create_app()
