"""论坛路由：未登录只读；登录后发帖/回复；作者可删除自有内容（01 文档第 7 节）。

## 结构附件（docs/plans/10）

发帖时可以随帖带一个 ≤10 MB 的 `.mcstructure`。服务端用**内置解析器**
（`parsers/mcstructure.py`，ADR-003）解析出材料清单，并另存一份「轻量渲染载荷」
供浏览器端做 3D 预览。三条边界：

1. **附件不是任意文件**：扩展名、体积、能不能解析，三道都要过。解析失败的字节
   不会入库，也不会在磁盘上留下记录。
2. **对外只暴露帖子 id**：`storage_path` / `render_path` 是模块内部字段，
   下载与预览都走 `/api/forum/threads/{id}/structure/...`，路径永不出现在响应里。
3. **预览载荷可以没有**：结构太大时只给材料清单，并把原因如实返回
   （`render.reason`），不假装渲染成功、也不因此让发帖失败。

发帖用 multipart 单独开一个端点而不是把 JSON 端点改成双形态：OpenAPI 是前端
类型的唯一来源（ADR-001），一个端点同时接受 JSON 与 multipart 会让生成的契约
含糊；「纯文字帖」与「带结构帖」在前端本来就是两条不同的提交路径。
"""
import base64
import json
from dataclasses import dataclass
from datetime import datetime
from urllib.parse import quote

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Response,
    UploadFile,
    status,
)
from fastapi.exceptions import RequestValidationError
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.orm import Session as DBSession

from ..config import FORUM_CATEGORIES, get_settings
from ..db import get_db
from ..deps import require_account
from ..forum_storage import (
    ForumStorageError,
    cover_max_bytes,
    max_bytes as structure_max_bytes,
    read_cover,
    read_render_gz,
    read_structure,
    remove_files,
    save_cover,
    save_render,
    save_structure,
)
from ..models import (
    Account,
    ForumCover,
    ForumReply,
    ForumStructure,
    ForumThread,
    utcnow,
)
from ..parsers.image_info import ImageFormatError, ImageInfo, inspect_image
from ..parsers.mcstructure import (
    McStructureError,
    McStructureFormatError,
    McStructureLimitError,
    parse_mcstructure,
)
from ..parsers.mcstructure_render import RENDER_VERSION, StructureReport, build_report
from ..schemas import (
    MaterialEntry,
    PageResult,
    ReplyCreate,
    ReplySummary,
    StructureDimensions,
    StructureRenderPayload,
    StructureRenderStatus,
    ThreadCover,
    ThreadCreate,
    ThreadDetail,
    ThreadStructure,
    ThreadSummary,
)
from ..uploads import format_bytes, read_upload_limited

router = APIRouter(prefix="/api/forum", tags=["forum"])

PAGE_SIZE = 20


# ----------------------------------------------------------------- 附件：上传

def _bad_request(code: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail={"code": code, "message": message},
    )


def _storage_error(exc: ForumStorageError) -> HTTPException:
    if exc.code == "file_too_large":
        return HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail={"code": exc.code, "message": exc.message},
        )
    return _bad_request(exc.code, exc.message)


@dataclass(frozen=True)
class PreparedStructure:
    """结构文件已经**校验并解析完毕**，但还没落盘。

    把「校验」与「落盘」拆成两步，是因为一次发帖可以同时带结构文件和封面：
    如果先落盘结构、再去校验封面，封面被拒时磁盘上就留下一个没有任何记录引用的
    结构文件（数据库已经回滚了，文件却还在）。这是测试实际抓到的——
    `test_封面被拒时结构文件也不入库`。所以规则是：**先把所有输入都验完，再动磁盘**。
    """

    data: bytes
    original_name: str
    report: StructureReport
    payload_json: bytes | None


@dataclass(frozen=True)
class PreparedCover:
    """封面已经**校验完毕**（类型与尺寸都来自字节），但还没落盘。"""

    data: bytes
    original_name: str
    info: ImageInfo


