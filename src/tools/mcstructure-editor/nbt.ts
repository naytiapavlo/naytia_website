/**
 * 小端 NBT 读取器与写入器（Bedrock 口径）—— 纯逻辑，不碰 DOM、不发请求。
 *
 * 为什么自己写这一层：`.mcstructure` 用的是**小端** NBT，而 Java 用大端。
 * 两者字节序不同，不能共用默认实现；后端 `backend/app/nbt_le.py` 出于同样的原因
 * 也是自实现的（见 docs/plans/decisions/ADR-003）。前端这一份存在的理由是
 * **编辑与下载必须在浏览器本地完成**——文件不出本机（04 文档第 5 节）。
 *
 * 与后端 Python 实现的关系：两侧都按同一份 bedrock.dev 格式文档实现，
 * 各自独立测试，用同一份真实文件夹具（backend/tests/fixtures/real/）做交叉验证。
 * 格式规则改动时必须同时改两边，并跑两边的测试。
 *
 * 值表示：标签类型与值分开存放（`{ type, value }`），而不是把类型塞进 JS 原生类型。
 * 这样 `TAG_Byte` 与 `TAG_Int` 的 1 不会混淆，写回时也不会猜错类型。
 */

export const TAG = {
  End: 0,
  Byte: 1,
  Short: 2,
  Int: 3,
  Long: 4,
  Float: 5,
  Double: 6,
  ByteArray: 7,
  String: 8,
  List: 9,
  Compound: 10,
  IntArray: 11,
  LongArray: 12,
} as const;

export type TagId = (typeof TAG)[keyof typeof TAG];

export const TAG_NAMES: Record<number, string> = {
  0: 'TAG_End',
  1: 'TAG_Byte',
  2: 'TAG_Short',
  3: 'TAG_Int',
  4: 'TAG_Long',
  5: 'TAG_Float',
  6: 'TAG_Double',
  7: 'TAG_Byte_Array',
  8: 'TAG_String',
  9: 'TAG_List',
  10: 'TAG_Compound',
  11: 'TAG_Int_Array',
  12: 'TAG_Long_Array',
};

/** 复合体：键 -> 标签。NBT 的复合体键恒为字符串。 */
export type NbtCompound = Map<string, NbtValue>;

export type NbtValue =
  | { type: typeof TAG.Byte; value: number }
  | { type: typeof TAG.Short; value: number }
  | { type: typeof TAG.Int; value: number }
  | { type: typeof TAG.Long; value: bigint }
  | { type: typeof TAG.Float; value: number }
  | { type: typeof TAG.Double; value: number }
  | { type: typeof TAG.ByteArray; value: number[]; kindDetail?: 'byte' }
  | { type: typeof TAG.String; value: string }
  | { type: typeof TAG.List; elementType: TagId; value: NbtValue[] }
  | { type: typeof TAG.Compound; value: NbtCompound }
  | { type: typeof TAG.IntArray; value: number[]; kindDetail?: 'int' }
  | { type: typeof TAG.LongArray; value: bigint[] };

export class NbtError extends Error {}
export class NbtTruncatedError extends NbtError {}
export class NbtFormatError extends NbtError {}
export class NbtLimitError extends NbtError {}

export interface NbtLimits {
  maxBytes: number;
  maxDepth: number;
  maxArrayLength: number;
  maxListLength: number;
  maxStringLength: number;
}

export const DEFAULT_LIMITS: NbtLimits = {
  maxBytes: 64 * 1024 * 1024,
  maxDepth: 64,
  // 结构文件的 block_indices 会长达百万级，上限要留够
  maxArrayLength: 16 * 1024 * 1024,
  maxListLength: 16 * 1024 * 1024,
  maxStringLength: 1024 * 1024,
};

// ---------------------------------------------------------------- 读取

class Reader {
  private view: DataView;
  private offset = 0;
  private bytes: Uint8Array;
  private limits: NbtLimits;

