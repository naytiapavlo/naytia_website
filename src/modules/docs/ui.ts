/**
 * 文档树界面（/docs/）：访客阅读、管理员投稿、超管审核。
 *
 * 三种身份看到的是**同一个界面**，差别只在侧栏底部与正文上方多出来的控件：
 * - 访客 / 会员：目录树 + 正文 + 搜索。没有任何写入口。
 * - 管理员（admin）：多出「管理」面板——上传文件、新建文件夹、提交变更单、
 *   查看自己的投稿状态。注意：管理员提交后**不能**自己发布。
 * - 超级管理员（superadmin）：多出「待审队列」，批准 / 驳回后才真正公开。
 *
 * 权限只在服务端强制（见 backend/app/routers/docs.py）；这里隐藏控件只是
 * 不给用户「点了报 403」的坏体验，不作为安全边界。
 */
import { toast } from '../../shared/toast';
import {
  ACTION_LABELS,
  FORMAT_LABELS,
  STATUS_LABELS,
  VISIBILITY_LABELS,
  docsApi,
  uploadFile,
  type DocsPermissions,
  type DocumentDetail,
  type DocumentOut,
  type FolderNode,
  type SubmissionOut,
  type TreeResponse,
  type Visibility,
} from './api';
import { renderDocument } from './markdown';

const STAFF_ROLES = new Set(['admin', 'superadmin']);

interface ViewState {
  /** 目录树整体（含 stats）；每次审核通过后重拉一次 */
  tree: TreeResponse | null;
  permissions: DocsPermissions | null;
  byId: Map<number, DocumentOut>;
  /** 路径（'代码机制分析/12 ...'）-> 文档，供正文里的相对链接互跳 */
  byPath: Map<string, DocumentOut>;
  current: DocumentDetail | null;
  /** 当前文档所在目录的路径，用于解析正文里的相对链接 */
  currentFolderPath: string;
  expanded: Set<number>;
  activeId: number | null;
}

interface Elements {
  tree: HTMLElement;
  stats: HTMLElement;
  breadcrumb: HTMLElement;
  doc: HTMLElement;
  toc: HTMLElement;
  searchForm: HTMLFormElement;
  searchInput: HTMLInputElement;
  searchResults: HTMLElement;
  sidebarExtra: HTMLElement;
  mainExtra: HTMLElement;
}

/**
 * 最近一次挂载的状态与 DOM 引用。
 *
 * 审核通过后需要重拉目录树并刷新管理面板，而这一步发生在事件回调深处；
 * 与其把 state/elements 沿着每一层函数往下传，不如在挂载时记录一次——
 * 文档页同一时刻只会有一个实例（页面脚本只挂一次），这个假设是安全的。
 */
let lastState: ViewState | null = null;
let lastElements: Elements | null = null;

export function initDocsView(root: HTMLElement): () => void {
  const state: ViewState = {
    tree: null,
    permissions: null,
    byId: new Map(),
    byPath: new Map(),
    current: null,
    currentFolderPath: '',
    expanded: new Set(),
    activeId: null,
  };

  const el = buildSkeleton(root);
  lastState = state;
  lastElements = el;
  const isStaff = (): boolean => STAFF_ROLES.has(state.permissions?.role ?? '');
  const isSuperadmin = (): boolean => state.permissions?.role === 'superadmin';

  // 正文区域的点击代理：站内文档链接走 SPA 跳转，不整页刷新
  el.doc.addEventListener('click', (event) => {
    const link = (event.target as HTMLElement | null)?.closest<HTMLAnchorElement>(
      'a.docs-internal-link',
    );
    if (!link) return;
    event.preventDefault();
    const id = Number(link.dataset.docId);
    if (Number.isFinite(id)) void openDocument(id, el, state);
  });

  // 搜索：回车即搜（不做输入即搜——服务端搜索是子串匹配，逐字查没意义）
  el.searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void runSearch(el, state);
  });

  const onHashChange = (): void => void applyHash(el, state);
  window.addEventListener('hashchange', onHashChange);

  void bootstrap(el, state, isStaff, isSuperadmin);

  return () => {
    window.removeEventListener('hashchange', onHashChange);
    lastState = null;
    lastElements = null;
    root.replaceChildren();
  };
}

// ----------------------------------------------------------------- 骨架

function buildSkeleton(root: HTMLElement): Elements {
  root.replaceChildren();
  root.classList.add('docs-root');

  const nav = document.createElement('aside');
  nav.className = 'docs-nav';

  const searchForm = document.createElement('form');
  searchForm.className = 'docs-search';
  searchForm.setAttribute('role', 'search');
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.placeholder = '搜索标题与正文…';
  searchInput.setAttribute('aria-label', '搜索文档');
  const searchButton = document.createElement('button');
  searchButton.type = 'submit';
  searchButton.textContent = '搜索';
  searchForm.append(searchInput, searchButton);

  const navHead = document.createElement('div');
  navHead.className = 'docs-nav-head';
  navHead.innerHTML = '<span>目录</span><button type="button" class="docs-nav-toggle-all">收起全部</button>';
  const toggleAll = navHead.querySelector<HTMLButtonElement>('.docs-nav-toggle-all')!;

  const tree = document.createElement('nav');
  tree.className = 'docs-tree';
  tree.setAttribute('aria-label', '文档目录');

  const stats = document.createElement('p');
  stats.className = 'docs-stats';

  const sidebarExtra = document.createElement('div');
  sidebarExtra.className = 'docs-sidebar-extra';

  nav.append(searchForm, navHead, tree, stats, sidebarExtra);

  const article = document.createElement('section');
  article.className = 'docs-article';

  const breadcrumb = document.createElement('nav');
  breadcrumb.className = 'docs-breadcrumb';
  breadcrumb.setAttribute('aria-label', '当前位置');

  const searchResults = document.createElement('div');
  searchResults.className = 'docs-search-results';
  searchResults.hidden = true;

  const mainExtra = document.createElement('div');
  mainExtra.className = 'docs-main-extra';

  const doc = document.createElement('article');
  doc.className = 'docs-doc';
  doc.setAttribute('aria-live', 'polite');

  const toc = document.createElement('nav');
  toc.className = 'docs-toc';
  toc.setAttribute('aria-label', '本页目录');
  toc.hidden = true;

  article.append(breadcrumb, searchResults, mainExtra, doc, toc);
  root.append(nav, article);

  toggleAll.addEventListener('click', () => {
    if (!lastState || !lastElements) return;
    const state = lastState;
    const collapsing = toggleAll.textContent?.includes('收起') ?? false;
    if (collapsing) state.expanded.clear();
    else collectFolderIds(state.tree?.root ?? null).forEach((id) => state.expanded.add(id));
    renderTree(lastElements, state);
    toggleAll.textContent = collapsing ? '展开全部' : '收起全部';
  });

  return { tree, stats, breadcrumb, doc, toc, searchForm, searchInput, searchResults,
    sidebarExtra, mainExtra };
}

// ----------------------------------------------------------------- 启动