def prepare_structure(data: bytes, original_name: str) -> PreparedStructure:
    """解析结构文件并算出材料清单与预览载荷；不写磁盘、不碰数据库。"""
    settings = get_settings()
    try:
        parsed, _root = parse_mcstructure(
            data, max_voxels=settings.mcstructure_max_voxels
        )
    except McStructureLimitError as exc:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail={"code": exc.code, "message": exc.message},
        ) from exc
    except McStructureFormatError as exc:
        raise _bad_request(exc.code, exc.message) from exc
    except McStructureError as exc:  # 兜底，避免漏掉新增的错误类型
        raise _bad_request(exc.code, exc.message) from exc

    report = build_report(
        parsed,
        file_bytes=len(data),
        material_limit=settings.forum_material_limit,
        max_payload_bytes=settings.forum_render_max_bytes,
    )
    payload_json = (
        json.dumps(
            report.payload.to_json(parsed), ensure_ascii=False, separators=(",", ":")
        ).encode("utf-8")
        if report.payload is not None
        else None
    )
    return PreparedStructure(
        data=data,
        original_name=original_name,
        report=report,
        payload_json=payload_json,
    )


def prepare_cover(data: bytes, original_name: str) -> PreparedCover:
    """校验封面图片；不写磁盘、不碰数据库。

    唯一的类型判据是文件头（`parsers/image_info`）：认不出就拒绝，
    绝不用用户给的扩展名去决定 Content-Type——否则一个叫 `cover.png` 的 HTML
    会被本站的 origin 当网页执行，变成存储型 XSS。
    """
    try:
        info = inspect_image(data)
    except ImageFormatError as exc:
        raise _bad_request(exc.code, exc.message) from exc
    return PreparedCover(data=data, original_name=original_name, info=info)


def store_structure(
    db: DBSession, thread: ForumThread, prepared: PreparedStructure
) -> ForumStructure:
    """把已校验的结构文件落盘并建记录（未 commit）。"""
    report = prepared.report
    try:
        stored = save_structure(prepared.data, prepared.original_name)
    except ForumStorageError as exc:
        raise _storage_error(exc) from exc

    render_path: str | None = None
    render_bytes = 0
    render_reason = report.summary["render"]["reason"]
    if prepared.payload_json is not None:
        try:
            render_path, render_bytes = save_render(stored.sha256, prepared.payload_json)
        except ForumStorageError:
            # 预览落盘失败不影响「帖子带结构」这件事：材料清单已经算好了，
            # 如实降级成「没有预览」，而不是把整次发帖判失败
            render_path = None
            render_reason = "预览数据落盘失败，请重新上传一次"

    summary = dict(report.summary)
    summary["render"] = {
        "available": render_path is not None,
        "reason": render_reason,
        "version": report.summary["render"]["version"] if render_path else None,
        "bytes": report.summary["render"]["bytes"] if render_path else None,
        "note": report.summary["render"]["note"],
    }

    record = ForumStructure(
        thread_id=thread.id,
        original_name=stored.original_name,
        byte_size=stored.byte_size,
        sha256=stored.sha256,
        storage_path=stored.storage_path,
        render_path=render_path,
        render_bytes=render_bytes,
        render_available=render_path is not None,
        summary_json=json.dumps(summary, ensure_ascii=False),
    )
    db.add(record)
    return record


def store_cover(
    db: DBSession, thread: ForumThread, prepared: PreparedCover
) -> ForumCover:
    """把已校验的封面落盘并建记录（未 commit）。

    落盘用的扩展名取自 `prepared.info.extension`（字节判定结果），
    不是用户给的文件名。
    """
    try:
        stored = save_cover(
            prepared.data, prepared.original_name, prepared.info.extension
        )
    except ForumStorageError as exc:
        raise _storage_error(exc) from exc

    record = ForumCover(
        thread_id=thread.id,
        original_name=stored.original_name,
        byte_size=stored.byte_size,
        sha256=stored.sha256,
        storage_path=stored.storage_path,
        content_type=prepared.info.mime,
        extension=prepared.info.extension,
        width=prepared.info.width,
        height=prepared.info.height,
    )
    db.add(record)
    return record


def _cover_view(record: ForumCover) -> ThreadCover:
    return ThreadCover(
        original_name=record.original_name,
        byte_size=record.byte_size,
        sha256=record.sha256,
        content_type=record.content_type,
        width=record.width,
        height=record.height,
        aspect_ratio=(record.width / record.height) if record.height else 0.0,
        created_at=record.created_at,
    )


