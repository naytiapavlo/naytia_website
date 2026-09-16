# Naytia 的像素小站

Naytia_帕芙洛的个人网站：博客、作品、Minecraft 玩家工具箱与玩家论坛。白色像素风，静态内容 + Python API 的模块化单体。

规划与决策文档在 [`docs/plans/`](docs/plans/README.md)，动工前先读它。

## 技术栈

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 前端 / 内容 | Astro 5 + TypeScript（strict） | 内容集合管理博客与作品；工具工作区用原生 TS + DOM（暂无 React，复杂交互出现时再评估） |
| 后端 | Python 3.11 + FastAPI | 账号 / 论坛 / 收藏三类 API（ADR-001） |
| 数据库 | SQLite（SQLAlchemy 2.x） | 保留 Postgres 迁移路径，仓储不暴露 SQL 方言 |
| 契约 | OpenAPI → openapi-typescript | 后端 pydantic 生成 OpenAPI，前端 TS 类型由其生成 |

## 目录结构

```text
docs/plans/               # 规划、契约、ADR、开发日志（文档唯一来源）
prototypes/               # 原型存档：pixel-demo（手写静态 Demo）、ida-demo（工作台界面原型）
content/
  posts/                  # 博客（Markdown + frontmatter，draft 不进构建）
  works/                  # 作品（含视频外链、标签）
public/                   # 可公开静态文件（头像等）
src/
  pages/                  # 路由：/ /blog /works /tools /tools/[slug] /forum /ida /docs /admin/users /404
  layouts/                # BaseLayout 公共页壳（导航、图标 sprite、页脚）
  components/ui/          # PageHeading、EmptyState 等基础组件
  config/site.ts          # SiteConfig：头像、简介、导航、首页入口排序
  styles/                 # tokens.css 设计变量 + base.css 基础样式 + tools.css
  content.config.ts       # 内容集合 schema（zod 校验）
  tools/                  # 工具箱：宿主 + 各工具目录
    _host/                # 宿主：契约、加载、校验→执行管线、UI 共用件、收藏
    manifests.ts          # 有 /tools/<slug>/ 详情页的工具（宿主据此生成路由）
    catalog.ts            # 目录清单 = 站内工具 + 外部入口（如 /ida/）
    registry.ts           # slug → 工具实现（懒加载，新工具在此登记一行）
    mcstructure-editor/   # .mcstructure 编辑器（含浏览器侧小端 NBT 读取器/写入器）
  modules/
    account/ site-config/ site-admin/  # 账号会话、站点配置、超管编辑面板
    forum/                # 论坛：帖子读写 + 附件（结构文件的材料清单与 3D 预览、封面图）
      voxel.ts            #   3D 渲染核心（纯计算：协议解码、面剔除、投影排序）
      voxel-view.ts       #   canvas 控件（拖动旋转、滚轮缩放、分层查看）
      block-colors.ts     #   方块 → 示意色（精确表 + 家族规则 + 名称散列兜底）
      api.ts present.ts ui.ts index.ts
    mcstructure/          # .mcstructure 解析 API 的客户端（类型来自 ports/api-schema）
    reverse/              # 逆向工作台界面（/ida/：函数列表、伪代码、反汇编、引用）
    docs/                 # 文档树（/docs/：目录树、Markdown 渲染、投稿、审核队列）
      markdown.ts         #   自实现 Markdown → DOM（全程 createElement，无 innerHTML）
      api.ts ui.ts index.ts
    admin-users/          # 超管的账号管理页（/admin/users/：搜索、设为/取消管理员）
      rules.ts            #   纯规则（匹配口径、行可操作性），可脱离 DOM 测试
      api.ts ui.ts index.ts
    works/                # 作品页：封面滚动 + 研究时间轴 + B 站成果清单 + 封面灯箱
      data.ts             #   展示数据（改内容不改模板）
      ui.ts index.ts      #   客户端增强（灯箱、时间轴进度）
    blog/                 # 模块占位（阶段 2 充实查询与展示）
  ports/
    api-schema.d.ts       # 后端 OpenAPI 生成的 TS 类型（npm run api:types，不手写）
  shared/                 # api-client、toast 等确有两个以上使用者的能力
  domain/ adapters/       # 占位：纯领域类型、适配器（02 文档分层）
backend/
  app/                    # FastAPI 应用（config/db/models/schemas/routers）
    nbt_le.py             # 小端 NBT 读取器（Bedrock 口径，纯标准库）
    uploads.py            # 上传共用规则：文件名清洗、体积格式化、带上限的读取
    forum_storage.py      # 论坛附件落盘（内容寻址，路径不出接口；structures/ 与 covers/）
    docs_storage.py       # 文档树落盘（内容寻址 + 分块上传 + 只收 md/txt/json）
    review_flow.py        # 文档树「提交单 → 目录树」的发布流程（超管批准后写库）
    parsers/              # 外部文件格式的语义解析（mcstructure + 渲染载荷 + 图片字节识别）
    reverse/              # 逆向工作台：IDA MCP 客户端 + 归一化 + 路由
  scripts/                # import_docs.py：首版文档导入（幂等、支持 --dry-run）
  tests/                  # pytest：认证、论坛、附件、收藏、角色、站点配置、结构解析、逆向、文档树
    fixtures/             # 测试夹具：.mcstructure（独立写入器 + nbtlib 自校验）、
                          # 图片字节（含改名 HTML / 内嵌脚本 SVG 等攻击样本）
  requirements*.txt       # 依赖清单（含 dev）
tests/                    # 前端测试：结构编辑器/SNBT/3D 渲染核心 + manual/（浏览器验证）
deploy/                   # 正式发布：本地同源入口 + 启动脚本 + 其自身的对照测试
  server.py               #   静态产物 + /api 反向代理（127.0.0.1:8080，隧道指向它）
  test_server.py          #   真实 IP 解析、转发首部、路径映射的对照用例
  start-all.cmd           #   一键：构建 + 开两个窗口（后端 8000、入口 8080）
  start-backend.cmd       #   后端：uvicorn，只监听回环 + 信任本机代理头
  start-site.cmd          #   入口：8080
scripts/ dist/            # 构建期脚本（占位）、构建产物（不入库）
```

