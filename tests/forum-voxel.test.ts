/**
 * 3D 预览渲染核心的对照测试（Node 内置 test runner，见 tests/README.md）。
 *
 * 这一组测试的重点不是「代码跑得通」，而是**协议两端对得上**：
 * `voxel.ts` 解的是后端 `parsers/mcstructure_render.py` 写出来的
 * 「占用位图 + 调色板下标」小协议。所以这里的载荷由**测试自己重新编码**
 * （`encodeGrid`），不复用生产解码器——两边共用一个实现的话，
 * 协议写错了两边会一起错，正好是最需要被测出来的那种情况。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildShell,
  decodeRenderPayload,
  fitView,
  indexToPosition,
  planFrame,
  viewBasis,
  visibleFaceMask,
  VoxelPayloadError,
  type RenderPayloadJson,
} from '../src/modules/forum/voxel.ts';
import { blockColor, displayBlockName } from '../src/modules/forum/block-colors.ts';
import {
  coverCropHint,
  coverFormatLabel,
  coverSizeText,
  formatRatio,
  formatStates,
  materialTotals,
  relativeTime,
  sortMaterials,
} from '../src/modules/forum/present.ts';

// ---------------------------------------------------------------- 载荷编码
//
// 按后端 mcstructure_render.py 的 version 1 布局独立写一遍：
//   occupancy: ceil(voxelCount/8) 字节，第 i 格 = occupancy[i>>3] >> (i&7) & 1
//   indices:   非空格子按位置下标升序，每个 index_bits/8 字节，小端
// 坐标到下标的换算是 ZYX：index = x*(sy*sz) + y*sz + z

interface GridSpec {
  size: [number, number, number];
  /** 返回调色板下标，null 表示这一格是空的 */
  at: (x: number, y: number, z: number) => number | null;
  palette: string[];
  note?: string | null;
}

function encodeGrid(spec: GridSpec): RenderPayloadJson {
  const [sx, sy, sz] = spec.size;
  const voxelCount = sx * sy * sz;
  const occupancy = new Uint8Array(Math.ceil(voxelCount / 8));
  const indices: number[] = [];
  for (let x = 0; x < sx; x += 1) {
    for (let y = 0; y < sy; y += 1) {
      for (let z = 0; z < sz; z += 1) {
        const value = spec.at(x, y, z);
        if (value === null) continue;
        const index = x * (sy * sz) + y * sz + z;
        occupancy[index >> 3] |= 1 << (index & 7);
        indices.push(value);
      }
    }
  }
  const indexBits = spec.palette.length <= 256 ? 8 : 16;
  const raw = Buffer.alloc(indices.length * (indexBits / 8));
  indices.forEach((value, i) => {
    if (indexBits === 8) raw[i] = value;
    else raw.writeUInt16LE(value, i * 2);
  });
  return {
    version: 1,
    size: { x: sx, y: sy, z: sz },
    voxel_count: voxelCount,
    solid_count: indices.length,
    index_bits: indexBits,
    palette: spec.palette,
    occupancy: Buffer.from(occupancy).toString('base64'),
    indices: raw.toString('base64'),
    note: spec.note ?? null,
  };
}

/** 一个 3×3×3 的实心立方（27 格全是 0 号方块）。 */
function solidCube(size = 3): RenderPayloadJson {
  return encodeGrid({
    size: [size, size, size],
    at: () => 0,
    palette: ['minecraft:stone'],
  });
}

// ---------------------------------------------------------------- 解码

