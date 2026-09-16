/** 超级管理员的主页编辑面板（ADR-002）。
 * 依赖关系：account 公开接口（会话/角色）+ site-config 公开接口（读写/渲染）；
 * 两个模块互不感知本模块的存在。
 */
import { type AccountSummary, currentSession } from '../account';
import {
  type MergedSiteConfig,
  type SiteConfigOverrides,
  applyConfig,
  fetchSiteConfig,
  mergeConfig,
  saveSiteConfig,
} from '../site-config';
import { toast } from '../../shared/toast';

let panel: HTMLElement | null = null;
let current: MergedSiteConfig;

export function initSiteAdmin(): void {
  window.addEventListener('naytia:session', (e: Event) => {
    const account = (e as CustomEvent<AccountSummary | null>).detail;
    if (account?.role === 'superadmin') void mount();
    else unmount();
  });
  // 首次进入页面时主动取一次会话（事件只在变化时广播）
  void currentSession().then((account) => {
    if (account?.role === 'superadmin') void mount();
  });
}

async function mount(): Promise<void> {
  if (panel) return;
  let overrides = await fetchSiteConfig().catch(() => null);
  current = mergeConfig(overrides);

  panel = document.createElement('div');
  panel.className = 'ui-admin-panel';
  panel.innerHTML = `
    <button type="button" class="ui-btn ui-btn-primary ui-admin-toggle">✎ 编辑主页</button>
    <form class="ui-admin-form" hidden novalidate>
      <h2>编辑主页 <small>超级管理员</small></h2>
      <div class="ui-field"><label for="sa-name">昵称</label>
        <input id="sa-name" maxlength="24" value="${escapeAttr(current.displayName)}"></div>
      <div class="ui-field"><label for="sa-intro">简介文字</label>
        <textarea id="sa-intro" rows="3" maxlength="400">${escapeText(current.intro)}</textarea></div>
      <div class="ui-field"><label for="sa-avatar">头像图片地址（支持 GIF 等动图）</label>
        <input id="sa-avatar" type="url" placeholder="https://…" value="${escapeAttr(overrides?.avatar_url ?? '')}"></div>
      <div class="ui-field"><label for="sa-bgmode">背景</label>
        <select id="sa-bgmode">
          <option value="none">无背景（白底）</option>
          <option value="image" ${current.background.mode === 'image' ? 'selected' : ''}>图片背景</option>
        </select></div>
      <div class="ui-field"><label for="sa-bgurl">背景图片地址（GIF / WebP / APNG 等动图均可）</label>
        <input id="sa-bgurl" type="url" placeholder="https://…/bg.gif" value="${escapeAttr(current.background.url ?? '')}"></div>
      <div class="ui-field"><label for="sa-overlay">背景遮罩深度：${current.background.overlay}</label>
        <input id="sa-overlay" type="range" min="0" max="0.9" step="0.05" value="${current.background.overlay}"></div>
      <p class="ui-error" hidden></p>
      <div class="ui-actions">
        <button type="submit" class="ui-btn ui-btn-primary">保存并发布</button>
        <button type="button" class="ui-btn" data-act="preview">预览</button>
        <button type="button" class="ui-btn" data-act="close">收起</button>
      </div>
    </form>`;

  document.body.appendChild(panel);
  const form = panel.querySelector<HTMLFormElement>('.ui-admin-form')!;
  const error = form.querySelector<HTMLElement>('.ui-error')!;

  panel.querySelector('.ui-admin-toggle')?.addEventListener('click', () => {
    form.hidden = !form.hidden;
  });
  form.querySelector('[data-act=close]')?.addEventListener('click', () => {
    form.hidden = true;
  });

  // 实时预览：输入即渲染，不做任何请求
  form.querySelector('#sa-bgmode')?.addEventListener('change', preview);
  form.querySelector('#sa-overlay')?.addEventListener('input', (e) => {
    form.querySelector('label[for=sa-overlay]')!.textContent =
      `背景遮罩深度：${(e.target as HTMLInputElement).value}`;
    preview();
  });
  ['#sa-name', '#sa-intro', '#sa-avatar', '#sa-bgurl'].forEach((sel) =>
    form.querySelector(sel)?.addEventListener('input', preview),
  );

  form.querySelector('[data-act=preview]')?.addEventListener('click', () => preview());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      overrides = collectOverrides();
      current = mergeConfig(overrides);
      await saveSiteConfig(overrides);
      applyConfig(current);
      toast('主页配置已保存并发布');
      form.hidden = true;
    } catch (err) {
      error.textContent = err instanceof Error ? err.message : '保存失败';
      error.hidden = false;
    }
  });

  function preview(): void {
    current = mergeConfig(collectOverrides());
    applyConfig(current);
  }

  function collectOverrides(): SiteConfigOverrides {
    const val = (sel: string) => form.querySelector<HTMLInputElement>(sel)!.value.trim();
    const displayName = val('#sa-name');
    const intro = val('#sa-intro');
    const avatarUrl = val('#sa-avatar');
    const bgUrl = val('#sa-bgurl');
    const overlay = Number(form.querySelector<HTMLInputElement>('#sa-overlay')!.value);
    const patch: SiteConfigOverrides = {};
    if (displayName) patch.display_name = displayName;
    if (intro) patch.intro = intro;
    if (avatarUrl) patch.avatar_url = avatarUrl;
    patch.background = {
      mode: form.querySelector<HTMLSelectElement>('#sa-bgmode')!.value as 'none' | 'image',
      overlay,
      ...(bgUrl ? { url: bgUrl } : {}),
    };
    return patch;
  }
}

function unmount(): void {
  panel?.remove();
  panel = null;
}

function escapeText(v: string): string {
  return v.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

function escapeAttr(v: string): string {
  return escapeText(v);
}
