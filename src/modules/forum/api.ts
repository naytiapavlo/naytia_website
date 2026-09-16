/**
 * 论坛 API 客户端（归属 forum 模块）。
 *
 * 类型来源：`src/ports/api-schema.d.ts`，由后端 OpenAPI 生成（ADR-001）。
 * 重新生成：`npm run api:types`。前端不手写与后端重复的字段定义。
 */
import { API_BASE, ApiError, apiFetch } from '../../shared/api-client';
import type { components } from '../../ports/api-schema';

export type ThreadSummary = components['schemas']['ThreadSummary'];
export type ThreadDetail = components['schemas']['ThreadDetail'];
export type ReplySummary = components['schemas']['ReplySummary'];
export type ThreadStructure = components['schemas']['ThreadStructure'];
export type ThreadCover = components['schemas']['ThreadCover'];
export type MaterialEntry = components['schemas']['MaterialEntry'];
export type StructureRenderPayload = components['schemas']['StructureRenderPayload'];
export type PageResult = components['schemas']['PageResult'];

/**
 * 响应里的时间字段是 UTC（后端统一 `utcnow`），但 pydantic 序列化出来的
 * ISO 串末尾是 `Z`。`new Date(...)` 能直接解析，这里只是给调用方一个明确入口。
 */
export function parseUtc(value: string): Date {
  return new Date(value);
}

export interface ThreadQuery {
  category?: string;
  cursor?: string;
}

function queryString(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, value);
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export function fetchCategories(): Promise<{ categories: string[] }> {
  return apiFetch<{ categories: string[] }>('/api/forum/categories');
}

export function fetchThreads(query: ThreadQuery = {}): Promise<PageResult> {
  return apiFetch<PageResult>(
    `/api/forum/threads${queryString({ category: query.category, cursor: query.cursor })}`,
  );
}

export function fetchThread(threadId: number): Promise<ThreadDetail> {
  return apiFetch<ThreadDetail>(`/api/forum/threads/${threadId}`);
}

export function createThread(payload: {
  category: string;
  title: string;
  body: string;
}): Promise<ThreadDetail> {
  return apiFetch<ThreadDetail>('/api/forum/threads', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export interface AttachmentUpload {
  /** .mcstructure 结构文件（可选） */
  structure?: File | null;
  /** 封面图片（可选，PNG/JPEG/GIF/WebP） */
  cover?: File | null;
}

/**
 * 发帖并随帖上传附件（multipart）。
 *
 * 两个附件**都可选**，但至少要带一个：一个都不带时用 `createThread`（JSON）。
 * 字段名是 `structure` / `cover` 而不是一个笼统的 `file`——两个可选文件放在一起时，
 * `file` 说不清是哪一个。
 *
 * 只走这一条 XHR 路径而不是复用 `apiFetch`：multipart 不能手写 `Content-Type`，
 * 边界必须由浏览器生成；而且上传进度事件只有 XHR 有（10 MB 的结构文件在慢网上
 * 要几十秒，没有进度条用户会以为卡死了）。错误结构仍是后端统一的
 * `{ detail: { code, message } }`，这里翻译成同一个 `ApiError`。
 */
export async function createThreadWithAttachments(
  payload: { category: string; title: string; body: string },
  attachments: AttachmentUpload,
  onProgress?: (sent: number, total: number) => void,
): Promise<ThreadDetail> {
  const body = new FormData();
  body.append('category', payload.category);
  body.append('title', payload.title);
  body.append('body', payload.body);
  if (attachments.structure) {
    body.append('structure', attachments.structure, attachments.structure.name);
  }
  if (attachments.cover) {
    body.append('cover', attachments.cover, attachments.cover.name);
  }

  return new Promise<ThreadDetail>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `${API_BASE}/api/forum/threads/with-attachments`);
    request.withCredentials = true;
    request.responseType = 'text';

    request.upload?.addEventListener('progress', (event) => {
      if (event.lengthComputable && onProgress) onProgress(event.loaded, event.total);
    });

    request.addEventListener('load', () => {
      const parsed = safeJson(request.responseText);
      if (request.status >= 200 && request.status < 300) {
        resolve(parsed as ThreadDetail);
        return;
      }
      reject(toApiError(request.status, parsed));
    });
    request.addEventListener('error', () => {
      reject(new ApiError(0, 'network_error', '网络中断，上传没有完成'));
    });
    request.addEventListener('abort', () => {
      reject(new ApiError(0, 'aborted', '上传已取消'));
    });

    request.send(body);
  });
}

export function createReply(threadId: number, body: string): Promise<ReplySummary> {
  return apiFetch<ReplySummary>(`/api/forum/threads/${threadId}/replies`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

export function deleteThread(threadId: number): Promise<void> {
  return apiFetch<void>(`/api/forum/threads/${threadId}`, { method: 'DELETE' });
}

export function deleteReply(replyId: number): Promise<void> {
  return apiFetch<void>(`/api/forum/replies/${replyId}`, { method: 'DELETE' });
}

export function deleteCover(threadId: number): Promise<void> {
  return apiFetch<void>(`/api/forum/threads/${threadId}/cover`, { method: 'DELETE' });
}

/** 3D 预览载荷。后端按 Accept-Encoding 直接回 gzip，浏览器会透明解压。 */
export function fetchRenderPayload(threadId: number): Promise<StructureRenderPayload> {
  return apiFetch<StructureRenderPayload>(`/api/forum/threads/${threadId}/structure/render`);
}

/** 原始 `.mcstructure` 的下载地址（浏览器直接跳转即可，带 Content-Disposition）。 */
export function structureFileUrl(threadId: number): string {
  return `${API_BASE}/api/forum/threads/${threadId}/structure/file`;
}

/**
 * 封面图地址。
 *
 * 直接给 `<img src>` 用，不走 fetch：图片由本站的 origin 提供，
 * 类型与缓存头都在服务端定好了，浏览器自己加载最省事也能用上原生懒加载。
 */
export function coverUrl(threadId: number): string {
  return `${API_BASE}/api/forum/threads/${threadId}/cover`;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function toApiError(status: number, parsed: unknown): ApiError {
  const detail = (parsed as { detail?: unknown } | null)?.detail;
  if (typeof detail === 'string') return new ApiError(status, 'http_error', detail);
  if (detail && typeof detail === 'object') {
    const shape = detail as { code?: string; message?: string };
    return new ApiError(status, shape.code ?? 'http_error', shape.message ?? `请求失败（${status}）`);
  }
  // multipart 端点的 422 来自 FastAPI 的字段校验，detail 是数组
  if (Array.isArray(detail)) {
    const first = detail[0] as { loc?: unknown[]; msg?: string } | undefined;
    const field = Array.isArray(first?.loc) ? String(first.loc[first.loc.length - 1]) : '';
    const labels: Record<string, string> = {
      title: '标题',
      body: '正文',
      category: '版块',
      structure: '结构文件',
      cover: '封面',
    };
    const label = labels[field] ?? field;
    return new ApiError(status, 'validation_error', `${label || '输入'}不合要求：${first?.msg ?? '请检查'}`);
  }
  return new ApiError(status, 'http_error', `请求失败（${status}）`);
}
