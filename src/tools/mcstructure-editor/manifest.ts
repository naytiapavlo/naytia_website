/**
 * .mcstructure 编辑器 · 工具定义（宿主从这里读取全部元数据与实现）。
 *
 * 状态定为 stable 的依据：解析、编辑、写回三个阶段都有独立对照测试
 * （`tests/mcstructure.test.ts` 与 `tests/snbt.test.ts`），其中
 * 「解析 → 序列化 → 字节完全一致」与「NBT 树 ↔ SNBT 文本往返一致」
 * 都用真实游戏导出文件验证过；写出的文件能被重新解析。
 */
import type { ToolHostConfig } from '../_host/types';
import { engine, type EditorOutput } from './engine';
import { editorInputSchema, type EditorInput } from './schema';
import { mount } from './view';

export const mcstructureEditorTool: ToolHostConfig<EditorInput, EditorOutput> = {
  id: 'mcstructure-editor',
  slug: 'mcstructure-editor',
  title: '.mcstructure 编辑器',
  summary: '打开基岩版结构文件，用 NBT 树或 SNBT 文本直接编辑，改完下载回 .mcstructure。',
  icon: 'i-grid',
  category: '文件与结构',
  tags: ['mcstructure', '结构文件', '基岩版', '编辑器', 'NBT', 'SNBT'],
  status: 'stable',
  purpose: '把 .mcstructure 里的 NBT 摊开来看清、改准，再原样存回去。',
  scope:
    'Bedrock 基岩版结构文件（Structure Block 导出）。支持未压缩与 gzip/zlib 压缩的输入；' +
    '输出为未压缩的小端 NBT（与游戏导出的口径一致）。文件大小上限 64 MB。' +
    '两种编辑方式：NBT 标签树（逐节点）与 SNBT 文本（可整段复制粘贴）。',
  implementationVersion: engine.implementationVersion,
  inputSchemaVersion: editorInputSchema.inputSchemaVersion,
  executionMode: 'inline',
  supportedRulesetIds: ['mcstructure-v1'],
  rulesetId: 'mcstructure-v1',
  notes: [
    '文件全程留在你的浏览器：解析、编辑与写回都在本地完成，不会上传到服务器，也没有网络请求。',
    '两种编辑方式操作同一棵 NBT 树。NBT 树适合「知道要改哪个字段」，' +
      'SNBT 文本适合「整段复制粘贴、批量改」。',
    'NBT 树里可以改值、改类型、新增字段、新增列表元素、改字段名、删除节点；新增时可选任意 NBT 类型。',
    'SNBT 文本支持游戏内的完整写法：类型后缀（1b / 1s / 1 / 1L / 1.0f / 1.0）、' +
      '数组（[B;1b,2b] / [I;1,2] / [L;1L,2L]）、裸串与带引号字符串、// 注释。',
    'SNBT 语法错误会给出具体的行号与列号，并附上出错那一行的原文，便于定位。',
    '写回时只改动你真正改过的地方——未知字段、方块实体 NBT、实体列表都原样保留，不会静默丢数据。',
    '位置下标按 ZYX 顺序排列（先 Z，再 Y，最后 X），与游戏内的口径一致。',
    '两层结构：主层与次层（共位层，例如水下的水）。结构空位的下标是 -1。',
    '方块实体（箱子内容、告示牌文字等）会被识别并保留；下载时会按结构原点自动同步方块实体里的绝对坐标。',
    '下标超出调色板范围的格子按游戏口径算空气，统计里单独计数，不会替你改写。',
  ],
  relatedContent: [],
  schema: editorInputSchema,
  engine,
  mount,
};
