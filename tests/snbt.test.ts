/**
 * SNBT 文本读写的对照测试。
 *
 * 两条正确性来源：
 * 1. **规范细节**：类型后缀、数组前缀、引号规则、转义 —— 逐条断言，
 *    保证写出的文本能被游戏/其它 NBT 工具读回同一份数据。
 * 2. **往返一致**：NBT 树 → SNBT → NBT 树，以及真实文件的根复合体往返。
 *
 * 运行：npm test
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { TAG, readNbtFile, toPlain, type NbtCompound, type NbtValue } from '../src/tools/mcstructure-editor/nbt';
import {
  SnbtParseError,
  parseSnbt,
  parseSnbtValue,
  rootToSnbt,
  toSnbt,
} from '../src/tools/mcstructure-editor/snbt';

const here = dirname(fileURLToPath(import.meta.url));
const REAL_FILE = join(
  here,
  '..',
  'backend',
  'tests',
  'fixtures',
  'real',
  'sticky-piston-1x1x1.mcstructure',
);

function realRoot(): NbtCompound {
  return new Map(); // 占位，真正读取在下面的 async 用例里
}

// ---------------------------------------------------------------- 序列化

describe('SNBT 序列化', () => {
  it('每种类型都带正确的后缀', () => {
    const cases: Array<[NbtValue, string]> = [
      [{ type: TAG.Byte, value: 1 }, '1b'],
      [{ type: TAG.Byte, value: -1 }, '-1b'],
      [{ type: TAG.Short, value: 300 }, '300s'],
      [{ type: TAG.Int, value: 42 }, '42'],
      [{ type: TAG.Long, value: 9007199254740993n }, '9007199254740993L'],
      [{ type: TAG.Long, value: -(2n ** 63n) }, '-9223372036854775808L'],
      [{ type: TAG.Float, value: 0.5 }, '0.5f'],
      [{ type: TAG.Double, value: 0.1 }, '0.1'],
      // 整数值的浮点必须带小数点，否则会被读成 Int
      [{ type: TAG.Double, value: 1 }, '1.0'],
      [{ type: TAG.Float, value: 2 }, '2.0f'],
      [{ type: TAG.String, value: 'hello' }, 'hello'],
    ];
    for (const [value, expected] of cases) {
      assert.equal(toSnbt(value), expected);
    }
  });

  it('三种数组用 [B; / [I; / [L; 前缀', () => {
    assert.equal(toSnbt({ type: TAG.ByteArray, value: [1, 2, 3] }), '[B;1b,2b,3b]');
    assert.equal(toSnbt({ type: TAG.IntArray, value: [1, -2] }), '[I;1,-2]');
    assert.equal(toSnbt({ type: TAG.LongArray, value: [1n, 2n] }), '[L;1L,2L]');
  });

  it('空容器', () => {
    assert.equal(toSnbt({ type: TAG.List, elementType: TAG.End, value: [] }), '[]');
    assert.equal(toSnbt({ type: TAG.Compound, value: new Map() }), '{}');
  });

  it('需要引号的字符串会被加上引号并转义', () => {
    assert.equal(toSnbt({ type: TAG.String, value: 'has space' }), '"has space"');
    assert.equal(toSnbt({ type: TAG.String, value: '' }), '""');
    assert.equal(toSnbt({ type: TAG.String, value: 'say "hi"' }), '"say \\"hi\\""');
    assert.equal(toSnbt({ type: TAG.String, value: 'line1\nline2' }), '"line1\\nline2"');
    assert.equal(toSnbt({ type: TAG.String, value: 'back\\slash' }), '"back\\\\slash"');
    // 中文不在裸串白名单里，加引号最安全
    assert.equal(toSnbt({ type: TAG.String, value: '石头' }), '"石头"');
  });

  it('带冒号的标识符是裸串（方块名要写成 minecraft:stone 才自然）', () => {
    for (const name of ['minecraft:stone', 'minecraft:sticky_piston', 'minecraft:oak_stairs']) {
      assert.equal(toSnbt({ type: TAG.String, value: name }), name, `${name} 不该加引号`);
      const back = parseSnbtValue(name);
      assert.equal(back.type, TAG.String);
      assert.equal(back.value, name);
    }
    // 含空格或括号的仍然要加引号
    assert.equal(toSnbt({ type: TAG.String, value: 'a b' }), '"a b"');
    assert.equal(toSnbt({ type: TAG.String, value: 'a,b' }), '"a,b"');
    assert.equal(toSnbt({ type: TAG.String, value: 'a{b' }), '"a{b"');
  });

  it('会被误读成本类型标记的裸串必须加引号', () => {
    // `b` 如果裸写，会被读成字节后缀 -> 必须加引号
    for (const tricky of ['b', 's', 'l', 'f', 'd', 'true', 'false']) {
      const text = toSnbt({ type: TAG.String, value: tricky });
      assert.equal(text, `"${tricky}"`, `${tricky} 应该加引号`);
      const back = parseSnbtValue(text);
      assert.equal(back.type, TAG.String);
      assert.equal(back.value, tricky);
    }
    // 纯数字字符串也要加引号，否则会变成数字
    assert.equal(toSnbt({ type: TAG.String, value: '123' }), '"123"');
    assert.equal(parseSnbtValue('"123"').type, TAG.String);
  });

  it('复合体缩进输出，且键在需要时加引号', () => {
    const compound: NbtCompound = new Map<string, NbtValue>([
      ['a', { type: TAG.Int, value: 1 }],
      ['with space', { type: TAG.String, value: 'x' }],
    ]);
    const text = toSnbt({ type: TAG.Compound, value: compound }, { indent: 2 });
    assert.equal(text, '{\n  a:1,\n  "with space":x\n}');
    // 紧凑模式
    assert.equal(toSnbt({ type: TAG.Compound, value: compound }, { indent: 0 }), '{a:1,"with space":x}');
  });

  it('列表与嵌套复合体', () => {
    const list: NbtValue = {
      type: TAG.List,
      elementType: TAG.Compound,
      value: [
        { type: TAG.Compound, value: new Map([['x', { type: TAG.Int, value: 1 }]]) },
        { type: TAG.Compound, value: new Map([['x', { type: TAG.Int, value: 2 }]]) },
      ],
    };
    assert.equal(toSnbt(list, { indent: 0 }), '[{x:1},{x:2}]');
  });
});

// ---------------------------------------------------------------- 解析

describe('SNBT 解析', () => {
  it('基本类型都能读回', () => {
    const root = parseSnbt(`{
      byte: 1b,
      short: -300s,
      int: 42,
      long: 9007199254740993L,
      float: 0.5f,
      double: 0.1,
      str: "hello",
      bare: minecraft:stone,
      yes: true,
      no: false
    }`);
    assert.equal(toPlain(root.get('byte')!), 1);
    assert.equal(root.get('byte')!.type, TAG.Byte);
    assert.equal(root.get('short')!.type, TAG.Short);
    assert.equal(toPlain(root.get('short')!), -300);
    assert.equal(root.get('int')!.type, TAG.Int);
    assert.equal(root.get('long')!.type, TAG.Long);
    assert.equal(toPlain(root.get('long')!), '9007199254740993');
    assert.equal(root.get('float')!.type, TAG.Float);
    assert.equal(toPlain(root.get('float')!), 0.5);
    assert.equal(root.get('double')!.type, TAG.Double);
    assert.equal(toPlain(root.get('str')!), 'hello');
    assert.equal(root.get('bare')!.type, TAG.String);
    assert.equal(toPlain(root.get('bare')!), 'minecraft:stone');
    // true/false 按字节读（与游戏一致）
    assert.equal(root.get('yes')!.type, TAG.Byte);
    assert.equal(toPlain(root.get('yes')!), 1);
    assert.equal(toPlain(root.get('no')!), 0);
  });

  it('数组读回正确的类型', () => {
    const root = parseSnbt('{b:[B;1b,2b],i:[I;1,-2],l:[L;1L,2L],eb:[B;],ei:[I;],el:[L;]}');
    assert.equal(root.get('b')!.type, TAG.ByteArray);
    assert.deepEqual(toPlain(root.get('b')!), [1, 2]);
    assert.equal(root.get('i')!.type, TAG.IntArray);
    assert.deepEqual(toPlain(root.get('i')!), [1, -2]);
    assert.equal(root.get('l')!.type, TAG.LongArray);
    assert.deepEqual(toPlain(root.get('l')!), ['1', '2']);
    // 空数组的类型不能丢
    assert.equal(root.get('eb')!.type, TAG.ByteArray);
    assert.equal(root.get('ei')!.type, TAG.IntArray);
    assert.equal(root.get('el')!.type, TAG.LongArray);
  });

  it('可选的类型后缀与尾随逗号、注释都被容忍', () => {
    const root = parseSnbt(`{
      // 这是注释
      a: 1,   // 行尾注释
      b: [1,2,],
      c: {x:1,},
    }`);
    assert.equal(toPlain(root.get('a')!), 1);
    assert.deepEqual((toPlain(root.get('b')!) as number[]), [1, 2]);
    assert.deepEqual(toPlain(root.get('c')!), { x: 1 });
  });

  it('转义序列读回正确', () => {
    const root = parseSnbt('{a:"line1\\nline2",b:"say \\"hi\\"",c:"back\\\\slash",d:"tab\\there"}');
    assert.equal(toPlain(root.get('a')!), 'line1\nline2');
    assert.equal(toPlain(root.get('b')!), 'say "hi"');
    assert.equal(toPlain(root.get('c')!), 'back\\slash');
    assert.equal(toPlain(root.get('d')!), 'tab\there');
  });

  it('带引号的键', () => {
    const root = parseSnbt('{"with space":1,"b":2}');
    assert.equal(toPlain(root.get('with space')!), 1);
    assert.equal(root.get('b')!.type, TAG.Int);
  });

  // ---- 错误路径：必须能定位 ----

  it('缺少闭合括号时报出位置', () => {
    assert.throws(() => parseSnbt('{a:1'), (error: unknown) => {
      assert.ok(error instanceof SnbtParseError);
      assert.match(error.message, /期望「,」或「}」/);
      return true;
    });
  });

  it('最外层不是复合体时报错', () => {
    assert.throws(() => parseSnbt('[1,2]'), /最外层必须是复合体/);
    assert.throws(() => parseSnbt('42'), /最外层必须是复合体/);
  });

  it('空文本报错', () => {
    assert.throws(() => parseSnbt('   '), /内容是空的/);
    assert.throws(() => parseSnbtValue(''), /值是空的/);
  });

  it('错误带行号列号，能定位到出错的那一行', () => {
    try {
      parseSnbt('{\n  a: 1,\n  b: ,\n}');
      assert.fail('应当抛错');
    } catch (error) {
      assert.ok(error instanceof SnbtParseError);
      assert.equal(error.line, 3, `应定位到第 3 行，实际第 ${error.line} 行`);
      assert.match(error.snippet, /b:/);
    }
  });

  it('整数超出 32 位时提示加 L 后缀', () => {
    assert.throws(() => parseSnbt('{a:99999999999}'), /超出 32 位范围.*L 后缀/s);
  });

  it('字节/短整型超范围时报错', () => {
    assert.throws(() => parseSnbt('{a:200b}'), /字节值 200 超出范围/);
    assert.throws(() => parseSnbt('{a:40000s}'), /短整型 40000 超出范围/);
  });

  it('列表元素类型必须一致', () => {
    assert.throws(() => parseSnbt('{a:[1,"two"]}'), /列表的元素必须同类型/);
    // 同类型可以
    assert.doesNotThrow(() => parseSnbt('{a:[1,2,3]}'));
  });

  it('未知转义报错', () => {
    assert.throws(() => parseSnbt('{a:"\\q"}'), /不认识的转义/);
  });

  it('复合体之后有多余内容时报错', () => {
    assert.throws(() => parseSnbt('{a:1} junk'), /还有多余内容/);
  });

  it('缺少冒号时报错', () => {
    assert.throws(() => parseSnbt('{a 1}'), /期望「:」/);
  });

  it('嵌套过深时报错', () => {
    const deep = `${'{a:'.repeat(20)}1${'}'.repeat(20)}`;
    assert.throws(() => parseSnbt(deep, 8), /嵌套超过 8 层/);
  });
});

// ---------------------------------------------------------------- 往返

describe('SNBT 往返一致', () => {
  it('各种值的值级往返', () => {
    const values: NbtValue[] = [
      { type: TAG.Byte, value: -128 },
      { type: TAG.Byte, value: 127 },
      { type: TAG.Short, value: -32768 },
      { type: TAG.Int, value: 2147483647 },
      { type: TAG.Int, value: -2147483648 },
      { type: TAG.Long, value: 9223372036854775807n },
      { type: TAG.Long, value: -(2n ** 63n) },
      { type: TAG.Float, value: 1.5 },
      { type: TAG.Double, value: 3.141592653589793 },
      { type: TAG.Double, value: 1e21 },
      { type: TAG.Double, value: -0.0 },
      { type: TAG.String, value: 'plain' },
      { type: TAG.String, value: '需要引号 的' },
      { type: TAG.String, value: 'quote"inside' },
      { type: TAG.ByteArray, value: [] },
      { type: TAG.ByteArray, value: [0, 127, 128, 255] },
      { type: TAG.IntArray, value: [] },
      { type: TAG.IntArray, value: [-1, 0, 1] },
      { type: TAG.LongArray, value: [0n] },
      { type: TAG.List, elementType: TAG.End, value: [] },
      { type: TAG.List, elementType: TAG.Int, value: [
        { type: TAG.Int, value: 1 },
        { type: TAG.Int, value: 2 },
      ] },
      { type: TAG.Compound, value: new Map() },
    ];

    for (const value of values) {
      const text = toSnbt(value);
      const back = parseSnbtValue(text);
      assert.equal(back.type, value.type, `${text} 的类型应保持`);
      if (value.type === TAG.Double && Object.is(value.value, -0)) {
        assert.ok(Object.is(back.value, 0) || Object.is(back.value, -0), '负零可接受');
      } else {
        assert.deepEqual(
          toPlain(back),
          toPlain(value),
          `${text} 往返后值应一致（类型 ${value.type}）`,
        );
      }
    }
  });

  it('根复合体往返后与原树一致', async () => {
    const bytes = new Uint8Array(readFileSync(REAL_FILE));
    const { root } = await readNbtFile(bytes);

    const text = rootToSnbt(root);
    const back = parseSnbt(text);
    assert.deepEqual(toPlain(back), toPlain(root), '真实文件的根复合体经 SNBT 往返应完全一致');
  });

  it('紧凑模式与缩进模式的解析结果一致', async () => {
    const { root } = await readNbtFile(new Uint8Array(readFileSync(REAL_FILE)));
    const pretty = parseSnbt(rootToSnbt(root, { indent: 2 }));
    const compact = parseSnbt(rootToSnbt(root, { indent: 0 }));
    assert.deepEqual(toPlain(pretty), toPlain(compact));
  });

  it('往返两次文本稳定（不会越写越乱）', async () => {
    const { root } = await readNbtFile(new Uint8Array(readFileSync(REAL_FILE)));
    const once = rootToSnbt(root);
    const twice = rootToSnbt(parseSnbt(once));
    assert.equal(twice, once);
  });

  it('真实文件里的方块实体能被 SNBT 表达并读回', async () => {
    const { root } = await readNbtFile(new Uint8Array(readFileSync(REAL_FILE)));
    const text = rootToSnbt(root);
    // 真实文件里 PistonArm 的绝对坐标应出现在文本里
    assert.match(text, /x:72/);
    assert.match(text, /y:59/);
    assert.match(text, /z:-10/);
    assert.match(text, /PistonArm/);

    const back = parseSnbt(text);
    const structure = (back.get('structure') as { value: NbtCompound }).value;
    const palette = (structure.get('palette') as { value: NbtCompound }).value;
    const def = (palette.get('default') as { value: NbtCompound }).value;
    const bpd = (def.get('block_position_data') as { value: NbtCompound }).value;
    const entry = (bpd.get('0') as { value: NbtCompound }).value;
    const data = (entry.get('block_entity_data') as { value: NbtCompound }).value;
    assert.equal(toPlain(data.get('x')!), 72);
    assert.equal(toPlain(data.get('Sticky')!), 1);
  });
});
