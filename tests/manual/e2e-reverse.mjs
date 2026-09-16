// 逆向工作台端到端验证：用无头 Edge 通过 CDP 真实操作 /ida/ 页面。
// 需要：后端在跑（含 /api/reverse）、同源静态服务（tests/manual/serve-dist.mjs）、
//       无头 Edge 带 --remote-debugging-port=9222。
// 用法：node tests/manual/e2e-reverse.mjs http://localhost:8002
const BASE = process.argv[2] ?? 'http://localhost:8002';
const DEBUG_URL = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch(`${DEBUG_URL}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => (ws.onopen = res));
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) =>
  new Promise((resolve) => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { __error: r.result.exceptionDetails.text };
  return r.result?.result?.value;
};
await send('Page.enable');
await send('Runtime.enable');
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.__errs = []; window.addEventListener('error', e => window.__errs.push(String(e.message)));
           window.addEventListener('unhandledrejection', e => window.__errs.push('rejection: ' + String(e.reason)));`,
});

const report = {};

// 1) 打开工作台并等待函数列表
await send('Page.navigate', { url: `${BASE}/ida/` });
await sleep(6000);

report.chip = await evaluate(`document.querySelector('.rv-chip')?.innerText ?? '(缺失)'`);
report.sidebarMeta = await evaluate(`document.querySelector('.rv-sidebar-meta')?.innerText?.replace(/\\s+/g,' ') ?? '(缺失)'`);
report.functionCount = await evaluate(`document.querySelectorAll('.rv-fn').length`);
report.firstFunctions = await evaluate(`[...document.querySelectorAll('.rv-fn')].slice(0,3).map(n => n.innerText.replace(/\\s+/g,' '))`);
report.statusBar = await evaluate(`document.querySelector('.rv-statusbar')?.innerText?.replace(/\\s+/g,' ') ?? '(缺失)'`);

// 2) 搜索一个真实函数并点开（后端列表是 offset 分页，直接搜名字更稳）
await evaluate(`(() => {
  const input = document.querySelector('.rv-search input');
  input.value = 'main';
  document.querySelector('.rv-search button').click();
  return true;
})()`);
await sleep(3500);
report.searchCount = await evaluate(`document.querySelectorAll('.rv-fn').length`);
report.searchFirst = await evaluate(`document.querySelector('.rv-fn')?.innerText?.replace(/\\s+/g,' ') ?? '(无)'`);

// 3) 点击第一个函数 → 伪代码
await evaluate(`document.querySelector('.rv-fn')?.click()`);
await sleep(4000);
report.fnBar = await evaluate(`document.querySelector('.rv-fnbar')?.innerText?.replace(/\\s+/g,' ') ?? '(缺失)'`);
report.pseudocodeHead = await evaluate(`document.querySelector('.rv-code')?.innerText?.slice(0, 260) ?? '(无伪代码)'`);
report.hasAddrJumps = await evaluate(`document.querySelectorAll('.rv-tok-addr').length`);
report.hasHighlight = await evaluate(`({
  keyword: document.querySelectorAll('.rv-tok-keyword').length,
  string: document.querySelectorAll('.rv-tok-string').length,
  number: document.querySelectorAll('.rv-tok-number').length,
  comment: document.querySelectorAll('.rv-tok-comment').length,
})`);

// 4) 切到反汇编
await evaluate(`[...document.querySelectorAll('.rv-tab')].find(b => b.innerText.includes('反汇编'))?.click()`);
await sleep(4000);
report.disasmFirstLines = await evaluate(`[...document.querySelectorAll('.rv-line')].slice(0,3).map(n => n.innerText.replace(/\\s+/g,' '))`);
report.disasmHead = await evaluate(`document.querySelector('.rv-disasm-head')?.innerText ?? '(无)'`);

// 5) 栈变量选项卡
await evaluate(`[...document.querySelectorAll('.rv-tab')].find(b => b.innerText.includes('栈变量'))?.click()`);
await sleep(3500);
report.stackRows = await evaluate(`document.querySelectorAll('.rv-table tbody tr').length`);
report.stackFirst = await evaluate(`[...document.querySelectorAll('.rv-table tbody tr')].slice(0,2).map(r => r.innerText.replace(/\\s+/g,' '))`);

// 6) 交叉引用选项卡
await evaluate(`[...document.querySelectorAll('.rv-tab')].find(b => b.innerText.includes('交叉引用'))?.click()`);
await sleep(3500);
report.xrefCols = await evaluate(`[...document.querySelectorAll('.rv-col-title')].map(n => n.innerText)`);

// 7) 访客不应看到重命名按钮 / 实例选择器
report.renameHidden = await evaluate(`document.querySelector('.rv-fnbar button')?.hidden ?? '(无按钮)'`);
report.instanceHidden = await evaluate(`document.querySelector('.rv-instance')?.hidden ?? '(无选择器)'`);

// 8) 页面错误
report.pageErrors = await evaluate(`window.__errs ?? []`);

console.log(JSON.stringify(report, null, 2));
ws.close();
