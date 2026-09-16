/**
 * 工具定义（含实现）。只应被「详情页的懒加载」引用——导入它会带上该工具的
 * engine 与 view，所以列表页不要碰这个文件（用 tools/manifests.ts）。
 *
 * 新增工具的完整动作（03 文档第 8 节）：建目录 + 写 manifest.ts + 在这里登记一项。
 */
import type { ToolManifest } from './_host/manifest';
import { eraseToolTypes, type ErasedToolConfig } from './_host/types';
import { chunkCoordinatesTool } from './chunk-coordinates/manifest';
import { materialCounterTool } from './material-counter/manifest';

interface ToolModule {
  manifest: ToolManifest;
  /** 详情页通过它拿到 view 与 engine */
  reference: ErasedToolConfig;
}

const registry: Record<string, ToolModule> = {
  [chunkCoordinatesTool.slug]: {
    manifest: chunkCoordinatesTool,
    reference: eraseToolTypes(chunkCoordinatesTool),
  },
  [materialCounterTool.slug]: {
    manifest: materialCounterTool,
    reference: eraseToolTypes(materialCounterTool),
  },
};

export function getToolModule(slug: string): ToolModule | undefined {
  return registry[slug];
}
