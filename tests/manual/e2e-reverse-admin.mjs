// 验证「admin 可见 / 可写」这一半：注册首个账号（bootstrap 成 superadmin）后，
// 实例选择器与重命名按钮应当出现，且重命名真的能改掉 IDA 里的函数名。
// 注意：这会真实修改 IDB 中的函数名，因此改的是一个测试用的动态初始化函数，
// 并在改完后恢复原名。
const BASE = process.argv[2] ?? 'http://localhost:8002';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
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

const report = {};
const user = `revadmin${Date.now().toString().slice(-5)}`;

// 打开工作台，先注册（同源 → Cookie 生效）
await send('Page.navigate', { url: `${BASE}/ida/` });
await sleep(5000);
report.register = await evaluate(`fetch('/api/auth/register', {
  method: 'POST', credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: '${user}', password: 'secret123' })
}).then(async r => ({ status: r.status, body: (await r.text()).slice(0, 160) }))`);

// 重新加载，让权限按新会话重算
await send('Page.navigate', { url: `${BASE}/ida/` });
await sleep(6500);

report.permissions = await evaluate(`fetch('/api/reverse/permissions', { credentials: 'include' }).then(r => r.json())`);
report.instanceSelectorVisible = await evaluate(`(() => { const s = document.querySelector('.rv-instance'); return s ? { hidden: s.hidden, options: [...s.options].map(o => o.textContent) } : '(无)'; })()`);
report.renameBtnVisible = await evaluate(`(() => { const b = document.querySelector('.rv-fnbar button'); return b ? { hidden: b.hidden, text: b.innerText } : '(无)'; })()`);

// 选一个函数，然后通过后端直接改一次名（绕开 prompt，便于自动化），再改回来
const target = '0x7ff6870d1010';
const original = await evaluate(`fetch('/api/reverse/functions/lookup?port=13337&q=${target}', { credentials: 'include' }).then(r => r.json())`);
report.lookupBefore = original;

report.rename = await evaluate(`fetch('/api/reverse/functions/rename?port=13337&addr=${target}', {
  method: 'POST', credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'naytia_renamed_test' })
}).then(async r => ({ status: r.status, body: (await r.text()).slice(0, 200) }))`);

report.lookupAfterRename = await evaluate(`fetch('/api/reverse/functions/lookup?port=13337&q=${target}', { credentials: 'include' }).then(r => r.json())`);

// 恢复原名
report.restore = await evaluate(`fetch('/api/reverse/functions/rename?port=13337&addr=${target}', {
  method: 'POST', credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: '${original?.[0]?.name ?? '_dynamic_initializer_for__Direction::FROM_STRING_MAP__'}' })
}).then(async r => ({ status: r.status }))`);
report.lookupRestored = await evaluate(`fetch('/api/reverse/functions/lookup?port=13337&q=${target}', { credentials: 'include' }).then(r => r.json())`);

console.log(JSON.stringify(report, null, 2));
ws.close();
