/**
 * 材料清单助手的输入契约。
 *
 * 关键设计（01 文档第 6 节明确要求）：
 * - 不把「所有物品都是 64 堆叠」写死：每条材料各自带堆叠上限。
 * - 多条材料一次算清，给出每种材料的组数和合计占用的容器数。
 * - 数量为 0 或留空的材料行直接忽略，不当成错误（还在填表的中间状态）。
 */
import { parseIntStrict } from '../_host/result';
import type { SchemaResult, ToolSchema } from '../_host/types';

export interface ContainerPreset {
  id: string;
  label: string;
  /** 每个容器可容纳的物品格数；0 表示不换算容器 */
  slots: number;
}

/** 容器容量取自游戏内实际格数：潜影盒 27、箱子 27、大箱子 54。 */
export const CONTAINER_PRESETS: ReadonlyArray<ContainerPreset> = [
  { id: 'none', label: '不换算容器', slots: 0 },
  { id: 'shulker', label: '潜影盒（27 格）', slots: 27 },
  { id: 'chest', label: '箱子 / 木桶（27 格）', slots: 27 },
  { id: 'double-chest', label: '大箱子（54 格）', slots: 54 },
];

/** 常见的堆叠上限，作为输入提示；实际允许 1 ~ 64 的任意整数（模组可能不同）。 */
export const STACK_PRESETS: ReadonlyArray<number> = [64, 16, 32, 1];

export const MAX_ENTRIES = 40;
export const MAX_COUNT = 1_000_000_000;
export const MAX_STACK = 64;
/** 单次计算的物品总格数上限，避免无意义的超大输入。 */
export const MAX_SLOTS = 1_000_000;

export interface MaterialEntry {
  name: string;
  count: number;
  stackSize: number;
}

export interface MaterialInput {
  entries: MaterialEntry[];
  containerSlots: number;
  containerLabel: string;
}

const DEFAULT_NAME = '未命名材料';

export const materialInputSchema: ToolSchema<MaterialInput> = {
  inputSchemaVersion: 1,

  parse(raw: unknown): SchemaResult<MaterialInput> {
    const source = (raw ?? {}) as Record<string, unknown>;
    const rawEntries = Array.isArray(source.entries) ? source.entries : [];

    if (rawEntries.length > MAX_ENTRIES) {
      return schemaError('too_many_entries', `一次最多计算 ${MAX_ENTRIES} 条材料`, 'entries');
    }

    const entries: MaterialEntry[] = [];

    for (let index = 0; index < rawEntries.length; index += 1) {
      const item = (rawEntries[index] ?? {}) as Record<string, unknown>;
      const field = `entries.${index}`;

      const rawName = typeof item.name === 'string' ? item.name.trim() : '';
      if (rawName.length > 40) {
        return schemaError('name_too_long', '材料名称请不要超过 40 个字符', `${field}.name`);
      }

      // 留空视为 0，跳过这一行
      if (item.count === '' || item.count === null || item.count === undefined) continue;
      const count = parseIntStrict(item.count, { min: 0, max: MAX_COUNT, field: `${field}.count` });
      if (!count.ok) {
        return { ok: false, error: { ...count.error, message: `第 ${index + 1} 条：${count.error.message}` } };
      }
      if (count.value === 0) continue;

      const stack = parseIntStrict(item.stackSize, {
        min: 1,
        max: MAX_STACK,
        field: `${field}.stackSize`,
      });
      if (!stack.ok) {
        return { ok: false, error: { ...stack.error, message: `第 ${index + 1} 条：${stack.error.message}` } };
      }

      entries.push({
        name: rawName === '' ? DEFAULT_NAME : rawName,
        count: count.value,
        stackSize: stack.value,
      });
    }

    if (entries.length === 0) {
      return schemaError('empty_list', '请至少填写一条材料的数量', 'entries.0.count');
    }

    const container = CONTAINER_PRESETS.find((preset) => preset.id === source.container) ??
      CONTAINER_PRESETS[0]!;

    return {
      ok: true,
      value: {
        entries,
        containerSlots: container.slots,
        containerLabel: container.label,
      },
    };
  },
};

function schemaError(code: string, message: string, field: string): SchemaResult<never> {
  return { ok: false, error: { code, message, field, retryable: false } };
}
