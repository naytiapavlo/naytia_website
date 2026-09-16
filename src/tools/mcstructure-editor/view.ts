/**
 * mcstructure 编辑器界面 —— 两种直接编辑方式。
 *
 *   1. **NBT 树**：按标签树逐节点看与改。可展开折叠、改值、改类型、新增字段/元素、删除、改名。
 *   2. **SNBT 文本**：把整棵 NBT 树当作文本编辑（可整段复制粘贴），点「应用改动」写回。
 *
 * 两者操作的是**同一棵树**：树里改过之后 SNBT 文本会标记为「树里有更新」，
 * 反之点「应用改动」后树视图重画。真正的数据只有一份（`state.root`），
 * 所以不存在两边打架的问题。
 *
 * 文件全程留在浏览器：不调用后端解析接口，下载的是本地重新序列化的字节
 * （04 文档第 5 节：文件处理明确说明是否上传）。
 */
import { createWarningList } from '../_host/ui-kit';
import type { ToolViewContext } from '../_host/types';
import { toast } from '../../shared/toast';
import { encodeStructure, type EditorOutput } from './engine';
import { editorInputSchema } from './schema';
import { TAG, type NbtValue } from './nbt';
import {
  NbtEditError,
  addToCompound,
  addToList,
  changeType,
  describe,
  formatPath,
  getAtPath,
  isExpandable,
  removeAtPath,
  renameInCompound,
  setAtPath,
  summarizeNode,
  type NbtPath,
} from './nbt-edit';
import { SnbtParseError, parseSnbt, parseSnbtValue, rootToSnbt, toSnbt } from './snbt';
import {
  refreshDerived,
  summarize,
  syncBlockEntityPositions,
  type McStructureState,
  type StructureSummary,
} from './structure';

type Mode = 'tree' | 'snbt';

/** 可选的新增类型（TAG_End 只能作列表结束标记，不在其中）。 */
const ADDABLE_TYPES: Array<{ id: number; label: string; defaultValue: NbtValue }> = [
  { id: TAG.Compound, label: 'TAG_Compound 复合体', defaultValue: { type: TAG.Compound, value: new Map() } },
  { id: TAG.List, label: 'TAG_List 列表', defaultValue: { type: TAG.List, elementType: TAG.End, value: [] } },
  { id: TAG.String, label: 'TAG_String 字符串', defaultValue: { type: TAG.String, value: '' } },
  { id: TAG.Int, label: 'TAG_Int 整数', defaultValue: { type: TAG.Int, value: 0 } },
  { id: TAG.Byte, label: 'TAG_Byte 字节', defaultValue: { type: TAG.Byte, value: 0 } },
  { id: TAG.Short, label: 'TAG_Short 短整型', defaultValue: { type: TAG.Short, value: 0 } },
  { id: TAG.Long, label: 'TAG_Long 长整型', defaultValue: { type: TAG.Long, value: 0n } },
  { id: TAG.Float, label: 'TAG_Float 单精度', defaultValue: { type: TAG.Float, value: 0 } },
  { id: TAG.Double, label: 'TAG_Double 双精度', defaultValue: { type: TAG.Double, value: 0 } },
  { id: TAG.ByteArray, label: 'TAG_Byte_Array 字节数组', defaultValue: { type: TAG.ByteArray, value: [] } },
  { id: TAG.IntArray, label: 'TAG_Int_Array 整数数组', defaultValue: { type: TAG.IntArray, value: [] } },
  { id: TAG.LongArray, label: 'TAG_Long_Array 长整型数组', defaultValue: { type: TAG.LongArray, value: [] } },
];

interface Session {
  state: McStructureState;
  summary: StructureSummary;
  mode: Mode;
  path: NbtPath;
  expanded: Set<string>;
  /** SNBT 文本是否落后于树（树改过、文本还没重新生成） */
  snbtStale: boolean;
  dirty: boolean;
}

let session: Session | null = null;