async function bootstrap(
  el: Elements,
  state: ViewState,
  isStaff: () => boolean,
  isSuperadmin: () => boolean,
): Promise<void> {
  el.doc.append(notice('正在加载文档目录…'));
  try {
    const [permissions, tree] = await Promise.all([docsApi.permissions(), docsApi.tree()]);
    state.permissions = permissions;
    state.tree = tree;
    renderTree(el, state);
    renderFooter(el, state, isStaff, isSuperadmin);
  } catch (error) {
    el.doc.replaceChildren(
      notice(
        '暂时读不到文档目录',
        '可能是后端服务没有启动。文档页依赖站内 API；服务恢复后刷新即可。',
      ),
    );
    el.stats.textContent = '后端不可用';
    console.warn('[docs] 目录加载失败', error);
    return;
  }

  if (isStaff()) void mountManagePanel(el, state, isSuperadmin);
  await applyHash(el, state);
}

async function applyHash(el: Elements, state: ViewState): Promise<void> {
  const hash = window.location.hash;
  const manage = /^#\/?manage\b/.exec(hash);
  if (manage) {
    document.querySelector('.docs-manage-panel')?.scrollIntoView({ block: 'start' });
    return;
  }
  const match = /^#\/doc\/(\d+)/.exec(hash);
  if (match) {
    await openDocument(Number(match[1]), el, state);
    return;
  }
  if (state.current === null) showWelcome(el, state);
}

// ----------------------------------------------------------------- 目录树

function renderTree(el: Elements, state: ViewState): void {
  const tree = state.tree;
  if (!tree) return;
  state.byId.clear();
  state.byPath.clear();
  indexTree(tree.root, state);
  if (state.expanded.size === 0) expandTo(tree.root, state.expanded, 1);

  el.tree.replaceChildren(...treeNode(tree.root, el, state, 0));
  const stats = tree.stats;
  el.stats.textContent =
    `${stats.folders} 个文件夹 · ${stats.documents} 篇文档 · ${formatBytes(stats.total_bytes)}` +
    (stats.published_documents < stats.documents
      ? `（其中 ${stats.documents - stats.published_documents} 篇未公开，仅你和超管可见）`
      : '');
}

function indexTree(node: FolderNode, state: ViewState): void {
  for (const document of node.documents) {
    state.byId.set(document.id, document);
    state.byPath.set(`${node.path}/${document.file.name}`, document);
    state.byPath.set(`${node.path}/${document.slug}`, document);
  }
  for (const child of node.children) indexTree(child, state);
}

function expandTo(node: FolderNode, expanded: Set<number>, depth: number): void {
  if (depth > 1) return;
  for (const child of node.children) {
    expanded.add(child.id);
    expandTo(child, expanded, depth + 1);
  }
}

function collectFolderIds(node: FolderNode | null, out: number[] = []): number[] {
  if (!node) return out;
  for (const child of node.children) {
    out.push(child.id);
    collectFolderIds(child, out);
  }
  return out;
}

const WELCOME_LIMIT = 8;

function showWelcome(el: Elements, state: ViewState): void {
  const tree = state.tree;
  el.breadcrumb.replaceChildren();
  el.toc.hidden = true;
  el.doc.replaceChildren();
  if (!tree) return;

  // 管理员/超管进页面时正文区上方已经有管理面板了，再摆一遍大标题与目录卡片
  // 只会把「该读的文档」挤到下面去，所以这里只给一句引导。
  if (document.querySelector('.docs-manage-panel')) {
    el.doc.appendChild(
      notice('从左边挑一篇开始读', '待审的提交单在下面；上传文件、新建文件夹也在这个页面上。'),
    );
    return;
  }

  const head = document.createElement('header');
  head.className = 'docs-welcome';
  const title = document.createElement('h1');
  title.textContent = '文档树';
  const lead = document.createElement('p');
  lead.textContent =
    '基岩版机制研究、漏洞分析与逆向笔记的合集：左边是目录，也可以直接搜索标题与正文。' +
    '所有人都能读；管理员上传的新内容要等站长审核通过后才出现在这里。';
  head.append(title, lead);

  const grid = document.createElement('div');
  grid.className = 'docs-welcome-grid';
  for (const folder of tree.root.children) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'docs-welcome-card';
    const name = document.createElement('strong');
    name.textContent = folder.name;
    const meta = document.createElement('small');
    const count = countDocuments(folder);
    meta.textContent = `${count} 篇` + (folder.children.length ? ` · ${folder.children.length} 个子目录` : '');
    card.append(name, meta);
    card.addEventListener('click', () => {
      state.expanded.add(folder.id);
      el.tree.replaceChildren(...treeNode(tree.root, el, state, 0));
      const target = firstDocument(folder);
      if (target) void openDocument(target.id, el, state);
    });
    grid.appendChild(card);
  }

  const recent = tree.root.documents.slice(0, WELCOME_LIMIT);
  el.doc.append(head, grid);
  if (recent.length > 0) {
    const list = document.createElement('ul');
    list.className = 'docs-recent';
    for (const entry of recent) {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = `#/doc/${entry.id}`;
      link.textContent = entry.title;
      link.addEventListener('click', (event) => {
        event.preventDefault();
        void openDocument(entry.id, el, state);
      });
      item.appendChild(link);
      list.appendChild(item);
    }
    const heading = document.createElement('h2');
    heading.textContent = '根目录下的文档';
    el.doc.append(heading, list);
  }
}

function countDocuments(folder: FolderNode): number {
  return (
    folder.documents.length + folder.children.reduce((sum, child) => sum + countDocuments(child), 0)
  );
}

function firstDocument(folder: FolderNode): DocumentOut | undefined {
  if (folder.documents.length > 0) return folder.documents[0];
  for (const child of folder.children) {
    const found = firstDocument(child);
    if (found) return found;
  }
  return undefined;
}

