/**
 * 工具的公开描述（03 文档第 4 节 ToolManifest）。
 * 这里是「列表页只用到的可序列化元数据」——不含 schema、engine、view，
 * 所以工具目录页不会把任何计算实现打进包里。
 */
import type { ExecutionMode, ToolStatus } from './types';

export type { ExecutionMode, ToolStatus };

export interface ToolManifest {
  id: string;
  slug: string;
  title: string;
  summary: string;
  /** 像素图标 symbol id，见 BaseLayout 的 SVG sprite */
  icon: string;
  category: string;
  tags: string[];
  status: ToolStatus;
  implementationVersion: string;
  inputSchemaVersion: number;
  executionMode: ExecutionMode;
  supportedRulesetIds: string[];
  /**
   * 可见性门槛（可选）。'admin' 表示只对 admin/superadmin 显示——
   * 用于依赖敏感能力（如访问本机 IDA 实例）的入口。
   * 这只是界面可见性；真正的权限拦截必须在服务端路由上。
   */
  gate?: 'admin';
  /**
   * 外部入口（可选）。填写后目录页的卡片直接跳到这个路径，
   * 而不是 /tools/<slug>/——用于「自成一套界面」的功能（如逆向工作台）。
   */
  entryHref?: string;
}

export const toolStatusLabels: Record<ToolStatus, string> = {
  planned: '规划中',
  experimental: '实验性',
  stable: '可用',
  deprecated: '已弃用',
};

/**
 * status='planned' 的工具不渲染任何可运行入口（01 文档第 6 节）。
 * 宿主用这个判断决定是否挂载视图，页面不各自复述规则。
 */
export function isRunnable(status: ToolStatus): boolean {
  return status !== 'planned';
}
