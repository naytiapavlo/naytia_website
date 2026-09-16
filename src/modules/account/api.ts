/** 账号会话 API（归属 account 模块）。 */
import { apiFetch } from '../../shared/api-client';

export type Role = 'member' | 'admin' | 'superadmin';

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

export const ROLE_LABELS: Record<Role, string> = {
  member: '会员',
  admin: '管理员',
  superadmin: '超级管理员',
};
