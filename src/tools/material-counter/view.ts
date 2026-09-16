/**
 * 材料清单助手的界面。
 * 多条材料用可增删的行编辑器；行字段名用「entries-<i>-<name>」，
 * 与 schema 的错误路径「entries.<i>.<name>」一一对应，出错时能精确标到某个输入框。
 */
import {
  createNoteList,
  createResultPanel,
  createSection,
  createStatGrid,
  createTable,
  createUnknownState,
  createWarningList,
  escapeText,
} from '../_host/ui-kit';import type { ToolViewContext } from '../_host/types';
import type { MaterialLine, MaterialOutput } from './engine';
import { CONTAINER_PRESETS, MAX_ENTRIES, STACK_PRESETS } from './schema';

const LAST_INPUT_KEY = 'naytia:tool:material-counter:last';
const DEFAULT_STACK = '64';

interface StoredRow {
  name: string;
  count: string;
  stackSize: string;
}

interface StoredInput {
  rows: StoredRow[];
  container: string;
}

const FALLBACK: StoredInput = {
  rows: [
    { name: '石头', count: '2432', stackSize: '64' },
    { name: '', count: '', stackSize: DEFAULT_STACK },
  ],
  container: 'shulker',
};

function loadLast(): StoredInput {
  try {
    const raw = localStorage.getItem(LAST_INPUT_KEY);
    if (!raw) return FALLBACK;
    const parsed = JSON.parse(raw) as Partial<StoredInput>;
    const rows = Array.isArray(parsed.rows)
      ? parsed.rows
          .filter((row): row is StoredRow => typeof row === 'object' && row !== null)
          .slice(0, MAX_ENTRIES)
          .map((row) => ({
            name: typeof row.name === 'string' ? row.name : '',
            count: typeof row.count === 'string' ? row.count : '',
            stackSize: typeof row.stackSize === 'string' ? row.stackSize : DEFAULT_STACK,
          }))
      : FALLBACK.rows;
    return {
      rows: rows.length > 0 ? rows : FALLBACK.rows,
      container:
        typeof parsed.container === 'string' &&
        CONTAINER_PRESETS.some((preset) => preset.id === parsed.container)
          ? parsed.container
          : FALLBACK.container,
    };
  } catch {
    return FALLBACK;
  }
}

function saveLast(input: StoredInput): void {
  try {
    localStorage.setItem(LAST_INPUT_KEY, JSON.stringify(input));
  } catch {
    // 隐私模式等场景写入失败：不影响计算
  }
}

export function renderMaterialResult(output: MaterialOutput): HTMLElement {
  const root = document.createElement('div');
  root.className = 'tool-output';

  const headline = document.createElement('p');
  headline.className = 'tool-headline';
  headline.innerHTML = `共 <b>${output.totals.kinds}</b> 种材料、<b>${output.totals.slots}</b> 格${
    output.container ? `，需要 <b>${output.container.need}</b> 个${escapeText(output.container.label)}` : ''
  }`;
  root.appendChild(headline);

  const containerEntries = output.container
    ? [
        {
          label: `需要的容器数量`,
          value: `${output.container.need} 个`,
          note: output.container.label,
          strong: true,
        },
        {
          label: '容器总容量',
          value: `${output.container.capacity} 格`,
          note: output.container.exact ? '刚好装满' : `剩余 ${output.container.spare} 格空位`,
        },
      ]
    : [];

  root.appendChild(
    createStatGrid([
      { label: '材料种类', value: `${output.totals.kinds} 种` },
      { label: '物品总数', value: output.totals.count.toLocaleString('zh-CN') },
      { label: '满组数合计', value: `${output.totals.fullStacks} 组` },
      { label: '占用格数合计', value: `${output.totals.slots} 格`, strong: true },
      ...containerEntries,
    ]),
  );

  root.appendChild(
    createSection(
      '按材料明细',
      createTable(
        ['材料', '数量', '堆叠上限', '组数', '零头', '占用格数'],
        output.lines.map((line: MaterialLine) => [
          line.name,
          line.count.toLocaleString('zh-CN'),
          String(line.stackSize),
          `${line.fullStacks} 组`,
          line.remainder === 0 ? '—' : `${line.remainder} 个`,
          `${line.slots} 格`,
        ]),
      ),
    ),
  );

  root.appendChild(createSection('换算过程', createNoteList(output.formula)));
  return root;
}