def _structure_view(record: ForumStructure) -> ThreadStructure:
    summary = json.loads(record.summary_json)
    size = summary.get("size") or {"x": 0, "y": 0, "z": 0}
    render = summary.get("render") or {}
    return ThreadStructure(
        original_name=record.original_name,
        byte_size=record.byte_size,
        sha256=record.sha256,
        created_at=record.created_at,
        format_version=summary.get("format_version"),
        compression=summary.get("compression"),
        size=StructureDimensions(
            x=int(size.get("x", 0)), y=int(size.get("y", 0)), z=int(size.get("z", 0))
        ),
        voxel_count=int(summary.get("voxel_count", 0)),
        world_origin=summary.get("world_origin"),
        world_origin_source=summary.get("world_origin_source"),
        layer_count=int(summary.get("layer_count", 0)),
        solid_cells=int(summary.get("solid_cells", 0)),
        placed_blocks=int(summary.get("placed_blocks", 0)),
        air_cells=int(summary.get("air_cells", 0)),
        air_blocks=int(summary.get("air_blocks", 0)),
        coincident_cells=int(summary.get("coincident_cells", 0)),
        out_of_range_indices=int(summary.get("out_of_range_indices", 0)),
        palette_size=int(summary.get("palette_size", 0)),
        materials=[
            MaterialEntry(
                index=int(row["index"]),
                name=str(row["name"]),
                states=row.get("states") or {},
                count=int(row["count"]),
                ratio=float(row["ratio"]),
            )
            for row in summary.get("materials", [])
        ],
        materials_total=int(summary.get("materials_total", 0)),
        materials_truncated=bool(summary.get("materials_truncated", False)),
        block_entities=int(summary.get("block_entities", 0)),
        entities=int(summary.get("entities", 0)),
        extra_root_fields=list(summary.get("extra_root_fields", [])),
        render=StructureRenderStatus(
            available=bool(render.get("available")),
            reason=render.get("reason"),
            version=render.get("version"),
            bytes=render.get("bytes"),
            note=render.get("note"),
        ),
    )


# ----------------------------------------------------------------- 帖子

def _cursor_encode(thread: ForumThread) -> str:
    raw = f"{thread.last_activity_at.isoformat()}|{thread.id}"
    return base64.urlsafe_b64encode(raw.encode()).decode()


def _cursor_decode(cursor: str) -> tuple[datetime, int]:
    try:
        raw = base64.urlsafe_b64decode(cursor.encode()).decode()
        ts, tid = raw.split("|")
        return datetime.fromisoformat(ts), int(tid)
    except Exception as exc:  # noqa: BLE001 —— 任何坏游标都按参数错误处理
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "bad_cursor", "message": "分页游标无效"},
        ) from exc


def _author_name(db: DBSession, author_id: int) -> str:
    account = db.get(Account, author_id)
    return account.username if account else "已注销用户"


def _thread_summary(
    db: DBSession,
    thread: ForumThread,
    *,
    has_structure: bool | None = None,
    has_cover: bool | None = None,
) -> ThreadSummary:
    reply_count = db.scalar(
        select(func.count(ForumReply.id)).where(
            ForumReply.thread_id == thread.id,
            ForumReply.status == "published",
        )
    )
    if has_structure is None:
        has_structure = (
            db.scalar(
                select(func.count(ForumStructure.id)).where(
                    ForumStructure.thread_id == thread.id
                )
            )
            or 0
        ) > 0
    if has_cover is None:
        has_cover = (
            db.scalar(
                select(func.count(ForumCover.id)).where(ForumCover.thread_id == thread.id)
            )
            or 0
        ) > 0
    return ThreadSummary(
        id=thread.id,
        category=thread.category_id,
        title=thread.title,
        author=_author_name(db, thread.author_id),
        reply_count=reply_count or 0,
        created_at=thread.created_at,
        last_activity_at=thread.last_activity_at,
        has_structure=has_structure,
        has_cover=has_cover,
    )


def _published_thread(db: DBSession, thread_id: int) -> ForumThread:
    thread = db.get(ForumThread, thread_id)
    if thread is None or thread.status != "published":
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "thread_not_found", "message": "帖子不存在"},
        )
    return thread


