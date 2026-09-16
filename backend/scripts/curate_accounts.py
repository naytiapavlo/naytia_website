"""一次性的开发数据整理：清掉测试账号，只留「站长」与「访客」。

背景：正式发布前 data/app.db 里混了 17 个开发/测试期自动注册的账号
（toolcheck / e2e / probe / diag 等前缀，见 docs/plans/14 第 7 节的边界）。
文档树的 119 篇文档、论坛帖子与附件都不动——那些是真实内容。

做三件事：
1. 把 app.db 备份成 app.db.bak-<时间戳>（先备份，再动手）；
2. 注册一个 member 账号「访客」（走真实接口，口令是随机生成的，最后打印一次）；
3. 删除用户名匹配测试前缀的账号及其会话。

用法（在 backend/ 下执行）：
    python scripts/curate_accounts.py --dry-run   # 只列出会删谁
    python scripts/curate_accounts.py             # 实际执行
"""
from __future__ import annotations

import argparse
import shutil
import sqlite3
import sys
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

# 开发期测试脚本自动注册的用户名前缀（前端 tests/manual 与后端 e2e 脚本）
TEST_PREFIXES = ("toolcheck", "e2e", "probe", "diag", "bdiag", "pdiag", "ndiag", "cdiag")
KEEP = ("站长",)
VISITOR_NAME = "访客"


def is_test_account(username: str) -> bool:
    low = username.lower()
    return any(low.startswith(p) for p in TEST_PREFIXES)


def main() -> int:
    parser = argparse.ArgumentParser(description="清理开发期测试账号，保留真实内容")
    parser.add_argument("--dry-run", action="store_true", help="只列出会做什么，不改库")
    parser.add_argument("--visitor-password", default=None,
                        help="「访客」账号的口令；不给就随机生成并打印一次")
    args = parser.parse_args()

    from app.config import get_settings  # noqa: E402  需要先补 sys.path
    from app.db import SessionLocal  # noqa: E402
    from app.models import Account, AuthSession  # noqa: E402
    from app.security import hash_password  # noqa: E402

    db_path = Path(get_settings().sqlite_path)
    if not db_path.is_absolute():
        db_path = BACKEND / db_path
    if not db_path.exists():
        print(f"找不到数据库：{db_path}")
        return 1
    print(f"数据库：{db_path}（{db_path.stat().st_size} 字节）")

    if args.dry_run:
        con = sqlite3.connect(db_path)
        rows = con.execute("select id, username, role from accounts order by id").fetchall()
        con.close()
        keep = [r for r in rows if not is_test_account(r[1])]
        drop = [r for r in rows if is_test_account(r[1])]
        print(f"\n保留 {len(keep)} 个：")
        for r in keep:
            print(f"   {r[0]:>4}  {r[1]:<20} {r[2]}")
        print(f"\n将删除 {len(drop)} 个：")
        for r in drop:
            print(f"   {r[0]:>4}  {r[1]:<20} {r[2]}")
        print(f"\n还会注册一个 member 账号「{VISITOR_NAME}」（如果它还不存在）。")
        print("（--dry-run：没有改动任何东西）")
        return 0

    # 1) 先备份
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backup = db_path.with_suffix(db_path.suffix + f".bak-{stamp}")
    shutil.copy2(db_path, backup)
    print(f"已备份 → {backup}")

    # 2) 事务里删测试账号 + 会话（会话是 account_id 外键，先删会话）
    con = sqlite3.connect(db_path)
    con.execute("pragma foreign_keys = on")
    try:
        rows = con.execute("select id, username from accounts").fetchall()
        victims = [(i, u) for i, u in rows if is_test_account(u)]
        ids = [i for i, _ in victims]
        if ids:
            marks = ",".join("?" * len(ids))
            sessions = con.execute(
                f"delete from auth_sessions where account_id in ({marks})", ids
            ).rowcount
            # 收藏等其余关联表若存在也一并清理，避免留下悬空行
            for table, column in (("tool_favorites", "account_id"),):
                exists = con.execute(
                    "select 1 from sqlite_master where type='table' and name=?", (table,)
                ).fetchone()
                if exists:
                    con.execute(f"delete from {table} where {column} in ({marks})", ids)
            con.execute(f"delete from accounts where id in ({marks})", ids)
            con.commit()
            print(f"已删除 {len(ids)} 个测试账号与 {sessions} 条会话：")
            for i, u in victims:
                print(f"   {i:>4}  {u}")
        else:
            print("没有匹配到测试账号。")
    finally:
        con.close()

    # 3) 注册「访客」（走 ORM，复用项目的哈希实现）
    password = args.visitor_password
    generated = password is None
    if generated:
        import secrets
        password = secrets.token_urlsafe(9)

    db = SessionLocal()
    try:
        exists = db.query(Account).filter(Account.username_key == VISITOR_NAME.lower()).first()
        if exists:
            print(f"\n「{VISITOR_NAME}」已存在（id={exists.id}，role={exists.role}），未新建。")
        else:
            account = Account(username=VISITOR_NAME, username_key=VISITOR_NAME.lower(),
                              password_hash=hash_password(password), role="member")
            db.add(account)
            db.commit()
            print(f"\n已创建账号「{VISITOR_NAME}」（id={account.id}，role=member）")
            if generated:
                print(f"   口令（只显示这一次，请立刻记下）：{password}")
        print("\n当前账号清单：")
        for a in db.query(Account).order_by(Account.id).all():
            print(f"   {a.id:>4}  {a.username:<20} {a.role}")
    finally:
        db.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
