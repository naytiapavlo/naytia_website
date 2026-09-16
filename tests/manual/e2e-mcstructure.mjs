// .mcstructure 编辑器（NBT 树 + SNBT 文本两种编辑方式）的浏览器端到端验证。
//
// 单元测试只能验证纯逻辑；这一层验证真实浏览器里的完整链路：
// 文件选择 → 宿主懒加载 → 树渲染 → 新增 NBT → SNBT 编辑与应用 → 下载 → 离线复解析。
//
// 用法：
//   node tests/manual/serve-dist.mjs 4399
//   msedge --headless=new --remote-debugging-port=9223 --user-data-dir=<临时目录> about:blank
//   node --import ./tests/resolve-ts.mjs tests/manual/e2e-mcstructure.mjs \
//        http://localhost:4399 http://127.0.0.1:9223 <夹具绝对路径> <尺寸文案>
//
// 这是一次性验证脚本，不属于项目源码（与同目录其它 e2e-*.mjs 一致）。
import { readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:4399';
const DEBUG_URL = process.argv[3] ?? 'http://127.0.0.1:9223';
const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '..', '..');
const FIXTURE =
  process.argv[4] ??
  join(REPO, 'backend', 'tests', 'fixtures', 'real', 'sticky-piston-1x1x1.mcstructure');
const EXPECT_SIZE_TEXT = process.argv[5] ?? '1×1×1';
const DOWNLOADS = join(REPO, '.tmp-downloads');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function assert(condition, message) {
  if (condition) {
    console.log(`    [OK] ${message}`);
  } else {
    failures += 1;
    console.log(`    [FAIL] ${message}`);
  }
}