describe('decodeRenderPayload', () => {
  it('解出尺寸、方块数与每个格子的调色板下标', () => {
    const model = decodeRenderPayload(
      encodeGrid({
        size: [2, 1, 3],
        // 只在 (0,0,0) 与 (1,0,2) 放两块，其余留空
        at: (x, y, z) => (x === 0 && y === 0 && z === 0 ? 0 : x === 1 && z === 2 ? 1 : null),
        palette: ['minecraft:stone', 'minecraft:oak_planks'],
      }),
    );
    assert.deepEqual(model.size, { x: 2, y: 1, z: 3 });
    assert.equal(model.voxelCount, 6);
    assert.equal(model.solidCount, 2);
    // ZYX：(0,0,0) -> 0，(1,0,2) -> 1*(1*3) + 0*3 + 2 = 5
    assert.deepEqual([...model.solidPositions], [0, 5]);
    assert.deepEqual([...model.paletteIndices], [0, 1]);
    assert.equal(model.indexBits, 8);
  });

  it('位置下标与坐标互算符合 ZYX 口径', () => {
    const model = decodeRenderPayload(solidCube(3));
    assert.deepEqual(indexToPosition(model.size, 0), [0, 0, 0]);
    // 位置下标 13 = x*(3*3) + y*3 + z = 1*9 + 1*3 + 1
    assert.deepEqual(indexToPosition(model.size, 13), [1, 1, 1]);
    assert.equal(model.solidCount, 27);
  });

  it('16 位下标的小端解码', () => {
    const palette = Array.from({ length: 300 }, (_, i) => `minecraft:block_${i}`);
    const model = decodeRenderPayload(
      encodeGrid({ size: [2, 1, 1], at: (x) => (x === 1 ? 299 : 5), palette }),
    );
    assert.equal(model.indexBits, 16);
    assert.deepEqual([...model.paletteIndices], [5, 299]);
  });

  it('未知版本明确拒绝，而不是凑合着画', () => {
    const payload = { ...solidCube(1), version: 2 };
    assert.throws(() => decodeRenderPayload(payload), VoxelPayloadError);
    assert.throws(() => decodeRenderPayload(payload), /版本/);
  });

  it('载荷自相矛盾时报错：size 乘积与 voxel_count 不符', () => {
    const payload = { ...solidCube(2), voxel_count: 99 };
    assert.throws(() => decodeRenderPayload(payload), /自相矛盾/);
  });

  it('载荷自相矛盾时报错：位图长度不对', () => {
    const payload = { ...solidCube(4), occupancy: Buffer.alloc(1).toString('base64') };
    assert.throws(() => decodeRenderPayload(payload), /占用位图长度不对/);
  });

  it('载荷自相矛盾时报错：下标数组长度不对', () => {
    const payload = { ...solidCube(2), indices: Buffer.alloc(1).toString('base64') };
    assert.throws(() => decodeRenderPayload(payload), /下标数组长度不对/);
  });

  it('载荷自相矛盾时报错：solid_count 与位图不符', () => {
    const payload = { ...solidCube(2), solid_count: 7 };
    assert.throws(() => decodeRenderPayload(payload), VoxelPayloadError);
  });

  it('引用了不存在的调色板下标时报错', () => {
    const payload = encodeGrid({
      size: [1, 1, 1],
      at: () => 0,
      palette: ['minecraft:stone'],
    });
    // 调色板砍到 0 项：下标 0 就越界了
    const broken = { ...payload, palette: [] };
    assert.throws(() => decodeRenderPayload(broken), /调色板是空的/);
  });

  it('index_bits 只能是 8 或 16', () => {
    const payload = { ...solidCube(1), index_bits: 12 };
    assert.throws(() => decodeRenderPayload(payload), /index_bits/);
  });
});

// ---------------------------------------------------------------- 外壳

