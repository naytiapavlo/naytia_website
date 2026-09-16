/**
 * .mcstructure 语义层：解析、编辑、序列化 —— 纯逻辑，不碰 DOM、不发请求。
 *
 * 设计要点：**保留原始 NBT 树作为唯一数据来源**。
 * - 解析时把关注的部分做成视图（尺寸、调色板、方块索引），供界面快速读写；
 * - 写回时改的是那棵原始树，而不是「重新拼一个文件」。
 *
 * 这样做的原因：真实文件的字段比文档列的多（block_position_data 里可能有
 * tick_queue_data、未知实体字段等），一旦「重新拼」就会静默丢字段。
 * 保留原树 = 只改用户真正改过的地方，其余字节原样写回。
 *
 * 与后端 Python 实现的关系：同一份 bedrock.dev 格式口径，两侧独立测试，
 * 用同一份真实文件夹具交叉验证（见 ADR-003）。规则改动要同时改两边。
 */
import {
  DEFAULT_LIMITS,
  NbtFormatError,
  TAG,
  type Compression,
  type NbtCompound,
  type NbtLimits,
  type NbtValue,
  compoundTag,
  getCompound,
  getInt,
  getList,
  getString,
  intTag,
  readNbtFile,
  stringTag,
  toPlain,
  writeNbtFile,
} from './nbt';

/** 当前实现版本：算法/格式语义变化时递增（03 文档第 7 节）。 */
export const IMPLEMENTATION_VERSION = '1.0.0';
/** 输入协议版本：结构状态形状变化时递增。 */
export const INPUT_SCHEMA_VERSION = 1;
export const RULESET_ID = 'mcstructure-v1';

/** 结构空位（void）：该格没有方块。
 *  文档：下标 -1 表示 void，加载时保留原有方块。 */
export const VOID = -1;

/** 次层（共位层）最常见的用途是水下的水；主层为 0。 */
export const LAYER_PRIMARY = 0;
export const LAYER_SECONDARY = 1;

const ROOT_ORIGIN_KEY = 'structure_world_origin';

export interface BlockState {
  name: string;
  /** 方块状态。值类型随状态而定（字符串 / 整数 / 字节） */
  states: NbtCompound;
  version?: number;
}

export interface StructureSize {
  x: number;
  y: number;
  z: number;
}

/** 结构原点取自哪里：'root' = 根层级（真实文件），'structure' = structure 内部（文档口径）。 */
export type OriginPlacement = 'root' | 'structure';

export interface McStructureState {
  /** 原始 NBT 树——序列化时的唯一来源，保证不丢字段 */
  root: NbtCompound;
  formatVersion: number | undefined;
  size: StructureSize;
  voxelCount: number;
  /** layers[层][位置下标] = 调色板下标（VOID 表示空位） */
  layers: number[][];
  /** block_indices 在 NBT 里的顺序号定位，写回时用 */
  palette: BlockState[];
  /** 方块实体/位置数据：键是位置下标的字符串 */
  positionData: Map<string, NbtCompound>;
  entities: NbtValue[];
  worldOrigin: [number, number, number] | undefined;
  originPlacement: OriginPlacement | undefined;
  compression: Compression;
  /** 未建模的根字段名（保留但不解释） */
  extraRootFields: string[];
  /** 文件原名，下载时沿用 */
  fileName: string;
}

export class McStructureError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------- 读写辅助

function requireCompound(root: NbtCompound, key: string, path: string): NbtCompound {
  const found = getCompound(root, key);
  if (!found) throw new McStructureError('invalid_structure', `${path} 应该是复合标签（compound）`);
  return found;
}

function requireInt(value: number | undefined, path: string): number {
  if (value === undefined) throw new McStructureError('invalid_structure', `${path} 应该是整数`);
  return value;
}

