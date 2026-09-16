/** 账号管理界面（/admin/users/）：超管搜索账号、授予或收回管理员。
 *
 * 依赖方向：admin-users → account（会话）+ shared（api-client / toast），
 * 不感知 site-admin / site-config。
 *
 * 权限：界面按会话角色分流（非超管看到说明文字，且**不发任何请求**），
 * 但真正的边界在服务端（`/api/admin/*` 的 require_superadmin）——
 * 前端隐藏按钮不作为权限控制（01 文档第 7 节）。
 */
import { type AccountSummary, currentSession } from '../account';
import { ApiError } from '../../shared/api-client';
import { toast } from '../../shared/toast';
import { type AccountRow, fetchAccounts, setAdmin } from './api';
import {
  adminToggleOn,
  matchesSearch,
  roleCounts,
  roleLabel,
  rowCapability,
  toggleDone,
  togglePrompt,
} from './rules';

/** 搜完再发请求的等待时间：太短会把每个字都变成一个请求，太长又显得卡。 */
const SEARCH_DEBOUNCE_MS = 220;

/** 导航栏里那一项管理入口的 id（只对超管出现）。 */
const NAV_ID = 'navAdminUsers';

interface AdminUsersState {
  rows: AccountRow[];
  search: string;
  self: AccountSummary | null;
  loaded: boolean;
  busy: boolean;
  /** 请求序号：慢的旧响应回来时不能覆盖新一次搜索的结果。 */
  seq: number;
}

let view: HTMLElement | null = null;
/** 表格容器与工具栏分开持有：搜索框在重渲染中原地保留，输入焦点才不会断。 */
let tableBox: HTMLElement | null = null;
let countBox: HTMLElement | null = null;
let state: AdminUsersState | null = null;

export function initAdminUsers(root: HTMLElement): void {
  view = root;
  state = { rows: [], search: '', self: null, loaded: false, busy: false, seq: 0 };
  void boot();
}

/**
 * 导航栏入口：只有超管能看到「账号管理」。
 *
 * 不把这一项写进 `site.nav`（那是访客也能拿到的构建期配置），而是在登录后按角色
 * 插入，并把判定同时挂在 `naytia:session` 事件上——页面开着的时候退出登录，
 * 入口会自己消失。这只是界面可见性，真正的权限在服务端。
 */
export function mountAdminNav(): void {
  const apply = (account: AccountSummary | null) => {
    const exists = document.getElementById(NAV_ID);
    if (account?.role !== 'superadmin') {
      exists?.remove();
      return;
    }
    if (exists) return;
    const link = document.createElement('a');
    link.id = NAV_ID;
    link.className = 'nav-link';
    link.href = '/admin/users/';
    // 与 BaseLayout 里 site.nav 的链接同款：当前页加 aria-current，样式表直接复用
    if (window.location.pathname.startsWith('/admin/users')) {
      link.setAttribute('aria-current', 'page');
    }
    link.innerHTML =
      '<svg class="pixel" aria-hidden="true"><use href="#i-user" /></svg>账号管理';
    // 插在账号角标之前，与 site.nav 其余项的顺序一致
    const chip = document.querySelector('.nav-account');
    if (chip) chip.before(link);
    else document.querySelector('.nav-links')?.append(link);
  };

  window.addEventListener('naytia:session', (e: Event) => {
    apply((e as CustomEvent<AccountSummary | null>).detail);
  });
  void currentSession().then(apply).catch(() => apply(null));
}

async function boot(): Promise<void> {
  if (!view || !state) return;
  view.replaceChildren(el('p', 'au-boot', '正在加载账号列表…'));

  let account: AccountSummary | null = null;
  try {
    account = await currentSession();
  } catch {
    renderNotice('这一页只对超级管理员开放。',
      '当前无法确认登录状态（后端没有响应），请稍后重试。');
    return;
  }
  if (!view || !state) return;
  state.self = account;
  if (account?.role !== 'superadmin') {
    renderNotice('这一页只对超级管理员开放。',
      '如果你认为这是误判，请用站长账号登录后重试。');
    return;
  }
  mountShell();
  await load();
}