@router.get("/categories", summary="版块清单（前端不硬编码版块名）")
def list_categories() -> dict[str, list[str]]:
    """版块是站点级配置（01 文档第 7 节）。

    单独开一个只读端点，是为了让前端的版块下拉与后端的校验用同一份来源——
    前端硬编码一份版块名，改配置时就会出现「下拉里有、提交被拒」的错位。
    """
    return {"categories": list(FORUM_CATEGORIES)}


@router.get("/threads", response_model=PageResult)
def list_threads(
    category: str | None = Query(default=None),
    cursor: str | None = Query(default=None),
    db: DBSession = Depends(get_db),
) -> PageResult:
    if category is not None and category not in FORUM_CATEGORIES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "unknown_category", "message": f"未知版块：{category}"},
        )
    stmt = (
        select(ForumThread)
        .where(ForumThread.status == "published")
        .order_by(ForumThread.last_activity_at.desc(), ForumThread.id.desc())
        .limit(PAGE_SIZE + 1)
    )
    if category is not None:
        stmt = stmt.where(ForumThread.category_id == category)
    if cursor is not None:
        ts, tid = _cursor_decode(cursor)
        stmt = stmt.where(
            (ForumThread.last_activity_at < ts)
            | ((ForumThread.last_activity_at == ts) & (ForumThread.id < tid))
        )
    rows = db.scalars(stmt).all()
    has_more = len(rows) > PAGE_SIZE
    page = rows[:PAGE_SIZE]
    # 一次查出这一页里哪些帖子带附件/封面，避免每行一次查询（N+1）
    page_ids = [t.id for t in page]
    with_structure: set[int] = set()
    with_cover: set[int] = set()
    if page_ids:
        with_structure = set(
            db.scalars(
                select(ForumStructure.thread_id).where(
                    ForumStructure.thread_id.in_(page_ids)
                )
            ).all()
        )
        with_cover = set(
            db.scalars(
                select(ForumCover.thread_id).where(ForumCover.thread_id.in_(page_ids))
            ).all()
        )
    items = [
        _thread_summary(
            db,
            t,
            has_structure=t.id in with_structure,
            has_cover=t.id in with_cover,
        )
        for t in page
    ]
    next_cursor = _cursor_encode(rows[PAGE_SIZE - 1]) if has_more and rows else None
    return PageResult(items=items, next_cursor=next_cursor)


def _create_thread(
    db: DBSession, account: Account, payload: ThreadCreate
) -> ForumThread:
    thread = ForumThread(
        category_id=payload.category,
        title=payload.title,
        body=payload.body,
        author_id=account.id,
    )
    db.add(thread)
    db.flush()  # 拿到 id 供附件关联；commit 由调用方决定
    return thread


@router.post("/threads", response_model=ThreadDetail,
             status_code=status.HTTP_201_CREATED)
def create_thread(payload: ThreadCreate, db: DBSession = Depends(get_db),
                  account: Account = Depends(require_account)) -> ThreadDetail:
    thread = _create_thread(db, account, payload)
    db.commit()
    return _thread_detail(db, thread)