describe('buildShell', () => {
  it('单个方块六个面全暴露', () => {
    const model = decodeRenderPayload(
      encodeGrid({ size: [3, 3, 3], at: (x, y, z) => (x === 1 && y === 1 && z === 1 ? 0 : null), palette: ['minecraft:stone'] }),
    );
    const shell = buildShell(model);
    assert.equal(shell.count, 1);
    assert.equal(shell.faceMask[0], 0b111111);
    assert.equal(shell.hidden, 0);
  });

  it('实心立方体只留外表面：内部方块被剔除', () => {
    const model = decodeRenderPayload(solidCube(5)); // 125 格
    const shell = buildShell(model);
    // 5³ 实心：可见的只有最外一层壳 = 125 - 27 = 98
    assert.equal(shell.count, 98);
    assert.equal(shell.hidden, 27);

    // 角上的方块暴露 3 个面，面心暴露 1 个面，棱上暴露 2 个面
    const faceCounts = new Map<number, number>();
    for (let i = 0; i < shell.count; i += 1) {
      const bits = shell.faceMask[i].toString(2).replace(/0/g, '').length;
      faceCounts.set(bits, (faceCounts.get(bits) ?? 0) + 1);
    }
    assert.equal(faceCounts.get(3), 8, '八个角各暴露 3 个面');
    assert.equal(faceCounts.get(2), 36, '12 条棱 × 3 个中间方块');
    assert.equal(faceCounts.get(1), 54, '六个面 × 3×3 个面心');
  });

  it('平板：面心只有上下两个面，边缘方块额外露出侧面', () => {
    const model = decodeRenderPayload(
      encodeGrid({ size: [4, 1, 4], at: () => 0, palette: ['minecraft:stone'] }),
    );
    const shell = buildShell(model);
    assert.equal(shell.count, 16);
    let totalFaces = 0;
    for (let i = 0; i < shell.count; i += 1) {
      const bits = shell.faceMask[i];
      // 上下两面一定露出来
      assert.ok((bits >> 2) & 1, '+Y 应暴露');
      assert.ok((bits >> 3) & 1, '-Y 应暴露');
      // 4×4 平板内部没有方块，所以不会有格子被包住
      assert.ok(bits !== 0);
      totalFaces += bits.toString(2).replace(/0/g, '').length;
    }
    // 上下 16×2 = 32 个面；侧边一圈 12 格：4 个角各 2 面 + 8 个边格各 1 面 = 16
    assert.equal(totalFaces, 32 + 16);
    assert.equal(shell.hidden, 0);
  });

  it('分层显示会重新计算遮挡：切掉顶层后下面那层的顶面露出来', () => {
    const model = decodeRenderPayload(solidCube(3));
    const all = buildShell(model);
    const cut = buildShell(model, { maxY: 1 });

    assert.equal(cut.count, 9, '只留下 y=0 的一层');
    assert.equal(cut.totalSolid, 27);
    for (let i = 0; i < cut.count; i += 1) {
      const bits = cut.faceMask[i];
      assert.ok((bits >> 2) & 1, '顶面必须暴露，否则剖面是空心的');
      assert.ok((bits >> 3) & 1, '底面仍然暴露');
    }
    assert.ok(cut.count < all.count);
  });

  it('空格子不参与，调色板下标与坐标一一对齐', () => {
    const model = decodeRenderPayload(
      encodeGrid({
        size: [3, 1, 1],
        // 只有中间一格是 1 号方块，其余空
        at: (x) => (x === 1 ? 1 : null),
        palette: ['minecraft:stone', 'minecraft:gold_block'],
      }),
    );
    const shell = buildShell(model);
    assert.equal(shell.count, 1);
    assert.equal(shell.px[0], 1);
    assert.equal(shell.py[0], 0);
    assert.equal(shell.pz[0], 0);
    assert.equal(shell.paletteIndices[0], 1);
  });
});

// ---------------------------------------------------------------- 相机

