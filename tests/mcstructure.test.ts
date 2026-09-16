/**
 * mcstructure 编辑器核心逻辑的对照测试（03 文档第 8 节：engine.test.ts 的等价物）。
 *
 * 测试两条独立的正确性来源：
 * 1. **真实文件**：用游戏内 Structure Block 导出的 pis.mcstructure
 *    （backend/tests/fixtures/real/），断言后端 Python 解析器与浏览器 TS 实现
 *    对同一个文件得到相同结果——两侧独立实现，互相验证。
 * 2. **往返一致**：解析 → 序列化 → 字节完全相同。这是「不改也要能原样写回」的底线，
 *    也是最能暴露写入器 bug 的测试（任何字段顺序、类型、长度写错都会在这里暴露）。
 *
 * 运行：npm test
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { TAG, readNbtFile, writeNbtFile, detectCompression, toPlain } from '../src/tools/mcstructure-editor/nbt';
import {
  LAYER_PRIMARY,
  LAYER_SECONDARY,
  VOID,
  addPaletteEntry,
  fillLayer,
  indexToPosition,
  parseStructure,
  positionToIndex,
  replaceEverywhere,
  serializeStructure,
  setBlock,
  summarize,
  syncBlockEntityPositions,
  UndoStack,
  type McStructureState,
} from '../src/tools/mcstructure-editor/structure';

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

function realBytes(): Uint8Array {
  return new Uint8Array(readFileSync(REAL_FILE));
}

// 与后端测试相同的期望值（backend/tests/test_real_files.py）
const EXPECTED_SIZE = { x: 1, y: 1, z: 1 };
const EXPECTED_ORIGIN: [number, number, number] = [72, 59, -10];

// ---------------------------------------------------------------- 真实文件

describe('真实文件（与后端 Python 实现交叉验证）', () => {
  it('字节未被改动：SHA-256 与 README 记录一致', async () => {
    const { createHash } = await import('node:crypto');
    const digest = createHash('sha256').update(realBytes()).digest('hex');
    assert.equal(digest, 'c73bea3fcf741b29356918cc8e1eeb97fbc40ff9d0b6d5f3737977a78bd7cac8');
  });

  it('识别为未压缩', () => {
    assert.equal(detectCompression(realBytes()), 'none');
  });

  it('尺寸、格式版本、层数与后端一致', async () => {
    const state = await parseStructure(realBytes());
    assert.equal(state.formatVersion, 1);
    assert.deepEqual(state.size, EXPECTED_SIZE);
    assert.equal(state.voxelCount, 1);
    assert.equal(state.layers.length, 2);
    assert.equal(state.compression, 'none');
  });

  it('结构原点在根层级（真实文件口径，文档写的是 structure 内部）', async () => {
    const state = await parseStructure(realBytes());
    assert.deepEqual(state.worldOrigin, EXPECTED_ORIGIN);
    assert.equal(state.originPlacement, 'root');
    assert.equal(state.root.has('structure_world_origin'), true);
    // 已消费的字段不该再算作「未建模」
    assert.deepEqual(state.extraRootFields, []);
  });

  it('调色板与方块状态', async () => {
    const state = await parseStructure(realBytes());
    assert.equal(state.palette.length, 1);
    assert.equal(state.palette[0]!.name, 'minecraft:sticky_piston');
    assert.equal(state.palette[0]!.version, 18168865);
    const facing = state.palette[0]!.states.get('facing_direction');
    assert.equal(facing?.type, TAG.Int);
    assert.equal(toPlain(facing!), 2);
  });

  it('两层索引：主层有方块、次层为 void', async () => {
    const state = await parseStructure(realBytes());
    assert.deepEqual(state.layers[LAYER_PRIMARY], [0]);
    assert.deepEqual(state.layers[LAYER_SECONDARY], [VOID]);
  });

  it('方块实体 NBT 完整保留，且绝对坐标等于结构原点', async () => {
    const state = await parseStructure(realBytes());
    assert.equal(state.positionData.size, 1);

    // position_data 的一条是 { block_entity_data: {...}, tick_queue_data: [...] }，
    // 真正的方块实体 NBT 在 block_entity_data 里面（用真实文件核对过层级）
    const entry = state.positionData.get('0')!;
    assert.ok(entry.has('block_entity_data'), '外层应有 block_entity_data');
    const nbt = entry.get('block_entity_data') as { type: number; value: Map<string, any> };
    assert.equal(nbt.type, TAG.Compound);
    const data = nbt.value;

    // 交叉验证：方块实体的 x/y/z 是绝对世界坐标，等于结构原点
    assert.equal(toPlain(data.get('x')!), EXPECTED_ORIGIN[0]);
    assert.equal(toPlain(data.get('y')!), EXPECTED_ORIGIN[1]);
    assert.equal(toPlain(data.get('z')!), EXPECTED_ORIGIN[2]);

    assert.equal(toPlain(data.get('id')!), 'PistonArm');
    assert.equal(toPlain(data.get('Sticky')!), 1);
    assert.equal(toPlain(data.get('isMovable')!), 1);
    assert.equal(toPlain(data.get('State')!), 0);
    assert.equal(toPlain(data.get('NewState')!), 0);
    assert.equal(toPlain(data.get('BlockEntityVersion')!), 0);
    // 浮点保持浮点
    assert.equal(toPlain(data.get('Progress')!), 0.0);
    assert.equal(typeof toPlain(data.get('Progress')!), 'number');
    // 空数组保持数组
    assert.deepEqual(toPlain(data.get('AttachedBlocks')!), []);
    assert.deepEqual(toPlain(data.get('BreakBlocks')!), []);
  });

  it('无实体', async () => {
    const state = await parseStructure(realBytes());
    assert.equal(state.entities.length, 0);
  });

  it('未建模字段为空（所有字段都被消费）', async () => {
    const state = await parseStructure(realBytes());
    assert.deepEqual(state.extraRootFields, []);
  });
});

// ---------------------------------------------------------------- 往返一致

describe('往返一致（解析 → 序列化 → 字节相同）', () => {
  it('真实文件未编辑时原样写回', async () => {
    const bytes = realBytes();
    const state = await parseStructure(bytes);
    const written = serializeStructure(state);
    assert.deepEqual(
      [...written],
      [...bytes],
      '未编辑的往返必须字节完全一致——任何差异都说明写入器漏字段或写错类型',
    );
  });

  it('往返两次仍然稳定', async () => {
    const state1 = await parseStructure(realBytes());
    const once = serializeStructure(state1);
    const state2 = await parseStructure(once);
    const twice = serializeStructure(state2);
    assert.deepEqual([...twice], [...once]);
  });

  it('手工构造的 NBT 树往返一致', async () => {
    const root = new Map<string, any>([
      ['format_version', { type: TAG.Int, value: 1 }],
      [
        'size',
        { type: TAG.List, elementType: TAG.Int, value: [1, 2, 3].map((n) => ({ type: TAG.Int, value: n })) },
      ],
      [
        'label',
        { type: TAG.String, value: '中文与 emoji 🎮' },
      ],
      ['ratio', { type: TAG.Float, value: 0.5 }],
      ['precise', { type: TAG.Double, value: 0.1 }],
      ['bignum', { type: TAG.Long, value: -4611686018427387904n }],
      ['flag', { type: TAG.Byte, value: 1 }],
      ['tiny', { type: TAG.Short, value: -300 }],
      ['blob', { type: TAG.ByteArray, value: [0, 127, 255] }],
      ['ints', { type: TAG.IntArray, value: [-1, 2 ** 31 - 1] }],
      ['longs', { type: TAG.LongArray, value: [-(2n ** 63n), 2n ** 63n - 1n] }],
      [
        'nested',
        {
          type: TAG.Compound,
          value: new Map<string, any>([['deep', { type: TAG.String, value: 'ok' }]]),
        },
      ],
      [
        'empty_list',
        { type: TAG.List, elementType: TAG.End, value: [] },
      ],
      [
        'list_of_compound',
        {
          type: TAG.List,
          elementType: TAG.Compound,
          value: [
            { type: TAG.Compound, value: new Map([['x', { type: TAG.Int, value: 1 }]]) },
            { type: TAG.Compound, value: new Map([['x', { type: TAG.Int, value: 2 }]]) },
          ],
        },
      ],
    ]);

    const bytes = writeNbtFile(root);
    const { root: back } = await readNbtFile(bytes);
    assert.deepEqual(toPlain(back.get('label')!), '中文与 emoji 🎮');
    assert.equal(toPlain(back.get('bignum')!), '-4611686018427387904');
    assert.deepEqual(toPlain(back.get('blob')!), [0, 127, 255]);
    assert.deepEqual(toPlain(back.get('ints')!), [-1, 2 ** 31 - 1]);
    assert.equal(toPlain(back.get('tiny')!), -300);
    assert.deepEqual(
      (toPlain(back.get('list_of_compound')!) as Array<{ x: number }>).map((i) => i.x),
      [1, 2],
    );
    assert.deepEqual(toPlain(back.get('nested')!), { deep: 'ok' });
    assert.equal(toPlain(back.get('ratio')!), 0.5);
    assert.equal(toPlain(back.get('precise')!), 0.1);
  });
});

// ---------------------------------------------------------------- 坐标换算

describe('位置下标换算（ZYX 顺序）', () => {
  it('小端读写的整数与小端字节序一致', () => {
    // 用已知的小端字节验证：TAG_Int 值 1 应写成 01 00 00 00
    const root = new Map<string, any>([['i', { type: TAG.Int, value: 1 }]]);
    const bytes = writeNbtFile(root);
    // 结构：0a 0000 | 03 0100 'i' | 01000000 | 00
    assert.equal(bytes[0], TAG.Compound);
    assert.equal(bytes[1], 0x00);
    assert.equal(bytes[2], 0x00);
    assert.equal(bytes[3], TAG.Int);
    assert.equal(bytes[4], 0x01);
    assert.equal(bytes[5], 0x00);
    assert.equal(bytes[6], 'i'.charCodeAt(0));
    assert.deepEqual([...bytes.slice(7, 11)], [0x01, 0x00, 0x00, 0x00], '整数必须是小端');
  });

  it('2×3×4 的下标顺序与文档一致', () => {
    const size = { x: 2, y: 3, z: 4 };
    const cases: Array<[number, number, number, number]> = [
      [0, 0, 0, 0],
      [0, 0, 3, 3],
      [0, 1, 0, 4],
      [0, 2, 3, 11],
      [1, 0, 0, 12],
      [1, 2, 3, 23],
    ];
    for (const [x, y, z, expected] of cases) {
      assert.equal(positionToIndex(size, x, y, z), expected, `(${x},${y},${z})`);
      assert.deepEqual(indexToPosition(size, expected), [x, y, z]);
    }
  });
});

// ---------------------------------------------------------------- 编辑操作

async function tinyState(): Promise<McStructureState> {
  // 用真实文件作为起点，改造成 2×2×2 便于编辑测试
  const state = await parseStructure(realBytes());
  const total = 8;
  state.size = { x: 2, y: 2, z: 2 };
  state.voxelCount = total;
  state.layers = [
    new Array(total).fill(VOID),
    new Array(total).fill(VOID),
  ];
  state.palette = [
    { name: 'minecraft:stone', states: new Map(), version: 18168865 },
    { name: 'minecraft:air', states: new Map(), version: 18168865 },
  ];
  state.positionData = new Map();
  return state;
}

describe('编辑操作', () => {
  it('设置方块与清空', async () => {
    const state = await tinyState();
    assert.deepEqual(setBlock(state, LAYER_PRIMARY, 0, 0), { changed: 1 });
    assert.equal(state.layers[LAYER_PRIMARY][0], 0);
    // 同值重复设置不算改动
    assert.deepEqual(setBlock(state, LAYER_PRIMARY, 0, 0), { changed: 0 });
    // 清空回到 void
    assert.deepEqual(setBlock(state, LAYER_PRIMARY, 0, VOID), { changed: 1 });
    assert.equal(state.layers[LAYER_PRIMARY][0], VOID);
  });

  it('越界下标与越界调色板被拒绝（不猜测修复）', async () => {
    const state = await tinyState();
    assert.throws(() => setBlock(state, LAYER_PRIMARY, 99, 0), /超出范围/);
    assert.throws(() => setBlock(state, LAYER_PRIMARY, 0, 99), /调色板下标/);
    assert.throws(() => setBlock(state, 5, 0, 0), /没有第 5 层/);
  });

  it('清空方块会一并移除该格的方块实体数据', async () => {
    const state = await tinyState();
    state.positionData.set('0', new Map([['id', { type: TAG.String, value: 'Chest' }]]));
    setBlock(state, LAYER_PRIMARY, 0, 0);
    assert.equal(state.positionData.has('0'), true, '有方块时保留');
    setBlock(state, LAYER_PRIMARY, 0, VOID);
    assert.equal(state.positionData.has('0'), false, '清空后应移除，避免留下孤儿方块实体');
  });

  it('填充整层', async () => {
    const state = await tinyState();
    assert.deepEqual(fillLayer(state, LAYER_PRIMARY, 1), { changed: 8 });
    assert.deepEqual(state.layers[LAYER_PRIMARY], new Array(8).fill(1));
    assert.deepEqual(fillLayer(state, LAYER_PRIMARY, VOID), { changed: 8 });
    assert.deepEqual(state.layers[LAYER_PRIMARY], new Array(8).fill(VOID));
  });

  it('全结构范围内替换方块', async () => {
    const state = await tinyState();
    fillLayer(state, LAYER_PRIMARY, 0);
    setBlock(state, LAYER_SECONDARY, 0, 0);
    assert.deepEqual(replaceEverywhere(state, 0, 1), { changed: 9 });
    assert.deepEqual(state.layers[LAYER_PRIMARY], new Array(8).fill(1));
    assert.equal(state.layers[LAYER_SECONDARY][0], 1);
  });

  it('新增调色板条目；完全相同时复用而不重复添加', async () => {
    const state = await tinyState();
    const first = addPaletteEntry(state, { name: 'minecraft:oak_planks', states: new Map() });
    assert.equal(first, 2);
    const again = addPaletteEntry(state, { name: 'minecraft:oak_planks', states: new Map() });
    assert.equal(again, 2, '相同排列应复用');
    assert.equal(state.palette.length, 3);
  });

  it('状态不同的同种方块不视为重复', async () => {
    const state = await tinyState();
    addPaletteEntry(state, { name: 'minecraft:oak_stairs', states: new Map() });
    const stairs = addPaletteEntry(state, {
      name: 'minecraft:oak_stairs',
      states: new Map([['weirdo_direction', { type: TAG.String, value: 'north' }]]),
    });
    assert.equal(state.palette.length, 4);
    assert.equal(stairs, 3);
  });

  it('编辑后仍能序列化并被重新解析（写回是有效文件）', async () => {
    const state = await tinyState();
    fillLayer(state, LAYER_PRIMARY, 0);
    setBlock(state, LAYER_SECONDARY, 3, 1);
    const bytes = serializeStructure(state);

    const reloaded = await parseStructure(bytes);
    assert.deepEqual(reloaded.size, { x: 2, y: 2, z: 2 });
    assert.deepEqual(reloaded.layers[LAYER_PRIMARY], new Array(8).fill(0));
    assert.equal(reloaded.layers[LAYER_SECONDARY][3], 1);
    assert.equal(reloaded.palette.length, 2);
    assert.equal(reloaded.palette[0]!.name, 'minecraft:stone');
  });

  it('同步方块实体绝对坐标（编辑/改原点之后不再自相矛盾）', async () => {
    const state = await parseStructure(realBytes());
    // 真实文件里 PistonArm 的 x/y/z = 72/59/-10（= 原点 + 结构内 0,0,0）
    assert.equal(syncBlockEntityPositions(state).changed, 0, '未改动时不应有变化');

    // 把原点挪走，坐标应随之更新
    state.worldOrigin = [100, 70, -5];
    const result = syncBlockEntityPositions(state);
    assert.equal(result.changed, 3);

    const entry = state.positionData.get('0')!;
    const data = (entry.get('block_entity_data') as { value: Map<string, any> }).value;
    assert.equal(toPlain(data.get('x')!), 100);
    assert.equal(toPlain(data.get('y')!), 70);
    assert.equal(toPlain(data.get('z')!), -5);
  });
});

// ---------------------------------------------------------------- 统计与撤销

describe('统计', () => {
  it('统计口径与后端一致（filled / void / 逐层）', async () => {
    const state = await parseStructure(realBytes());
    const s = summarize(state);
    assert.equal(s.voxelCount, 1);
    assert.equal(s.filled, 1);
    assert.equal(s.filledPerLayer[LAYER_PRIMARY], 1);
    assert.equal(s.filledPerLayer[LAYER_SECONDARY], 0);
    assert.equal(s.voidSlots, 0);
    assert.equal(s.blockEntities, 1);
    assert.equal(s.entities, 0);
    assert.equal(s.outOfRange, 0);
    assert.equal(s.paletteUsed, 1);
    assert.deepEqual(s.worldOrigin, EXPECTED_ORIGIN);
    assert.equal(s.counts[0]!.name, 'minecraft:sticky_piston');
    assert.equal(s.counts[0]!.count, 1);
    assert.equal(s.counts[0]!.ratio, 1);
  });

  it('越界调色板下标被单独计数而不是当成方块', async () => {
    const state = await tinyState();
    state.layers[LAYER_PRIMARY][0] = 99;
    const s = summarize(state);
    assert.equal(s.outOfRange, 1);
    assert.equal(s.filled, 1);
  });
});

describe('撤销栈', () => {
  it('撤销与重做恢复编辑', async () => {
    const state = await tinyState();
    const undo = new UndoStack();

    undo.record(state, '放置石头');
    setBlock(state, LAYER_PRIMARY, 0, 0);
    assert.equal(state.layers[LAYER_PRIMARY][0], 0);

    assert.equal(undo.canUndo, true);
    undo.undo(state);
    assert.equal(state.layers[LAYER_PRIMARY][0], VOID);

    assert.equal(undo.canRedo, true);
    undo.redo(state);
    assert.equal(state.layers[LAYER_PRIMARY][0], 0);
  });

  it('新编辑会清空重做栈', async () => {
    const state = await tinyState();
    const undo = new UndoStack();
    undo.record(state, 'a');
    setBlock(state, LAYER_PRIMARY, 0, 0);
    undo.undo(state);
    assert.equal(undo.canRedo, true);
    undo.record(state, 'b');
    setBlock(state, LAYER_PRIMARY, 1, 1);
    assert.equal(undo.canRedo, false);
  });
});
