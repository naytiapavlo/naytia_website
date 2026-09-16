/**
 * admin-users 模块公开接口（唯一入口）。
 *
 * 职责：超级管理员的账号管理页（`/admin/users/`）——按名字搜索账号、
 * 授予或收回管理员。权限一律服务端判定（`/api/admin/*` 的 require_superadmin），
 * 本模块只负责界面与「点了会失败」的前置提示。
 *
 * 依赖方向：admin-users → account（会话与角色文案）+ shared（api-client / toast）。
 * account / site-config / site-admin 都不感知本模块。
 */
export { initAdminUsers, mountAdminNav } from './ui';
export { type AccountRow, fetchAccounts, setAdmin } from './api';
// 规则整体再导出：它们是这一页的可测内核（`tests/admin-users.test.ts` 直接对照），
// 逐项挑选只会让「改了 rules 忘了改 index」变成一种失败方式。
export * from './rules';