/** 首次构建页面骨架：工具栏与搜索框只建一次，之后只换表格内容。 */
function mountShell(): void {
  if (!view || !state) return;
  const toolbar = el('div', 'au-toolbar');
  toolbar.append(searchBox());
  countBox = el('span', 'au-count');
  const refresh = el('button', 'ui-btn', '刷新');
  refresh.type = 'button';
  refresh.dataset.act = 'refresh';
  toolbar.append(countBox, refresh);
  refresh.addEventListener('click', () => void load());

  tableBox = el('div', 'au-table');
  tableBox.setAttribute('role', 'table');
  tableBox.setAttribute('aria-label', '账号列表');

  view.replaceChildren(toolbar, tableBox, footnote());
}

function searchBox(): HTMLElement {
  const box = el('div', 'au-search');
  const input = document.createElement('input');
  input.type = 'search';
  input.id = 'au-search';
  input.className = 'au-search-input';
  input.placeholder = '按名字搜索…';
  input.autocomplete = 'off';
  // 与后端 USERNAME_MAX 一致：更长的搜索词不可能匹配到人
  input.maxLength = 16;
  input.setAttribute('aria-label', '按名字搜索账号');

  let timer: number | undefined;
  input.addEventListener('input', () => {
    if (!state) return;
    state.search = input.value;
    // 立刻复筛当前这一批：服务端结果回来之前，界面不会留着明显不匹配的行
    filterLocally(input.value);
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void load(), SEARCH_DEBOUNCE_MS);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      window.clearTimeout(timer);
      void load();
    }
  });
  box.append(input);
  return box;
}

/**
 * 拉取列表并重画表格。
 *
 * 搜索过程中**不动**工具栏（搜索框是同一个节点），所以输入焦点不会中断；
 * 表格在忙碌期间用 `aria-busy` 标记而不是清空——搜索框还开着的时候整块闪一下，
 * 会让人以为界面坏了。首次加载由 boot() 先放一句「正在加载」。
 */
async function load(): Promise<void> {
  if (!view || !state) return;
  const seq = ++state.seq;
  state.busy = true;
  if (!state.loaded) tableBox?.replaceChildren(el('p', 'au-boot', '正在加载账号列表…'));
  else tableBox?.setAttribute('aria-busy', 'true');

  let rows: AccountRow[];
  try {
    rows = await fetchAccounts(state.search);
  } catch (err) {
    if (!state || seq !== state.seq) return; // 已被更新的一次搜索取代
    state.busy = false;
    renderError(err);
    return;
  }
  if (!state || seq !== state.seq) return;
  state.rows = rows;
  state.loaded = true;
  state.busy = false;
  renderTable();
}

function renderTable(): void {
  if (!tableBox || !state) return;
  tableBox.setAttribute('aria-busy', 'false');
  tableBox.replaceChildren(headerRow());
  for (const row of state.rows) tableBox.append(bodyRow(row));
  if (state.rows.length === 0) tableBox.append(emptyBox());
  if (countBox) {
    const counts = roleCounts(state.rows);
    countBox.textContent = `${state.rows.length} 个账号 · 管理员 ${counts.admin}`
      + ` · 超管 ${counts.superadmin}`;
  }
}

/** 表头。列宽由 CSS 的 grid 模板统一决定，所以这里只放文字。 */
function headerRow(): HTMLElement {
  const head = el('div', 'au-row au-head');
  head.setAttribute('role', 'row');
  for (const [text, cls] of [
    ['用户', 'au-c-user'],
    ['角色', 'au-c-role'],
    ['注册时间', 'au-c-time'],
    ['操作', 'au-c-act'],
  ] as const) {
    const cell = el('div', cls, text);
    cell.setAttribute('role', 'columnheader');
    head.append(cell);
  }
  return head;
}

