/**
 * 角色词表（account 模块内部的基础件）：只有类型与文案，**不 import 任何东西**。
 *
 * 为什么从 api.ts 里拆出来：这个文件必须能被 Node 的「只删类型」模式直接运行
 * （`npm test` 用 `node --test` 跑 .ts，不做类型转换）。api.ts 依赖 shared/api-client，
 * 而那里的 `ApiError` 用了构造函数参数属性（`constructor(public status: number…)`），
 * 属于 strip-only 模式明确不支持的语法——于是任何 `import { ROLE_LABELS } from './api'`
 * 的纯逻辑文件都会在测试里连编译都过不了。把词表挪开，纯逻辑就能被对照测试覆盖。
 */
export type Role = 'member' | 'admin' | 'superadmin';

export const ROLE_LABELS: Record<Role, string> = {
  member: '会员',
  admin: '管理员',
  superadmin: '超级管理员',
};
