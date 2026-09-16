/**
 * SNBT（Stringified NBT）文本读写 —— 纯逻辑，不碰 DOM。
 *
 * SNBT 是 NBT 的文本表示，也是各 NBT 编辑器通用的交换格式。用它当「直接编辑」
 * 的载体有两个好处：一是可以整段复制粘贴，二是能精确表达类型（`1b` 是字节、
 * `1` 是整数、`1L` 是长整数），不会像 JSON 那样把类型和精度丢掉。
 *
 * 语法（与游戏内 `/data`、`/setblock` 的 NBT 参数一致）：
 *   复合体 `{k:v,...}`   列表 `[v,v]`   字符串 `"..."` 或裸串
 *   `1b` 字节  `1s` 短整型  `1` 整数  `1L` 长整型  `1.0f` 单精度  `1.0` 双精度
 *   `[B;…]` `[I;…]` `[L;…]` 三种数组；也接受 `true`/`false`（按字节读，与游戏一致）
 *
 * 写：类型明确写出，裸串只在安全时才用（避免 `b` 这样的值被读成类型后缀）。
 * 读：错误带行号与列号 —— 这是人手动编辑的入口，报错必须能直接定位。
 */
import { TAG, type NbtCompound, type NbtValue } from './nbt';

const MAX_DEPTH = 64;

// ================================================================ 序列化

/**
 * 裸串允许的字符（不必加引号）。
 *
 * 含 `:` 是必要的：方块名要写成 `minecraft:stone`，而冒号在「值」的位置没有歧义
 * （只有复合体的键才用冒号分隔），所以加进来让输出更接近游戏与常见工具的写法。
 * 不含空格、逗号、引号、括号 —— 那些一定会破坏结构，必须加引号并转义。
 */
const BARE_STRING = /^[A-Za-z0-9._+:-]+$/;

/** 这些字面量必须加引号，否则会被读成类型标记或布尔值。 */
const QUOTE_LITERALS = new Set([
  'b', 'B', 's', 'S', 'l', 'L', 'f', 'F', 'd', 'D', 'true', 'false',
]);

export interface SnbtOptions {
  /** 缩进空格数；0 表示压成一行（紧凑输出） */
  indent?: number;
  /** 数组是否每个元素换行（元素很多时关掉更好读） */
  prettyArrays?: boolean;
}

const DEFAULT_OPTIONS: Required<SnbtOptions> = { indent: 2, prettyArrays: false };