@router.post(
    "/threads/with-attachments",
    response_model=ThreadDetail,
    status_code=status.HTTP_201_CREATED,
    summary="发帖并随帖上传附件（结构文件 / 封面，multipart）",
)
async def create_thread_with_attachments(
    category: str = Form(description="版块名，取值见 GET /api/forum/categories"),
    title: str = Form(description="标题，2-60 字"),
    body: str = Form(description="正文，2-2000 字"),
    structure: UploadFile | None = File(
        default=None, description=".mcstructure 文件（可选），不超过 10 MB"
    ),
    cover: UploadFile | None = File(
        default=None, description="封面图片（可选，PNG/JPEG/GIF/WebP），不超过 5 MB"
    ),
    db: DBSession = Depends(get_db),
    account: Account = Depends(require_account),
) -> ThreadDetail:
    """一次请求完成「发帖 +（可选）上传结构文件 +（可选）上传封面」。

    做成一个端点是为了一致性：任何一个附件被拒时帖子都不会被创建，
    用户拿到的是一条明确的错误，而不是「帖子发出去了但附件没了」这种半成品。

    **两个附件都可选**，所以原来那个只能传结构文件的
    `/threads/with-structure` 被它取代了：一个帖子现在可以有四种组合
    （纯文字 / 只带结构 / 只带封面 / 都带），拆成多个端点会让前端按组合去猜该调哪个。
    """
    # 文本字段走与 JSON 端点**同一个** schema。multipart 的字段不会经过 FastAPI
    # 的请求体校验，所以这里手动构造一次；失败时转成 RequestValidationError，
    # 由 FastAPI 默认处理器吐出一模一样的 422 响应体——前端不需要为两个端点
    # 各写一套字段错误解析。
    try:
        payload = ThreadCreate(category=category, title=title, body=body)
    except ValidationError as exc:
        raise RequestValidationError(exc.errors()) from exc

    # 两个附件都先读进内存、**全部校验完**，再动磁盘。
    # 顺序上先读结构文件：它更常见，报错顺序与用户的填写顺序一致
    # （先挑结构文件再挑封面）。
    #
    # 「字段没传」「传了但文件是空的」是两回事，错误码要分开：
    # 前者是调用方用错了端点（empty_upload），后者是用户选错/选了个空文件（empty_file）。
    # 合并成一句会让用户对着「什么都没带」的提示去找自己明明已经选好的文件。
    prepared_structure: PreparedStructure | None = None
    if structure is not None and structure.filename:
        structure_data = await read_upload_limited(
            structure, structure_max_bytes(), label="结构文件"
        )
        if not structure_data:
            raise _bad_request("empty_file", "结构文件是空的")
        prepared_structure = prepare_structure(structure_data, structure.filename)

    prepared_cover: PreparedCover | None = None
    if cover is not None and cover.filename:
        cover_data = await read_upload_limited(cover, cover_max_bytes(), label="封面")
        if not cover_data:
            raise _bad_request("empty_file", "封面文件是空的")
        prepared_cover = prepare_cover(cover_data, cover.filename)

    if prepared_structure is None and prepared_cover is None:
        raise _bad_request("empty_upload", "既没有结构文件也没有封面，这个端点至少要带一个")

    # 到这一步两个附件都已经验证通过，落盘不会再因为「输入不合法」失败
    thread = _create_thread(db, account, payload)
    try:
        if prepared_structure is not None:
            store_structure(db, thread, prepared_structure)
        if prepared_cover is not None:
            store_cover(db, thread, prepared_cover)
        db.commit()
    except Exception:
        db.rollback()
        raise
    return _thread_detail(db, thread)


@router.get("/threads/{thread_id}", response_model=ThreadDetail)
def get_thread(thread_id: int, db: DBSession = Depends(get_db)) -> ThreadDetail:
    thread = _published_thread(db, thread_id)
    return _thread_detail(db, thread)


@router.post("/threads/{thread_id}/replies", response_model=ReplySummary,
             status_code=status.HTTP_201_CREATED)
def create_reply(thread_id: int, payload: ReplyCreate,
                 db: DBSession = Depends(get_db),
                 account: Account = Depends(require_account)) -> ReplySummary:
    thread = _published_thread(db, thread_id)
    reply = ForumReply(thread_id=thread.id, author_id=account.id, body=payload.body)
    db.add(reply)
    thread.last_activity_at = utcnow()
    db.commit()
    return ReplySummary(id=reply.id, author=account.username, body=reply.body,
                        created_at=reply.created_at)


# ----------------------------------------------------------------- 附件：读取

def _structure_of(db: DBSession, thread_id: int) -> ForumStructure:
    record = db.scalar(
        select(ForumStructure).where(ForumStructure.thread_id == thread_id)
    )
    if record is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "structure_not_found", "message": "这个帖子没有附带结构文件"},
        )
    return record


@router.get("/threads/{thread_id}/structure", response_model=ThreadStructure,
            summary="结构附件摘要与材料清单")
def get_thread_structure(thread_id: int,
                         db: DBSession = Depends(get_db)) -> ThreadStructure:
    _published_thread(db, thread_id)
    return _structure_view(_structure_of(db, thread_id))


# ----------------------------------------------------------------- 封面

def _cover_of(db: DBSession, thread_id: int) -> ForumCover:
    record = db.scalar(select(ForumCover).where(ForumCover.thread_id == thread_id))
    if record is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "cover_not_found", "message": "这个帖子没有封面"},
        )
    return record