  constructor(bytes: Uint8Array, limits: NbtLimits) {
    this.bytes = bytes;
    this.limits = limits;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get pos(): number {
    return this.offset;
  }

  private need(n: number): void {
    if (this.offset + n > this.bytes.length) {
      throw new NbtTruncatedError(
        `数据在第 ${this.offset} 字节处提前结束（需要 ${n} 字节，只剩 ${this.bytes.length - this.offset}）`,
      );
    }
  }

  u8(): number {
    this.need(1);
    return this.view.getUint8(this.offset++);
  }

  i8(): number {
    this.need(1);
    return this.view.getInt8(this.offset++);
  }

  i16(): number {
    this.need(2);
    const v = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return v;
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  i32(): number {
    this.need(4);
    const v = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return v;
  }

  i64(): bigint {
    this.need(8);
    const v = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return v;
  }

  f32(): number {
    this.need(4);
    const v = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return v;
  }

  f64(): number {
    this.need(8);
    const v = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return v;
  }

  str(): string {
    const length = this.u16();
    // 先校验声明长度再看数据够不够：超大声明长度必须报「超限」而不是「截断」
    if (length > this.limits.maxStringLength) {
      throw new NbtLimitError(`字符串长度 ${length} 超过上限 ${this.limits.maxStringLength}`);
    }
    this.need(length);
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(slice);
    } catch {
      throw new NbtFormatError(`字符串不是合法 UTF-8（第 ${this.offset - length} 字节起）`);
    }
  }

  private count(kind: string, limit: number): number {
    const n = this.i32();
    if (n < 0) throw new NbtFormatError(`${kind} 长度为负数：${n}`);
    if (n > limit) throw new NbtLimitError(`${kind} 长度 ${n} 超过上限 ${limit}`);
    return n;
  }

  /** 读取 tagId 对应的值。调用方必须已经消费掉 tagId 本身。 */
  payload(tagId: number, depth: number): NbtValue {
    if (depth > this.limits.maxDepth) {
      throw new NbtLimitError(`嵌套深度超过 ${this.limits.maxDepth} 层`);
    }
    switch (tagId) {
      case TAG.Byte:
        return { type: TAG.Byte, value: this.i8() };
      case TAG.Short:
        return { type: TAG.Short, value: this.i16() };
      case TAG.Int:
        return { type: TAG.Int, value: this.i32() };
      case TAG.Long:
        return { type: TAG.Long, value: this.i64() };
      case TAG.Float:
        return { type: TAG.Float, value: this.f32() };
      case TAG.Double:
        return { type: TAG.Double, value: this.f64() };
      case TAG.String:
        return { type: TAG.String, value: this.str() };
      case TAG.ByteArray: {
        const n = this.count('TAG_Byte_Array', this.limits.maxArrayLength);
        this.need(n);
        const out = new Array<number>(n);
        for (let i = 0; i < n; i += 1) out[i] = this.view.getUint8(this.offset + i);
        this.offset += n;
        return { type: TAG.ByteArray, value: out };
      }
      case TAG.IntArray: {
        const n = this.count('TAG_Int_Array', this.limits.maxArrayLength);
        const out = new Array<number>(n);
        for (let i = 0; i < n; i += 1) out[i] = this.i32();
        return { type: TAG.IntArray, value: out };
      }
      case TAG.LongArray: {
        const n = this.count('TAG_Long_Array', this.limits.maxArrayLength);
        const out = new Array<bigint>(n);
        for (let i = 0; i < n; i += 1) out[i] = this.i64();
        return { type: TAG.LongArray, value: out };
      }
      case TAG.List: {
        const elementType = this.u8();
        const n = this.count('TAG_List', this.limits.maxListLength);
        if (n > 0 && elementType === TAG.End) {
          throw new NbtFormatError('非空 TAG_List 的元素类型不能是 TAG_End');
        }
        const items = new Array<NbtValue>(n);
        for (let i = 0; i < n; i += 1) items[i] = this.payload(elementType, depth + 1);
        return { type: TAG.List, elementType: elementType as TagId, value: items };
      }
      case TAG.Compound:
        return { type: TAG.Compound, value: this.compoundBody(depth + 1) };
      default:
        throw new NbtFormatError(`未知的标签类型编号：${tagId}`);
    }
  }

  /** 读取命名标签直到 TAG_End。复合体自身的 tagId 已被调用方消费。 */
  compoundBody(depth: number): NbtCompound {
    if (depth > this.limits.maxDepth) {
      throw new NbtLimitError(`嵌套深度超过 ${this.limits.maxDepth} 层`);
    }
    const out: NbtCompound = new Map();
    for (;;) {
      const childId = this.u8();
      if (childId === TAG.End) return out;
      const name = this.str();
      out.set(name, this.payload(childId, depth + 1));
    }
  }

  named(tagId: number, depth: number): NbtValue {
    return this.payload(tagId, depth);
  }
}

/** 压缩方式识别结果。 */
export type Compression = 'none' | 'gzip' | 'zlib';

/** 按魔数识别压缩方式。.mcstructure 官方不压缩，但用户常拿到 gzip/zlib 副本。 */
export function detectCompression(bytes: Uint8Array): Compression {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return 'gzip';
  if (bytes.length >= 2 && bytes[0] === 0x78 && ((bytes[0] << 8) | bytes[1]) % 31 === 0) {
    return 'zlib';
  }
  return 'none';
}

/**
 * 解压（若需要）。用浏览器原生的 DecompressionStream，不引入压缩库。
 * 浏览器不支持时抛 NbtFormatError 并说明原因——不静默当成「格式错误」。
 */
export async function decompress(
  bytes: Uint8Array,
  compression: Compression,
  limits: NbtLimits = DEFAULT_LIMITS,
): Promise<Uint8Array> {
  if (compression === 'none') return bytes;

  const format = compression === 'gzip' ? 'gzip' : 'deflate';
  if (typeof DecompressionStream === 'undefined') {
    throw new NbtFormatError(
      `这个文件是 ${compression} 压缩的，但当前浏览器不支持 DecompressionStream。` +
        '请用较新的 Chrome / Edge / Firefox，或先在本地解压成未压缩的 .mcstructure。',
    );
  }

  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream(format));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  if (out.length > limits.maxBytes) {
    throw new NbtLimitError(
      `解压后 ${out.length} 字节，超过 ${limits.maxBytes} 上限（可能是压缩膨胀）`,
    );
  }
  return out;
}