function bodyRow(row: AccountRow): HTMLElement {
  const wrap = el('div', 'au-row');
  wrap.setAttribute('role', 'row');
  wrap.dataset.id = String(row.id);

  const self = state?.self ?? null;
  const isSelf = self !== null && row.id === self.id;
  const cap = rowCapability(row, self?.id ?? null);
  const on = adminToggleOn(row.role);

  const name = el('div', 'au-c-user');
  name.setAttribute('role', 'cell');
  const initial = el('span', 'au-avatar', row.username.slice(0, 1).toUpperCase());
  initial.setAttribute('aria-hidden', 'true');
  const nameText = el('div', 'au-name');
  nameText.append(
    el('strong', null, row.username),
    el('small', null, `#${row.id}${isSelf ? ' · 我' : ''}`),
  );
  name.append(initial, nameText);

  const role = el('div', 'au-c-role');
  role.setAttribute('role', 'cell');
  role.append(el('span', `ui-role-badge ui-role-${row.role}`, roleLabel(row.role)));

  const time = el('div', 'au-c-time', formatDate(row.created_at));
  time.setAttribute('role', 'cell');

  const act = el('div', 'au-c-act');
  act.setAttribute('role', 'cell');
  if (cap.canToggle) {
    const button = el('button', on ? 'ui-btn au-toggle is-on' : 'ui-btn au-toggle',
      on ? '取消管理员' : '设为管理员');
    button.type = 'button';
    button.dataset.act = on ? 'revoke' : 'grant';
    button.dataset.id = String(row.id);
    button.dataset.name = row.username;
    button.addEventListener('click', () => void toggle(button, !on));
    act.append(button);
  } else {
    // 不能操作时把原因写出来，而不是给一个点了没反应的禁用按钮
    act.append(el('span', 'au-locked', cap.reason ?? '不可修改'));
  }

  wrap.append(name, role, time, act);
  return wrap;
}

function emptyBox(): HTMLElement {
  const box = el('div', 'au-empty');
  const q = state?.search.trim() ?? '';
  box.append(
    el('p', null, q ? `没有名字包含「${q}」的账号` : '站内还没有其他账号'),
    el('small', null, q
      ? '换个关键词试试；搜索不区分大小写，按用户名的一部分匹配。'
      : '有人注册之后就会出现在这里。'),
  );
  return box;
}

/** 授予 / 收回管理员：先确认后果，再就地改这一行（不整表重载，焦点与滚动都不动）。 */
async function toggle(button: HTMLButtonElement, enabled: boolean): Promise<void> {
  if (!state) return;
  const { id, name: username = '' } = button.dataset;
  if (!window.confirm(togglePrompt(username, enabled))) return;
  button.disabled = true;
  try {
    const updated = await setAdmin(Number(id), enabled);
    if (!state) return;
    const index = state.rows.findIndex((row) => row.id === updated.id);
    if (index >= 0) state.rows[index] = updated;
    toast(toggleDone(username, enabled));
    renderTable();
  } catch (err) {
    button.disabled = false;
    toast(err instanceof ApiError ? err.message : '操作失败，请重试');
    // 服务端可能以「你自己/对方刚被别处改过」为由拒绝，重新拉一次让界面回到真实状态
    void load();
  }
}

/** 只对本批结果做即时复筛（不改 state.rows，下一次服务端返回会整体替换）。 */
function filterLocally(search: string): void {
  if (!tableBox || !state) return;
  tableBox.querySelectorAll<HTMLElement>('.au-row[data-id]').forEach((row) => {
    const account = state?.rows.find((r) => r.id === Number(row.dataset.id));
    row.hidden = account ? !matchesSearch(account.username, search) : false;
  });
}

function renderNotice(message: string, hint: string): void {
  if (!view) return;
  const box = el('div', 'au-denied');
  box.append(el('p', null, message), el('small', null, hint));
  view.replaceChildren(box);
}

function renderError(err: unknown): void {
  if (!view) return;
  const detail = err instanceof ApiError
    ? `${err.message}（HTTP ${err.status}）`
    : '无法连接后端服务。';
  const box = el('div', 'au-denied');
  box.append(el('p', null, '账号列表没能加载。'), el('small', null, detail));
  const retry = el('button', 'ui-btn ui-btn-primary', '重试');
  retry.type = 'button';
  retry.addEventListener('click', () => void boot());
  box.append(retry);
  view.replaceChildren(box);
}

function footnote(): HTMLElement {
  const note = el('p', 'au-note');
  note.textContent =
    '权限由服务端判定，这里的按钮只是入口。超管档位不在这里调整：'
    + '「设为管理员」最高只到管理员，超管的管理员身份也不能被取消'
    + '（超管只能由首个账号的引导规则或注册邀请码产生）。';
  return note;
}

/** 时间只显示到分钟，用浏览器本地时区（后端已把 UTC 时间补齐时区信息）。 */
function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string | null,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
