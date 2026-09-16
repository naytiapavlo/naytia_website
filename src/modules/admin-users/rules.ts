/** admin-users 的纯规则：搜索匹配、角色文案、以及「这一行能不能改」。
 *
 * 单独放在一个不碰 DOM 的文件里，是为了让 `npm test` 能直接对照这些判断——
 * 界面上点错一次「取消管理员」的代价，比多写一个文件高得多。
 *
 * 只依赖 `account/roles`（纯词表、零 import），不碰 `account/api` 与 shared：
 * 后两者会把 `ApiError`（构造函数参数属性）拖进来，而 `node --test` 用的是
 * 「只删类型」模式，遇到那种语法直接报错（见 account/roles.ts 的说明）。
 */
import { ROLE_LABELS, type Role } from '../account/roles';

export interface AccountRowLike {
  id: number;
  username: string;
  role: Role;
}

/** 角色文案：会员 / 管理员 / 超级管理员。 */
export const roleLabel = (role: Role): string => ROLE_LABELS[role];

/**
 * 本地搜索（用于服务端返回后的**当前批**复筛与离线降级）。
 *
 * 正式路径是服务端 `?q=`（见 api.ts）；这个函数与后端 `_like_pattern` 同名同义，
 * 大小写不敏感、按子串匹配，不引入正则——用户名允许中文，正则里的元字符
 * 交给 `includes` 处理比让用户去理解转义更安全。
 */
export function matchesSearch(username: string, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  return username.toLowerCase().includes(q);
}

/** 界面上把「超管」也视为管理员档位（超管本来就有管理员的全部能力）。 */
export function isAdminTier(role: Role): boolean {
  return role === 'admin' || role === 'superadmin';
}

/**
 * 开关状态：这一行现在「是不是管理员」。
 *
 * 只看 admin / superadmin 两档——按钮的两个方向都是相对**管理员**这一档说的：
 * 会员显示「设为管理员」，管理员显示「取消管理员」。超管的行不放开关
 * （见 rowCapability），所以这里返回 true 只是让口径自洽，不会画出一个能点的按钮。
 */
export const adminToggleOn = (role: Role): boolean => isAdminTier(role);

export interface RowCapability {
  /** 能不能切换这一行的管理员状态。 */
  canToggle: boolean;
  /** 不能切换时，界面上的原因（人话，直接显示给使用者）。 */
  reason: string | null;
}

/**
 * 一行账号的可操作性。
 *
 * 与服务端 `_writable_target` 的两道拒绝一一对应（`self_role_change` / `is_superadmin`）。
 * 前端先拦一道是为了**不让人点了才失败**，不是权限边界——
 * 真正的判定始终在服务端，绕过界面直接调 API 一样会被拒。
 */
export function rowCapability(account: AccountRowLike, selfId: number | null): RowCapability {
  if (selfId !== null && account.id === selfId) {
    return { canToggle: false, reason: '不能修改自己的角色' };
  }
  if (account.role === 'superadmin') {
    // 超管本来就拥有管理员的全部能力，把这一档降下来是纯粹的权限损失，
    // 只可能来自误操作——所以不给开关，而不是给一个点了会报错的按钮。
    return {
      canToggle: false,
      reason: '超级管理员的管理员身份不能取消（超管档位只能由引导规则或邀请码产生）',
    };
  }
  return { canToggle: true, reason: null };
}

/** 变更确认话术：两个方向的后果不一样，按钮文案也不一样。 */
export function togglePrompt(username: string, enabled: boolean): string {
  return enabled
    ? `把「${username}」设为管理员？他将可以审核并删除论坛里的任何帖子与回复。`
    : `取消「${username}」的管理员身份？他将退回普通会员，失去内容审核权限。`;
}

/** 结果提示：与上面的话术对称，让使用者能确认「改变的是什么」。 */
export function toggleDone(username: string, enabled: boolean): string {
  return enabled ? `「${username}」已设为管理员` : `已取消「${username}」的管理员身份`;
}

/** 统计口径：这一批里各档位有多少人（管理员数含超管）。 */
export function roleCounts(rows: AccountRowLike[]): Record<Role, number> {
  const counts: Record<Role, number> = { member: 0, admin: 0, superadmin: 0 };
  for (const row of rows) counts[row.role] += 1;
  return counts;
}
