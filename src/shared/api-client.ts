/**
 * 后端 API 基地址与统一请求封装（shared 基础能力，见 docs/plans/02 分层）。
 * 开发期通过 PUBLIC_API_BASE 覆盖；同域部署时为空串，走相对路径
 * （正式部署由 deploy/server.py 把站点与 /api 收在同一个来源下，见 docs/plans/14）。
 */
export const API_BASE: string = import.meta.env.PUBLIC_API_BASE ?? '';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as
    | { detail?: { code?: string; message?: string } }
    | T
    | null;
  if (!res.ok) {
    const detail = (data as { detail?: { code?: string; message?: string } })?.detail;
    throw new ApiError(
      res.status,
      detail?.code ?? 'http_error',
      detail?.message ?? `请求失败（${res.status}）`,
    );
  }
  return data as T;
}
