"""论坛路由：未登录只读；登录后发帖/回复；作者可删除自有内容（01 文档第 7 节）。"""
import base64
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session as DBSession

from ..config import FORUM_CATEGORIES
from ..db import get_db
from ..deps import require_account
from ..models import Account, ForumReply, ForumThread, utcnow
from ..schemas import (
    PageResult,
    ReplyCreate,
    ReplySummary,
    ThreadCreate,
    ThreadDetail,
    ThreadSummary,
)

router = APIRouter(prefix="/api/forum", tags=["forum"])

PAGE_SIZE = 20


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


def _thread_summary(db: DBSession, thread: ForumThread) -> ThreadSummary:
    reply_count = db.scalar(
        select(func.count(ForumReply.id)).where(
            ForumReply.thread_id == thread.id,
            ForumReply.status == "published",
        )
    )
    return ThreadSummary(
        id=thread.id,
        category=thread.category_id,
        title=thread.title,
        author=_author_name(db, thread.author_id),
        reply_count=reply_count or 0,
        created_at=thread.created_at,
        last_activity_at=thread.last_activity_at,
    )


def _published_thread(db: DBSession, thread_id: int) -> ForumThread:
    thread = db.get(ForumThread, thread_id)
    if thread is None or thread.status != "published":
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "thread_not_found", "message": "帖子不存在"},
        )
    return thread


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
    items = [_thread_summary(db, t) for t in rows[:PAGE_SIZE]]
    next_cursor = _cursor_encode(rows[PAGE_SIZE - 1]) if has_more and rows else None
    return PageResult(items=items, next_cursor=next_cursor)


@router.post("/threads", response_model=ThreadDetail,
             status_code=status.HTTP_201_CREATED)
def create_thread(payload: ThreadCreate, db: DBSession = Depends(get_db),
                  account: Account = Depends(require_account)) -> ThreadDetail:
    thread = ForumThread(
        category_id=payload.category,
        title=payload.title,
        body=payload.body,
        author_id=account.id,
    )
    db.add(thread)
    db.commit()
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


@router.delete("/threads/{thread_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_thread(thread_id: int, db: DBSession = Depends(get_db),
                  account: Account = Depends(require_account)) -> None:
    thread = _published_thread(db, thread_id)
    if thread.author_id != account.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"code": "not_owner", "message": "只能删除自己的帖子"},
        )
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
    if reply.author_id != account.id:
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
    base = _thread_summary(db, thread)
    return ThreadDetail(
        **base.model_dump(),
        body=thread.body,
        replies=[
            ReplySummary(id=r.id, author=_author_name(db, r.author_id),
                         body=r.body, created_at=r.created_at)
            for r in replies
        ],
    )
