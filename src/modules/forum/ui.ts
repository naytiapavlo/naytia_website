/**
 * 论坛界面（阶段 4 正式实现）。
 *
 * 静态外壳 + 客户端调用 Python API（FastAPI + SQLite，ADR-001）。
 * 页面本身由 Astro 预渲染，数据全靠 `modules/forum` 的 API 客户端取；
 * 后端不可用时页面显示明确的不可用状态，不假装成功（02 文档：失败要可见）。
 *
 * ## 路由
 *
 * 静态托管下没有服务端动态路由，所以帖子详情走 **hash**：
 * `#/t/12` = 第 12 帖、`#/new` = 发帖。这样前进/后退、刷新、把链接发给别人
 * 都能用，也不需要额外的构建期数据（`getStaticPaths` 拿不到运行时的库内容）。
 *
 * ## 上传边界（04 文档第 5 节：文件处理要明确说明是否上传）
 *
 * 工具箱里的 `.mcstructure` 编辑器**只在浏览器本地**处理文件；论坛的附件
 * 不一样——它必须传给服务端才能被解析、被别人看到。界面上把这件事写清楚了，
 * 不让用户以为两者是一回事。
 */
import { SESSION_EVENT, me, openAccountDialog, type AccountSummary } from '../account';
import { ApiError } from '../../shared/api-client';
import { toast } from '../../shared/toast';
import {
  coverUrl,
  createReply,
  createThread,
  createThreadWithAttachments,
  deleteCover,
  deleteReply,
  deleteThread,
  fetchCategories,
  fetchRenderPayload,
  fetchThread,
  fetchThreads,
  structureFileUrl,
  type StructureRenderPayload,
  type ThreadCover,
  type ThreadDetail,
  type ThreadStructure,
  type ThreadSummary,
} from './api';
import { blockColor, cssColor, displayBlockName } from './block-colors';
import {
  coverCropHint,
  coverFormatLabel,
  coverSizeText,
  formatBytes,
  formatCount,
  formatRatio,
  formatStates,
  materialTotals,
  relativeTime,
  sortMaterials,
  structureFacts,
  structureWarnings,
} from './present';
import { mountVoxelView } from './voxel-view';

/** 与后端 `NAYTIA_FORUM_STRUCTURE_MAX_BYTES` 默认值一致的前端预检值 */
const MAX_STRUCTURE_BYTES = 10 * 1024 * 1024;
const STRUCTURE_EXTENSION = '.mcstructure';
/** 与后端 `NAYTIA_FORUM_COVER_MAX_BYTES` 默认值一致 */
const MAX_COVER_BYTES = 5 * 1024 * 1024;
/**
 * 浏览器愿意在 `<img>` 里直接渲染的类型。
 *
 * 这里只是**前端预检**（省得让人白等一次上传），真正的判据在服务端：
 * 它按文件头认格式，认不出就拒。前端的这个列表宽一点没关系，
 * 宽了只是多一次往返，窄了会拦掉合法文件。
 */
const COVER_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
/** 单张封面超过这个体积就提醒一下（不是拒绝）——列表里每次都要加载它 */
const COVER_HEAVY_BYTES = 1024 * 1024;
/** 材料清单默认先渲染多少行，其余点按钮展开（2000 行的表格没必要一次全塞进 DOM） */
const MATERIAL_PREVIEW_ROWS = 60;

type Route = { name: 'list' } | { name: 'thread'; id: number } | { name: 'new' };

interface ForumState {
  categories: string[];
  /** 版块加载失败的原因；非空时发帖入口必须明确报错，不能给一个空下拉 */
  categoriesError: string | null;
  categoriesLoading: boolean;
  session: AccountSummary | null;
  category: string | null;
  threads: ThreadSummary[];
  nextCursor: string | null;
  loadingList: boolean;
  listError: string | null;
  detail: ThreadDetail | null;
  detailError: string | null;
  materialSort: 'count' | 'name';
  materialExpanded: boolean;
  /** 详情里挂着的 3D 视图卸载函数 */
  disposeVoxel: (() => void) | null;
}

/**
 * 已取到的 3D 载荷。放在模块作用域而不是 `ForumState` 里：
 * 它跟「当前在看哪一贴」无关，进出帖子不该把它丢掉。
 */
const renderCache = new Map<number, StructureRenderPayload>();

