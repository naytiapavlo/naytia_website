/**
 * site-config 模块公开接口（唯一入口）。
 * 其他模块/页面只允许 import from 'modules/site-config'，不深入内部文件。
 */
export type {
  BackgroundMode,
  MergedSiteConfig,
  SiteBackground,
  SiteConfigOverrides,
} from './types';
export { defaultSiteConfig, mergeConfig } from './defaults';
export { fetchSiteConfig, saveSiteConfig } from './api';
export { applyConfig } from './apply';
