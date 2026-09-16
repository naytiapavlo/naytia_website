/**
 * 编辑器引擎：把「已校验的输入」变成「可展示、可编辑的结构状态」。
 *
 * 03 文档第 4 节要求 engine 独立于 UI、不含 DOM 操作；本文件遵守该约定，
 * 因此可以在 Node 里直接测试（tests/mcstructure.test.ts 就是这么跑的）。
 *
 * 编辑操作（放置、填充、调色板增改）不经过 engine.run——它们是**交互式**的，
 * 每次点击都往返一次 ToolResult 没有意义。engine 负责「文件 → 状态」与
 * 「状态 → 文件字节」这两个确定性转换，交互动作直接调用 structure.ts 的纯函数。
 */
import { ok, fail } from '../_host/result';
import type { ComputeContext, ToolEngine, ToolResult } from '../_host/types';
import {
  IMPLEMENTATION_VERSION,
  McStructureError,
  parseStructure,
  serializeStructure,
  summarize,
  type McStructureState,
  type StructureSummary,
} from './structure';
import { MAX_FILE_BYTES, type EditorInput } from './schema';

export interface EditorOutput {
  state: McStructureState;
  summary: StructureSummary;
  /** 原始文件字节数（用于「已修改」对比） */
  originalBytes: number;
}

async function readFileBytes(file: File): Promise<Uint8Array> {
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength > MAX_FILE_BYTES) {
    throw new McStructureError(
      'file_too_large',
      `文件 ${buffer.byteLength} 字节，超过上限 ${MAX_FILE_BYTES}`,
    );
  }
  return new Uint8Array(buffer);
}

export const engine: ToolEngine<EditorInput, EditorOutput> = {
  implementationVersion: IMPLEMENTATION_VERSION,

  async run(input: EditorInput, context: ComputeContext): Promise<ToolResult<EditorOutput>> {
    try {
      if (context.signal.aborted) {
        return fail('cancelled', '已取消', undefined, true);
      }

      const bytes = await readFileBytes(input.file);
      const state = await parseStructure(bytes, input.fileName);
      const summary = summarize(state);

      const warnings: string[] = [];
      if (summary.outOfRange > 0) {
        warnings.push(
          `有 ${summary.outOfRange} 个方块索引超出调色板范围，游戏加载时会当成空气。` +
            '编辑器会把它们当成「未知方块」显示，不会替你改写。',
        );
      }
      if (state.extraRootFields.length > 0) {
        warnings.push(
          `文件里有 ${state.extraRootFields.length} 个编辑器未建模的根字段` +
            `（${state.extraRootFields.join('、')}），已原样保留，下载时不会丢失。`,
        );
      }
      if (summary.blockEntities > 0) {
        warnings.push(
          `包含 ${summary.blockEntities} 个方块实体。编辑方块后，相关格的方块实体数据会被清理；` +
            '结构原点或方块位置变化时，方块实体里的绝对坐标会自动同步。',
        );
      }

      return ok(
        {
          state,
          summary,
          originalBytes: bytes.length,
        },
        warnings,
      );
    } catch (error) {
      if (error instanceof McStructureError) {
        return fail(error.code, error.message);
      }
      if (error instanceof Error && error.name.startsWith('Nbt')) {
        return fail('invalid_structure', error.message);
      }
      throw error;
    }
  },
};

/** 「状态 → 文件字节」——下载用。与 engine 同属确定性转换，放一起便于复用与测试。 */
export function encodeStructure(state: McStructureState): Uint8Array {
  return serializeStructure(state);
}