export function mountForum(root: HTMLElement): () => void {
  const state: ForumState = {
    categories: [],
    categoriesError: null,
    categoriesLoading: true,
    session: null,
    category: null,
    threads: [],
    nextCursor: null,
    loadingList: false,
    listError: null,
    detail: null,
    detailError: null,
    materialSort: 'count',
    materialExpanded: false,
    disposeVoxel: null,
  };

  const onSession = (event: Event): void => {
    state.session = (event as CustomEvent<AccountSummary | null>).detail ?? null;
    render();
  };
  window.addEventListener(SESSION_EVENT, onSession);
  const onHashChange = (): void => {
    void route();
  };
  window.addEventListener('hashchange', onHashChange);

  // ---- 首次加载 ----
  // 这三件事互不阻塞：会话、版块、帖子各来各的，谁也不等谁。
  void me()
    .then((account) => {
      state.session = account;
      render();
    })
    .catch(() => undefined);
  void loadCategories();
  void route();


  // ------------------------------------------------------------ 路由

  function currentRoute(): Route {
    const hash = window.location.hash.replace(/^#\/?/, '');
    if (hash === 'new') return { name: 'new' };
    const match = /^t\/(\d+)$/.exec(hash);
    if (match) return { name: 'thread', id: Number(match[1]) };
    return { name: 'list' };
  }

  async function route(): Promise<void> {
    const target = currentRoute();
    if (target.name === 'list') {
      state.detail = null;
      state.detailError = null;
      disposeVoxel();
      render();
      if (state.threads.length === 0) await loadThreads();
      return;
    }
    if (target.name === 'new') {
      disposeVoxel();
      render();
      return;
    }
    await loadThread(target.id);
  }

  function navigate(hash: string): void {
    if (window.location.hash === hash) {
      void route();
      return;
    }
    window.location.hash = hash;
  }

  // ------------------------------------------------------------ 数据

  /**
   * 拉取版块清单。
   *
   * 版块是**发帖的必要条件**：没有它就是选不出板块、发不出帖子。所以失败时
   * 不能像别的可选数据那样静默降级——之前就是在这里 `catch` 里什么也不做，
   * 结果发帖表单渲染出一个**空的下拉框**，用户点开发现没得选，也看不到任何
   * 原因（这是实测到的现象，不是假想）。
   *
   * 现在：记下原因 → 发帖入口直接显示错误与「重试」，而不是给一个用不了的表单。
   */
  async function loadCategories(): Promise<void> {
    state.categoriesLoading = true;
    state.categoriesError = null;
    render();
    try {
      const result = await fetchCategories();
      state.categories = result.categories;
      if (state.categories.length === 0) {
        state.categoriesError = '后端没有返回任何版块，暂时无法发帖。';
      }
    } catch (error) {
      state.categoriesError = describeCategoriesError(error);
    } finally {
      state.categoriesLoading = false;
      render();
    }
  }

  async function loadThreads(append = false): Promise<void> {
    if (state.loadingList) return;
    state.loadingList = true;
    state.listError = null;
    render();
    try {
      const page = await fetchThreads({
        category: state.category ?? undefined,
        cursor: append ? (state.nextCursor ?? undefined) : undefined,
      });
      state.threads = append ? [...state.threads, ...page.items] : page.items;
      state.nextCursor = page.next_cursor ?? null;
    } catch (error) {
      state.listError = describeError(error);
    } finally {
      state.loadingList = false;
      render();
    }
  }

  async function loadThread(id: number): Promise<void> {
    disposeVoxel();
    state.detail = null;
    state.detailError = null;
    state.materialExpanded = false;
    render();
    try {
      state.detail = await fetchThread(id);
    } catch (error) {
      state.detailError = describeError(error);
    }
    render();
  }

  function disposeVoxel(): void {
    state.disposeVoxel?.();
    state.disposeVoxel = null;
  }

  // ------------------------------------------------------------ 渲染

  function render(): void {
    const target = currentRoute();
    if (target.name === 'new') {
      renderComposer();
      return;
    }
    if (target.name === 'thread') {
      renderDetail(target.id);
      return;
    }
    renderList();
  }

  function renderList(): void {
    disposeVoxel();
    root.innerHTML = `
      <div class="forum">
        <div class="forum-bar">
          <div class="forum-tabs" role="tablist" aria-label="版块筛选">
            ${filterTab('全部', null)}
            ${state.categories.map((name) => filterTab(name, name)).join('')}
          </div>
          <button type="button" class="forum-btn forum-btn-primary" data-act="new">发帖</button>
        </div>
        ${
          state.categoriesError
            ? `<div class="forum-alert is-error">
                 <strong>版块列表没能加载。</strong>
                 <span>${escapeHtml(state.categoriesError)}</span>
                 <span>帖子仍然可以浏览与筛选，但暂时发不了帖。</span>
                 <button type="button" class="forum-btn" data-act="retry-categories">重试加载版块</button>
               </div>`
            : ''
        }
        ${
          state.listError
            ? `<div class="forum-alert is-error">
                 <strong>帖子列表没能加载出来。</strong>
                 <span>${escapeHtml(state.listError)}</span>
                 <button type="button" class="forum-btn" data-act="retry-list">重试</button>
               </div>`
            : ''
        }
        <div class="forum-list" data-part="list">${listBody()}</div>
        ${
          state.nextCursor
            ? '<button type="button" class="forum-btn forum-more" data-act="more">加载更多</button>'
            : ''
        }
      </div>`;
  }

  function filterTab(label: string, value: string | null): string {
    const active = state.category === value;
    return `<button type="button" class="forum-tab${active ? ' is-active' : ''}"
              role="tab" aria-selected="${active}"
              data-category="${value === null ? '' : escapeHtml(value)}">${escapeHtml(label)}</button>`;
  }

  function listBody(): string {
    if (state.loadingList && state.threads.length === 0) {
      return '<p class="forum-empty">正在加载帖子…</p>';
    }
    if (state.threads.length === 0) {
      return `<p class="forum-empty">${
        state.category ? `「${escapeHtml(state.category)}」还没有帖子。` : '还没有帖子，来发第一贴吧。'
      }</p>`;
    }
    return state.threads.map((thread) => cardHtml(thread)).join('');
  }

  function cardHtml(thread: ThreadSummary): string {
    // 有封面的帖子用横向卡片：左边缩略图，右边文字。
    // 缩略图外层套一个 16:9 的框并用 object-fit 裁切，所以不同比例的封面
    // 都不会把卡片撑变形（这一点在发帖时会提示用户）。
    const cover = thread.has_cover
      ? `<span class="forum-card-thumb">
           <img src="${coverUrl(thread.id)}" alt="" loading="lazy" decoding="async" />
         </span>`
      : '';
    return `
      <a class="forum-card${thread.has_cover ? ' has-cover' : ''}" href="#/t/${thread.id}">
        ${cover}
        <span class="forum-card-body">
          <span class="forum-card-head">
            <span class="forum-cat">${escapeHtml(thread.category)}</span>
            ${thread.has_cover ? '<span class="forum-badge forum-badge-cover">封面</span>' : ''}
            ${thread.has_structure ? '<span class="forum-badge" title="附带 .mcstructure 结构文件">结构文件</span>' : ''}
          </span>
          <h2>${escapeHtml(thread.title)}</h2>
          <span class="forum-card-meta">
            <span>${escapeHtml(thread.author)}</span>
            <span>${relativeTime(thread.created_at)}</span>
            <span>${thread.reply_count} 条回复</span>
            <span class="forum-card-activity">最后活动 ${relativeTime(thread.last_activity_at)}</span>
          </span>
        </span>
      </a>`;
  }

  function renderDetail(threadId: number): void {
    const detail = state.detail;
    root.innerHTML = `
      <div class="forum">
        <button type="button" class="forum-btn forum-back" data-act="back">← 回到帖子列表</button>
        ${
          state.detailError
            ? `<div class="forum-alert is-error">
                 <strong>帖子没能打开。</strong><span>${escapeHtml(state.detailError)}</span>
               </div>`
            : detail
              ? detailBody(detail)
              : '<p class="forum-empty">正在加载帖子…</p>'
        }
      </div>`;

    if (!detail) return;

    // 结构预览要等容器在 DOM 里再挂
    if (detail.structure?.render.available) {
      void mountRenderer(threadId);
    }
  }

  function detailBody(detail: ThreadDetail): string {
    const canDelete =
      state.session !== null &&
      (state.session.username === detail.author ||
        state.session.role === 'admin' ||
        state.session.role === 'superadmin');
    return `
      <article class="forum-thread">
        <div class="forum-card-head">
          <span class="forum-cat">${escapeHtml(detail.category)}</span>
          ${detail.has_cover ? '<span class="forum-badge forum-badge-cover">封面</span>' : ''}
          ${detail.has_structure ? '<span class="forum-badge">结构文件</span>' : ''}
        </div>
        <h1>${escapeHtml(detail.title)}</h1>
        <p class="forum-card-meta">
          <span>${escapeHtml(detail.author)}</span>
          <span>${relativeTime(detail.created_at)}</span>
          <span>${detail.reply_count} 条回复</span>
        </p>
        ${detail.cover ? coverFigure(detail, canDelete) : ''}
        <div class="forum-body">${linkify(detail.body)}</div>
        ${
          canDelete
            ? '<button type="button" class="forum-btn forum-danger" data-act="delete-thread">删除这个帖子</button>'
            : ''
        }
      </article>

      ${detail.structure ? structurePanel(detail.structure) : ''}

      <section class="forum-replies">
        <h2>回复 <span class="forum-muted">${detail.replies.length}</span></h2>
        ${
          detail.replies.length === 0
            ? '<p class="forum-empty">还没有人回复。</p>'
            : detail.replies
                .map(
                  (reply) => `
            <div class="forum-reply">
              <div class="forum-reply-head">
                <strong>${escapeHtml(reply.author)}</strong>
                <span>${relativeTime(reply.created_at)}</span>
                ${
                  state.session &&
                  (state.session.username === reply.author ||
                    state.session.role === 'admin' ||
                    state.session.role === 'superadmin')
                    ? `<button type="button" class="forum-link" data-act="delete-reply" data-id="${reply.id}">删除</button>`
                    : ''
                }
              </div>
              <div class="forum-body">${linkify(reply.body)}</div>
            </div>`,
                )
                .join('')
        }
        ${
          state.session
            ? `<form class="forum-reply-form" data-part="reply-form">
                 <label for="reply-body">写一条回复</label>
                 <textarea id="reply-body" name="body" rows="3" maxlength="2000"
                           placeholder="说说你的想法…（2-2000 字）"></textarea>
                 <p class="forum-error" data-part="reply-error" hidden></p>
                 <button type="submit" class="forum-btn forum-btn-primary">发表回复</button>
               </form>`
            : `<div class="forum-alert">
                 <span>登录后可以回复。</span>
                 <button type="button" class="forum-btn forum-btn-primary" data-act="login">登录 / 注册</button>
               </div>`
        }
      </section>`;
  }

  function coverFigure(detail: ThreadDetail, canDelete: boolean): string {
    const cover = detail.cover!;
    // 宽高写进 img 属性：浏览器在图片下载完成之前就知道该留多大的位置，
    // 页面不会在图片加载完的瞬间跳一下（04 文档第 4 节）
    return `
      <figure class="forum-cover">
        <img src="${coverUrl(detail.id)}"
             width="${cover.width}" height="${cover.height}"
             alt="${escapeHtml(`《${detail.title}》的封面`)}"
             decoding="async" />
        <figcaption>
          <span>${escapeHtml(cover.original_name)} · ${formatBytes(cover.byte_size)} ·
            ${escapeHtml(coverSizeText(cover))} · ${escapeHtml(coverFormatLabel(cover.content_type))}</span>
          ${
            canDelete
              ? '<button type="button" class="forum-link" data-act="delete-cover">删除封面</button>'
              : ''
          }
        </figcaption>
      </figure>`;
  }

  function structurePanel(structure: ThreadStructure): string {
    const facts = structureFacts(structure)
      .map(
        ([label, value]) =>
          `<div class="forum-fact"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`,
      )
      .join('');
    const warnings = structureWarnings(structure)
      .map((text) => `<li>${escapeHtml(text)}</li>`)
      .join('');

    return `
      <section class="forum-structure">
        <header class="forum-structure-head">
          <div>
            <h2>随帖结构文件</h2>
            <p class="forum-muted">
              ${escapeHtml(structure.original_name)} · ${formatBytes(structure.byte_size)}
              · sha256 ${escapeHtml(structure.sha256.slice(0, 12))}…
            </p>
          </div>
          <a class="forum-btn" href="${structureFileUrl(currentThreadId())}" rel="noopener">下载 .mcstructure</a>
        </header>

        <div class="forum-structure-grid">
          <div class="forum-preview" data-part="preview">
            ${
              structure.render.available
                ? '<p class="forum-empty">正在加载 3D 预览…</p>'
                : `<p class="forum-empty">${escapeHtml(structure.render.reason ?? '这个结构没有可用的 3D 预览。')}</p>`
            }
          </div>
          <dl class="forum-facts">${facts}</dl>
        </div>

        ${warnings ? `<ul class="forum-notes">${warnings}</ul>` : ''}

        <div class="forum-materials">
          <div class="forum-materials-head">
            <h3>材料清单 <span class="forum-muted">${formatCount(structure.materials_total)} 种</span></h3>
            <div class="forum-sort" role="group" aria-label="材料排序">
              <button type="button" class="forum-tab${state.materialSort === 'count' ? ' is-active' : ''}"
                      data-sort="count">按数量</button>
              <button type="button" class="forum-tab${state.materialSort === 'name' ? ' is-active' : ''}"
                      data-sort="name">按名称</button>
            </div>
          </div>
          ${materialTable(structure)}
          <p class="forum-muted forum-materials-note">
            统计单位是<b>方块排列</b>：同一个方块带不同状态（朝向、开关等）算两行——
            照着搭的时候，你要的是「几块什么朝向的楼梯」，不是一个模糊的总数。
            ${structure.materials_truncated ? '清单过长，这里只保留数量最多的若干条。' : ''}
          </p>
        </div>
      </section>`;
  }

  function materialTable(structure: ThreadStructure): string {
    const rows = sortMaterials(structure.materials, state.materialSort);
    if (rows.length === 0) {
      return '<p class="forum-empty">这个结构里没有可统计的方块。</p>';
    }
    const shown = state.materialExpanded ? rows : rows.slice(0, MATERIAL_PREVIEW_ROWS);
    const body = shown
      .map((row) => {
        const swatch = cssColor(blockColor(row.name));
        return `<tr>
          <td class="forum-swatch-cell"><span class="forum-swatch" style="background:${swatch}"></span></td>
          <td><code>${escapeHtml(displayBlockName(row.name))}</code></td>
          <td class="forum-states">${escapeHtml(formatStates(row.states))}</td>
          <td class="forum-num">${formatCount(row.count)}</td>
          <td class="forum-num">${formatRatio(row.ratio)}</td>
        </tr>`;
      })
      .join('');
    const totals = materialTotals(structure);
    return `
      <table class="forum-table">
        <thead>
          <tr><th></th><th>方块</th><th>状态</th><th class="forum-num">数量</th><th class="forum-num">占比</th></tr>
        </thead>
        <tbody>${body}</tbody>
        <tfoot>
          <tr>
            <td></td>
            <td>合计 ${formatCount(totals.kinds)} 种</td>
            <td></td>
            <td class="forum-num">${formatCount(totals.blocks)}</td>
            <td class="forum-num">100%</td>
          </tr>
        </tfoot>
      </table>
      ${
        !state.materialExpanded && rows.length > MATERIAL_PREVIEW_ROWS
          ? `<button type="button" class="forum-btn" data-act="expand-material">
               还有 ${formatCount(rows.length - MATERIAL_PREVIEW_ROWS)} 种，展开全部
             </button>`
          : ''
      }`;
  }

  function renderComposer(): void {
    disposeVoxel();
    if (!state.session) {
      root.innerHTML = `
        <div class="forum">
          <button type="button" class="forum-btn forum-back" data-act="back">← 回到帖子列表</button>
          <div class="forum-alert">
            <strong>发帖需要先登录。</strong>
            <span>账号只用于论坛署名与权限，不收邮箱。</span>
            <button type="button" class="forum-btn forum-btn-primary" data-act="login">登录 / 注册</button>
          </div>
        </div>`;
      return;
    }

    // 版块还没到（或永远到不了）时不渲染表单。
    // 渲染一个空下拉框是**最糟的选择**：用户点开发现没得选，表单也交不上去，
    // 却看不到任何原因——只能猜是自己操作错了。宁可什么都不给，把原因说清楚。
    if (state.categoriesLoading || state.categories.length === 0) {
      root.innerHTML = `
        <div class="forum">
          <button type="button" class="forum-btn forum-back" data-act="back">← 回到帖子列表</button>
          ${
            state.categoriesLoading
              ? '<p class="forum-empty">正在加载版块列表…</p>'
              : `<div class="forum-alert is-error">
                   <strong>暂时无法发帖：版块列表没能加载。</strong>
                   <span>${escapeHtml(state.categoriesError ?? '后端没有返回任何版块。')}</span>
                   <span>版块清单来自服务端接口，取不到就没法确定这篇帖子发到哪个版块，所以先不给你一个用不了的表单。</span>
                   <button type="button" class="forum-btn forum-btn-primary" data-act="retry-categories">重试加载版块</button>
                 </div>`
          }
        </div>`;
      return;
    }

    root.innerHTML = `
      <div class="forum">
        <button type="button" class="forum-btn forum-back" data-act="back">← 回到帖子列表</button>
        <form class="forum-compose" data-part="compose" novalidate>
          <h1>发一贴</h1>

          <div class="forum-field">
            <label for="compose-category">版块</label>
            <select id="compose-category" name="category">
              ${state.categories
                .map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
                .join('')}
            </select>
          </div>

          <div class="forum-field">
            <label for="compose-title">标题</label>
            <input id="compose-title" name="title" maxlength="60" required
                   placeholder="2-60 个字，说清楚你想聊什么" />
          </div>

          <div class="forum-field">
            <label for="compose-body">正文</label>
            <textarea id="compose-body" name="body" rows="8" maxlength="2000" required
                      placeholder="2-2000 个字。可以直接贴坐标、给材料数量、写注意事项。"></textarea>
            <small><span data-part="body-count">0</span> / 2000</small>
          </div>

          <fieldset class="forum-field forum-upload">
            <legend>封面图片（可选）</legend>
            <input type="file" id="compose-cover" accept="image/png,image/jpeg,image/gif,image/webp"
                   data-part="cover" hidden />
            <label class="forum-drop forum-drop-cover" for="compose-cover" data-part="cover-drop">
              <strong>选择一张封面图</strong>
              <small>PNG / JPEG / GIF / WebP，最大 ${formatBytes(MAX_COVER_BYTES)}。会显示在列表和帖子顶部。</small>
            </label>
            <div class="forum-cover-preview" data-part="cover-preview" hidden>
              <img alt="封面预览" data-part="cover-preview-img" />
              <div>
                <p class="forum-file-info" data-part="cover-info"></p>
                <button type="button" class="forum-link" data-act="clear-cover">移除封面</button>
              </div>
            </div>
            <p class="forum-upload-warning">
              封面也<b>会上传到本站服务器</b>，并按原图保存（服务端不做压缩）。
              列表里每次都会加载它，建议控制在 1 MB 以内。
            </p>
          </fieldset>

          <fieldset class="forum-field forum-upload">
            <legend>结构文件（可选）</legend>
            <input type="file" id="compose-file" accept=".mcstructure" data-part="file" hidden />
            <label class="forum-drop" for="compose-file" data-part="drop">
              <strong>选择一个 .mcstructure 文件</strong>
              <small>点这里选择，或把文件拖进来。最大 ${formatBytes(MAX_STRUCTURE_BYTES)}。</small>
            </label>
            <p class="forum-file-info" data-part="file-info" hidden></p>
            <p class="forum-upload-warning">
              注意：<b>附件会上传到本站服务器</b>。它需要被解析出材料清单、并给其他访客
              看 3D 预览，所以不能像工具箱那样只在浏览器里处理。上传后任何人下载这个帖子
              都能拿到原文件。
            </p>
            <progress data-part="progress" max="100" value="0" hidden></progress>
          </fieldset>

          <p class="forum-error" data-part="compose-error" hidden></p>
          <div class="forum-compose-actions">
            <button type="submit" class="forum-btn forum-btn-primary" data-part="submit">发布</button>
            <button type="button" class="forum-btn" data-act="back">取消</button>
          </div>
        </form>
      </div>`;

    bindComposer();
  }

  // ------------------------------------------------------------ 事件绑定

  // 委派：列表与详情会整块重绘，逐个绑事件会在每次重绘后失效
  root.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(
      '[data-act],[data-category],[data-sort]',
    );
    if (!target || !root.contains(target)) return;

    if (target.dataset.category !== undefined && target.dataset.category !== '') {
      state.category = target.dataset.category;
      state.threads = [];
      state.nextCursor = null;
      void loadThreads();
      return;
    }
    if (target.dataset.category === '') {
      state.category = null;
      state.threads = [];
      state.nextCursor = null;
      void loadThreads();
      return;
    }
    if (target.dataset.sort) {
      state.materialSort = target.dataset.sort === 'name' ? 'name' : 'count';
      render();
      return;
    }

    switch (target.dataset.act) {
      case 'new':
        navigate('#/new');
        break;
      case 'back':
        navigate('#/');
        break;
      case 'login':
        openAccountDialog();
        break;
      case 'retry-list':
        void loadThreads();
        break;
      case 'retry-categories':
        void loadCategories();
        break;
      case 'more':
        void loadThreads(true);
        break;
      case 'expand-material':
        state.materialExpanded = true;
        render();
        break;
      case 'delete-thread':
        void removeThread();
        break;
      case 'delete-cover':
        void removeCover();
        break;
      case 'delete-reply':
        void removeReply(Number(target.dataset.id));
        break;
      default:
        break;
    }
  });

  root.addEventListener('submit', (event) => {
    const form = event.target as HTMLFormElement;
    if (form.dataset.part === 'reply-form') {
      event.preventDefault();
      void submitReply(form);
    }
  });

  async function removeThread(): Promise<void> {
    const id = currentThreadId();
    if (!window.confirm('删除后帖子不再显示，附件也会一并清理。确定删除吗？')) return;
    try {
      await deleteThread(id);
      toast('帖子已删除');
      state.threads = [];
      navigate('#/');
    } catch (error) {
      toast(describeError(error));
    }
  }

  async function removeReply(replyId: number): Promise<void> {
    if (!window.confirm('删除这条回复？')) return;
    try {
      await deleteReply(replyId);
      await loadThread(currentThreadId());
      toast('回复已删除');
    } catch (error) {
      toast(describeError(error));
    }
  }

  async function removeCover(): Promise<void> {
    if (!window.confirm('删除封面？帖子本身不会受影响。')) return;
    try {
      await deleteCover(currentThreadId());
      await loadThread(currentThreadId());
      toast('封面已删除');
    } catch (error) {
      toast(describeError(error));
    }
  }

  async function submitReply(form: HTMLFormElement): Promise<void> {
    const errorBox = form.querySelector<HTMLElement>('[data-part="reply-error"]');
    const textarea = form.querySelector<HTMLTextAreaElement>('textarea[name="body"]');
    const body = (textarea?.value ?? '').trim();
    if (body.length < 2) {
      setError(errorBox, '回复至少 2 个字。');
      return;
    }
    setError(errorBox, null);
    try {
      await createReply(currentThreadId(), body);
      await loadThread(currentThreadId());
      toast('回复已发表');
    } catch (error) {
      setError(errorBox, describeError(error));
    }
  }

  // ------------------------------------------------------------ 发帖表单

  function bindComposer(): void {
    const form = root.querySelector<HTMLFormElement>('[data-part="compose"]');
    if (!form) return;
    const fileInput = form.querySelector<HTMLInputElement>('[data-part="file"]');
    const drop = form.querySelector<HTMLElement>('[data-part="drop"]');
    const fileInfo = form.querySelector<HTMLElement>('[data-part="file-info"]');
    const errorBox = form.querySelector<HTMLElement>('[data-part="compose-error"]');
    const progress = form.querySelector<HTMLProgressElement>('[data-part="progress"]');
    const submit = form.querySelector<HTMLButtonElement>('[data-part="submit"]');
    const bodyCount = form.querySelector<HTMLElement>('[data-part="body-count"]');
    const textarea = form.querySelector<HTMLTextAreaElement>('textarea[name="body"]');

    textarea?.addEventListener('input', () => {
      if (bodyCount) bodyCount.textContent = String(textarea.value.length);
    });

    let file: File | null = null;
    let cover: File | null = null;
    /** 预览用的 objectURL，换图/卸载时必须 revoke，否则整页会一直攒着内存 */
    let coverObjectUrl: string | null = null;

    const acceptFile = (candidate: File | null): void => {
      if (!candidate) {
        file = null;
        if (fileInfo) fileInfo.hidden = true;
        return;
      }
      const problem = validateStructureFile(candidate);
      if (problem) {
        file = null;
        if (fileInput) fileInput.value = '';
        if (fileInfo) fileInfo.hidden = true;
        setError(errorBox, problem);
        return;
      }
      file = candidate;
      setError(errorBox, null);
      if (fileInfo) {
        fileInfo.hidden = false;
        fileInfo.textContent = `已选择 ${candidate.name}（${formatBytes(candidate.size)}），发布时会一起上传。`;
      }
    };

    fileInput?.addEventListener('change', () => {
      acceptFile(fileInput.files?.[0] ?? null);
    });

    // 拖放：与工具箱的文件选择保持同一套手势
    drop?.addEventListener('dragover', (event) => {
      event.preventDefault();
      drop.classList.add('is-over');
    });
    drop?.addEventListener('dragleave', () => drop.classList.remove('is-over'));
    drop?.addEventListener('drop', (event) => {
      event.preventDefault();
      drop.classList.remove('is-over');
      acceptFile(event.dataTransfer?.files?.[0] ?? null);
    });

    // ---- 封面
    const coverInput = form.querySelector<HTMLInputElement>('[data-part="cover"]');
    const coverDrop = form.querySelector<HTMLElement>('[data-part="cover-drop"]');
    const coverPreview = form.querySelector<HTMLElement>('[data-part="cover-preview"]');
    const coverPreviewImg = form.querySelector<HTMLImageElement>('[data-part="cover-preview-img"]');
    const coverInfo = form.querySelector<HTMLElement>('[data-part="cover-info"]');

    const releaseCoverUrl = (): void => {
      if (coverObjectUrl) URL.revokeObjectURL(coverObjectUrl);
      coverObjectUrl = null;
    };

    const clearCover = (): void => {
      cover = null;
      releaseCoverUrl();
      if (coverInput) coverInput.value = '';
      if (coverPreview) coverPreview.hidden = true;
    };

    const acceptCover = (candidate: File | null): void => {
      if (!candidate) {
        clearCover();
        return;
      }
      const problem = validateCoverFile(candidate);
      if (problem) {
        clearCover();
        setError(errorBox, problem);
        return;
      }
      setError(errorBox, null);
      cover = candidate;
      releaseCoverUrl();
      coverObjectUrl = URL.createObjectURL(candidate);
      if (coverPreviewImg) {
        coverPreviewImg.onload = () => {
          // 浏览器解出来的真实像素，比扩展名可靠
          const width = coverPreviewImg.naturalWidth;
          const height = coverPreviewImg.naturalHeight;
          if (!width || !height || cover !== candidate) return;
          const hint = coverCropNotice({
            width,
            height,
          } as ThreadCover);
          if (coverInfo) {
            coverInfo.textContent = [describePickedCover(candidate, { width, height }), hint]
              .filter(Boolean)
              .join(' ');
          }
        };
        coverPreviewImg.src = coverObjectUrl;
      }
      if (coverPreview) coverPreview.hidden = false;
      if (coverInfo) coverInfo.textContent = describePickedCover(candidate, null);
    };

    coverInput?.addEventListener('change', () => {
      acceptCover(coverInput.files?.[0] ?? null);
    });

    coverDrop?.addEventListener('dragover', (event) => {
      event.preventDefault();
      coverDrop.classList.add('is-over');
    });
    coverDrop?.addEventListener('dragleave', () => coverDrop.classList.remove('is-over'));
    coverDrop?.addEventListener('drop', (event) => {
      event.preventDefault();
      coverDrop.classList.remove('is-over');
      acceptCover(event.dataTransfer?.files?.[0] ?? null);
    });

    form.querySelector('[data-act="clear-cover"]')?.addEventListener('click', clearCover);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void submitComposer();
    });

    async function submitComposer(): Promise<void> {
      if (!form || !submit) return;
      const category = (form.querySelector<HTMLSelectElement>('select[name="category"]')?.value ?? '').trim();
      const title = (form.querySelector<HTMLInputElement>('input[name="title"]')?.value ?? '').trim();
      const body = (textarea?.value ?? '').trim();

      if (title.length < 2) return setError(errorBox, '标题至少 2 个字。');
      if (body.length < 2) return setError(errorBox, '正文至少 2 个字。');
      if (!category) return setError(errorBox, '请选择一个版块。');

      setError(errorBox, null);
      submit.disabled = true;
      const uploading = Boolean(file || cover);
      submit.textContent = uploading ? '正在上传并解析…' : '发布中…';
      if (uploading && progress) {
        progress.hidden = false;
        progress.value = 0;
      }

      try {
        const payload = { category, title, body };
        const thread = uploading
          ? await createThreadWithAttachments(payload, { structure: file, cover }, (sent, total) => {
              if (progress) progress.value = total > 0 ? Math.round((sent / total) * 100) : 0;
            })
          : await createThread(payload);
        state.threads = [];
        state.nextCursor = null;
        toast(describePublishResult(file, cover));
        navigate(`#/t/${thread.id}`);
      } catch (error) {
        setError(errorBox, describeError(error));
        submit.disabled = false;
        submit.textContent = '发布';
        if (progress) progress.hidden = true;
      } finally {
        releaseCoverUrl();
      }
    }
  }

  // ------------------------------------------------------------ 3D 预览

  async function mountRenderer(threadId: number): Promise<void> {
    const host = root.querySelector<HTMLElement>('[data-part="preview"]');
    if (!host) return;

    // 载荷按帖子缓存：回复一次就会重绘详情，重新拉几百 KB 的载荷纯属浪费。
    // 内容寻址 + 不可变（后端给的是 immutable 缓存头），所以缓存永远安全。
    let payload = renderCache.get(threadId);
    if (!payload) {
      try {
        payload = await fetchRenderPayload(threadId);
        renderCache.set(threadId, payload);
      } catch (error) {
        host.innerHTML = `<p class="forum-empty">3D 预览没能加载：${escapeHtml(describeError(error))}</p>`;
        return;
      }
    }
    // 加载期间用户可能已经返回列表
    if (!root.contains(host)) return;
    try {
      state.disposeVoxel = mountVoxelView(host, payload);
    } catch (error) {
      host.innerHTML = `<p class="forum-empty">3D 预览没能渲染：${escapeHtml(describeError(error))}</p>`;
    }
  }

  function currentThreadId(): number {
    const target = currentRoute();
    return target.name === 'thread' ? target.id : 0;
  }

  // ------------------------------------------------------------ 卸载
  //
  // 这个 return 必须留在 mountForum 的**最后**：函数声明会提升，写在它后面的
  // `root.addEventListener` 不会——放在中间的话事件绑定永远执行不到，
  // 页面看起来正常，却完全点不动。
  return () => {
    window.removeEventListener(SESSION_EVENT, onSession);
    window.removeEventListener('hashchange', onHashChange);
    disposeVoxel();
    root.replaceChildren();
  };
}

