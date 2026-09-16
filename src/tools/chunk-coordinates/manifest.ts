/**
 * 区块与坐标助手 · 工具定义（宿主从这里读取全部元数据与实现）。
 *
 * 状态定为 stable 的依据：算法是「向下取整」这一条确定规则，
 * 边界样例（-17 / -16 / -1 / 0 / 15 / 16）有独立对照测试（见 tools.test.ts）。
 */
import type { ToolManifest } from '../_host/manifest';
import type { ToolHostConfig } from '../_host/types';
import { engine, type ChunkOutput } from './engine';
import { chunkInputSchema, type ChunkInput } from './schema';
import { mount } from './view';

/** 可序列化元数据：目录页只用这一段（satisfies 保证仍按字面量推断 status）。 */
export const chunkCoordinatesManifest = {
  id: 'chunk-coordinates',
  slug: 'chunk-coordinates',
  title: '区块与坐标助手',
  summary: '方块坐标换区块坐标、区块内坐标与区域文件下标，含主世界↔下界换算。',
  icon: 'i-target',
  category: '坐标与定位',
  tags: ['坐标', '区块', '区域文件', '传送门'],
  status: 'stable',
  implementationVersion: engine.implementationVersion,
  inputSchemaVersion: chunkInputSchema.inputSchemaVersion,
  executionMode: 'inline',
  supportedRulesetIds: ['chunk-16-v1'],
} satisfies ToolManifest;

export const chunkCoordinatesTool: ToolHostConfig<ChunkInput, ChunkOutput> = {
  ...chunkCoordinatesManifest,
  purpose: '把「我在哪一格」翻译成区块编号、区块内偏移和区域文件位置。',
  scope: '主世界 / 下界 / 末地，坐标范围 ±29,999,999。区块大小为 16×16，负坐标按向下取整归入区块。',
  rulesetId: 'chunk-16-v1',
  notes: [
    '负坐标是最容易出错的地方：-1 属于区块 -1，而不是区块 0。本工具按向下取整计算，并有对照测试。',
    '「区域文件」一行是按 32×32 区块的存放规则推导的下标，用于理解存档结构；它不是游戏内会显示的数字。',
    '主世界与下界的换算按 8 : 1 换算（主世界 ÷ 8、下界 × 8），结果向下取整，可能有 1 格内偏差，主要用于估算传送门对应位置。',
  ],
  relatedContent: [{ kind: 'work', id: 'chest-entanglement', label: '箱子纠缠 · 超距信号传递' }],
  schema: chunkInputSchema,
  engine,
  mount,
};
