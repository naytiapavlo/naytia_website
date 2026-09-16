/** 把合并后的配置渲染到页面挂钩点；页面只提供 data-site-field 标记。 */
import type { MergedSiteConfig } from './types';

export function applyConfig(cfg: MergedSiteConfig): void {
  document.querySelectorAll('[data-site-field="display_name"]').forEach((el) => {
    (el as HTMLElement).textContent = cfg.displayName;
  });
  document.querySelectorAll('[data-site-field="intro"]').forEach((el) => {
    (el as HTMLElement).textContent = cfg.intro;
  });
  document.querySelectorAll<HTMLImageElement>('img[data-site-field="avatar"]').forEach((el) => {
    el.src = cfg.avatarUrl;
  });

  const layer = document.getElementById('site-background');
  if (layer) {
    if (cfg.background.mode === 'image' && cfg.background.url) {
      layer.classList.add('is-image');
      layer.style.backgroundImage = `url("${cfg.background.url.replace(/"/g, '%22')}")`;
    } else {
      layer.classList.remove('is-image');
      layer.style.backgroundImage = '';
    }
  }
  const overlay = document.querySelector<HTMLElement>('#site-background .site-bg-overlay');
  if (overlay) overlay.style.opacity = String(cfg.background.overlay);
}
