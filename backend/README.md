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
| `app/models/` | 按模块拆表：account（Account/AuthSession）、forum、favorites、site |
| `app/schemas.py` | pydantic 契约（OpenAPI 的单一事实源） |
| `app/security.py` | argon2id 哈希、会话令牌（库存 SHA-256） |
| `app/deps.py` | `get_current_account` / `require_account` / `require_role`（服务端鉴权） |
| `app/routers/` | auth（注册/登录/登出/me）、forum（列表/发帖/回复/删除）、favorites、admin（角色与账号管理，见 ADR-010）、site_config |
| `app/nbt_le.py` | 小端 NBT 读取器（Bedrock 口径），只用标准库 |
| `app/parsers/` | 外部文件格式的语义解析：`mcstructure`（基岩版结构文件，见 ADR-003） |
| `app/schemas_mcstructure.py` | 结构文件解析接口的 pydantic 契约 |
| `app/routers/mcstructure.py` | `.mcstructure` 只读解析接口 |
| `app/models/docs.py` | 文档树的表：folders / documents / files / revisions / submissions（见 ADR-007） |
| `app/docs_storage.py` | 文档树落盘：受控目录、文件名清洗、分块上传、内容寻址 |
| `app/review_flow.py` | 「提交单 → 目录树」的发布流程；路径操作（移动/重命名/删除）的唯一实现 |
| `app/direct_actions.py` | 超管的直接操作（移动/重命名/删除立即生效 + 审计记录） |
| `app/schemas_docs.py` | 文档树接口的 pydantic 契约 |
| `app/routers/docs.py` | 文档树接口：公开读 + 管理员提交 + 超管审核与直接操作 |
| `scripts/import_docs.py` | 首版资料导入（幂等，支持 `--dry-run`） |

## 约定

- 权限在服务端判定：发帖/回复/收藏必须登录；删帖/删回复仅作者本人（软删除保留审计）。
- 分页用 `(last_activity_at, id)` keyset 游标，避免偏移量翻页时的抖动。
- 版块是站点级配置（`FORUM_CATEGORIES`），新增版块改配置不改表。
- 密码 argon2id 加盐哈希；Cookie 只携带随机令牌，数据库存其 SHA-256。
- 测试：`pytest`，每个用例使用独立临时 SQLite。

## 结构文件解析（`.mcstructure`）

只读接口，用于解析基岩版结构文件，包含方块实体 NBT 与实体 NBT：

```bash
# 需要 python-multipart（已列入 requirements.txt）
curl -F "file=@house.mcstructure" "http://127.0.0.1:8000/api/mcstructure/parse?include_voxels=true"
```

| 接口 | 作用 |
| --- | --- |
| `GET /api/mcstructure/info` | 能力边界与当前限制（公开只读） |
| `POST /api/mcstructure/parse` | 上传并解析，返回索引 + 统计；`include_voxels` / `include_raw` 按需 |
| `POST /api/mcstructure/voxels` | 只取完整方块索引数组 |
| `POST /api/mcstructure/slice` | 只取某一轴薄片（`axis` + `at` + `layer`） |
| `POST /api/mcstructure/position` | 坐标 ↔ 位置下标互查，并返回该格各层方块 |
| `POST /api/mcstructure/blocks` | 方块实体 / 实体分页列表 |

关键口径（决策与理由见 `docs/plans/decisions/ADR-003`）：

- **小端**：Bedrock 的 NBT 是小端，与 Java 的大端不同。`app/nbt_le.py` 是自实现读取器，
  不依赖第三方库——已装的 `rapidnbt` 实测只输出大端，`bedrock_protocol.nbt` 当前版本 import 即失败。
- **位置下标按 ZYX 顺序**：`index = x * (sizeY * sizeZ) + y * sizeZ + z`，从结构底部西北角开始。
- **两层共位**：`block_indices` 恰好两个子列表；`-1` 为 void（结构空位）。
- **结构原点**：`world_origin` 附 `world_origin_source` 标明取自哪里——真实文件把它放在**根层级**
  （`'root'`），bedrock.dev 文档写在 `structure` 内部（`'structure'`）。两处都支持，缺失时为 `null`。
- **索引与体素分离**：默认不返回完整方块数组（大结构可达百万级），按需请求。
- **上传边界**：内容不落盘、不写日志；上限由 `NAYTIA_MCSTRUCTURE_MAX_BYTES`（默认 32 MB）
  与 `NAYTIA_MCSTRUCTURE_MAX_VOXELS`（默认 16,777,216）控制。