describe('viewBasis / visibleFaceMask', () => {
  it('三个基向量两两正交且都是单位长度', () => {
    for (const [yaw, pitch] of [[0, 0], [0.7, 0.4], [-2.1, -1.2], [3.0, 0.9]]) {
      const { right, up, fwd } = viewBasis(yaw, pitch);
      const dot = (a: typeof right, b: typeof right): number => a.x * b.x + a.y * b.y + a.z * b.z;
      const len = (v: typeof right): number => Math.sqrt(dot(v, v));
      for (const v of [right, up, fwd]) assert.ok(Math.abs(len(v) - 1) < 1e-9);
      for (const [a, b] of [[right, up], [right, fwd], [up, fwd]]) {
        assert.ok(Math.abs(dot(a, b)) < 1e-9);
      }
    }
  });

  it('俯仰角为正时视线朝下（从上方看）', () => {
    const { fwd } = viewBasis(0, 0.6);
    assert.ok(fwd.y < 0);
  });

  it('方位角 0、俯仰 0 时看到的是 +Z 面', () => {
    const mask = visibleFaceMask(viewBasis(0, 0));
    assert.equal(mask, 1 << 4);
  });

  it('俯视时看到 +Y 面', () => {
    const mask = visibleFaceMask(viewBasis(0, 1.2));
    assert.ok((mask >> 2) & 1, '+Y 可见');
    assert.ok((mask >> 4) & 1, '+Z 仍然可见');
  });

  it('每个视角最多看到 3 个面', () => {
    for (let i = 0; i < 24; i += 1) {
      const mask = visibleFaceMask(viewBasis((i / 24) * Math.PI * 2, (i % 5) * 0.3 - 0.6));
      const count = mask.toString(2).replace(/0/g, '').length;
      assert.ok(count >= 1 && count <= 3, `方向数应在 1~3，实际 ${count}`);
    }
  });
});

// ---------------------------------------------------------------- 规划

describe('planFrame', () => {
  it('绘制顺序是远到近', () => {
    const model = decodeRenderPayload(solidCube(4));
    const shell = buildShell(model);
    const basis = viewBasis(0, 0);
    const plan = planFrame(shell, basis);

    // 方位角 0、俯仰 0 时视线朝 -Z：z 越大越近
    const { fwd } = basis;
    const depthOf = (i: number): number =>
      shell.px[i] * fwd.x + shell.py[i] * fwd.y + shell.pz[i] * fwd.z;
    for (let n = 1; n < plan.order.length; n += 1) {
      assert.ok(
        depthOf(plan.order[n - 1]) >= depthOf(plan.order[n]) - 1e-6,
        `第 ${n} 个元素的深度比前一个更远`,
      );
    }
    // 第一个应该是 z 最小（最远）的一批
    assert.equal(shell.pz[plan.order[0]], 0);
    assert.equal(shell.pz[plan.order[plan.order.length - 1]], 3);
  });

  it('包围盒包含方块自身体积（不是只包住基准点）', () => {
    const model = decodeRenderPayload(
      encodeGrid({ size: [2, 2, 2], at: (x, y, z) => (x === 0 && y === 0 && z === 0 ? 0 : null), palette: ['minecraft:stone'] }),
    );
    const shell = buildShell(model);
    const plan = planFrame(shell, viewBasis(0, 0));
    // 方位角 0 俯仰 0：屏幕 x = x、屏幕 y = -y；一个方块占 1×1，所以两个方向都正好 1
    assert.ok(Math.abs(plan.bounds.maxY - plan.bounds.minY - 1) < 1e-6);
    assert.ok(Math.abs(plan.bounds.maxX - plan.bounds.minX - 1) < 1e-6);
  });

  it('空外壳不报错：没有绘制顺序', () => {
    const model = decodeRenderPayload(
      encodeGrid({ size: [2, 2, 2], at: () => null, palette: ['minecraft:stone'] }),
    );
    const shell = buildShell(model);
    assert.equal(shell.count, 0);
    const plan = planFrame(shell, viewBasis(0.3, 0.4));
    assert.equal(plan.order.length, 0);
    assert.ok(Number.isFinite(plan.bounds.minX));
    assert.ok(Number.isFinite(plan.bounds.maxY));
  });
});

