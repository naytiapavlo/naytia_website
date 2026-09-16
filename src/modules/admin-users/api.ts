/** 账号管理 API（归属 admin-users 模块，全部要求 superadmin）。
 *
 * 类型来自 `ports/api-schema`（后端 OpenAPI 生成，ADR-001），不在这里手写字段清单：
 * 这一页读写的就是 `AccountSummary`，与导航角标上的那个是同一份结构。
 */
import { apiFetch } from '../../shared/api-client';
import type { components } from '../../ports/api-schema';
import type { Role } from '../account';

/** 生成的契约里 role 是 string；收窄成 Role 后 ROLE_LABELS 之类的表才能查。 */
export type AccountRow = Omit<components['schemas']['AccountSummary'], 'role'> & {
  role: Role;
};

/**
 * 账号列表；`search` 非空时由**服务端**过滤（大小写不敏感的用户名子串匹配）。
 *
 * 为什么把搜索交给服务端：这一页是管理界面，账号数会增长，前端过滤只能
 * 在「已经拿到的那一批」里找，搜不到时会得出「这个人不存在」的错误结论。
 */
export function fetchAccounts(search = ''): Promise<AccountRow[]> {
  const q = search.trim();
  const path = q ? `/api/admin/accounts?q=${encodeURIComponent(q)}` : '/api/admin/accounts';
  return apiFetch<AccountRow[]>(path);
}

/** 授予 / 收回管理员。不走 role 接口：那个接口按契约能收到 superadmin。 */
export function setAdmin(accountId: number, enabled: boolean): Promise<AccountRow> {
  return apiFetch<AccountRow>(`/api/admin/accounts/${accountId}/admin`, {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  });
}