## 部署（正式域名 + 内网穿透）

完整步骤、验收清单与已知边界见 [`docs/plans/14-部署手册-域名与内网穿透.md`](docs/plans/14-部署手册-域名与内网穿透.md)，
架构取舍见 [`ADR-009`](docs/plans/decisions/ADR-009-同源单端口部署与内网穿透.md)。一句话版本：

```bash
# 构建 → 开两个窗口 → 樱花隧道指向 127.0.0.1:8080
# 正式域名 www.naytia.io 已写在根目录 .env 的 SITE_URL（换域名改这一行后重新构建）
deploy\start-all.cmd
```

**为什么不是隧道直接指向前端或后端**：站点是「静态产物 + Python API」两半，
浏览器必须把它们看成**同一个来源**，否则会话 Cookie（`SameSite=Lax`）会被拦掉。
所以中间加了一层本地入口，用一个端口同时承载两者——静态文件走磁盘，`/api` 转给后端。

| 地址 | 谁在听 | 说明 |
| --- | --- | --- |
| `127.0.0.1:8080` | `deploy/server.py` | **隧道指向这里**；只监听回环 |
| `127.0.0.1:8000` | FastAPI | 由入口转发，不直接对外 |
| `127.0.0.1:4321` | Astro dev | 仅本地开发用 |

入口自己的对照测试（真实 IP、转发首部、路径映射）：

```bash
python deploy\test_server.py
```

## 本地开发

前端（Astro，默认 <http://localhost:4321>）：

```bash
npm install
npm run dev        # 开发服务器
npm run build      # 生产构建 → dist/
npm run check      # astro check 类型检查
npm test           # 工具引擎对照测试（Node 内置 test runner，无额外依赖）
```

后端（FastAPI，默认 <http://127.0.0.1:8000>，交互文档在 `/api/docs`，契约在 `/api/openapi.json`）：

```bash
cd backend
pip install -r requirements-dev.txt
copy .env.example .env   # Windows；macOS/Linux 用 cp
uvicorn app.main:app --reload
```

后端测试（独立临时库，不影响真实数据）：

```bash
cd backend
pytest
```