export interface ReadNbtResult {
  root: NbtCompound;
  compression: Compression;
}

/**
 * 解析一个小端 NBT 文件。根标签必须是 TAG_Compound。
 * 解析失败抛 NbtError 的子类，调用方负责转成结构化错误。
 */
export async function readNbtFile(
  bytes: Uint8Array,
  limits: NbtLimits = DEFAULT_LIMITS,
): Promise<ReadNbtResult> {
  if (bytes.length === 0) throw new NbtTruncatedError('文件是空的');
  if (bytes.length > limits.maxBytes) {
    throw new NbtLimitError(`文件 ${bytes.length} 字节，超过 ${limits.maxBytes} 上限`);
  }

  const compression = detectCompression(bytes);
  const raw = await decompress(bytes, compression, limits);

  const reader = new Reader(raw, limits);
  const rootId = reader.u8();
  if (rootId !== TAG.Compound) {
    throw new NbtFormatError(
      `根标签应是 TAG_Compound(10)，实际是 ${TAG_NAMES[rootId] ?? rootId}`,
    );
  }
  reader.str(); // 根名恒为空串
  const root = reader.compoundBody(0);
  return { root, compression };
}

// ---------------------------------------------------------------- 写入

/** 数值安全整数上限（TAG_Int 是 32 位；JS 用它存 Int 足够）。 */
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

class Writer {
  private chunks: Uint8Array[] = [];
  private scratch = new Uint8Array(8);

  private push(bytes: Uint8Array): void {
    this.chunks.push(bytes);
  }

  u8(value: number): void {
    this.scratch[0] = value & 0xff;
    this.push(this.scratch.slice(0, 1));
  }

  i16(value: number): void {
    new DataView(this.scratch.buffer).setInt16(0, value, true);
    this.push(this.scratch.slice(0, 2));
  }

  u16(value: number): void {
    new DataView(this.scratch.buffer).setUint16(0, value, true);
    this.push(this.scratch.slice(0, 2));
  }

  i32(value: number): void {
    new DataView(this.scratch.buffer).setInt32(0, value, true);
    this.push(this.scratch.slice(0, 4));
  }

  i64(value: bigint): void {
    new DataView(this.scratch.buffer).setBigInt64(0, value, true);
    this.push(this.scratch.slice(0, 8));
  }

  f32(value: number): void {
    new DataView(this.scratch.buffer).setFloat32(0, value, true);
    this.push(this.scratch.slice(0, 4));
  }

  f64(value: number): void {
    new DataView(this.scratch.buffer).setFloat64(0, value, true);
    this.push(this.scratch.slice(0, 8));
  }

  str(value: string): void {
    const encoded = new TextEncoder().encode(value);
    if (encoded.length > 65535) {
      throw new NbtFormatError(`字符串过长（${encoded.length} 字节），NBT 上限 65535`);
    }
    this.u16(encoded.length);
    this.push(encoded);
  }

  raw(bytes: Uint8Array): void {
    this.push(bytes);
  }

  concat(): Uint8Array {
    let total = 0;
    for (const chunk of this.chunks) total += chunk.length;
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }

  get length(): number {
    let total = 0;
    for (const chunk of this.chunks) total += chunk.length;
    return total;
  }
}

/** 名称长度上限（NBT 用 16 位无符号短整型）。 */
export const MAX_NAME_BYTES = 65535;

function assertInt32(value: number, what: string): void {
  if (!Number.isInteger(value)) throw new NbtFormatError(`${what} 必须是整数，实际 ${value}`);
  if (value < INT32_MIN || value > INT32_MAX) {
    throw new NbtFormatError(`${what} 超出 32 位整数范围：${value}`);
  }
}