function requireIntTriple(value: NbtValue[] | undefined, path: string): [number, number, number] {
  if (!value || value.length !== 3) {
    throw new McStructureError('invalid_structure', `${path} 应该有 3 个整数`);
  }
  const numbers = value.map((item) => (item.type === TAG.Int ? item.value : undefined));
  if (numbers.some((n) => n === undefined)) {
    throw new McStructureError('invalid_structure', `${path} 的元素应该都是整数`);
  }
  return [numbers[0]!, numbers[1]!, numbers[2]!];
}

/** 位置下标 -> (x, y, z)。按文档的 ZYX 顺序：先 X，再 Y，最后 Z。 */
export function indexToPosition(size: StructureSize, index: number): [number, number, number] {
  const plane = size.y * size.z;
  return [Math.floor(index / plane), Math.floor((index % plane) / size.z), index % size.z];
}

/** (x, y, z) -> 位置下标。与后端 /position 用同一公式。 */
export function positionToIndex(size: StructureSize, x: number, y: number, z: number): number {
  return x * (size.y * size.z) + y * size.z + z;
}

// ---------------------------------------------------------------- 解析

export async function parseStructure(
  bytes: Uint8Array,
  fileName = 'structure.mcstructure',
  limits: NbtLimits = DEFAULT_LIMITS,
): Promise<McStructureState> {
  let root: NbtCompound;
  let compression: Compression;
  try {
    const result = await readNbtFile(bytes, limits);
    root = result.root;
    compression = result.compression;
  } catch (error) {
    if (error instanceof Error && error.name.startsWith('Nbt')) {
      throw new McStructureError('invalid_structure', error.message);
    }
    throw error;
  }

  const formatVersion = getInt(root, 'format_version');

  const sizeValues = getList(root, 'size');
  if (!sizeValues) throw new McStructureError('invalid_structure', '缺少必需字段 size');
  const [sx, sy, sz] = requireIntTriple(sizeValues, 'size');
  if (sx <= 0 || sy <= 0 || sz <= 0) {
    throw new McStructureError('invalid_structure', `size 必须为正数，实际 [${sx}, ${sy}, ${sz}]`);
  }

  const voxelCount = sx * sy * sz;
  if (voxelCount > limits.maxArrayLength) {
    throw new McStructureError(
      'structure_too_large',
      `结构体积 ${sx}×${sy}×${sz} = ${voxelCount} 格，超过上限 ${limits.maxArrayLength}`,
    );
  }
  const size: StructureSize = { x: sx, y: sy, z: sz };

  const structure = requireCompound(root, 'structure', 'structure');

  // ---- 结构原点：真实文件在根层级，文档写在 structure 内部（两处都认）
  let worldOrigin: [number, number, number] | undefined;
  let originPlacement: OriginPlacement | undefined;
  if (root.has(ROOT_ORIGIN_KEY)) {
    worldOrigin = requireIntTriple(getList(root, ROOT_ORIGIN_KEY), ROOT_ORIGIN_KEY);
    originPlacement = 'root';
  } else if (structure.has(ROOT_ORIGIN_KEY)) {
    worldOrigin = requireIntTriple(
      getList(structure, ROOT_ORIGIN_KEY),
      `structure.${ROOT_ORIGIN_KEY}`,
    );
    originPlacement = 'structure';
  }

  // ---- 调色板
  const paletteWrapper = requireCompound(structure, 'palette', 'palette');
  if (!paletteWrapper.has('default')) {
    throw new McStructureError(
      'invalid_structure',
      'palette 里缺少 default（游戏加载时不会放置任何方块）',
    );
  }
  const defaultPalette = requireCompound(paletteWrapper, 'default', 'palette.default');

  const rawPalette = getList(defaultPalette, 'block_palette') ?? [];
  const palette: BlockState[] = rawPalette.map((entry, i) => {
    if (entry.type !== TAG.Compound) {
      throw new McStructureError('invalid_structure', `block_palette[${i}] 应该是复合标签`);
    }
    const name = getString(entry.value, 'name');
    if (name === undefined) {
      throw new McStructureError('invalid_structure', `block_palette[${i}].name 缺失`);
    }
    return {
      name,
      states: getCompound(entry.value, 'states') ?? new Map(),
      version: getInt(entry.value, 'version'),
    };
  });

  // ---- 方块索引（两层）
  const rawIndices = getList(structure, 'block_indices');
  if (!rawIndices) {
    throw new McStructureError('invalid_structure', '缺少 block_indices 或它不是列表');
  }
  if (rawIndices.length !== 2) {
    throw new McStructureError(
      'invalid_structure',
      `block_indices 应该恰好有 2 个子列表（主层/次层），实际 ${rawIndices.length} 个`,
    );
  }
  const layers: number[][] = rawIndices.map((layer, layerNo) => {
    if (layer.type !== TAG.List) {
      throw new McStructureError('invalid_structure', `block_indices[${layerNo}] 应该是列表`);
    }
    if (layer.value.length !== voxelCount) {
      throw new McStructureError(
        'invalid_structure',
        `block_indices[${layerNo}] 有 ${layer.value.length} 项，应等于 size 的乘积 ${voxelCount}`,
      );
    }
    return layer.value.map((item) =>
      item.type === TAG.Int ? item.value : item.type === TAG.Byte || item.type === TAG.Short ? item.value : 0,
    );
  });

  // ---- 方块位置数据（方块实体）
  const positionData = new Map<string, NbtCompound>();
  const rawPositionData = getCompound(defaultPalette, 'block_position_data');
  if (rawPositionData) {
    for (const [key, value] of rawPositionData) {
      if (value.type !== TAG.Compound) {
        throw new McStructureError(
          'invalid_structure',
          `block_position_data["${key}"] 应该是复合标签`,
        );
      }
      positionData.set(key, value.value);
    }
  }

  const entities = getList(structure, 'entities') ?? [];
  const knownRoot = new Set(['format_version', 'size', 'structure', ROOT_ORIGIN_KEY]);
  const extraRootFields = [...root.keys()].filter((key) => !knownRoot.has(key));

  return {
    root,
    formatVersion,
    size,
    voxelCount,
    layers,
    palette,
    positionData,
    entities,
    worldOrigin,
    originPlacement,
    compression,
    extraRootFields,
    fileName,
  };
}

