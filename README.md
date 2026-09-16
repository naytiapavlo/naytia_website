# Naytia 的像素小站

Naytia_帕芙洛的个人网站：博客、作品、Minecraft 玩家工具箱与玩家论坛。白色像素风，静态内容 + Python API 的模块化单体。

规划与决策文档在 [`docs/plans/`](docs/plans/README.md)，动工前先读它。

## 技术栈

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 前端 / 内容 | Astro 5 + TypeScript（strict） | 内容集合管理博客与作品；工具工作区后续按需引入 React 岛 |
| 后端 | Python 3.11 + FastAPI | 账号 / 论坛 / 收藏三类 API（ADR-001） |
| 数据库 | SQLite（SQLAlchemy 2.x） | 保留 Postgres 迁移路径，仓储不暴露 SQL 方言 |
| 契约 | OpenAPI → openapi-typescript | 后端 pydantic 生成 OpenAPI，前端 TS 类型由其生成 |

## 目录结构

```text
docs/plans/               # 规划、契约、ADR（文档唯一来源）
prototypes/pixel-demo/    # 手写静态 Demo 的存档（已验证哈希）
content/
  posts/                  # 博客（Markdown + frontmatter，draft 不进构建）
  works/                  # 作品（含视频外链、标签）
public/                   # 可公开静态文件（头像等）
src/
  pages/                  # 路由：/ /blog /works /tools /forum /404
  layouts/                # BaseLayout 公共页壳（导航、图标 sprite、页脚）
  components/ui/          # PageHeading、EmptyState 等基础组件
  config/site.ts          # SiteConfig：头像、简介、导航、首页入口排序
  styles/                 # tokens.css 设计变量 + base.css 基础样式
  content.config.ts       # 内容集合 schema（zod 校验）
  modules/
    toolbox/registry.ts   # 工具注册表（manifest，阶段 3 扩展工具宿主）
    blog/ works/          # 模块占位（阶段 2 充实查询与展示）
  domain/ adapters/       # 占位：纯领域类型、适配器（02 文档分层）
backend/
  app/                    # FastAPI 应用（config/db/models/schemas/routers）
  tests/                  # pytest：认证、论坛权限、收藏隔离
  requirements*.txt       # 依赖清单（含 dev）
scripts/ tests/fixtures/  # 构建期脚本与测试夹具（占位）
dist/                     # 构建产物（不入库）
```

## 本地开发

前端（Astro，默认 <http://localhost:4321>）：

```bash
npm install
npm run dev        # 开发服务器
npm run build      # 生产构建 → dist/
npm run check      # astro check 类型检查
```

后端（FastAPI，默认 <http://127.0.0.1:8000>，交互文档在 `/docs`）：

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
npm run api:types   # OpenAPI → src/ports/api-schema.d.ts
```

## 约定

- 内容与展示分离：新增文章/作品只加 Markdown 文件；新增工具只加 `src/tools/<id>/` 目录并在注册表登记（阶段 3 起）。
- `status='planned'` 的工具不渲染可运行入口；草稿不进入构建、RSS 与索引。
- 权限一律由服务端判定；前端隐藏按钮不作为权限控制。
- `ancient_debris/`（研究资料）与 `dist/`（构建产物）不入库。
- 提交信息用中文，遵循现有风格；关键决策必须先更新 `docs/plans/`（含 ADR）。

## 当前状态

阶段 1（工程基础）已落地，阶段 2-4 按 [`docs/plans/05`](docs/plans/05-阶段计划与任务清单.md) 推进：博客/作品内容管道 → 工具宿主与首批工具 → 论坛与账号前后端联调。
