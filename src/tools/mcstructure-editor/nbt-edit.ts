/**
 * NBT 树的编辑操作 —— 纯函数，不碰 DOM。
 *
 * 用「路径」定位节点，而不是把整棵树深拷贝出去再换回来：
 * - 深拷贝在结构文件上很贵（block_indices 每层可能上百万项）；
 * - 路径定位让「改一个值」的代价与树的大小无关；
 * - 路径同时是界面要展示的东西（`structure.block_indices[0][5]`），一举两得。
 *
 * 路径段：复合体用键名（string），列表/数组用下标（number）。
 * 复合体用 Map 存储，所以「保持插入顺序」是天然的，改名/新增都不会打乱顺序。
 */
import { TAG, type NbtCompound, type NbtValue } from './nbt';

/** 路径段：复合体的键，或列表/数组的下标。 */
export type PathSegment = string | number;
export type NbtPath = readonly PathSegment[];

export class NbtEditError extends Error {}

/** 按路径取节点；不存在返回 undefined。 */
export function getAtPath(root: NbtCompound, path: NbtPath): NbtValue | undefined {
  let current: NbtValue = { type: TAG.Compound, value: root };
  for (const segment of path) {
    if (current.type === TAG.Compound) {
      if (typeof segment !== 'string') return undefined;
      const next: NbtValue | undefined = current.value.get(segment);
      if (!next) return undefined;
      current = next;
    } else if (current.type === TAG.List) {
      if (typeof segment !== 'number') return undefined;
      const next: NbtValue | undefined = current.value[segment];
      if (!next) return undefined;
      current = next;
    } else if (current.type === TAG.ByteArray || current.type === TAG.IntArray) {
      return undefined; // 数值数组不按路径下钻，直接整体编辑
    } else {
      return undefined;
    }
  }
  return current;
}

/** 取父节点与最后一段，便于原地替换。 */
function getParent(root: NbtCompound, path: NbtPath): { parent: NbtValue; last: PathSegment } {
  if (path.length === 0) throw new NbtEditError('不能替换根节点');
  const parentPath = path.slice(0, -1);
  const last = path[path.length - 1]!;
  const parent = parentPath.length === 0
    ? ({ type: TAG.Compound, value: root } as NbtValue)
    : getAtPath(root, parentPath);
  if (!parent) throw new NbtEditError('路径上的父节点不存在');
  return { parent, last };
}

/** 把一个节点的值换成新的（类型可以不同），原地修改。 */
export function setAtPath(root: NbtCompound, path: NbtPath, value: NbtValue): void {
  const { parent, last } = getParent(root, path);
  if (parent.type === TAG.Compound) {
    if (typeof last !== 'string') throw new NbtEditError('复合体的路径段必须是键名');
    if (!parent.value.has(last)) throw new NbtEditError(`键「${last}」不存在`);
    parent.value.set(last, value);
    return;
  }
  if (parent.type === TAG.List) {
    if (typeof last !== 'number') throw new NbtEditError('列表的路径段必须是下标');
    if (last < 0 || last >= parent.value.length) throw new NbtEditError(`列表下标 ${last} 越界`);
    parent.value[last] = value;
    return;
  }
  throw new NbtEditError('这个位置不支持替换');
}

/**
 * 改节点的类型：保留能保留的部分。
 *
 * 规则（不猜）：
 * - 标量之间互转：按 SNBT 的写法做合理映射（数值直接搬，字符串按字面读成数字，
 *   读不成数字就报错）；
 * - 任何类型 -> 复合体/列表/数组：变成**空**的那种类型，不试图搬内容；
 * - 数组之间：元素逐个搬，超出目标类型范围的元素报错。
 */
export function changeType(root: NbtCompound, path: NbtPath, targetType: number): void {
  const current = getAtPath(root, path);
  if (!current) throw new NbtEditError('节点不存在');
  if (current.type === targetType) return;

  const converted = convertValue(current, targetType);
  setAtPath(root, path, converted);
}