// ---------------------------------------------------------------- 工具

function validateStructureFile(file: File): string | null {
  if (!file.name.toLowerCase().endsWith(STRUCTURE_EXTENSION)) {
    return `只接受 ${STRUCTURE_EXTENSION} 文件，这个是 ${file.name.split('.').pop() ?? '无扩展名'}。`;
  }
  if (file.size === 0) return '这个文件是空的。';
  if (file.size > MAX_STRUCTURE_BYTES) {
    return `文件 ${formatBytes(file.size)}，超过 ${formatBytes(MAX_STRUCTURE_BYTES)} 上限。`;
  }
  return null;
}

/**
 * 封面的前端预检。
 *
 * 只挡两件明显的事：扩展名不在白名单里、体积超限。**类型是否正确不在这里判断**——
 * 那要看文件头字节，只有服务端能做（见 `parsers/image_info`）。
 * 前端多放行一个，代价是一次往返；少放行一个，代价是用户明明有合法图片却传不上去。
 */
function validateCoverFile(file: File): string | null {
  const dot = file.name.lastIndexOf('.');
  const extension = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';
  // .jpg / .jpeg 都要放行；服务端认出来之后统一落成 .jpg
  const allowed = new Set([...COVER_EXTENSIONS, '.jpeg']);
  if (!allowed.has(extension)) {
    return `封面只接受 ${COVER_EXTENSIONS.join(' / ')}，这个是 ${extension || '无扩展名'}。`;
  }
  if (file.size === 0) return '这个文件是空的。';
  if (file.size > MAX_COVER_BYTES) {
    return `封面 ${formatBytes(file.size)}，超过 ${formatBytes(MAX_COVER_BYTES)} 上限。`;
  }
  return null;
}

