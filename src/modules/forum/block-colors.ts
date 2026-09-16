/**
 * 方块 → 示意色（纯函数，不碰 DOM）。
 *
 * ## 为什么是一张表而不是材质贴图
 *
 * 真实的方块外观来自游戏里的 16×16 贴图集，那属于 Mojang 的美术资源，不能打包
 * 进站点；而「轻量化」的要求也排除了引入几百 KB 的贴图图集。所以这里给每个
 * 方块一个**示意色**，让预览能看清结构轮廓与材质分区——它的用途是「看出这是个
 * 什么形状、哪一块用了什么料」，不是「还原游戏画面」。界面必须把这一点说清楚，
 * 不能让人以为看到的就是游戏里的样子。
 *
 * ## 三层取值
 *
 * 1. **精确表** `EXACT`：常见建材的固定取值，颜色是按游戏观感挑的。
 * 2. **家族规则** `RULES`：`*_wool`、`*_planks`、`*_ore` 这类带颜色词/材质词的
 *    命名，Bedrock 的方块名有很强的规律，一条规则能覆盖上百个方块。
 * 3. **兜底**：都没命中时由方块名散列出一个稳定的色相。**同样的方块名永远得到
 *    同样的颜色**，但会标记 `known: false`，界面据此提示「这是示意色」。
 *
 * 三层都返回 `known`，不做「看起来像真的」的伪装。
 */

export interface BlockColor {
  /** 0-255 */
  r: number;
  g: number;
  b: number;
  /** 是否来自精确表/家族规则；false 表示是按名字生成的示意色 */
  known: boolean;
}

