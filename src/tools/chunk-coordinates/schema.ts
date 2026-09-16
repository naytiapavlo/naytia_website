/**
 * 区块与坐标助手的输入契约（03 文档第 4 节：schema.ts 负责运行时校验）。
 */
import { parseIntStrict } from '../_host/result';
import type { SchemaResult, ToolSchema } from '../_host/types';

export interface ChunkInput {
  x: number;
  z: number;
  dimension: DimensionId;
}

export type DimensionId = 'overworld' | 'nether' | 'end';

export interface DimensionInfo {
  id: DimensionId;
  label: string;
  /** 该维度可到达的方块 X/Z 边界（超出即不在世界范围内） */
  bound: number;
  /** 方块坐标 → 该维度坐标的缩放比（下界 8 : 主世界 1） */
  coordinateScale: number;
}

export const DIMENSIONS: Record<DimensionId, DimensionInfo> = {
  overworld: { id: 'overworld', label: '主世界', bound: 29_999_999, coordinateScale: 1 },
  nether: { id: 'nether', label: '下界', bound: 29_999_999, coordinateScale: 8 },
  end: { id: 'end', label: '末地', bound: 29_999_999, coordinateScale: 1 },
};

export const dimensionOptions: ReadonlyArray<{ id: DimensionId; label: string }> = [
  { id: 'overworld', label: '主世界' },
  { id: 'nether', label: '下界' },
  { id: 'end', label: '末地' },
];

const MIN_BOUND = -29_999_999;

function parseDimension(raw: unknown): DimensionId {
  return typeof raw === 'string' && raw in DIMENSIONS ? (raw as DimensionId) : 'overworld';
}

export const chunkInputSchema: ToolSchema<ChunkInput> = {
  inputSchemaVersion: 1,

  parse(raw: unknown): SchemaResult<ChunkInput> {
    const source = (raw ?? {}) as Record<string, unknown>;
    const dimension = parseDimension(source.dimension);
    const bound = DIMENSIONS[dimension].bound;

    const x = parseIntStrict(source.x, { min: MIN_BOUND, max: bound, field: 'x' });
    if (!x.ok) return x;
    const z = parseIntStrict(source.z, { min: MIN_BOUND, max: bound, field: 'z' });
    if (!z.ok) return z;

    return { ok: true, value: { x: x.value, z: z.value, dimension } };
  },
};