function treeNode(node: FolderNode, el: Elements, state: ViewState, depth: number): Node[] {
  const nodes: Node[] = [];

  for (const child of node.children) {
    const wrapper = document.createElement('div');
    wrapper.className = 'docs-tree-folder';

    const row = document.createElement('div');
    row.className = 'docs-tree-row';
    row.style.paddingLeft = `${6 + depth * 12}px`;

    const isOpen = state.expanded.has(child.id);
    const caret = document.createElement('button');
    caret.type = 'button';
    caret.className = 'docs-caret';
    caret.setAttribute('aria-expanded', String(isOpen));
    caret.setAttribute('aria-label', `${isOpen ? '折叠' : '展开'}${child.name}`);
    caret.textContent = isOpen ? '▾' : '▸';

    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'docs-folder-name';
    label.textContent = child.name;
    const count = countDocuments(child);
    const badge = document.createElement('span');
    badge.className = 'docs-count';
    badge.textContent = String(count);
    label.appendChild(badge);

    row.append(caret, label);

    // 整理入口（仅 staff 可见）：移动 / 重命名 / 删除文件夹
    const canOrganize = state.permissions?.can_organize === true;
    if (canOrganize) {
      const tools = document.createElement('button');
      tools.type = 'button';
      tools.className = 'docs-tree-tools';
      tools.textContent = '⋯';
      tools.title = `整理「${child.name}」：移动 / 重命名 / 删除`;
      tools.setAttribute('aria-label', tools.title);
      tools.addEventListener('click', async (event) => {
        event.stopPropagation();
        const action = await openModal(
          `整理文件夹「${child.name}」`,
          [
            {
              name: 'action',
              label: '要做什么',
              type: 'select',
              value: 'move',
              options: [
                { value: 'move', label: '移动到别的目录…' },
                { value: 'rename', label: '重命名…' },
                { value: 'delete', label: `删除（含 ${countDocuments(child)} 篇文档）…` },
              ],
            },
          ],
          '继续',
          isDirect(state.permissions)
            ? '你是超级管理员：下一步确认后立即生效。'
            : '你是管理员：移动与删除会作为申请提交，等超管审核。',
        );
        if (!action) return;
        if (action.action === 'move') return moveFolderFlow(state.permissions, child, el, state);
        if (action.action === 'rename') return renameFolderFlow(state.permissions, child, el, state);
        return deleteFolderFlow(state.permissions, child, el, state);
      });
      row.appendChild(tools);
    }
    wrapper.appendChild(row);

    caret.addEventListener('click', (event) => {
      event.stopPropagation();
      if (state.expanded.has(child.id)) state.expanded.delete(child.id);
      else state.expanded.add(child.id);
      el.tree.replaceChildren(...treeNode(state.tree!.root, el, state, 0));
    });

    const body = document.createElement('div');
    body.className = 'docs-tree-children';
    body.hidden = !isOpen;
    body.append(...treeNode(child, el, state, depth + 1));
    wrapper.appendChild(body);

    nodes.push(wrapper);
  }

  for (const entry of node.documents) {
    // 每篇文档一行：主体是「打开」按钮，staff 额外拿到一个「整理」按钮。
    // 用 flex 行包住，而不是把 ⋯ 塞进按钮里——按钮套按钮是无效 HTML。
    const row = document.createElement('div');
    row.className = 'docs-tree-doc-row';

    const link = document.createElement('button');
    link.type = 'button';
    link.className = 'docs-tree-doc';
    link.style.paddingLeft = `${22 + depth * 12}px`;
    link.dataset.docId = String(entry.id);
    if (state.activeId === entry.id) link.classList.add('is-active');
    if (!entry.published) link.classList.add('is-draft');

    const icon = document.createElement('span');
    icon.className = `docs-fmt docs-fmt-${entry.doc_format}`;
    icon.textContent = entry.doc_format === 'md' ? 'M' : entry.doc_format === 'json' ? '{}' : 'T';
    const title = document.createElement('span');
    title.className = 'docs-tree-title';
    title.textContent = entry.title;
    link.append(icon, title);
    if (!entry.published) {
      const draft = document.createElement('span');
      draft.className = 'docs-draft-badge';
      draft.textContent = '草稿';
      link.appendChild(draft);
    }
    link.title = entry.file.name;

    link.addEventListener('click', () => void openDocument(entry.id, el, state));
    row.appendChild(link);

    if (state.permissions?.can_organize === true) {
      const tools = document.createElement('button');
      tools.type = 'button';
      tools.className = 'docs-tree-tools';
      tools.textContent = '⋯';
      tools.title = `整理《${entry.title}》：移动 / 删除`;
      tools.setAttribute('aria-label', tools.title);
      tools.addEventListener('click', async (event) => {
        event.stopPropagation();
        const action = await openModal(
          `整理《${entry.title}》`,
          [
            {
              name: 'action',
              label: '要做什么',
              type: 'select',
              value: 'move',
              options: [
                { value: 'move', label: '移动到别的文件夹…' },
                { value: 'delete', label: '删除这篇文档…' },
              ],
            },
          ],
          '继续',
          isDirect(state.permissions)
            ? '你是超级管理员：下一步确认后立即生效。'
            : '你是管理员：会作为申请提交，等超管审核。',
        );
        if (!action) return;
        const detail = await docsApi.document(entry.id).catch(() => null);
        if (!detail) {
          toast('读不到这篇文档');
          return;
        }
        if (action.action === 'move') return moveDocumentFlow(state.permissions, detail, el, state);
        return deleteDocumentFlow(state.permissions, detail, el, state);
      });
      row.appendChild(tools);
    }

    nodes.push(row);
  }

  return nodes;
}

// ----------------------------------------------------------------- 正文

async function openDocument(id: number, el: Elements, state: ViewState): Promise<void> {
  el.searchResults.hidden = true;
  el.doc.replaceChildren(notice('正在读取正文…'));
  let detail: DocumentDetail;
  try {
    detail = await docsApi.document(id);
  } catch (error) {
    el.doc.replaceChildren(
      notice('读不到这篇文档', error instanceof Error ? error.message : '未知错误'),
    );
    return;
  }

  state.current = detail;
  state.activeId = id;
  if (window.location.hash !== `#/doc/${id}`) {
    history.replaceState(null, '', `#/doc/${id}`);
  }
  el.tree.querySelectorAll('.docs-tree-doc').forEach((node) => {
    node.classList.toggle('is-active', (node as HTMLElement).dataset.docId === String(id));
  });

  renderBreadcrumb(el, state, detail);
  renderArticle(el, state, detail);
}

function renderBreadcrumb(el: Elements, state: ViewState, detail: DocumentDetail): void {
  el.breadcrumb.replaceChildren();
  const home = document.createElement('button');
  home.type = 'button';
  home.className = 'docs-crumb';
  home.textContent = '文档树';
  home.addEventListener('click', () => {
    state.current = null;
    state.activeId = null;
    history.replaceState(null, '', '#/');
    showWelcome(el, state);
    el.tree.querySelectorAll('.docs-tree-doc').forEach((n) => n.classList.remove('is-active'));
  });
  el.breadcrumb.appendChild(home);

  const folder = findFolder(state.tree?.root ?? null, detail.parent_id);
  if (folder?.path) {
    for (const segment of folder.path.split('/')) {
      const sep = document.createElement('span');
      sep.className = 'docs-crumb-sep';
      sep.textContent = '/';
      const label = document.createElement('span');
      label.textContent = segment;
      el.breadcrumb.append(sep, label);
    }
  }
  const sep = document.createElement('span');
  sep.className = 'docs-crumb-sep';
  sep.textContent = '/';
  const here = document.createElement('strong');
  here.textContent = detail.title;
  el.breadcrumb.append(sep, here);
  state.currentFolderPath = folder?.path ?? '';
}

function findFolder(node: FolderNode | null, id: number | null): FolderNode | null {
  if (!node || id === null) return null;
  if (node.id === id) return node;
  for (const child of node.children) {
    const found = findFolder(child, id);
    if (found) return found;
  }
  return null;
}

