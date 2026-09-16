/**
 * 工具清单。
 *
 * 本文件**只导出数据**：不导出 schema、engine 或 view，所以工具目录页
 * 引它时不会把任何工具实现打进列表页产物——每个工具的具体实现只在它自己的
 * 详情页产物里（05 文档阶段 3 验收：不运行该工具的页面不下载它的实现）。
 *
 * 每个条目同时提供「可序列化元数据」（ToolManifest 字段）与「详情页文档」
 * （purpose / scope / notes / relatedContent / rulesetId）。
 */
import { mcstructureEditorTool } from './mcstructure-editor/manifest';
import type { ToolManifest } from './_host/manifest';
import type { RelatedContent } from './_host/types';

/** 详情页渲染所需的完整工具定义（含元数据与文档字段，不含实现）。 */
export interface ToolPageDefinition extends ToolManifest {
  purpose: string;
  scope: string;
  rulesetId: string;
  notes: string[];
  relatedContent: RelatedContent[];
}

export const toolManifests: readonly ToolPageDefinition[] = [
  mcstructureEditorTool,
];
