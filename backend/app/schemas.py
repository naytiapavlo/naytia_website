"""Pydantic schema：API 请求/响应契约，是 OpenAPI → 前端 TS 类型的来源（ADR-001）。"""
from datetime import datetime, timezone
from typing import Annotated, Any

from pydantic import AfterValidator, BaseModel, Field, field_validator

from .config import BODY_MAX, FORUM_CATEGORIES, PASSWORD_MIN, TITLE_MAX, USERNAME_MAX

USERNAME_PATTERN = r"^[A-Za-z0-9_\u4e00-\u9fa5]{2,16}$"


def _as_utc(value: datetime) -> datetime:
    """把数据库读出来的 datetime 统一标成 UTC。

    为什么必须做：SQLite 没有原生时间类型，SQLAlchemy 存的是字符串，
    **读回来时 tzinfo 会丢掉**。于是「刚写入时带着 Z、重新查一次就没有 Z」
    这种同一字段两种形态的情况就出现了，而浏览器对没有 Z 的 ISO 串会按
    **本地时间**解析——刚发的帖子显示成「8 小时前」（实测于东八区环境）。

    在契约边界上补一次是最省事也最不容易漏的地方：所有对外的
    datetime 字段都走这个注解，模型与数据库保持原样。
    """
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


# 对外暴露的时间字段都用它，不要直接写 datetime
UtcDatetime = Annotated[datetime, AfterValidator(_as_utc)]


class AccountCreate(BaseModel):
    username: str = Field(
        pattern=USERNAME_PATTERN,
        min_length=2,
        max_length=USERNAME_MAX,
        description="2-16 位字母、数字、下划线或中文",
    )
    password: str = Field(min_length=PASSWORD_MIN, max_length=128)
    # 超级管理员引导邀请码（可选；见 config.superadmin_code）
    code: str | None = Field(default=None, max_length=64)


class RoleUpdate(BaseModel):
    role: str = Field(pattern="^(member|admin|superadmin)$")


class RoleToggle(BaseModel):
    """「设为管理员 / 取消管理员」的语义化入参（/api/admin/accounts/{id}/admin）。

    为什么不复用 RoleUpdate：那个接口收的是**任意角色**，包括 superadmin——
    一个「给不给管理员」的开关，不应该具备把别人提成超管的能力。
    这里的 `enabled` 只映射到 admin 与 member 两档，超管只能由引导规则或邀请码产生。
    """

    enabled: bool = Field(
        strict=True,
        description="true = 授予 admin；false = 退回 member",
    )


class BackgroundConfig(BaseModel):
    """主页背景：image 模式直接用 URL，支持 GIF/WebP/APNG 等动图格式（ADR-002）。"""

    mode: str = Field(default="none", pattern="^(none|image)$")
    url: str | None = Field(default=None, max_length=2048)
    # 遮罩不透明度：动图背景上压一层暗色保证文字可读
    overlay: float = Field(default=0.35, ge=0, le=0.9)

    @field_validator("url")
    @classmethod
    def url_https_only(cls, v: str | None) -> str | None:
        if v is not None and not v.lower().startswith(("http://", "https://")):
            raise ValueError("背景/头像地址必须是 http(s) 链接")
        return v


class SiteConfigUpdate(BaseModel):
    """超级管理员可修改的主页内容；None 字段表示不修改。"""

    display_name: str | None = Field(default=None, min_length=1, max_length=24)
    intro: str | None = Field(default=None, max_length=400)
    avatar_url: str | None = Field(default=None, max_length=2048)
    background: BackgroundConfig | None = None

    @field_validator("avatar_url")
    @classmethod
    def avatar_https_only(cls, v: str | None) -> str | None:
        if v is not None and not v.lower().startswith(("http://", "https://")):
            raise ValueError("头像地址必须是 http(s) 链接")
        return v


class LoginRequest(BaseModel):
    username: str
    password: str


class AccountSummary(BaseModel):
    id: int
    username: str
    role: str
    created_at: UtcDatetime