前端类型对接后端契约（先启动后端，再执行）：

```bash
npm run api:types   # OpenAPI → src/ports/api-schema.d.ts（后端接口文档在 /api/docs）
```

> 后端端口被占用时也可以不走网络：在 `backend/` 下用
> `python -c "import json,sys;sys.path.insert(0,'.');from app.main import app;json.dump(app.openapi(),open('../openapi.json','w',encoding='utf-8'))"`
> 导出 `openapi.json`，再执行 `npx openapi-typescript openapi.json -o src/ports/api-schema.d.ts`。

## 结构文件解析接口（.mcstructure）

基岩版结构文件的**只读**解析接口，可解析完整结构、方块实体 NBT 与实体 NBT：

```bash
curl -F "file=@house.mcstructure" \
  "http://127.0.0.1:8000/api/mcstructure/parse?include_voxels=true"
```

| 接口 | 作用 |
| --- | --- |
| `GET /api/mcstructure/info` | 能力边界与当前限制 |
| `POST /api/mcstructure/parse` | 上传并解析：索引 + 统计（体素/原始 NBT 按需） |
| `POST /api/mcstructure/voxels` | 完整方块索引数组 |
| `POST /api/mcstructure/slice` | 某一轴薄片 |
| `POST /api/mcstructure/position` | 坐标 ↔ 位置下标互查 |
| `POST /api/mcstructure/blocks` | 方块实体 / 实体分页列表 |

前端类型由 OpenAPI 生成，客户端模块为 `src/modules/mcstructure/`。

**注意边界**：这是全站**需要上传文件**的功能之一，与工具箱「计算在浏览器本地完成、
输入不上传」的默认口径不同；上传内容不落盘、不写日志。决策与理由见
[`docs/plans/decisions/ADR-003`](docs/plans/decisions/ADR-003-基岩版结构文件解析器.md)。
另一处需要上传的是论坛的帖子附件（见下节），两者共用 `backend/app/uploads.py`
里的读取上限与错误码。

## 论坛的附件与 3D 预览

发帖时可以随帖带上两类附件，各自独立可选：

- **`.mcstructure` 结构文件（≤10 MB）**：服务端用上面那个内置解析器解析出**材料清单**
  （按「方块排列」统计：同一个方块带不同朝向算两行；空气不算材料，但原始计数单列出来不藏），
  并在上传时另存一份「占用位图 + 调色板下标」的轻量载荷。
  网页端用**自实现的 Canvas 2D 体素渲染器**把结构画出来（约 600 行、零依赖，
  不引 three.js）：拖动旋转、滚轮缩放、分层查看、自动旋转，键盘也能操作。附件可以下载。
- **封面图片（≤5 MB，PNG / JPEG / GIF / WebP）**：列表卡片显示 16:9 缩略图，
  详情页顶部显示原图；作者与管理员可以删除。

| 接口 | 作用 |
| --- | --- |
| `GET /api/forum/categories` | 版块清单（前端不硬编码版块名） |
| `POST /api/forum/threads/with-attachments` | 发帖 + 上传附件（multipart，两个文件都可选） |
| `GET /api/forum/threads/{id}/structure` | 结构摘要与材料清单 |
| `GET /api/forum/threads/{id}/structure/render` | 3D 预览载荷（上传时已 gzip） |
| `GET /api/forum/threads/{id}/structure/file` | 下载原始 `.mcstructure` |
| `GET /api/forum/threads/{id}/cover` | 封面图 |
| `DELETE /api/forum/threads/{id}/cover` | 删除封面（作者或管理员） |

**封面的类型只认文件头字节，不看文件名**：封面是全站唯一把用户上传的字节当
「可直接渲染的内容」发出去的地方，只信文件名的实现会让一个叫 `cover.png` 的 HTML
被浏览器当网页执行。所以类型由 `backend/app/parsers/image_info.py`（纯标准库）
按魔数判定，**SVG 一律拒绝**（可内嵌脚本），并提供 `nosniff` 与
`Content-Security-Policy: default-src 'none'; sandbox`。

