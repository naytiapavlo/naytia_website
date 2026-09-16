# src/modules · 前端模块边界（并行开发约定）

每个目录是一个**独立模块**，可以由不同的人/分支并行开发，互不阻塞。规则（与 `docs/plans/02` 分层一致）：

1. **唯一入口**：每个模块只通过 `index.ts` 导出公开 API。其他模块和页面 `import` 时只允许引用模块根（`modules/xxx`），禁止深入 `modules/xxx/内部文件`。
2. **无环依赖**：模块之间的依赖方向固定为
   `site-admin → account`、`site-admin → site-config`、`BaseLayout → account + site-config`。
   `account`、`site-config` 互相不感知，也不感知 `site-admin`。
3. **跨模块通信靠事件**：会话变化由 `account` 广播 `naytia:session` 事件（detail 为账号或 null），订阅方自行响应——`site-admin` 据此挂载/卸载编辑面板。
4. **静态优先**：模块失败（后端离线、接口报错）时页面必须保持内置默认值可用，不得阻塞首屏。
5. **共享基础能力放 `src/shared/`**（api-client、toast）；只有 ≥2 个模块确需复用才进来，不放业务逻辑。

## 现有模块

| 模块 | 职责 | 公开接口（index.ts） |
| --- | --- | --- |
| `site-config` | 主页动态内容：类型、默认值、API、渲染挂钩（背景/头像/文字） | `fetchSiteConfig / saveSiteConfig / mergeConfig / applyConfig / 类型` |
| `account` | 会话：登录/注册/退出、导航角标、角色徽章、`naytia:session` 事件 | `me / login / logout / register / currentSession / mountAccountChip` |
| `site-admin` | 超级管理员的主页编辑面板（实时预览、保存发布） | `initSiteAdmin` |
| `toolbox`（现有 `registry.ts`） | 工具注册表 manifest | 阶段 3 扩展为宿主时改为模块目录 |

## 后端对应

`backend/app/` 同样按模块切分：`routers/auth.py + models/account.py`（账号）、`routers/forum.py + models/forum.py`（论坛）、`routers/favorites.py + models/favorites.py`（工具箱）、`routers/site_config.py + models/site.py`（站点配置）、`routers/admin.py`（角色管理，依赖账号模块）。跨模块只通过公开路由/模型导出引用；数据库表结构变更只发生在归属模块的 models 文件里。