@router.get("/threads/{thread_id}/cover", summary="帖子封面图")
def get_cover(thread_id: int, db: DBSession = Depends(get_db)) -> Response:
    """直接返回封面图片字节。

    这是全站**唯一**把用户上传的字节当「可直接渲染的内容」发出去的地方，
    所以这里的三道防线都不能省：

    1. `Content-Type` 取自**入库时按字节判定的结果**（`forum_covers.content_type`），
       不是用户给的文件名——上传时认不出文件头的文件根本进不了库；
    2. `X-Content-Type-Options: nosniff`，禁止浏览器「猜」成别的类型；
    3. `Content-Security-Policy: default-src 'none'; sandbox`，
       万一有人直接打开图片地址，它也只能作为一张图存在，不能变成可执行文档。

    图片用 `inline`（不是 attachment）：它就是要在页面里显示的内容。
    """
    _published_thread(db, thread_id)
    record = _cover_of(db, thread_id)
    try:
        data = read_cover(record.storage_path)
    except ForumStorageError as exc:
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail={"code": exc.code, "message": exc.message},
        ) from exc
    return Response(
        content=data,
        media_type=record.content_type,
        headers={
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            # 内容寻址：同一个 sha256 的字节永远不会变，可以放心长缓存
            "ETag": f'"{record.sha256}"',
            "Cache-Control": "public, max-age=31536000, immutable",
        },
    )


@router.delete("/threads/{thread_id}/cover", status_code=status.HTTP_204_NO_CONTENT,
               summary="删除帖子封面（作者或管理员）")
def delete_cover(thread_id: int, db: DBSession = Depends(get_db),
                 account: Account = Depends(require_account)) -> None:
    """能传就要能撤：传错图之后如果没有删除入口，那张图就永久留在帖子上了。

    权限与删帖、删回复同一套：作者本人，或 admin / superadmin。
    """
    thread = _published_thread(db, thread_id)
    if thread.author_id != account.id and not _can_moderate(account):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "not_owner", "message": "只能删除自己帖子的封面"},
        )
    record = _cover_of(db, thread_id)
    _remove_cover_blob(db, record)
    db.delete(record)
    db.commit()


@router.get("/threads/{thread_id}/structure/file", summary="下载原始 .mcstructure")
def download_structure(thread_id: int, db: DBSession = Depends(get_db)) -> Response:
    """下载帖子里那份原始文件。

    用户上传的是自己的建筑，愿意公开就该能被人拿走继续用。响应头固定
    `application/octet-stream` + `Content-Disposition: attachment` +
    `X-Content-Type-Options: nosniff`：即使有人把伪装成 .mcstructure 的
    HTML 传上来（解析器会拒），浏览器也不会按网页执行它。
    """
    _published_thread(db, thread_id)
    record = _structure_of(db, thread_id)
    try:
        data = read_structure(record.storage_path)
    except ForumStorageError as exc:
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail={"code": exc.code, "message": exc.message},
        ) from exc

    # 用 ASCII 回退名 + RFC 5987 的 filename*：中文文件名在各浏览器都能正确落盘
    ascii_name = "".join(
        ch if ch.isascii() and (ch.isalnum() or ch in "._-") else "_"
        for ch in record.original_name
    ) or "structure.mcstructure"
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": (
                f'attachment; filename="{ascii_name}"; '
                f"filename*=UTF-8''{quote(record.original_name, safe='')}"
            ),
            "X-Content-Type-Options": "nosniff",
            # 内容寻址：同一个 sha256 的字节永远不会变，可以放心长缓存
            "ETag": f'"{record.sha256}"',
            "Cache-Control": "public, max-age=31536000, immutable",
        },
    )


@router.get(
    "/threads/{thread_id}/structure/render",
    response_model=StructureRenderPayload,
    summary="3D 预览载荷",
)
def get_render_payload(
    thread_id: int, db: DBSession = Depends(get_db)
) -> StructureRenderPayload | Response:
    """返回浏览器端渲染 3D 预览所需的最小数据。

    载荷在**上传时**就 gzip 落盘（见 forum_storage.save_render），这里按
    客户端的 `Accept-Encoding` 决定是直接回压缩字节还是解压后回 JSON：
    大结构的载荷未压缩有几百 KB 到几 MB，而论坛帖子会被反复打开，
    每次都重新压一遍纯属浪费。
    """
    _published_thread(db, thread_id)
    record = _structure_of(db, thread_id)
    if not record.render_available or not record.render_path:
        summary = json.loads(record.summary_json)
        reason = (summary.get("render") or {}).get("reason") or "这个结构没有可用的 3D 预览"
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "render_unavailable", "message": reason},
        )
    try:
        packed = read_render_gz(record.render_path)
    except ForumStorageError as exc:
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail={"code": exc.code, "message": exc.message},
        ) from exc
    return Response(
        content=packed,
        media_type="application/json",
        headers={
            "Content-Encoding": "gzip",
            "Vary": "Accept-Encoding",
            "X-Content-Type-Options": "nosniff",
            "ETag": f'"{record.sha256}-r{RENDER_VERSION}"',
            "Cache-Control": "public, max-age=31536000, immutable",
        },
    )