/** 选好封面后的即时反馈：体积提示 + 预览的真实比例。 */
function describePickedCover(
  file: File,
  size: { width: number; height: number } | null,
): string {
  const parts = [`已选择 ${file.name}（${formatBytes(file.size)}）`];
  if (size) parts.push(`${formatCount(size.width)} × ${formatCount(size.height)}`);
  if (file.size > COVER_HEAVY_BYTES) {
    parts.push('偏大——列表每次都会加载它，建议压到 1 MB 以内');
  }
  return `${parts.join('，')}。`;
}

/**
 * 列表缩略图会裁掉一部分时的提醒。
 *
 * 前端读的是浏览器解出来的真实像素（`naturalWidth/Height`），比文件名可靠；
 * 但它只在**选图的那一刻**能提前告诉用户，最终入库的尺寸仍以服务端的字节解析为准。
 */
function coverCropNotice(cover: ThreadCover): string | null {
  return coverCropHint(cover);
}

/** 发布成功后的提示：说清楚到底带上去了什么，别让人猜。 */
function describePublishResult(structure: File | null, cover: File | null): string {
  if (structure && cover) return '帖子已发布，结构与封面都在处理';
  if (structure) return '帖子已发布，结构已解析';
  if (cover) return '帖子已发布，封面已保存';
  return '帖子已发布';
}

