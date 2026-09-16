"""应用配置：全部来自环境变量（.env），密钥与路径不进代码库。"""
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="NAYTIA_", env_file=".env", extra="ignore"
    )

    sqlite_path: Path = Path("data/app.db")
    session_days: int = 14
    cookie_secure: bool = False
    cors_origins: str = "http://localhost:4321,http://127.0.0.1:4321"
    # 超级管理员引导：非空时，注册携带此邀请码即授予 superadmin（ADR-002）
    superadmin_code: str = ""

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


# 版块为站点级配置（01 文档第 7 节：新版块通过配置增加）
FORUM_CATEGORIES = ("机制研究", "作品展示", "问答互助", "站务公告")

# 用户名与正文的输入边界（与演示版口径一致）
USERNAME_MIN, USERNAME_MAX = 2, 16
PASSWORD_MIN = 6
TITLE_MAX = 60
BODY_MAX = 2000
