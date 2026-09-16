// 删除两个工具之后的验证：工具箱目录只剩一个「站内工具」，且该工具仍可用。
//
// 说明：工具箱目录 = 站内工具（manifests，有 /tools/<slug>/）+ 外部入口（如 /ida/）。
// 所以这里要区分「工具数」与「入口数」——只有前者才应该因为这次删除而变化。
//
// 用法：node tests/manual/e2e-tools-catalog.mjs [base] [debugPort]
const BASE = process.argv[2] ?? 'http://localhost:4399';
const DEBUG_PORT = process.argv[3] ?? '9223';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`  [OK] ${message}`);
  else {
    failures += 1;
    console.log(`  [FAIL] ${message}`);
  }
}

const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error('WebSocket 连接失败'));
});
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
  return r.result?.result?.value;
};
await send('Page.enable');
await send('Runtime.enable');

console.log('\n[1] 工具箱目录');
await send('Page.navigate', { url: `${BASE}/tools/` });
await sleep(2200);
const catalog = await evaluate(`(() => {
  const cards = [...document.querySelectorAll('.tool-link')];
  return {
    all: cards.map(c => ({
      title: c.querySelector('h2')?.textContent ?? '',
      href: c.getAttribute('href'),
    })),
    // 站内工具 = 链到 /tools/<slug>/ 的卡片
    toolCards: cards.filter(c => (c.getAttribute('href') ?? '').startsWith('/tools/'))
      .map(c => ({ title: c.querySelector('h2')?.textContent ?? '', href: c.getAttribute('href') })),
    note: (document.querySelector('.page-note')?.innerText ?? '').replace(/\\s+/g,' '),
    bodyHasOldTools: document.body.innerText.includes('区块坐标')
      || document.body.innerText.includes('材料清单'),
  };
})()`);

assert(catalog.toolCards.length === 1, `站内工具只有 1 个（实际 ${catalog.toolCards.length}）`);
assert(
  catalog.toolCards[0]?.href === '/tools/mcstructure-editor/',
  `工具卡片链到 /tools/mcstructure-editor/（${catalog.toolCards[0]?.href}）`,
);
assert(
  catalog.toolCards[0]?.title.includes('.mcstructure'),
  `工具标题是「.mcstructure 编辑器」（${catalog.toolCards[0]?.title}）`,
);
assert(!catalog.bodyHasOldTools, '目录页没有残留「区块坐标 / 材料清单」字样');
// 目录里还有外部入口（逆向工作台），这是设计如此，不该被这次删除影响
const external = catalog.all.filter((c) => !(c.href ?? '').startsWith('/tools/'));
assert(
  external.some((c) => c.href === '/ida/'),
  `外部入口仍在（${external.map((c) => `${c.title}→${c.href}`).join(', ') || '无'}）`,
);

console.log('\n[2] 旧工具详情页确实不存在了');
// 注意:测试用的静态服务器(serve-dist.mjs)对缺失文件只回 text/plain "not found",
// 不像真实托管平台那样回落到 dist/404.html。所以这里分两步验证:
//   (a) 旧路由在 HTTP 层确实是 404,而不是还能拿到页面;
//   (b) 404 页面本身能正常渲染(直接访问 /404.html)。
for (const slug of ['chunk-coordinates', 'material-counter']) {
  const res = await fetch(`${BASE}/tools/${slug}/`, { redirect: 'manual' });
  assert(res.status === 404, `/tools/${slug}/ 返回 404(实际 ${res.status})`);
}

await send('Page.navigate', { url: `${BASE}/404.html` });
await sleep(1400);
const notFound = await evaluate(`(() => ({
  is404: document.body.innerText.includes('这一格还没有方块'),
  hasHomeLink: !!document.querySelector('.not-found a[href="/"]'),
  hasNav: !!document.querySelector('nav.navigation'),
}))()`);
assert(notFound.is404, '404 页面渲染正确');
assert(notFound.hasHomeLink, '404 页面有返回首页入口');
assert(notFound.hasNav, '404 页面保留公共页壳(导航仍在)');

console.log('\n[3] 现有工具仍能正常加载');
await send('Page.navigate', { url: `${BASE}/tools/mcstructure-editor/` });
await sleep(2400);
const tool = await evaluate(`(() => ({
  heading: document.querySelector('.tool-top h1')?.textContent ?? '',
  status: document.querySelector('.tool-status')?.textContent ?? '',
  drop: !!document.querySelector('.mcs-drop'),
  favButton: document.querySelector('.tool-actions-bar button')?.innerText ?? '',
  modes: [...document.querySelectorAll('[data-mode]')].map(b => b.textContent.trim()),
}))()`);
assert(tool.heading.includes('.mcstructure'), `详情页标题正确（${tool.heading}）`);
assert(tool.status.includes('可用'), '状态为「可用」');
assert(tool.drop, '工具界面已挂载（懒加载的 chunk 仍在）');
assert(tool.modes.includes('NBT 树') && tool.modes.includes('SNBT 文本'), '两种编辑方式都在');
assert(tool.favButton.includes('登录'), `收藏入口仍在（未登录显示「${tool.favButton}」）`);

console.log(failures === 0 ? '\n全部通过。' : `\n有 ${failures} 项失败。`);
process.exit(failures === 0 ? 0 : 1);
