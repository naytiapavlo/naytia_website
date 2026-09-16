/** 站点配置的动态部分（ADR-002）：超级管理员可修改的覆盖项。 */

export type BackgroundMode = 'none' | 'image';

export interface SiteBackground {
  mode: BackgroundMode;
  /** http(s) 图片地址，支持 GIF / WebP / APNG 等动图格式 */
  url?: string;
  /** 暗色遮罩 0-0.9，保证动图上的文字可读 */
  overlay: number;
}

/** 后端存储的覆盖项（PATCH 语义：只存修改过的字段） */
export interface SiteConfigOverrides {
  display_name?: string;
  intro?: string;
  avatar_url?: string;
  background?: Partial<SiteBackground>;
}

/** 与内置默认值合并后的完整配置 */
export interface MergedSiteConfig {
  displayName: string;
  intro: string;
  avatarUrl: string;
  background: SiteBackground;
}
