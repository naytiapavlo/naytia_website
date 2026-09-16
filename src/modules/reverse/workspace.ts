/**
 * 逆向工作台界面：仿 IDA 的多面板布局。
 *
 * 面板组成：
 * - 工具栏：实例选择（仅管理员）、函数搜索、上一个/下一个、复制、重命名（仅 admin）、快捷键
 * - 左栏：函数 / 字符串 / 段 三个页签
 * - 主区：伪代码 / 反汇编 / 交叉引用 / 栈变量 / 基本块 五个页签
 * - 状态栏：模块、基址、已加载函数数、当前选择、权限、IDB 路径
 *
 * 设计约束（docs/plans/07 与 ADR-004）：
 * - 访客与普通用户只读；重命名与实例切换只对 admin/superadmin 显示，
 *   且服务端在 /api/reverse/* 另有拦截——前端隐藏控件不作为权限控制。
 * - IDA 返回的标识符与字符串可能含任意字符，所以内容一律用
 *   createElement + textContent 写入，绝不拼 innerHTML。
 * - IDA 不可达时只降级自己的工作区，不影响站内其他功能。
 */
import { currentSession, SESSION_EVENT } from '../account';
import { ApiError } from '../../shared/api-client';
import { toast } from '../../shared/toast';
import { mountAiPanel } from './ai-panel';
import {
  reverseApi,
  type BinaryOverview,
  type FunctionSummary,
  type IdaInstance,
  type IdaStatus,
  type ReversePermissions,
  type SegmentInfo,
  type StringMatch,
} from './api';

const PAGE_SIZE = 200;
/** 进入「字符串」页签时默认搜这个模式，保证一进去就有内容可看。 */
const DEFAULT_STRING_PATTERN = '.';
const STRING_LIMIT = 200;

type TabId = 'pseudocode' | 'disasm' | 'xrefs' | 'vars' | 'blocks';
type SideId = 'funcs' | 'strings' | 'segments';

interface StringRow {
  addr: string;
  text: string;
}

/** 面板尺寸持久化键（用户拖动过就记住，刷新后保留）。 */
const PANEL_SIZE_KEYS: Record<'side' | 'list', string> = {
  side: 'naytia:ida:side-width',
  list: 'naytia:ida:list-height',
};

interface WorkspaceState {
  port: number | null;
  /** 用户是否手动选过实例；没选过就跟随 MCP 当前实例 */
  portPinned: boolean;
  instances: IdaInstance[];
  permissions: ReversePermissions;
  status: IdaStatus | null;
  overview: BinaryOverview | null;
  functions: FunctionSummary[];
  nextOffset: number | null;
  filter: string;
  selected: number;
  tab: TabId;
  side: SideId;
  strings: StringRow[];
  stringPattern: string;
  stringOffset: number;
  stringsMore: boolean;
  segments: SegmentInfo[];
}