class ReplySummary(BaseModel):
    id: int
    author: str
    body: str
    created_at: UtcDatetime


class ThreadCreate(BaseModel):
    category: str
    title: str = Field(min_length=2, max_length=TITLE_MAX)
    body: str = Field(min_length=2, max_length=BODY_MAX)

    @field_validator("category")
    @classmethod
    def category_known(cls, v: str) -> str:
        if v not in FORUM_CATEGORIES:
            raise ValueError(f"未知版块：{v}")
        return v


class ReplyCreate(BaseModel):
    body: str = Field(min_length=2, max_length=BODY_MAX)


class ThreadSummary(BaseModel):
    id: int
    category: str
    title: str
    author: str
    reply_count: int
    created_at: UtcDatetime
    last_activity_at: UtcDatetime
    has_structure: bool = Field(
        default=False, description="是否附带 .mcstructure 结构文件（列表页据此显示徽标）"
    )
    has_cover: bool = Field(
        default=False, description="是否有封面图（列表页据此显示缩略图）"
    )


class ThreadDetail(ThreadSummary):
    body: str
    replies: list[ReplySummary]
    structure: "ThreadStructure | None" = Field(
        default=None, description="随帖上传的结构文件摘要与材料清单；没有附件时为 null"
    )
    cover: "ThreadCover | None" = Field(
        default=None, description="帖子封面；没有封面时为 null"
    )


# --------------------------------------------------------------- 封面
#
# 封面不复用「结构附件」那套模型：它没有材料清单，但有尺寸与像素比例，
# 而这两样正是列表页排版要用的东西（预先留出空间，避免图片加载完页面跳一下）。

class ThreadCover(BaseModel):
    """帖子封面。宽高来自图片字节本身，不是文件名或用户输入。"""

    original_name: str
    byte_size: int
    sha256: str = Field(description="图片内容的 sha256，下载后可自行核对")
    content_type: str = Field(
        description="由字节判定出的 MIME（image/png 等），不受用户文件名影响"
    )
    width: int = Field(description="像素宽")
    height: int = Field(description="像素高")
    aspect_ratio: float = Field(
        description="宽/高。前端用它给图片预留位置，避免加载完成时页面跳动"
    )
    created_at: UtcDatetime


# --------------------------------------------------------------- 结构附件
#
# 这些模型是**论坛自己的**结构摘要投影，不复用 schemas_mcstructure 里的同名模型：
# 那个是「解析接口」的契约（要把 palette / 方块实体 / 实体原始 NBT 都透出），
# 论坛要的是「一个帖子带了什么、要用多少材料」。两边的字段演进节奏不同，
# 合成一个模型会让改解析接口变成改论坛契约。

class StructureDimensions(BaseModel):
    x: int = Field(description="X 方向尺寸（方块数）")
    y: int = Field(description="Y 方向尺寸（方块数）")
    z: int = Field(description="Z 方向尺寸（方块数）")


class MaterialEntry(BaseModel):
    """材料清单的一行。

    统计单位是**调色板条目**而不是方块名：同一个 `minecraft:oak_stairs`
    带不同朝向是两个条目，清单里也分开列——玩家要的是「这份图纸要多少块
    什么朝向的楼梯」，不是模糊的名字汇总。
    """

    index: int = Field(description="在结构调色板中的下标")
    name: str = Field(description="方块标识，如 minecraft:stone")
    # json_schema_extra 那一行不是装饰：pydantic 对 `dict[str, Any]` 生成的是
    # `additionalProperties: {}`，而 openapi-typescript 会把空 schema 映射成
    # `Record<string, never>`——前端拿到的类型等于「这个对象永远是空的」，
    # 一读字段就报错。显式写成 `true` 才会生成 `Record<string, unknown>`。
    states: dict[str, Any] = Field(
        description="方块状态原文（值类型随状态而变：字符串 / 整数 / 字节），不做推断",
        json_schema_extra={"additionalProperties": True},
    )
    count: int = Field(description="出现次数（主层 + 次层）")
    ratio: float = Field(description="占非空方块总数的比例，0~1")


