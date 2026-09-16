/**
 * 论坛展示层格式化：纯函数，不碰 DOM、不发请求，便于单独测试。
 * 与 `modules/mcstructure/present.ts` 同口径（工具引擎那一套约定）。
 */
import type { MaterialEntry, ThreadCover, ThreadStructure } from './api';

/** 相对时间文案。超过 30 天就直接给日期，免得读者还要自己算「几个月前」是几号。 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return iso;
  const diffMs = now.getTime() - then.getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${then.getFullYear()}-${pad(then.getMonth() + 1)}-${pad(then.getDate())}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatCount(value: number): string {
  return value.toLocaleString('zh-CN');
}

/** 0.1234 -> "12.3%"。材料清单里比例比小数好读。 */
export function formatRatio(ratio: number): string {
  if (ratio <= 0) return '0%';
  if (ratio < 0.0001) return '<0.01%';
  return `${(ratio * 100).toFixed(ratio < 0.01 ? 2 : 1)}%`;
}

/**
 * 方块状态的紧凑文案。
 *
 * Bedrock 的状态名本来就短（`facing_direction`、`open_bit`），直接
 * `key=value` 连起来最省地方，也不引入一层需要维护的翻译表。
 * 值类型随状态而变（字符串/整数/字节），这里统一成字符串展示。
 */
export function formatStates(states: Record<string, unknown>): string {
  const keys = Object.keys(states);
  if (keys.length === 0) return '—';
  return keys
    .sort()
    .map((key) => `${key}=${stringifyState(states[key])}`)
    .join(' ');
}

function stringifyState(value: unknown): string {
  if (value === null || value === undefined) return '?';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** 材料清单的合计行。 */
export interface MaterialTotals {
  kinds: number;
  blocks: number;
  /** 清单是否被后端截断（只保留了数量最多的若干条） */
  truncated: boolean;
}

export function materialTotals(structure: ThreadStructure): MaterialTotals {
  return {
    kinds: structure.materials_total,
    blocks: structure.materials.reduce((sum, row) => sum + row.count, 0),
    truncated: structure.materials_truncated,
  };
}

/** 结构摘要面板要用的一行行键值对。 */
export function structureFacts(structure: ThreadStructure): Array<[string, string]> {
  const size = structure.size;
  const facts: Array<[string, string]> = [
    ['尺寸', `${size.x} × ${size.y} × ${size.z}`],
    ['容量', `${formatCount(structure.voxel_count)} 格`],
    ['实心方块', `${formatCount(structure.solid_cells)} 个`],
    ['文件大小', formatBytes(structure.byte_size)],
  ];
  if (structure.layer_count > 1) {
    facts.push(['层数', `${structure.layer_count} 层（含共位层）`]);
  }
  if (structure.coincident_cells > 0) {
    facts.push(['共位格', `${formatCount(structure.coincident_cells)} 格（两层各一块）`]);
  }
  if (structure.block_entities > 0) {
    facts.push(['方块实体', `${formatCount(structure.block_entities)} 个`]);
  }
  if (structure.entities > 0) {
    facts.push(['实体', `${formatCount(structure.entities)} 个`]);
  }
  if (structure.world_origin) {
    const [x, y, z] = structure.world_origin;
    facts.push(['世界原点', `X ${x} / Y ${y} / Z ${z}`]);
  }
  facts.push(['压缩', compressionText(structure.compression)]);
  return facts;
}

export function compressionText(compression: string | null | undefined): string {
  if (compression === 'gzip') return 'gzip';
  if (compression === 'zlib') return 'zlib';
  return '未压缩';
}

/**
 * 需要提醒用户的地方。
 *
 * 这个功能最容易让人误解的两件事是「为什么有方块没画出来」和
 * 「颜色为什么和游戏里不一样」，所以都在这里明说，不做静默处理。
 */
export function structureWarnings(structure: ThreadStructure): string[] {
  const warnings: string[] = [];
  if (structure.out_of_range_indices > 0) {
    warnings.push(
      `有 ${formatCount(structure.out_of_range_indices)} 个方块索引超出调色板范围，` +
        '游戏加载时会当成空气（这里如实计数，没有替你改写）。',
    );
  }
  if (structure.air_blocks > 0) {
    warnings.push(
      `文件里有 ${formatCount(structure.air_blocks)} 个空气方块（占 ${formatCount(structure.air_cells)} 格），` +
        '已经从材料清单里剔除，也不会出现在 3D 预览里。',
    );
  }
  if (structure.materials.some((row) => row.name.includes(':')) === false && structure.materials.length) {
    // 全部没有命名空间：不是错误，但说明这份文件可能来自第三方工具
    warnings.push('这份文件的方块名没有 minecraft: 前缀，可能由第三方工具生成。');
  }
  if (structure.extra_root_fields.length > 0) {
    warnings.push(
      `文件里还有本站未建模的根字段：${structure.extra_root_fields.join('、')}（已原样保留，不做解释）。`,
    );
  }
  if (!structure.render.available && structure.render.reason) {
    warnings.push(structure.render.reason);
  }
  return warnings;
}

/** 材料清单排序切换用：按数量（默认）或按方块名。 */
export function sortMaterials(
  materials: MaterialEntry[],
  mode: 'count' | 'name',
): MaterialEntry[] {
  const rows = [...materials];
  if (mode === 'name') rows.sort((a, b) => a.name.localeCompare(b.name));
  else rows.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return rows;
}

// ---------------------------------------------------------------- 封面

/**
 * 封面尺寸文案，例如 `1280 × 720（16:9）`。
 *
 * 比例用最大公约数化简：1280×720 写成「16:9」比「1.78」直观得多，
 * 人一眼就能判断这张图在列表里会不会太高。
 */
export function coverSizeText(cover: ThreadCover): string {
  const { width, height } = cover;
  const divisor = greatestCommonDivisor(width, height);
  const ratio = divisor > 0 ? `${width / divisor}:${height / divisor}` : '—';
  return `${formatCount(width)} × ${formatCount(height)}（${ratio}）`;
}

function greatestCommonDivisor(a: number, b: number): number {
  let x = Math.abs(Math.trunc(a));
  let y = Math.abs(Math.trunc(b));
  while (y) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x;
}

/**
 * 封面比例与列表缩略图（16:9）差得太远时给出的提示。
 *
 * 列表缩略图按 16:9 裁切，比例差太远的封面会被裁掉一大块；提前说一声，
 * 发帖的人就知道自己在列表里大概会看到什么，而不是发布之后才发现构图没了。
 */
export function coverCropHint(cover: ThreadCover): string | null {
  if (!cover.height) return null;
  const ratio = cover.width / cover.height;
  const target = 16 / 9;
  if (Math.abs(ratio - target) < 0.3) return null;
  if (ratio > target) return '这张图比 16:9 更宽，列表缩略图会裁掉左右两侧。';
  return '这张图比 16:9 更高，列表缩略图会裁掉上下部分。';
}

/** 图片类型 → 展示名，用于「识别出来的格式是 …」这类提示。 */
export function coverFormatLabel(contentType: string): string {
  switch (contentType) {
    case 'image/png':
      return 'PNG';
    case 'image/jpeg':
      return 'JPEG';
    case 'image/gif':
      return 'GIF';
    case 'image/webp':
      return 'WebP';
    default:
      return contentType;
  }
}