// ---------------------------------------------------------------- 序列化

/**
 * 把当前状态写回字节。
 *
 * 只改动「用户真正改过的地方」：
 * - 尺寸/索引/调色板数量都会重新写回 NBT；
 * - `block_position_data` 里没有方块实体的格子在编辑后会被清掉（原本就没有的不会被凭空造出来）；
 * - 其余未建模字段原样保留。
 */
export function serializeStructure(state: McStructureState): Uint8Array {
  const structure = requireCompound(state.root, 'structure', 'structure');
  const paletteWrapper = requireCompound(structure, 'palette', 'palette');
  const defaultPalette = requireCompound(paletteWrapper, 'default', 'palette.default');

  // 尺寸
  state.root.set('size', {
    type: TAG.List,
    elementType: TAG.Int,
    value: [intTag(state.size.x), intTag(state.size.y), intTag(state.size.z)],
  });
  if (state.formatVersion !== undefined) {
    state.root.set('format_version', intTag(state.formatVersion));
  }

  // 调色板
  defaultPalette.set('block_palette', {
    type: TAG.List,
    elementType: TAG.Compound,
    value: state.palette.map((block) =>
      compoundTag(
        new Map<string, NbtValue>([
          ['name', stringTag(block.name)],
          ['states', compoundTag(block.states)],
          ...(block.version !== undefined
            ? ([['version', intTag(block.version)]] as [string, NbtValue][])
            : []),
        ]),
      ),
    ),
  });

  // 方块索引
  structure.set('block_indices', {
    type: TAG.List,
    elementType: TAG.List,
    // 每个元素显式标注为 NbtValue：TAG.List 是对象属性访问，
    // 直接写会被推断成宽泛的 TagId，收窄不到「列表标签」这一支
    value: state.layers.map(
      (layer): NbtValue => ({
        type: TAG.List,
        elementType: TAG.Int,
        value: layer.map((index) => intTag(index)),
      }),
    ),
  });

  // 方块位置数据：按位置下标重排（键是字符串形式的下标）
  const positionDataCompound: NbtCompound = new Map();
  for (const key of [...state.positionData.keys()].sort((a, b) => Number(a) - Number(b))) {
    const entry = state.positionData.get(key)!;
    positionDataCompound.set(key, compoundTag(entry));
  }
  defaultPalette.set('block_position_data', compoundTag(positionDataCompound));

  // 结构原点：写回它原来在的位置，不擅自搬家
  if (state.worldOrigin) {
    const originTag: NbtValue = {
      type: TAG.List,
      elementType: TAG.Int,
      value: state.worldOrigin.map((n) => intTag(n)),
    };
    if (state.originPlacement === 'structure') {
      structure.set(ROOT_ORIGIN_KEY, originTag);
    } else {
      state.root.set(ROOT_ORIGIN_KEY, originTag);
    }
  }

  return writeNbtFile(state.root);
}

