/**
 * 展示层格式化：把解析结果整理成界面要用的形状。
 * 纯函数、不碰 DOM、不发请求，便于单独测试（与 tools 的 engine 同口径）。
 */
import type { BlockCountEntry, LayerStats, StructureIndex } from './api';

export interface StructureSummary {
  /** 尺寸文案，如 16 × 8 × 16 */
  sizeText: string;
  /** 每层格数 */
  voxelCount: number;
  /** 非 void 方块总数 */
  filled: number;
  /** 填充率 0~1（非 void / 总格数，两层合并后可能 >1，这里按主层口径） */
  fillRatio: number;
  /** 方块种类数 */
  kinds: number;
  /** 压缩方式文案 */
  compressionText: string;
  /** 文件体积文案 */
  fileSizeText: string;
  /** 方块实体与实体数量 */
  blockEntityCount: number;
  entityCount: number;
  /** 越界下标提示（有才给） */
  outOfRangeWarning: string | null;
  /** 世界原点文案（可能缺失） */
  worldOriginText: string;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * 结构内坐标 -> 位置下标。
 * 文档口径：block_indices 按 ZYX 顺序展开（先 Z，再 Y，最后 X），
 * 即 index = x * (sizeY * sizeZ) + y * sizeZ + z。后端 /position 用同一公式。
 */
export function positionToIndex(
  x: number,
  y: number,
  z: number,
  size: { x: number; y: number; z: number },
): number {
  return x * (size.y * size.z) + y * size.z + z;
}

export function summarize(structure: StructureIndex): StructureSummary {
  const { size, voxel_count: voxelCount, world_origin: origin } = structure.layout;
  const stats = structure.stats;
  const primary: LayerStats | undefined = stats.layers.find((layer) => layer.layer === 0);

  const compression = structure.compression;
  const compressionText =
    compression === 'gzip' ? 'gzip 压缩' : compression === 'zlib' ? 'zlib 压缩' : '未压缩';

  const outOfRange = stats.out_of_range_indices;

  return {
    sizeText: `${size.x} × ${size.y} × ${size.z}`,
    voxelCount,
    filled: stats.filled,
    fillRatio: primary ? primary.fill_ratio : 0,
    kinds: stats.palette_used,
    compressionText,
    fileSizeText: formatBytes(structure.file_bytes),
    blockEntityCount: structure.block_entities.length,
    entityCount: structure.entities.length,
    outOfRangeWarning:
      outOfRange > 0
        ? `有 ${outOfRange} 个方块索引超出调色板范围，游戏加载时会当成空气（这里如实计数，没有替你改写）。`
        : null,
    worldOriginText: origin
      ? `X ${origin.x} / Y ${origin.y} / Z ${origin.z}`
      : '文件未记录（structure_world_origin 缺失）',
  };
}

/** 取统计里前 n 种方块，用于概览表格。 */
export function topBlocks(structure: StructureIndex, limit = 20): BlockCountEntry[] {
  return structure.stats.blocks.slice(0, limit);
}