function quoteString(value: string): string {
  if (
    value.length > 0 &&
    BARE_STRING.test(value) &&
    !QUOTE_LITERALS.has(value) &&
    !/^[0-9]/.test(value)
  ) {
    return value;
  }
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

function quoteKey(key: string): string {
  if (key.length > 0 && BARE_STRING.test(key) && !QUOTE_LITERALS.has(key)) return key;
  return quoteString(key);
}

/** 0~255 的字节值转成有符号表示（-128~127）。 */
function signedByte(n: number): number {
  const wrapped = ((n % 256) + 256) % 256;
  return wrapped >= 128 ? wrapped - 256 : wrapped;
}

/** 浮点数：保证结果能被读回同一个值（用最短短表示），且明确带上小数点。 */
function formatDouble(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return 'Infinity';
  if (value === -Infinity) return '-Infinity';
  const text = String(value);
  // `1` 会被读成 Int，必须带上 `.0` 才明确是浮点
  return text.includes('.') || text.includes('e') || text.includes('E') ? text : `${text}.0`;
}

function writeValue(value: NbtValue, options: Required<SnbtOptions>, depth: number): string {
  switch (value.type) {
    case TAG.Byte:
      return `${value.value}b`;
    case TAG.Short:
      return `${value.value}s`;
    case TAG.Int:
      return String(value.value);
    case TAG.Long:
      return `${value.value}L`;
    case TAG.Float:
      return `${formatDouble(value.value)}f`;
    case TAG.Double:
      return formatDouble(value.value);
    case TAG.String:
      return quoteString(value.value);
    case TAG.ByteArray:
      // 按有符号 -128~127 写出：符合 `1b` 语法，且能读回同一个字节（255 与 -1 是同一个字节）
      return `[B;${value.value.map((n) => `${signedByte(n)}b`).join(',')}]`;
    case TAG.IntArray:
      return `[I;${value.value.map((n) => String(n)).join(',')}]`;
    case TAG.LongArray:
      return `[L;${value.value.map((n) => `${n}L`).join(',')}]`;
    case TAG.List:
      return writeList(value.value, options, depth);
    case TAG.Compound:
      return writeCompound(value.value, options, depth);
    default:
      return 'null';
  }
}

function writeList(items: NbtValue[], options: Required<SnbtOptions>, depth: number): string {
  if (items.length === 0) return '[]';
  const parts = items.map((item) => writeValue(item, options, depth + 1));
  const oneLine = `[${parts.join(',')}]`;
  if (options.indent === 0 || !options.prettyArrays || oneLine.length <= 80) return oneLine;

  const pad = ' '.repeat(options.indent * (depth + 1));
  const closePad = ' '.repeat(options.indent * depth);
  return `[\n${parts.map((part) => `${pad}${part}`).join(',\n')}\n${closePad}]`;
}

function writeCompound(
  compound: NbtCompound,
  options: Required<SnbtOptions>,
  depth: number,
): string {
  if (compound.size === 0) return '{}';
  const entries = [...compound];

  if (options.indent === 0) {
    return `{${entries.map(([k, v]) => `${quoteKey(k)}:${writeValue(v, options, depth + 1)}`).join(',')}}`;
  }

  const pad = ' '.repeat(options.indent * (depth + 1));
  const closePad = ' '.repeat(options.indent * depth);
  const body = entries
    .map(([key, value]) => `${pad}${quoteKey(key)}:${writeValue(value, options, depth + 1)}`)
    .join(',\n');
  return `{\n${body}\n${closePad}}`;
}

/** 把 NBT 值序列化成 SNBT 文本。 */
export function toSnbt(value: NbtValue, options: SnbtOptions = {}): string {
  return writeValue(value, { ...DEFAULT_OPTIONS, ...options }, 0);
}

/** 把根复合体序列化成 SNBT 文本（编辑器默认用缩进版）。 */
export function rootToSnbt(root: NbtCompound, options: SnbtOptions = {}): string {
  return writeCompound(root, { ...DEFAULT_OPTIONS, ...options }, 0);
}

// ================================================================ 解析

export class SnbtParseError extends Error {
  line: number;
  column: number;
  /** 出错那一行的原文，便于界面高亮 */
  snippet: string;

  constructor(message: string, line: number, column: number, snippet: string) {
    super(`第 ${line} 行第 ${column} 列：${message}`);
    this.name = 'SnbtParseError';
    this.line = line;
    this.column = column;
    this.snippet = snippet;
  }
}

class Parser {
  private text: string;
  private pos = 0;
  private maxDepth: number;

  constructor(text: string, maxDepth = MAX_DEPTH) {
    this.text = text;
    this.maxDepth = maxDepth;
  }

  private fail(message: string, at = this.pos): never {
    const before = this.text.slice(0, at);
    const line = before.split('\n').length;
    const lineStart = before.lastIndexOf('\n') + 1;
    const column = at - lineStart + 1;
    const lineEnd = this.text.indexOf('\n', at);
    const snippet = this.text.slice(lineStart, lineEnd === -1 ? this.text.length : lineEnd).trimEnd();
    throw new SnbtParseError(message, line, column, snippet);
  }

  private peek(): string {
    return this.text[this.pos] ?? '';
  }

  private skipSpace(): void {
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos]!;
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        this.pos += 1;
        continue;
      }
      // 注释：不是游戏语法，但手写时很有用，解析器忽略掉
      if (ch === '/' && this.text[this.pos + 1] === '/') {
        const end = this.text.indexOf('\n', this.pos);
        this.pos = end === -1 ? this.text.length : end;
        continue;
      }
      break;
    }
  }

  private expect(ch: string): void {
    if (this.peek() !== ch) {
      this.fail(`期望「${ch}」，实际遇到「${this.peek() || '文本结束'}」`);
    }
    this.pos += 1;
  }

  // ---- 字符串 ----

  private parseQuoted(): string {
    this.expect('"');
    let out = '';
    for (;;) {
      if (this.pos >= this.text.length) this.fail('字符串没有闭合的引号');
      const ch = this.text[this.pos]!;
      if (ch === '"') {
        this.pos += 1;
        return out;
      }
      if (ch === '\\') {
        const next = this.text[this.pos + 1] ?? '';
        const at = this.pos;
        this.pos += 2;
        switch (next) {
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case '"': out += '"'; break;
          case '\\': out += '\\'; break;
          case "'": out += "'"; break;
          default:
            this.fail(`不认识的转义「\\${next}」`, at);
        }
        continue;
      }
      out += ch;
      this.pos += 1;
    }
  }

  /**
   * 裸串：一直读到「最外层分隔符」为止，即 `,` `]` `}` 或空白。
   *
   * 为什么不像常见解析器那样把 `:` 也当分隔符：方块名要写成 `minecraft:stone`，
   * 把 `:` 当分隔符会把它切成两截，整个复合体随之解析错位。
   * 冒号的歧义改由调用方解决 —— 键的解析会用 `parseBare(0)`（停在第一个 `:`），
   * 值的位置不会遇到需要靠冒号切分的边界。
   */
  private parseBare(colonStop = false): string {
    const start = this.pos;
    let colon = -1;
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos]!;
      if (ch === ':' && colon === -1) colon = this.pos;
      if (ch === ',' || ch === ']' || ch === '}' || /\s/.test(ch)) break;
      this.pos += 1;
    }
    if (this.pos === start) this.fail(`期望一个值，实际遇到「${this.peek() || '文本结束'}」`);
    if (colonStop && colon !== -1) {
      const key = this.text.slice(start, colon);
      if (key === '') this.fail('键名是空的');
      this.pos = colon;
      return key;
    }
    return this.text.slice(start, this.pos);
  }

  // ---- 数值 ----

  private tryNumber(raw: string, offset: number): NbtValue {
    // 后缀只有在同时满足两件事时才算类型后缀：
    //   a) 末尾那个字符确实是后缀字母（b/s/l/f/d）；
    //   b) 去掉它之后剩下的是数字。
    // (a) 不能省：否则 `2147483647` 会被切成 `214748364` + 后缀 `7`，静默算错数值！
    // (b) 也不能省：方块名常以 s/l/b 结尾（oak_stairs、minecraft:stone 不会，但 stairs 会），
    //     只看后缀字母会把 `minecraft:oak_stairs` 读成「短整型」而报错。
    const last = raw.slice(-1);
    const body0 = raw.slice(0, -1);
    const isSuffixLetter = 'bslfdBSLFD'.includes(last);
    const numericBody = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(body0);
    const suffix = isSuffixLetter && numericBody ? last : '';
    const body = suffix ? body0 : raw;
    const lower = suffix.toLowerCase();

    const isIntLike = /^[+-]?\d+$/.test(body);
    const isFloatLike = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(body);

    if (lower === 'b') {
      if (!isIntLike) this.fail(`「${raw}」不是合法的字节值（应形如 1b）`, offset);
      const n = Number(body);
      if (n < -128 || n > 127) this.fail(`字节值 ${n} 超出范围 -128 ~ 127`, offset);
      return { type: TAG.Byte, value: n };
    }
    if (lower === 's') {
      if (!isIntLike) this.fail(`「${raw}」不是合法的短整型（应形如 1s）`, offset);
      const n = Number(body);
      if (n < -32768 || n > 32767) this.fail(`短整型 ${n} 超出范围 -32768 ~ 32767`, offset);
      return { type: TAG.Short, value: n };
    }
    if (lower === 'l') {
      if (!isIntLike) this.fail(`「${raw}」不是合法的长整型（应形如 1L）`, offset);
      return { type: TAG.Long, value: BigInt(body) };
    }
    if (lower === 'f') {
      if (!isFloatLike) this.fail(`「${raw}」不是合法的单精度浮点（应形如 1.0f）`, offset);
      return { type: TAG.Float, value: Number(body) };
    }
    if (lower === 'd') {
      if (!isFloatLike) this.fail(`「${raw}」不是合法的双精度浮点（应形如 1.0d）`, offset);
      return { type: TAG.Double, value: Number(body) };
    }

    // 无后缀：按字面形式判定
    if (isIntLike) {
      const n = Number(body);
      if (!Number.isSafeInteger(n) || n < -2147483648 || n > 2147483647) {
        this.fail(
          `整数 ${body} 超出 32 位范围（-2147483648 ~ 2147483647）。要表示长整型请加 L 后缀`,
          offset,
        );
      }
      return { type: TAG.Int, value: n };
    }
    if (isFloatLike) return { type: TAG.Double, value: Number(body) };
    if (body === 'NaN') return { type: TAG.Double, value: Number.NaN };
    if (body === 'Infinity') return { type: TAG.Double, value: Infinity };
    if (body === '-Infinity') return { type: TAG.Double, value: -Infinity };

    // 裸串兜底（`stone`、`minecraft:air` 这类）
    return { type: TAG.String, value: raw };
  }

  // ---- 复合体 ----

  private parseCompound(depth: number): NbtCompound {
    this.expect('{');
    const out: NbtCompound = new Map();
    this.skipSpace();
    if (this.peek() === '}') {
      this.pos += 1;
      return out;
    }
    for (;;) {
      this.skipSpace();
      const key = this.peek() === '"' ? this.parseQuoted() : this.parseBare(true);
      this.skipSpace();
      this.expect(':');
      const value = this.parseValue(depth + 1);
      out.set(key, value);
      this.skipSpace();
      const ch = this.peek();
      if (ch === ',') {
        this.pos += 1;
        this.skipSpace();
        if (this.peek() === '}') {  // 容忍尾随逗号
          this.pos += 1;
          return out;
        }
        continue;
      }
      if (ch === '}') {
        this.pos += 1;
        return out;
      }
      this.fail(`期望「,」或「}」，实际遇到「${ch || '文本结束'}」`);
    }
  }

  // ---- 列表与数组 ----

  private parseListOrArray(depth: number): NbtValue {
    this.expect('[');
    this.skipSpace();

    // 数组：[B; / [I; / [L;
    const typeChar = this.peek().toUpperCase();
    if ((typeChar === 'B' || typeChar === 'I' || typeChar === 'L') && this.text[this.pos + 1] === ';') {
      this.pos += 2;
      const numbers: number[] = [];
      const longs: bigint[] = [];
      this.skipSpace();
      if (this.peek() === ']') {
        this.pos += 1;
        return this.buildArray(typeChar, numbers, longs);
      }
      for (;;) {
        this.skipSpace();
        const start = this.pos;
        const raw = this.peek() === '"' ? this.parseQuoted() : this.parseBare();
        if (typeChar === 'L') {
          const body = raw.replace(/[lL]$/, '');
          if (!/^[+-]?\d+$/.test(body)) this.fail(`长整型数组里的「${raw}」不是整数`, start);
          longs.push(BigInt(body));
        } else {
          const body = raw.replace(/[bBsS]$/, '');
          if (!/^[+-]?\d+$/.test(body)) this.fail(`整数数组里的「${raw}」不是整数`, start);
          numbers.push(Number(body));
        }
        this.skipSpace();
        const ch = this.peek();
        if (ch === ',') {
          this.pos += 1;
          this.skipSpace();
          if (this.peek() === ']') {
            this.pos += 1;
            return this.buildArray(typeChar, numbers, longs);
          }
          continue;
        }
        if (ch === ']') {
          this.pos += 1;
          return this.buildArray(typeChar, numbers, longs);
        }
        this.fail(`数组里期望「,」或「]」，实际遇到「${ch || '文本结束'}」`);
      }
    }

    // 普通列表
    const items: NbtValue[] = [];
    if (this.peek() === ']') {
      this.pos += 1;
      return { type: TAG.List, elementType: TAG.End, value: items };
    }
    for (;;) {
      items.push(this.parseValue(depth + 1));
      this.skipSpace();
      const ch = this.peek();
      if (ch === ',') {
        this.pos += 1;
        this.skipSpace();
        if (this.peek() === ']') {
          this.pos += 1;
          break;
        }
        continue;
      }
      if (ch === ']') {
        this.pos += 1;
        break;
      }
      this.fail(`列表里期望「,」或「]」，实际遇到「${ch || '文本结束'}」`);
    }

    if (items.length === 0) return { type: TAG.List, elementType: TAG.End, value: items };

    // NBT 的列表要求元素同类型：如实报错，不「猜测修复」
    const elementType = items[0]!.type;
    for (let i = 1; i < items.length; i += 1) {
      if (items[i]!.type !== elementType) {
        this.fail(
          `列表的元素必须同类型：第 1 个是 ${tagName(elementType)}，第 ${i + 1} 个是 ${tagName(
            items[i]!.type,
          )}。要放不同类型请改用复合体`,
        );
      }
    }
    return { type: TAG.List, elementType, value: items };
  }

  private buildArray(typeChar: string, numbers: number[], longs: bigint[]): NbtValue {
    if (typeChar === 'L') return { type: TAG.LongArray, value: longs };
    if (typeChar === 'I') {
      for (const n of numbers) {
        if (n < -2147483648 || n > 2147483647) this.fail(`整数数组里的 ${n} 超出 32 位范围`);
      }
      return {
        type: TAG.IntArray,
        value: numbers,
        // 空数组的「数字型/int 数组」之分会丢，需要记下来才能原样写回
        ...(numbers.length === 0 ? { kindDetail: 'int' as const } : {}),
      };
    }
    for (const n of numbers) {
      if (n < -128 || n > 127) this.fail(`字节数组里的 ${n} 超出 -128 ~ 127`);
    }
    return {
      type: TAG.ByteArray,
      value: numbers.map((n) => n & 0xff),
      ...(numbers.length === 0 ? { kindDetail: 'byte' as const } : {}),
    };
  }

  // ---- 值分派 ----

  parseValue(depth: number): NbtValue {
    if (depth > this.maxDepth) this.fail(`嵌套超过 ${this.maxDepth} 层`);
    this.skipSpace();
    const ch = this.peek();
    if (ch === '') this.fail('期望一个值，但文本已经结束');
    if (ch === '{') return { type: TAG.Compound, value: this.parseCompound(depth) };
    if (ch === '[') return this.parseListOrArray(depth);
    if (ch === '"') return { type: TAG.String, value: this.parseQuoted() };

    const start = this.pos;
    const raw = this.parseBare();
    if (raw === 'true') return { type: TAG.Byte, value: 1 };
    if (raw === 'false') return { type: TAG.Byte, value: 0 };
    return this.tryNumber(raw, start);
  }

  parseRoot(): NbtCompound {
    this.skipSpace();
    if (this.peek() !== '{') {
      this.fail(`SNBT 的最外层必须是复合体 {…}，实际以「${this.peek() || '文本结束'}」开头`);
    }
    const value = this.parseCompound(0);
    this.skipSpace();
    if (this.pos < this.text.length) {
      this.fail(`复合体之后还有多余内容：「${this.text.slice(this.pos, this.pos + 20)}」`);
    }
    return value;
  }

  parseSingle(): NbtValue {
    const value = this.parseValue(0);
    this.skipSpace();
    if (this.pos < this.text.length) {
      this.fail(`值之后还有多余内容：「${this.text.slice(this.pos, this.pos + 20)}」`);
    }
    return value;
  }
}

