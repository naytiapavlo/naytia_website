/**
 * 工具箱目录清单 = 站内工具 + 外部入口。
 *
 * 为什么与 manifests.ts 分开：
 * - `manifests.ts` 是「有 /tools/<slug>/ 详情页的工具」，宿主会为每一项生成路由，
 *   所以那里面每一项都必须自带 schema / engine / view。
 * - 自成一套全屏界面的功能（逆向工作台 /ida/、文档树 /docs/）没有也不该有工具宿主
 *   协议；它们只是**入口**，所以登记在这里，用 entryHref 直接跳转。
 *
 * 本文件同样只导出数据，不导入任何工具实现。
 */
import { toolManifests, type ToolPageDefinition } from './manifests';
import type { ToolManifest } from './_host/manifest';

/**
 * 逆向工作台入口（/ida/）。
 *
 * 不设门槛：**访客可读**是需求明确要求的（浏览反汇编与伪代码）。
 * 工作台里的写操作（重命名、切换实例）仍只对 admin 显示，
 * 且 /api/reverse/* 在服务端另有拦截——前端隐藏控件不作为权限控制。
 */
const reverseWorkbench: ToolManifest = {
  id: 'bds-reverse',
  slug: 'bds-reverse',
  title: 'BDS 逆向工作台',
  summary: '浏览 Minecraft 基岩版服务端的反汇编与 Hex-Rays 伪代码：函数检索、交叉引用、字符串搜索，还能问 AI。',
  icon: 'i-target',
  category: '逆向与分析',
  tags: ['IDA', '反编译', 'BDS', '逆向'],
  status: 'experimental',
  implementationVersion: '0.1.0',
  inputSchemaVersion: 1,
  executionMode: 'server',
  supportedRulesetIds: ['ida-mcp-v2'],
  entryHref: '/ida/',
};

/**
 * 文档树入口（/docs/）。
 *
 * 不设 admin 门槛：**访客本来就要能读**（这是需求的核心）。管理员上传与超管审核
 * 入口在同一个页面里按角色显示，真正的写权限由 /api/docs/* 在服务端判定。
 */
const docsTree: ToolManifest = {
  id: 'docs-tree',
  slug: 'docs-tree',
  title: '文档树',
  summary: '按目录浏览机制研究与逆向笔记：访客可读可搜，管理员上传投稿，站长审核后公开。',
  icon: 'i-note',
  category: '资料与检索',
  tags: ['文档', '知识库', 'Markdown', '检索'],
  status: 'stable',
  implementationVersion: '0.1.0',
  inputSchemaVersion: 1,
  executionMode: 'server',
  supportedRulesetIds: ['docs-tree-v1'],
  entryHref: '/docs/',
};

export type CatalogEntry = ToolManifest | ToolPageDefinition;

export const toolCatalog: readonly CatalogEntry[] = [...toolManifests, docsTree, reverseWorkbench];

/** 目录里可运行（有真实入口）的项数，供目录页脚注使用。 */
export function isAvailable(entry: CatalogEntry): boolean {
  return Boolean(entry.entryHref) || entry.status !== 'planned';
}
