# tests · 测试

## 自动测试（日常用这个）

```bash
npm test        # 纯逻辑对照测试（Node 内置 test runner，零额外依赖）
```

- `mcstructure.test.ts`：浏览器侧 .mcstructure 语义层（解析/编辑/序列化往返）。
- `snbt.test.ts`：SNBT 文本格式（每种类型的写法、引号转义、往返一致、错误带行列号）。
- `forum-voxel.test.ts`：论坛 3D 预览的渲染核心 + 封面展示的纯函数。载荷由测试自己重新编码
  （`encodeGrid`），不复用生产解码器——两边共用一个实现的话，协议写错了两边会一起错。
  面剔除的期望值是解析解（5³ 实心立方 = 98 个可见方块、8 角 3 面 / 36 棱 2 面 / 54 面心 1 面）。
- `admin-users.test.ts`：账号管理页的纯规则（匹配口径、角色文案、`rowCapability`
  的三条分支、确认话术、分档计数）。服务端那一侧的同名规则在
  `backend/tests/test_admin_users.py`——两边各测一次，是因为「界面判断」与
  「服务端判断」漂移时的表现最坏：按钮点得下去，请求却一定失败。
- `resolve-ts.mjs`：Node 解析钩子。生产代码按 Astro/Vite 约定写无扩展名导入，
  Node 的 ESM 解析要求写全扩展名，钩子在测试侧补 `.ts`，两边都不用改代码。

后端测试在 `backend/tests/`，用 `cd backend && pytest` 单独运行。

## 手动验证（改了界面或账号联动时用）

`tests/manual/` 下的脚本用无头 Edge 通过 CDP 真实操作页面，不属于 CI。
需要：后端在 8000 运行、Edge 以 `--remote-debugging-port=9222` 启动。

```bash
# 1) 起后端
cd backend && python -m uvicorn app.main:app --port 8000

# 2) 起无头 Edge
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --headless=new \
  --remote-debugging-port=9222 --user-data-dir=%TEMP%\edgecdp about:blank

# 3) 同源静态服务（把 dist 和 /api 放在一个 origin 后面）
node tests/manual/serve-dist.mjs 8001 http://127.0.0.1:8000

# 4) 跑场景
node tests/manual/e2e-favorites.mjs http://localhost:8001   # 收藏门槛与读写
node tests/manual/e2e-mcstructure.mjs http://localhost:4399 http://127.0.0.1:9223 <夹具路径>
node tests/manual/e2e-forum.mjs http://localhost:8001 http://127.0.0.1:9222 <小屋夹具> <封面夹具>
node tests/manual/e2e-works-showcase.mjs http://localhost:4323   # 作品页封面滚动/时间轴/灯箱
```

`e2e-forum.mjs` 覆盖论坛的完整链路：未登录浏览 → 注册 → 发帖（真实文件选择框上传
`.mcstructure` **和封面图片**）→ 材料清单 → 3D 预览（**读画布像素**，确认真的画出了东西、
三种材质的示意色都在、分层与旋转都改变画面）→ 封面在详情页真的解码出来、在列表里是
懒加载缩略图 → 下载字节比对 → 删除封面（正文与预览不受影响）→ 回复 →
回列表看徽标与筛选 → 整页刷新复现 → **版块接口 404 时的降级**（不能给一个空的下拉框）→
控制台无异常。

夹具（小屋 + 一张 16:9 的封面，脚本会断言 768×432 这个尺寸）：

```bash
cd backend
python tests/fixtures/mcstructure_fixtures.py --kind house --out ../.tmp-e2e/house.mcstructure
python -c "import sys;sys.path.insert(0,'.');import pathlib;from tests.fixtures import image_fixtures as i;pathlib.Path('../.tmp-e2e/cover.png').write_bytes(i.png(768,432))"
```

**为什么要同源（8001）而不是直接用 4321 预览**：会话 Cookie 是 `SameSite=Lax`，
跨端口时浏览器不会在 fetch 中携带它，`/api/auth/me` 会一直返回 null（登录看起来"没生效"）。
这是本地开发的浏览器限制，不是应用缺陷——线上前后端同域时不存在。
`serve-dist.mjs` 把 `/api` 反代到 FastAPI，让验证能在同源条件下进行。

