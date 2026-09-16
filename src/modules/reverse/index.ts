/**
 * reverse 模块公开接口（唯一入口）。
 * 其他模块只从这里 `import { initReverseWorkspace }`，
 * 不深入本目录内部文件（见 src/modules/README.md 第 1 条）。
 */
export { initReverseWorkspace } from './workspace';
export type {
  BinaryOverview,
  FunctionSummary,
  IdaInstance,
  IdaStatus,
  ReversePermissions,
} from './api';
