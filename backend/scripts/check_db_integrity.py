"""检查 app.db 的外键完整性，并核对「只留站长与访客」之后的关联表。

为什么单独查一遍：整理账号时是直接用 SQL 删的行，而项目里其他会话/脚本
可能同时给数据库加了新表（例如论坛封面）。这里确认没留下悬空行，
也顺便列出各表还剩多少数据，避免把真实内容一起清掉。
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

DB = Path(__file__).resolve().parent.parent / "data" / "app.db"
con = sqlite3.connect(DB)
con.row_factory = sqlite3.Row

print(f"数据库：{DB}（{DB.stat().st_size} 字节）\n")

tables = [r[0] for r in con.execute(
    "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name")]

print("各表行数：")
for t in tables:
    n = con.execute(f"select count(*) from [{t}]").fetchone()[0]
    print(f"  {t:26} {n}")

print("\n外键完整性检查（PRAGMA foreign_key_check）：")
problems = con.execute("pragma foreign_key_check").fetchall()
if not problems:
    print("  没有问题：没有悬空外键。")
else:
    for row in problems:
        print("  !", dict(row))

print("\n账号与其关联数据：")
for a in con.execute("select id, username, role from accounts order by id"):
    aid = a["id"]
    parts = []
    for t in tables:
        cols = [c["name"] for c in con.execute(f"pragma table_info([{t}])")]
        if "account_id" in cols:
            n = con.execute(f"select count(*) from [{t}] where account_id=?", (aid,)).fetchone()[0]
            if n:
                parts.append(f"{t}={n}")
    print(f"  {aid:>3}  {a['username']:<10} {a['role']:<11} {' '.join(parts) or '（无关联数据）'}")

print("\n文档树与论坛（真实内容，应保留）：")
for label, sql in [
    ("已发布文档", "select count(*) from doc_documents"),
    ("已落盘文件", "select count(*) from doc_files"),
    ("文件夹", "select count(*) from doc_folders"),
    ("待审提交单", "select count(*) from doc_submissions"),
    ("论坛主题", "select count(*) from forum_threads"),
    ("论坛回复", "select count(*) from forum_replies"),
    ("结构附件", "select count(*) from forum_structures"),
]:
    exists = con.execute("select 1 from sqlite_master where type='table' and name=?",
                         (sql.split("from ")[1].split()[0],)).fetchone()
    if exists:
        print(f"  {label:12} {con.execute(sql).fetchone()[0]}")

con.close()