function renderArticle(el: Elements, state: ViewState, detail: DocumentDetail): void {
  const header = document.createElement('header');
  header.className = 'docs-doc-head';

  const title = document.createElement('h1');
  title.textContent = detail.title;
  header.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'docs-doc-meta';
  meta.append(
    chip(FORMAT_LABELS[detail.doc_format]),
    chip(VISIBILITY_LABELS[detail.visibility]),
    chip(`v${detail.revision_no}`),
    chip(formatBytes(detail.byte_size)),
    chip(`更新于 ${formatDate(detail.updated_at)}`),
  );
  if (!detail.published) {
    const draftChip = chip('草稿 · 尚未公开');
    draftChip.classList.add('is-warn');
    meta.appendChild(draftChip);
  }
  header.appendChild(meta);

  if (detail.summary) {
    const summary = document.createElement('p');
    summary.className = 'docs-doc-summary';
    summary.textContent = detail.summary;
    header.appendChild(summary);
  }

  const actions = document.createElement('div');
  actions.className = 'docs-doc-actions';
  const download = document.createElement('a');
  download.className = 'docs-btn';
  download.href = docsApi.downloadUrl(detail.file.id);
  download.textContent = `下载原文件（${detail.file.name}）`;
  actions.appendChild(download);
  if (detail.doc_format !== 'md') {
    const raw = document.createElement('a');
    raw.className = 'docs-btn docs-btn-ghost';
    raw.href = docsApi.contentUrl(detail.file.id, 'inline');
    raw.target = '_blank';
    raw.rel = 'noopener';
    raw.textContent = '在新标签页看原始文本';
    actions.appendChild(raw);
  }
  const permission = state.permissions;
  if (permission?.can_organize) {
    const move = document.createElement('button');
    move.type = 'button';
    move.className = 'docs-btn docs-btn-ghost';
    move.textContent = '移动到…';
    move.addEventListener('click', () => void moveDocumentFlow(state.permissions, detail, el, state));
    actions.appendChild(move);

    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'docs-btn docs-btn-ghost';
    rename.textContent = '改标题';
    rename.addEventListener('click', () => void renameDocumentFlow(state.permissions, detail, el, state));
    actions.appendChild(rename);
  }
  if (permission?.can_delete) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'docs-btn docs-btn-ghost docs-btn-danger';
    remove.textContent = isDirect(state.permissions) ? '删除这篇' : '申请删除这篇';
    remove.addEventListener('click', () => void deleteDocumentFlow(state.permissions, detail, el, state));
    actions.appendChild(remove);
  }
  header.appendChild(actions);

  const body = document.createElement('div');
  body.className = 'docs-body';
  const rendered = renderDocument(detail.body, {
    format: detail.doc_format,
    resolveDocLink: (href) => resolveDocLink(href, state, detail),
  });
  body.append(...rendered.nodes);

  el.doc.replaceChildren(header, body);
  renderToc(el, rendered.headings);
  el.doc.scrollIntoView({ block: 'nearest' });
}

function resolveDocLink(href: string, state: ViewState, detail: DocumentDetail): number | undefined {
  if (/^[a-z]+:/i.test(href) || href.startsWith('#') || href.startsWith('/')) return undefined;
  const clean = decodeURIComponent(href.split('#')[0].split('?')[0]);
  const candidate = state.byPath.get(`${state.currentFolderPath}/${clean}`);
  if (candidate && candidate.id !== detail.id) return candidate.id;
  const byName = [...state.byId.values()].find((doc) => doc.file.name === clean);
  return byName && byName.id !== detail.id ? byName.id : undefined;
}

function renderToc(el: Elements, headings: { level: number; text: string; id: string }[]): void {
  const useful = headings.filter((heading) => heading.level <= 3);
  if (useful.length < 3) {
    el.toc.hidden = true;
    return;
  }
  el.toc.hidden = false;
  const title = document.createElement('p');
  title.className = 'docs-toc-title';
  title.textContent = '本页目录';
  const list = document.createElement('ul');
  for (const heading of useful) {
    const item = document.createElement('li');
    item.style.paddingLeft = `${(heading.level - 1) * 10}px`;
    const link = document.createElement('a');
    link.href = `#${heading.id}`;
    link.textContent = heading.text;
    link.addEventListener('click', (event) => {
      event.preventDefault();
      document.getElementById(heading.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    item.appendChild(link);
    list.appendChild(item);
  }
  el.toc.replaceChildren(title, list);
}

// ----------------------------------------------------------------- 整理目录：移动 / 重命名 / 删除

/**
 * 超管直接生效，管理员走提交单。
 *
 * 两种身份的按钮文案与结果都不同，但**没有两条实现**：这里只决定「调哪个接口」，
 * 移动 / 重命名 / 删除的真正逻辑在服务端同一批函数里（review_flow / direct_actions）。
 */
function isDirect(permissions: DocsPermissions | null): boolean {
  return permissions?.can_publish_directly === true;
}

interface FolderChoice {
  value: string;
  label: string;
  disabled?: boolean;
}

/** 文件夹下拉选项：扁平化整棵树，深度用全角空格缩进（原生 select 不支持层级）。 */
function folderChoices(
  tree: TreeResponse | null,
  options: { excludeSubtreeOf?: number; excludeCurrent?: number | null } = {},
): FolderChoice[] {
  const out: FolderChoice[] = [{ value: '', label: '（根目录）' }];
  const walk = (node: FolderNode, depth: number): void => {
    for (const child of node.children) {
      const blocked = options.excludeSubtreeOf === child.id;
      out.push({
        value: String(child.id),
        label: `${'　'.repeat(depth)}${child.name}${blocked ? '（不能选：它自己或子目录）' : ''}`,
        disabled: blocked,
      });
      walk(child, depth + 1);
    }
  };
  if (tree) walk(tree.root, 0);
  if (options.excludeCurrent !== undefined && options.excludeCurrent !== null) {
    const current = out.find((choice) => choice.value === String(options.excludeCurrent));
    if (current) current.disabled = true;
  }
  return out;
}

interface ModalField {
  name: string;
  label: string;
  type?: 'text' | 'textarea' | 'select';
  value?: string;
  placeholder?: string;
  hint?: string;
  options?: FolderChoice[];
}

/**
 * 通用弹窗。返回各字段的值；取消返回 null。
 *
 * 为什么不用 window.prompt：原生 prompt 不能放下拉框，也做不了「禁用自己子树」这种
 * 选项状态，更没法在同一个弹窗里给出「这个操作立即生效 / 需要审核」的提示。
 */
function openModal(
  title: string,
  fields: ModalField[],
  submitLabel: string,
  note: string,
): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'docs-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    const box = document.createElement('div');
    box.className = 'docs-modal';

    const heading = document.createElement('h2');
    heading.textContent = title;
    const lead = document.createElement('p');
    lead.className = 'docs-modal-note';
    lead.textContent = note;
    box.append(heading, lead);

    const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>();
    for (const field of fields) {
      const wrap = document.createElement('label');
      wrap.className = 'docs-field';
      const label = document.createElement('span');
      label.textContent = field.label;
      let control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
      if (field.type === 'select') {
        const select = document.createElement('select');
        select.className = 'docs-input';
        for (const option of field.options ?? []) {
          const node = document.createElement('option');
          node.value = option.value;
          node.textContent = option.label;
          node.disabled = option.disabled === true;
          select.appendChild(node);
        }
        if (field.value !== undefined) select.value = field.value;
        control = select;
      } else if (field.type === 'textarea') {
        const area = document.createElement('textarea');
        area.className = 'docs-input';
        area.rows = 3;
        area.placeholder = field.placeholder ?? '';
        area.value = field.value ?? '';
        control = area;
      } else {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'docs-input';
        input.placeholder = field.placeholder ?? '';
        input.value = field.value ?? '';
        control = input;
      }
      inputs.set(field.name, control);
      wrap.append(label, control);
      if (field.hint) {
        const hint = document.createElement('small');
        hint.className = 'docs-field-hint';
        hint.textContent = field.hint;
        wrap.appendChild(hint);
      }
      box.appendChild(wrap);
    }

    const actions = document.createElement('div');
    actions.className = 'docs-modal-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'docs-btn docs-btn-ghost';
    cancel.textContent = '取消';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'docs-btn docs-btn-primary';
    confirm.textContent = submitLabel;
    actions.append(cancel, confirm);
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const collect = (): Record<string, string> => {
      const out: Record<string, string> = {};
      inputs.forEach((control, name) => (out[name] = control.value));
      return out;
    };

    function close(result: Record<string, string> | null): void {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(result);
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') close(null);
      if (event.key === 'Enter' && (event.target as HTMLElement)?.tagName !== 'TEXTAREA') {
        close(collect());
      }
    }
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close(null);
    });
    cancel.addEventListener('click', () => close(null));
    confirm.addEventListener('click', () => close(collect()));

    // 打开即聚焦第一个输入框：键盘用户不用先 Tab 一圈
    const first = [...inputs.values()][0];
    if (first) (first as HTMLElement).focus();
  });
}

