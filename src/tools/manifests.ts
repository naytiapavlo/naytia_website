/**
 * 工具清单（可序列化元数据，03 文档第 4 节 ToolManifest）。
 *
 * 本文件只导出数据，不导入任何工具实现或宿主代码——
 * 所以工具目录页引它时，不会把任何 engine / view 打进列表页的产物
 * （05 文档阶段 3 验收：不运行该工具的页面不下载它的实现）。
 */
import { chunkCoordinatesManifest } from './chunk-coordinates/manifest';
import { materialCounterManifest } from './material-counter/manifest';
import type { ToolManifest } from './_host/manifest';

export const toolManifests: readonly ToolManifest[] = [
  chunkCoordinatesManifest,
  materialCounterManifest,
];
