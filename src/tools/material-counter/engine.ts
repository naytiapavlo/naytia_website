/**
 * 材料清单助手 · 纯计算。
 *
 * 规则（docs/plans/04 首批工具必要样例：0、1、堆叠上限前后、16/64/不可堆叠物品、非整数、负数、安全整数边界）：
 * - 每种材料：组数 = floor(数量 / 堆叠上限)，余量 = 数量 % 堆叠上限；
 *   余量不为 0 时仍占 1 格，所以占用格数 = ceil(数量 / 堆叠上限)。
 * - 堆叠上限为 1 的材料（工具、潜影盒等）占用格数就等于数量。
 * - 合计占用格数 = 各材料占用格数之和；容器数量 = ceil(总格数 / 容器容量)。
 *   这是「容器数」的定义：按格数换算，不假设多种材料能塞进同一个容器的最优装箱。
 */
import { ok } from '../_host/result';
import type { ComputeContext, ToolEngine, ToolResult } from '../_host/types';
import { MAX_SLOTS, type MaterialInput } from './schema';

export interface MaterialLine {
  name: string;
  count: number;
  stackSize: number;
  fullStacks: number;
  remainder: number;
  slots: number;
}

export interface ContainerPlan {
  label: string;
  /** 每个容器的格数 */
  slots: number;
  /** 需要的容器个数 */
  need: number;
  /** 全部容器的总容量 */
  capacity: number;
  /** 装完后最后一个容器剩余的空位 */
  spare: number;
  /** 是否装满了整数个容器 */
  exact: boolean;
}

export interface MaterialOutput {
  lines: MaterialLine[];
  totals: {
    /** 材料种类数 */
    kinds: number;
    count: number;
    /** 各材料满组数之和 */
    fullStacks: number;
    slots: number;
  };
  container: ContainerPlan | null;
  formula: string[];
}

export const engine: ToolEngine<MaterialInput, MaterialOutput> = {
  implementationVersion: '1.0.0',

  async run(input: MaterialInput, _context: ComputeContext): Promise<ToolResult<MaterialOutput>> {
    const lines: MaterialLine[] = input.entries.map((entry) => {
      const fullStacks = Math.floor(entry.count / entry.stackSize);
      return {
        name: entry.name,
        count: entry.count,
        stackSize: entry.stackSize,
        fullStacks,
        remainder: entry.count % entry.stackSize,
        slots: Math.ceil(entry.count / entry.stackSize),
      };
    });

    const totalCount = lines.reduce((sum, line) => sum + line.count, 0);
    const totalFullStacks = lines.reduce((sum, line) => sum + line.fullStacks, 0);
    const totalSlots = lines.reduce((sum, line) => sum + line.slots, 0);

    const warnings: string[] = [];
    if (totalSlots > MAX_SLOTS) {
      warnings.push(`占用格数超过 ${MAX_SLOTS.toLocaleString('zh-CN')} 格，容器换算结果仅供参考。`);
    }
    if (lines.some((line) => line.stackSize === 1)) {
      warnings.push('存在堆叠上限为 1 的材料，它们每一件都单独占用一格。');
    }

    let container: ContainerPlan | null = null;
    if (input.containerSlots > 0) {
      const need = Math.ceil(totalSlots / input.containerSlots);
      const capacity = need * input.containerSlots;
      container = {
        label: input.containerLabel,
        slots: input.containerSlots,
        need,
        capacity,
        spare: capacity - totalSlots,
        exact: capacity === totalSlots,
      };
    }

    const formula: string[] = [
      `共 ${lines.length} 种材料、${totalCount.toLocaleString('zh-CN')} 件物品。`,
      `合计占用 ${totalSlots} 格（各材料占用格数之和）。`,
    ];
    if (container) {
      formula.push(
        `${totalSlots} 格 ÷ ${container.slots}（每个容器 ${container.slots} 格）= 需要 ${container.need} 个${container.label}${container.exact ? '，刚好装满' : `，最后一个还剩 ${container.spare} 格空位`}。`,
      );
      formula.push('容器数按占用格数换算，未假设多种材料之间的最优装箱。');
    } else {
      formula.push('未选择容器，只给出组数与占用格数。');
    }

    return ok(
      {
        lines,
        totals: {
          kinds: lines.length,
          count: totalCount,
          fullStacks: totalFullStacks,
          slots: totalSlots,
        },
        container,
        formula,
      },
      warnings,
    );
  },
};