async function moveDocumentFlow(
  permissions: DocsPermissions | null,
  detail: DocumentDetail,
  el: Elements,
  state: ViewState,
): Promise<void> {
  const direct = isDirect(permissions);
  const values = await openModal(
    `移动《${detail.title}》`,
    [
      {
        name: 'parent',
        label: '移动到',
        type: 'select',
        value: String(detail.parent_id ?? ''),
        options: folderChoices(state.tree, { excludeCurrent: detail.parent_id }),
      },
      { name: 'note', label: '说明（可选）', placeholder: '为什么挪动它' },
    ],
    direct ? '立即移动' : '提交移动申请',
    direct
      ? '你是超级管理员：点确认后立刻生效，访客马上看到新的位置。'
      : '你是管理员：提交后进入待审队列，超级管理员批准后才会真正移动。',
  );
  if (!values) return;

  const parentId = values.parent ? Number(values.parent) : null;
  try {
    if (direct) {
      const result = await docsApi.moveDocumentNow(detail.id, parentId, values.note ?? '');
      toast(result.message);
      await refreshAfterOrganize(el, state, { openDocumentId: detail.id });
    } else {
      const created = await docsApi.submit({
        action: 'move_doc',
        document_id: detail.id,
        parent_id: parentId,
        note: values.note ?? '',
      });
      toast(`移动申请已提交（#${created.id}），等超管审核`);
      refreshManagePanel();
    }
  } catch (error) {
    toast(error instanceof Error ? error.message : '移动失败');
  }
}

async function renameDocumentFlow(
  permissions: DocsPermissions | null,
  detail: DocumentDetail,
  el: Elements,
  state: ViewState,
): Promise<void> {
  const direct = isDirect(permissions);
  if (!direct) {
    toast('改标题需要重新上传文件并提交更新；如果只是想让目录里显示得更好，可以请超管直接改');
    return;
  }
  const values = await openModal(
    '改标题',
    [
      { name: 'title', label: '新标题', value: detail.title, placeholder: '显示在目录树与页面上的名字' },
      { name: 'note', label: '说明（可选）', placeholder: '为什么改' },
    ],
    '立即修改',
    '改的只是显示标题；文档在目录里的路径键保持不变，已有链接不会失效。',
  );
  if (!values || !values.title?.trim()) return;
  try {
    const result = await docsApi.renameDocumentNow(detail.id, values.title.trim(), values.note ?? '');
    toast(result.message);
    await refreshAfterOrganize(el, state, { openDocumentId: detail.id });
  } catch (error) {
    toast(error instanceof Error ? error.message : '改名失败');
  }
}

async function deleteDocumentFlow(
  permissions: DocsPermissions | null,
  detail: DocumentDetail,
  el: Elements,
  state: ViewState,
): Promise<void> {
  const direct = isDirect(permissions);
  const values = await openModal(
    direct ? `删除《${detail.title}》` : `申请删除《${detail.title}》`,
    [
      {
        name: 'note',
        label: direct ? '删除理由（会留在站内记录里）' : '给超管的理由',
        type: 'textarea',
        placeholder: direct ? '例如：内容已合并到另一篇' : '例如：内容重复',
      },
    ],
    direct ? '确认删除' : '提交删除申请',
    direct
      ? '删除后目录树与搜索里都会消失，且无法在站内恢复（修订记录一并删除）。'
      : '提交后进入待审队列，超级管理员批准才会真正删除。',
  );
  if (!values) return;
  try {
    if (direct) {
      const result = await docsApi.deleteDocumentNow(detail.id, values.note ?? '');
      toast(result.message);
      await refreshAfterOrganize(el, state, { showWelcome: true });
    } else {
      const created = await docsApi.submit({
        action: 'delete_doc',
        document_id: detail.id,
        note: values.note ?? '',
      });
      toast(`删除申请已提交（#${created.id}），等超管审核`);
      refreshManagePanel();
    }
  } catch (error) {
    toast(error instanceof Error ? error.message : '删除失败');
  }
}

async function moveFolderFlow(
  permissions: DocsPermissions | null,
  folder: FolderNode,
  el: Elements,
  state: ViewState,
): Promise<void> {
  const direct = isDirect(permissions);
  const values = await openModal(
    `移动文件夹「${folder.name}」`,
    [
      {
        name: 'parent',
        label: '移动到',
        type: 'select',
        value: String(folder.parent_id ?? ''),
        // 自己与自己的子树不能选：移进去会让子树成为孤岛（服务端也会拦）
        options: folderChoices(state.tree, { excludeSubtreeOf: folder.id, excludeCurrent: folder.parent_id }),
      },
      { name: 'note', label: '说明（可选）' },
    ],
    direct ? '立即移动' : '提交移动申请',
    `连同里面的 ${countDocuments(folder)} 篇文档一起移动（含子目录）。${
      direct ? '点确认后立刻生效。' : '提交后等超管审核。'
    }`,
  );
  if (!values) return;
  const parentId = values.parent ? Number(values.parent) : null;
  try {
    if (direct) {
      const result = await docsApi.moveFolderNow(folder.id, parentId, values.note ?? '');
      toast(result.message);
    } else {
      const created = await docsApi.submit({
        action: 'move_folder',
        folder_id: folder.id,
        parent_id: parentId,
        note: values.note ?? '',
      });
      toast(`移动申请已提交（#${created.id}），等超管审核`);
    }
    await refreshAfterOrganize(el, state, {});
  } catch (error) {
    toast(error instanceof Error ? error.message : '移动失败');
  }
}

async function renameFolderFlow(
  permissions: DocsPermissions | null,
  folder: FolderNode,
  el: Elements,
  state: ViewState,
): Promise<void> {
  const direct = isDirect(permissions);
  if (!direct) {
    toast('重命名文件夹需要超管操作；你可以新建一个文件夹并提交移动申请');
    return;
  }
  const values = await openModal(
    '重命名文件夹',
    [
      { name: 'name', label: '新名称', value: folder.name },
      { name: 'note', label: '说明（可选）' },
    ],
    '立即改名',
    '改的是文件夹名，子目录与文档的路径会一起更新（它们跟着父目录走）。',
  );
  if (!values?.name?.trim()) return;
  try {
    const result = await docsApi.renameFolderNow(folder.id, values.name.trim(), values.note ?? '');
    toast(result.message);
    await refreshAfterOrganize(el, state, {});
  } catch (error) {
    toast(error instanceof Error ? error.message : '改名失败');
  }
}