**诚实边界**：3D 预览里的颜色是**示意色**（按方块名生成，不打包游戏贴图资源），
用途是看清形状与材质分区，不是还原游戏画面；可见面超过 20 万时会按坐标抽稀并在界面上
说明抽了多少。封面**不做服务端压缩**（不引入 Pillow），按原图保存。
目前**没有存储配额与限流**，单文件 10 MB / 封面 5 MB 是唯一硬边界。
决策见 [`ADR-006`](docs/plans/decisions/ADR-006-论坛结构附件与网页3D预览.md)，
实装与验证证据见 [`10-开发日志`](docs/plans/10-开发日志-论坛结构附件与3D预览.md)。

## 文档树（/docs/）

按目录浏览机制研究与逆向笔记的知识库：**访客可公开阅读与搜索**，
**管理员可以上传文件、新建文件夹**，但改动以「提交单」形式排队，
**由超级管理员审核通过后才真正对访客开放**。

| 身份 | 能做什么 |
| --- | --- |
| 访客（未登录） | 读已发布且可见性为「所有人」的目录、正文、搜索、下载原文件 |
| 登录会员 | 同上（「仅登录会员」的内容也对会员开放） |
| 管理员 admin | 上传 md/txt/json（≤8 MB）、新建文件夹、**移动与删除（作为申请提交）**、看自己的投稿状态 |
| 超级管理员 | 上述全部 + 上传即发布 + **立即移动/重命名/删除** + 审核他人的提交单（批准 / 驳回并留意见） |

界面：左侧是可折叠目录树 + 搜索框，右侧是正文（Markdown 渲染、本页目录、下载原文件）。
staff 在每个目录节点与正文上都有整理入口：**移动到某个文件夹 / 改标题 / 删除**。
管理员**没有**在线编辑正文的界面——需求就是「给他们上传权限」，改动靠重新上传 + 提交单；
管理员的移动与删除会作为**申请**进队列，超管批准才生效，超管自己点则立即生效。

```bash
# 首版资料导入（在 backend/ 下执行；幂等，重复运行只会更新有变化的文件）
python scripts/import_docs.py --dry-run     # 先看会导入什么
python scripts/import_docs.py               # 默认收录 md/txt/json；--root 换目录
```

首版已导入 `Minecraft\doc` 的 **120 篇文档 / 8 个文件夹**（58 md、51 txt、14 json，
同内容去重后 116 个落盘文件；`.html` 与 `.bak` 被明确跳过并列出）。

**诚实边界**：首版**只收文本**（md/txt/json），二进制附件不碰；
不提供在线编辑正文（管理员连标题也不能改，超管可以改标题与文件夹名）；
不做行级 diff；没有上传配额与限流（靠 8 MB 上限与管理员门槛兜底）；搜索是子串匹配；
删除文档不会清理磁盘上的内容寻址文件（同一份内容可能被别处引用）。
决策见 [`ADR-007`](docs/plans/decisions/ADR-007-文档树与审核发布流程.md)，
实装与验证证据见 [`12-开发日志`](docs/plans/12-开发日志-文档树工具.md)。

## 逆向工作台（/ida/）

在线浏览 Minecraft 基岩版服务端（BDS）的反汇编与 Hex-Rays 伪代码。后端**代理本机 `ida-pro-mcp`**
（IDA Pro MCP 插件，默认 `http://127.0.0.1:13337/mcp`），不引入 MCP SDK。

**前置条件**：IDA Pro 已打开、已加载目标 IDB（如 `bedrock_server.exe.i64`）且 MCP 插件在运行。
后端必须与 IDA 在**同一台机器**上。相关环境变量（`backend/.env`）：

```bash
NAYTIA_IDA_MCP_URL=http://127.0.0.1:13337/mcp   # MCP 端点
NAYTIA_IDA_DEFAULT_PORT=13337                    # 未指定实例时用哪个
NAYTIA_IDA_ALLOWED_PORTS=                        # 可选：实例端口白名单，留空=全部
```

从**工具箱**目录的「BDS 逆向工作台」卡片进入（该卡片只对 admin 及以上显示）。

