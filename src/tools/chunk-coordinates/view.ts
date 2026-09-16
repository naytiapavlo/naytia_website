/**
 * 区块与坐标助手的界面（03 文档第 4 节 ToolView 的等价物；本工具用原生 DOM，理由见 README）。
 */
import {
  createForm,
  createNoteList,
  createResultPanel,
  createSection,
  createStatGrid,
  createUnknownState,
  createWarningList,
  escapeText,
} from '../_host/ui-kit';
import type { ToolViewContext } from '../_host/types';
import type { ChunkOutput } from './engine';
import { dimensionOptions } from './schema';

const LAST_INPUT_KEY = 'naytia:tool:chunk-coordinates:last';

interface StoredInput {
  x: string;
  z: string;
  dimension: string;
}

function loadLast(): StoredInput {
  const fallback: StoredInput = { x: '0', z: '0', dimension: 'overworld' };
  try {
    const raw = localStorage.getItem(LAST_INPUT_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<StoredInput>;
    return {
      x: typeof parsed.x === 'string' ? parsed.x : fallback.x,
      z: typeof parsed.z === 'string' ? parsed.z : fallback.z,
      dimension: typeof parsed.dimension === 'string' ? parsed.dimension : fallback.dimension,
    };
  } catch {
    return fallback;
  }
}

function saveLast(input: StoredInput): void {
  try {
    localStorage.setItem(LAST_INPUT_KEY, JSON.stringify(input));
  } catch {
    // 隐私模式等场景写入失败：不影响计算，静默跳过
  }
}

export function renderChunkResult(output: ChunkOutput): HTMLElement {
  const root = document.createElement('div');
  root.className = 'tool-output';

  const headline = document.createElement('p');
  headline.className = 'tool-headline';
  headline.innerHTML = `方块 <b>X ${escapeText(String(output.input.x))} / Z ${escapeText(String(output.input.z))}</b> 位于 <b>区块 ${output.chunk.x}, ${output.chunk.z}</b>`;
  root.appendChild(headline);

  root.appendChild(
    createStatGrid([
      { label: '区块坐标 (chunkX, chunkZ)', value: `${output.chunk.x}, ${output.chunk.z}`, strong: true },
      { label: '区块内坐标 (0 ~ 15)', value: `${output.offset.x}, ${output.offset.z}` },
      {
        label: '所在区块原点',
        value: `${output.chunkOrigin.x}, ${output.chunkOrigin.z}`,
        note: '区块覆盖范围的最小方块坐标',
      },
      {
        label: '区域文件 (region)',
        value: `${output.region.x}, ${output.region.z}`,
        note: `文件内区块下标 ${output.region.localIndex}`,
      },
    ]),
  );

  if (output.related.length > 0) {
    root.appendChild(
      createSection(
        '维度换算',
        createStatGrid(
          output.related.map((item) => ({
            label: item.label,
            value: `${item.x}, ${item.z}`,
            note: item.note,
          })),
        ),
      ),
    );
  }

  root.appendChild(createSection('说明', createNoteList(output.notes)));
  return root;
}

export function mount(container: HTMLElement, context: ToolViewContext<unknown, ChunkOutput>): void {
  const last = loadLast();
  const handle = createForm(
    [
      {
        name: 'x',
        label: '方块 X 坐标',
        type: 'text',
        value: last.x,
        placeholder: '例如 -17',
        hint: '可填负数；负坐标按向下取整归入区块',
      },
      {
        name: 'z',
        label: '方块 Z 坐标',
        type: 'text',
        value: last.z,
        placeholder: '例如 33',
        hint: '东西方向为 X，南北方向为 Z',
      },
      {
        name: 'dimension',
        label: '维度',
        type: 'select',
        value: last.dimension,
        options: dimensionOptions.map((d) => ({ value: d.id, label: d.label })),
        hint: '影响维度换算结果，不影响区块编号',
      },
    ],
    '开始计算',
  );

  const result = createResultPanel();
  container.append(handle.form, result.panel);
  result.render(createUnknownState());

  let running = false;

  handle.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (running) return;
    running = true;
    handle.clearErrors();
    const raw = handle.values();
    saveLast({ x: raw.x ?? '', z: raw.z ?? '', dimension: raw.dimension ?? 'overworld' });

    const outcome = await context.compute(raw);
    running = false;

    if (!outcome.ok) {
      handle.markField(outcome.error.field, outcome.error.message);
      const box = document.createElement('div');
      box.className = 'tool-error';
      box.setAttribute('role', 'alert');
      const strong = document.createElement('strong');
      strong.textContent = outcome.error.message;
      box.appendChild(strong);
      result.render(box);
      return;
    }

    const wrapper = renderChunkResult(outcome.value);
    if (outcome.warnings.length > 0) {
      wrapper.prepend(createWarningList(outcome.warnings));
    }
    result.render(wrapper);
  });
}
