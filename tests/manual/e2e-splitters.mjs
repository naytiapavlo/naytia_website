// 验证分隔条：用真实 PointerEvent 拖动，检查面板尺寸变化 + localStorage 持久化 + 双击复位。
const BASE = process.argv[2] ?? 'http://localhost:8011';
const SHOTS = process.argv[3] ?? '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const fs = await import('node:fs');
  fs.writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(r.result.data, 'base64'));
};

await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `${BASE}/ida/` });
for (let i = 0; i < 40; i += 1) {
  await sleep(500);
  if ((await ev(`document.querySelectorAll('.ida-row').length`)) > 0) break;
}

const out = {};
out.splitterCount = await ev(`document.querySelectorAll('.ida-splitter').length`);
out.splitterAria = await ev(`[...document.querySelectorAll('.ida-splitter')].map(s => ({ cls: s.className, role: s.getAttribute('role'), orient: s.getAttribute('aria-orientation'), tab: s.tabIndex }))`);
out.geometry = await ev(`(() => {
  const h = (sel) => { const n = document.querySelector(sel); return n ? Math.round(n.getBoundingClientRect().height) : null; };
  return { viewport: window.innerHeight, root: h('.ida-root'), workarea: h('.ida-workarea'), side: h('.ida-side'), list: h('.ida-list') };
})()`);
out.sideBefore = await ev(`Math.round(document.querySelector('.ida-side').getBoundingClientRect().width)`);
out.listBefore = await ev(`Math.round(document.querySelector('.ida-list').getBoundingClientRect().height)`);
await shot('20-before-drag');

// 用真实指针事件拖「侧栏」分隔条 +140px
out.dragSide = await ev(`(() => {
  const sp = document.querySelector('.ida-splitter.is-vertical');
  const r = sp.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + 60;
  const opts = (cx) => ({ bubbles: true, cancelable: true, clientX: cx, clientY: y, button: 0, buttons: 1, pointerId: 1, isPrimary: true, pointerType: 'mouse' });
  sp.dispatchEvent(new PointerEvent('pointerdown', opts(x)));
  document.dispatchEvent(new PointerEvent('pointermove', opts(x + 70)));
  document.dispatchEvent(new PointerEvent('pointermove', opts(x + 140)));
  document.dispatchEvent(new PointerEvent('pointerup', opts(x + 140)));
  return 'dragged';
})()`);
await sleep(400);
out.sideAfter = await ev(`Math.round(document.querySelector('.ida-side').getBoundingClientRect().width)`);
out.sideDelta = out.sideAfter - out.sideBefore;
out.sideInlineStyle = await ev(`document.querySelector('.ida-side').style.flex`);
out.storedSide = await ev(`localStorage.getItem('naytia:ida:side-width')`);
out.resizingClassCleared = await ev(`!document.querySelector('.ida-root').className.includes('is-resizing')`);
await shot('21-after-side-drag');

// 拖「列表↔底部」分隔条 -120px（把列表压矮）
out.dragList = await ev(`(() => {
  const sp = document.querySelector('.ida-splitter.is-horizontal');
  const r = sp.getBoundingClientRect();
  const x = r.left + 100, y = r.top + r.height / 2;
  const opts = (cy) => ({ bubbles: true, cancelable: true, clientX: x, clientY: cy, button: 0, buttons: 1, pointerId: 1, isPrimary: true, pointerType: 'mouse' });
  sp.dispatchEvent(new PointerEvent('pointerdown', opts(y)));
  document.dispatchEvent(new PointerEvent('pointermove', opts(y - 60)));
  document.dispatchEvent(new PointerEvent('pointermove', opts(y - 120)));
  document.dispatchEvent(new PointerEvent('pointerup', opts(y - 120)));
  return 'dragged';
})()`);
await sleep(400);
out.listAfter = await ev(`Math.round(document.querySelector('.ida-list').getBoundingClientRect().height)`);
out.listDelta = out.listAfter - out.listBefore;
out.storedList = await ev(`localStorage.getItem('naytia:ida:list-height')`);
await shot('22-after-list-drag');

// 双击复位
await ev(`document.querySelector('.ida-splitter.is-vertical').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
await ev(`document.querySelector('.ida-splitter.is-horizontal').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
await sleep(400);
out.afterResetSide = await ev(`Math.round(document.querySelector('.ida-side').getBoundingClientRect().width)`);
out.afterResetList = await ev(`Math.round(document.querySelector('.ida-list').getBoundingClientRect().height)`);
out.storedAfterReset = await ev(`[localStorage.getItem('naytia:ida:side-width'), localStorage.getItem('naytia:ida:list-height')]`);

// 键盘调整 + Home 复位
await ev(`(() => { const sp = document.querySelector('.ida-splitter.is-vertical'); sp.focus(); sp.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); return true; })()`);
await sleep(300);
out.afterArrowRight = await ev(`Math.round(document.querySelector('.ida-side').getBoundingClientRect().width)`);
await ev(`document.querySelector('.ida-splitter.is-vertical').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))`);
await sleep(300);
out.afterHome = await ev(`Math.round(document.querySelector('.ida-side').getBoundingClientRect().width)`);

// 刷新后是否记住：先拖一次，再重载
await ev(`(() => {
  const sp = document.querySelector('.ida-splitter.is-vertical');
  const r = sp.getBoundingClientRect(); const x = r.left + 2, y = r.top + 60;
  const o = (cx) => ({ bubbles: true, cancelable: true, clientX: cx, clientY: y, button: 0, buttons: 1, pointerId: 2, isPrimary: true });
  sp.dispatchEvent(new PointerEvent('pointerdown', o(x)));
  document.dispatchEvent(new PointerEvent('pointermove', o(x + 90)));
  document.dispatchEvent(new PointerEvent('pointerup', o(x + 90)));
  return true;
})()`);
await sleep(400);
out.beforeReload = await ev(`Math.round(document.querySelector('.ida-side').getBoundingClientRect().width)`);
await send('Page.navigate', { url: `${BASE}/ida/?reload=${Date.now()}` });
for (let i = 0; i < 40; i += 1) {
  await sleep(500);
  if ((await ev(`document.querySelectorAll('.ida-row').length`)) > 0) break;
}
out.afterReload = await ev(`Math.round(document.querySelector('.ida-side').getBoundingClientRect().width)`);
out.sizePersisted = Math.abs(out.afterReload - out.beforeReload) <= 2;
await shot('23-after-reload');

// 收尾：清掉持久化，避免影响后续
await ev(`localStorage.removeItem('naytia:ida:side-width'); localStorage.removeItem('naytia:ida:list-height'); true`);

out.errors = errors;
console.log(JSON.stringify(out, null, 2));
ws.close();