// ---------------------------------------------------------------- 编辑操作

export function paletteIndexAt(state: McStructureState, layer: number, index: number): number {
  return state.layers[layer]?.[index] ?? VOID;
}

/** 该格是否越界（下标超出调色板范围：游戏按空气处理）。 */
export function isOutOfRange(state: McStructureState, paletteIndex: number): boolean {
  return paletteIndex !== VOID && (paletteIndex < 0 || paletteIndex >= state.palette.length);
}

export interface EditResult {
  changed: number;
}

/** 设置某一格某一层的方块。paletteIndex 用 VOID 表示清空（结构空位）。 */
export function setBlock(
  state: McStructureState,
  layer: number,
  index: number,
  paletteIndex: number,
): EditResult {
  const target = state.layers[layer];
  if (!target) throw new McStructureError('bad_layer', `没有第 ${layer} 层`);
  if (index < 0 || index >= target.length) {
    throw new McStructureError('bad_index', `位置下标 ${index} 超出范围 0~${target.length - 1}`);
  }
  if (paletteIndex !== VOID && (paletteIndex < 0 || paletteIndex >= state.palette.length)) {
    throw new McStructureError('bad_palette', `调色板下标 ${paletteIndex} 超出范围`);
  }
  if (target[index] === paletteIndex) return { changed: 0 };
  target[index] = paletteIndex;
  // 改成 void 或换成别的方块后，原来的方块实体数据不再属于这一格
  if (paletteIndex === VOID) state.positionData.delete(String(index));
  return { changed: 1 };
}

/** 批量设置（用于填充、涂抹、整层替换）。positions 是位置下标集合。 */
export function setBlocks(
  state: McStructureState,
  layer: number,
  positions: Iterable<number>,
  paletteIndex: number,
): EditResult {
  let changed = 0;
  for (const index of positions) {
    changed += setBlock(state, layer, index, paletteIndex).changed;
  }
  return { changed };
}

/** 把某一层全部填成同一个方块（VOID = 清空整层）。 */
export function fillLayer(
  state: McStructureState,
  layer: number,
  paletteIndex: number,
): EditResult {
  const target = state.layers[layer];
  if (!target) throw new McStructureError('bad_layer', `没有第 ${layer} 层`);
  return setBlocks(state, layer, target.keys(), paletteIndex);
}

/**
 * 在调色板末尾新增一个方块排列，返回其下标。
 * 已存在完全相同的排列时直接复用（避免调色板里堆重复项）。
 */