同源验证时前端要把 API 基地址指向**代理的端口**，并且**构建到独立目录**：

```bash
# 验证用：产物单独放，避免与别人的 npm run build 抢 dist/
PUBLIC_API_BASE="http://localhost:8001" npx astro build --outDir dist-e2e
node tests/manual/serve-dist.mjs 8001 http://127.0.0.1:8000 dist-e2e
# 验证完记得重新 npm run build（回到 .env 里配的地址）
```

> **三个踩过的坑，写在这里省得再踩**：
> 1. `PUBLIC_API_BASE=""` **不会**生效——Astro 在存在 `.env` 时以 `.env` 为准，
>    空串会被当成「没设置」。所以要给代理的完整地址而不是空串。
> 2. `dist/` 是**共享状态**。多人（或多个 agent）在同一个仓库里开发时，
>    别人一次 `npm run build` 就会把验证产物换掉，表现为「本来通过的用例突然
>    打到另一个后端上、报 CORS 失败」。用 `--outDir dist-e2e` 隔离。
> 3. `serve-dist.mjs` 转发响应头时**刻意不转发 `content-encoding`**：Node 的 `fetch`
>    已经自动解压了正文，再带上 gzip 头会让浏览器把明文当压缩流解。

## 文档树的链路验收（`verify-docs-*.mjs`）

文档树有**写操作**（管理员上传 / 提交移动与删除申请 / 超管审核与直接整理目录），
验证要能真的改数据，所以这两个脚本用**完全隔离的临时库**跑，不碰 `backend/data/app.db`
（临时库与上传目录建议直接放 `%TEMP%`，别放进仓库——见下面第 2 条坑）：

```bash
# 1) 建隔离库并导入资料（都在 backend/ 下执行）
cd backend
NAYTIA_SQLITE_PATH=%TEMP%\docs-verify\verify.db \
NAYTIA_DOCS_STORAGE_DIR=%TEMP%\docs-verify\storage \
  python -m uvicorn app.main:app --host 127.0.0.1 --port 8123 --log-level warning

# 2) 建三个验收账号（走真实注册接口 + 超管的角色管理接口提权）
node tests/manual/verify-docs-accounts.mjs http://127.0.0.1:8123

# 3) 起指向该后端的开发服务器（要放行 CORS：NAYTIA_CORS_ORIGINS）
PUBLIC_API_BASE="http://127.0.0.1:8123" npx astro dev --port 4333 --host 127.0.0.1

# 4) 起无头 Chrome（独立端口 + 仓库外的 profile 目录）
chrome --headless=new --remote-debugging-port=9333 \
  --user-data-dir=%TEMP%\docs-cdp about:blank

# 5) 跑链路验收（66 项，截图落到第 3 个参数）
#    必须设 DOCS_ALLOW_MUTATIONS=1：这一段会真的写数据
DOCS_ALLOW_MUTATIONS=1 node tests/manual/verify-docs-ui.mjs \
  http://127.0.0.1:4333 http://127.0.0.1:8123 %TEMP%\docs-verify
```

**为什么写操作要显式开启**：这套脚本会真的创建、移动、删除文档。
万一有人（或某个 agent）把 `apiBase` 指向了真实站点，站长的知识库里就会多出一堆
「验收专用文档」。所以默认只跑访客只读那一段（18 项），
把「会改数据」这件事做成需要显式开关的动作。

覆盖：访客阅读与搜索 → 管理员上传 md（真实分块上传）与新建文件夹（都进待审队列，
线上不可见）→ 超管批准后对访客可见、驳回的不进树 → 登出后复查访客视角（含 txt/json 渲染）
→ **超管直接移动/改标题/删除**（含文件夹改名连带路径）→ **管理员提交移动申请、
超管在队列里批准后文档真的换目录**（共 66 项）。

