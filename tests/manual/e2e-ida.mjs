// 逆向工作台（/ida/）端到端验证：驱动合并后的仿 IDA 界面。
// 需要：后端含 /api/reverse 在跑、同源静态服务（tests/manual/serve-dist.mjs）、
//       无头 Edge 带 --remote-debugging-port=9222。
// 用法：node tests/manual/e2e-ida.mjs http://localhost:8011 [截图目录]
const BASE = process.argv[2] ?? 'http://localhost:8011';
const SHOTS = process.argv[3] ?? '';
const DEBUG_URL = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch(`${DEBUG_URL}/json/list`)).json();
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
const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.exception?.description };
  return r.result?.result?.value;
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/ida/` });

async function shot(name) {
  if (!SHOTS) return;
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const fs = await import('node:fs');
  fs.writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(r.result.data, 'base64'));
}

// 等就绪：函数行出现且主视图不是"读取中…"
let ready = false;
for (let i = 0; i < 50; i += 1) {
  await sleep(500);
  const s = await evaluate(`({
    rows: document.querySelectorAll('.ida-row').length,
    loading: (document.getElementById('view')?.innerText || document.querySelector('.ida-view')?.innerText || '').includes('读取中'),
    fn: document.querySelector('.ida-fnname')?.textContent || '',
  })`);
  if (s.rows > 0 && !s.loading && s.fn && s.fn !== '（未选择函数）') { ready = true; break; }
}
if (!ready) console.error('警告：等待就绪超时');

const out = {};
out.headlessWaitOk = ready;
out.chipMode = await evaluate(`[...document.querySelectorAll('.ida-chip')].map(n => n.textContent)`);
out.titleIdb = await evaluate(`document.querySelector('.ida-appsub')?.textContent`);
out.metaRows = await evaluate(`[...document.querySelectorAll('.ida-meta-row')].map(n => n.textContent.replace(/\\s+/g,' '))`);
out.functionRows = await evaluate(`document.querySelectorAll('.ida-row').length`);
out.selected = await evaluate(`({ name: document.querySelector('.ida-fnname')?.textContent, at: document.querySelector('.ida-fnat')?.textContent })`);
out.statusBar = await evaluate(`document.querySelector('.ida-status')?.innerText?.replace(/\\s+/g,' ')`);
out.pseudocodeLines = await evaluate(`document.querySelectorAll('.ida-cl').length`);
out.clickableAddrs = await evaluate(`document.querySelectorAll('.ida-addr').length`);
out.tabCounts = await evaluate(`[...document.querySelectorAll('.ida-tab')].map(n => n.textContent.trim())`);
await shot('01-pseudocode');

// 反汇编
await evaluate(`document.querySelector('[data-tab="disasm"]').click()`);
await sleep(2500);
out.asmLines = await evaluate(`document.querySelectorAll('.ida-cl').length`);
out.asmFirst = await evaluate(`document.querySelector('.ida-cl')?.innerText?.replace(/\\s+/g,' ')`);
await shot('02-disasm');

// 交叉引用
await evaluate(`document.querySelector('[data-tab="xrefs"]').click()`);
await sleep(2500);
out.xrefCols = await evaluate(`[...document.querySelectorAll('.ida-col h4')].map(n => n.textContent)`);
await shot('03-xrefs');

// 栈变量
await evaluate(`document.querySelector('[data-tab="vars"]').click()`);
await sleep(2500);
out.varRows = await evaluate(`document.querySelectorAll('.ida-table tbody tr').length`);
await shot('04-vars');

// 基本块
await evaluate(`document.querySelector('[data-tab="blocks"]').click()`);
await sleep(2500);
out.blockRows = await evaluate(`document.querySelectorAll('.ida-blk').length`);
await shot('05-blocks');

// 切页签后不能靠固定 sleep：函数页的加载是异步的，加载完成会晚于切换。
// 这里等到「列表头」真的变成目标页签的描述再读，避免读到上一次的残留。
async function waitForPane(pattern, label) {
  for (let i = 0; i < 30; i += 1) {
    await sleep(400);
    const head = await evaluate(`document.querySelector('.ida-listhead')?.innerText || ''`);
    if (typeof head === 'string' && head.includes(pattern)) return true;
  }
  console.error(`警告：等待页签「${label}」超时`);
  return false;
}

// 字符串侧栏
await evaluate(`document.querySelector('[data-side="strings"]').click()`);
await waitForPane('字符串', '字符串');
out.stringRows = await evaluate(`document.querySelectorAll('.ida-row').length`);
out.stringFirst = await evaluate(`document.querySelector('.ida-row')?.innerText?.replace(/\\s+/g,' ')`);
await shot('06-strings');

// 段侧栏
await evaluate(`document.querySelector('[data-side="segments"]').click()`);
await waitForPane('段', '段');
out.segmentRows = await evaluate(`document.querySelectorAll('.ida-row').length`);
out.segmentFirst = await evaluate(`document.querySelector('.ida-row')?.innerText?.replace(/\\s+/g,' ')`);
await shot('07-segments');

// 回到函数
await evaluate(`document.querySelector('[data-side="funcs"]').click()`);
await waitForPane('名称', '函数');
await sleep(800);
const before = await evaluate(`document.querySelector('.ida-fnat')?.textContent`);
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
await sleep(2500);
out.afterArrowDown = await evaluate(`({ at: document.querySelector('.ida-fnat')?.textContent, changed: document.querySelector('.ida-fnat')?.textContent !== ${JSON.stringify(before)} })`);

await evaluate(`document.querySelector('[data-tab="pseudocode"]').click()`);
await sleep(3000);
out.addrBefore = await evaluate(`document.querySelector('.ida-fnat')?.textContent`);
await evaluate(`document.querySelectorAll('.ida-addr')[0]?.click()`);
await sleep(2500);
out.addrAfterJump = await evaluate(`({ at: document.querySelector('.ida-fnat')?.textContent, name: document.querySelector('.ida-fnname')?.textContent?.slice(0,50) })`);

// 搜索
await evaluate(`(() => { const i = document.querySelector('.ida-search input'); i.value = 'DedicatedServer'; document.querySelector('.ida-search button').click(); return true; })()`);
await sleep(3000);
out.searchRows = await evaluate(`document.querySelectorAll('.ida-row').length`);
out.searchFirst = await evaluate(`document.querySelector('.ida-row')?.innerText?.replace(/\\s+/g,' ')`);
await shot('08-search');

// 权限门控：访客应看不到重命名按钮与实例选择器
out.renameHidden = await evaluate(`document.querySelector('.ida-toolbar button:nth-of-type(5)')?.hidden ?? '(无法定位)'`);
out.renameButtonState = await evaluate(`(() => { const b = [...document.querySelectorAll('.ida-btn')].find(x => x.textContent === '重命名'); return b ? { hidden: b.hidden, disabled: b.disabled } : '(无)'; })()`);
out.instanceSelector = await evaluate(`(() => { const s = document.querySelector('select.ida-field'); return s ? { hidden: s.hidden, options: s.options.length } : '(无)'; })()`);
out.permissions = await evaluate(`fetch('/api/reverse/permissions').then(r => r.json())`);
out.helpOpens = await evaluate(`(() => { document.querySelector('.ida-help')?.classList.add('show'); return document.querySelector('.ida-help')?.classList.contains('show'); })()`);
await shot('09-help');

out.pageErrors = errors;
console.log(JSON.stringify(out, null, 2));
ws.close();