export function mount(container: HTMLElement, context: ToolViewContext<unknown, MaterialOutput>): void {
  const saved = loadLast();
  let rowSeq = 0;

  const form = document.createElement('form');
  form.className = 'tool-form';
  form.noValidate = true;

  const rowsBox = document.createElement('div');
  rowsBox.className = 'material-rows';

  const containerField = document.createElement('div');
  containerField.className = 'tool-field';
  containerField.dataset.field = 'container';
  const containerLabel = document.createElement('label');
  containerLabel.htmlFor = 'material-container';
  containerLabel.textContent = '换算成容器';
  const containerSelect = document.createElement('select');
  containerSelect.id = 'material-container';
  containerSelect.name = 'container';
  for (const preset of CONTAINER_PRESETS) {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.label;
    containerSelect.appendChild(option);
  }
  containerSelect.value = saved.container;
  const containerHint = document.createElement('small');
  containerHint.className = 'tool-field-hint';
  containerHint.textContent = '容器数按占用格数换算，不假设多种材料之间的最优装箱';
  containerField.append(containerLabel, containerSelect, containerHint);

  const fieldError = document.createElement('span');
  fieldError.className = 'tool-field-error';
  fieldError.hidden = true;

  const actions = document.createElement('div');
  actions.className = 'tool-actions';
  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.className = 'tool-secondary';
  addButton.textContent = '+ 添加一种材料';
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'tool-submit';
  submit.textContent = '开始计算';
  actions.append(addButton, submit);

  form.append(rowsBox, containerField, fieldError, actions);
  rowsBox.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest('button[data-remove]');
    if (!button) return;
    const row = button.closest('.material-row');
    if (row && rowsBox.querySelectorAll('.material-row').length > 1) row.remove();
  });

  const result = createResultPanel();
  container.append(form, result.panel);
  result.render(createUnknownState());

  function fieldsOf(row: HTMLElement): {
    name: HTMLInputElement;
    count: HTMLInputElement;
    stackSize: HTMLInputElement;
  } {
    return {
      name: row.querySelector<HTMLInputElement>('input[data-role=name]')!,
      count: row.querySelector<HTMLInputElement>('input[data-role=count]')!,
      stackSize: row.querySelector<HTMLInputElement>('input[data-role=stack]')!,
    };
  }

  function addRow(initial: StoredRow): void {
    const index = rowsBox.querySelectorAll('.material-row').length;
    if (index >= MAX_ENTRIES) return;
    const rowId = `material-row-${(rowSeq += 1)}`;
    const value = initial.name;
    const count = initial.count;
    const stack = initial.stackSize;

    const row = document.createElement('div');
    row.className = 'material-row';
    row.dataset.index = String(index);
    row.innerHTML = `
      <div class="material-cell is-name">
        <label for="${rowId}-name">材料 ${index + 1}</label>
        <input id="${rowId}-name" data-role="name" data-field="entries-${index}-name"
               list="material-stack-notes" maxlength="40" autocomplete="off"
               placeholder="例如 石头" value="${escapeText(value)}" />
      </div>
      <div class="material-cell is-count">
        <label for="${rowId}-count">数量</label>
        <input id="${rowId}-count" data-role="count" data-field="entries-${index}-count"
               inputmode="numeric" autocomplete="off" placeholder="例如 2432" value="${escapeText(count)}" />
      </div>
      <div class="material-cell is-stack">
        <label for="${rowId}-stack">堆叠上限</label>
        <input id="${rowId}-stack" data-role="stack" data-field="entries-${index}-stack"
               inputmode="numeric" autocomplete="off" value="${escapeText(stack)}"
               aria-describedby="${rowId}-stack-hint" />
        <small id="${rowId}-stack-hint" class="material-stack-hint">常用 ${STACK_PRESETS.join(' / ')}，按物品实际填</small>
      </div>
      <button type="button" class="material-remove" data-remove aria-label="删除第 ${index + 1} 条材料">×</button>
    `;
    rowsBox.appendChild(row);
  }

  function renumber(): void {
    rowsBox.querySelectorAll<HTMLElement>('.material-row').forEach((row, index) => {
      row.dataset.index = String(index);
      const label = row.querySelector<HTMLLabelElement>('.material-cell.is-name label');
      if (label) label.textContent = `材料 ${index + 1}`;
      row.querySelectorAll<HTMLInputElement>('input[data-field]').forEach((input) => {
        const role = input.dataset.role ?? '';
        input.dataset.field = `entries-${index}-${role}`;
      });
      const remove = row.querySelector<HTMLButtonElement>('.material-remove');
      if (remove) remove.setAttribute('aria-label', `删除第 ${index + 1} 条材料`);
    });
  }

  addButton.addEventListener('click', () => {
    addRow({ name: '', count: '', stackSize: DEFAULT_STACK });
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    fieldError.hidden = true;
    fieldError.textContent = '';
    form.querySelectorAll('.has-error').forEach((el) => {
      el.classList.remove('has-error');
      el.removeAttribute('aria-invalid');
    });

    const rows: StoredRow[] = [];
    rowsBox.querySelectorAll<HTMLElement>('.material-row').forEach((row) => {
      const fields = fieldsOf(row);
      rows.push({
        name: fields.name.value,
        count: fields.count.value,
        stackSize: fields.stackSize.value,
      });
    });

    const payload = { entries: rows, container: containerSelect.value };
    saveLast({ rows, container: containerSelect.value });

    const outcome = await context.compute(payload);
    if (!outcome.ok) {
      // schema 的字段路径 entries.<i>.<name> → 界面字段名 entries-<i>-<name>
      const target = outcome.error.field?.replace(/\./g, '-');
      const input = target
        ? form.querySelector<HTMLInputElement>(`input[data-field="${CSS.escape(target)}"]`)
        : null;
      if (input) {
        input.classList.add('has-error');
        input.setAttribute('aria-invalid', 'true');
        input.focus();
      } else {
        fieldError.textContent = outcome.error.message;
        fieldError.hidden = false;
      }
      const box = document.createElement('div');
      box.className = 'tool-error';
      box.setAttribute('role', 'alert');
      const strong = document.createElement('strong');
      strong.textContent = outcome.error.message;
      const meta = document.createElement('small');
      meta.textContent = `错误代码：${outcome.error.code}`;
      box.append(strong, meta);
      result.render(box);
      return;
    }

    const wrapper = renderMaterialResult(outcome.value);
    if (outcome.warnings.length > 0) wrapper.prepend(createWarningList(outcome.warnings));
    result.render(wrapper);
  });

  for (const row of saved.rows.length > 0 ? saved.rows : FALLBACK.rows) addRow(row);
  renumber();
}