export function addPaletteEntry(state: McStructureState, block: BlockState): number {
  const existing = state.palette.findIndex(
    (item) => item.name === block.name && sameStates(item.states, block.states),
  );
  if (existing >= 0) return existing;
  state.palette.push(block);
  return state.palette.length - 1;
}

/** 把某一层里所有 `from` 下标替换成 `to`。 */
export function replaceInLayer(
  state: McStructureState,
  layer: number,
  from: number,
  to: number,
): EditResult {
  const target = state.layers[layer];
  if (!target) throw new McStructureError('bad_layer', `没有第 ${layer} 层`);
  const positions: number[] = [];
  target.forEach((value, index) => {
    if (value === from) positions.push(index);
  });
  return setBlocks(state, layer, positions, to);
}

/** 全结构范围内把所有 `from` 下标替换成 `to`（两层都改）。 */
export function replaceEverywhere(
  state: McStructureState,
  from: number,
  to: number,
): EditResult {
  let changed = 0;
  for (let layer = 0; layer < state.layers.length; layer += 1) {
    changed += replaceInLayer(state, layer, from, to).changed;
  }
  return { changed };
}

function sameStates(a: NbtCompound, b: NbtCompound): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    const other = b.get(key);
    if (!other || other.type !== value.type) return false;
    if (other.type === TAG.Compound && value.type === TAG.Compound) {
      if (!sameStates(other.value, value.value)) return false;
    } else if (other.type === TAG.List && value.type === TAG.List) {
      if (JSON.stringify(toPlain(other)) !== JSON.stringify(toPlain(value))) return false;
    } else if (other.value !== value.value) {
      return false;
    }
  }
  return true;
}

/**
 * 编辑后同步方块实体的绝对坐标。
 *
 * 起因：真实文件里方块实体 NBT 的 x/y/z 是**绝对世界坐标**，等于
 * structure_world_origin 加上结构内坐标。移动过方块、或改了结构原点之后，
 * 这些坐标就不再自洽。这里按当前原点与位置下标重算，避免写出「坐标对不上」的文件。
 *
 * 注意层级：position_data 的一条是
 *   { block_entity_data: {...}, tick_queue_data: [...] }
 * x/y/z 在 **block_entity_data 里面**，不在外层（用真实文件核对过：
 * 外层只有 block_entity_data，tick_queue_data 可以缺省）。
 */
export function syncBlockEntityPositions(state: McStructureState): EditResult {
  if (!state.worldOrigin) return { changed: 0 };
  const [ox, oy, oz] = state.worldOrigin;
  let changed = 0;

  for (const [key, entry] of state.positionData) {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= state.voxelCount) continue;

    const nbt = getCompound(entry, 'block_entity_data');
    if (!nbt) continue;

    const [x, y, z] = indexToPosition(state.size, index);
    const want: Array<[string, number]> = [
      ['x', ox + x],
      ['y', oy + y],
      ['z', oz + z],
    ];
    for (const [field, value] of want) {
      // 只更新文件里本来就有这个字段的实体：没有就不要凭空造出来
      if (!nbt.has(field)) continue;
      if (getInt(nbt, field) !== value) {
        nbt.set(field, intTag(value));
        changed += 1;
      }
    }
  }
  return { changed };
}

// ---------------------------------------------------------------- 重新派生

/**
 * 改过 NBT 树之后，把派生视图（尺寸、层索引、调色板、方块实体）重算一遍。
 *
 * 为什么需要：直接编辑 NBT 树时，用户可能改了 `size`、`block_indices`、调色板
 * 任意一处。界面上的统计与下载都必须基于改后的树，否则会显示过时数据。
 * 本函数不重新解析文件，只从现有 root 重新读一遍——所以编辑的代价与文件大小无关。
 *
 * 用的是与 parseStructure 相同的校验；失败说明树已被改成不合法的结构，
 * 此时**不改动**现有派生视图，让调用方把错误报给用户。
 */