/** 精确表：`minecraft:` 前缀已去掉。取值按游戏观感挑选，不追求逐像素一致。 */
const EXACT: Record<string, [number, number, number]> = {
  air: [0, 0, 0],
  stone: [125, 125, 125],
  cobblestone: [122, 122, 122],
  mossy_cobblestone: [105, 121, 90],
  smooth_stone: [158, 158, 158],
  stone_bricks: [122, 122, 122],
  mossy_stone_bricks: [105, 121, 90],
  cracked_stone_bricks: [118, 118, 118],
  chiseled_stone_bricks: [118, 118, 118],
  granite: [149, 103, 85],
  polished_granite: [153, 108, 90],
  diorite: [200, 200, 200],
  polished_diorite: [200, 200, 200],
  andesite: [136, 136, 136],
  polished_andesite: [132, 132, 132],
  deepslate: [80, 80, 84],
  cobbled_deepslate: [77, 77, 80],
  polished_deepslate: [72, 72, 75],
  deepslate_bricks: [70, 70, 73],
  deepslate_tiles: [54, 54, 56],
  tuff: [108, 109, 102],
  calcite: [223, 224, 220],
  dripstone_block: [134, 108, 92],
  bedrock: [85, 85, 85],
  obsidian: [20, 18, 29],
  crying_obsidian: [32, 17, 51],
  netherrack: [97, 38, 38],
  soul_sand: [81, 62, 50],
  soul_soil: [75, 57, 46],
  basalt: [72, 72, 78],
  blackstone: [42, 35, 40],
  end_stone: [219, 222, 158],
  purpur_block: [169, 125, 169],
  prismarine: [99, 156, 151],
  dark_prismarine: [51, 91, 75],
  sea_lantern: [172, 199, 190],
  glowstone: [171, 131, 84],
  shroomlight: [240, 146, 70],
  magma: [142, 63, 31],
  honey_block: [251, 185, 58],
  slime: [111, 192, 91],
  snow: [249, 254, 254],
  snow_layer: [249, 254, 254],
  ice: [145, 183, 253],
  packed_ice: [141, 180, 250],
  blue_ice: [116, 167, 253],
  frosted_ice: [140, 180, 250],
  clay: [160, 166, 179],
  sand: [219, 207, 163],
  red_sand: [190, 102, 33],
  gravel: [131, 127, 126],
  dirt: [134, 96, 67],
  coarse_dirt: [119, 85, 59],
  rooted_dirt: [144, 103, 76],
  grass_block: [124, 189, 107],
  grass_path: [148, 121, 65],
  dirt_path: [148, 121, 65],
  podzol: [91, 65, 24],
  mycelium: [111, 99, 105],
  farmland: [150, 108, 67],
  mud: [60, 57, 60],
  packed_mud: [142, 106, 79],
  mud_bricks: [137, 103, 78],
  sandstone: [216, 203, 155],
  smooth_sandstone: [216, 203, 155],
  chiseled_sandstone: [216, 203, 155],
  cut_sandstone: [218, 205, 158],
  red_sandstone: [181, 97, 31],
  quartz_block: [235, 229, 222],
  smooth_quartz: [235, 229, 222],
  chiseled_quartz_block: [232, 226, 218],
  quartz_bricks: [234, 229, 221],
  bricks: [150, 97, 83],
  nether_bricks: [44, 22, 26],
  red_nether_bricks: [69, 7, 10],
  prismarine_bricks: [99, 171, 158],
  mud_brick: [137, 103, 78],
  polished_blackstone: [53, 48, 56],
  polished_blackstone_bricks: [48, 43, 51],
  gilded_blackstone: [55, 42, 39],
  water: [52, 91, 200],
  flowing_water: [52, 91, 200],
  lava: [207, 92, 23],
  flowing_lava: [207, 92, 23],
  glass: [200, 226, 232],
  glass_pane: [200, 226, 232],
  tinted_glass: [44, 40, 51],
  hay_block: [166, 138, 26],
  bookshelf: [146, 118, 76],
  crafting_table: [124, 88, 56],
  furnace: [110, 110, 110],
  chest: [140, 106, 55],
  barrel: [124, 96, 56],
  tnt: [219, 68, 52],
  sponge: [196, 213, 70],
  cake: [240, 236, 232],
  lantern: [120, 106, 84],
  soul_lantern: [80, 148, 154],
  sea_pickle: [94, 120, 60],
  cobweb: [226, 232, 232],
  iron_bars: [120, 120, 120],
  iron_block: [219, 219, 219],
  gold_block: [246, 208, 61],
  diamond_block: [97, 219, 213],
  emerald_block: [42, 203, 86],
  lapis_block: [30, 67, 140],
  redstone_block: [175, 24, 5],
  coal_block: [16, 15, 15],
  netherite_block: [67, 61, 63],
  copper_block: [192, 107, 79],
  oxidized_copper: [82, 161, 129],
  weathered_copper: [108, 153, 110],
  exposed_copper: [161, 125, 103],
  cut_copper: [191, 106, 80],
  amethyst_block: [133, 97, 191],
  beacon: [116, 221, 215],
  conduit: [104, 118, 129],
  bell: [246, 202, 71],
  anvil: [72, 72, 72],
  cauldron: [72, 72, 72],
  composter: [124, 96, 56],
  lectern: [160, 130, 84],
  smithing_table: [60, 66, 74],
  stonecutter: [124, 124, 124],
  loom: [150, 130, 96],
  cartography_table: [124, 96, 56],
  fletching_table: [200, 180, 120],
  grindstone: [130, 130, 130],
  blast_furnace: [90, 90, 92],
  smoker: [104, 92, 72],
  campfire: [150, 110, 60],
  soul_campfire: [70, 130, 136],
  torch: [252, 216, 132],
  wall_torch: [252, 216, 132],
  end_rod: [233, 230, 214],
  dragon_egg: [12, 9, 15],
  spawner: [24, 33, 44],
  monster_spawner: [24, 33, 44],
  enchanting_table: [128, 60, 74],
  end_portal_frame: [94, 124, 106],
  nether_portal: [88, 20, 138],
  end_portal: [10, 6, 20],
  bamboo: [124, 165, 60],
  scaffolding: [196, 172, 100],
  ladder: [150, 118, 72],
  rail: [140, 130, 110],
  ladder_crossing: [150, 118, 72],
  tuff_bricks: [104, 105, 98],
  chiseled_tuff: [110, 111, 104],
  copper_grate: [166, 108, 84],
};