/** 写入一个标签的值（不含类型与名字）。返回元素类型，供列表头使用。 */
function writePayload(w: Writer, tag: NbtValue, depth: number): void {
  if (depth > DEFAULT_LIMITS.maxDepth) {
    throw new NbtLimitError(`嵌套深度超过 ${DEFAULT_LIMITS.maxDepth} 层`);
  }
  switch (tag.type) {
    case TAG.Byte:
      w.u8(tag.value & 0xff);
      break;
    case TAG.Short:
      w.i16(tag.value);
      break;
    case TAG.Int:
      assertInt32(tag.value, 'TAG_Int');
      w.i32(tag.value);
      break;
    case TAG.Long:
      w.i64(tag.value);
      break;
    case TAG.Float:
      w.f32(tag.value);
      break;
    case TAG.Double:
      w.f64(tag.value);
      break;
    case TAG.String:
      w.str(tag.value);
      break;
    case TAG.ByteArray:
      w.i32(tag.value.length);
      for (const b of tag.value) w.u8(b & 0xff);
      break;
    case TAG.IntArray:
      w.i32(tag.value.length);
      for (const n of tag.value) {
        assertInt32(n, 'TAG_Int_Array 元素');
        w.i32(n);
      }
      break;
    case TAG.LongArray:
      w.i32(tag.value.length);
      for (const n of tag.value) w.i64(n);
      break;
    case TAG.List: {
      // 空列表的元素类型：NBT 惯例写 TAG_End，且读取端允许
      const elementType = tag.value.length > 0 ? tag.value[0]!.type : tag.elementType;
      w.u8(elementType);
      w.i32(tag.value.length);
      for (const item of tag.value) writePayload(w, item, depth + 1);
      break;
    }
    case TAG.Compound:
      writeCompoundBody(w, tag.value, depth + 1);
      break;
    default:
      throw new NbtFormatError(`无法写入的标签类型：${(tag as NbtValue).type}`);
  }
}

function writeCompoundBody(w: Writer, compound: NbtCompound, depth: number): void {
  if (depth > DEFAULT_LIMITS.maxDepth) {
    throw new NbtLimitError(`嵌套深度超过 ${DEFAULT_LIMITS.maxDepth} 层`);
  }
  for (const [name, value] of compound) {
    if (name === '') {
      // 只有根复合体允许空名字；这里放宽为拒绝，避免写出游戏读不了的文件
      throw new NbtFormatError('复合体内部的字段名不能为空');
    }
    w.u8(value.type);
    w.str(name);
    writePayload(w, value, depth);
  }
  w.u8(TAG.End);
}

/** 把小端 NBT 根复合体序列化成字节（未压缩）。 */
export function writeNbtFile(root: NbtCompound): Uint8Array {
  const w = new Writer();
  w.u8(TAG.Compound);
  w.str(''); // 根名恒为空串
  writeCompoundBody(w, root, 0);
  return w.concat();
}

// ---------------------------------------------------------------- 取值辅助

export function asCompound(value: NbtValue | undefined): NbtCompound | undefined {
  return value?.type === TAG.Compound ? value.value : undefined;
}

export function getCompound(compound: NbtCompound, key: string): NbtCompound | undefined {
  return asCompound(compound.get(key));
}

export function getInt(compound: NbtCompound, key: string): number | undefined {
  const tag = compound.get(key);
  if (!tag) return undefined;
  switch (tag.type) {
    case TAG.Byte:
    case TAG.Short:
    case TAG.Int:
      return tag.value;
    default:
      return undefined;
  }
}

export function getString(compound: NbtCompound, key: string): string | undefined {
  const tag = compound.get(key);
  return tag?.type === TAG.String ? tag.value : undefined;
}

export function getList(compound: NbtCompound, key: string): NbtValue[] | undefined {
  const tag = compound.get(key);
  return tag?.type === TAG.List ? tag.value : undefined;
}

export function intTag(value: number): NbtValue {
  return { type: TAG.Int, value };
}

export function stringTag(value: string): NbtValue {
  return { type: TAG.String, value };
}

export function compoundTag(value: NbtCompound): NbtValue {
  return { type: TAG.Compound, value };
}

/** 把标签值转成便于阅读的纯 JS 值（用于详情展示与 JSON 导出）。 */
export function toPlain(value: NbtValue): unknown {
  switch (value.type) {
    case TAG.Byte:
    case TAG.Short:
    case TAG.Int:
    case TAG.Float:
    case TAG.Double:
    case TAG.String:
      return value.value;
    case TAG.Long:
      // bigint 不能直接 JSON 化：超出安全整数范围时用字符串保精度
      return value.value >= BigInt(Number.MIN_SAFE_INTEGER) &&
        value.value <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(value.value)
        : value.value.toString();
    case TAG.ByteArray:
    case TAG.IntArray:
      return value.value;
    case TAG.LongArray:
      return value.value.map(String);
    case TAG.List:
      return value.value.map(toPlain);
    case TAG.Compound: {
      const out: Record<string, unknown> = {};
      for (const [k, v] of value.value) out[k] = toPlain(v);
      return out;
    }
    default:
      return null;
  }
}
