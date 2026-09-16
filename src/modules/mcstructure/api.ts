/**
 * mcstructure 解析 API 客户端（归属 mcstructure 模块）。
 *
 * 类型来源：`src/ports/api-schema.d.ts`，由后端 OpenAPI 生成（ADR-001 约定：
 * 契约以后端 pydantic 为单一事实源，前端不手写漂移的字段定义）。
 * 重新生成：`npm run api:types`。
 *
 * 与 `shared/api-client` 的区别：这里要发 multipart/form-data，不能带
 * `Content-Type: application/json`（浏览器必须自己补 boundary），所以单独实现
 * 一次 fetch；错误结构仍然遵循后端统一的 { detail: { code, message } }。
 */
import { API_BASE, ApiError } from '../../shared/api-client';
import type { components } from '../../ports/api-schema';

export type StructureResponse = components['schemas']['StructureResponse'];
export type VoxelLayer = components['schemas']['VoxelLayer'];
export type VoxelSlice = components['schemas']['VoxelSlice'];
export type PositionLookup = components['schemas']['PositionLookup'];
export type BlockEntityEntry = components['schemas']['BlockEntityEntry'];
export type EntityEntry = components['schemas']['EntityEntry'];
export type BlockCountEntry = components['schemas']['BlockCountEntry'];
export type LayerStats = components['schemas']['LayerStats'];
export type StructureInfo = Record<string, unknown>;

/**
 * 索引区（不含体素与原始 NBT）。
 *
 * 后端 `StructureIndex` 是 `StructureResponse` 的基类，FastAPI 只会为实际出现在
 * 响应里的 `StructureResponse` 生成 schema，所以这里从它派生：
 * 去掉两个可选大字段，语义与后端一一对应，不需要在前端另写一份字段清单。
 */
export type StructureIndex = Omit<StructureResponse, 'voxels' | 'raw_nbt'>;

/** 上传的查询参数，对应后端各接口的 query 参数。 */
export interface ParseOptions {
  includeVoxels?: boolean;
  includeRaw?: boolean;
}

async function postFile<T>(path: string, file: File | Blob, params: Record<string, string> = {}): Promise<T> {
  const body = new FormData();
  const name = file instanceof File ? file.name : 'structure.mcstructure';
  body.append('file', file, name);

  const query = new URLSearchParams(params).toString();
  const url = `${API_BASE}${path}${query ? `?${query}` : ''}`;

  const res = await fetch(url, { method: 'POST', body, credentials: 'include' });
  if (res.status === 204) return undefined as T;

  const data = (await res.json().catch(() => null)) as
    | { detail?: { code?: string; message?: string } | string }
    | T
    | null;

  if (!res.ok) {
    const detail = (data as { detail?: { code?: string; message?: string } | string })?.detail;
    const code = typeof detail === 'object' && detail ? detail.code ?? 'http_error' : 'http_error';
    const message =
      typeof detail === 'object' && detail
        ? detail.message ?? `请求失败（${res.status}）`
        : typeof detail === 'string'
          ? detail
          : `请求失败（${res.status}）`;
    throw new ApiError(res.status, code, message);
  }
  return data as T;
}

/** 上传并解析。默认只取索引与统计；体素数组按需请求（可能很大）。 */
export function parseStructure(file: File | Blob, options: ParseOptions = {}): Promise<StructureResponse> {
  const params: Record<string, string> = {};
  if (options.includeVoxels) params.include_voxels = 'true';
  if (options.includeRaw) params.include_raw = 'true';
  return postFile<StructureResponse>('/api/mcstructure/parse', file, params);
}

/** 只取完整方块索引数组。 */
export function fetchVoxels(file: File | Blob): Promise<VoxelLayer[]> {
  return postFile<VoxelLayer[]>('/api/mcstructure/voxels', file);
}

/** 取某一轴上的薄片。 */
export function fetchSlice(
  file: File | Blob,
  axis: 'x' | 'y' | 'z',
  at: number,
  layer = 0,
): Promise<VoxelSlice> {
  return postFile<VoxelSlice>('/api/mcstructure/slice', file, {
    axis,
    at: String(at),
    layer: String(layer),
  });
}

/** 结构内坐标 -> 位置下标，并返回该格每层的方块。 */
export function lookupPosition(
  file: File | Blob,
  x: number,
  y: number,
  z: number,
): Promise<PositionLookup> {
  return postFile<PositionLookup>('/api/mcstructure/position', file, {
    x: String(x),
    y: String(y),
    z: String(z),
  });
}

/** 方块实体 / 实体分页列表。 */
export function fetchBlocks(
  file: File | Blob,
  kind: 'block_entities' | 'entities' = 'block_entities',
  offset = 0,
  limit = 100,
): Promise<components['schemas']['BlockEntityPage']> {
  return postFile<components['schemas']['BlockEntityPage']>('/api/mcstructure/blocks', file, {
    kind,
    offset: String(offset),
    limit: String(limit),
  });
}

/** 接口说明与当前限制（公开只读）。 */
export async function fetchInfo(): Promise<StructureInfo> {
  const res = await fetch(`${API_BASE}/api/mcstructure/info`, { credentials: 'include' });
  if (!res.ok) throw new ApiError(res.status, 'http_error', `请求失败（${res.status}）`);
  return (await res.json()) as StructureInfo;
}