界面为仿 IDA 的多面板布局：左栏 **函数 / 字符串 / 段** 三个页签，主区 **伪代码 / 反汇编 / 交叉引用 / 栈变量 / 基本块** 五个页签，
底部状态栏显示模块、基址、权限与 IDB 路径。伪代码里 Hex-Rays 的行内地址（`/*0x…*/`）可点击跳转；
支持键盘操作（`↑↓`/`JK` 翻函数、`1`–`5` 切页签、`/` 搜索、`G` 跳地址、`C` 复制、`?` 帮助）。

| 能力 | 访客 / 会员 | admin / superadmin |
| --- | --- | --- |
| 状态、二进制概览、函数列表、伪代码、反汇编、交叉引用、栈变量、字符串搜索 | ✅ | ✅ |
| 切换 IDA 实例 | ❌ | ✅ |
| 重命名函数（真实写入 IDB） | ❌ | ✅ |

**安全边界**（详见 [`ADR-004`](docs/plans/decisions/ADR-004-在线逆向工作台代理IDA-MCP.md)）：
`ida-pro-mcp` 本身暴露 65 个工具，其中 `patch`、`py_eval`、`py_exec_file`、`put_int`、
`undefine` 等具备**任意代码执行或破坏数据库**的能力。本站**只开放只读白名单**加少量
「沉淀分析成果」类写入（重命名/注释/类型），上述危险工具在任何角色下都不可达。
权限一律在服务端判定。

## 账号管理（/admin/users/）

超级管理员管理用户列表的地方：按名字搜索账号、把会员设为管理员、把管理员退回会员。
**只有超管能进**——导航栏的「账号管理」入口在登录后按角色插入，访客与会员既看不到
入口、也拿不到数据（页面只显示一句说明，且不发任何请求）。

| 身份 | 在 `/admin/users/` 看到什么 |
| --- | --- |
| 访客 / 会员 | 一句「这一页只对超级管理员开放」，没有任何列表与按钮 |
| 管理员 admin | 同上（管理内容 ≠ 管理账号） |
| 超级管理员 | 账号列表：名字、角色、注册时间、操作；自己的行与超管行只有说明文字 |

| 接口 | 作用 |
| --- | --- |
| `GET /api/admin/accounts?q=` | 账号列表 + 按名字模糊搜索（大小写不敏感的子串匹配） |
| `PUT /api/admin/accounts/{id}/admin` | `{"enabled": true/false}` → 设为 / 取消管理员 |
| `PUT /api/admin/accounts/{id}/role` | 调整角色（既有接口，含「最后一个超管」兜底） |

**三条边界**（详见 [`ADR-010`](docs/plans/decisions/ADR-010-账号管理界面.md)）：

1. **搜索在服务端做**：管理界面上「搜不到」等于「这个人不在站上」，这个结论不能
   建立在「已经加载了哪一批」上。输入时前端会先复筛当前批，停顿 220ms 后由服务端
   给出权威结果（LIKE 的 `_` / `%` 已转义，否则搜一个下划线会命中所有账号）。
2. **「设为管理员」是独立接口**，不复用能写任意角色的 `/role`：一个「给不给管理员」
   的开关，在契约上就应该只覆盖 admin ↔ member 两档。`enabled` 用 `strict=True`，
   `"false"` 这类字符串会在 422 失败而不是被当成真值。
3. **超管档位不在这里改**：超管本来就拥有管理员的全部能力，把它「降」下来是纯粹的
   权限损失，只可能来自误操作。超管行没有开关，只有说明文字；超管只能由首个账号的
   引导规则或注册邀请码产生（[`ADR-002`](docs/plans/decisions/ADR-002-角色权限与动态主页配置.md)）。
   超管也不能改自己的角色——这两条合起来保证场上永远至少有一个超管。

实装与验证证据见 [`15-开发日志-账号管理页.md`](docs/plans/15-开发日志-账号管理页.md)。

## 新增一个工具

1. 在 `src/tools/<id>/` 建目录，写 `manifest.ts`（元数据 + 文档）、`schema.ts`（输入校验）、`engine.ts`（纯计算）、`view.ts`（专属界面）。
2. 在 `src/tools/registry.ts` 加一行懒加载登记；`src/tools/manifests.ts` 加一项供目录页展示。
3. 在 `tests/tools.test.ts` 补边界对照用例，`npm test` 跑通。