/** 16 种染色名 → 颜色（Bedrock 的羊毛/混凝土/陶瓦/玻璃都按这套词命名）。 */
const DYES: Record<string, [number, number, number]> = {
  white: [233, 236, 236],
  light_gray: [142, 142, 134],
  gray: [62, 68, 71],
  black: [29, 29, 33],
  brown: [114, 71, 40],
  red: [176, 46, 38],
  orange: [240, 118, 19],
  yellow: [248, 198, 39],
  lime: [112, 185, 25],
  green: [93, 124, 21],
  cyan: [21, 137, 145],
  light_blue: [58, 175, 217],
  blue: [60, 68, 170],
  purple: [137, 50, 184],
  magenta: [189, 68, 179],
  pink: [237, 141, 172],
};

/** 木材名 → 颜色（原木 / 木板 / 楼梯 / 台阶 / 栅栏 / 门 共用）。 */
const WOODS: Record<string, [number, number, number]> = {
  oak: [162, 130, 78],
  spruce: [114, 84, 48],
  birch: [215, 205, 165],
  jungle: [160, 115, 80],
  acacia: [186, 100, 52],
  dark_oak: [66, 43, 20],
  mangrove: [117, 54, 48],
  cherry: [225, 200, 199],
  pale_oak: [222, 210, 178],
  bamboo: [193, 176, 90],
  crimson: [101, 48, 70],
  warped: [43, 104, 99],
};

/** 矿物名 → 颜色。 */
const ORES: Record<string, [number, number, number]> = {
  coal: [40, 40, 40],
  iron: [196, 165, 140],
  copper: [196, 116, 84],
  gold: [248, 216, 90],
  redstone: [170, 30, 20],
  lapis: [40, 70, 160],
  diamond: [110, 225, 220],
  emerald: [60, 200, 100],
  quartz: [235, 229, 222],
  nether_gold: [140, 70, 40],
  ancient_debris: [90, 70, 66],
};

/** 形状后缀：剥掉它们之后再去查木材/颜色，能覆盖楼梯、台阶、栅栏等等。 */
const SHAPE_SUFFIXES = [
  '_stairs',
  '_slab',
  '_wall',
  '_fence_gate',
  '_fence',
  '_door',
  '_trapdoor',
  '_button',
  '_pressure_plate',
  '_sign',
  '_hanging_sign',
  '_boat',
  '_planks',
  '_log',
  '_wood',
  '_hyphae',
  '_stem',
  '_leaves',
];

function stripNamespace(name: string): string {
  const colon = name.indexOf(':');
  return (colon >= 0 ? name.slice(colon + 1) : name).toLowerCase();
}

function dyeFamily(key: string): [number, number, number] | null {
  for (const [dye, rgb] of Object.entries(DYES)) {
    if (
      key === dye ||
      key.startsWith(`${dye}_`) ||
      key.endsWith(`_${dye}`)
    ) {
      return rgb;
    }
  }
  return null;
}

function woodFamily(key: string): [number, number, number] | null {
  for (const [wood, rgb] of Object.entries(WOODS)) {
    if (key === wood || key.startsWith(`${wood}_`) || key.endsWith(`_${wood}`)) {
      return rgb;
    }
  }
  return null;
}

/** 按名字散列出稳定的色相（同一名字永远同一颜色，但明显是「生成」的）。 */
function hashedColor(key: string): [number, number, number] {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const hue = (hash >>> 0) % 360;
  // 饱和度与明度固定在中段：保证任何色相都能看清轮廓，也不会亮得发白
  return hslToRgb(hue / 360, 0.38, 0.55);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h * 6) % 2) - 1));
  const m = l - c / 2;
  const sector = Math.floor(h * 6) % 6;
  const [r, g, b] =
    sector === 0
      ? [c, x, 0]
      : sector === 1
        ? [x, c, 0]
        : sector === 2
          ? [0, c, x]
          : sector === 3
            ? [0, x, c]
            : sector === 4
              ? [x, 0, c]
              : [c, 0, x];
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

