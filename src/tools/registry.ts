/**
 * 工具定义（含实现）。只应被「详情页的懒加载」引用——导入它会带上该工具的
 * engine 与 view，所以列表页不要碰这个文件（用 tools/manifests.ts）。
 *
 * 用动态 import 而不是静态 import：这样每个工具各自成块，
 * 打开 A 工具的页面不会下载 B 工具的实现（05 文档阶段 3 验收项）。
 * slug 只用于在这张显式表里查表，绝不拼接成模块路径去加载（02 文档第 5 节第 4 条）。
 *
 * 新增工具的完整动作（03 文档第 8 节）：建目录 + 写 manifest.ts + 在这里登记一项。
 */
import type { ToolManifest } from './_host/manifest';
import { eraseToolTypes, type ErasedToolConfig } from './_host/types';

export interface ToolModule {
  manifest: ToolManifest;
  /** 详情页通过它拿到 view 与 engine */
  reference: ErasedToolConfig;
}

const loaders: Record<string, () => Promise<ToolModule>> = {
  'mcstructure-editor': async () => {
    const { mcstructureEditorTool } = await import('./mcstructure-editor/manifest');
    return { manifest: mcstructureEditorTool, reference: eraseToolTypes(mcstructureEditorTool) };
  },
};

export async function loadToolModule(slug: string): Promise<ToolModule | undefined> {
  const load = loaders[slug];
  return load ? load() : undefined;
}
