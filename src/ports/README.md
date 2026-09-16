# src/ports · 跨语言契约

本目录只放**由后端生成、不由人手写**的类型与边界定义。

| 文件 | 来源 | 重新生成方式 |
| --- | --- | --- |
| `api-schema.d.ts` | 后端 FastAPI 的 OpenAPI（pydantic 模型是单一事实源，ADR-001） | `npm run api:types` |

## 为什么不能手写

ADR-001 约定：跨语言契约以 **JSON API + OpenAPI 为单一事实源**——后端 pydantic 生成 OpenAPI，
前端由此生成 TypeScript 类型，**两侧不得各自手写漂移的字段定义**。
因此本目录的文件属于生成产物，不要在编辑器里直接改；改了也会在下次生成时被覆盖。

## 后端端口被占用时怎么生成

`npm run api:types` 需要后端可访问（默认 <http://127.0.0.1:8000>）。
若该端口已被别的进程占用，可以不经过网络，直接从 app 对象导出：

```bash
cd backend
python -c "import json,sys;sys.path.insert(0,'.');from app.main import app;json.dump(app.openapi(),open('../openapi.json','w',encoding='utf-8'),ensure_ascii=False)"
cd ..
npx openapi-typescript openapi.json -o src/ports/api-schema.d.ts
rm openapi.json          # 中间产物，不入库
```

两条路径拿到的 schema 完全一致——`app.openapi()` 就是 `/openapi.json` 返回的内容。

## 使用方式

模块只从这里取类型，不复制字段清单：

```ts
import type { components } from '../../ports/api-schema';

type StructureResponse = components['schemas']['StructureResponse'];
```

后端某些 pydantic 模型只作为基类存在（例如 `StructureIndex` 是 `StructureResponse` 的基类），
FastAPI 不会为它们单独生成 schema。这时应在前端用 `Omit`/`Pick` 从已生成的类型**派生**，
而不是另写一份字段定义（见 `src/modules/mcstructure/api.ts`）。