async function deleteFolderFlow(
  permissions: DocsPermissions | null,
  folder: FolderNode,
  el: Elements,
  state: ViewState,
): Promise<void> {
  const direct = isDirect(permissions);
  const count = countDocuments(folder);
  const values = await openModal(
    direct ? `删除文件夹「${folder.name}」` : `申请删除文件夹「${folder.name}」`,
    [
      {
        name: 'note',
        label: '理由',
        type: 'textarea',
        placeholder: '例如：内容已经并入别的目录',
      },
    ],
    direct ? '确认删除' : '提交删除申请',
    count > 0
      ? `⚠ 这个文件夹下有 ${count} 篇文档，连同子目录会被一起删除。${
          direct ? '这一步在站内无法撤销。' : '提交后等超管审核。'
        }`
      : direct
        ? '这个文件夹是空的，删除不会有别的影响。'
        : '提交后等超管审核。',
  );
  if (!values) return;
  try {
    if (direct) {
      const result = await docsApi.deleteFolderNow(folder.id, values.note ?? '');
      toast(result.message);
    } else {
      const created = await docsApi.submit({
        action: 'delete_folder',
        folder_id: folder.id,
        note: values.note ?? '',
      });
      toast(`删除申请已提交（#${created.id}），等超管审核`);
    }
    await refreshAfterOrganize(el, state, { showWelcome: true });
  } catch (error) {
    toast(error instanceof Error ? error.message : '删除失败');
  }
}

/** 整理操作之后：重拉目录树，必要时重新打开当前文档 / 回到欢迎页。 */
async function refreshAfterOrganize(
  el: Elements,
  state: ViewState,
  options: { openDocumentId?: number; showWelcome?: boolean },
): Promise<void> {
  try {
    const tree = await docsApi.tree();
    state.tree = tree;
    // 移动可能换了目录，展开状态跟着重建一遍，否则目标目录是折叠的、看不到结果
    indexAndRender(el, state);
  } catch {
    /* 树刷新失败不影响已经完成的写操作，下面照旧提示 */
  }
  refreshManagePanel();
  if (options.openDocumentId !== undefined) {
    await openDocument(options.openDocumentId, el, state).catch(() => undefined);
  } else if (options.showWelcome) {
    state.current = null;
    state.activeId = null;
    history.replaceState(null, '', '#/');
    showWelcome(el, state);
  }
}

/** 重建索引并重画目录树（展开状态保留）。 */
function indexAndRender(el: Elements, state: ViewState): void {
  state.byId.clear();
  state.byPath.clear();
  if (state.tree) indexTree(state.tree.root, state);
  renderTree(el, state);
}

// ----------------------------------------------------------------- 搜索

async function runSearch(el: Elements, state: ViewState): Promise<void> {
  const query = el.searchInput.value.trim();
  if (!query) return;
  el.searchResults.hidden = false;
  el.searchResults.replaceChildren(notice(`正在搜索「${query}」…`));
  try {
    const result = await docsApi.search(query);
    el.searchResults.replaceChildren();
    const head = document.createElement('p');
    head.className = 'docs-search-head';
    head.textContent = result.total === 0
      ? `没有找到包含「${query}」的文档`
      : `找到 ${result.total} 篇${result.truncated ? `（只显示前 ${result.hits.length} 篇，再补几个关键词试试）` : ''}`;
    el.searchResults.appendChild(head);

    for (const hit of result.hits) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'docs-hit';
      const title = document.createElement('strong');
      title.textContent = hit.title;
      const where = document.createElement('small');
      where.textContent = hit.path ? `${hit.path} · ${FORMAT_LABELS[hit.doc_format]}` : FORMAT_LABELS[hit.doc_format];
      const snippet = document.createElement('span');
      snippet.className = 'docs-hit-snippet';
      snippet.textContent = hit.snippet;
      card.append(title, where, snippet);
      card.addEventListener('click', () => void openDocument(hit.id, el, state));
      el.searchResults.appendChild(card);
    }
    el.doc.replaceChildren(notice('搜索结果在左上角', '点任意一条即可打开正文。'));
    el.toc.hidden = true;
  } catch (error) {
    el.searchResults.replaceChildren(
      notice('搜索失败', error instanceof Error ? error.message : '未知错误'),
    );
  }
}

// ----------------------------------------------------------------- 身份提示