export function refreshDerived(state: McStructureState): void {
  const { root } = state;

  const sizeValues = getList(root, 'size');
  if (!sizeValues) throw new McStructureError('invalid_structure', 'size 缺失或不是列表');
  const [sx, sy, sz] = requireIntTriple(sizeValues, 'size');
  if (sx <= 0 || sy <= 0 || sz <= 0) {
    throw new McStructureError('invalid_structure', `size 必须为正数，实际 [${sx}, ${sy}, ${sz}]`);
  }
  const voxelCount = sx * sy * sz;

  const structure = requireCompound(root, 'structure', 'structure');
  const rawIndices = getList(structure, 'block_indices');
  if (!rawIndices || rawIndices.length !== 2) {
    throw new McStructureError('invalid_structure', 'block_indices 应该恰好有 2 个子列表');
  }
  const layers: number[][] = rawIndices.map((layer, layerNo) => {
    if (layer.type !== TAG.List) {
      throw new McStructureError('invalid_structure', `block_indices[${layerNo}] 不是列表`);
    }
    if (layer.value.length !== voxelCount) {
      throw new McStructureError(
        'invalid_structure',
        `block_indices[${layerNo}] 有 ${layer.value.length} 项，应等于 size 的乘积 ${voxelCount}。` +
          '改过 size 的话，索引数组也要跟着改。',
      );
    }
    return layer.value.map((item) =>
      item.type === TAG.Int || item.type === TAG.Byte || item.type === TAG.Short ? item.value : 0,
    );
  });

  const paletteWrapper = requireCompound(structure, 'palette', 'palette');
  const defaultPalette = requireCompound(paletteWrapper, 'default', 'palette.default');
  const rawPalette = getList(defaultPalette, 'block_palette') ?? [];
  const palette: BlockState[] = rawPalette.map((entry, i) => {
    if (entry.type !== TAG.Compound) {
      throw new McStructureError('invalid_structure', `block_palette[${i}] 不是复合体`);
    }
    const name = getString(entry.value, 'name');
    if (name === undefined) {
      throw new McStructureError('invalid_structure', `block_palette[${i}].name 缺失`);
    }
    return {
      name,
      states: getCompound(entry.value, 'states') ?? new Map(),
      version: getInt(entry.value, 'version'),
    };
  });

  const positionData = new Map<string, NbtCompound>();
  const rawPositionData = getCompound(defaultPalette, 'block_position_data');
  if (rawPositionData) {
    for (const [key, value] of rawPositionData) {
      if (value.type === TAG.Compound) positionData.set(key, value.value);
    }
  }

  // 结构原点（两处都可能写，与解析时一致）
  let worldOrigin: [number, number, number] | undefined;
  let originPlacement: OriginPlacement | undefined;
  if (root.has(ROOT_ORIGIN_KEY)) {
    worldOrigin = requireIntTriple(getList(root, ROOT_ORIGIN_KEY), ROOT_ORIGIN_KEY);
    originPlacement = 'root';
  } else if (structure.has(ROOT_ORIGIN_KEY)) {
    worldOrigin = requireIntTriple(
      getList(structure, ROOT_ORIGIN_KEY),
      `structure.${ROOT_ORIGIN_KEY}`,
    );
    originPlacement = 'structure';
  }

  const knownRoot = new Set(['format_version', 'size', 'structure', ROOT_ORIGIN_KEY]);

  state.size = { x: sx, y: sy, z: sz };
  state.voxelCount = voxelCount;
  state.layers = layers;
  state.palette = palette;
  state.positionData = positionData;
  state.entities = getList(structure, 'entities') ?? [];
  state.formatVersion = getInt(root, 'format_version');
  state.worldOrigin = worldOrigin;
  state.originPlacement = originPlacement;
  state.extraRootFields = [...root.keys()].filter((key) => !knownRoot.has(key));
}

// ---------------------------------------------------------------- 只读派生