export function initReverseWorkspace(root: HTMLElement): () => void {
  const state: WorkspaceState = {
    port: null,
    portPinned: false,
    instances: [],
    permissions: { role: null, can_write: false },
    status: null,
    overview: null,
    functions: [],
    nextOffset: null,
    filter: '',
    selected: -1,
    tab: 'pseudocode',
    side: 'funcs',
    strings: [],
    stringPattern: DEFAULT_STRING_PATTERN,
    stringOffset: 0,
    stringsMore: false,
    segments: [],
  };

  /** 所有事件监听都登记在这里，dispose 时统一摘掉，避免重复挂载后重复响应。 */
  const disposers: Array<() => void> = [];
  const on = <K extends keyof HTMLElementEventMap>(
    target: HTMLElement | Window | Document,
    type: K | string,
    handler: (event: never) => void,
    useCapture = false,
  ): void => {
    target.addEventListener(type, handler as EventListener, useCapture);
    disposers.push(() => target.removeEventListener(type, handler as EventListener, useCapture));
  };

  // ===================== DOM 骨架 =====================
  const titlebar = el('div', 'ida-titlebar');
  const mark = el('span', 'ida-mark'); mark.textContent = 'N';
  const appName = el('span', 'ida-appname'); appName.textContent = 'BDS 逆向工作台';
  const appSub = el('span', 'ida-appsub'); appSub.textContent = '（未连接）';
  const chipMode = el('span', 'ida-chip'); chipMode.dataset.tone = 'warn';
  chipMode.textContent = '连接中…';
  const chipHealth = el('span', 'ida-chip'); chipHealth.textContent = '—';
  titlebar.append(mark, appName, appSub, el('span', 'ida-grow'), chipMode, chipHealth);

  const toolbar = el('div', 'ida-toolbar');
  const instanceLabel = el('span', 'ida-label'); instanceLabel.textContent = '实例';
  const instanceSel = document.createElement('select');
  instanceSel.className = 'ida-field';
  instanceSel.setAttribute('aria-label', '选择 IDA 实例');
  instanceSel.hidden = true;
  const sep1 = el('span', 'ida-sep');

  const searchWrap = el('span', 'ida-search');
  const funcSearch = document.createElement('input');
  funcSearch.type = 'search';
  funcSearch.className = 'ida-field';
  funcSearch.placeholder = '函数名（支持 * 通配）';
  funcSearch.setAttribute('aria-label', '搜索函数');
  const btnSearch = btn('搜索');
  searchWrap.append(funcSearch, btnSearch);
  const sep2 = el('span', 'ida-sep');

  const btnPrev = btn('↑ 上一个');
  const btnNext = btn('↓ 下一个');
  const sep3 = el('span', 'ida-sep');
  const btnCopy = btn('复制');
  const btnRename = btn('重命名');
  btnRename.disabled = true;
  btnRename.hidden = true;
  const btnHelp = btn('快捷键');
  const chipPerm = el('span', 'ida-chip'); chipPerm.textContent = '只读';
  const chipCount = el('span', 'ida-chip'); chipCount.textContent = '0 个函数';
  toolbar.append(
    instanceLabel, instanceSel, sep1, searchWrap, sep2,
    btnPrev, btnNext, sep3, btnCopy, btnRename, btnHelp,
    el('span', 'ida-grow'), chipPerm, chipCount,
  );

  const workarea = el('div', 'ida-workarea');
  const side = el('aside', 'ida-side');
  const sideTabs = el('div', 'ida-side-tabs');
  const sideTabDefs: Array<[SideId, string]> = [['funcs', '函数'], ['strings', '字符串'], ['segments', '段']];
  const sideTabNodes = new Map<SideId, HTMLButtonElement>();
  for (const [id, label] of sideTabDefs) {
    const t = document.createElement('button');
    t.type = 'button';
    t.className = 'ida-side-tab';
    t.textContent = label;
    on(t, 'click', () => {
      state.side = id;
      paintSideTabs();
      void selectSide(id);
    });
    sideTabNodes.set(id, t);
    sideTabs.appendChild(t);
  }
  const metaBox = el('div', 'ida-meta');
  const listHead = el('div', 'ida-listhead');
  const listHeadLabel = el('span', ''); listHeadLabel.textContent = '地址 / 名称';
  const listHeadCount = el('span', '');
  listHead.append(listHeadLabel, listHeadCount);
  const list = el('div', 'ida-list');
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', '函数列表');
  list.tabIndex = 0;
  const listFoot = el('div', 'ida-listfoot');
  const btnMore = btn('加载更多');
  btnMore.style.width = '100%';
  btnMore.style.justifyContent = 'center';
  btnMore.hidden = true;
  listFoot.appendChild(btnMore);
  // 列表与底部按钮区之间可以拖（列表想多高就多高）
  const splitterListFoot = createSplitter('y', 120, 1200, '函数列表高度');
  side.append(sideTabs, metaBox, listHead, list, splitterListFoot, listFoot);

  const main = el('div', 'ida-main');
  const crumbs = el('div', 'ida-crumbs');
  const fnName = el('span', 'ida-fnname'); fnName.textContent = '（未选择函数）';
  const fnAt = el('span', 'ida-fnat');
  const chipSize = el('span', 'ida-chip');
  crumbs.append(fnName, fnAt, el('span', 'ida-grow'), chipSize);

  const tabsBox = el('div', 'ida-tabs');
  const tabDefs: Array<[TabId, string]> = [
    ['pseudocode', '伪代码'], ['disasm', '反汇编'], ['xrefs', '交叉引用'],
    ['vars', '栈变量'], ['blocks', '基本块'],
  ];
  const tabNodes = new Map<TabId, HTMLButtonElement>();
  for (const [id, label] of tabDefs) {
    const t = document.createElement('button');
    t.type = 'button';
    t.className = 'ida-tab';
    t.dataset.tab = id;
    t.textContent = label;
    const cnt = el('span', 'cnt');
    cnt.dataset.count = id;
    t.appendChild(cnt);
    on(t, 'click', () => {
      state.tab = id;
      paintTabs();
      void render();
    });
    tabNodes.set(id, t);
    tabsBox.appendChild(t);
  }
  const view = el('div', 'ida-view');
  main.append(crumbs, tabsBox, view);

  // 左栏宽度可拖（侧栏 ↔ 主区）
  const splitterSide = createSplitter('x', 220, 720, '侧栏宽度');
  workarea.append(side, splitterSide, main);

  const statusbar = el('div', 'ida-status');
  const stHint = el('span', 'ida-grow dim');
  const stModule = el('span', ''); stModule.textContent = '—';
  const stBase = el('span', ''); stBase.textContent = '—';
  const stSel = el('span', ''); stSel.textContent = '未选择';
  const stPerm = el('span', ''); stPerm.textContent = '只读';
  statusbar.append(stModule, stBase, stSel, stPerm, stHint);

  const help = el('div', 'ida-help');
  const helpCard = el('div', 'ida-help-card');
  const helpTitle = document.createElement('h3');
  helpTitle.textContent = '键盘操作';
  const helpTable = document.createElement('table');
  const HELP_ROWS: Array<[string, string]> = [
    ['↑ ↓ 或 J K', '在函数列表中上下移动（自动加载该函数）'],
    ['1 … 5', '切换 伪代码 / 反汇编 / 交叉引用 / 栈变量 / 基本块'],
    ['/', '聚焦到函数搜索框'],
    ['Enter', '在搜索框内提交搜索'],
    ['G', '跳转到地址或函数名'],
    ['C', '复制当前视图内容'],
    ['?', '打开 / 关闭本帮助'],
    ['Esc', '关闭浮层'],
  ];
  for (const [keys, desc] of HELP_ROWS) {
    const tr = document.createElement('tr');
    const td1 = document.createElement('td');
    for (const part of keys.split(' ')) {
      const kbd = document.createElement('kbd');
      kbd.textContent = part;
      td1.append(kbd, document.createTextNode(' '));
    }
    const td2 = document.createElement('td');
    td2.textContent = desc;
    tr.append(td1, td2);
    helpTable.appendChild(tr);
  }
  const helpNote = el('p', 'ida-note');
  helpNote.textContent = '伪代码里的浅色小地址（例如 /*0x…*/）可以点击，直接跳到那个位置。';
  const btnHelpClose = btn('知道了');
  helpCard.append(helpTitle, helpTable, helpNote, btnHelpClose);
  help.appendChild(helpCard);

  root.replaceChildren(titlebar, toolbar, workarea, statusbar, help);

  function el(tag: string, className: string): HTMLElement {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }
  function btn(label: string, className = 'ida-btn'): HTMLButtonElement {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = className;
    node.textContent = label;
    return node;
  }

  // ===================== 分隔条：拖动调整面板尺寸 =====================
  // 竖向分隔条改宽度（用 clientX），横向分隔条改高度（用 clientY）。
  // 尺寸记在 localStorage，刷新后保留；双击或按 Home 复位。
  // 一次只可能拖一条，所以移动/抬起监听挂在 document 上、只注册一次。
  const PANEL_MIN = 120;
  type SplitTarget = 'side' | 'list';
  interface DragState {
    axis: 'x' | 'y';
    target: SplitTarget;
    startPos: number;
    startSize: number;
    min: number;
    max: number;
  }
  let drag: DragState | null = null;

  function panelNode(target: SplitTarget): HTMLElement {
    return target === 'side' ? side : list;
  }

  function currentPanelSize(target: SplitTarget): number {
    const node = panelNode(target);
    return target === 'side' ? node.getBoundingClientRect().width : node.getBoundingClientRect().height;
  }

  function storePanelSize(target: SplitTarget, size: number): void {
    try {
      localStorage.setItem(PANEL_SIZE_KEYS[target], String(Math.round(size)));
    } catch { /* 隐私模式等：不记住也能用 */ }
  }

  function applySize(target: SplitTarget, size: number): void {
    const node = panelNode(target);
    if (target === 'side') {
      node.style.flex = `0 0 ${size}px`;
      node.style.width = `${size}px`;
    } else {
      node.style.flex = `0 0 ${size}px`;
      node.style.height = `${size}px`;
    }
    storePanelSize(target, size);
  }

  function resetSize(target: SplitTarget): void {
    const node = panelNode(target);
    node.style.flex = '';
    node.style.width = '';
    node.style.height = '';
    try {
      localStorage.removeItem(PANEL_SIZE_KEYS[target]);
    } catch { /* 忽略 */ }
  }

  function restoreSizes(): void {
    for (const target of ['side', 'list'] as SplitTarget[]) {
      const saved = readStoredSize(target);
      if (saved !== null) applySize(target, saved);
    }
  }

  function readStoredSize(target: SplitTarget): number | null {
    try {
      const raw = localStorage.getItem(PANEL_SIZE_KEYS[target]);
      if (!raw) return null;
      const value = Number(raw);
      return Number.isFinite(value) && value >= PANEL_MIN ? value : null;
    } catch {
      return null;
    }
  }

  function createSplitter(
    axis: 'x' | 'y',
    min: number,
    max: number,
    label: string,
    target: SplitTarget = axis === 'x' ? 'side' : 'list',
  ): HTMLElement {
    const node = el('div', `ida-splitter is-${axis === 'x' ? 'vertical' : 'horizontal'}`);
    node.tabIndex = 0;
    node.setAttribute('role', 'separator');
    node.setAttribute('aria-orientation', axis === 'x' ? 'vertical' : 'horizontal');
    node.setAttribute('aria-label', `${label}（拖动或方向键调整，双击复位）`);
    node.title = `${label}：拖动调整，双击复位`;

    on(node, 'pointerdown', (event: PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      drag = {
        axis,
        target,
        startPos: axis === 'x' ? event.clientX : event.clientY,
        startSize: currentPanelSize(target),
        min,
        max,
      };
      node.classList.add('is-active');
      root.classList.add('is-resizing', `is-resizing-${axis}`);
    });
    on(node, 'dblclick', () => resetSize(target));
    on(node, 'keydown', (event: KeyboardEvent) => {
      const back = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
      const forward = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
      if (event.key === 'Home') {
        event.preventDefault();
        resetSize(target);
        return;
      }
      if (event.key !== back && event.key !== forward) return;
      event.preventDefault();
      const step = event.shiftKey ? 48 : 16;
      const next = currentPanelSize(target) + (event.key === forward ? step : -step);
      applySize(target, Math.min(max, Math.max(min, next)));
    });
    return node;
  }

  let activeSplitter: HTMLElement | null = null;
  on(document, 'pointermove', (event: PointerEvent) => {
    if (!drag) return;
    event.preventDefault();
    const pos = drag.axis === 'x' ? event.clientX : event.clientY;
    const size = drag.startSize + (pos - drag.startPos);
    applySize(drag.target, Math.min(drag.max, Math.max(drag.min, size)));
  });
  const endDrag = (): void => {
    if (!drag) return;
    drag = null;
    activeSplitter?.classList.remove('is-active');
    activeSplitter = null;
    root.classList.remove('is-resizing', 'is-resizing-x', 'is-resizing-y');
  };
  on(document, 'pointerup', endDrag);
  on(document, 'pointercancel', endDrag);
  // 记住是哪条在拖，抬起时好清理高亮
  on(document, 'pointerdown', (event: PointerEvent) => {
    const node = (event.target as HTMLElement | null)?.closest<HTMLElement>('.ida-splitter');
    activeSplitter = node ?? null;
  }, true);

  // ===================== 绘制：外壳 =====================
  function paintSideTabs(): void {
    for (const [id, node] of sideTabNodes) node.classList.toggle('is-active', id === state.side);
  }
  function paintTabs(): void {
    for (const [id, node] of tabNodes) {
      node.classList.toggle('is-active', id === state.tab);
      node.setAttribute('aria-selected', String(id === state.tab));
    }
  }
  function setTabCount(key: TabId, value: string | number): void {
    const node = tabsBox.querySelector<HTMLElement>(`[data-count="${key}"]`);
    if (node) node.textContent = value === '' || value === 0 ? '' : String(value);
  }
  function setChip(node: HTMLElement, text: string, tone?: string): void {
    node.textContent = text;
    if (tone) node.dataset.tone = tone;
  }
  function fmt(n: number | null | undefined): string {
    return typeof n === 'number' ? n.toLocaleString('zh-CN') : '?';
  }

  function paintChrome(): void {
    const moduleName = state.overview?.module ?? state.status?.module ?? '（未知模块）';
    appSub.textContent = state.status?.idb_path ?? '（未连接）';
    if (!state.status?.reachable) {
      setChip(chipMode, 'IDA 未连接', 'bad');
    } else {
      setChip(chipMode, `真实数据 · IDA 已连接`, 'ok');
    }
    setChip(
      chipHealth,
      state.status?.reachable
        ? `Hex-Rays ${state.status.hexrays_ready ? '就绪' : '未就绪'}`
        : '—',
      state.status?.reachable ? (state.status.hexrays_ready ? 'ok' : 'warn') : undefined,
    );
    setChip(chipPerm, state.permissions.can_write ? `可编辑（${state.permissions.role}）` : '只读');
    setChip(chipCount, `${state.functions.length} / ${fmt(state.overview?.total_functions)} 个函数`);
    btnRename.hidden = !state.permissions.can_write;
    btnRename.disabled = !state.permissions.can_write || state.selected < 0;

    stModule.textContent = moduleName;
    stBase.textContent = state.overview?.base_address ? `基址 ${state.overview.base_address}` : '—';
    stPerm.textContent = state.permissions.can_write ? '可编辑' : '只读';
    const cur = state.functions[state.selected];
    stSel.textContent = cur ? `选中 ${cur.addr}` : '未选择';
  }

  function paintMeta(): void {
    metaBox.replaceChildren();
    const overview = state.overview;
    let rows: Array<[string, string]>;
    if (state.side === 'strings') {
      rows = [['字符串', fmt(overview?.total_strings)], ['已加载', String(state.strings.length)]];
    } else if (state.side === 'segments') {
      rows = [['段数', String(state.segments.length)], ['架构', overview?.arch ? `${overview.arch} 位` : '?']];
    } else {
      rows = [
        ['模块', overview?.module ?? '（未知）'],
        ['函数', fmt(overview?.total_functions)],
        ['已命名', fmt(overview?.named_functions)],
        ['字符串', fmt(overview?.total_strings)],
        ['段', String(state.segments.length)],
        ['基址', overview?.base_address ?? '?'],
        ['架构', overview?.arch ? `${overview.arch} 位` : '?'],
      ];
    }
    for (const [k, v] of rows) {
      const row = el('div', 'ida-meta-row');
      const kk = el('span', 'k'); kk.textContent = k.padEnd(5, ' ');
      const vv = document.createElement('span'); vv.textContent = String(v);
      row.append(kk, vv);
      metaBox.appendChild(row);
    }
  }

  function notice(host: HTMLElement, title: string, detail: string): void {
    host.replaceChildren();
    const box = el('div', 'ida-notice');
    const strong = document.createElement('strong'); strong.textContent = title;
    const p = document.createElement('p'); p.textContent = detail;
    box.append(strong, p);
    host.appendChild(box);
  }
  function empty(text: string): HTMLElement {
    const node = el('div', 'ida-empty');
    node.textContent = text;
    return node;
  }

  // ===================== 数据访问 =====================
  async function guard<T>(fn: () => Promise<T>, onError?: (message: string) => void): Promise<T | null> {
    try {
      return await fn();
    } catch (error) {
      const message = error instanceof ApiError
        ? error.message
        : error instanceof Error ? error.message : '请求失败';
      if (onError) onError(message);
      else console.warn('[reverse]', message);
      return null;
    }
  }

  async function refreshAll(): Promise<void> {
    setChip(chipMode, '连接中…', 'warn');
    const perms = await guard(() => reverseApi.permissions());
    if (perms) state.permissions = perms;

    // 权限一旦确定，若会话与本地推断不一致就以服务端为准
    const status = await guard(() => reverseApi.status(state.port));
    state.status = status;

    if (!status || !status.reachable) {
      paintChrome();
      notice(
        view,
        '连接不上 IDA',
        status?.error ??
          '请确认 IDA Pro 已打开、已加载要分析的数据库，且 ida-pro-mcp 插件在运行（默认端口 13337）。后端必须与 IDA 在同一台机器上。',
      );
      notice(metaBox, '无数据', 'IDA 未连接时无法列出函数。');
      list.replaceChildren();
      stHint.textContent = status?.error ?? 'IDA 未连接';
      return;
    }

    // 首次成功连接时，若用户没手动选过实例，采用 MCP 当前实例的端口
    if (!state.portPinned && state.port === null && status.idb_path) {
      const instances = await guard(() => reverseApi.instances());
      if (instances && instances.length > 0) {
        state.instances = instances;
        const active = instances.find((i) => i.active && i.reachable) ?? instances.find((i) => i.reachable);
        if (active) state.port = active.port;
      }
    }

    await Promise.all([loadInstances(), loadOverview(), loadFunctions(true)]);
    paintMeta();
    paintChrome();
    paintMeta();
    stHint.textContent = `已连接 IDA（${status.module ?? 'IDB'}）`;
  }

  async function loadInstances(): Promise<void> {
    const list0 = await guard(() => reverseApi.instances());
    if (!list0) return;
    state.instances = list0;

    // 切换 IDA 实例是全局状态，只对管理员开放
    if (!state.permissions.can_write || list0.length <= 1) {
      instanceSel.hidden = true;
      instanceLabel.hidden = true;
      return;
    }
    instanceLabel.hidden = false;
    instanceSel.hidden = false;
    instanceSel.replaceChildren();
    for (const item of list0) {
      const option = document.createElement('option');
      option.value = String(item.port);
      option.textContent = `${item.binary ?? '未知'} · ${item.port}${item.reachable ? '' : '（不可达）'}`;
      option.selected = state.port === item.port;
      instanceSel.appendChild(option);
    }
  }

  async function loadOverview(): Promise<void> {
    const overview = await guard(() => reverseApi.overview(state.port));
    if (!overview) return;
    state.overview = overview;
    state.segments = overview.segments ?? [];
  }

  function visibleFunctions(): FunctionSummary[] {
    if (!state.filter) return state.functions;
    const needle = state.filter.toLowerCase().replace(/\*/g, '');
    return state.functions.filter((f) => f.name.toLowerCase().includes(needle));
  }

  async function loadFunctions(reset: boolean): Promise<void> {
    const offset = reset ? 0 : state.nextOffset ?? 0;
    const page = await guard(
      () => reverseApi.functions(state.port, offset, PAGE_SIZE, state.filter || undefined),
      (message) => notice(list, '加载失败', message),
    );
    if (!page) return;
    state.functions = reset ? page.items : [...state.functions, ...page.items];
    state.nextOffset = page.next_offset;
    if (reset) state.selected = page.items.length > 0 ? 0 : -1;
    // 只有用户还停在「函数」页签时才画列表：
    // 否则一次慢加载会把别的页签（字符串/段）覆盖成函数列表
    if (state.side !== 'funcs') return;
    paintFunctionList();
    paintMeta();
    if (state.selected >= 0) await render();
  }

  async function loadStrings(reset: boolean): Promise<void> {
    const offset = reset ? 0 : state.stringOffset;
    const result = await guard(
      () => reverseApi.searchStrings(state.port, state.stringPattern || DEFAULT_STRING_PATTERN, STRING_LIMIT, offset),
      (message) => {
        if (state.side === 'strings') notice(list, '字符串搜索失败', message);
      },
    );
    if (!result) return;
    const rows: StringRow[] = (result.matches as StringMatch[]).map((m) => ({ addr: m.addr, text: m.string }));
    state.strings = reset ? rows : [...state.strings, ...rows];
    state.stringOffset = offset + rows.length;
    state.stringsMore = rows.length >= STRING_LIMIT && state.strings.length < result.total;
    // 同理：用户可能已经切走了
    if (state.side !== 'strings') return;
    paintStringList();
    paintMeta();
  }

  // ===================== 绘制：左栏 =====================
  /**
   * 统一入口：只画当前页签该画的东西。
   * 各加载函数都调这里，避免「加载完成时用户已经切走了页签」导致
   * 列表被别的数据覆盖（曾经出现过：切到"段"后函数加载完成，200 行函数
   * 盖掉了 6 个段）。
   */
  function paintList(): void {
    if (state.side === 'funcs') paintFunctionList();
    else if (state.side === 'strings') paintStringList();
    else paintSegmentList();
  }

  function paintFunctionList(): void {
    list.replaceChildren();
    listHeadLabel.textContent = '地址 / 名称 / 大小';
    const items = visibleFunctions();
    listHeadCount.textContent = `${items.length} 项${state.filter ? '（已过滤）' : ''}`;
    btnMore.hidden = state.nextOffset === null || Boolean(state.filter);
    listFoot.hidden = false;

    if (items.length === 0) {
      list.appendChild(empty(state.filter ? `没有函数名匹配「${state.filter}」。` : '当前实例没有函数。'));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const fn of items) {
      const index = state.functions.indexOf(fn);
      const row = el('div', index === state.selected ? 'ida-row is-sel' : 'ida-row');
      row.setAttribute('role', 'option');
      const a = el('span', 'a'); a.textContent = fn.addr;
      const n = el('span', 'n'); n.textContent = fn.name;
      const s = el('span', 's'); s.textContent = fn.size ?? '';
      row.append(a, n, s);
      on(row, 'click', () => void selectIndex(index));
      frag.appendChild(row);
    }
    list.appendChild(frag);
  }

  function paintStringList(): void {
    list.replaceChildren();
    listHeadLabel.textContent = '地址 / 字符串';
    listHeadCount.textContent = `${state.strings.length} 条`;
    btnMore.hidden = !state.stringsMore;
    listFoot.hidden = false;
    if (state.strings.length === 0) {
      list.appendChild(empty(`没有匹配「${state.stringPattern}」的字符串。`));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const s of state.strings) {
      const row = el('div', 'ida-row');
      row.style.gridTemplateColumns = '110px 1fr';
      const a = el('span', 'a'); a.textContent = s.addr;
      const n = el('span', 'n'); n.textContent = s.text;
      n.title = s.text;
      row.append(a, n);
      on(row, 'click', () => void jumpTo(s.addr));
      frag.appendChild(row);
    }
    list.appendChild(frag);
  }

  function paintSegmentList(): void {
    list.replaceChildren();
    listHeadLabel.textContent = '段 / 范围';
    listHeadCount.textContent = `${state.segments.length} 个`;
    btnMore.hidden = true;
    listFoot.hidden = true;
    if (state.segments.length === 0) {
      list.appendChild(empty('没有段信息。'));
      return;
    }
    const frag = document.createDocumentFragment();
    for (const seg of state.segments) {
      const row = el('div', 'ida-row');
      row.style.gridTemplateColumns = '1fr auto';
      const n = el('span', 'n');
      n.textContent = `${seg.name}  ${seg.start} – ${seg.end}`;
      const s = el('span', 's');
      s.textContent = `${seg.permissions ?? ''}  ${seg.size}`;
      row.append(n, s);
      frag.appendChild(row);
    }
    list.appendChild(frag);
  }

  async function selectSide(id: SideId): Promise<void> {
    list.replaceChildren(empty('读取中…'));
    if (id === 'strings') await loadStrings(true);
    else paintList();
  }

  // ===================== 绘制：主区 =====================
  async function selectIndex(index: number): Promise<void> {
    if (index < 0 || index >= state.functions.length) return;
    state.selected = index;
    // 只在与当前页签匹配时重画列表（选中态需要更新）
    if (state.side === 'funcs') paintFunctionList();
    const row = list.querySelector<HTMLElement>(`.ida-row.is-sel`);
    row?.scrollIntoView({ block: 'nearest' });
    await render();
    paintChrome();
  }

  async function render(): Promise<void> {
    const fn = state.functions[state.selected];
    if (!fn) {
      fnName.textContent = '（未选择函数）';
      fnAt.textContent = '';
      chipSize.textContent = '';
      notice(view, '尚未选择函数', '在左侧列表里点一个函数，这里会显示它的内容。');
      for (const [id] of tabNodes) setTabCount(id, '');
      return;
    }

    fnName.textContent = fn.name;
    fnAt.textContent = fn.addr;
    chipSize.textContent = fn.size ? `${fn.size} 字节` : '';
    view.replaceChildren(empty('读取中…'));

    const addr = fn.addr;
    if (state.tab === 'pseudocode') await renderPseudocode(addr);
    else if (state.tab === 'disasm') await renderDisasm(addr);
    else if (state.tab === 'xrefs') await renderXrefs(addr);
    else if (state.tab === 'vars') await renderVars(addr);
    else await renderBlocks(addr);
  }

  async function renderPseudocode(addr: string): Promise<void> {
    const result = await guard(
      () => reverseApi.decompile(state.port, addr, true),
      (message) => notice(view, '反编译失败', message),
    );
    if (!result) return;
    if (!result.code) {
      setTabCount('pseudocode', '');
      notice(
        view,
        '没有伪代码',
        result.error ?? 'Hex-Rays 未能反编译这个函数（可能是数据或导入桩）。可查看「反汇编」选项卡。',
      );
      return;
    }
    const lines = result.code.split('\n');
    setTabCount('pseudocode', lines.length);
    const pre = el('pre', 'ida-code');
    lines.forEach((line, i) => {
      const row = el('div', 'ida-cl');
      const ln = el('span', 'ln'); ln.textContent = String(i + 1);
      const ct = el('span', 'ct');
      ct.appendChild(fragPseudo(line));
      row.append(ln, ct);
      pre.appendChild(row);
    });
    view.replaceChildren(pre);
  }

  async function renderDisasm(addr: string): Promise<void> {
    const result = await guard(
      () => reverseApi.disasm(state.port, addr),
      (message) => notice(view, '反汇编失败', message),
    );
    if (!result) return;
    if (result.lines.length === 0) {
      setTabCount('disasm', '');
      notice(view, '没有指令', '这个地址没有反汇编输出。');
      return;
    }
    setTabCount('disasm', result.lines.length);
    setTabCount('vars', result.stack_frame.length);
    const pre = el('pre', 'ida-code');
    for (const line of result.lines) {
      const row = el('div', 'ida-cl');
      const a = el('span', 'ln is-addr'); a.textContent = line.addr;
      const ct = el('span', 'ct');
      if (line.label) {
        const lbl = el('span', 'tok-lbl'); lbl.textContent = `${line.label}:`;
        ct.append(lbl, document.createTextNode(' '));
      }
      ct.appendChild(fragAsm(line.instruction));
      row.append(a, ct);
      pre.appendChild(row);
    }
    view.replaceChildren(pre);
  }

  async function renderXrefs(addr: string): Promise<void> {
    const [to, from, callees] = await Promise.all([
      guard(() => reverseApi.xrefs(state.port, addr, 'to')),
      guard(() => reverseApi.xrefs(state.port, addr, 'from')),
      guard(() => reverseApi.callees(state.port, addr)),
    ]);
    const toItems = to?.[0]?.xrefs ?? [];
    const fromItems = from?.[0]?.xrefs ?? [];
    const calleeItems = callees?.[0]?.callees ?? [];
    setTabCount('xrefs', toItems.length + fromItems.length + calleeItems.length);

    const cols = el('div', 'ida-cols');
    cols.append(
      refColumn(`被引用 · 谁调用了它（${toItems.length}）`, toItems, '无引用（可能是入口或被内联）'),
      refColumn(`引用 · 它引用了谁（${fromItems.length}）`, fromItems, '无'),
      refColumn(`调用的函数（${calleeItems.length}）`, calleeItems, '无'),
    );
    view.replaceChildren(cols);
  }

  function refColumn(
    title: string,
    items: Array<{ addr: string; name?: string | null; fn?: string | null; fn_name?: string | null; type?: string | null }>,
    emptyText: string,
  ): HTMLElement {
    const col = el('section', 'ida-col');
    const head = document.createElement('h4');
    head.textContent = title;
    col.appendChild(head);
    if (items.length === 0) {
      col.appendChild(empty(emptyText));
      return col;
    }
    for (const item of items) {
      const row = btn('', 'ida-ref');
      const a = el('span', 'ra'); a.textContent = item.addr;
      const n = el('span', 'rn'); n.textContent = item.name ?? item.fn_name ?? item.fn ?? '(未命名)';
      const t = el('span', 'rt'); t.textContent = item.type ?? '';
      row.append(a, n, t);
      on(row, 'click', () => void jumpTo(item.addr, item.name ?? item.fn_name ?? item.fn ?? undefined));
      col.appendChild(row);
    }
    return col;
  }

  async function renderVars(addr: string): Promise<void> {
    const result = await guard(
      () => reverseApi.disasm(state.port, addr, 0, 1),
      (message) => notice(view, '读取失败', message),
    );
    const frame = result?.stack_frame ?? [];
    setTabCount('vars', frame.length);
    if (frame.length === 0) {
      notice(view, '没有栈变量信息', '这个函数没有可显示的栈帧变量。');
      return;
    }
    const table = document.createElement('table');
    table.className = 'ida-table';
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const label of ['名称', '偏移', '大小', '类型']) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = label;
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    const tbody = document.createElement('tbody');
    for (const v of frame) {
      const tr = document.createElement('tr');
      for (const value of [v.name, v.offset ?? '', v.size ?? '', v.type ?? '']) {
        const td = document.createElement('td');
        td.textContent = value;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.append(thead, tbody);
    view.replaceChildren(table);
  }

  async function renderBlocks(addr: string): Promise<void> {
    const result = await guard(
      () => reverseApi.blocks(state.port, addr, 500),
      (message) => notice(view, '读取失败', message),
    );
    const group = result?.[0];
    const blocks = group?.blocks ?? [];
    setTabCount('blocks', blocks.length);
    if (blocks.length === 0) {
      notice(view, '没有基本块', '这个地址没有可显示的 CFG 基本块。');
      return;
    }
    const head = el('div', 'ida-listhead');
    head.textContent = `显示 ${blocks.length} 块 / 共 ${group?.total_blocks ?? blocks.length} 块`;
    const box = el('div', 'ida-blocks');
    for (const b of blocks) {
      const row = btn('', 'ida-blk');
      const a = document.createElement('span'); a.textContent = b.start;
      const e2 = el('span', 'bt'); e2.textContent = b.end ?? '';
      const sz = el('span', 'bt'); sz.textContent = b.size === null ? '' : `${b.size}B`;
      const su = el('span', 'bt');
      su.textContent = b.successors.length > 0 ? `→ ${b.successors.join(', ')}` : '（终止块）';
      row.append(a, e2, sz, su);
      on(row, 'click', () => void jumpTo(b.start));
      box.appendChild(row);
    }
    view.replaceChildren(head, box);
  }

  // ===================== 跳转 / 重命名 / 复制 =====================
  async function jumpTo(addr: string, name?: string): Promise<void> {
    const hex = addr.startsWith('0x') ? addr : `0x${addr}`;
    const norm = hex.toLowerCase();
    let index = state.functions.findIndex((f) => f.addr.toLowerCase() === norm);
    if (index === -1 && name) {
      index = state.functions.findIndex((f) => f.name === name);
    }
    // 不在当前页时向 IDA 解析一次，命中就插进列表，保持"跳过去能看见它"的手感
    if (index === -1) {
      const found = await guard(() => reverseApi.lookup(state.port, [name?.trim() || hex]));
      const hit = found?.[0];
      if (hit) {
        const existing = state.functions.findIndex((f) => f.addr === hit.addr);
        if (existing >= 0) index = existing;
        else {
          state.functions.push(hit);
          index = state.functions.length - 1;
        }
      }
    }
    if (index === -1) {
      // 代码中间的地址：作为临时条目查看
      state.functions.push({ addr: hex, name: `loc_${hex.slice(2).toUpperCase()}`, size: null });
      index = state.functions.length - 1;
      toast(`跳转到 ${hex}（不在函数入口，已作为位置查看）`);
    }
    await selectIndex(index);
  }

  // 伪代码里的行内地址注释（/*0xADDR*/）点击后跳转
  on(window, 'ida:jump', (event: CustomEvent<string>) => void jumpTo(event.detail));

  function currentViewText(): string {
    const fn = state.functions[state.selected];
    if (!fn) return '';
    return view.innerText ?? '';
  }

  async function copyView(): Promise<void> {
    const text = currentViewText().trim();
    if (!text) {
      toast('当前视图没有可复制的内容');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast(`已复制当前视图（${text.length} 字符）`);
    } catch {
      toast('复制失败：浏览器拒绝了剪贴板访问');
    }
  }

  async function renameCurrent(): Promise<void> {
    const fn = state.functions[state.selected];
    if (!fn) return;
    if (!state.permissions.can_write) {
      toast('只有管理员可以重命名函数');
      return;
    }
    const next = window.prompt(`把 ${fn.name} 重命名为：`, fn.name);
    if (!next || next === fn.name) return;
    const result = await guard(
      () => reverseApi.rename(state.port, fn.addr, next),
      (message) => toast(message),
    );
    if (!result) return;
    toast(`已重命名为 ${result.name}`);
    Object.assign(fn, { name: result.name });
    await selectIndex(state.selected);
  }

  // ===================== 交互绑定 =====================
  on(btnSearch, 'click', () => void runSearch());
  on(funcSearch, 'keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void runSearch();
    }
  });
  on(btnPrev, 'click', () => void selectIndex(state.selected - 1));
  on(btnNext, 'click', () => void selectIndex(state.selected + 1));
  on(btnCopy, 'click', () => void copyView());
  on(btnRename, 'click', () => void renameCurrent());
  on(btnMore, 'click', () => {
    if (state.side === 'strings') void loadStrings(false);
    else void loadFunctions(false);
  });
  on(btnHelp, 'click', () => help.classList.add('show'));
  on(btnHelpClose, 'click', () => help.classList.remove('show'));
  on(help, 'click', (event: MouseEvent) => {
    if (event.target === help) help.classList.remove('show');
  });
  on(instanceSel, 'change', () => {
    state.port = Number(instanceSel.value);
    state.portPinned = true;
    state.functions = [];
    state.nextOffset = null;
    state.selected = -1;
    notice(view, '已切换实例', '选择左侧函数开始查看。');
    void refreshAll();
  });

  async function runSearch(): Promise<void> {
    state.filter = funcSearch.value.trim();
    state.side = 'funcs';
    paintSideTabs();
    await loadFunctions(true);
    stHint.textContent = state.filter ? `过滤「${state.filter}」：${visibleFunctions().length} 项` : '就绪';
  }

  on(document, 'keydown', (event: KeyboardEvent) => {
    const active = document.activeElement;
    const typing = active instanceof HTMLElement &&
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName);

    if (event.key === 'Escape') {
      help.classList.remove('show');
      if (typing) active.blur();
      return;
    }
    if (event.key === '?' && !typing) {
      event.preventDefault();
      help.classList.toggle('show');
      return;
    }
    if (typing) return;

    if (event.key === 'ArrowDown' || event.key === 'j' || event.key === 'J') {
      event.preventDefault();
      void selectIndex(state.selected + 1);
    } else if (event.key === 'ArrowUp' || event.key === 'k' || event.key === 'K') {
      event.preventDefault();
      void selectIndex(state.selected - 1);
    } else if (event.key === '/') {
      event.preventDefault();
      funcSearch.focus();
    } else if (event.key === 'c' || event.key === 'C') {
      void copyView();
    } else if (event.key === 'g' || event.key === 'G') {
      const q = window.prompt('跳转到地址或函数名：', 'main');
      if (q) void jumpTo(q.trim(), q.trim());
    } else if (['1', '2', '3', '4', '5'].includes(event.key)) {
      state.tab = (['pseudocode', 'disasm', 'xrefs', 'vars', 'blocks'] as TabId[])[Number(event.key) - 1]!;
      paintTabs();
      void render();
    }
  });

  // 会话变化（登录/退出）→ 权限与实例选择器重新计算
  on(window, SESSION_EVENT, () => void refreshAll());

  // ===================== 启动 =====================
  restoreSizes();          // 应用用户上次拖动保存的面板尺寸
  paintSideTabs();
  paintTabs();
  paintChrome();

  // AI 助手悬浮窗：访客也能用，配额由服务端判定（每 5 小时 3 轮）
  disposers.push(mountAiPanel(root as HTMLElement, {
    getContext: () => {
      const fn = state.functions[state.selected];
      return {
        module: state.overview?.module ?? state.status?.module ?? null,
        base_address: state.overview?.base_address ?? null,
        selected_name: fn?.name ?? null,
        selected_addr: fn?.addr ?? null,
        total_functions: state.overview?.total_functions ?? null,
      };
    },
    getPort: () => state.port,
    onJump: (addr) => void jumpTo(addr),
  }));

  void (async () => {
    const session = await currentSession().catch(() => null);
    if (session) {
      state.permissions = {
        role: session.role,
        can_write: session.role === 'admin' || session.role === 'superadmin',
      };
      paintChrome();
    }
    await refreshAll();
  })();

  return () => {
    for (const dispose of disposers) dispose();
    disposers.length = 0;
  };
}

