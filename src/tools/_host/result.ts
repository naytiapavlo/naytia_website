/**
 * 结果与输入的公共构造/解析工具（宿主与各工具的 engine 共用）。
 * 只放确有两个以上使用者的能力，不堆业务规则。
 */
import type { ToolError, ToolResult } from './types';

export function ok<T>(value: T, warnings: string[] = []): ToolResult<T> {
  return { ok: true, value, warnings };
}

export function fail<T = never>(
  code: string,
  message: string,
  field?: string,
  retryable = false,
): ToolResult<T> {
  return { ok: false, error: { code, message, field, retryable } };
}

export function schemaFail(
  code: string,
  message: string,
  field?: string,
): { ok: false; error: ToolError } {
  return { ok: false, error: { code, message, field, retryable: false } };
}

/**
 * 把用户输入解析成安全范围内的整数。
 * 拒绝空串、小数、非数字与超出 JavaScript 安全整数的值——不四舍五入、不猜测修复。
 */
export function parseIntStrict(
  raw: unknown,
  options: { min: number; max: number; field: string },
): { ok: true; value: number } | { ok: false; error: ToolError } {
  const { min, max, field } = options;
  const text = typeof raw === 'string' ? raw.trim() : raw;
  if (text === '' || text === null || text === undefined) {
    return schemaFail('empty_value', '请填写这项数值', field);
  }
  const num = typeof text === 'number' ? text : Number(text);
  if (!Number.isFinite(num)) {
    return schemaFail('not_a_number', '请输入数字', field);
  }
  if (!Number.isInteger(num)) {
    return schemaFail('not_an_integer', '请输入整数（不支持小数）', field);
  }
  if (!Number.isSafeInteger(num)) {
    return schemaFail('out_of_safe_range', '数值超出可精确计算的范围', field);
  }
  if (num < min || num > max) {
    return schemaFail('out_of_range', `数值需在 ${min} ~ ${max} 之间`, field);
  }
  return { ok: true, value: num };
}

/**
 * 向下取整除法（Math.floor 语义）。
 * 单独抽出来是因为负坐标：JS 的 `/` 截断趋零，-1 / 16 得到 -0 而不是 -1，
 * 直接用会算错区块编号（docs/plans/04 首批工具样例明确要求覆盖负数边界）。
 */
export function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

/** 始终返回非负余数，用于「区块内坐标」这类 0 ~ b-1 的取值。 */
export function positiveMod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

/** 千分位格式化，仅用于展示，不参与计算。 */
export function formatInt(value: number): string {
  return value.toLocaleString('zh-CN');
}
