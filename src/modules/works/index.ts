/**
 * 作品模块（`/works/` 页面）公开接口。
 *
 * 页面只从模块根 `modules/works` 取用（`src/modules/README.md` 第 1 条）：
 * - 展示数据（封面滚动 / 时间轴 / 成果清单）在 `data.ts`，改内容不改模板；
 * - 客户端增强（灯箱、时间轴动效）在 `ui.ts`，静态内容不依赖它。
 */
export type { ShowcaseItem, TimelineEntry, VideoWork } from './data';
export { showcaseItems, timelineEntries, videoWorks } from './data';
export { initWorksShowcase } from './ui';
