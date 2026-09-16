/**
 * 工具引擎对照测试（04 文档第 3 节「纯计算：独立已知结果、边界值、非法输入、不变量」）。
 *
 * 运行：npm test（Node 内置 test runner，直接执行 TypeScript）
 * 约定：期望值全部是手算的独立结果，不用实现本身推导；
 *       边界样例按 04 文档要求覆盖 -17 / -16 / -1 / 0 / 15 / 16、0 / 1 / 堆叠上限前后 / 不可堆叠。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { engine as chunkEngine, REGION_CHUNKS } from '../src/tools/chunk-coordinates/engine.ts';
import { chunkInputSchema } from '../src/tools/chunk-coordinates/schema.ts';
import { engine as materialEngine } from '../src/tools/material-counter/engine.ts';
import { materialInputSchema } from '../src/tools/material-counter/schema.ts';

const CHUNK_CONTEXT = { rulesetId: 'chunk-16-v1', signal: new AbortController().signal };
const STACK_CONTEXT = { rulesetId: 'stack-slots-v1', signal: new AbortController().signal };

async function chunkAt(x: number, z: number, dimension = 'overworld') {
  const parsed = chunkInputSchema.parse({ x: String(x), z: String(z), dimension });
  assert.equal(parsed.ok, true, `输入应通过校验：x=${x} z=${z}`);
  const result = await chunkEngine.run(parsed.value, CHUNK_CONTEXT);
  assert.equal(result.ok, true);
  return result.value;
}

async function materials(input: unknown) {
  const parsed = materialInputSchema.parse(input);
  assert.equal(parsed.ok, true, '输入应通过校验');
  const result = await materialEngine.run(parsed.value, STACK_CONTEXT);
  assert.equal(result.ok, true);
  return result.value;
}

describe('区块与坐标助手', () => {
  test('整格与边界坐标的区块编号（含负坐标向下取整）', async () => {
    // 手算对照：floor(x/16)，负坐标不能截断趋零
    const cases: Array<[number, number, number, number]> = [
      // [方块坐标, 期望区块坐标, 期望区块内坐标, 期望区块原点]
      [0, 0, 0, 0],
      [15, 0, 15, 0],
      [16, 1, 0, 16],
      [-1, -1, 15, -16],
      [-16, -1, 0, -16],
      [-17, -2, 15, -32],
      [33, 2, 1, 32],
      [-33, -3, 15, -48],
    ];

    for (const [block, expectedChunk, expectedOffset, expectedOrigin] of cases) {
      const out = await chunkAt(block, block);
      assert.equal(out.chunk.x, expectedChunk, `X=${block} 的区块编号`);
      assert.equal(out.chunk.z, expectedChunk, `Z=${block} 的区块编号`);
      assert.equal(out.offset.x, expectedOffset, `X=${block} 的区块内坐标`);
      assert.equal(out.offset.z, expectedOffset, `Z=${block} 的区块内坐标`);
      assert.equal(out.chunkOrigin.x, expectedOrigin, `X=${block} 的区块原点`);
    }
  });

  test('不变量：区块内坐标恒在 0 ~ 15，且能还原原坐标', async () => {
    for (const value of [-1000, -33, -17, -16, -1, 0, 1, 15, 16, 17, 255, 4096]) {
      const out = await chunkAt(value, 0);
      assert.ok(out.offset.x >= 0 && out.offset.x <= 15, `区块内坐标越界：${out.offset.x}`);
      // 原点 + 区块内坐标 必须还原成输入
      assert.equal(out.chunkOrigin.x + out.offset.x, value, `X=${value} 还原失败`);
    }
  });

  test('区域文件下标按 32×32 区块推算，负区块不出现负数下标', async () => {
    const cases: Array<[number, number, number, number, number]> = [
      // [区块X, 区块Z, 期望区域X, 期望区域Z, 期望下标]
      [0, 0, 0, 0, 0],
      [31, 31, 0, 0, 31 + 31 * REGION_CHUNKS],
      [32, 32, 1, 1, 0],
      [-1, -1, -1, -1, 31 + 31 * REGION_CHUNKS],
      [-32, -32, -1, -1, 0],
    ];

    for (const [chunkX, chunkZ, regionX, regionZ, localIndex] of cases) {
      const out = await chunkAt(chunkX * 16, chunkZ * 16);
      assert.equal(out.region.x, regionX, `区块 ${chunkX},${chunkZ} 的区域 X`);
      assert.equal(out.region.z, regionZ, `区块 ${chunkX},${chunkZ} 的区域 Z`);
      assert.equal(out.region.localIndex, localIndex, `区块 ${chunkX},${chunkZ} 的文件内下标`);
      assert.ok(out.region.localIndex >= 0 && out.region.localIndex < 1024);
    }
  });

  test('主世界与下界按 8:1 互换', async () => {
    const overworld = await chunkAt(800, -800, 'overworld');
    const toNether = overworld.related.find((item) => item.label.includes('下界'));
    assert.ok(toNether, '主世界结果应给出下界对应坐标');
    assert.equal(toNether.x, 100);
    assert.equal(toNether.z, -100);

    const nether = await chunkAt(100, -100, 'nether');
    const toOverworld = nether.related.find((item) => item.label.includes('主世界'));
    assert.ok(toOverworld);
    assert.equal(toOverworld.x, 800);
    assert.equal(toOverworld.z, -800);
  });

  test('非法输入被拒绝，且指出具体字段', () => {
    const cases: Array<[unknown, string, string]> = [
      [{ x: 'abc', z: '0' }, 'not_a_number', 'x'],
      [{ x: '1.5', z: '0' }, 'not_an_integer', 'x'],
      [{ x: '', z: '0' }, 'empty_value', 'x'],
      [{ x: '99999999999', z: '0' }, 'out_of_range', 'x'],
      [{ x: '0', z: '0', dimension: 'moon' }, null as unknown as string, ''],
    ];

    for (const [input, code, field] of cases) {
      const parsed = chunkInputSchema.parse(input);
      if (code === null) {
        // 未知维度不报错，而是回落到主世界（默认值只是默认值，不猜测修复坐标）
        assert.equal(parsed.ok, true);
        assert.equal(parsed.ok && parsed.value.dimension, 'overworld');
        continue;
      }
      assert.equal(parsed.ok, false, `应拒绝输入：${JSON.stringify(input)}`);
      assert.equal(parsed.ok === false && parsed.error.code, code);
      assert.equal(parsed.ok === false && parsed.error.field, field);
    }
  });

  test('世界边界外的整数坐标被拒绝', () => {
    const parsed = chunkInputSchema.parse({ x: '30000000', z: '0' });
    assert.equal(parsed.ok, false);
    assert.equal(parsed.ok === false && parsed.error.code, 'out_of_range');
  });
});

describe('材料清单助手', () => {
  test('整除：2432 个石头 = 38 组，占 38 格，2 个潜影盒', async () => {
    const out = await materials({
      entries: [{ name: '石头', count: '2432', stackSize: '64' }],
      container: 'shulker',
    });
    assert.equal(out.lines[0]!.fullStacks, 38);
    assert.equal(out.lines[0]!.remainder, 0);
    assert.equal(out.lines[0]!.slots, 38);
    assert.equal(out.container?.need, 2);
    assert.equal(out.container?.spare, 54 - 38);
    assert.equal(out.container?.exact, false);
  });

  test('边界数量：1 个、恰好一组、刚过一组、不可堆叠物品', async () => {
    const one = await materials({ entries: [{ count: '1', stackSize: '64' }], container: 'none' });
    assert.equal(one.lines[0]!.fullStacks, 0);
    assert.equal(one.lines[0]!.remainder, 1);
    assert.equal(one.lines[0]!.slots, 1);

    const exactlyOneStack = await materials({
      entries: [{ count: '64', stackSize: '64' }],
      container: 'none',
    });
    assert.equal(exactlyOneStack.lines[0]!.fullStacks, 1);
    assert.equal(exactlyOneStack.lines[0]!.remainder, 0);
    assert.equal(exactlyOneStack.lines[0]!.slots, 1);

    const justOver = await materials({ entries: [{ count: '65', stackSize: '64' }], container: 'none' });
    assert.equal(justOver.lines[0]!.fullStacks, 1);
    assert.equal(justOver.lines[0]!.remainder, 1);
    assert.equal(justOver.lines[0]!.slots, 2, '多出的 1 个也要占一整格');

    const noStack = await materials({ entries: [{ count: '5', stackSize: '1' }], container: 'none' });
    assert.equal(noStack.lines[0]!.fullStacks, 5);
    assert.equal(noStack.lines[0]!.slots, 5, '不可堆叠物品每件占一格');
  });

  test('多种材料合计：0 行被忽略、16 堆叠单独处理', async () => {
    const out = await materials({
      entries: [
        { name: '石头', count: '2432', stackSize: '64' },
        { name: '末影珍珠', count: '20', stackSize: '16' },
        { name: '', count: '0', stackSize: '64' },
        { name: '', count: '', stackSize: '64' },
      ],
      container: 'shulker',
    });
    assert.equal(out.lines.length, 2, '数量为 0 或留空的行应被忽略');
    assert.equal(out.totals.kinds, 2);
    assert.equal(out.totals.count, 2452);
    assert.equal(out.totals.slots, 38 + 2, '20 个末影珍珠 = 1 组 + 4 个零头 = 2 格');
    assert.equal(out.container?.need, 2, '40 格里最后一个潜影盒还剩 14 格');
    assert.equal(out.container?.spare, 54 - 40);
  });

  test('刚好装满容器时标记 exact', async () => {
    const out = await materials({
      entries: [{ count: '1728', stackSize: '64' }],
      container: 'shulker',
    });
    assert.equal(out.lines[0]!.slots, 27);
    assert.equal(out.container?.need, 1);
    assert.equal(out.container?.exact, true);
    assert.equal(out.container?.spare, 0);
  });

  test('不选容器时不做容器换算', async () => {
    const out = await materials({ entries: [{ count: '100', stackSize: '64' }], container: 'none' });
    assert.equal(out.container, null);
    assert.equal(out.lines[0]!.slots, 2);
  });

  test('大数量仍在安全整数范围内计算', async () => {
    const out = await materials({
      entries: [{ count: '1000000000', stackSize: '64' }],
      container: 'double-chest',
    });
    assert.equal(out.lines[0]!.fullStacks, 15_625_000);
    assert.equal(out.lines[0]!.slots, 15_625_000);
    assert.ok(Number.isSafeInteger(out.totals.slots));
    assert.ok(Number.isSafeInteger(out.container!.capacity));
  });

  test('非法输入被拒绝：负数、小数、超范围堆叠、全空', () => {
    const negative = materialInputSchema.parse({
      entries: [{ count: '-5', stackSize: '64' }],
      container: 'none',
    });
    assert.equal(negative.ok, false);
    assert.equal(negative.ok === false && negative.error.field, 'entries.0.count');

    const decimal = materialInputSchema.parse({
      entries: [{ count: '3.5', stackSize: '64' }],
      container: 'none',
    });
    assert.equal(decimal.ok, false);
    assert.equal(decimal.ok === false && decimal.error.code, 'not_an_integer');

    const badStack = materialInputSchema.parse({
      entries: [{ count: '10', stackSize: '128' }],
      container: 'none',
    });
    assert.equal(badStack.ok, false);
    assert.equal(badStack.ok === false && badStack.error.field, 'entries.0.stackSize');

    const empty = materialInputSchema.parse({ entries: [], container: 'none' });
    assert.equal(empty.ok, false);
    assert.equal(empty.ok === false && empty.error.code, 'empty_list');
  });

  test('容器容量来自输入而不是写死：大箱子按 54 格换算', async () => {
    const out = await materials({
      entries: [{ count: '3456', stackSize: '64' }],
      container: 'double-chest',
    });
    assert.equal(out.lines[0]!.slots, 54);
    assert.equal(out.container?.slots, 54);
    assert.equal(out.container?.need, 1);
    assert.equal(out.container?.exact, true);
  });
});

describe('工具契约', () => {
  test('两个引擎都声明了实现版本与输入协议版本', async () => {
    assert.match(chunkEngine.implementationVersion, /^\d+\.\d+\.\d+$/);
    assert.match(materialEngine.implementationVersion, /^\d+\.\d+\.\d+$/);
    assert.equal(chunkInputSchema.inputSchemaVersion, 1);
    assert.equal(materialInputSchema.inputSchemaVersion, 1);
  });

  test('引擎不读取 DOM：在纯 Node 环境下可运行', async () => {
    // 本测试文件本身没有 document/window，能跑通即说明 engine 与 schema 不依赖浏览器
    assert.equal(typeof globalThis.document, 'undefined');
    const out = await chunkAt(16, 16);
    assert.equal(out.chunk.x, 1);
  });
});
