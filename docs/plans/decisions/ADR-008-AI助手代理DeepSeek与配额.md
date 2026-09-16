# ADR-008 · 逆向工作台的 AI 助手：代理 DeepSeek，按人限轮

日期：2026-09-16  
状态：已接受（用户要求「增加一个问 AI 的悬浮窗口，内置简单 agent，配 DeepSeek API，普通用户每 5 小时 3 轮」）  
关联需求：`../13-开发日志-AI助手.md`；`ADR-004-在线逆向工作台代理IDA-MCP.md`  
替代记录：无

## 背景

逆向工作台已经能让访客读反汇编与伪代码（ADR-004），但"看懂那段伪代码"仍然需要专业知识。
用户要求加一个悬浮问答窗口：内置简单 agent，接 DeepSeek，**普通用户每 5 小时 3 轮**。

这件事和站内其他功能有两个本质区别：

1. **会花钱**。每次调用都消耗 DeepSeek 计费额度，且 agent 一轮里可能调用多次模型。
2. **它是"能自己动手"的接口**。agent 通过工具去访问 IDA，能力边界必须显式设计——
   一旦给到写工具，模型（或被提示注入诱导的模型）就能改用户的 IDB。

同时逆向工作台的定位刚被确认为「访客可读」，所以 AI 助手也必须对访客开放，
这就把"如何识别一个人"的问题摆上台面。

## 选择

| 方案 | 收益 | 成本与限制 |
| --- | --- | --- |
| A. 后端代理 DeepSeek，只读工具集，按人限轮（采纳） | key 不出服务端；额度在服务端判定；agent 能力被白名单钉死 | 需要自己写 agent 循环与配额 |
| B. 前端直连 DeepSeek，key 放浏览器 | 后端几乎不用写 | **key 会泄露给任何访客**，等于把钱包公开；不可接受 |
| C. 不做 agent，只把用户问题转成一次性问答 | 实现最简单 | 模型看不到真实伪代码，只能泛泛而谈，价值很低 |
| D. agent 给全套 MCP 工具（含 rename/patch） | 能力强 | 模型可改 IDB；提示注入下不可控。**与 ADR-004 的边界冲突** |

## 决定

采用 A。具体边界：

1. **key 只在服务端**：`NAYTIA_DEEPSEEK_API_KEY` 由后端读取，
   前端拿到的只有 `/api/ai/quota` 的 `configured` 布尔值。
2. **只用 httpx 直连，不引入 SDK**：`openai` 不在本项目的依赖清单里
   （04 文档第 1 节第 3 条要求依赖显式锁定），而 httpx 已随逆向工作台进入运行期依赖；
   直连还让测试能用 `MockTransport` 假扮接口，**不消耗真实额度**。
3. **工具集是只读白名单**（`app/ai/tools.py`）：`survey_binary`、`list_functions`、
   `lookup_function`、`decompile`、`disassemble`、`xrefs_to`、`callees`、`basic_blocks`、
   `search_strings`、`search_text`。
   **不提供** `rename` / `patch` / `set_type` / `set_comments` / `py_eval` 等任何写工具。
   底层 `IdaMcpClient.call()` 本身还有一层只读白名单，写操作必须走 `call_write`——
   所以 agent 在**结构上**不可能修改 IDB，不是靠提示词约束。
4. **配额：每 5 小时 3 轮**，滑动窗口。
   - 一轮 = 用户发一条消息；agent 内部的多次工具调用算同一轮，不重复扣。
   - 登录用户按账号 ID 计，未登录按客户端 IP 计。需求没有区分两者，这里只区分身份来源。
   - 被拒的请求不消耗额度（先判后扣）。
5. **对话历史不落库**：只存在浏览器 localStorage，每轮整体回传给服务端，
   服务端按 `ai_max_messages` / `ai_max_chars` 截断。少一份隐私负担，
   也避免为此建表。
6. **agent 循环有上限**：一条消息内最多 `ai_max_tool_rounds`（默认 6）轮工具调用，
   用尽时**如实说明"没能得出结论"**，不假装给出了答案。

## 扩展影响

- 新增后端包 `backend/app/ai/`（`deepseek` / `tools` / `agent` / `ratelimit` / `schemas` / `router`）。
- 新增前端 `src/modules/reverse/ai-panel.ts` + `ai-api.ts`，由工作台挂载。
- 新增配置项：`deepseek_*`、`ai_max_*`（见 `backend/.env.example`）。
- 新增依赖：无。
- 复用：`ReverseService`（不新增 IDA 访问路径）、`get_current_account`（身份）。
- DeepSeek 不可达或未配置时，工作台其余功能**完全不受影响**（只影响悬浮窗）。

## 数据与回退

- 无新增数据库表；配额是进程内内存，重启即重置。
- 回退：删除 `main.py` 里的 `ai_router` 注册与前端 `mountAiPanel` 调用即可，
  两侧都不被其他模块依赖。
- 费用风险：key 泄露或被盗用是唯一不可逆的损失，因此 key 只存服务端，
  且**建议在 DeepSeek 控制台设置消费上限**。

## 验证

- [x] 配额：3 轮放行、第 4 轮 429、被拒不扣额度、窗口滑出后恢复、不同 key 互不影响。
- [x] 只读：断言 `rename`/`patch`/`py_eval` 等不在工具集内。
- [x] agent 循环：无工具直接回答、工具调用后回答、坏 JSON 参数容错、
      模型"发明"工具名时如实记失败、轮数用尽时如实报告。
- [x] key 未配置 → `/api/ai/chat` 返回 503 且 `/api/ai/quota` 的 `configured=false`。
- [x] 上游错误：401 转 `ai_bad_key`、429 转 `ai_upstream_rate_limited`。
- [x] 身份：未登录按 IP（`identity: "ip"`），登录按账号（`account:1`）。
- [x] 浏览器端到端（假 DeepSeek，不花额度）：窗口开合、提问、工具记录展示、
      配额 3→2→0、第 4 轮被拦并提示恢复时间、0 页面报错。

## 重新评估条件

- **多实例部署**：内存配额在多个进程间不共享，同一用户可能被放行 N 倍。
  届时改为 Redis 或数据库计数，并补一条 ADR。
- **反代后取真实 IP**：当前用 `request.client.host`，在反向代理后面会拿到代理 IP，
  导致所有访客共用一个配额桶。上线到反代前必须改为读取可信代理头。
- **配额口径变化**：若改成"按 token 计费"或"登录用户更多轮"，只需改
  `AI_ROUNDS_PER_WINDOW` / `RateLimiter` 的键，agent 与工具集不受影响。
- **模型换代**：`NAYTIA_DEEPSEEK_MODEL` 可切换；若换到不支持 function calling 的模型，
  agent 会退化成纯问答（工具调用永远为空），需要重新评估该模型是否可用。
