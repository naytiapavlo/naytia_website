/**
 * 工具界面共用件（03 文档第 4 节：通用字段可以复用表单组件）。
 * 生成的是真实 DOM 元素，不受 innerHTML 注入影响；标签、错误提示与 aria 一并给出。
 */

export interface FieldSpec {
  name: string;
  label: string;
  type?: 'number' | 'select' | 'text';
  value?: string;
  placeholder?: string;
  hint?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: ReadonlyArray<{ value: string; label: string }>;
}

export interface FormHandle {
  readonly form: HTMLFormElement;
  /** 以 string 收集各字段原始值；解析交给 schema，界面不预先猜测。 */
  values(): Record<string, string>;
  /** 指出某个字段有问题：加红色边框并显示可读消息。 */
  markField(field: string | undefined, message: string): void;
  clearErrors(): void;
}

export function escapeText(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

function fieldId(name: string): string {
  return `field-${name.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

export function createForm(specs: readonly FieldSpec[], submitLabel: string): FormHandle {
  const form = document.createElement('form');
  form.className = 'tool-form';
  form.noValidate = true;

  const inputs = new Map<string, HTMLInputElement | HTMLSelectElement>();

  for (const spec of specs) {
    const wrap = document.createElement('div');
    wrap.className = 'tool-field';
    wrap.dataset.field = spec.name;

    const label = document.createElement('label');
    label.htmlFor = fieldId(spec.name);
    label.textContent = spec.label;

    let input: HTMLInputElement | HTMLSelectElement;
    if (spec.type === 'select') {
      const select = document.createElement('select');
      for (const option of spec.options ?? []) {
        const el = document.createElement('option');
        el.value = option.value;
        el.textContent = option.label;
        select.appendChild(el);
      }
      if (spec.value !== undefined) select.value = spec.value;
      input = select;
    } else {
      const el = document.createElement('input');
      el.type = spec.type === 'text' || spec.type === undefined ? 'text' : spec.type;
      if (spec.type !== 'text' && spec.type !== undefined) el.inputMode = 'numeric';
      if (spec.placeholder) el.placeholder = spec.placeholder;
      if (spec.value !== undefined) el.value = spec.value;
      if (spec.min !== undefined) el.min = String(spec.min);
      if (spec.max !== undefined) el.max = String(spec.max);
      if (spec.step !== undefined) el.step = String(spec.step);
      el.autocomplete = 'off';
      input = el;
    }
    input.id = fieldId(spec.name);
    input.name = spec.name;

    const hint = document.createElement('small');
    hint.className = 'tool-field-hint';
    hint.textContent = spec.hint ?? '';
    hint.hidden = !spec.hint;

    // 字段级错误：默认隐藏，由 markField 打开
    const error = document.createElement('span');
    error.className = 'tool-field-error';
    error.hidden = true;

    wrap.append(label, input, hint, error);
    form.appendChild(wrap);
    inputs.set(spec.name, input);
  }

  const actions = document.createElement('div');
  actions.className = 'tool-actions';
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'tool-submit';
  submit.textContent = submitLabel;
  actions.appendChild(submit);
  form.appendChild(actions);

  const clearErrors = (): void => {
    form.querySelectorAll('.tool-field-error').forEach((el) => {
      el.textContent = '';
      (el as HTMLElement).hidden = true;
    });
    form.querySelectorAll('.tool-field input, .tool-field select').forEach((el) => {
      el.classList.remove('has-error');
      el.removeAttribute('aria-invalid');
    });
  };

  const markField = (field: string | undefined, message: string): void => {
    if (!field) return;
    const wrap = form.querySelector<HTMLElement>(`.tool-field[data-field="${CSS.escape(field)}"]`);
    const input = inputs.get(field);
    const error = wrap?.querySelector<HTMLElement>('.tool-field-error');
    if (error) {
      error.textContent = message;
      error.hidden = false;
    }
    if (input) {
      input.classList.add('has-error');
      input.setAttribute('aria-invalid', 'true');
    }
  };

  return {
    form,
    values: () => {
      const out: Record<string, string> = {};
      inputs.forEach((input, name) => {
        out[name] = input.value;
      });
      return out;
    },
    markField,
    clearErrors,
  };
}

/** 键值结果卡：输入与输出都按同一形态展示，便于对照。 */
export function createStatGrid(
  entries: ReadonlyArray<{ label: string; value: string; note?: string; strong?: boolean }>,
): HTMLElement {
  const grid = document.createElement('dl');
  grid.className = 'tool-stats';
  for (const entry of entries) {
    const cell = document.createElement('div');
    cell.className = entry.strong ? 'tool-stat is-strong' : 'tool-stat';
    const dt = document.createElement('dt');
    dt.textContent = entry.label;
    const dd = document.createElement('dd');
    dd.textContent = entry.value;
    cell.append(dt, dd);
    if (entry.note) {
      const note = document.createElement('small');
      note.textContent = entry.note;
      cell.appendChild(note);
    }
    grid.appendChild(cell);
  }
  return grid;
}

export function createTable(
  columns: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string>>,
): HTMLElement {
  const table = document.createElement('table');
  table.className = 'tool-table';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const column of columns) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = column;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const cell of row) {
      const td = document.createElement('td');
      td.textContent = cell;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  return table;
}

export function createNoteList(items: readonly string[], className = 'tool-notes'): HTMLElement {
  const ul = document.createElement('ul');
  ul.className = className;
  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = item;
    ul.appendChild(li);
  }
  return ul;
}

export function createSection(title: string, ...children: HTMLElement[]): HTMLElement {
  const section = document.createElement('section');
  section.className = 'tool-section';
  const heading = document.createElement('h4');
  heading.textContent = title;
  section.append(heading, ...children);
  return section;
}

export function createUnknownState(): HTMLElement {
  const p = document.createElement('p');
  p.className = 'tool-state';
  p.textContent = '填写上面的数值后点「开始计算」。';
  return p;
}

export function createErrorState(error: { code: string; message: string; retryable: boolean }): HTMLElement {
  const box = document.createElement('div');
  box.className = 'tool-error';
  box.setAttribute('role', 'alert');
  const title = document.createElement('strong');
  title.textContent = error.message;
  const meta = document.createElement('small');
  meta.textContent = `错误代码：${error.code}${error.retryable ? ' · 可重试' : ''}`;
  box.append(title, meta);
  return box;
}

export function createWarningList(warnings: readonly string[]): HTMLElement {
  const box = document.createElement('div');
  box.className = 'tool-warning';
  for (const warning of warnings) {
    const p = document.createElement('p');
    p.textContent = warning;
    box.appendChild(p);
  }
  return box;
}

/** 可访问的结果区：内容变化由屏幕阅读器播报（01 文档第 10 节键盘与可读性）。 */
export function createResultPanel(): {
  panel: HTMLElement;
  render(node: HTMLElement): void;
  reset(): void;
} {
  const panel = document.createElement('div');
  panel.className = 'tool-result';
  panel.setAttribute('role', 'status');
  panel.setAttribute('aria-live', 'polite');
  return {
    panel,
    render: (node) => {
      panel.replaceChildren(node);
      panel.classList.add('has-content');
    },
    reset: () => {
      panel.replaceChildren();
      panel.classList.remove('has-content');
    },
  };
}