// ===================== 语法着色 =====================
// 目标可读而非完整着色：注释 / 字符串 / 数字 / 关键字 / 函数名；
// 反汇编再分助记符与寄存器。全部走 textContent，不用 innerHTML。

const PSEUDO_RE = /(\/\*0x[0-9a-fA-F]+\*\/)|(\/\/[^\n]*)|("(?:[^"\\]|\\.)*")|\b(0x[0-9a-fA-F]+|\d+)\b|([A-Za-z_~][A-Za-z0-9_:<>~]*)\s*(?=\()|\b(if|else|while|for|return|switch|case|break|continue|do|goto|sizeof|void|int|char|bool|unsigned|signed|long|short|float|double|struct|class|const|static|extern|__int8|__int16|__int32|__int64|__int128|_BYTE|_WORD|_DWORD|_QWORD|_OWORD|__fastcall|__cdecl|__stdcall)\b/g;

const ASM_RE = /(0x[0-9a-fA-F]+|\b[0-9a-fA-F]+h\b)|(\b(mov|movups|movsd|movss|movzx|movsx|lea|call|jmp|jz|jnz|je|jne|jg|jl|jge|jle|ja|jb|jae|jbe|js|jns|push|pop|sub|add|adc|sbb|xor|xorps|and|or|not|neg|cmp|test|ret|retn|nop|inc|dec|imul|mul|idiv|div|shl|shr|sar|rol|ror|cmovz|cmovnz|setz|setnz|ucomiss|comiss|cdqe|movsxd|rep|stosb|stosd|stosq|leave|enter|int3|ud2)\b)|(\b(r[a-d]x|r[a-d]i|r[a-d]p|r[a-d]s|r[89]|r1[0-5]|e[a-d]x|ebx|ecx|edx|esi|edi|esp|ebp|eax|al|ah|bl|bh|cl|dl|ax|bx|cx|dx|xmm\d+|ymm\d+|zmm\d+|cs|ds|es|fs|gs|ss|rsp|rbp)\b)/gi;