describe('fitView', () => {
  it('把结构居中并填满可用区域', () => {
    const bounds = { minX: -5, minY: -10, maxX: 5, maxY: 10 };
    const view = fitView(bounds, { width: 400, height: 400 }, 1, 20);
    // 高度方向更紧，所以 scale 由高度决定：(400-40)/20 = 18
    assert.ok(Math.abs(view.scale - 18) < 1e-9);
    // 中心 (0,0) 映射到画布中心
    assert.ok(Math.abs(view.offsetX - 200) < 1e-9);
    assert.ok(Math.abs(view.offsetY - 200) < 1e-9);
  });

  it('zoom 成比例放大', () => {
    const bounds = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    const base = fitView(bounds, { width: 300, height: 300 }, 1, 20);
    const zoomed = fitView(bounds, { width: 300, height: 300 }, 2, 20);
    assert.ok(Math.abs(zoomed.scale - base.scale * 2) < 1e-9);
  });
});

// ---------------------------------------------------------------- 颜色

describe('blockColor', () => {
  it('精确表命中常见建材且标记为已知', () => {
    const stone = blockColor('minecraft:stone');
    assert.equal(stone.known, true);
    assert.deepEqual([stone.r, stone.g, stone.b], [125, 125, 125]);
    assert.equal(blockColor('stone').known, true, '没有命名空间也要命中');
  });

  it('染色家族：羊毛 / 混凝土 / 陶瓦按颜色词取色', () => {
    const red = blockColor('minecraft:red_wool');
    const blue = blockColor('minecraft:blue_wool');
    assert.ok(red.r > red.b, '红色羊毛红色分量更高');
    assert.ok(blue.b > blue.r, '蓝色羊毛蓝色分量更高');
    assert.equal(red.known, true);
    assert.equal(blockColor('minecraft:lime_concrete').known, true);
    assert.equal(blockColor('minecraft:black_terracotta').known, true);
  });

  it('木材家族覆盖楼梯/台阶/木板/原木', () => {
    const planks = blockColor('minecraft:oak_planks');
    const stairs = blockColor('minecraft:oak_stairs');
    const log = blockColor('minecraft:oak_log');
    assert.deepEqual([planks.r, planks.g, planks.b], [stairs.r, stairs.g, stairs.b]);
    assert.deepEqual([planks.r, planks.g, planks.b], [log.r, log.g, log.b]);
    assert.equal(planks.known, true);
    assert.notDeepEqual(
      [planks.r, planks.g, planks.b],
      [blockColor('minecraft:spruce_planks').r, blockColor('minecraft:spruce_planks').g, blockColor('minecraft:spruce_planks').b],
      '不同木材要能区分开',
    );
  });

  it('树叶比同种木材更绿', () => {
    const leaves = blockColor('minecraft:oak_leaves');
    const planks = blockColor('minecraft:oak_planks');
    assert.ok(leaves.g - leaves.r > planks.g - planks.r);
  });

  it('未收录的方块给稳定示意色并标记 known=false', () => {
    const a = blockColor('minecraft:some_modded_block');
    const b = blockColor('minecraft:some_modded_block');
    const c = blockColor('minecraft:another_modded_block');
    assert.equal(a.known, false);
    assert.deepEqual([a.r, a.g, a.b], [b.r, b.g, b.b], '同一个名字永远同一个颜色');
    assert.notDeepEqual([a.r, a.g, a.b], [c.r, c.g, c.b]);
  });

  it('展示名去掉命名空间前缀', () => {
    assert.equal(displayBlockName('minecraft:oak_stairs'), 'oak_stairs');
    assert.equal(displayBlockName('oak_stairs'), 'oak_stairs');
  });
});

// ---------------------------------------------------------------- 展示层