# ----------------------------------------------------------------- 删除

def _can_moderate(account: Account) -> bool:
    """admin / superadmin 可审核删除任何内容（ADR-002 权限矩阵）。"""
    return account.role in ("admin", "superadmin")


def _remove_attachment_blob(db: DBSession, record: ForumStructure) -> None:
    """删帖子时清理附件文件——但只在没有别的帖子引用同一份内容时才删。

    内容寻址意味着两个帖子可能指向同一个 blob（同一个结构被两个人分别发）。
    直接 unlink 会让另一个帖子突然 410，属于最难查的那种「数据没坏但东西没了」。
    """
    others = db.scalar(
        select(func.count(ForumStructure.id)).where(
            ForumStructure.sha256 == record.sha256,
            ForumStructure.id != record.id,
        )
    )
    if others:
        return
    remove_files(record.storage_path, record.render_path)


def _remove_cover_blob(db: DBSession, record: ForumCover) -> None:
    """删封面文件——同样要先数引用（同一张图可能被多个帖子当封面）。"""
    others = db.scalar(
        select(func.count(ForumCover.id)).where(
            ForumCover.sha256 == record.sha256,
            ForumCover.id != record.id,
        )
    )
    if others:
        return
    remove_files(record.storage_path)


@router.delete("/threads/{thread_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_thread(thread_id: int, db: DBSession = Depends(get_db),
                  account: Account = Depends(require_account)) -> None:
    thread = _published_thread(db, thread_id)
    if thread.author_id != account.id and not _can_moderate(account):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "not_owner", "message": "只能删除自己的帖子"},
        )
    record = db.scalar(
        select(ForumStructure).where(ForumStructure.thread_id == thread_id)
    )
    if record is not None:
        _remove_attachment_blob(db, record)
        db.delete(record)
    cover = db.scalar(select(ForumCover).where(ForumCover.thread_id == thread_id))
    if cover is not None:
        _remove_cover_blob(db, cover)
        db.delete(cover)
    thread.status = "deleted"
    db.commit()


@router.delete("/replies/{reply_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_reply(reply_id: int, db: DBSession = Depends(get_db),
                 account: Account = Depends(require_account)) -> None:
    reply = db.get(ForumReply, reply_id)
    if reply is None or reply.status != "published":
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "reply_not_found", "message": "回复不存在"},
        )
    if reply.author_id != account.id and not _can_moderate(account):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "not_owner", "message": "只能删除自己的回复"},
        )
    reply.status = "deleted"
    reply.thread.last_activity_at = utcnow()
    db.commit()


def _thread_detail(db: DBSession, thread: ForumThread) -> ThreadDetail:
    replies = db.scalars(
        select(ForumReply)
        .where(ForumReply.thread_id == thread.id, ForumReply.status == "published")
        .order_by(ForumReply.created_at.asc(), ForumReply.id.asc())
    ).all()
    record = db.scalar(
        select(ForumStructure).where(ForumStructure.thread_id == thread.id)
    )
    cover = db.scalar(select(ForumCover).where(ForumCover.thread_id == thread.id))
    base = _thread_summary(
        db, thread, has_structure=record is not None, has_cover=cover is not None
    )
    return ThreadDetail(
        **base.model_dump(),
        body=thread.body,
        replies=[
            ReplySummary(id=r.id, author=_author_name(db, r.author_id),
                         body=r.body, created_at=r.created_at)
            for r in replies
        ],
        structure=_structure_view(record) if record is not None else None,
        cover=_cover_view(cover) if cover is not None else None,
    )
