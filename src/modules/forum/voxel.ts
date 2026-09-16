/**
 * 轻量 3D 体素渲染核心 —— 纯计算，不碰 DOM、不发请求。
 *
 * ## 它解决的问题
 *
 * 论坛帖子要把别人上传的结构在网页上画出来。做法有两条路：
 *
 * - 引一个 WebGL 体素引擎（three.js 之类）：几百 KB 的依赖，为了看一眼房子
 *   不值得，而且「轻量化」是明确要求。
 * - **自己算**：结构本来就是规整的立方体网格，用 Canvas 2D + 画家算法
 *   就能画得很像样。整个实现只有一个文件，没有依赖。
 *
 * 这里选后者。分成三段，每段都是纯函数，可以脱离浏览器测试：
 *
 * 1. `decodeRenderPayload` —— 把后端那份「占用位图 + 调色板下标」解回网格；
 * 2. `buildShell` —— 剔除被邻居挡住的内部面（画不出来的面根本不进绘制列表）；
 * 3. `planFrame` —— 给定相机角度，算出绘制顺序与屏幕坐标。
 *
 * ## 几个必须说清楚的近似
 *
 * - **画家算法按方块中心的深度排序**。对规整网格上的等大立方体，这个顺序就是
 *   正确的遮挡顺序（这也是体素渲染器的常规做法）。它依赖「所有方块都是 1×1×1
 *   且轴对齐」，本项目的结构文件正好如此。
 * - **颜色是示意色**，不是游戏贴图。见 `block-colors.ts` 的说明。
 * - **只画外表面**：内部的方块与面永远看不到，画了纯属浪费。
 */

/** 面方向：0 +X / 1 -X / 2 +Y / 3 -Y / 4 +Z / 5 -Z。 */
export const FACE_PX = 0;
export const FACE_NX = 1;
export const FACE_PY = 2;
export const FACE_NY = 3;
export const FACE_PZ = 4;
export const FACE_NZ = 5;
export const FACE_COUNT = 6;

/**
 * 每个面的 4 个角（单位立方体的角偏移）。
 * 只用于画填充多边形，不描边，所以顶点的绕向不影响结果。
 */
const FACE_CORNERS: ReadonlyArray<ReadonlyArray<readonly [number, number, number]>> = [
  // +X
  [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]],
  // -X
  [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]],
  // +Y
  [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]],
  // -Y
  [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
  // +Z
  [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
  // -Z
  [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]],
];

/**
 * 每个面的明暗系数。没有光照模型，用固定的方向明暗来区分面：
 * 顶面最亮、底面最暗，四个侧面按常见光向（右上打光）拉开层次。
 * 这是像素游戏里的老办法，便宜且一眼能看出体积感。
 */
const FACE_SHADE = [0.86, 0.7, 1.0, 0.52, 0.92, 0.74];

/** 8 个立方体角的偏移（与 FACE_CORNERS 共用同一组坐标，去重后只剩 8 个）。 */
const CUBE_CORNERS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
  [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
];

/** 后端 `/structure/render` 的响应（字段名与 pydantic 契约一致）。 */
export interface RenderPayloadJson {
  version: number;
  size: { x: number; y: number; z: number };
  voxel_count: number;
  solid_count: number;
  index_bits: number;
  palette: string[];
  occupancy: string;
  indices: string;
  note?: string | null;
}

export interface VoxelModel {
  size: { x: number; y: number; z: number };
  voxelCount: number;
  solidCount: number;
  /** 调色板：下标 -> 方块名（如 minecraft:stone） */
  palette: string[];
  /** 占用位图，第 i 格有方块 ⟺ occupancy[i>>3] >> (i&7) & 1 */
  occupancy: Uint8Array;
  /** 每个非空格子的调色板下标，与 solidPositions 一一对应 */
  paletteIndices: Uint8Array | Uint16Array;
  /** 非空格子的位置下标，升序 */
  solidPositions: Int32Array;
  indexBits: number;
  note: string | null;
}

export class VoxelPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoxelPayloadError';
  }
}

/**
 * base64 -> 字节。浏览器的 `atob` 在 Node 里没有，所以两处都要能跑
 * （渲染核心要能在 `npm test` 里直接测）。
 */
