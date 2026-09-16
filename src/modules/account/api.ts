/** 账号会话 API（归属 account 模块）。 */
import { apiFetch } from '../../shared/api-client';
import { ROLE_LABELS, type Role } from './roles';

// 词表在 roles.ts（无依赖，供纯逻辑文件引用）；这里再导出一次，
// 让 account 的公开接口仍然是「从 index.ts 拿 Role / ROLE_LABELS」这一条路径。
export { ROLE_LABELS, type Role };

export interface AccountSummary {
  id: number;
  username: string;
  role: Role;
  created_at: string;
}

export function me(): Promise<AccountSummary | null> {
  return apiFetch<AccountSummary | null>('/api/auth/me');
}

export function login(username: string, password: string): Promise<AccountSummary> {
  return apiFetch<AccountSummary>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

export function logout(): Promise<void> {
  return apiFetch<void>('/api/auth/logout', { method: 'POST' });
}

export function register(username: string, password: string, code?: string): Promise<AccountSummary> {
  return apiFetch<AccountSummary>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(code ? { username, password, code } : { username, password }),
  });
}
