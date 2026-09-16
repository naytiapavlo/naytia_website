/** 账号 UI：导航栏角标 + 登录/注册弹窗。角色变化广播 `naytia:session` 事件。 */
import { toast } from '../../shared/toast';
import { type AccountSummary, ROLE_LABELS, login, logout, me, register } from './api';

const EVENT = 'naytia:session';

function announce(account: AccountSummary | null): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: account }));
}

export function currentSession(): Promise<AccountSummary | null> {
  return me();
}

export function mountAccountChip(container: HTMLElement | null): void {
  if (!container) return;
  renderLoggedOut(container);
  void me()
    .then((account) => (account ? renderLoggedIn(container, account) : undefined))
    .catch(() => undefined); // 后端离线：保持静态表现
}

function renderLoggedOut(container: HTMLElement): void {
  container.innerHTML = '<button type="button" class="ui-btn ui-btn-primary">登录 / 注册</button>';
  container.querySelector('button')?.addEventListener('click', () => openDialog(container));
}

function renderLoggedIn(container: HTMLElement, account: AccountSummary): void {
  const badge =
    account.role === 'superadmin' ? '超管' : account.role === 'admin' ? '管理员' : '';
  container.innerHTML = `
    <span class="ui-user-chip">
      <span class="ui-user-avatar" aria-hidden="true">${escapeText(account.username.slice(0, 1).toUpperCase())}</span>
      <span class="ui-user-name">${escapeText(account.username)}</span>
      ${badge ? `<span class="ui-role-badge ui-role-${account.role}">${badge}</span>` : ''}
      <button type="button" class="ui-logout">退出</button>
    </span>`;
  container.querySelector('.ui-logout')?.addEventListener('click', async () => {
    await logout().catch(() => undefined);
    toast('已退出登录');
    renderLoggedOut(container);
    announce(null);
  });
  announce(account);
}

function openDialog(container: HTMLElement): void {
  let overlay = document.getElementById('account-dialog');
  if (overlay) {
    overlay.hidden = false;
    return;
  }
  overlay = document.createElement('div');
  overlay.id = 'account-dialog';
  overlay.className = 'ui-overlay';
  overlay.innerHTML = `
    <div class="ui-dialog" role="dialog" aria-modal="true" aria-labelledby="account-dialog-title">
      <button type="button" class="ui-dialog-close" aria-label="关闭">×</button>
      <p class="ui-eyebrow">WELCOME</p>
      <h2 id="account-dialog-title">登录</h2>
      <div class="ui-tabs">
        <button type="button" class="ui-tab is-active" data-tab="login">登录</button>
        <button type="button" class="ui-tab" data-tab="register">注册</button>
      </div>
      <form novalidate>
        <div class="ui-field"><label for="acct-name">用户名</label>
          <input id="acct-name" maxlength="16" autocomplete="username" placeholder="2-16 位字母 / 数字 / 下划线 / 中文"></div>
        <div class="ui-field"><label for="acct-pass">密码</label>
          <input id="acct-pass" type="password" autocomplete="current-password" placeholder="至少 6 位"></div>
        <div class="ui-field" data-only="register" hidden><label for="acct-pass2">确认密码</label>
          <input id="acct-pass2" type="password" autocomplete="new-password" placeholder="再输入一次密码"></div>
        <div class="ui-field" data-only="register" hidden><label for="acct-code">超级管理员邀请码（没有可留空）</label>
          <input id="acct-code" maxlength="64" placeholder="仅站长部署时使用"></div>
        <p class="ui-error" hidden></p>
        <button type="submit" class="ui-btn ui-btn-primary" style="width:100%">登录</button>
      </form>
      <p class="ui-note">账号数据由站内服务保存；请勿使用你在其他网站的常用密码。</p>
    </div>`;
  document.body.appendChild(overlay);

  const dialog = overlay.querySelector<HTMLElement>('.ui-dialog')!;
  const submit = overlay.querySelector<HTMLButtonElement>('button[type=submit]')!;
  let mode: 'login' | 'register' = 'login';

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay!.hidden = true;
  });
  overlay.querySelector('.ui-dialog-close')?.addEventListener('click', () => {
    overlay!.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay && !overlay.hidden) overlay.hidden = true;
  });
  overlay.querySelectorAll('.ui-tab').forEach((tab) =>
    tab.addEventListener('click', () => {
      mode = (tab as HTMLElement).dataset.tab as 'login' | 'register';
      overlay!.querySelectorAll('.ui-tab').forEach((t) => t.classList.toggle('is-active', t === tab));
      overlay!.querySelectorAll('[data-only=register]').forEach((f) => ((f as HTMLElement).hidden = mode !== 'register'));
      submit.textContent = mode === 'login' ? '登录' : '注册并登录';
      showError(null);
    }),
  );

  function showError(msg: string | null): void {
    const el = overlay!.querySelector<HTMLElement>('.ui-error')!;
    el.textContent = msg ?? '';
    el.hidden = !msg;
  }

  overlay.querySelector('form')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = (overlay!.querySelector<HTMLInputElement>('#acct-name')!.value || '').trim();
    const password = overlay!.querySelector<HTMLInputElement>('#acct-pass')!.value;
    try {
      if (mode === 'register') {
        const pass2 = overlay!.querySelector<HTMLInputElement>('#acct-pass2')!.value;
        const code = overlay!.querySelector<HTMLInputElement>('#acct-code')!.value.trim();
        if (password !== pass2) return showError('两次输入的密码不一致');
        const account = await register(username, password, code || undefined);
        dialogClose();
        toast(`欢迎你，${account.username}！`);
        renderLoggedIn(container, account);
      } else {
        const account = await login(username, password);
        dialogClose();
        toast(`欢迎回来，${account.username}！`);
        renderLoggedIn(container, account);
      }
    } catch (err) {
      showError(err instanceof Error ? err.message : '操作失败，请重试');
    }
  });

  function dialogClose(): void {
    overlay!.hidden = true;
  }
}

function escapeText(v: string): string {
  return v.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}