describe('present', () => {
  it('formatRatio 处理极小值与零', () => {
    assert.equal(formatRatio(0), '0%');
    assert.equal(formatRatio(1), '100.0%');
    assert.equal(formatRatio(0.5), '50.0%');
    assert.equal(formatRatio(0.000001), '<0.01%');
  });

  it('formatStates 稳定排序并统一成 key=value', () => {
    assert.equal(formatStates({}), '—');
    assert.equal(
      formatStates({ upside_down_bit: 1, weirdo_direction: 'north' }),
      'upside_down_bit=1 weirdo_direction=north',
    );
    assert.equal(formatStates({ open_bit: true }), 'open_bit=1');
  });

  it('sortMaterials 两种口径都稳定', () => {
    const rows = [
      { index: 0, name: 'minecraft:stone', states: {}, count: 3, ratio: 0.3 },
      { index: 1, name: 'minecraft:air', states: {}, count: 5, ratio: 0.5 },
      { index: 2, name: 'minecraft:brick', states: {}, count: 2, ratio: 0.2 },
    ];
    assert.deepEqual(
      sortMaterials(rows, 'count').map((r) => r.name),
      ['minecraft:air', 'minecraft:stone', 'minecraft:brick'],
    );
    assert.deepEqual(
      sortMaterials(rows, 'name').map((r) => r.name),
      ['minecraft:air', 'minecraft:brick', 'minecraft:stone'],
    );
    // 不改原数组
    assert.equal(rows[0].name, 'minecraft:stone');
  });

  it('materialTotals 汇总种类与总数', () => {
    const totals = materialTotals({
      materials: [
        { index: 0, name: 'a', states: {}, count: 3, ratio: 0.6 },
        { index: 1, name: 'b', states: {}, count: 2, ratio: 0.4 },
      ],
      materials_total: 2,
      materials_truncated: false,
    } as never);
    assert.deepEqual(totals, { kinds: 2, blocks: 5, truncated: false });
  });

  it('relativeTime 分档给出人话', () => {
    const now = new Date('2026-09-16T12:00:00Z');
    assert.equal(relativeTime('2026-09-16T11:59:40Z', now), '刚刚');
    assert.equal(relativeTime('2026-09-16T11:30:00Z', now), '30 分钟前');
    assert.equal(relativeTime('2026-09-16T06:00:00Z', now), '6 小时前');
    assert.equal(relativeTime('2026-09-13T12:00:00Z', now), '3 天前');
    assert.equal(relativeTime('2026-01-02T12:00:00Z', now), '2026-01-02');
  });
});

// ---------------------------------------------------------------- 封面

describe('封面展示', () => {
  const cover = (width: number, height: number): never =>
    ({ width, height } as never);

  it('尺寸文案把比例化简成最简整数比', () => {
    assert.equal(coverSizeText(cover(1280, 720)), '1,280 × 720（16:9）');
    assert.equal(coverSizeText(cover(1920, 1080)), '1,920 × 1,080（16:9）');
    assert.equal(coverSizeText(cover(800, 600)), '800 × 600（4:3）');
    // 互质的一对：最大公约数是 1，比例就是它自己
    assert.equal(coverSizeText(cover(7, 5)), '7 × 5（7:5）');
    assert.equal(coverSizeText(cover(100, 100)), '100 × 100（1:1）');
  });

  it('接近 16:9 时不提醒裁切', () => {
    assert.equal(coverCropHint(cover(1280, 720)), null);
    // 1.6 与 16:9(1.778) 差 0.18，落在容差内
    assert.equal(coverCropHint(cover(1600, 1000)), null);
    assert.equal(coverCropHint(cover(2560, 1440)), null);
  });

  it('太宽或太高时分别给出对应的提醒', () => {
    const wide = coverCropHint(cover(2400, 600)); // 4:1
    assert.ok(wide && wide.includes('左右'));
    const tall = coverCropHint(cover(600, 1200)); // 1:2
    assert.ok(tall && tall.includes('上下'));
  });

  it('高度为 0 的畸形数据不炸，也不给建议', () => {
    assert.equal(coverCropHint(cover(100, 0)), null);
  });

  it('类型标签覆盖四种受支持格式，未知的照原样回显', () => {
    assert.equal(coverFormatLabel('image/png'), 'PNG');
    assert.equal(coverFormatLabel('image/jpeg'), 'JPEG');
    assert.equal(coverFormatLabel('image/gif'), 'GIF');
    assert.equal(coverFormatLabel('image/webp'), 'WebP');
    assert.equal(coverFormatLabel('image/avif'), 'image/avif');
  });
});
