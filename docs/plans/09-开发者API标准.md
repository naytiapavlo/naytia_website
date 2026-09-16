# 08 · 开发者 API 标准（工具箱开放接口 v1）

更新日期：2026-09-16  
状态：v1 已实现并测试通过（后端 `backend/app/public_api/`，ADR-005）。  
读者：外部开发者（使用 API）与站点维护者（演进 API）。

## 1. 总览

外部开发者可以通过 HTTP API 直接调用站内工具箱的**服务端引擎**，无需浏览器。能力范围：`status` 为 `stable` / `experimental` 的工具；`planned` 工具不开放。

- Base URL：`http://<站点域名>/api/v1`
- 传输：HTTPS（正式环境）/ HTTP（本地开发）
- 格式：请求与响应均为 UTF-8 JSON
- 交互文档：`/docs`（OpenAPI/Swagger，自动生成）
- 契约：`docs/plans/03` 的工具协议；服务端引擎是前端引擎的同规则集移植，测试用例两端一致

## 2. 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/tools` | 工具目录（id、标题、状态、标签） |
| GET | `/api/v1/tools/{tool_id}` | 工具详情：JSON Schema、示例、调用方式 |
| POST | `/api/v1/tools/{tool_id}/run` | 执行计算 |
| POST | `/api/admin/api-keys` | 签发密钥（仅超级管理员） |
| GET | `/api/admin/api-keys` | 密钥列表（不含明文） |
| DELETE | `/api/admin/api-keys/{id}` | 停用密钥 |

当前 v1 工具：`chunk-coordinates`（区块与坐标助手，规则集 `chunk-16-v1`）、`material-counter`（材料清单助手，规则集 `stack-count-v1`）。

## 3. 调用示例

```bash
# 目录
curl http://localhost:8000/api/v1/tools

# 详情（含 JSON Schema 与示例）
curl http://localhost:8000/api/v1/tools/chunk-coordinates

# 执行（匿名）
curl -X POST http://localhost:8000/api/v1/tools/chunk-coordinates/run \
  -H "Content-Type: application/json" \
  -d '{"input": {"x": -17, "z": -1}}'

# 执行（携带密钥，更高限额）
curl -X POST http://localhost:8000/api/v1/tools/material-counter/run \
  -H "Authorization: Bearer nk_xxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{"input": {"entries": [{"name": "石头", "count": 130, "stackSize": 64}],
       "containerSlots": 27, "containerLabel": "潜影盒"}}'
```

## 4. 响应信封（所有 v1 接口统一）

成功：

```json
{
  "ok": true,
  "data": { "...": "工具各自的计算结果" },
  "warnings": ["该方块位于区块边界上……"],
  "meta": {
    "tool_id": "chunk-coordinates",
    "implementation_version": "1.0.0",
    "input_schema_version": 1,
    "ruleset_id": "chunk-16-v1",
    "duration_ms": 0.42
  }
}
```

失败（HTTP 状态码 + 统一错误体；`field` 指向出错字段，`retryable` 表示可否原样重试）：

```json
{
  "ok": false,
  "error": {
    "code": "out_of_range",
    "message": "x 超出世界范围（-29999999 ~ 29999999）",
    "field": "x",
    "retryable": false
  }
}
```

`meta` 使每次结果可追溯（工具 ID + 实现版本 + 输入协议版本 + 规则集 ID），对应 03 文档第 7 节的可复现性要求。

## 5. 错误码

| HTTP | code | 场景 |
| --- | --- | --- |
| 400 | `unsupported_ruleset` | 请求的 ruleset_id 不被该工具支持 |
| 401 | `invalid_api_key` | Bearer 缺失/格式错/密钥不存在 |
| 403 | `api_key_disabled` | 密钥已被停用 |
| 404 | `tool_not_found` | 工具 ID 不存在 |
| 404 | `tool_not_available` | 工具存在但状态未开放（planned 等） |
| 413 | `payload_too_large` | 请求体超过 64KB |
| 422 | `not_an_integer` / `out_of_range` / `invalid_dimension` / `too_many_entries` / `name_too_long` / `empty_list` / `invalid_input` | 输入校验失败，`field` 指明位置 |
| 429 | `rate_limited` | 超出限额，带 `Retry-After` |

## 6. 认证与限额

| 档位 | 条件 | 限额 | 说明 |
| --- | --- | --- | --- |
| anonymous | 无密钥 | 30 次/分钟/IP | 评估与轻量使用 |
| standard | `Authorization: Bearer nk_…` | 300 次/分钟/密钥 | 免费申请，超级管理员签发 |

- 每个响应带 `X-RateLimit-Limit` / `X-RateLimit-Remaining`；超限返回 429 + `Retry-After`
- 密钥明文只在签发时返回一次，服务端只存 SHA-256
- 限流为进程内滑动窗口实现；多实例部署时迁移 Redis（05 阶段 6），限额数值经 ADR 调整

## 7. 版本与兼容承诺

- **URL 主版本**（`/api/v1/…`）：破坏性变更（删字段、改语义、改错误码）必须升 `v2`，`v1` 保留至少 6 个月并返回 `Deprecation` 头
- **工具内版本**：每次响应 `meta` 携带 `implementation_version` / `input_schema_version` / `ruleset_id`；调用方可用请求体 `ruleset_id` 固定规则集，不匹配返回 `unsupported_ruleset`
- **兼容定义**：新增可选请求字段、新增响应字段、新增错误码不算破坏性变更；调用方必须容忍未知字段
- **引擎移植契约**：服务端 Python 引擎与前端 TS 引擎是同一规则集的两个实现，边界测试用例共享（-17/-16/-1/0/15/16 等）；规则升级时同步升级 `ruleset_id`，两端一起换版

## 8. 输入上限

| 限制 | 值 |
| --- | --- |
| 请求体 | ≤ 64KB |
| 材料条目 | ≤ 40 条/次，数量 ≤ 1,000,000,000，堆叠 1~64 |
| 坐标 | ±29,999,999（世界边界） |

## 9. 使用条款（摘要）

计算结果按现状提供，用于 Minecraft 相关用途；禁止用于攻击、滥用或绕过限额的行为；站点有权停用违规密钥。正式发布前补充完整条款与联系方式（依赖 D05/D07）。