function renderFooter(
  el: Elements,
  state: ViewState,
  isStaff: () => boolean,
  isSuperadmin: () => boolean,
): void {
  el.sidebarExtra.replaceChildren();
  const role = state.permissions?.role ?? null;
  const line = document.createElement('p');
  line.className = 'docs-role-note';

  if (!role) {
    line.textContent = '你是访客：全部已发布文档都可阅读。登录后可以评论与收藏。';
  } else if (role === 'member') {
    line.textContent = '你是登录会员：可阅读全部已发布文档。';
  } else if (role === 'admin') {
    line.textContent = '你是管理员：可以上传文件与新建文件夹，提交后由超级管理员审核发布。';
  } else {
    line.textContent = '你是超级管理员：可以直接发布内容，并审核其他管理员的提交。';
  }
  el.sidebarExtra.appendChild(line);

  if (isStaff()) {
    const jump = document.createElement('button');
    jump.type = 'button';
    jump.className = 'docs-btn docs-btn-primary';
    jump.textContent = isSuperadmin() ? '打开管理 / 审核面板' : '打开管理面板';
    jump.addEventListener('click', () => {
      const panel = document.querySelector('.docs-manage-panel');
      if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    el.sidebarExtra.appendChild(jump);
  }
}

// ----------------------------------------------------------------- 管理面板

let refreshManagePanel: () => void = () => undefined;

async function mountManagePanel(
  el: Elements,
  state: ViewState,
  isSuperadmin: () => boolean,
): Promise<void> {
  const panel = document.createElement('section');
  panel.className = 'docs-manage-panel';
  panel.id = 'docs-manage';

  const heading = document.createElement('h2');
  heading.textContent = isSuperadmin() ? '管理面板 · 上传与审核' : '管理面板 · 上传与投稿';
  const lead = document.createElement('p');
  lead.className = 'docs-manage-lead';
  lead.textContent = isSuperadmin()
    ? '你上传的内容会直接发布；其他管理员提交的变更单需要你在这里批准或驳回，批准后才对访客可见。'
    : '上传文件或新建文件夹后，需要提交给超级管理员审核；审核通过前访客看不到这些内容。';
  panel.append(heading, lead);

  const columns = document.createElement('div');
  columns.className = 'docs-manage-grid';

  // 上传文档
  const uploadCard = manageCard('上传文档', '选择 md / json / txt 文件，填好标题与放置目录。');
  const folderOptions = collectFolderOptions(state.tree?.root ?? null);
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.md,.markdown,.txt,.json';
  fileInput.className = 'docs-input';
  const uploadFolder = selectField('放置到', folderOptions);
  const titleInput = textField('标题（留空则用文件名推断）', '不再手改也可以');
  const summaryInput = textField('摘要（可选，一句话说明这篇讲什么）');
  const visibility = visibilityField();
  const progress = document.createElement('p');
  progress.className = 'docs-progress';
  const uploadButton = document.createElement('button');
  uploadButton.type = 'button';
  uploadButton.className = 'docs-btn docs-btn-primary';
  uploadButton.textContent = isSuperadmin() ? '上传并直接发布' : '上传并提交审核';
  uploadButton.addEventListener('click', () => {
    void handleUpload({
      fileInput,
      titleInput: titleInput.input,
      summaryInput: summaryInput.input,
      visibility,
      progress,
      uploadButton,
      folderId: () => uploadFolder.select.value,
      onDone: () => refreshManagePanel(),
    });
  });
  uploadCard.append(
    labeled('文件', fileInput),
    uploadFolder.wrap,
    titleInput.wrap,
    summaryInput.wrap,
    visibility.wrap,
    progress,
    uploadButton,
  );

  // 新建文件夹
  const folderCard = manageCard('新建文件夹', '用来给文档分组，名称会直接出现在左侧目录里。');
  const folderName = textField('文件夹名称', '例如：漏洞bug分析');
  const folderParent = selectField('上级目录', folderOptions);
  const folderVisibility = visibilityField();
  const folderButton = document.createElement('button');
  folderButton.type = 'button';
  folderButton.className = 'docs-btn';
  folderButton.textContent = isSuperadmin() ? '直接创建' : '提交新建申请';
  folderButton.addEventListener('click', () => {
    void handleCreateFolder({
      nameInput: folderName.input,
      parentId: () => folderParent.select.value,
      visibility: folderVisibility.select.value as Visibility,
      button: folderButton,
      onDone: () => refreshManagePanel(),
    });
  });
  folderCard.append(folderName.wrap, folderParent.wrap, folderVisibility.wrap, folderButton);

  columns.append(uploadCard, folderCard);
  panel.appendChild(columns);

  // 提交单列表
  const listSection = document.createElement('div');
  listSection.className = 'docs-submissions';
  const listHead = document.createElement('h3');
  listHead.textContent = isSuperadmin() ? '待审提交单' : '我的提交单';
  const listBody = document.createElement('div');
  listBody.className = 'docs-submission-list';
  listSection.append(listHead, listBody);
  panel.appendChild(listSection);

  el.mainExtra.replaceChildren(panel);

  refreshManagePanel = () => {
    if (lastState) void loadSubmissions(listBody, lastState, isSuperadmin);
  };
  void loadSubmissions(listBody, state, isSuperadmin);
}

interface UploadRequest {
  fileInput: HTMLInputElement;
  titleInput: HTMLInputElement;
  summaryInput: HTMLInputElement;
  visibility: { select: HTMLSelectElement };
  progress: HTMLElement;
  uploadButton: HTMLButtonElement;
  folderId: () => string;
  onDone: () => void;
}

async function handleUpload(request: UploadRequest): Promise<void> {
  // 点击这一刻文件必须还在 input 上：自动化脚本/浏览器差异都可能让 files 被丢掉，
  // 那时界面会显示「已进入待审队列」而服务端什么也没收到——宁可提示重选，也不要假成功。
  const file = request.fileInput.files?.[0];
  if (!file) {
    request.progress.textContent = '';
    toast('文件没有选上，请重新选择后再点上传');
    return;
  }
  request.uploadButton.disabled = true;
  request.progress.textContent = `正在上传 ${file.name}（0%）…`;
  try {
    const uploaded = await uploadFile(file, (sent, total) => {
      request.progress.textContent =
        `正在上传 ${file.name}（${Math.round((sent / total) * 100)}%）…`;
    });
    request.progress.textContent = `已落盘 ${formatBytes(uploaded.byte_size)}，正在提交审核…`;
    const created = await docsApi.submit({
      action: 'create_doc',
      parent_id: request.folderId() ? Number(request.folderId()) : null,
      title: request.titleInput.value.trim() || undefined,
      summary: request.summaryInput.value.trim() || undefined,
      visibility: request.visibility.select.value,
      file_id: uploaded.id,
    });
    const direct = created.status === 'approved';
    toast(direct ? '已发布，访客现在就能看到' : `已提交审核（#${created.id}）`);
    request.progress.textContent = direct
      ? `已发布：${created.title}`
      : `提交单 #${created.id} 已进入待审队列，等超管处理。`;
    request.fileInput.value = '';
    request.titleInput.value = '';
    request.summaryInput.value = '';
    request.onDone();
  } catch (error) {
    request.progress.textContent = '';
    toast(error instanceof Error ? error.message : '上传失败');
  } finally {
    request.uploadButton.disabled = false;
  }
}

interface FolderRequest {
  nameInput: HTMLInputElement;
  parentId: () => string;
  visibility: Visibility;
  button: HTMLButtonElement;
  onDone: () => void;
}

async function handleCreateFolder(request: FolderRequest): Promise<void> {
  const name = request.nameInput.value.trim();
  if (!name) {
    toast('填一下文件夹名称');
    return;
  }
  request.button.disabled = true;
  try {
    const created = await docsApi.submit({
      action: 'create_folder',
      name,
      parent_id: request.parentId() ? Number(request.parentId()) : null,
      visibility: request.visibility,
    });
    toast(created.status === 'approved' ? '文件夹已创建' : `新建申请已提交（#${created.id}）`);
    request.nameInput.value = '';
    request.onDone();
  } catch (error) {
    toast(error instanceof Error ? error.message : '提交失败');
  } finally {
    request.button.disabled = false;
  }
}

async function loadSubmissions(
  body: HTMLElement,
  state: ViewState,
  isSuperadmin: () => boolean,
): Promise<void> {
  body.replaceChildren(notice('正在读取提交单…'));
  try {
    const [pending, mine] = isSuperadmin()
      ? await Promise.all([docsApi.submissions('pending'), docsApi.submissions('mine')])
      : [null, await docsApi.submissions('mine')];
    body.replaceChildren();

    const pendingItems = pending?.items.filter((item) => item.status === 'pending') ?? [];
    if (isSuperadmin()) {
      if (pendingItems.length === 0) {
        body.appendChild(notice('待审队列是空的', '管理员提交的变更单会出现在这里。'));
      } else {
        body.appendChild(submissionGroup('等待你处理', pendingItems, state, isSuperadmin, true));
      }
    } else if (mine.items.every((item) => item.status !== 'pending')) {
      body.appendChild(notice('暂时没有待审的提交', '上传文件或新建文件夹后，这里会显示审核进度。'));
    }

    const history = mine.items.filter(
      (item) => item.status !== 'pending' || !isSuperadmin(),
    );
    if (history.length > 0) {
      body.appendChild(submissionGroup(isSuperadmin() ? '我的提交记录' : '我的提交与状态',
        history.slice(0, 30), state, isSuperadmin, false));
    }
  } catch (error) {
    body.replaceChildren(
      notice('读不到提交单', error instanceof Error ? error.message : '未知错误'),
    );
  }
}

function submissionGroup(
  title: string,
  items: SubmissionOut[],
  state: ViewState,
  isSuperadmin: () => boolean,
  withReview: boolean,
): HTMLElement {
  const group = document.createElement('div');
  group.className = 'docs-submission-group';
  const heading = document.createElement('h4');
  heading.textContent = `${title}（${items.length}）`;
  group.appendChild(heading);

  for (const item of items) {
    const row = document.createElement('div');
    row.className = `docs-submission is-${item.status}`;

    const top = document.createElement('div');
    top.className = 'docs-submission-top';
    const action = document.createElement('span');
    action.className = 'docs-submission-action';
    action.textContent = ACTION_LABELS[item.action];
    const status = document.createElement('span');
    status.className = `docs-status is-${item.status}`;
    status.textContent = STATUS_LABELS[item.status];
    top.append(action, status);
    if (item.submitted_by_name) {
      const who = document.createElement('span');
      who.className = 'docs-submission-who';
      who.textContent = `${item.submitted_by_name} · ${formatDate(item.created_at)}`;
      top.appendChild(who);
    }

    const subject = document.createElement('p');
    subject.className = 'docs-submission-subject';
    const where = item.parent_path ? `${item.parent_path} / ` : '';
    subject.textContent = item.name
      ? `${where}${item.name}`
      : `${where}${item.title || '（未命名）'}`;

    row.append(top, subject);

    const details: string[] = [];
    if (item.file) details.push(`文件 ${item.file.name}（${formatBytes(item.file.byte_size)}）`);
    details.push(VISIBILITY_LABELS[item.visibility]);
    if (item.note) details.push(`理由：${item.note}`);
    if (item.review_note) details.push(`审核意见：${item.review_note}`);
    if (details.length > 0) {
      const meta = document.createElement('p');
      meta.className = 'docs-submission-meta';
      meta.textContent = details.join(' · ');
      row.appendChild(meta);
    }
    if (item.body_preview) {
      const preview = document.createElement('pre');
      preview.className = 'docs-submission-preview';
      preview.textContent = item.body_preview;
      row.appendChild(preview);
    }

    const actions = document.createElement('div');
    actions.className = 'docs-submission-actions';

    if (withReview && isSuperadmin() && item.status === 'pending') {
      const approve = document.createElement('button');
      approve.type = 'button';
      approve.className = 'docs-btn docs-btn-primary';
      approve.textContent = '批准并发布';
      approve.addEventListener('click', () => void review(item, 'approve', row));
      const reject = document.createElement('button');
      reject.type = 'button';
      reject.className = 'docs-btn docs-btn-ghost';
      reject.textContent = '驳回';
      reject.addEventListener('click', () => void review(item, 'reject', row));

      const note = document.createElement('input');
      note.type = 'text';
      note.className = 'docs-input docs-review-note';
      note.placeholder = '审核意见（可选，驳回时会写进记录）';
      actions.append(approve, reject, note);
    }

    if (item.status === 'pending' && !withReview) {
      const withdraw = document.createElement('button');
      withdraw.type = 'button';
      withdraw.className = 'docs-btn docs-btn-ghost';
      withdraw.textContent = '撤回';
      withdraw.addEventListener('click', async () => {
        try {
          await docsApi.withdraw(item.id);
          toast('已撤回');
          refreshManagePanel();
        } catch (error) {
          toast(error instanceof Error ? error.message : '撤回失败');
        }
      });
      actions.appendChild(withdraw);
    }

    if (item.status === 'approved' && item.applied_document_id) {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'docs-btn docs-btn-ghost';
      open.textContent = '打开已发布的文档';
      open.addEventListener('click', () => {
        const link = document.querySelector<HTMLButtonElement>(
          `.docs-tree-doc[data-doc-id="${item.applied_document_id}"]`,
        );
        link?.click();
      });
      actions.appendChild(open);
    }

    if (actions.childElementCount > 0) row.appendChild(actions);
    group.appendChild(row);
  }
  return group;
}

async function review(
  item: SubmissionOut,
  decision: 'approve' | 'reject',
  row: HTMLElement,
): Promise<void> {
  const noteInput = row.querySelector<HTMLInputElement>('.docs-review-note');
  const note = noteInput?.value.trim() ?? '';
  if (decision === 'reject' && !note) {
    const typed = window.prompt('驳回理由（会记录在提交单里，便于作者知道怎么改）：', '');
    if (typed === null) return;
    return finishReview(item, decision, typed, row);
  }
  return finishReview(item, decision, note, row);
}

async function finishReview(
  item: SubmissionOut,
  decision: 'approve' | 'reject',
  note: string,
  row: HTMLElement,
): Promise<void> {
  const buttons = row.querySelectorAll<HTMLButtonElement>('button');
  buttons.forEach((button) => (button.disabled = true));
  try {
    const result = await docsApi.review(item.id, decision, note);
    if (result.status === 'approved') {
      toast('已批准并发布，访客现在可以看到了');
    } else {
      toast(`已驳回：${result.review_note || '未填写理由'}`);
    }
    // 目录树需要重新拉一次：批准可能新增了文档或文件夹
    const tree = await docsApi.tree();
    if (lastState && lastElements) {
      lastState.tree = tree;
      renderTree(lastElements, lastState);
      // 当前正文如果正好是被批准的那篇（草稿→已发布），刷新一下标题上的状态标记
      if (lastState.current && lastState.current.id === item.applied_document_id) {
        await openDocument(lastState.current.id, lastElements, lastState);
      }
    }
    refreshManagePanel();
  } catch (error) {
    toast(error instanceof Error ? error.message : '审核失败');
    buttons.forEach((button) => (button.disabled = false));
  }
}

// ----------------------------------------------------------------- 小部件

function manageCard(title: string, lead: string): HTMLElement {
  const card = document.createElement('section');
  card.className = 'docs-manage-card';
  const heading = document.createElement('h3');
  heading.textContent = title;
  const note = document.createElement('p');
  note.className = 'docs-manage-note';
  note.textContent = lead;
  card.append(heading, note);
  return card;
}

function labeled(label: string, control: HTMLElement): HTMLElement {
  const wrap = document.createElement('label');
  wrap.className = 'docs-field';
  const span = document.createElement('span');
  span.textContent = label;
  wrap.append(span, control);
  return wrap;
}

function textField(label: string, placeholder = ''): { wrap: HTMLElement; input: HTMLInputElement } {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'docs-input';
  input.placeholder = placeholder;
  const wrap = labeled(label, input);
  return { wrap, input };
}

function selectField(
  label: string,
  options: { value: string; label: string }[],
): { wrap: HTMLElement; select: HTMLSelectElement } {
  const select = document.createElement('select');
  select.className = 'docs-input';
  for (const option of options) {
    const node = document.createElement('option');
    node.value = option.value;
    node.textContent = option.label;
    select.appendChild(node);
  }
  const wrap = labeled(label, select);
  return { wrap, select };
}

function visibilityField(): { wrap: HTMLElement; select: HTMLSelectElement } {
  return selectField('可见性', [
    { value: 'public', label: '所有人可见（含未登录访客）' },
    { value: 'members', label: '仅登录会员' },
    { value: 'staff', label: '仅管理员' },
  ]);
}

function collectFolderOptions(
  tree: FolderNode | null,
  depth = 0,
  out: { value: string; label: string }[] = [{ value: '', label: '（根目录）' }],
): { value: string; label: string }[] {
  if (!tree) return out;
  for (const child of tree.children) {
    out.push({ value: String(child.id), label: `${'　'.repeat(depth)}${child.name}` });
    collectFolderOptions(child, depth + 1, out);
  }
  return out;
}

function chip(text: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'docs-chip';
  span.textContent = text;
  return span;
}

function notice(title: string, body = ''): HTMLElement {
  const box = document.createElement('div');
  box.className = 'docs-notice';
  const strong = document.createElement('strong');
  strong.textContent = title;
  box.appendChild(strong);
  if (body) {
    const p = document.createElement('p');
    p.textContent = body;
    box.appendChild(p);
  }
  return box;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDate(value: string): string {
  const date = new Date(value.endsWith('Z') || value.includes('+') ? value : `${value}Z`);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}