export function mount(
  container: HTMLElement,
  context: ToolViewContext<unknown, EditorOutput>,
): () => void {
  session = null;
  container.replaceChildren();

  const root = document.createElement('div');
  root.className = 'mcs';
  root.innerHTML = `
    <section class="mcs-file">
      <div class="mcs-drop" data-part="drop" tabindex="0" role="button"
           aria-label="选择或拖入 .mcstructure 文件">
        <svg class="pixel" aria-hidden="true"><use href="#i-box" /></svg>
        <strong>选择一个 .mcstructure 文件</strong>
        <small>点这里选择，或把文件拖进来。文件只在你的浏览器里读写，不会上传。</small>
      </div>
      <input type="file" accept=".mcstructure" hidden data-part="input" />
      <div class="mcs-file-info" data-part="file-info" hidden></div>
    </section>

    <section class="mcs-work" data-part="work" hidden>
      <div class="mcs-toolbar">
        <div class="mcs-group" role="tablist" aria-label="编辑方式">
          <button type="button" class="mcs-btn" role="tab" data-mode="tree"
                  aria-selected="true">NBT 树</button>
          <button type="button" class="mcs-btn" role="tab" data-mode="snbt"
                  aria-selected="false">SNBT 文本</button>
        </div>
        <div class="mcs-group">
          <span class="mcs-path" data-part="path">(根)</span>
        </div>
        <div class="mcs-group mcs-group-end">
          <button type="button" class="mcs-btn mcs-primary" data-act="download">下载 .mcstructure</button>
          <button type="button" class="mcs-btn" data-act="reset">换一个文件</button>
        </div>
      </div>

      <p class="mcs-dirty" data-part="dirty" hidden>已修改（尚未下载）</p>
      <div class="mcs-warnings" data-part="warnings" hidden></div>

      <div class="mcs-pane" data-pane="tree">
        <div class="mcs-grid-area">
          <div class="mcs-panel mcs-tree-panel">
            <h3>NBT 标签树 <span data-part="tree-hint">点击节点查看与编辑</span></h3>
            <div class="mcs-tree" data-part="tree" role="tree" aria-label="NBT 标签树"></div>
          </div>
          <div class="mcs-panel">
            <h3>编辑选中节点</h3>
            <div data-part="node-editor"></div>
          </div>
        </div>
      </div>

      <div class="mcs-pane" data-pane="snbt" hidden>
        <div class="mcs-snbt-bar">
          <button type="button" class="mcs-btn mcs-primary" data-act="snbt-apply">应用改动</button>
          <button type="button" class="mcs-btn" data-act="snbt-reset">从树重新生成</button>
          <button type="button" class="mcs-btn" data-act="snbt-compact">压成一行</button>
          <span class="mcs-snbt-state" data-part="snbt-state"></span>
        </div>
        <p class="mcs-error" data-part="snbt-error" hidden></p>
        <textarea class="mcs-snbt" data-part="snbt" spellcheck="false"
                  aria-label="SNBT 文本"></textarea>
        <p class="mcs-hint">
          这里是整棵 NBT 树的 SNBT 表示，可以直接改、整段粘贴，再点「应用改动」。
          类型靠后缀区分：<code>1b</code> 字节、<code>1s</code> 短整型、<code>1</code> 整数、
          <code>1L</code> 长整型、<code>1.0f</code> 单精度、<code>1.0</code> 双精度；
          数组写作 <code>[B;1b,2b]</code> / <code>[I;1,2]</code> / <code>[L;1L,2L]</code>；
          <code>//</code> 开头的注释会被忽略。
        </p>
      </div>

      <div class="mcs-grid-area mcs-foot">
        <div class="mcs-panel">
          <h3>结构信息</h3>
          <div data-part="stats"></div>
        </div>
        <div class="mcs-panel">
          <h3>方块统计</h3>
          <div class="mcs-counts" data-part="counts"></div>
        </div>
      </div>
    </section>
  `;
  container.appendChild(root);

  const part = <T extends HTMLElement>(name: string): T =>
    root.querySelector<T>(`[data-part="${name}"]`)!;

  const input = part<HTMLInputElement>('input');
  const drop = part<HTMLDivElement>('drop');
  const fileInfo = part<HTMLDivElement>('file-info');
  const work = part<HTMLElement>('work');
  const treeBox = part<HTMLElement>('tree');
  const nodeEditor = part<HTMLElement>('node-editor');
  const snbtArea = part<HTMLTextAreaElement>('snbt');
  const snbtError = part<HTMLElement>('snbt-error');
  const snbtState = part<HTMLElement>('snbt-state');
  const pathLabel = part<HTMLElement>('path');
  const dirtyBadge = part<HTMLElement>('dirty');

  // ---- 文件选择
  const openPicker = (): void => input.click();
  drop.addEventListener('click', openPicker);
  drop.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openPicker();
    }
  });
  drop.addEventListener('dragover', (event) => {
    event.preventDefault();
    drop.classList.add('is-over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    drop.classList.remove('is-over');
    const file = event.dataTransfer?.files?.[0];
    if (file) void loadFile(file, context);
  });
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) void loadFile(file, context);
  });

  // ---- 模式切换
  root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => {
    button.addEventListener('click', () => switchMode(button.dataset.mode as Mode));
  });

  // ---- 工具条
  root.querySelector<HTMLButtonElement>('[data-act="download"]')!.addEventListener('click', download);
  root.querySelector<HTMLButtonElement>('[data-act="reset"]')!.addEventListener('click', () => {
    session = null;
    work.hidden = true;
    fileInfo.hidden = true;
    drop.hidden = false;
    input.value = '';
    toast('已清空，可以换一个文件');
  });

  // ---- SNBT 操作
  snbtArea.addEventListener('input', () => {
    if (!session) return;
    session.snbtStale = true;
    snbtState.textContent = '有未应用的改动';
    snbtState.className = 'mcs-snbt-state is-stale';
  });
  root.querySelector<HTMLButtonElement>('[data-act="snbt-apply"]')!
    .addEventListener('click', applySnbt);
  root.querySelector<HTMLButtonElement>('[data-act="snbt-reset"]')!.addEventListener('click', () => {
    if (!session) return;
    regenerateSnbt();
    snbtError.hidden = true;
    toast('已从当前的树重新生成 SNBT 文本');
  });
  root.querySelector<HTMLButtonElement>('[data-act="snbt-compact"]')!.addEventListener('click', () => {
    if (!session) return;
    try {
      snbtArea.value = rootToSnbt(session.state.root, { indent: 0 });
      session.snbtStale = true;
      snbtState.textContent = '有未应用的改动（已压成一行）';
      snbtState.className = 'mcs-snbt-state is-stale';
    } catch (error) {
      toast(error instanceof Error ? error.message : '生成失败');
    }
  });

  return () => {
    session = null;
  };

  // ------------------------------------------------------------ 内部实现

  function afterEdit(message: string): void {
    if (!session) return;
    session.dirty = true;
    dirtyBadge.hidden = false;
    try {
      // 树改过之后重新派生尺寸/层索引/调色板，保证统计与下载都基于改后的树
      refreshDerived(session.state);
      session.summary = summarize(session.state);
    } catch (error) {
      // 树暂时不构成合法结构：如实报出来，但不改动已派生的视图
      toast(`注意：当前树不构成合法结构 —— ${error instanceof Error ? error.message : ''}`);
    }
    session.snbtStale = true;
    renderTree();
    renderNodeEditor();
    renderStats();
    if (session.mode === 'snbt') syncSnbtState();
    if (message) toast(message);
  }

  function switchMode(mode: Mode): void {
    if (!session) return;
    session.mode = mode;
    root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => {
      const active = button.dataset.mode === mode;
      button.setAttribute('aria-selected', String(active));
      button.classList.toggle('mcs-primary', active);
    });
    root.querySelectorAll<HTMLElement>('[data-pane]').forEach((pane) => {
      pane.hidden = pane.dataset.pane !== mode;
    });
    if (mode === 'snbt') {
      syncSnbtState();
      snbtError.hidden = true;
    }
  }

  function syncSnbtState(): void {
    if (!session) return;
    if (session.snbtStale) {
      snbtState.textContent = '树里有更新 —— 点「从树重新生成」可同步';
      snbtState.className = 'mcs-snbt-state is-stale';
    } else {
      snbtState.textContent = '与树同步';
      snbtState.className = 'mcs-snbt-state';
    }
  }

  function regenerateSnbt(): void {
    if (!session) return;
    snbtArea.value = rootToSnbt(session.state.root);
    session.snbtStale = false;
    syncSnbtState();
  }

  function applySnbt(): void {
    if (!session) return;
    try {
      const parsed = parseSnbt(snbtArea.value);
      session.state.root = parsed;
      // 应用成功后重新派生；不合法会在这里被抓住并报给用户
      refreshDerived(session.state);
      session.summary = summarize(session.state);
      session.snbtStale = false;
      session.dirty = true;
      dirtyBadge.hidden = false;
      snbtError.hidden = true;
      // 路径可能已失效（键被删了），退回根节点
      if (getAtPath(session.state.root, session.path) === undefined) session.path = [];
      renderTree();
      renderNodeEditor();
      renderStats();
      syncSnbtState();
      toast('SNBT 已应用到 NBT 树');
    } catch (error) {
      showSnbtError(error);
    }
  }

  function showSnbtError(error: unknown): void {
    let message: string;
    if (error instanceof SnbtParseError) {
      message = `${error.message}${error.snippet ? `\n  ${error.snippet}` : ''}`;
    } else if (error instanceof NbtEditError) {
      message = error.message;
    } else if (error instanceof Error) {
      message = error.message;
    } else {
      message = '未知错误';
    }
    snbtError.textContent = message;
    snbtError.hidden = false;
  }

  function download(): void {
    if (!session) return;
    try {
      const synced = syncBlockEntityPositions(session.state);
      const bytes = encodeStructure(session.state);
      const blob = new Blob([bytes as BlobPart], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = downloadName(session.state.fileName);
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);

      session.dirty = false;
      dirtyBadge.hidden = true;
      toast(
        `已下载 ${link.download}（${bytes.length} 字节）` +
          (synced.changed ? `，同步了 ${synced.changed} 个方块实体坐标` : ''),
      );
    } catch (error) {
      toast(error instanceof Error ? error.message : '导出失败');
    }
  }

  async function loadFile(file: File, ctx: ToolViewContext<unknown, EditorOutput>): Promise<void> {
    const parsedInput = editorInputSchema.parse({ file });
    if (!parsedInput.ok) {
      fileInfo.hidden = false;
      fileInfo.className = 'mcs-file-info is-error';
      fileInfo.textContent = parsedInput.error.message;
      work.hidden = true;
      return;
    }

    fileInfo.hidden = false;
    fileInfo.className = 'mcs-file-info';
    fileInfo.textContent = `正在解析 ${file.name}（${(file.size / 1024).toFixed(1)} KB）…`;

    const outcome = await ctx.compute(parsedInput.value);
    if (!outcome.ok) {
      fileInfo.className = 'mcs-file-info is-error';
      fileInfo.textContent = outcome.error.message;
      work.hidden = true;
      return;
    }

    const { state, summary } = outcome.value;
    session = {
      state,
      summary,
      mode: 'tree',
      path: [],
      expanded: new Set(['']),   // 根默认展开
      snbtStale: true,
      dirty: false,
    };

    fileInfo.textContent =
      `${state.fileName} · ${state.size.x}×${state.size.y}×${state.size.z} · ` +
      `${summary.filled} 个方块 · ${(file.size / 1024).toFixed(1)} KB` +
      (state.compression === 'none' ? '' : ` · ${state.compression} 压缩`);

    const warnings = part<HTMLElement>('warnings');
    if (outcome.warnings.length > 0) {
      warnings.replaceChildren(createWarningList(outcome.warnings));
      warnings.hidden = false;
    } else {
      warnings.hidden = true;
    }

    drop.hidden = true;
    work.hidden = false;
    switchMode('tree');

    renderTree();
    renderNodeEditor();
    renderStats();
    toast(`已载入 ${state.fileName}`);
  }

  // ------------------------------------------------------------ NBT 树渲染

  function pathKey(path: NbtPath): string {
    return path.map((segment) => String(segment)).join('\u0000');
  }

  function renderTree(): void {
    if (!session) return;
    treeBox.replaceChildren();
    const rootValue: NbtValue = { type: TAG.Compound, value: session.state.root };
    treeBox.appendChild(buildNode('(根)', rootValue, [], 0));
    pathLabel.textContent = formatPath(session.path);
  }

  function buildNode(label: string, value: NbtValue, path: NbtPath, depth: number): HTMLElement {
    const row = document.createElement('div');
    row.className = pathKey(path) === pathKey(session!.path) ? 'mcs-node is-active' : 'mcs-node';
    row.style.paddingLeft = `${depth * 14}px`;

    const expandable = isExpandable(value);
    const isOpen = session!.expanded.has(pathKey(path));

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'mcs-node-toggle';
    toggle.textContent = expandable ? (isOpen ? '▾' : '▸') : '·';
    toggle.disabled = !expandable;
    toggle.setAttribute('aria-label', expandable ? (isOpen ? '折叠' : '展开') : '无子节点');
    if (expandable) {
      toggle.addEventListener('click', (event) => {
        event.stopPropagation();
        const key = pathKey(path);
        if (session!.expanded.has(key)) session!.expanded.delete(key);
        else session!.expanded.add(key);
        renderTree();
      });
    }

    const name = document.createElement('span');
    name.className = 'mcs-node-name';
    name.textContent = label;
    if (typeof path[path.length - 1] === 'number') name.classList.add('is-index');

    const type = document.createElement('span');
    type.className = `mcs-node-type t${value.type}`;
    type.textContent = describe(value);

    const preview = document.createElement('span');
    preview.className = 'mcs-node-preview';
    preview.textContent = summarizeNode(value);

    row.append(toggle, name, type, preview);
    row.addEventListener('click', () => {
      session!.path = path;
      renderTree();
      renderNodeEditor();
    });

    const wrap = document.createElement('div');
    wrap.className = 'mcs-node-wrap';
    wrap.appendChild(row);

    if (expandable && isOpen) {
      const children = document.createElement('div');
      if (value.type === TAG.Compound) {
        for (const [key, child] of value.value) {
          children.appendChild(buildNode(key, child, [...path, key], depth + 1));
        }
      } else if (value.type === TAG.List) {
        const limit = 500;   // 大列表只画前若干项，否则界面撑不住
        const total = value.value.length;
        for (let i = 0; i < Math.min(total, limit); i += 1) {
          children.appendChild(buildNode(`[${i}]`, value.value[i]!, [...path, i], depth + 1));
        }
        if (total > limit) {
          const more = document.createElement('div');
          more.className = 'mcs-node-more';
          more.style.paddingLeft = `${(depth + 1) * 14}px`;
          more.textContent = `…还有 ${total - limit} 项没显示（用 SNBT 文本模式看全量）`;
          children.appendChild(more);
        }
      }
      wrap.appendChild(children);
    }
    return wrap;
  }

  // ------------------------------------------------------------ 选中节点编辑

  function renderNodeEditor(): void {
    if (!session) return;
    nodeEditor.replaceChildren();
    const { path } = session;

    const value = getAtPath(session.state.root, path);
    if (value === undefined) {
      const empty = document.createElement('p');
      empty.className = 'mcs-hint';
      empty.textContent = '点左边的节点来编辑它。';
      nodeEditor.appendChild(empty);
      return;
    }

    const info = document.createElement('p');
    info.className = 'mcs-node-path';
    info.textContent = formatPath(path);
    nodeEditor.appendChild(info);

    const meta = document.createElement('p');
    meta.className = 'mcs-hint';
    meta.textContent = `类型：${describe(value)}`;
    nodeEditor.appendChild(meta);

    if (value.type !== TAG.Compound && value.type !== TAG.List) {
      nodeEditor.appendChild(buildValueEditor(path, value));
    } else if (value.type === TAG.List && value.value.length === 0) {
      const hint = document.createElement('p');
      hint.className = 'mcs-hint';
      hint.textContent = '空列表。用下面的「新增列表元素」放第一个元素，之后再改它的值。';
      nodeEditor.appendChild(hint);
    }

    nodeEditor.appendChild(buildTypeChanger(path, value));
    if (value.type === TAG.Compound) nodeEditor.appendChild(buildAddToCompound(path));
    if (value.type === TAG.List) nodeEditor.appendChild(buildAddToList(path, value));

    // ---- 改名 / 删除
    const actions = document.createElement('div');
    actions.className = 'mcs-node-actions';

    if (path.length > 0) {
      const parent = getAtPath(session.state.root, path.slice(0, -1));
      if (parent?.type === TAG.Compound && typeof path[path.length - 1] === 'string') {
        const rename = document.createElement('button');
        rename.type = 'button';
        rename.className = 'mcs-btn';
        rename.textContent = '改字段名';
        rename.addEventListener('click', () => {
          const current = String(path[path.length - 1]);
          const next = window.prompt('新的字段名：', current);
          if (next === null || next === current) return;
          try {
            renameInCompound(session!.state.root, path, next);
            session!.path = [...path.slice(0, -1), next];
            afterEdit(`已重命名为 ${next}`);
          } catch (error) {
            toast(error instanceof Error ? error.message : '改名失败');
          }
        });
        actions.appendChild(rename);
      }

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'mcs-btn mcs-danger';
      remove.textContent = '删除这个节点';
      remove.addEventListener('click', () => {
        try {
          removeAtPath(session!.state.root, path);
          session!.path = path.slice(0, -1);
          afterEdit('已删除');
        } catch (error) {
          toast(error instanceof Error ? error.message : '删除失败');
        }
      });
      actions.appendChild(remove);
    }
    nodeEditor.appendChild(actions);
  }

  function buildValueEditor(path: NbtPath, value: NbtValue): HTMLElement {
    const box = document.createElement('div');
    box.className = 'mcs-field';

    const label = document.createElement('label');
    label.htmlFor = 'mcs-value-input';
    label.textContent = '值（按 SNBT 写法）';

    const line = document.createElement('div');
    line.className = 'mcs-inline';

    const field = document.createElement('input');
    field.id = 'mcs-value-input';
    field.className = 'mcs-input';
    field.value = toSnbt(value, { indent: 0 });
    field.spellcheck = false;

    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'mcs-btn mcs-primary';
    save.textContent = '保存';

    const error = document.createElement('span');
    error.className = 'mcs-field-error';

    const commit = (): void => {
      try {
        const next = parseSnbtValue(field.value, 256);
        if (next.type !== value.type) {
          toast(`类型将由 ${describe(value)} 变成 ${describe(next)}`);
        }
        setAtPath(session!.state.root, path, next);
        error.textContent = '';
        afterEdit('已保存');
      } catch (err) {
        error.textContent = err instanceof Error ? err.message : '值不合法';
      }
    };

    save.addEventListener('click', commit);
    field.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      }
    });

    line.append(field, save);
    box.append(label, line, error);

    const hint = document.createElement('p');
    hint.className = 'mcs-hint';
    hint.textContent = value.type === TAG.String
      ? '字符串可以不加引号；含空格或特殊字符时用双引号包起来。'
      : '后缀决定类型：1b 字节 / 1s 短整型 / 1 整数 / 1L 长整型 / 1.0f 单精度 / 1.0 双精度。';
    box.appendChild(hint);
    return box;
  }

  function buildTypeChanger(path: NbtPath, value: NbtValue): HTMLElement {
    const box = document.createElement('div');
    box.className = 'mcs-field';

    const label = document.createElement('label');
    label.htmlFor = 'mcs-type-select';
    label.textContent = '标签类型';

    const select = document.createElement('select');
    select.id = 'mcs-type-select';
    select.className = 'mcs-input';
    for (const option of ADDABLE_TYPES) {
      const item = document.createElement('option');
      item.value = String(option.id);
      item.textContent = option.label;
      if (option.id === value.type) item.selected = true;
      select.appendChild(item);
    }

    select.addEventListener('change', () => {
      const target = Number(select.value);
      try {
        changeType(session!.state.root, path, target);
        afterEdit(`类型已改成 ${describe({ type: target } as NbtValue)}`);
      } catch (error) {
        toast(error instanceof Error ? error.message : '改类型失败');
        renderNodeEditor();
      }
    });

    const hint = document.createElement('p');
    hint.className = 'mcs-hint';
    hint.textContent = '标量之间互转会尽量保留数值；转成复合体/列表/数组会变成空的，不搬内容。';
    box.append(label, select, hint);
    return box;
  }

  function buildAddToCompound(path: NbtPath): HTMLElement {
    const box = document.createElement('div');
    box.className = 'mcs-field';

    const label = document.createElement('label');
    label.textContent = '新增字段';
    label.htmlFor = 'mcs-add-key';

    const row1 = document.createElement('div');
    row1.className = 'mcs-inline';
    const key = document.createElement('input');
    key.id = 'mcs-add-key';
    key.className = 'mcs-input';
    key.placeholder = '字段名，如 CustomName';
    row1.appendChild(key);

    const row2 = document.createElement('div');
    row2.className = 'mcs-inline';
    const typeSelect = document.createElement('select');
    typeSelect.className = 'mcs-input';
    for (const option of ADDABLE_TYPES) {
      const item = document.createElement('option');
      item.value = String(option.id);
      item.textContent = option.label;
      typeSelect.appendChild(item);
    }
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'mcs-btn mcs-primary';
    add.textContent = '添加';

    const error = document.createElement('span');
    error.className = 'mcs-field-error';

    add.addEventListener('click', () => {
      const name = key.value.trim();
      if (name === '') {
        error.textContent = '请填字段名';
        return;
      }
      const chosen = ADDABLE_TYPES.find((item) => item.id === Number(typeSelect.value))!;
      try {
        const result = addToCompound(session!.state.root, path, name, freshValue(chosen.defaultValue));
        key.value = '';
        error.textContent = '';
        session!.path = [...path, name];
        afterEdit(result.replaced ? `已覆盖同名字段 ${name}` : `已新增字段 ${name}`);
      } catch (err) {
        error.textContent = err instanceof Error ? err.message : '新增失败';
      }
    });

    row2.append(typeSelect, add);
    box.append(label, row1, row2, error);

    const hint = document.createElement('p');
    hint.className = 'mcs-hint';
    hint.textContent = '新增后会自动选中它，接着可以在下面填值。同名会覆盖。';
    box.appendChild(hint);
    return box;
  }

  function buildAddToList(path: NbtPath, value: NbtValue): HTMLElement {
    const box = document.createElement('div');
    box.className = 'mcs-field';

    const label = document.createElement('label');
    label.textContent = '新增列表元素';

    const row = document.createElement('div');
    row.className = 'mcs-inline';

    const error = document.createElement('span');
    error.className = 'mcs-field-error';

    if (value.type !== TAG.List) return box;
    const items = value.value;

    if (items.length === 0) {
      // 空列表：元素类型还没定，让用户先选
      const typeSelect = document.createElement('select');
      typeSelect.className = 'mcs-input';
      for (const option of ADDABLE_TYPES) {
        const item = document.createElement('option');
        item.value = String(option.id);
        item.textContent = option.label;
        typeSelect.appendChild(item);
      }
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'mcs-btn mcs-primary';
      add.textContent = '添加';
      add.addEventListener('click', () => {
        const chosen = ADDABLE_TYPES.find((item) => item.id === Number(typeSelect.value))!;
        try {
          const position = addToList(session!.state.root, path, freshValue(chosen.defaultValue));
          session!.path = [...path, position - 1];
          afterEdit(`已添加第 ${position} 项`);
        } catch (err) {
          error.textContent = err instanceof Error ? err.message : '添加失败';
        }
      });
      row.append(typeSelect, add);
      box.append(label, row, error);
      const hint = document.createElement('p');
      hint.className = 'mcs-hint';
      hint.textContent = '空列表的元素类型由第一个元素决定。';
      box.appendChild(hint);
      return box;
    }

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'mcs-btn mcs-primary';
    add.textContent = `追加一个 ${describe({ type: value.elementType } as NbtValue)}`;
    add.addEventListener('click', () => {
      try {
        const template = cloneValue(items[0]!);
        const position = addToList(session!.state.root, path, template);
        session!.path = [...path, position - 1];
        afterEdit(`已添加第 ${position} 项（复制了第一项，接着改它）`);
      } catch (err) {
        error.textContent = err instanceof Error ? err.message : '添加失败';
      }
    });
    row.appendChild(add);
    box.append(label, row, error);

    const hint = document.createElement('p');
    hint.className = 'mcs-hint';
    hint.textContent =
      'NBT 的列表要求元素同类型，所以新元素按现有类型创建；要换类型请先清空列表。';
    box.appendChild(hint);
    return box;
  }

  // ------------------------------------------------------------ 统计

  function renderStats(): void {
    if (!session) return;
    const { summary, state } = session;

    const stats = part<HTMLElement>('stats');
    stats.replaceChildren();
    const list = document.createElement('ul');
    list.className = 'mcs-list';
    const lines = [
      `尺寸：${state.size.x} × ${state.size.y} × ${state.size.z}（每层 ${state.size.x * state.size.z} 格）`,
      `层数：${summary.layerCount}（主层 + 次层共位）`,
      `方块：${summary.filled} 格，跨 ${summary.paletteUsed} 种`,
      `结构空位：${summary.voidSlots} 格（主层）`,
      `方块实体：${summary.blockEntities}`,
      `实体：${summary.entities}`,
      `结构原点：${summary.worldOrigin ? summary.worldOrigin.join(' / ') : '文件未记录'}` +
        (summary.originPlacement
          ? `（取自 ${summary.originPlacement === 'root' ? '根层级' : 'structure 内部'}）`
          : ''),
      `文件格式：v${summary.formatVersion ?? '?'} · ${summary.compression === 'none' ? '未压缩' : summary.compression}`,
      `根字段：${[...state.root.keys()].join('、')}`,
    ];
    for (const line of lines) {
      const item = document.createElement('li');
      item.textContent = line;
      list.appendChild(item);
    }
    stats.appendChild(list);

    const counts = part<HTMLElement>('counts');
    counts.replaceChildren();
    if (summary.counts.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'mcs-hint';
      empty.textContent = '还没有放置任何方块。';
      counts.appendChild(empty);
      return;
    }
    const table = document.createElement('table');
    table.className = 'mcs-table';
    for (const item of summary.counts.slice(0, 30)) {
      const row = document.createElement('tr');
      const name = document.createElement('td');
      name.textContent = item.name;
      const count = document.createElement('td');
      count.textContent = `${item.count} 格 · ${(item.ratio * 100).toFixed(1)}%`;
      row.append(name, count);
      table.appendChild(row);
    }
    counts.appendChild(table);
    if (summary.counts.length > 30) {
      const more = document.createElement('p');
      more.className = 'mcs-hint';
      more.textContent = `另有 ${summary.counts.length - 30} 种方块未列出。`;
      counts.appendChild(more);
    }
  }
}

