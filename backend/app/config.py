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

    # ---- 结构文件解析（.mcstructure，docs/plans/03 第 3 节）----
    # 上传文件字节上限。结构文件通常几十 KB ~ 几 MB；给到 32 MB 足够
    mcstructure_max_bytes: int = 32 * 1024 * 1024
    # 单次解析的体素上限（size 的乘积）。64×256×64 ≈ 104 万，远在默认值之内
    mcstructure_max_voxels: int = 16 * 1024 * 1024

    # ---- 论坛附件（结构文件 + 封面，docs/plans/10）----
    # 发帖时随帖上传的 .mcstructure 上限。10 MB 是需求给定的硬边界
    forum_structure_max_bytes: int = 10 * 1024 * 1024
    # 帖子封面上限。封面会在列表里反复加载，给到 5 MB 是为了容纳
    # 游戏全屏截图的原图；服务端不做压缩（不引入 Pillow），界面上会提示控制体积
    forum_cover_max_bytes: int = 5 * 1024 * 1024
    # 论坛附件的落盘根目录（相对 backend/ 运行时的工作目录）。
    # 下面按类型分 structures/ 与 covers/ 两个子目录，见 forum_storage
    forum_storage_dir: Path = Path("data/forum")
    # 材料清单最多入库多少条（按数量降序），超出部分如实标记为已截断
    forum_material_limit: int = 2000
    # 3D 预览载荷（压缩前）的上限。超过就不生成预览，只给材料清单
    forum_render_max_bytes: int = 8 * 1024 * 1024

    # ---- 逆向工作台：IDA Pro MCP（docs/plans/07）----
    # ida-pro-mcp 默认监听 13337；多实例时由它自己的 list_instances 发现 13338+
    ida_mcp_url: str = "http://127.0.0.1:13337/mcp"
    # 单次 MCP 调用超时（秒）。反编译大函数可能较慢，给足余量
    ida_mcp_timeout: float = 60.0
    # 未指定实例时默认连哪个端口；留空则用 MCP 服务当前选中的实例
    ida_default_port: int = 13337
    # 允许前端选择的实例端口白名单（逗号分隔）；留空表示允许发现到的全部实例。
    # 设成白名单可以避免误连到正在手工操作的那个 IDA 实例（见 07 文档安全边界）
    ida_allowed_ports: str = ""

    # ---- 逆向工作台的 AI 助手（DeepSeek，docs/plans/11）----
    # 未配置 key 时 /api/ai/chat 返回 503，前端显示"未配置"而不是报错
    deepseek_api_key: str = ""
    deepseek_base_url: str = "https://api.deepseek.com"
    deepseek_model: str = "deepseek-chat"
    deepseek_timeout: float = 90.0
    # 一条用户消息内最多几轮工具调用（防止模型来回调用停不下来）
    ai_max_tool_rounds: int = 6
    # 单次请求最多接受多少条历史消息（前端只传最近若干轮）
    ai_max_messages: int = 24
    # 对话历史的字符预算（超出时从最早的消息开始丢）
    ai_max_chars: int = 24000

    # ---- 文档树（docs/plans/09）----    # 上传文件的落盘根目录（相对 backend/ 运行时的工作目录）。库里只存相对路径。
    docs_storage_dir: Path = Path("data/docs")
    # 单个文档文件上限。首版只收 md/json/txt 文本，8 MB 足够装下长篇反汇编笔记
    docs_max_bytes: int = 8 * 1024 * 1024
    # 公开搜索结果条数上限（访客可读，给个上限避免被当成免费全文检索接口刷）
    docs_search_limit: int = 50

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def ida_allowed_port_list(self) -> list[int]:
        return [int(p) for p in self.ida_allowed_ports.split(",") if p.strip().isdigit()]


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

# ---- AI 助手配额 ----
# 每 5 小时 3 轮。一轮 = 用户发一条消息；agent 内部的多次工具调用算同一轮。
AI_ROUNDS_PER_WINDOW = 3
AI_WINDOW_SECONDS = 5 * 3600
