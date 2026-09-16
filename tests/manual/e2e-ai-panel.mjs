// AI 助手悬浮窗端到端验证（配合 tests/manual/mock-deepseek.mjs，不花真实额度）。
// 覆盖：窗口开合、提问、工具调用展示、配额递减、第 4 轮被拦。
const BASE = process.argv[2] ?? 'http://localhost:8011';
const SHOTS = process.argv[3] ?? '';
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
  if (!SHOTS) return;
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(r.result.data, 'base64'));
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/ida/` });
for (let i = 0; i < 50; i += 1) {
  await sleep(500);
  if ((await ev(`document.querySelectorAll('.ida-row').length`)) > 0) break;
}

const out = {};
// 1) 悬浮球与窗口存在、默认收起
out.bubbleExists = await ev(`!!document.querySelector('.ai-bubble')`);
out.panelExists = await ev(`!!document.querySelector('.ai-panel')`);
out.panelOpenInitially = await ev(`document.querySelector('.ai-panel')?.classList.contains('is-open')`);
out.quotaChip = await ev(`document.querySelector('.ai-chip')?.textContent`);
out.hint = await ev(`document.querySelector('.ai-hint')?.textContent`);
await shot('40-ai-collapsed');

// 2) 展开
await ev(`document.querySelector('.ai-bubble').click()`);
await sleep(600);
out.panelOpenAfterClick = await ev(`document.querySelector('.ai-panel')?.classList.contains('is-open')`);
out.bubbleHiddenWhenOpen = await ev(`document.querySelector('.ai-bubble')?.hidden`);
out.emptyText = await ev(`document.querySelector('.ai-empty')?.textContent`);
await shot('41-ai-open');

// 3) 选中 main，让上下文带上函数名
await ev(`(() => { const i=document.querySelector('.ida-search input'); i.value='main'; document.querySelector('.ida-search button').click(); return true; })()`);
await sleep(4000);
await ev(`(() => { const r=[...document.querySelectorAll('.ida-row')].find(x=>x.innerText.trim().split(/\\s+/)[1]==='main'); if(r) r.click(); return !!r; })()`);
await sleep(5000);
out.selectedFn = await ev(`document.querySelector('.ida-fnname')?.textContent`);

// 4) 提问（会触发 mock 的 tool_call → 第二轮回答）
const beforeQuota = await ev(`document.querySelector('.ai-chip')?.textContent`);
await ev(`(() => {
  const t = document.querySelector('.ai-input');
  t.value = '这个函数在做什么？';
  document.querySelector('.ai-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  return true;
})()`);
// 等回答出现
for (let i = 0; i < 40; i += 1) {
  await sleep(500);
  const txt = await ev(`document.querySelector('.ai-log')?.innerText || ''`);
  if (typeof txt === 'string' && txt.includes('DedicatedServer::run')) break;
}
out.quotaBeforeChat = beforeQuota;
out.quotaAfterChat = await ev(`document.querySelector('.ai-chip')?.textContent`);
out.hintAfterChat = await ev(`document.querySelector('.ai-hint')?.textContent`);
out.toolNodes = await ev(`[...document.querySelectorAll('.ai-tool')].map(n=>n.textContent)`);
out.logText = await ev(`document.querySelector('.ai-log')?.innerText?.replace(/\\s+/g,' ')?.slice(0,300)`);
out.hasJumpAddr = await ev(`document.querySelectorAll('.ai-addr').length`);
await shot('42-ai-answer');

// 5) 历史写入 localStorage
out.storedHistory = await ev(`(() => { const raw = localStorage.getItem('naytia:ida:ai:history'); if (!raw) return null; const h = JSON.parse(raw); return h.map(m => m.role); })()`);

// 6) 把剩余额度用光，验证第 4 轮被拦
for (let round = 0; round < 2; round += 1) {
  await ev(`(() => {
    const t = document.querySelector('.ai-input');
    t.value = '再问一次 ${round}';
    document.querySelector('.ai-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return true;
  })()`);
  await sleep(3500);
}
out.quotaExhausted = await ev(`document.querySelector('.ai-chip')?.textContent`);
await ev(`(() => {
  const t = document.querySelector('.ai-input');
  t.value = '第四次提问';
  document.querySelector('.ai-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  return true;
})()`);
await sleep(4000);
out.quotaAfterFourth = await ev(`document.querySelector('.ai-chip')?.textContent`);
out.fourthHint = await ev(`document.querySelector('.ai-hint')?.textContent`);
out.sendDisabled = await ev(`document.querySelector('.ai-send')?.disabled`);
out.inputDisabled = await ev(`document.querySelector('.ai-input')?.disabled`);
await shot('43-ai-quota-out');

out.pageErrors = errors;
console.log(JSON.stringify(out, null, 1));
ws.close();