function convertValue(value: NbtValue, targetType: number): NbtValue {
  const scalar = scalarNumber(value);
  switch (targetType) {
    case TAG.Byte:
      return { type: TAG.Byte, value: requireByte(scalar, value) };
    case TAG.Short:
      return { type: TAG.Short, value: requireIntInRange(scalar, -32768, 32767, '短整型', value) };
    case TAG.Int:
      return { type: TAG.Int, value: requireIntInRange(
        scalar, -2147483648, 2147483647, '整数', value,
      ) };
    case TAG.Long:
      return { type: TAG.Long, value: BigInt(Math.trunc(requireNumber(scalar, value))) };
    case TAG.Float:
      return { type: TAG.Float, value: requireNumber(scalar, value) };
    case TAG.Double:
      return { type: TAG.Double, value: requireNumber(scalar, value) };
    case TAG.String:
      return { type: TAG.String, value: scalarToString(value) };
    case TAG.Compound:
      return { type: TAG.Compound, value: new Map() };
    case TAG.List:
      return { type: TAG.List, elementType: TAG.End, value: [] };
    case TAG.ByteArray:
      return { type: TAG.ByteArray, value: [] };
    case TAG.IntArray:
      return { type: TAG.IntArray, value: [] };
    case TAG.LongArray:
      return { type: TAG.LongArray, value: [] };
    default:
      throw new NbtEditError(`不支持转换成 ${targetType}`);
  }
}

function requireNumber(n: number | undefined, value: NbtValue): number {
  if (n === undefined) {
    throw new NbtEditError(`不能把 ${describe(value)} 当作数字（请先改成字符串或数值）`);
  }
  return n;
}

function requireByte(n: number | undefined, value: NbtValue): number {
  const num = requireNumber(n, value);
  if (!Number.isInteger(num) || num < -128 || num > 127) {
    throw new NbtEditError(`字节值需要在 -128 ~ 127 之间，实际 ${num}`);
  }
  return num;
}

function requireIntInRange(
  n: number | undefined,
  min: number,
  max: number,
  label: string,
  value: NbtValue,
): number {
  const num = requireNumber(n, value);
  if (!Number.isInteger(num) || num < min || num > max) {
    throw new NbtEditError(`${label}需要在 ${min} ~ ${max} 之间，实际 ${num}`);
  }
  return num;
}

/** 把值变成数字（用于标量互转）；字符串先尝试按数字解析。 */
function scalarNumber(value: NbtValue): number | undefined {
  switch (value.type) {
    case TAG.Byte:
    case TAG.Short:
    case TAG.Int:
    case TAG.Float:
    case TAG.Double:
      return value.value;
    case TAG.Long:
      return Number(value.value);
    case TAG.String: {
      const trimmed = value.value.trim();
      if (/^[+-]?\d+$/.test(trimmed)) return Number(trimmed);
      if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return Number(trimmed);
      return undefined;
    }
    default:
      return undefined;
  }
}

function scalarToString(value: NbtValue): string {
  switch (value.type) {
    case TAG.Byte:
    case TAG.Short:
    case TAG.Int:
    case TAG.Float:
    case TAG.Double:
      return String(value.value);
    case TAG.Long:
      return value.value.toString();
    case TAG.String:
      return value.value;
    default:
      return JSON.stringify(plainish(value));
  }
}

function plainish(value: NbtValue): unknown {
  switch (value.type) {
    case TAG.ByteArray:
    case TAG.IntArray:
      return value.value;
    case TAG.LongArray:
      return value.value.map(String);
    case TAG.List:
      return value.value.map(plainish);
    case TAG.Compound:
      return Object.fromEntries([...value.value].map(([k, v]) => [k, plainish(v)]));
    default:
      return (value as { value: unknown }).value;
  }
}

export function describe(value: NbtValue): string {
  const names: Record<number, string> = {
    1: 'TAG_Byte', 2: 'TAG_Short', 3: 'TAG_Int', 4: 'TAG_Long',
    5: 'TAG_Float', 6: 'TAG_Double', 7: 'TAG_Byte_Array', 8: 'TAG_String',
    9: 'TAG_List', 10: 'TAG_Compound', 11: 'TAG_Int_Array', 12: 'TAG_Long_Array',
  };
  return names[value.type] ?? `类型 ${value.type}`;
}

// ---------------------------------------------------------------- 新增 / 删除

/** 在复合体里新增一个字段。键重复时替换（并说明）。 */
export function addToCompound(
  root: NbtCompound,
  path: NbtPath,
  key: string,
  value: NbtValue,
): { replaced: boolean } {
  const target = getAtPath(root, path);
  if (!target) throw new NbtEditError('目标节点不存在');
  if (target.type !== TAG.Compound) throw new NbtEditError('只能在复合体里新增字段');
  if (key === '') throw new NbtEditError('键名不能为空');
  const replaced = target.value.has(key);
  target.value.set(key, value);
  return { replaced };
}

/** 在列表末尾追加一个元素。 */
export function addToList(root: NbtCompound, path: NbtPath, value: NbtValue): number {
  const target = getAtPath(root, path);
  if (!target) throw new NbtEditError('目标节点不存在');
  if (target.type !== TAG.List) throw new NbtEditError('只能在列表里追加元素');

  // NBT 的列表要求元素同类型，这里如实把关而不是写出游戏读不了的文件
  if (target.value.length > 0 && target.elementType !== value.type) {
    throw new NbtEditError(
      `这个列表的元素类型是 ${describe({ type: target.elementType } as NbtValue)}，` +
        `不能追加 ${describe(value)}。要把列表元素换成别的类型，请先清空列表。`,
    );
  }
  target.value.push(value);
  target.elementType = value.type;
  return target.value.length;
}

