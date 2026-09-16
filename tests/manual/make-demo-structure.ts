// 生成一个较大的测试结构，用于验证编辑器的网格交互与编辑（1×1×1 太简单了）。
// 用编辑器自己的写入器生成，保证是合法 .mcstructure。
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { parseStructure, serializeStructure, addPaletteEntry } from '../../src/tools/mcstructure-editor/structure';
import { TAG } from '../../src/tools/mcstructure-editor/nbt';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '..', '..');
const REAL = join(REPO, 'backend', 'tests', 'fixtures', 'real', 'sticky-piston-1x1x1.mcstructure');

const state = await parseStructure(new Uint8Array(readFileSync(REAL)));

// 改成 8×3×8，用来验证网格、层切换与连通填充
const X = 8;
const Y = 3;
const Z = 8;
state.size = { x: X, y: Y, z: Z };
state.voxelCount = X * Y * Z;
state.layers = [
  new Array(X * Y * Z).fill(-1),
  new Array(X * Y * Z).fill(-1),
];
state.positionData = new Map();

// 加几种方块，覆盖不同的状态值类型（字符串 / 整数 / 字节）
const stone = addPaletteEntry(state, { name: 'minecraft:stone', states: new Map(), version: 18168865 });
const planks = addPaletteEntry(state, { name: 'minecraft:oak_planks', states: new Map(), version: 18168865 });
const glass = addPaletteEntry(state, {
  name: 'minecraft:glass',
  states: new Map([['pillar_axis', { type: TAG.String, value: 'y' }]]),
  version: 18168865,
});
const water = addPaletteEntry(state, {
  name: 'minecraft:water',
  states: new Map([['liquid_depth', { type: TAG.Int, value: 0 }]]),
  version: 18168865,
});

const idx = (x, y, z) => x * (Y * Z) + y * Z + z;

// 地板（y=0 铺满石头），中间放一个玻璃柱，四周留空
for (let x = 0; x < X; x += 1) {
  for (let z = 0; z < Z; z += 1) {
    state.layers[0][idx(x, 0, z)] = stone;
  }
}
// 二层：四角木板
for (const [x, z] of [[1, 1], [1, Z - 2], [X - 2, 1], [X - 2, Z - 2]]) {
  state.layers[0][idx(x, 1, z)] = planks;
}
// 二层中心玻璃柱
for (const [x, z] of [[3, 3], [3, 4], [4, 3], [4, 4]]) {
  state.layers[0][idx(x, 1, z)] = glass;
}
// 次层（共位层）：在地板几格上放水，验证两层独立编辑
for (const [x, z] of [[0, 0], [0, 1], [1, 0]]) {
  state.layers[1][idx(x, 0, z)] = water;
}
// 一个方块实体（箱子），用来验证编辑后仍保留
state.positionData.set(String(idx(2, 1, 2)), new Map([
  ['block_entity_data', {
    type: TAG.Compound,
    value: new Map([
      ['id', { type: TAG.String, value: 'Chest' }],
      ['x', { type: TAG.Int, value: 72 + 2 }],
      ['y', { type: TAG.Int, value: 59 + 1 }],
      ['z', { type: TAG.Int, value: -10 + 2 }],
      ['Items', {
        type: TAG.List,
        elementType: TAG.Compound,
        value: [{
          type: TAG.Compound,
          value: new Map([
            ['Name', { type: TAG.String, value: 'minecraft:apple' }],
            ['Count', { type: TAG.Byte, value: 3 }],
            ['Slot', { type: TAG.Byte, value: 0 }],
          ]),
        }],
      }],
    ]),
  }],
]));
state.layers[0][idx(2, 1, 2)] = planks;

const out = join(REPO, '.tmp-downloads', 'editor-demo-8x3x8.mcstructure');
writeFileSync(out, serializeStructure(state));

// 回读验证
const check = await parseStructure(new Uint8Array(readFileSync(out)));
console.log(`已生成 ${out}`);
console.log(`  ${check.size.x}×${check.size.y}×${check.size.z}，调色板 ${check.palette.length} 项`);
const filled = check.layers.map((l) => l.filter((v) => v !== -1).length);
console.log(`  逐层非空：${filled.join(' / ')}（主层 / 次层）`);
console.log(`  方块实体：${check.positionData.size}`);
console.log(`  字节数：${readFileSync(out).length}`);