- **不丢数据**：未建模字段保留在 `raw_nbt` / `extra_root_fields`；越界调色板下标按游戏口径
  视为空气，但单独计数而不是替用户改写。

## 文档树（`/api/docs/*`）

访客可读、管理员投稿、超级管理员审核发布的知识库。决策与理由见
`docs/plans/decisions/ADR-007-文档树与审核发布流程.md`，实装记录见 `docs/plans/12-开发日志-文档树工具.md`。

权限矩阵（服务端强制，前端隐藏按钮只是界面便利）：

| 身份 | 能做什么 |
| --- | --- |
| 访客（未登录） | 读已发布且 `visibility=public` 的目录、正文、搜索、下载 |
| 登录会员 | 同上（`members` 限定的内容也对会员开放） |
| admin | 会员能力 + 上传文件、新建文件夹、**移动/删除（作为提交单）**、看自己的投稿状态 |
| superadmin | 上述全部 + 直接发布 + **立即移动/重命名/删除** + 审核他人提交单 |

| 接口 | 作用 |
| --- | --- |
| `GET /api/docs/info` | 能力边界与当前限制（公开） |
| `GET /api/docs/permissions` | 当前账号在本工具的能力（前端据此显示控件） |
| `GET /api/docs/tree` | 目录树（只给元数据，不含正文） |
| `GET /api/docs/search?q=` | 全文子串搜索（只搜有权阅读的内容） |
| `GET /api/docs/documents/{id}` | 正文 + 版本信息 |
| `GET /api/docs/files/{id}/download` | 下载原始文件（先判定可见性） |
| `GET /api/docs/files/{id}/content?disposition=inline` | 内联读取（txt/json 的原始文本视图） |
| `POST /api/docs/uploads` → `/chunks?index=n` → `/finish` | 分块上传（staff） |
| `POST /api/docs/uploads/direct` | 一次性上传（脚本与小文件，staff） |
| `POST /api/docs/submissions` | 提交变更单（staff；**不直接改线上内容**）。`action` 取 `create_doc` / `update_doc` / `move_doc` / `create_folder` / `move_folder` / `delete_doc` / `delete_folder` |
| `GET /api/docs/submissions?scope=mine\|pending` | 我的提交 / 待审列表（移动类会带 `target_path`） |
| `POST /api/docs/submissions/{id}/withdraw` | 撤回自己的待审提交 |
| `POST /api/docs/review/{id}?decision=approve\|reject&note=` | 审核（仅超管） |
| `POST /api/docs/documents/{id}/move` | **移动文档**（仅超管，立即生效） |
| `POST /api/docs/documents/{id}/rename` | **改文档标题**（仅超管） |
| `DELETE /api/docs/documents/{id}?note=` | **删除文档**（仅超管，修订一并删除） |
| `POST /api/docs/folders/{id}/move` | **移动文件夹（含子树）**（仅超管） |
| `POST /api/docs/folders/{id}/rename` | **重命名文件夹（连带子树路径）**（仅超管） |
| `DELETE /api/docs/folders/{id}?note=` | **删除文件夹及其内容**（仅超管，返回连带篇数） |

关键口径：

- **写操作一律走提交单**：管理员上传/新建/移动/删除只写 `doc_submissions`（`pending`），
  超管批准时由 `review_flow.apply_submission()` 落库。批准时会重新校验目标是否还在、
  路径是否冲突——冲突就把提交单标成 `rejected` 并写明原因，不写坏目录树。
- **管理员的移动/删除是申请，超管的是立即生效**：两条路径最终调用 `review_flow` 里
  **同一批**函数（`move_document` / `move_folder` / `rename_*`），所以行为一致，
  差别只在「要不要等审核」。超管的直接操作也会写一条 `status=approved` 的提交单作为审计记录
  （谁、什么时候、把什么挪到了哪里）。
- **文件夹移动/重命名会重写整棵子树的 `path_key`**（邻接表 + 物化路径的代价）：
  `review_flow.rewrite_folder_paths()` 是唯一实现。不这么做，子树里的文档
  `path_key` 会指向一条已不存在的路径——表现是「导入脚本认不出它们、再导一次就多出一份」。
- **不允许把文件夹移进自己或自己的子树**（`move_into_self`）：那会让子树成为孤岛，
  显示路径算不出来、递归遍历会死循环。
