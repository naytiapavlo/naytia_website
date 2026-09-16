/**
 * account 模块公开接口（唯一入口）。
 * 其他模块只从这里获取会话与角色；会话变化通过 `naytia:session` 事件广播
 * （detail 为账号或 null），订阅方自行响应——见 src/modules/README.md。
 */
export { type AccountSummary, type Role, ROLE_LABELS, me, login, logout, register } from './api';
export { currentSession, mountAccountChip, openAccountDialog, SESSION_EVENT } from './ui';
