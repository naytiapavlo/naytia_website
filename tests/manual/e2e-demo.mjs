// 用 CDP 驱动 demo：报告默认选中内容、切选项卡、点地址跳转、键盘导航、搜索，
// 并截图保存（供用户查看界面）。
const DEBUG = 'http://127.0.0.1:9222';
const TARGET = process.argv[2];
const SHOT_DIR = process.argv[3] ?? '.';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch(`${DEBUG}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => (ws.onopen = res));
let id = 0;
const pending = new Map();
const errors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) =>
  new Promise((resolve) => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'eval error');
  return r.result?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: TARGET });

// 等界面真正就绪：函数列表出现行 + 主视图不再是"读取中…"。
// 离线快照几乎瞬间完成；连真实 IDA 时要用几秒（17 万函数的列表 + 一次反编译）。
let ready = false;
for (let i = 0; i < 40; i += 1) {
  await sleep(500);
  const state = await evaluate(`({
    rows: document.querySelectorAll('.row').length,
    loading: (document.getElementById('view')?.innerText || '').includes('读取中'),
    fn: document.getElementById('fnName')?.textContent || '',
  })`);
  if (state.rows > 0 && !state.loading && state.fn && state.fn !== '（未选择函数）') { ready = true; break; }
}
if (!ready) console.error('警告：等待界面就绪超时，以下结果可能不完整');

const out = {};
out.defaultSelection = await evaluate(`({ name: document.getElementById('fnName').textContent, addr: document.getElementById('fnAt').textContent })`);
out.pseudoLines = await evaluate(`document.querySelectorAll('.cl').length`);
out.clickableAddrs = await evaluate(`document.querySelectorAll('.addr').length`);
out.listRows = await evaluate(`document.querySelectorAll('.row').length`);

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const fs = await import('node:fs');
  fs.writeFileSync(`${SHOT_DIR}/${name}.png`, Buffer.from(r.result.data, 'base64'));
}

await shot('01-pseudocode');

// 切到反汇编
await evaluate(`document.querySelector('[data-tab="asm"]').click()`);
await sleep(600);
out.asmLines = await evaluate(`document.querySelectorAll('.cl').length`);
out.asmFirst = await evaluate(`document.querySelector('.cl')?.innerText?.replace(/\\s+/g,' ')`);
await shot('02-disassembly');

// 切到交叉引用
await evaluate(`document.querySelector('[data-tab="xrefs"]').click()`);
await sleep(600);
out.xrefCols = await evaluate(`[...document.querySelectorAll('.col h4')].map(n => n.textContent)`);
await shot('03-xrefs');

// 栈变量
await evaluate(`document.querySelector('[data-tab="vars"]').click()`);
await sleep(600);
out.varRows = await evaluate(`document.querySelectorAll('.tbl tbody tr').length`);
await shot('04-stackvars');

// 基本块
await evaluate(`document.querySelector('[data-tab="blocks"]').click()`);
await sleep(600);
out.blockRows = await evaluate(`document.querySelectorAll('.blk').length`);
await shot('05-blocks');

// 回伪代码，点一个行内地址跳转
await evaluate(`document.querySelector('[data-tab="pseudo"]').click()`);
await sleep(500);
out.beforeJump = await evaluate(`document.getElementById('fnAt').textContent`);
await evaluate(`document.querySelectorAll('.addr')[0]?.click()`);
await sleep(900);
out.afterJump = await evaluate(`({ name: document.getElementById('fnName').textContent, addr: document.getElementById('fnAt').textContent })`);

// 跳回 main（验证 G 键路径用的 jumpTo）
await evaluate(`window.jumpTo ? null : null`);
await evaluate(`document.querySelectorAll('.row')[0].click()`);
await sleep(700);
// 键盘：下移到 main
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
await sleep(900);
out.afterArrowDown = await evaluate(`document.getElementById('fnName').textContent`);

// 搜索
await evaluate(`(() => { const i = document.getElementById('funcSearch'); i.value = 'DedicatedServer'; document.getElementById('btnSearch').click(); return true; })()`);
await sleep(700);
out.searchRows = await evaluate(`document.querySelectorAll('.row').length`);
out.searchFirst = await evaluate(`document.querySelector('.row')?.innerText?.replace(/\\s+/g,' ')`);
await shot('06-search');

// 字符串侧栏
await evaluate(`document.querySelector('[data-side="strings"]').click()`);
await sleep(600);
out.stringRows = await evaluate(`document.querySelectorAll('.row').length`);
await shot('07-strings');

// 段侧栏
await evaluate(`document.querySelector('[data-side="segments"]').click()`);
await sleep(500);
out.segmentRows = await evaluate(`document.querySelectorAll('.row').length`);
await shot('08-segments');

// 帮助浮层
await evaluate(`document.getElementById('btnHelp').click()`);
await sleep(400);
out.helpVisible = await evaluate(`document.getElementById('help').classList.contains('show')`);
await shot('09-help');

out.errors = errors;
console.log(JSON.stringify(out, null, 2));
ws.close();