- **移动到已有同 slug 的目录时自动加 `-2` 后缀**，不覆盖目标目录里的同名文档。
- **删除文件夹有爆炸半径上限**：子树内文档超过 200 篇会被拒绝（`cascade_too_large`），
  避免一次误批清空整个知识库。超管直接删除时同样受这个上限约束。
- **可见性只有一个过滤器**：`routers/docs.py::Viewer`。目录树、正文、搜索、下载四条读路径
  全走它，草稿只有 staff 与提交人本人可见（有测试盯着「拿到文件 id 直接下载草稿」这条绕过路径）。
- **只收文本**：`docs_storage.ALLOWED_EXTENSIONS` = `.md` / `.markdown` / `.txt` / `.json`，
  单文件上限 `NAYTIA_DOCS_MAX_BYTES`（默认 8 MB）。
- **落盘 + 内容寻址**：文件存 `<storage_root>/documents/<sha256 前两位>/<sha256>.<ext>`，
  库里只存相对路径、体积、摘要；`storage_path` 不出现在任何响应里。删除文档不删磁盘文件
  （同一份内容可能被别的文档引用），靠内容寻址去重。

首版资料导入（在 `backend/` 下执行）：

```bash
python scripts/import_docs.py --dry-run     # 先看会导入什么
python scripts/import_docs.py               # 收录 md/txt/json，幂等；默认资料目录见脚本头部
python scripts/import_docs.py --root "D:\资料" --imported-by 站长
```

脚本以超管身份运行，导入的内容**直接是已发布状态**（等价于超管审核通过）；
管理员之后上传的内容仍然要走提交单审核。

## 账号管理（`/api/admin/*`）

超管的账号管理页（前端 `/admin/users/`）的后端。三个接口全部在
`require_superadmin` 之下——**管理员（admin）也不行**：管理内容不等于管理账号。

| 接口 | 作用 |
| --- | --- |
| `GET /api/admin/accounts?q=` | 账号列表；`q` 为按名字的模糊搜索（大小写不敏感的子串匹配，不传则返回全部） |
| `PUT /api/admin/accounts/{id}/admin` | `{"enabled": bool}` → 设为 / 取消管理员（admin ↔ member） |
| `PUT /api/admin/accounts/{id}/role` | 调整角色（含 `superadmin`；保留原有的强接口语义） |

关键口径（决策与理由见 `docs/plans/decisions/ADR-010-账号管理界面.md`）：

- **搜索在 SQL 里做，并且转义 LIKE 通配符**：`_` / `%` / `\` 不转义的话，搜一个
  下划线会命中**所有**账号，界面上就成了「搜什么都有」。匹配 `username_key`
  （注册时已转小写），中文不受影响。
- **`/admin` 只映射 admin 与 member 两档**：一个「给不给管理员」的开关，契约上就不该
  具备把别人提成超管的能力（超管只能由引导规则或邀请码产生，ADR-002）。
  `enabled` 是 `strict=True` 的布尔——`"false"` 这类字符串在 422 失败，而不是被 Python
  的真值判断悄悄当成 True（那会让「取消管理员」执行成「设为管理员」）。
- **超管档位默认不接受改动**（`is_superadmin`）：超管本来就拥有管理员的全部能力，
  把它降下来是纯粹的权限损失，只可能来自误操作。
- **超管不能改自己的角色**（`self_role_change`）：降完自己就没有人能再提权了
  （邀请码只在注册时生效，站上没有自助恢复超管的入口）。这条与上一条合起来保证
  场上永远至少留着一个超管；`/role` 里 `_superadmin_count <= 1` 那道判断是同一件事的
  **第二层兜底**（当前从 API 出发不可达，见 ADR-010）。
- 两条改角色的路径共用 `_writable_target()`，避免其中一条漏判。

测试：`backend/tests/test_admin_users.py`（16 项）。

## 待办（阶段 4 联调）

- 基础限流（登录/发帖接口）。
- OpenAPI → 前端 TS 类型的生成脚本接入 CI（`npm run api:types`）。
- CORS 与 Cookie Secure 属性随部署环境（D07 托管选型）确认。
- 结构文件解析：已用真实游戏导出文件验证（`tests/fixtures/real/`）；遇到新的格式差异时按
  该目录 README 的约定补样例——手工夹具无法发现「文档与真实实现不一致」。