// ---------------------------------------------------------------- 辅助

/** 新增节点时给一份互不共享的初值（复合体/列表要新建，避免两处改同一份）。 */
function freshValue(value: NbtValue): NbtValue {
  switch (value.type) {
    case TAG.Compound:
      return { type: TAG.Compound, value: new Map() };
    case TAG.List:
      return { type: TAG.List, elementType: TAG.End, value: [] };
    case TAG.ByteArray:
      return { type: TAG.ByteArray, value: [] };
    case TAG.IntArray:
      return { type: TAG.IntArray, value: [] };
    case TAG.LongArray:
      return { type: TAG.LongArray, value: [] };
    default:
      return { ...value } as NbtValue;
  }
}

/** 深拷贝一个 NBT 值（列表追加时用，避免新旧元素共享同一份 Map/数组）。 */
function cloneValue(value: NbtValue): NbtValue {
  switch (value.type) {
    case TAG.Compound: {
      const out = new Map<string, NbtValue>();
      for (const [key, child] of value.value) out.set(key, cloneValue(child));
      return { type: TAG.Compound, value: out };
    }
    case TAG.List:
      return {
        type: TAG.List,
        elementType: value.elementType,
        value: value.value.map(cloneValue),
      };
    case TAG.ByteArray:
      return { type: TAG.ByteArray, value: [...value.value] };
    case TAG.IntArray:
      return { type: TAG.IntArray, value: [...value.value] };
    case TAG.LongArray:
      return { type: TAG.LongArray, value: [...value.value] };
    default:
      return { ...value } as NbtValue;
  }
}

function downloadName(original: string): string {
  const base = original.replace(/\.mcstructure$/i, '');
  const suffix = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `${base}-edited-${suffix}.mcstructure`;
}
