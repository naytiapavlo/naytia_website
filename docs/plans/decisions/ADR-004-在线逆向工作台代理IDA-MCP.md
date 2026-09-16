# ADR-004 · 在线逆向工作台：代理本机 IDA MCP，只读优先

日期：2026-09-16  
状态：已接受（用户要求实现在线反编译 BDS 的功能）  
关联需求：`../07-开发日志-逆向工作台.md`；`../01-产品范围与功能规划.md` 第 6 节；`ADR-001-后端语言选型Python.md`  
替代记录：无

## 背景

用户要求「实现在线反编译基岩版 BDS 的功能」，并做成「简易的 IDA 前端」，
后端直接使用本机 IDA MCP 提供的接口。

现场事实（2026-09-16 实测）：

- 本机装有 **IDA Professional 9.2**，以及 **ida-pro-mcp v2.0.0**（mrexodia），
  以 HTTP JSON-RPC（Streamable HTTP）暴露在 `http://127.0.0.1:13337/mcp`。
- MCP 提供了 **65 个工具**，其中包括 `list_funcs` / `decompile` / `disasm` /
  `xrefs_to` / `basic_blocks` / `find_regex` / `search_text` / `survey_binary`，
  以及多实例发现与切换的 `list_instances` / `select_instance`。
- 同时也有 `patch` / `py_eval` / `py_exec_file` / `put_int` / `undefine` 等
  **写入与任意代码执行**能力。
- 当前有 3 个 IDA 实例在跑（BDS `bedrock_server.exe` 1.21.1.03、`Minecraft.Windows.exe`、
  `minecraft-edu.x86_64`），BDS 实例的 IDB 已完成自动分析、Hex-Rays 就绪、字符串缓存 49,232 条。

因此本决策的核心不是「怎么反编译」，而是**把一个具备任意执行能力的本机能力放到 Web 上时，
边界画在哪里**。

## 选择

| 方案 | 收益 | 成本与限制 |
| --- | --- | --- |
| A. 后端代理 MCP，只读白名单 + 角色分级（采纳） | 不引入 MCP SDK 依赖；权限在站内既有角色体系里判定；危险工具根本不出现在可用集合中 | 需要自己维护工具白名单；IDA 必须本机长驻运行 |
| B. 引入官方 MCP Python SDK 做通用转发 | 少写传输层代码 | 通用转发等于把 65 个工具（含 `py_eval`）全量暴露，需要一个很复杂的策略层才能安全 |
| C. 前端直连 MCP（浏览器 → 13337） | 后端几乎不用写 | 跨源、无鉴权、把 IDA 端口暴露给任何访客；**不可接受** |
| D. 让后端自己跑 IDA 批处理生成静态结果 | 无需长驻 IDA | 失去交互式查询（按需反编译、跳转、搜索）；BDS 有 17 万函数，预生成不现实 |

## 决定

采用 A。具体边界：

1. **传输**：后端用 `httpx` 直接发 JSON-RPC，不引入 MCP SDK。
   会话（`Mcp-Session-Id`）由后端持有，会话失效自动重连一次。
2. **串行化**：`select_instance` 是 MCP 侧全局状态，所以「切换实例 + 调用工具」
   必须在同一把 `asyncio.Lock` 内完成，否则并发请求会互相切走实例、
   返回别的二进制的结果（这是本方案最容易被忽略的正确性问题）。
3. **工具白名单**，而不是黑名单：
   - 只读集合（访客/会员/管理员都可用）：`list_funcs`、`decompile`、`disasm`、
     `xrefs_to`、`xref_query`、`callees`、`basic_blocks`、`find_regex`、`search_text`、
     `survey_binary`、`lookup_funcs` 等。
   - 写入集合（**仅 admin / superadmin**，且只开放「沉淀分析成果」类）：
     `rename`、`set_comments`、`append_comments`、`set_type`、`declare_type`、`enum_upsert`。
   - **刻意不开放**：`patch`、`patch_asm`、`py_eval`、`py_exec_file`、`put_int`、
     `undefine`、`define_func`、`define_code`、`delete_stack`。
     理由：这些等价于在 IDA 进程内任意执行代码或破坏数据库，
     不因为调用方是 superadmin 就变成安全操作。要改字节时请在 IDA 界面里手工做。