async function main() {
  rmSync(DOWNLOADS, { recursive: true, force: true });
  mkdirSync(DOWNLOADS, { recursive: true });

  const targets = await (await fetch(`${DEBUG_URL}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('没有可用的页面目标');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('WebSocket 连接失败'));
  });

  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params?.exceptionDetails?.exception?.description ?? '未知异常');
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      const timer = setTimeout(() => {
        pending.delete(msgId);
        reject(new Error(`CDP 调用超时：${method}`));
      }, 20000);
      pending.set(msgId, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.result?.exceptionDetails) {
      throw new Error(
        `页面脚本异常：${
          res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text
        }`,
      );
    }
    return res.result?.result?.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('DOM.enable');
  await send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: DOWNLOADS,
    eventsEnabled: true,
  });

  // ---------------------------------------------------------------- 1
  console.log('\n[1] 工具页加载与宿主懒加载');
  await send('Page.navigate', { url: `${BASE}/tools/mcstructure-editor/` });
  await sleep(2600);
  const head = await evaluate(`(() => ({
    heading: document.querySelector('.tool-top h1')?.textContent ?? '',
    status: document.querySelector('.tool-status')?.textContent ?? '',
    drop: !!document.querySelector('.mcs-drop'),
  }))()`);
  assert(head.heading.includes('.mcstructure'), `详情页标题（${head.heading}）`);
  assert(head.status.includes('可用'), `状态为「可用」`);
  assert(head.drop, '懒加载的工具界面已挂载');

  // ---------------------------------------------------------------- 2
  console.log('\n[2] 上传文件 → NBT 树渲染');
  const doc = await send('DOM.getDocument', { depth: -1 });
  const inputNode = await send('DOM.querySelector', {
    nodeId: doc.result.root.nodeId,
    selector: 'input[type=file][data-part=input]',
  });
  await send('DOM.setFileInputFiles', { nodeId: inputNode.result.nodeId, files: [FIXTURE] });
  await sleep(1800);

  const loaded = await evaluate(`(() => ({
    infoText: (document.querySelector('[data-part="file-info"]')?.textContent ?? '').replace(/\\s+/g,' '),
    isError: document.querySelector('[data-part="file-info"]')?.className.includes('is-error') ?? false,
    workHidden: document.querySelector('[data-part="work"]')?.hidden ?? true,
    nodeCount: document.querySelectorAll('.mcs-node').length,
    rootLabels: [...document.querySelectorAll('.mcs-node-name')].slice(0, 6).map(e => e.textContent),
    stats: (document.querySelector('[data-part="stats"]')?.innerText ?? '').replace(/\\s+/g,' '),
    modes: [...document.querySelectorAll('[data-mode]')].map(b => b.textContent.trim()),
  }))()`);
  assert(!loaded.isError, '解析没有报错');
  assert(!loaded.workHidden, '工作区已显示');
  assert(loaded.infoText.includes(EXPECT_SIZE_TEXT), `文件信息显示尺寸 ${EXPECT_SIZE_TEXT}`);
  assert(loaded.nodeCount > 3, `NBT 树已渲染（${loaded.nodeCount} 个节点）`);
  assert(loaded.rootLabels.includes('format_version'), '树里出现 format_version');
  assert(loaded.rootLabels.includes('structure'), '树里出现 structure');
  assert(loaded.stats.includes('72 / 59 / -10'), '结构原点解析正确');
  assert(
    loaded.modes.includes('NBT 树') && loaded.modes.includes('SNBT 文本'),
    `两种编辑方式都在（${loaded.modes.join(' / ')}）`,
  );

  // ---------------------------------------------------------------- 3
  console.log('\n[3] NBT 树：展开 structure → palette → default，并选中一个节点');
  const expandResult = await evaluate(`(async () => {
    const click = (label) => {
      const nodes = [...document.querySelectorAll('.mcs-node')];
      const target = nodes.find(n => n.querySelector('.mcs-node-name')?.textContent === label);
      if (!target) return false;
      target.querySelector('.mcs-node-toggle')?.click() || target.click();
      return true;
    };
    // 逐个展开，每步等渲染
    const seq = ['structure', 'palette', 'default', 'block_palette', '[0]'];
    const trace = [];
    for (const label of seq) {
      const ok = click(label);
      trace.push(label + ':' + (ok ? 'ok' : 'miss'));
      await new Promise(r => setTimeout(r, 150));
    }
    return {
      trace,
      paletteEntrySelected: document.querySelector('[data-part="path"]')?.textContent ?? '',
      nodeEditorHasValue: !!document.querySelector('#mcs-value-input'),
      hasAddKey: !!document.querySelector('#mcs-add-key'),
      editorText: (document.querySelector('[data-part="node-editor"]')?.innerText ?? '').replace(/\\s+/g,' '),
    };
  })()`);
  assert(expandResult.trace.every((t) => t.endsWith('ok')), `逐层展开成功（${expandResult.trace.join(' ')}）`);
  assert(
    expandResult.paletteEntrySelected.includes('block_palette'),
    `路径栏显示选中的路径（${expandResult.paletteEntrySelected}）`,
  );
  // 复合体节点不该有「值」编辑框（值就是它的子节点），但必须有「新增字段」
  assert(!expandResult.nodeEditorHasValue, '复合体节点不出现「值」编辑框（值由子节点决定）');
  assert(expandResult.hasAddKey, '复合体节点提供「新增字段」输入框');
  assert(expandResult.editorText.includes('新增字段'), '节点编辑面板有「新增字段」区块');

  // 再选中一个标量节点（block_palette[0].name 是字符串），应当出现「值」编辑框
  const scalarResult = await evaluate(`(async () => {
    const click = (label) => {
      const nodes = [...document.querySelectorAll('.mcs-node')];
      const t = nodes.find(n => n.querySelector('.mcs-node-name')?.textContent === label);
      if (!t) return false;
      t.querySelector('.mcs-node-toggle')?.click() || t.click();
      return true;
    };
    click('name');
    await new Promise(r => setTimeout(r, 250));
    const input = document.querySelector('#mcs-value-input');
    return {
      path: document.querySelector('[data-part="path"]')?.textContent ?? '',
      hasValueInput: !!input,
      value: input?.value ?? null,
      type: (document.querySelector('[data-part="node-editor"]')?.innerText ?? '').replace(/\\s+/g,' ').slice(0, 60),
    };
  })()`);
  assert(scalarResult.hasValueInput, '标量节点出现「值」编辑框');
  assert(
    scalarResult.path.endsWith('.name'),
    `路径指向 block_palette[0].name（${scalarResult.path}）`,
  );
  assert(scalarResult.value === 'minecraft:sticky_piston', `值框里是当前值（${scalarResult.value}）`);

  // ---------------------------------------------------------------- 4
  console.log('\n[4] NBT 树：新增一个 NBT 字段（AddTag）并改它的值');
  const addResult = await evaluate(`(async () => {
    // 先选中根节点（复合体）
    const rootNode = document.querySelector('.mcs-node');
    rootNode.click();
    await new Promise(r => setTimeout(r, 150));

    const keyInput = document.querySelector('#mcs-add-key');
    if (!keyInput) return { error: '没有新增字段输入框' };
    keyInput.value = 'EditorTest';
    // 类型选 TAG_Int
    const selects = [...document.querySelectorAll('[data-part="node-editor"] select')];
    const typeSelect = selects[selects.length - 1] ?? selects[0];
    typeSelect.value = '3';
    const addBtn = [...document.querySelectorAll('[data-part="node-editor"] .mcs-btn')]
      .find(b => b.textContent.trim() === '添加');
    if (!addBtn) return { error: '没有添加按钮' };
    addBtn.click();
    await new Promise(r => setTimeout(r, 250));

    const names = [...document.querySelectorAll('.mcs-node-name')].map(e => e.textContent);
    const path = document.querySelector('[data-part="path"]')?.textContent ?? '';
    const valueInput = document.querySelector('#mcs-value-input');
    return {
      added: names.includes('EditorTest'),
      path,
      hasValueInput: !!valueInput,
      value: valueInput?.value ?? null,
      dirty: !document.querySelector('[data-part="dirty"]')?.hidden,
    };
  })()`);
  assert(!addResult.error, `新增字段没有报错${addResult.error ? `：${addResult.error}` : ''}`);
  assert(addResult.added, '新的 NBT 字段 EditorTest 出现在树里');
  assert(addResult.path === 'EditorTest', `新字段被自动选中（路径 ${addResult.path}）`);
  assert(addResult.value === '0', `新字段的初值按所选类型给出（${addResult.value}）`);
  assert(addResult.dirty, '「已修改」标记出现');

  // 把它的值改成 2026
  const setValue = await evaluate(`(async () => {
    const input = document.querySelector('#mcs-value-input');
    input.value = '2026';
    const save = [...document.querySelectorAll('[data-part="node-editor"] .mcs-btn')]
      .find(b => b.textContent.trim() === '保存');
    save.click();
    await new Promise(r => setTimeout(r, 250));
    return { value: document.querySelector('#mcs-value-input')?.value ?? null };
  })()`);
  assert(setValue.value === '2026', `改值成功（${setValue.value}）`);

  // ---------------------------------------------------------------- 5
  console.log('\n[5] SNBT 文本模式：生成、检查内容、改一个值并应用');
  const snbtResult = await evaluate(`(async () => {
    document.querySelector('[data-mode="snbt"]').click();
    await new Promise(r => setTimeout(r, 200));

    // 文本落后于树，先点「从树重新生成」
    const regen = [...document.querySelectorAll('.mcs-btn')].find(b => b.textContent.includes('从树重新生成'));
    regen.click();
    await new Promise(r => setTimeout(r, 400));

    const area = document.querySelector('[data-part="snbt"]');
    const text = area.value;
    return {
      visible: !document.querySelector('[data-pane="snbt"]').hidden,
      length: text.length,
      hasRootField: text.includes('format_version'),
      hasOrigin: text.includes('72') && text.includes('59'),
      hasAddedField: text.includes('EditorTest:2026'),
      hasTypedSuffix: /1L|\\d+b/.test(text),
      state: document.querySelector('[data-part="snbt-state"]')?.textContent ?? '',
    };
  })()`);
  assert(snbtResult.visible, 'SNBT 面板已显示');
  assert(snbtResult.length > 100, `SNBT 文本已生成（${snbtResult.length} 字符）`);
  assert(snbtResult.hasRootField, '文本含 format_version');
  assert(snbtResult.hasOrigin, '文本含结构原点 72 / 59');
  assert(snbtResult.hasAddedField, '文本含刚在树里新增的 EditorTest:2026');
  assert(snbtResult.hasTypedSuffix, '文本里带类型后缀（如 1L / 72b）');
  assert(snbtResult.state.includes('同步'), `状态显示与树同步（${snbtResult.state}）`);

  // 用 SNBT 直接改：把 EditorTest 改成 9999，并再加一个字符串字段
  const applied = await evaluate(`(async () => {
    const area = document.querySelector('[data-part="snbt"]');
    area.value = area.value
      .replace('EditorTest:2026', 'EditorTest:9999, SnbtAdded:"来自 SNBT"');
    area.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 100));
    const staleState = document.querySelector('[data-part="snbt-state"]')?.textContent ?? '';

    const apply = [...document.querySelectorAll('.mcs-btn')].find(b => b.textContent.trim() === '应用改动');
    apply.click();
    await new Promise(r => setTimeout(r, 500));

    return {
      staleState,
      errorHidden: document.querySelector('[data-part="snbt-error"]')?.hidden ?? true,
      errorText: (document.querySelector('[data-part="snbt-error"]')?.textContent ?? '').slice(0, 160),
      dirty: !document.querySelector('[data-part="dirty"]')?.hidden,
    };
  })()`);
  assert(applied.staleState.includes('未应用'), `编辑后提示有未应用的改动（${applied.staleState}）`);
  assert(applied.errorHidden, `应用 SNBT 没有报错${applied.errorHidden ? '' : `：${applied.errorText}`}`);
  assert(applied.dirty, '应用后仍是「已修改」状态');

  // 回到树视图确认 SNBT 的改动真的进了树
  const backToTree = await evaluate(`(async () => {
    document.querySelector('[data-mode="tree"]').click();
    await new Promise(r => setTimeout(r, 200));
    const names = [...document.querySelectorAll('.mcs-node-name')].map(e => e.textContent);
    const previews = [...document.querySelectorAll('.mcs-node')]
      .filter(n => ['EditorTest', 'SnbtAdded'].includes(n.querySelector('.mcs-node-name')?.textContent ?? ''))
      .map(n => n.querySelector('.mcs-node-name').textContent + '=' + (n.querySelector('.mcs-node-preview')?.textContent ?? ''));
    return { names, previews };
  })()`);
  assert(backToTree.names.includes('EditorTest'), 'EditorTest 仍在树里');
  assert(backToTree.names.includes('SnbtAdded'), 'SNBT 新增的 SnbtAdded 已进入树');
  assert(
    backToTree.previews.some((p) => p === 'EditorTest=9999'),
    `EditorTest 的值已按 SNBT 改成 9999（${backToTree.previews.join(', ')}）`,
  );

  // ---------------------------------------------------------------- 6
  console.log('\n[6] SNBT 语法错误应给出可定位的提示');
  const badSnbt = await evaluate(`(async () => {
    document.querySelector('[data-mode="snbt"]').click();
    await new Promise(r => setTimeout(r, 200));
    const area = document.querySelector('[data-part="snbt"]');
    area.value = '{\\n  a: 1,\\n  b: ,\\n}';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    const apply = [...document.querySelectorAll('.mcs-btn')].find(b => b.textContent.trim() === '应用改动');
    apply.click();
    await new Promise(r => setTimeout(r, 400));
    const err = document.querySelector('[data-part="snbt-error"]');
    return { hidden: err.hidden, text: (err.textContent ?? '').replace(/\\s+/g,' ') };
  })()`);
  assert(!badSnbt.hidden, '错误提示已显示');
  assert(/第 3 行/.test(badSnbt.text), `错误定位到第 3 行（${badSnbt.text.slice(0, 90)}）`);

  // 恢复成合法内容再继续
  await evaluate(`(async () => {
    const regen = [...document.querySelectorAll('.mcs-btn')].find(b => b.textContent.includes('从树重新生成'));
    regen.click();
    await new Promise(r => setTimeout(r, 300));
    return true;
  })()`);

  // ---------------------------------------------------------------- 7
  console.log('\n[7] 下载并离线复解析');
  await evaluate(`document.querySelector('[data-act="download"]').click()`);
  await sleep(2500);
  const downloaded = readdirSync(DOWNLOADS).filter((f) => f.endsWith('.mcstructure'));
  assert(downloaded.length > 0, `下载目录出现 .mcstructure（${downloaded.join(', ')}）`);
  const bytes = new Uint8Array(readFileSync(join(DOWNLOADS, downloaded[0])));
  assert(bytes.length > 0, `下载文件非空（${bytes.length} 字节）`);

  const { parseStructure } = await import('../../src/tools/mcstructure-editor/structure.ts');
  const { toPlain: plain } = await import('../../src/tools/mcstructure-editor/nbt.ts');
  const state = await parseStructure(bytes);
  assert(
    `${state.size.x}×${state.size.y}×${state.size.z}` === EXPECT_SIZE_TEXT,
    `尺寸仍为 ${EXPECT_SIZE_TEXT}`,
  );
  assert(state.worldOrigin?.join(',') === '72,59,-10', '保留结构原点');
  assert(plain(state.root.get('EditorTest')) === 9999, '下载文件里带着树/SNBT 改过的 EditorTest=9999');
  assert(plain(state.root.get('SnbtAdded')) === '来自 SNBT', '下载文件里带着 SNBT 新增的字段');
  assert(state.positionData.size >= 1, '方块实体未被丢字段');

  // ---------------------------------------------------------------- 8
  console.log('\n[8] 页面无未捕获异常');
  assert(errors.length === 0, errors.length ? `有异常：${errors[0].slice(0, 240)}` : '没有未捕获异常');

  console.log(failures === 0 ? '\n全部通过。' : `\n有 ${failures} 项失败。`);
  if (failures === 0) {
    console.log(JSON.stringify({ downloaded: downloaded[0], bytes: bytes.length }, null, 2));
  }
  return failures;
}

main().then(
  (failed) => process.exit(failed === 0 ? 0 : 1),
  (error) => {
    console.error('\n脚本失败：', error.message);
    process.exit(1);
  },
);