function tagName(type: number): string {
  const names: Record<number, string> = {
    1: 'TAG_Byte', 2: 'TAG_Short', 3: 'TAG_Int', 4: 'TAG_Long',
    5: 'TAG_Float', 6: 'TAG_Double', 7: 'TAG_Byte_Array', 8: 'TAG_String',
    9: 'TAG_List', 10: 'TAG_Compound', 11: 'TAG_Int_Array', 12: 'TAG_Long_Array',
  };
  return names[type] ?? `类型 ${type}`;
}

/** 解析 SNBT 文本，返回根复合体。失败抛 SnbtParseError（带行号列号）。 */
export function parseSnbt(text: string, maxDepth = MAX_DEPTH): NbtCompound {
  if (text.trim() === '') throw new SnbtParseError('内容是空的', 1, 1, '');
  return new Parser(text, maxDepth).parseRoot();
}

/**
 * 解析单个值（不是复合体），用于「按类型输入一个值」。
 * 列表元素、数组元素这类场景都走它，因此嵌套深度上限要放宽一些。
 */
export function parseSnbtValue(text: string, maxDepth = MAX_DEPTH * 4): NbtValue {
  if (text.trim() === '') throw new SnbtParseError('值是空的', 1, 1, '');
  return new Parser(text, maxDepth).parseSingle();
}
