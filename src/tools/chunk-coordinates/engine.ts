/**
 * 区块与坐标助手 · 纯计算（不含 UI、不碰 DOM，见 03 文档第 4 节 engine.ts）。
 *
 * 规则依据（docs/plans/04 首批工具必要样例）：
 * - 区块大小为 16×16 方块，区块编号 = floor(方块坐标 / 16)。
 * - 负坐标必须向下取整：-1 属于区块 -1，而不是区块 0。
 *   这是本工具最容易出错的地方，也是必须给出对照样例的地方。
 * - 区块内坐标恒为 0 ~ 15，即 ((方块坐标 % 16) + 16) % 16。
 */
import { floorDiv, ok, positiveMod } from '../_host/result';
import type { ComputeContext, ToolEngine, ToolResult } from '../_host/types';
import { DIMENSIONS, type ChunkInput } from './schema';

export const CHUNK_SIZE = 16;
/** 区域文件（region）边长：32×32 区块 */
export const REGION_CHUNKS = 32;

export interface RelatedCoordinate {
  label: string;
  x: number;
  z: number;
  note: string;
}

export interface ChunkOutput {
  input: { x: number; z: number; dimension: string; dimensionLabel: string };
  chunk: { x: number; z: number };
  /** 在区块内的偏移，范围 0 ~ 15 */
  offset: { x: number; z: number };
  region: { x: number; z: number; localIndex: number };
  /** 方块列所属区块的西北角（区块最小坐标处） */
  chunkOrigin: { x: number; z: number };
  related: RelatedCoordinate[];
  notes: string[];
}

function chunkOf(value: number): number {
  return floorDiv(value, CHUNK_SIZE);
}

function offsetOf(value: number): number {
  return positiveMod(value, CHUNK_SIZE);
}

/** 区域文件内的区块下标：region 文件按 32×32 区块存放，下标 = (rx & 31) + (rz & 31) * 32 */
function regionLocalIndex(chunkX: number, chunkZ: number): number {
  return positiveMod(chunkX, REGION_CHUNKS) + positiveMod(chunkZ, REGION_CHUNKS) * REGION_CHUNKS;
}

function offsetText(chunk: number, value: number): string {
  const offset = offsetOf(value);
  if (value >= 0) return `区块内第 ${offset} 格`;
  // 负坐标给出「距区块边界」的读法，避免把 floor 语义误读成截断
  return `区块内第 ${offset} 格（距区块最小坐标 ${value - chunk * CHUNK_SIZE} 格）`;
}

export const engine: ToolEngine<ChunkInput, ChunkOutput> = {
  implementationVersion: '1.0.0',

  async run(input: ChunkInput, _context: ComputeContext): Promise<ToolResult<ChunkOutput>> {
    const { x, z, dimension } = input;
    const info = DIMENSIONS[dimension];

    const chunkX = chunkOf(x);
    const chunkZ = chunkOf(z);
    const offsetX = offsetOf(x);
    const offsetZ = offsetOf(z);
    const regionX = floorDiv(chunkX, REGION_CHUNKS);
    const regionZ = floorDiv(chunkZ, REGION_CHUNKS);

    const related: RelatedCoordinate[] = [];
    // 主世界 ↔ 下界按 8 : 1 对应：下界 1 格 = 主世界 8 格。
    // 所以主世界 → 下界要除以 8，下界 → 主世界要乘以 8。
    if (dimension === 'overworld' || dimension === 'nether') {
      const toNether = dimension === 'overworld';
      const target = toNether ? DIMENSIONS.nether : DIMENSIONS.overworld;
      const scale = toNether ? 1 / 8 : 8;
      const targetX = Math.floor(x * scale);
      const targetZ = Math.floor(z * scale);
      related.push({
        label: `${info.label} → ${target.label}`,
        x: targetX,
        z: targetZ,
        note: toNether
          ? '主世界坐标除以 8：该处对应的下界传送门位置（取整会有 1 格内的偏差）'
          : '下界坐标乘以 8：该处对应的主世界位置',
      });
    }

    const warnings: string[] = [];
    if (offsetX === 0 || offsetZ === 0) {
      warnings.push('该方块位于区块边界上（区块内坐标含 0），相邻区块紧邻这一列。');
    }
    if (Math.abs(x) > 29_999_989 || Math.abs(z) > 29_999_989) {
      warnings.push('坐标接近世界边界，粘贴式建筑、传送门等机制在边界附近可能异常。');
    }

    return ok(
      {
        input: { x, z, dimension, dimensionLabel: info.label },
        chunk: { x: chunkX, z: chunkZ },
        offset: { x: offsetX, z: offsetZ },
        region: { x: regionX, z: regionZ, localIndex: regionLocalIndex(chunkX, chunkZ) },
        chunkOrigin: { x: chunkX * CHUNK_SIZE, z: chunkZ * CHUNK_SIZE },
        related,
        notes: [
          `本方块在区块内的位置：X ${offsetText(chunkX, x)}，Z ${offsetText(chunkZ, z)}。`,
          `所在区块覆盖方块 X ${chunkX * CHUNK_SIZE} ~ ${chunkX * CHUNK_SIZE + CHUNK_SIZE - 1}、Z ${chunkZ * CHUNK_SIZE} ~ ${chunkZ * CHUNK_SIZE + CHUNK_SIZE - 1}。`,
          '区块编号与区域下标是按公式推导的确定值；存档工具显示的编号口径若不同，以工具自身说明为准。',
        ],
      },
      warnings,
    );
  },
};
