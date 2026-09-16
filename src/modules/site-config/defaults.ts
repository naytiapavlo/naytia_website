/** 内置默认值：后端不可用或未配置时，站点保持这套静态表现（02 文档：无隐式强依赖）。 */
import type { MergedSiteConfig, SiteConfigOverrides } from './types';

export const defaultSiteConfig: MergedSiteConfig = {
  displayName: '帕芙洛',
  intro: '一个喜欢研究 Minecraft 的人。在这里记录灵感、分享作品，也折腾一些有趣的小工具。',
  avatarUrl: '/avatar.png',
  background: { mode: 'none', overlay: 0.35 },
};

export function mergeConfig(overrides: SiteConfigOverrides | null): MergedSiteConfig {
  const o = overrides ?? {};
  const bg = o.background ?? {};
  return {
    displayName: o.display_name?.trim() || defaultSiteConfig.displayName,
    intro: o.intro ?? defaultSiteConfig.intro,
    avatarUrl: o.avatar_url?.trim() || defaultSiteConfig.avatarUrl,
    background: {
      mode: bg.mode === 'image' && bg.url ? 'image' : 'none',
      url: bg.url,
      overlay: typeof bg.overlay === 'number' ? bg.overlay : defaultSiteConfig.background.overlay,
    },
  };
}