function decodeBase64(text: string): Uint8Array {
  const globalAtob = (globalThis as { atob?: (input: string) => string }).atob;
  if (typeof globalAtob === 'function') {
    const binary = globalAtob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  // Node 路径。Buffer 在浏览器打包里不存在，所以只在没有 atob 时才走这里
  const nodeBuffer = (globalThis as unknown as {
    Buffer?: { from(input: string, encoding: string): Uint8Array };
  }).Buffer;
  if (nodeBuffer) return new Uint8Array(nodeBuffer.from(text, 'base64'));
  throw new VoxelPayloadError('当前环境既没有 atob 也没有 Buffer，无法解码 base64');
}

/**
 * 解析渲染载荷。
 *
 * 校验的是**协议能不能用**，不是「数据可不可信」——载荷来自本站后端，
 * 不是用户直接构造的。但版本不认识时必须明确拒绝，而不是凑合着画：
 * 画错了比画不出来更糟，用户没法判断是自己看错了还是数据坏了。
 */
export function decodeRenderPayload(payload: RenderPayloadJson): VoxelModel {
  if (payload.version !== 1) {
    throw new VoxelPayloadError(
      `预览数据格式版本是 ${payload.version}，这个页面只认识版本 1，请刷新后再试`,
    );
  }
  const { x: sx, y: sy, z: sz } = payload.size;
  if (sx <= 0 || sy <= 0 || sz <= 0) {
    throw new VoxelPayloadError(`结构尺寸不合法：${sx} × ${sy} × ${sz}`);
  }
  const voxelCount = sx * sy * sz;
  if (payload.voxel_count !== voxelCount) {
    throw new VoxelPayloadError(
      `载荷自相矛盾：size 乘积是 ${voxelCount}，voxel_count 写的是 ${payload.voxel_count}`,
    );
  }
  if (payload.index_bits !== 8 && payload.index_bits !== 16) {
    throw new VoxelPayloadError(`index_bits 只能是 8 或 16，收到 ${payload.index_bits}`);
  }
  if (payload.palette.length === 0) {
    throw new VoxelPayloadError('调色板是空的，没有可渲染的方块');
  }

  const occupancy = decodeBase64(payload.occupancy);
  const expectedBytes = Math.ceil(voxelCount / 8);
  if (occupancy.length !== expectedBytes) {
    throw new VoxelPayloadError(
      `占用位图长度不对：应该是 ${expectedBytes} 字节，收到 ${occupancy.length} 字节`,
    );
  }

  const raw = decodeBase64(payload.indices);
  const step = payload.index_bits / 8;
  if (raw.length !== payload.solid_count * step) {
    throw new VoxelPayloadError(
      `下标数组长度不对：应该是 ${payload.solid_count * step} 字节，收到 ${raw.length} 字节`,
    );
  }

  const paletteIndices =
    payload.index_bits === 8 ? new Uint8Array(payload.solid_count) : new Uint16Array(payload.solid_count);
  const solidPositions = new Int32Array(payload.solid_count);

  let cursor = 0;
  for (let byte = 0; byte < occupancy.length; byte += 1) {
    const bits = occupancy[byte];
    if (bits === 0) continue;
    for (let bit = 0; bit < 8; bit += 1) {
      if (!((bits >> bit) & 1)) continue;
      const position = byte * 8 + bit;
      if (position >= voxelCount) break;
      if (cursor >= payload.solid_count) {
        throw new VoxelPayloadError('下标数组比占用位图短，载荷不完整');
      }
      const value =
        step === 1
          ? raw[cursor]
          : raw[cursor * 2] | (raw[cursor * 2 + 1] << 8);
      if (value >= payload.palette.length) {
        throw new VoxelPayloadError(
          `第 ${cursor} 个方块引用了不存在的调色板下标 ${value}（调色板只有 ${payload.palette.length} 项）`,
        );
      }
      paletteIndices[cursor] = value;
      solidPositions[cursor] = position;
      cursor += 1;
    }
  }
  if (cursor !== payload.solid_count) {
    throw new VoxelPayloadError(
      `占用位图里有 ${cursor} 个方块，solid_count 写的是 ${payload.solid_count}`,
    );
  }

  return {
    size: { x: sx, y: sy, z: sz },
    voxelCount,
    solidCount: payload.solid_count,
    palette: payload.palette,
    occupancy,
    paletteIndices,
    solidPositions,
    indexBits: payload.index_bits,
    note: payload.note ?? null,
  };
}

/** 位置下标 -> 坐标。ZYX 顺序，与后端 `/position` 用同一公式。 */
export function indexToPosition(
  size: { x: number; y: number; z: number },
  index: number,
): [number, number, number] {
  const plane = size.y * size.z;
  return [Math.floor(index / plane), Math.floor((index % plane) / size.z), index % size.z];
}

export function isSolid(model: VoxelModel, index: number): boolean {
  return ((model.occupancy[index >> 3] >> (index & 7)) & 1) === 1;
}

// ---------------------------------------------------------------- 外壳

export interface ShellOptions {
  /**
   * 只显示 y < maxY 的方块（分层查看）。传 `undefined` 表示全部显示。
   *
   * 分层会影响遮挡计算：切掉顶层之后，下面那一层的顶面就露出来了，
   * 所以这个参数**必须参与面剔除**，不能只在绘制时过滤——只在绘制时过滤
   * 会切出一个空壳，看不见剖面。
   */
  maxY?: number;
}

export interface VoxelShell {
  /** 参与绘制的方块数（已经过内外面剔除与尺寸过滤） */
  count: number;
  /** 模型里方块的原始总数（用于如实显示「显示了多少 / 共多少」） */
  totalSolid: number;
  /** 每个可绘制方块的坐标 */
  px: Int16Array;
  py: Int16Array;
  pz: Int16Array;
  /** 每个方块的调色板下标 */
  paletteIndices: Uint8Array | Uint16Array;
  /** 每个方块**暴露在外**的面（6 位掩码；0 表示被完全包住，画不出来） */
  faceMask: Uint8Array;
  /** 被剔除的方块数（被完全包住的＋被 maxY 挡住的） */
  hidden: number;
}

/**
 * 建立可绘制的「外壳」：只留下至少有一个面暴露在外的方块。
 *
 * 这一步是性能的关键。一个实心 32×32×32 的房子有 32768 个方块、6 万个面，
 * 但真正能看到的只有外表面那几千个；内部方块画了也是立刻被覆盖，
 * 在 Canvas 2D 上那是纯粹的开销。挖空之后绘制量通常降到 1/5 ~ 1/20。
 */
export function buildShell(model: VoxelModel, options: ShellOptions = {}): VoxelShell {
  const { x: sx, y: sy, z: sz } = model.size;
  const plane = sy * sz;
  const maxY = options.maxY ?? sy;
  const solid = model.solidPositions;
  const total = model.solidCount;

  const px = new Int16Array(total);
  const py = new Int16Array(total);
  const pz = new Int16Array(total);
  const mask = new Uint8Array(total);
  const kept =
    model.indexBits === 8 ? new Uint8Array(total) : new Uint16Array(total);

  // 在「考虑 maxY」之后仍然算实心的格子才算挡得住邻居。
  // 切掉顶层之后下面那层的顶面要露出来，所以 maxY 必须参与面剔除。
  const inRange = (x: number, y: number, z: number): boolean =>
    x >= 0 && x < sx && y >= 0 && y < maxY && z >= 0 && z < sz;

  let count = 0;
  for (let i = 0; i < total; i += 1) {
    const index = solid[i];
    const [x, y, z] = indexToPosition(model.size, index);
    if (y >= maxY) continue;

    let faces = 0;
    if (!inRange(x + 1, y, z) || !isSolid(model, index + plane)) faces |= 1 << FACE_PX;
    if (!inRange(x - 1, y, z) || !isSolid(model, index - plane)) faces |= 1 << FACE_NX;
    if (!inRange(x, y + 1, z) || !isSolid(model, index + sz)) faces |= 1 << FACE_PY;
    if (!inRange(x, y - 1, z) || !isSolid(model, index - sz)) faces |= 1 << FACE_NY;
    if (!inRange(x, y, z + 1) || !isSolid(model, index + 1)) faces |= 1 << FACE_PZ;
    if (!inRange(x, y, z - 1) || !isSolid(model, index - 1)) faces |= 1 << FACE_NZ;

    if (faces === 0) continue; // 六面都被包住：永远看不到，画了也是白画
    px[count] = x;
    py[count] = y;
    pz[count] = z;
    mask[count] = faces;
    kept[count] = model.paletteIndices[i];
    count += 1;
  }

  return {
    count,
    totalSolid: total,
    px: px.subarray(0, count),
    py: py.subarray(0, count),
    pz: pz.subarray(0, count),
    paletteIndices: kept.subarray(0, count),
    faceMask: mask.subarray(0, count),
    hidden: total - count,
  };
}

// ---------------------------------------------------------------- 相机

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface ViewBasis {
  right: Vec3;
  up: Vec3;
  /** 视线方向（从相机指向场景内部）。depth = 点积(p, fwd)，越大越远。 */
  fwd: Vec3;
}

/**
 * 由方位角与俯仰角算出正交相机的三个基向量。
 *
 * 用正交投影而不是透视：体素建筑是给人「看结构」的，正交投影不产生近大远小，
 * 每一层网格都一样大，比透视更容易看懂形状；像素风的观感也更对。
 *
 * @param yaw 方位角（弧度），0 表示从 +Z 方向看
 * @param pitch 俯仰角（弧度），正数是从上往下看
 */
export function viewBasis(yaw: number, pitch: number): ViewBasis {
  const ca = Math.cos(yaw);
  const sa = Math.sin(yaw);
  const ce = Math.cos(pitch);
  const se = Math.sin(pitch);
  return {
    right: { x: ca, y: 0, z: -sa },
    // up = right × fwd，这样俯视时「远处」在屏幕上方，符合直觉
    up: { x: -sa * se, y: ce, z: -ca * se },
    fwd: { x: -sa * ce, y: -se, z: -ca * ce },
  };
}

/** 本帧朝向相机的面掩码。面的可见性只看 fwd 各分量的符号，不必逐面做点积。 */
export function visibleFaceMask(basis: ViewBasis): number {
  const { fwd } = basis;
  let mask = 0;
  if (fwd.x < 0) mask |= 1 << FACE_PX;
  if (fwd.x > 0) mask |= 1 << FACE_NX;
  if (fwd.y < 0) mask |= 1 << FACE_PY;
  if (fwd.y > 0) mask |= 1 << FACE_NY;
  if (fwd.z < 0) mask |= 1 << FACE_PZ;
  if (fwd.z > 0) mask |= 1 << FACE_NZ;
  return mask;
}

export interface FramePlan {
  /** 绘制顺序（远 -> 近）在 shell 里的下标 */
  order: Uint32Array;
  /** 每个方块基准点（最小角）的屏幕坐标；未缩放、未平移 */
  screenX: Float32Array;
  screenY: Float32Array;
  /** 8 个单位立方体角相对基准点的屏幕偏移（交替 x/y） */
  cornerX: Float32Array;
  cornerY: Float32Array;
  /** 本帧朝向相机的面掩码 */
  visibleFaces: number;
  /** 屏幕包围盒（含方块自身的体积），用于自适应缩放 */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

/**
 * 规划一帧：排序 + 投影。
 *
 * 屏幕坐标不算缩放与平移，留给视图层按画布尺寸统一处理——这样窗口尺寸变化
 * 不需要重算投影，旋转时也不必关心画布多大，两边都好测。
 */
export function planFrame(shell: VoxelShell, basis: ViewBasis): FramePlan {
  const { count } = shell;
  const depth = new Float32Array(count);
  const screenX = new Float32Array(count);
  const screenY = new Float32Array(count);
  const order = new Uint32Array(count);

  const { right, up, fwd } = basis;
  for (let i = 0; i < count; i += 1) {
    const x = shell.px[i];
    const y = shell.py[i];
    const z = shell.pz[i];
    depth[i] = x * fwd.x + y * fwd.y + z * fwd.z;
    screenX[i] = x * right.x + y * right.y + z * right.z;
    screenY[i] = -(x * up.x + y * up.y + z * up.z);
    order[i] = i;
  }

  // 远 -> 近。等大轴对齐立方体的中心深度序就是正确的遮挡序（见文件头说明）。
  order.sort((a, b) => depth[b] - depth[a]);

  // 立方体 8 个角的屏幕偏移：投影是线性的，角坐标 = 基准点 + 单位角偏移的投影，
  // 所以每个角只需要在绘制时做两次加法，不必再乘一遍矩阵
  const cornerX = new Float32Array(CUBE_CORNERS.length);
  const cornerY = new Float32Array(CUBE_CORNERS.length);
  let minDx = 0;
  let maxDx = 0;
  let minDy = 0;
  let maxDy = 0;
  CUBE_CORNERS.forEach(([cx, cy, cz], i) => {
    const ox = cx * right.x + cy * right.y + cz * right.z;
    const oy = -(cx * up.x + cy * up.y + cz * up.z);
    cornerX[i] = ox;
    cornerY[i] = oy;
    if (ox < minDx) minDx = ox;
    if (ox > maxDx) maxDx = ox;
    if (oy < minDy) minDy = oy;
    if (oy > maxDy) maxDy = oy;
  });

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < count; i += 1) {
    if (screenX[i] < minX) minX = screenX[i];
    if (screenX[i] > maxX) maxX = screenX[i];
    if (screenY[i] < minY) minY = screenY[i];
    if (screenY[i] > maxY) maxY = screenY[i];
  }
  if (count === 0) {
    minX = minY = maxX = maxY = 0;
  }

  return {
    order,
    screenX,
    screenY,
    cornerX,
    cornerY,
    visibleFaces: visibleFaceMask(basis),
    bounds: {
      minX: minX + minDx,
      minY: minY + minDy,
      maxX: maxX + maxDx,
      maxY: maxY + maxDy,
    },
  };
}

/**
 * 算出自适应缩放与平移：把整卷结构摆进画布中央。
 *
 * 传入的是上一帧 `planFrame` 的包围盒；`zoom` 是用户滚轮给的倍率（1 = 刚好装下）。
 */
export function fitView(
  bounds: FramePlan['bounds'],
  viewport: { width: number; height: number },
  zoom: number,
  padding = 24,
): { scale: number; offsetX: number; offsetY: number } {
  const spanX = Math.max(bounds.maxX - bounds.minX, 1e-6);
  const spanY = Math.max(bounds.maxY - bounds.minY, 1e-6);
  const usableW = Math.max(viewport.width - padding * 2, 1);
  const usableH = Math.max(viewport.height - padding * 2, 1);
  const scale = Math.min(usableW / spanX, usableH / spanY) * zoom;
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  return {
    scale,
    offsetX: viewport.width / 2 - centerX * scale,
    offsetY: viewport.height / 2 - centerY * scale,
  };
}

/** 面的明暗系数；导出给渲染循环用，避免那份常量在别处被抄一遍。 */
export function faceShade(face: number): number {
  return FACE_SHADE[face];
}

export function faceCorners(face: number): ReadonlyArray<readonly [number, number, number]> {
  return FACE_CORNERS[face];
}

/** 单位立方体 8 个角在 CUBE_CORNERS 里的下标：绘制时要把角坐标映射回偏移表。 */
const CORNER_INDEX = new Map<string, number>(
  CUBE_CORNERS.map((corner, index) => [corner.join(','), index]),
);

export function cornerIndex(corner: readonly [number, number, number]): number {
  const found = CORNER_INDEX.get(corner.join(','));
  if (found === undefined) throw new Error(`不是立方体的角：${corner.join(',')}`);
  return found;
}

/** 把方块颜色按面的明暗压暗/提亮，返回 CSS 颜色串。 */
export function shadedCss(
  color: { r: number; g: number; b: number },
  face: number,
): string {
  const shade = FACE_SHADE[face];
  const r = Math.min(255, Math.round(color.r * shade));
  const g = Math.min(255, Math.round(color.g * shade));
  const b = Math.min(255, Math.round(color.b * shade));
  return `rgb(${r}, ${g}, ${b})`;
}