> **这两个脚本踩过的坑**：
> 1. **别用 9222 端口**：那上面可能正开着使用者自己的 Chrome，脚本的页面导航会打到
>    别人正在看的标签页上（本次真踩到了）。用 9333。
> 2. **别把 Chrome 的 profile 目录放进仓库**：Vite 的文件监听会对 profile 里的
>    锁文件报 `EBUSY`，刷屏的 unhandled rejection 会把整轮验收卡死。放到 `%TEMP%` 下。
> 3. **同一 URL 的重复导航不保证重新加载**：切换账号后要显式 `Page.reload`，
>    否则检查会以「上一个人的身份」跑，表现为随机失败。
> 4. **`input.files` 赋值与点击之间要等一下**：脚本在同一帧里连做两步时，
>    浏览器还没把 FileList 交给 input，点击瞬间读到的是空的。

## 账号管理的链路验收（`verify-admin-users.mjs`）

这一页会**真的改角色**，所以脚本自带一套隔离环境：临时库、独立端口、临时 Chrome
profile，跑完自行清理。**不需要**先起后端或浏览器，也**不改动任何仓库文件**，
一条命令跑完（可重复跑，实测连跑三次结果一致、无残留）：

```bash
node tests/manual/verify-admin-users.mjs
# 端口可用环境变量改：ADMIN_VERIFY_BACKEND_PORT / ADMIN_VERIFY_SITE_PORT / ADMIN_VERIFY_CDP_PORT
```

覆盖 24 项：未登录 / 会员 / 超管三种身份看到的界面不同（未登录与会员**不发任何
数据请求**）→ 导航入口只在超管出现、退出后消失 → 列表与角色徽章 → 自己的行与
超管行只有说明文字 → 搜索（本地复筛 + 服务端结果一致、搜不到时的空状态）→
点「设为管理员」徽章就地翻转、**整页刷新后仍是管理员**（证明确实落库而不是只改了
DOM）→ 点「取消管理员」回到会员 → 确认框选「取消」时不发请求 → 控制台无错误。

> **这套脚本踩过的三个坑**（都真踩过，写在这里省得再踩）：
> 1. **别用「临时改写 `astro.config.mjs`」来注入 `/api` 代理**。最初就是这么写的
>    （写文件 → 启动 → 等就绪 → 还原），结果有两类难查的竞态：等到的那次「就绪」
>    可能是配置热重载**之前**的响应，随后还原文件又触发一次重载，代理就没了
>    （表现为请求落到 Astro 的 404 路由上而不是后端，看着像「登录接口 404」）；
>    而 `process.exit()` 不等异步清理，一次异常就能把带代理的配置留在树上，
>    后续运行再把它当「干净原件」备份下来——脏配置再也回不去。
>    现在的做法是**环境变量**：`astro.config.mjs` 读 `VITE_API_PROXY_TARGET`，
>    不设就完全不存在（正式构建不受影响）。没有共享状态，就没有需要还原的东西。
> 2. **杀子进程要连整棵进程树**（Windows 用 `taskkill /T /F`）。`child.kill()` 只杀
>    直接子进程，Chrome 会留下一堆渲染/GPU 子进程继续占着用户数据目录——
>    临时目录删不掉只是表象，真正的问题是每跑一次就多一批僵尸浏览器进程。
> 3. **开发服务器的文件监听必须关掉**（配置里写 `watch: null`，只在设置了代理目标时
>    生效）：Vite 会 watch 整个仓库，撞上 `backend/tests` 下另一次 pytest 运行留下的
>    临时文件就 `EBUSY` 抛 UnhandledRejection，整个服务器挂掉——表现是「登录突然
>    全部失败」，看着像功能坏了。验收只看首屏之后的行为，不需要 HMR。
>
> 另外：它验证的**不是** dist 产物，而是 Astro 开发服务器（Vite 按需转换）。原因是
> 仓库里同一时刻可能有别的改动在飞，链路验证不该被别人的文件挡住（`npm run build`
> 因为论坛模块重构失败过一次，和本功能无关）。生产构建是否通过由 `npm run build` 单独负责。
