/**
 * 编辑器输入契约（03 文档第 4 节：schema.ts 负责运行时校验）。
 *
 * 编辑器的主要输入是「用户选的文件」，不是表单数值。这里校验的是：
 * - 有没有选文件；
 * - 类型是否像 .mcstructure；
 * - 大小是否在上限内。
 *
 * 文件内容的正确性不在这里判断——那由解析器负责，并且会给出具体的格式错误
 * （哪一字节、缺什么字段）。这一层只拦「明显不对的输入」，不猜测修复。
 */
import { type SchemaResult, type ToolError, type ToolSchema } from '../_host/types';

/** 单文件大小上限。结构文件通常几十 KB ~ 几 MB；给到 64 MB 足够。 */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** 允许的扩展名。不只看扩展名，但大小写都要认。 */
const ALLOWED_EXTENSIONS = ['.mcstructure'];

/** 文件名过长时截断展示用（不参与判断）。 */
export const MAX_NAME_LENGTH = 200;

export interface EditorInput {
  file: File;
  /** 文件原名，下载时沿用 */
  fileName: string;
}

function schemaError(code: string, message: string, field?: string): { ok: false; error: ToolError } {
  return { ok: false, error: { code, message, field, retryable: false } };
}

function hasAllowedExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return ALLOWED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export const editorInputSchema: ToolSchema<EditorInput> = {
  inputSchemaVersion: 1,

  parse(raw: unknown): SchemaResult<EditorInput> {
    const source = (raw ?? {}) as Record<string, unknown>;
    const file = source.file;

    if (file === undefined || file === null) {
      return schemaError('no_file', '请先选择一个 .mcstructure 文件', 'file');
    }
    // File 是浏览器对象；结构化克隆/序列化后会退化成普通对象，这里明确拒绝
    if (typeof File !== 'undefined' && !(file instanceof File)) {
      return schemaError('not_a_file', '请选择文件（不是文本或链接）', 'file');
    }

    const typed = file as File;
    const name = typeof typed.name === 'string' && typed.name ? typed.name : 'structure.mcstructure';

    if (name.length > MAX_NAME_LENGTH) {
      return schemaError('name_too_long', `文件名过长（${name.length} 字符）`, 'file');
    }
    if (!hasAllowedExtension(name)) {
      return schemaError(
        'wrong_extension',
        `只支持 .mcstructure 文件，当前是「${name}」。基岩版结构文件由游戏内的结构方块导出。`,
        'file',
      );
    }
    if (typed.size === 0) {
      return schemaError('empty_file', '这个文件是空的', 'file');
    }
    if (typed.size > MAX_FILE_BYTES) {
      return schemaError(
        'file_too_large',
        `文件 ${(typed.size / 1024 / 1024).toFixed(1)} MB，超过 ${MAX_FILE_BYTES / 1024 / 1024} MB 上限`,
        'file',
      );
    }

    return { ok: true, value: { file: typed, fileName: name } };
  },
};