/** 删除节点：复合体删键、列表删元素。 */
export function removeAtPath(root: NbtCompound, path: NbtPath): void {
  if (path.length === 0) throw new NbtEditError('不能删除根节点');
  const { parent, last } = getParent(root, path);
  if (parent.type === TAG.Compound) {
    if (typeof last !== 'string') throw new NbtEditError('复合体的路径段必须是键名');
    if (!parent.value.delete(last)) throw new NbtEditError(`键「${last}」不存在`);
    return;
  }
  if (parent.type === TAG.List) {
    if (typeof last !== 'number') throw new NbtEditError('列表的路径段必须是下标');
    if (last < 0 || last >= parent.value.length) throw new NbtEditError(`列表下标 ${last} 越界`);
    parent.value.splice(last, 1);
    return;
  }
  throw new NbtEditError('这个位置不支持删除');
}

/** 复合体里重命名一个键（保持顺序不变）。 */
export function renameInCompound(root: NbtCompound, path: NbtPath, newKey: string): void {
  const compound = getAtPath(root, path);
  if (!compound || compound.type !== TAG.Compound) {
    throw new NbtEditError('只能给复合体里的字段改名');
  }
  const { parent, last } = getParent(root, path);
  if (parent.type !== TAG.Compound || typeof last !== 'string') {
    throw new NbtEditError('路径不对');
  }
  if (newKey === '' ) throw new NbtEditError('键名不能为空');
  if (newKey === last) return;
  if (parent.value.has(newKey)) throw new NbtEditError(`键「${newKey}」已经存在`);

  // Map 保序，但要保留原位置：重建一遍
  const rebuilt: NbtCompound = new Map();
  for (const [key, value] of parent.value) {
    rebuilt.set(key === last ? newKey : key, value);
  }
  parent.value.clear();
  for (const [key, value] of rebuilt) parent.value.set(key, value);
}

// ---------------------------------------------------------------- 路径工具

/** 把路径渲染成可读文本，如 `structure.block_indices[0][5]`。 */
export function formatPath(path: NbtPath): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else out += out === '' ? segment : `.${segment}`;
  }
  return out || '(根)';
}

/** 把可读文本解析回路径（与 formatPath 互逆）。 */
export function parsePath(text: string): NbtPath {
  const path: PathSegment[] = [];
  let i = 0;
  const trimmed = text.trim();
  if (trimmed === '' || trimmed === '(根)') return path;

  while (i < trimmed.length) {
    if (trimmed[i] === '.') {
      i += 1;
      continue;
    }
    if (trimmed[i] === '[') {
      const end = trimmed.indexOf(']', i);
      if (end === -1) throw new NbtEditError(`路径里的「[」没有闭合：${text}`);
      const inner = trimmed.slice(i + 1, end).trim();
      if (!/^\d+$/.test(inner)) throw new NbtEditError(`下标必须是数字：${inner}`);
      path.push(Number(inner));
      i = end + 1;
      continue;
    }
    const next = trimmed.slice(i).search(/[.[]/);
    const end = next === -1 ? trimmed.length : i + next;
    const key = trimmed.slice(i, end);
    if (key !== '') path.push(key);
    i = end;
  }
  return path;
}

/** 该节点是否还能往下展开（界面用来决定要不要画三角）。 */
export function isExpandable(value: NbtValue): boolean {
  if (value.type === TAG.Compound) return value.value.size > 0;
  if (value.type === TAG.List) return value.value.length > 0;
  return false;
}

/** 节点的单行摘要（折叠状态下显示）。 */
export function summarizeNode(value: NbtValue): string {
  switch (value.type) {
    case TAG.Compound: {
      const keys = [...value.value.keys()];
      const shown = keys.slice(0, 4).join(', ');
      return `{${shown}${keys.length > 4 ? `, …${keys.length - 4} 项` : ''}}`;
    }
    case TAG.List: {
      return `[${value.value.length} 项]`;
    }
    case TAG.ByteArray:
    case TAG.IntArray:
    case TAG.LongArray: {
      return `[${value.value.length} 项]`;
    }
    case TAG.String:
      return value.value.length > 40 ? `${value.value.slice(0, 40)}…` : value.value;
    case TAG.Long:
      return value.value.toString();
    default:
      return String((value as { value: unknown }).value);
  }
}