4. **权限在服务端判定**：写入路由挂 `require_staff`；前端隐藏按钮只是界面引导
   （01 文档第 7 节：前端隐藏按钮不作为权限控制）。
5. **实例选择限管理员**：切换实例影响全局状态，且会把分析现场切到别的二进制，
   因此只对 admin 及以上显示选择器。访客沿用服务端当前实例。
6. **界面归属**：做成工具箱目录里的一个**入口**，跳转到独立的 `/ida/` 全屏页面。
   不塞进 `/tools/<slug>/` 的工具宿主协议——IDA 式三栏界面需要整屏宽度，
   且它不满足「纯函数引擎 + 可序列化 manifest」的工具契约。

## 扩展影响

- 新增后端模块 `backend/app/reverse/`（`mcp_client` / `schemas` / `client` / `router`），
  与既有 `routers/` 平级，按 02 文档的分层：路由不直接碰 MCP 细节。
- 新增前端模块 `src/modules/reverse/`，页面 `src/pages/ida.astro`。
- `ToolManifest` 增加两个可选字段：`gate`（界面门槛）与 `entryHref`（外部入口），
  使工具箱目录能收录「自成一套界面」的功能，而不必伪造工具宿主实现。
- 新增依赖：无（`httpx` 已在 `requirements-dev.txt`，现提升为运行期依赖）。
- MCP 不可达时工作台显示降级提示，**不影响站内其他功能**（02 文档：无隐式强依赖的启动链）。

## 安全边界（明确写清，避免误用）

- 本站的逆向工作台**不是公网可用的 IDA**：它只代理本机 13337 等端口的 MCP，
  后端必须与 IDA 在同一台机器上运行。
- 只读能力对访客开放，意味着**BDS 的反编译结果对访客可见**。
  这是用户明确选择（"访客只读"）；如需收紧，把 `/api/reverse/*` 的读接口
  也挂上 `require_account` 即可，无需改架构。
- `ida_allowed_ports` 可配置端口白名单，避免误连到正在手工操作的那个实例。
- 数据库文件（`.i64`）不由本功能写入；`rename` 会真实修改 IDB 中的符号，
  这是有意的（分析成果沉淀），但因此**不提供**批量改名接口以外的破坏性操作。

## 数据与回退

- 无新增数据库表；工作台不持久化任何数据，IDA 侧的状态仍由 IDB 自己保存。
- 回退方式：删除 `app.reverse` 路由注册与 `/ida/` 页面即可，
  对站内其他模块无影响（两侧都不被其他模块依赖）。
- `rename` 是可逆的（改回原名即可）；`patch` 类操作未开放，因此不存在不可逆的字节改动。

## 验证

- [x] MCP 客户端：会话建立、会话失效重连、只读白名单拒绝未知工具、实例切换缓存与并发串行化。
- [x] 形状归一化：按真实返回结构断言（`list_funcs` 的 `[{data,next_offset}]`、
      `decompile` 的 `{addr,code}`、`disasm` 的 `{addr,asm:{lines,stack_frame}}` 等）。
- [x] 权限：访客 401 / 普通会员 403 / 管理员放行并真实改名成功。
- [x] 危险工具不在任何白名单内（有断言）。
- [x] 真实实例联调：BDS 概览 171,396 函数、`main` 反编译 432 ms、
      反汇编 237 ms、交叉引用与基本块、字符串搜索。
- [x] 浏览器端到端：函数列表→搜索→伪代码（含行内地址跳转）→反汇编→栈变量→交叉引用，
      访客看不到实例选择器与重命名按钮，管理员可见且改名生效。

## 重新评估条件

- 若 IDA MCP 升级导致工具名或返回结构变更：`schemas.py` 的归一化层是唯一改动点，
  但需要重新跑一次真实形状探测（`tests/manual/probe_ida_shapes.py`）。
- 若需要「多人同时看不同实例」：当前 `select_instance` 是全局状态，
  串行化能保证正确性但会互相影响；那时应改为每个实例一个 MCP 端点或独立进程。
- 若要把读接口也限制为登录可见，或需要审计日志（谁改了什么名字）：
  引入审计表与 `require_account`，属于增量改动，不影响本决策的其余部分。
