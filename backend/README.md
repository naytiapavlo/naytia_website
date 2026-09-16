# backend · Python API

账号 / 论坛 / 工具箱收藏服务。技术决策见 `docs/plans/decisions/ADR-001-后端语言选型Python.md`，接口契约见 `docs/plans/03`。

## 运行

```bash
pip install -r requirements-dev.txt
copy .env.example .env    # 按需修改 NAYTIA_* 变量
uvicorn app.main:app --reload
```

- 交互式文档：<http://127.0.0.1:8000/docs>
- 健康检查：`GET /api/health`

## 模块

| 文件 | 职责 |
| --- | --- |
| `app/config.py` | 环境变量配置、版块与输入边界常量 |
| `app/db.py` | SQLAlchemy 引擎、会话、`get_db` |
| `app/models.py` | Account / AuthSession / ForumThread / ForumReply / ToolFavorite |
| `app/schemas.py` | pydantic 契约（OpenAPI 的单一事实源） |
| `app/security.py` | argon2id 哈希、会话令牌（库存 SHA-256） |
| `app/deps.py` | `get_current_account` / `require_account`（服务端鉴权） |
| `app/routers/` | auth（注册/登录/登出/me）、forum（列表/发帖/回复/删除）、favorites |

## 约定

- 权限在服务端判定：发帖/回复/收藏必须登录；删帖/删回复仅作者本人（软删除保留审计）。
- 分页用 `(last_activity_at, id)` keyset 游标，避免偏移量翻页时的抖动。
- 版块是站点级配置（`FORUM_CATEGORIES`），新增版块改配置不改表。
- 密码 argon2id 加盐哈希；Cookie 只携带随机令牌，数据库存其 SHA-256。
- 测试：`pytest`，每个用例使用独立临时 SQLite。

## 待办（阶段 4 联调）

- 基础限流（登录/发帖接口）。
- OpenAPI → 前端 TS 类型的生成脚本接入 CI（`npm run api:types`）。
- CORS 与 Cookie Secure 属性随部署环境（D07 托管选型）确认。
