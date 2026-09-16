// 抓一张有代表性的界面截图：搜索 main → 选中 → 伪代码/反汇编/引用
const BASE = process.argv[2] ?? 'http://localhost:8011';
const SHOTS = process.argv[3] ?? '.';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = await import('node:fs');

const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => (ws.onopen = res));
let id = 0;
const pending = new Map();
const errors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) =>
  new Promise((resolve) => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { ERR: r.result.exceptionDetails.exception?.description };
  return r.result?.result?.value;
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(r.result.data, 'base64'));
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/ida/` });

// 登场等就绪
for (let i = 0; i < 40; i += 1) {
  await sleep(500);
  const rows = await ev(`document.querySelectorAll('.ida-row').length`);
  if (rows > 0) break;
}
// 搜索 main（MCP 的 glob 语义较宽，用精确名再挑一次）
await ev(`(() => { const i = document.querySelector('.ida-search input'); i.value = 'main'; document.querySelector('.ida-search button').click(); return true; })()`);
await sleep(4000);

const out = {};
out.searchRows = await ev(`document.querySelectorAll('.ida-row').length`);
// 点名字正好是 main 的那一行
out.clicked = await ev(`(() => {
  const row = [...document.querySelectorAll('.ida-row')].find(r => r.innerText.trim().split(/\\s+/)[1] === 'main');
  if (!row) return '没找到名为 main 的行';
  row.click();
  return 'clicked';
})()`);
await sleep(5000);

out.selected = await ev(`({ name: document.querySelector('.ida-fnname')?.textContent, at: document.querySelector('.ida-fnat')?.textContent })`);
out.pseudoLines = await ev(`document.querySelectorAll('.ida-cl').length`);
out.clickableAddrs = await ev(`document.querySelectorAll('.ida-addr').length`);
out.tokens = await ev(`({ k: document.querySelectorAll('.tok-k').length, s: document.querySelectorAll('.tok-s').length, n: document.querySelectorAll('.tok-n').length, c: document.querySelectorAll('.tok-c').length, fn: document.querySelectorAll('.tok-fn').length })`);
await shot('10-pseudo-main');

await ev(`document.querySelector('[data-tab="disasm"]').click()`);
await sleep(4000);
out.asmLines = await ev(`document.querySelectorAll('.ida-cl').length`);
out.asmTokens = await ev(`({ m: document.querySelectorAll('.tok-m').length, r: document.querySelectorAll('.tok-r').length, n: document.querySelectorAll('.tok-n').length })`);
await shot('11-asm-main');

await ev(`document.querySelector('[data-tab="xrefs"]').click()`);
await sleep(4000);
out.xrefCols = await ev(`[...document.querySelectorAll('.ida-col h4')].map(n=>n.textContent)`);
await shot('12-xrefs-main');

await ev(`document.querySelector('[data-tab="vars"]').click()`);
await sleep(4000);
out.varRows = await ev(`document.querySelectorAll('.ida-table tbody tr').length`);
await shot('13-vars-main');

await ev(`document.querySelector('[data-tab="blocks"]').click()`);
await sleep(4000);
out.blockRows = await ev(`document.querySelectorAll('.ida-blk').length`);
await shot('14-blocks-main');

out.errors = errors;
console.log(JSON.stringify(out, null, 2));
ws.close();