export interface StructureSummary {
  size: StructureSize;
  voxelCount: number;
  layerCount: number;
  paletteUsed: number;
  /** 每层非 void 方块数 */
  filledPerLayer: number[];
  filled: number;
  voidSlots: number;
  blockEntities: number;
  entities: number;
  outOfRange: number;
  worldOrigin: [number, number, number] | undefined;
  originPlacement: OriginPlacement | undefined;
  compression: Compression;
  formatVersion: number | undefined;
  extraRootFields: string[];
  /** 按数量降序的方块统计 */
  counts: Array<{ paletteIndex: number; name: string; count: number; ratio: number }>;
}

export function summarize(state: McStructureState): StructureSummary {
  const countsByPalette = new Map<number, number>();
  const filledPerLayer: number[] = [];
  let outOfRange = 0;

  state.layers.forEach((layer) => {
    let filled = 0;
    for (const paletteIndex of layer) {
      if (paletteIndex === VOID) continue;
      if (paletteIndex < 0 || paletteIndex >= state.palette.length) {
        outOfRange += 1;
        continue;
      }
      filled += 1;
      countsByPalette.set(paletteIndex, (countsByPalette.get(paletteIndex) ?? 0) + 1);
    }
    filledPerLayer.push(filled);
  });

  const filled = [...countsByPalette.values()].reduce((a, b) => a + b, 0) + outOfRange;
  const counts = [...countsByPalette.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(([paletteIndex, count]) => ({
      paletteIndex,
      name: state.palette[paletteIndex]?.name ?? `(未知 #${paletteIndex})`,
      count,
      ratio: filled > 0 ? count / filled : 0,
    }));

  return {
    size: state.size,
    voxelCount: state.voxelCount,
    layerCount: state.layers.length,
    paletteUsed: countsByPalette.size,
    filledPerLayer,
    filled,
    voidSlots: state.voxelCount - (filledPerLayer[LAYER_PRIMARY] ?? 0),
    blockEntities: state.positionData.size,
    entities: state.entities.length,
    outOfRange,
    worldOrigin: state.worldOrigin,
    originPlacement: state.originPlacement,
    compression: state.compression,
    formatVersion: state.formatVersion,
    extraRootFields: state.extraRootFields,
    counts,
  };
}

// ---------------------------------------------------------------- 撤销

/**
 * 轻量快照式撤销：只存「会被编辑改动」的部分。
 * 结构可能上百万格，存整棵 NBT 树太贵，所以只快照 layers 与 positionData。
 */
export interface Snapshot {
  layers: number[][];
  positionData: Map<string, NbtCompound>;
  label: string;
}

export function snapshot(state: McStructureState, label: string): Snapshot {
  return {
    layers: state.layers.map((layer) => [...layer]),
    positionData: new Map([...state.positionData].map(([k, v]) => [k, v])),
    label,
  };
}

export function restore(state: McStructureState, snap: Snapshot): void {
  state.layers = snap.layers.map((layer) => [...layer]);
  state.positionData = new Map(snap.positionData);
}

export class UndoStack {
  private past: Snapshot[] = [];
  private future: Snapshot[] = [];
  private limit: number;

  constructor(limit = 50) {
    this.limit = limit;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  get undoLabel(): string | undefined {
    return this.past[this.past.length - 1]?.label;
  }

  get redoLabel(): string | undefined {
    return this.future[this.future.length - 1]?.label;
  }

  /** 在修改之前记录快照。 */
  record(state: McStructureState, label: string): void {
    this.past.push(snapshot(state, label));
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  undo(state: McStructureState): boolean {
    const snap = this.past.pop();
    if (!snap) return false;
    this.future.push(snapshot(state, snap.label));
    restore(state, snap);
    return true;
  }

  redo(state: McStructureState): boolean {
    const snap = this.future.pop();
    if (!snap) return false;
    this.past.push(snapshot(state, snap.label));
    restore(state, snap);
    return true;
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }
}