function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return '操作失败，请重试。';
}

/**
 * 版块加载失败时的说明。
 *
 * 这里单独写一份而不是直接用 `describeError`，是因为最常见的那种失败
 * （后端还在跑旧版本、没有 `/api/forum/categories` 这个接口）光说
 * 「请求失败（404）」对谁都没帮助：运维看不出要重启后端，访客也不知道
 * 该不该刷新。404 和网络错误给不同的话。
 */
function describeCategoriesError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) {
      return '服务端没有版块接口（404）：后端很可能还在运行旧版本，重启一次后端即可。';
    }
    return `读取版块失败：${error.message}`;
  }
  // fetch 在网络层失败时抛的是 TypeError，没有状态码可看
  return '连不上后端服务，请确认它正在运行。';
}

function setError(box: HTMLElement | null, message: string | null): void {
  if (!box) return;
  box.textContent = message ?? '';
  box.hidden = !message;
}

/**
 * 正文里的裸链接变成可点链接。
 *
 * 只做这一件事，不做 Markdown：论坛正文是**用户输入**，渲染 Markdown 等于
 * 把一份格式化语言交给不可信来源（04 文档第 5 节：用户评论不走可信作者流程）。
 * 先转义再套链接，顺序不能反，否则 `&lt;script&gt;` 会被重新解成标签。
 */
function linkify(text: string): string {
  return escapeHtml(text).replace(
    /(https?:\/\/[^\s<]+)/g,
    '<a href="$1" rel="noopener noreferrer nofollow" target="_blank">$1</a>',
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string,
  );
}