引擎不碰 DOM、不调宿主，所以可以脱离浏览器测试；`/tools/[slug]/` 路由与目录卡片由注册表自动生成，**不需要改动其他工具**。

## 约定

- 内容与展示分离：新增文章/作品只加 Markdown 文件；新增工具只加 `src/tools/<id>/` 目录并在注册表登记。
- `status='planned'` 的工具不渲染可运行入口；草稿不进入构建、RSS 与索引。
- 权限一律由服务端判定；前端隐藏按钮不作为权限控制。
- 工具引擎保持纯函数、不读取 DOM；数值输入不猜测修复（空值、小数、越界一律说明原因后拒绝）。
- `ancient_debris/`（研究资料）与 `dist/`（构建产物）不入库。
- 提交信息用中文，遵循现有风格；关键决策与实装记录必须先更新 `docs/plans/`（含 ADR）。

## 当前状态

- **阶段 1（工程基础）** 与 **阶段 3（工具宿主）** 已落地：工具箱宿主可用，
  当前工具为 **`.mcstructure` 编辑器**（上传 / 查看 / 编辑 / 下载，登录后可收藏；
  未登录仍可浏览与使用）。
- 阶段 3 最初的两个工具（区块与坐标助手、材料清单助手）已按需求**移除**，
  只留下 `.mcstructure` 编辑器。移除记录见
  [`06-开发日志-工具系统实装.md`](docs/plans/06-开发日志-工具系统实装.md) 开头的说明；
  历史实现仍可从 git 提交 `fa47d7b` 取回。
- **阶段 6 追加项**：**逆向工作台**（`/ida/`，在线 BDS 反编译）与 **`.mcstructure` 解析接口**已实装并验证。
- **阶段 4 已落地（2026-09-16）**：**论坛前端接入真实 API**——`/forum/` 的列表、详情、发帖、
  回复、删除全部可用（未登录只读）；发帖可随帖上传 ≤10 MB 的 `.mcstructure`，
  服务端解析出材料清单并生成轻量载荷，网页端用自实现的 Canvas 2D 体素渲染器
  做 3D 预览。证据见 [`10-开发日志`](docs/plans/10-开发日志-论坛结构附件与3D预览.md)。
- **超管账号管理页已实装（2026-09-16）**：`/admin/users/`——超管按名字搜索账号、
  把会员设为管理员、把管理员退回会员。搜索在服务端（大小写不敏感的子串匹配），
  「设为管理员」走独立的 `/api/admin/accounts/{id}/admin`，**超管档位不在这里改**。
  决策见 [`ADR-010`](docs/plans/decisions/ADR-010-账号管理界面.md)，证据见
  [`15-开发日志`](docs/plans/15-开发日志-账号管理页.md)。
- 阶段 2（博客/作品详情页）与阶段 4 剩余项（托管平台、账号限流）按
  [`docs/plans/05`](docs/plans/05-阶段计划与任务清单.md) 推进。
- **作品页三个新区块已实装（2026-09-16）**：动态滚动的作品封面（一行无缝循环、
  悬停暂停、点击看大图）、研究时间轴（滚动进度线 + 节点浮现）、B 站视频成果清单（纯文本）。
  内容改 `src/modules/works/data.ts`。证据见
  [`11-开发日志`](docs/plans/11-开发日志-作品页封面滚动与时间轴.md)。
- 各项实装记录与验证证据：[`06`](docs/plans/06-开发日志-工具系统实装.md)（工具系统宿主）、
  [`07`](docs/plans/07-开发日志-逆向工作台.md)（逆向工作台）、
  [`08`](docs/plans/08-开发日志-mcstructure编辑器.md)（结构文件编辑器）、
  [`10`](docs/plans/10-开发日志-论坛结构附件与3D预览.md)（论坛结构附件与 3D 预览）与
  [`11`](docs/plans/11-开发日志-作品页封面滚动与时间轴.md)（作品页封面滚动与时间轴）；
  `.mcstructure` 解析边界见 [`ADR-003`](docs/plans/decisions/ADR-003-基岩版结构文件解析器.md)，
  附件与预览的取舍见 [`ADR-006`](docs/plans/decisions/ADR-006-论坛结构附件与网页3D预览.md)。
