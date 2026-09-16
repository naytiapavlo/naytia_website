/**
 * 作品页展示数据：封面滚动、研究时间轴、B 站视频成果清单。
 *
 * 与 `src/config/site.ts` 同一约定：**改内容只改这里，不动页面模板**。
 * 封面图放在 `public/works/showcase/`，路径以 `/` 开头（对外公开）。
 * 没有确切视频链接的条目留空 `videoUrl`，页面不会为它编造跳转地址
 * （04 文档第 2 节：引用目标必须真实可达）。
 */

/** 封面滚动区的一张作品封面 */
export interface ShowcaseItem {
  /** 封面图地址（public 下路径） */
  image: string;
  /** 封面上的作品名 */
  title: string;
  /** 一句话补充说明，同时用于图片替代文本 */
  caption: string;
  tags: string[];
  /** 对应视频外链；未知就不写 */
  videoUrl?: string;
}

/** 时间轴上的一个研究节点 */
export interface TimelineEntry {
  /** 时间点，原样展示（如 2024.3） */
  date: string;
  title: string;
  description: string;
  tags: string[];
}

/** 成果清单里的一条 B 站视频作品（页面按纯文本一行一条渲染） */
export interface VideoWork {
  title: string;
  meta: string;
}

/** 封面滚动：顺序即展示顺序，第二行自动反向滚动 */
export const showcaseItems: ShowcaseItem[] = [
  {
    image: '/works/showcase/dupe-infinite-block.jpg',
    title: '无限方块复制',
    caption: '网易版同样可用；被修复的复制漏洞在这里复活。',
    tags: ['无限方块', '特性 bug', '网易版可用'],
  },
  {
    image: '/works/showcase/end-mechanism.jpg',
    title: '「末地 / 地狱异步地物回溯」',
    caption: '末地与地狱的异步地物回溯实测。',
    tags: ['末地', '地狱', '异步地物回溯'],
  },
  {
    image: '/works/showcase/fastest-ftff.jpg',
    title: 'The world Fastest FTFF in MCBE',
    caption: 'MCBE 里最速的 FTFF。',
    tags: ['FTFF', 'MCBE'],
  },
  {
    image: '/works/showcase/tree-farm-16gt.jpg',
    title: '16gt 双核心四树种树场',
    caption: '寸止催熟，每秒 2.5 颗树。',
    tags: ['树场', '16gt', '寸止催熟'],
  },
  {
    image: '/works/showcase/chest-entanglement.jpg',
    title: '箱子纠缠 · 超距信号传输',
    caption: '超距传输物品 + 无线红石，全版本生存简易好做。',
    tags: ['机制', '信号', '无线红石'],
    videoUrl: 'https://www.bilibili.com/video/BV1HaaxzuExT/',
  },
];

/** 研究时间轴：按时间顺序书写，页面按数组顺序渲染 */
export const timelineEntries: TimelineEntry[] = [
  {
    date: '2024.3',
    title: '新式树场',
    description: '研发出基于 pt 科技和区块优先级的新式树场，启发了基岩版其它高级 pt 科技。',
    tags: ['pt 科技', '区块优先级', '树场'],
  },
  {
    date: '2025.2',
    title: '无限方块 · 方块实体分离',
    description:
      '逆向代码研究出无限方块 bug 的底层逻辑，发展出了方块实体分离技术，构建了基岩版第一个基于特性 bug 的完整复杂科技树。',
    tags: ['逆向', '方块实体分离', '科技树'],
  },
  {
    date: '2026.2',
    title: '区块加载 · 无限方块复活',
    description: '逆向研究全部区块加载机制，并开发出基于区块保存和异步加载漏洞的科技树，复活被修复的无限方块。',
    tags: ['区块加载', '异步加载', '无限方块'],
  },
];

/** 成果清单：B 站视频作品（与上方封面滚动互为索引） */
export const videoWorks: VideoWork[] = [
  {
    title: '无限方块复制',
    meta: '特性 bug 逆向 · 网易版可用',
  },
  {
    title: '「末地 / 地狱异步地物回溯」',
    meta: '末地与地狱的异步地物回溯实测',
  },
  {
    title: 'The world Fastest FTFF in MCBE',
    meta: 'MCBE · 最速 FTFF',
  },
  {
    title: '16gt 双核心四树种树场',
    meta: 'MCBE · 每秒 2.5 颗树',
  },
  {
    title: '箱子纠缠 · 超距信号传输',
    meta: '超距传输物品 · 无线红石',
  },
  {
    title: '高频闪门 · 猪人塔',
    meta: '红石工程 · 触发时序与机器搭建',
  },
  {
    title: '无基岩 · 凋零笼',
    meta: '机器设计 · 不依赖基岩约束凋零',
  },
];
