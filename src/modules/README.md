# src/modules · 前端模块边界（并行开发约定）

每个目录是一个**独立模块**，可以由不同的人/分支并行开发，互不阻塞。规则（与 `docs/plans/02` 分层一致）：

1. **唯一入口**：每个模块只通过 `index.ts` 导出公开 API。其他模块和页面 `import` 时只允许引用模块根（`modules/xxx`），禁止深入 `modules/xxx/内部文件`。
2. **无环依赖**：模块之间的依赖方向固定为
   `site-admin → account`、`site-admin → site-config`、`forum → account`、
   `admin-users → account`、`BaseLayout → account + site-config + admin-users`。
   `account`、`site-config` 互相不感知，也不感知 `site-admin` / `forum` / `admin-users`。
   （`forum` 只用 `account` 的会话与 `openAccountDialog`：遇到未登录时把登录入口
   递到用户手上，而不是让他自己去右上角找。）
3. **跨模块通信靠事件**：会话变化由 `account` 广播 `naytia:session` 事件（detail 为账号或 null），订阅方自行响应——`site-admin` 据此挂载/卸载编辑面板。
4. **静态优先**：模块失败（后端离线、接口报错）时页面必须保持内置默认值可用，不得阻塞首屏。
5. **共享基础能力放 `src/shared/`**（api-client、toast）；只有 ≥2 个模块确需复用才进来，不放业务逻辑。

## 现有模块

| 模块 | 职责 | 公开接口（index.ts） |
| --- | --- | --- |
| `site-config` | 主页动态内容：类型、默认值、API、渲染挂钩（背景/头像/文字） | `fetchSiteConfig / saveSiteConfig / mergeConfig / applyConfig / 类型` |
| `account` | 会话：登录/注册/退出、导航角标、角色徽章、登录弹窗入口、`naytia:session` 事件 | `me / login / logout / register / currentSession / mountAccountChip / openAccountDialog / SESSION_EVENT` |
| `site-admin` | 超级管理员的主页编辑面板（实时预览、保存发布） | `initSiteAdmin` |
| `mcstructure` | 基岩版结构文件（.mcstructure）的上传与解析结果访问；类型来自 `ports/api-schema` | `parseStructure / fetchVoxels / fetchSlice / lookupPosition / fetchBlocks / fetchInfo / summarize / positionToIndex / formatBytes / 类型` |
| `forum` | 论坛帖子读写（列表/详情/发帖/回复/删除）+ 随帖附件（结构文件的材料清单与 3D 预览、封面图） | `mountForum / 完整渲染核心（decodeRenderPayload / buildShell / planFrame / viewBasis / fitView）/ mountVoxelView / blockColor / 展示层格式化（含封面尺寸与裁切提醒）/ API 与类型` |
| `works` | 作品页展示数据（封面滚动 / 研究时间轴 / B 站成果清单）与客户端增强（封面灯箱、时间轴进度） | `showcaseItems / timelineEntries / videoWorks / initWorksShowcase / 类型` |
| `docs` | 文档树（`/docs/`）：目录树、Markdown 渲染、搜索、管理员上传与投稿（含移动/删除申请）、超管审核队列与直接整理目录 | `initDocsView / renderDocument / docsApi / uploadFile / 标签常量 / 类型` |
| `admin-users` | 超管的账号管理页（`/admin/users/`）：按名字搜索、设为/取消管理员，以及导航栏入口 | `initAdminUsers / mountAdminNav / fetchAccounts / setAdmin / rowCapability / matchesSearch / roleLabel / roleCounts / togglePrompt / toggleDone / 类型` |

工具系统不在这里：`src/tools/` 自成一套（宿主 `_host/` + 每工具一个目录），
因为工具的扩展单位是「一个工具目录」，与页面级模块的划分方式不同。
工具与账号的联动只通过公开接口（`modules/account` 的会话与 `naytia:session` 事件）完成。

## 后端对应

`backend/app/` 同样按模块切分：`routers/auth.py + models/account.py`（账号）、`routers/forum.py + models/forum.py`（论坛，含帖子结构附件）、`routers/favorites.py + models/favorites.py`（工具箱）、`routers/site_config.py + models/site.py`（站点配置）、`routers/admin.py`（角色与账号管理，依赖账号模块，见 ADR-010）、`routers/mcstructure.py + parsers/mcstructure.py`（结构文件解析，见 ADR-003）、`routers/docs.py + models/docs.py + docs_storage.py + review_flow.py`（文档树与「投稿—审核—发布」，见 ADR-007）、`forum_storage.py`（附件落盘，见 ADR-006）。跨模块只通过公开路由/模型导出引用；数据库表结构变更只发生在归属模块的 models 文件里。
`uploads.py` 是**纯基础设施**的共用件（文件名清洗、带上限的读取）：结构解析接口与论坛附件都从这里取规则——各写一份迟早漂移，而这里漂移的后果是路径穿越或响应头注入。
文档树的落盘规则在同层的 `docs_storage.py`（内容寻址 + 分块上传），它自带一份更严格的扩展名白名单（只收 md/txt/json）。

## 契约（跨语言类型）

前端不手写与后端重复的字段定义：后端 pydantic 生成 OpenAPI，前端 `npm run api:types`
生成 `src/ports/api-schema.d.ts`，模块从那里取类型（ADR-001）。详见 `src/ports/README.md`。