/**
 * 解析一个方块的示意色。
 *
 * `states` 目前没有参与取色：Bedrock 的方块状态里确实有些能改颜色（例如
 * 告示牌的 `color`、潜影盒的朝向），但那是少数；引入之前先把主力路径做对，
 * 免得为了边缘情况把规则写得没人看得懂。函数签名留了参数，加的时候不必改调用点。
 */
export function blockColor(name: string, states?: Record<string, unknown>): BlockColor {
  void states;
  const key = stripNamespace(name);

  const exact = EXACT[key];
  if (exact) return toColor(exact, true);

  // 染色家族：羊毛 / 混凝土 / 陶瓦 / 玻璃 / 床 / 旗帜 / 蜡烛 …
  // 先剥形状后缀，`red_wool_slab` 这类少见命名也能命中
  let base = key;
  for (const suffix of SHAPE_SUFFIXES) {
    if (base.endsWith(suffix)) {
      base = base.slice(0, -suffix.length);
      break;
    }
  }

  const dye = dyeFamily(base) ?? dyeFamily(key);
  if (dye) {
    // 陶瓦/混凝土比羊毛暗一档，用乘法压一下，避免整屏一样亮
    if (key.includes('terracotta') || key.includes('concrete')) {
      return toColor([dye[0] * 0.92, dye[1] * 0.9, dye[2] * 0.88], true);
    }
    return toColor(dye, true);
  }

  if (key.includes('leaves') || key.includes('leaf')) {
    const wood = woodFamily(base) ?? woodFamily(key) ?? [90, 140, 60];
    // 树叶在游戏里普遍比木材绿一些
    return toColor([wood[0] * 0.55 + 30, wood[1] * 0.75 + 60, wood[2] * 0.4 + 20], true);
  }

  if (key.includes('ore')) {
    for (const [metal, rgb] of Object.entries(ORES)) {
      if (key.includes(metal)) {
        // 矿石 = 石头底 + 矿物色，取个中间值
        return toColor([(rgb[0] + 125) / 2, (rgb[1] + 125) / 2, (rgb[2] + 125) / 2], true);
      }
    }
  }

  if (key.includes('glass') || key.includes('pane')) {
    return toColor([200, 226, 232], true);
  }
  if (key.includes('water')) return toColor([52, 91, 200], true);
  if (key.includes('lava')) return toColor([207, 92, 23], true);
  if (key.includes('planks') || key.includes('log') || key.includes('wood')) {
    const wood = woodFamily(base) ?? woodFamily(key);
    if (wood) return toColor(wood, true);
  }
  if (key.includes('brick')) return toColor([150, 97, 83], true);
  if (key.includes('sand')) return toColor([219, 207, 163], true);
  if (key.includes('stone') || key.includes('rock')) return toColor([125, 125, 125], true);
  if (key.includes('dirt') || key.includes('soil')) return toColor([134, 96, 67], true);
  if (key.includes('copper')) return toColor([192, 107, 79], true);
  if (key.includes('concrete')) return toColor([180, 180, 180], true);
  if (key.includes('wool') || key.includes('carpet')) return toColor([233, 236, 236], true);

  const wood = woodFamily(key);
  if (wood) return toColor(wood, true);

  return toColor(hashedColor(key), false);
}

function toColor(rgb: [number, number, number], known: boolean): BlockColor {
  return {
    r: clamp255(rgb[0]),
    g: clamp255(rgb[1]),
    b: clamp255(rgb[2]),
    known,
  };
}

function clamp255(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/** CSS 颜色串，用于材料清单的色块。 */
export function cssColor(color: BlockColor): string {
  return `rgb(${color.r}, ${color.g}, ${color.b})`;
}

/**
 * 方块名 → 展示名。Bedrock 的标识是 `minecraft:oak_stairs` 这种，
 * 界面上不翻译成中文（翻译表会立刻过期，而且社区里大家本来就说英文 ID），
 * 只把命名空间前缀去掉，避免每行都重复 `minecraft:`。
 */
export function displayBlockName(name: string): string {
  return stripNamespace(name);
}
