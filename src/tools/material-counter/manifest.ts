/**
 * 材料清单助手 · 工具定义。
 *
 * 状态定为 stable 的依据：只有「组数 = 向下取整、余量 < 堆叠上限」一条确定算法，
 * 边界样例（0 / 1 / 恰好一组 / 不可堆叠 / 大数量）有独立对照测试。
 */
import type { ToolManifest } from '../_host/manifest';
import type { ToolHostConfig } from '../_host/types';
import { engine, type MaterialOutput } from './engine';
import { materialInputSchema, type MaterialInput } from './schema';
import { mount } from './view';

/** 可序列化元数据：目录页只用这一段。 */
export const materialCounterManifest = {
  id: 'material-counter',
  slug: 'material-counter',
  title: '材料清单助手',
  summary: '多种材料一次换算：组数、零头与占用格数，并按容器容量算出需要几个潜影盒。',
  icon: 'i-box',
  category: '材料与准备',
  tags: ['材料', '堆叠', '潜影盒', '箱子'],
  status: 'stable',
  implementationVersion: engine.implementationVersion,
  inputSchemaVersion: materialInputSchema.inputSchemaVersion,
  executionMode: 'inline',
  supportedRulesetIds: ['stack-slots-v1'],
} satisfies ToolManifest;

export const materialCounterTool: ToolHostConfig<MaterialInput, MaterialOutput> = {
  ...materialCounterManifest,
  purpose: '开工前先算清楚：要几组材料、占几格、带几个潜影盒。',
  scope: '堆叠上限按 1 ~ 64 由你逐条填写（不假设所有物品都是 64）。容器容量取潜影盒 / 箱子 27 格、大箱子 54 格。',
  rulesetId: 'stack-slots-v1',
  notes: [
    '堆叠上限不写死：工具、潜影盒等不可堆叠物品填 1，末影珍珠等填 16，普通方块填 64。',
    '容器数按占用格数换算，不假设多种材料之间的最优装箱；实际打包时零头可以互相凑格。',
    '余量不为 0 时仍要占一整格，所以「占用格数」用的是向上取整，不是组数。',
  ],
  relatedContent: [],
  schema: materialInputSchema,
  engine,
  mount,
};