function fragPseudo(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const match of text.matchAll(PSEUDO_RE)) {
    const index = match.index ?? 0;
    if (index > last) frag.appendChild(document.createTextNode(text.slice(last, index)));
    const [raw, addrComment, comment, string, number, fnCall, keyword] = match;
    if (addrComment) {
      frag.appendChild(addrButton(raw.slice(2, -2)));
    } else if (comment) frag.appendChild(span('tok-c', raw));
    else if (string) frag.appendChild(span('tok-s', raw));
    else if (number) frag.appendChild(span('tok-n', raw));
    else if (fnCall) frag.appendChild(span('tok-fn', raw));
    else if (keyword) frag.appendChild(span('tok-k', raw));
    else frag.appendChild(document.createTextNode(raw));
    last = index + raw.length;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

function fragAsm(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const match of text.matchAll(ASM_RE)) {
    const index = match.index ?? 0;
    if (index > last) frag.appendChild(document.createTextNode(text.slice(last, index)));
    const raw = match[0];
    frag.appendChild(span(match[1] ? 'tok-n' : match[2] ? 'tok-m' : 'tok-r', raw));
    last = index + raw.length;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

function span(className: string, text: string): HTMLElement {
  const node = document.createElement('span');
  node.className = className;
  node.textContent = text;
  return node;
}

/** 行内地址注释按钮：派发事件，由工作台自己监听（避免全局单例耦合）。 */
function addrButton(addr: string): HTMLElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = 'ida-addr';
  node.textContent = addr;
  node.title = `跳转到 ${addr}`;
  node.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('ida:jump', { detail: addr }));
  });
  return node;
}