class StructureRenderStatus(BaseModel):
    """/structure/render 能不能用、以及为什么。"""

    available: bool = Field(description="是否生成了 3D 预览载荷")
    reason: str | None = Field(default=None, description="不可用时的人话原因")
    version: int | None = Field(default=None, description="载荷格式版本，前端据此决定能否解码")
    bytes: int | None = Field(default=None, description="载荷未压缩时的字节数")
    note: str | None = Field(default=None, description="可展示的提示（例如方块很多，只画外表面）")


class ThreadStructure(BaseModel):
    """帖子附带的结构文件摘要（材料清单在这里）。"""

    original_name: str
    byte_size: int
    sha256: str = Field(description="文件内容的 sha256，下载后可自行核对")
    created_at: UtcDatetime

    format_version: int | None = None
    compression: str | None = Field(default=None, description="检测到的压缩方式")
    size: StructureDimensions
    voxel_count: int = Field(description="size 的乘积（整卷格数，含空气）")
    world_origin: list[int] | None = Field(default=None, description="保存时的世界原点")
    world_origin_source: str | None = Field(default=None, description="'root' / 'structure' / null")
    layer_count: int

    solid_cells: int = Field(
        description="有方块的格子数（不含空气），等于 3D 预览里会出现的方块数"
    )
    placed_blocks: int = Field(
        description="两层合计放置的方块数（含空气，与 /api/mcstructure/parse 口径一致）"
    )
    air_cells: int = Field(description="索引里写了方块、但那些方块全是空气的格子数")
    air_blocks: int = Field(description="被算作空气的方块数（材料清单里已排除）")
    coincident_cells: int = Field(description="两层都有方块的格子数")
    out_of_range_indices: int = Field(description="越界调色板下标数量（游戏按空气处理）")
    palette_size: int

    materials: list[MaterialEntry] = Field(description="按数量降序；已排除空气方块")
    materials_total: int = Field(description="不同方块排列的总数（截断前，不含空气）")
    materials_truncated: bool = Field(
        default=False, description="清单是否被截断（只保留数量最多的若干条）"
    )

    block_entities: int
    entities: int
    extra_root_fields: list[str] = Field(
        description="未建模但已保留的根字段名（响应里一定给，不会是 undefined）"
    )
    render: StructureRenderStatus


class StructureRenderPayload(BaseModel):
    """/structure/render 的响应：浏览器直接照着画的最小数据。

    两个大数组都是 base64。布局（version 1）见
    `backend/app/parsers/mcstructure_render.py` 的模块说明——那里是唯一事实源。
    """

    version: int
    size: StructureDimensions
    voxel_count: int
    solid_count: int
    index_bits: int = Field(description="8 或 16：indices 里每个下标的位宽（小端）")
    palette: list[str] = Field(description="按调色板下标顺序的方块名")
    occupancy: str = Field(
        description="占用位图 base64：第 i 格有方块 ⟺ occupancy[i>>3] >> (i&7) & 1（LSB-first）"
    )
    indices: str = Field(
        description="按位置下标升序排列的非空格子调色板下标，base64，小端整数"
    )
    note: str | None = None


class PageResult(BaseModel):
    """稳定分页语义（03 文档第 3 节）。"""

    items: list[ThreadSummary]
    next_cursor: str | None = None


class FavoriteList(BaseModel):
    tools: list[str]


class ApiError(BaseModel):
    """结构化错误（03 文档第 5 节 ToolError 风格）。"""

    code: str
    message: str


# ThreadDetail 里的 `structure` 是前向引用（ThreadStructure 定义在它之后，
# 因为文件按「帖子 → 附件」的顺序读更顺）。pydantic v2 不会自己重试解析，
# 必须显式重建一次，否则 FastAPI 生成 OpenAPI 时会报模型未完全定义。
ThreadDetail.model_rebuild()
