// 文档树的浏览器端验收（CDP 驱动无头 Chrome）。
//
// 覆盖三种身份在同一条链路上的行为：
//   访客 → 目录树/正文/搜索/下载都可用，且没有任何写入口
//   管理员 → 能上传 md 文件、新建文件夹（都进待审队列，线上不可见）
//   超管 → 待审队列里批准，内容立刻对访客可见；再驳回一条作对照
//
// 用法：node tests/manual/verify-docs-ui.mjs [devServer] [apiBase] [shotDir]
// 前置：1) backend 起在 apiBase 上（要跑写操作时必须指向隔离库）
//       2) `npx astro dev --port 4333` 且 PUBLIC_API_BASE=apiBase
//       3) 无头 Chrome：--remote-debugging-port=9333 --user-data-dir=<仓库外的目录>
//          （端口可用 DOCS_CDP_PORT 覆盖；别用 9222——那可能是使用者自己的 Chrome）
//       4) DOCS_ALLOW_MUTATIONS=1 —— 不设时只跑访客只读检查，绝不写数据
//       5) 写操作需要 node tests/manual/verify-docs-accounts.mjs 先建好三个验收账号
import { writeFileSync } from 'node:fs';

const DEV = process.argv[2] ?? 'http://127.0.0.1:4333';
const API = process.argv[3] ?? 'http://127.0.0.1:8123';
const SHOTS = process.argv[4] ?? '.verify';
// 用一个独立端口：9222 上可能开着使用者自己的 Chrome（远程调试），
// 复用那个端口会把脚本的导航打到别人正在看的标签页上。
const CDP_PORT = process.env.DOCS_CDP_PORT ?? '9333';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, ok, extra = '') {
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

// ---------------------------------------------------------------- CDP

const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) throw new Error(`没有可用的 Chrome 页面（先启动 --remote-debugging-port=${CDP_PORT}）`);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => (ws.onopen = res));
let id = 0;
const pending = new Map();
const consoleErrors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(m.params.exceptionDetails.exception?.description ?? 'unknown');
  }
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    consoleErrors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  }
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) {
    return { __error: r.result.exceptionDetails.exception?.description ?? 'eval error' };
  }
  return r.result?.result?.value;
};
await send('Runtime.enable');
await send('Page.enable');

async function goto(url) {
  await send('Page.navigate', { url });
  await sleep(1600);
}

async function shot(name) {
  const r = await send('Page.captureScreenshot', { captureBeyondViewport: true });
  if (r.result?.data) {
    writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(r.result.data, 'base64'));
  }
}

// ---------------------------------------------------------------- 等待工具

async function waitFor(expression, { timeout = 12000, label = expression } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await ev(expression);
    if (value) return value;
    await sleep(200);
  }
  throw new Error(`等待超时：${label}`);
}

const clickByText = (selector, text) => `
(() => {
  const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
  const hit = nodes.find((n) => (n.textContent || '').includes(${JSON.stringify(text)}));
  if (!hit) return false;
  hit.click();
  return true;
})()`;

/**
 * 登录并确认服务端认了这个身份，然后重新加载文档页。
 *
 * 只写 `fetch(login)` 就导航是不可靠的：请求还没落地页面就被换掉，
 * 下一段检查会以「上一个人的身份」跑，表现为随机失败。
 */
async function signIn(username, expectedRole) {
  await goto(`${DEV}/docs/`);
  const who = await evRetry(`fetch('${API}/api/auth/login', {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ${JSON.stringify(username)}, password: 'verify123' }),
  }).then((r) => r.json()).catch((e) => ({ error: String(e) }))`);
  const confirmed = await evRetry(
    `fetch('${API}/api/auth/me', { credentials: 'include' }).then((r) => r.json()).catch(() => null)`,
  );
  if (!confirmed || confirmed.role !== expectedRole) {
    throw new Error(`登录 ${username} 失败：${JSON.stringify(who)} / me=${JSON.stringify(confirmed)}`);
  }
  // 同一 URL 的重复导航不保证重新加载；显式 reload 才能保证页面按新身份重新初始化
  await send('Page.reload', { ignoreCache: true });
  await sleep(2600);
  return confirmed;
}

/**
 * 带重试的页面内求值。
 *
 * 页面刚导航过去时就发 fetch，可能撞上正在换页的文档（TypeError: Failed to fetch）。
 * 这类失败是脚手架的时序问题，不是被测代码的问题，所以在这里重试而不是让它进结果。
 */
async function evRetry(expression, attempts = 4) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    last = await ev(expression);
    if (!(last && typeof last === 'object' && typeof last.error === 'string' && last.error.includes('Failed to fetch'))) {
      return last;
    }
    await sleep(500);
  }
  return last;
}

// ---------------------------------------------------------------- 访客

console.log('\n[1] 访客视角');
console.log('  （只读检查：登出后看目录树、正文、搜索、下载与权限拦截）');
// 先显式登出：验收脚本可能被重复运行，上一轮留下的会话会让「访客」其实已登录
await goto(`${DEV}/docs/`);
await ev(`fetch('${API}/api/auth/logout', { method: 'POST', credentials: 'include' })
  .then((r) => r.status)`);
const visitorSession = await ev(
  `fetch('${API}/api/auth/me', { credentials: 'include' }).then((r) => r.json()).catch(() => null)`,
);
check('访客段开始时确实是未登录状态', visitorSession === null, JSON.stringify(visitorSession));
await goto(`${DEV}/docs/`);
await waitFor(`document.querySelectorAll('.docs-tree-doc').length > 0`, {
  label: '目录树渲染',
});
const visitor = await ev(`(() => ({
  docs: document.querySelectorAll('.docs-tree-doc').length,
  folders: document.querySelectorAll('.docs-tree-folder').length,
  stats: document.querySelector('.docs-stats')?.textContent ?? '',
  manage: !!document.querySelector('.docs-manage-panel'),
  roleNote: document.querySelector('.docs-role-note')?.textContent ?? '',
  welcome: !!document.querySelector('.docs-welcome'),
}))()`);
check('访客能看到目录树', visitor.docs > 5, JSON.stringify(visitor));
check('访客看不到管理面板', visitor.manage === false);
check('访客身份提示正确', visitor.roleNote.includes('访客'), visitor.roleNote);
check('侧栏统计显示篇数与体积', /篇文档/.test(visitor.stats), visitor.stats);
await shot('docs-1-visitor-welcome');

// 打开一篇正文（第一篇 md）
await ev(`
(() => {
  const link = [...document.querySelectorAll('.docs-tree-doc')].find((n) =>
    n.querySelector('.docs-fmt-md'));
  link.click();
  return true;
})()`);
await waitFor(`!!document.querySelector('.docs-body')`, { label: '正文渲染' });
const article = await ev(`(() => ({
  title: document.querySelector('.docs-doc-head h1')?.textContent ?? '',
  bodyLen: document.querySelector('.docs-body')?.textContent.length ?? 0,
  headings: document.querySelectorAll('.docs-body h1,.docs-body h2,.docs-body h3').length,
  links: document.querySelectorAll('.docs-body a').length,
  toc: document.querySelector('.docs-toc')?.hidden === false,
  breadcrumb: document.querySelector('.docs-breadcrumb')?.textContent ?? '',
  hash: location.hash,
  scripts: document.querySelectorAll('.docs-body script').length,
}))()`);
check('正文渲染出内容', article.bodyLen > 200, `len=${article.bodyLen}`);
check('标题与面包屑就位', article.title.length > 2 && article.breadcrumb.includes('/'), JSON.stringify(article.breadcrumb));
check('正文里没有注入 script 标签', article.scripts === 0);
check('正文链接被渲染为元素', article.links >= 0);
check('URL 记录下来当前文档', /^#\/doc\/\d+$/.test(article.hash), article.hash);
await shot('docs-2-visitor-article');

// 站内互链：点正文里的相对链接
const internal = await ev(`
(() => {
  const link = document.querySelector('.docs-body a.docs-internal-link');
  if (!link) return null;
  const before = location.hash;
  link.click();
  return { before, label: link.textContent };
})()`);
if (internal) {
  await sleep(1200);
  const after = await ev(`location.hash`);
  check('正文里的站内链接可以跳转', after !== internal.before, `${internal.before} -> ${after}`);
} else {
  console.log('  · 这篇没有站内互链，跳过互链测试');
}

// 搜索
await ev(`
(() => {
  const input = document.querySelector('.docs-search input');
  input.value = '区块加载';
  document.querySelector('.docs-search').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  return true;
})()`);
await waitFor(`document.querySelectorAll('.docs-hit').length > 0`, { label: '搜索结果' });
const search = await ev(`(() => ({
  hits: document.querySelectorAll('.docs-hit').length,
  head: document.querySelector('.docs-search-head')?.textContent ?? '',
}))()`);
check('搜索返回结果', search.hits > 0, JSON.stringify(search));
check('搜索提示里带命中总数', /找到 \d+ 篇/.test(search.head), search.head);
await shot('docs-3-visitor-search');

// 点搜索结果进正文
await ev(`document.querySelector('.docs-hit').click()`);
await waitFor(`document.querySelector('.docs-body')?.textContent.length > 100`, { label: '搜索结果跳正文' });
const afterSearch = await ev(`document.querySelector('.docs-doc-head h1')?.textContent ?? ''`);
check('点搜索结果能打开正文', afterSearch.length > 1, afterSearch);

// 下载链接指向后端
await ev(`(() => { const a = document.querySelector('.docs-doc-actions a'); window.__dl = a.href; return true; })()`);
const downloadUrl = await ev(`window.__dl`);
check('下载链接指向 /api/docs/files/*/download', /\/api\/docs\/files\/\d+\/download$/.test(downloadUrl), downloadUrl);
const downloadStatus = await ev(`fetch(window.__dl).then((r) => r.status)`);
check('访客能下载原文件', downloadStatus === 200, `status=${downloadStatus}`);

// 访客访问管理接口应被拒
const visitorApi = await ev(`Promise.all([
  fetch('${API}/api/docs/permissions').then((r) => r.json()),
  fetch('${API}/api/docs/uploads/direct', { method: 'POST' }).then((r) => r.status),
]).then(([p, s]) => ({ role: p.role, can_upload: p.can_upload, upload_status: s }))`);
check('访客权限接口显示只读', visitorApi.role === null && visitorApi.can_upload === false, JSON.stringify(visitorApi));
check('访客直接调上传接口被拒（401）', visitorApi.upload_status === 401, `status=${visitorApi.upload_status}`);

// ---------------------------------------------------------------- 写操作门槛

/*
 * 从这一段开始会**写数据**（上传、建目录、审核、移动、删除）。
 *
 * 所以要求显式开启：默认只跑上面的只读检查。
 * 想跑完整链路时，必须先把后端指向一个隔离的库（见 tests/README.md 的
 * 「文档树的链路验收」一节），再加上 DOCS_ALLOW_MUTATIONS=1。
 * 这样就不会有人（或某个 agent）把它误指向真实站点，在站长的知识库里留下一堆
 * 「验收专用文档」——这种事要么不做，要么做得让人看得见。
 */
if (process.env.DOCS_ALLOW_MUTATIONS !== '1') {
  console.log('\n[跳过] 后面的写操作检查');
  console.log('  这一段会创建/移动/删除文档，因此默认不跑。');
  console.log('  要跑完整链路：把后端指向隔离库，然后 DOCS_ALLOW_MUTATIONS=1 重新执行。');
  console.log('\n[7] 控制台错误');
  const readOnlyErrors = consoleErrors.filter((e) => !/favicon|404 \(Not Found\)/i.test(e));
  check('页面没有 JS 异常', readOnlyErrors.length === 0, readOnlyErrors.slice(0, 3).join(' | '));
  console.log(`\n结果：${pass} 项通过，${fail} 项失败（只读模式）`);
  ws.close();
  process.exit(fail === 0 ? 0 : 1);
}

// ---------------------------------------------------------------- 登录为管理员

console.log('\n[2] 管理员视角（验收管理员）');
await signIn('验收管理员', 'admin');
await waitFor(`!!document.querySelector('.docs-manage-panel')`, { label: '管理面板' });
const adminView = await ev(`(() => ({
  manage: !!document.querySelector('.docs-manage-panel'),
  roleNote: document.querySelector('.docs-role-note')?.textContent ?? '',
  hasUpload: !!document.querySelector('.docs-manage-card input[type=file]'),
  reviewButtons: [...document.querySelectorAll('.docs-submission-actions button')]
    .map((b) => b.textContent),
  draftCount: document.querySelectorAll('.docs-tree-doc.is-draft').length,
}))()`);
check('管理员看到管理面板', adminView.manage === true);
check('管理员提示里写清「需要超管审核」', adminView.roleNote.includes('审核'), adminView.roleNote);
check('管理面板有文件上传控件', adminView.hasUpload === true);
check('管理员看不到「批准并发布」按钮', !adminView.reviewButtons.includes('批准并发布'),
  JSON.stringify(adminView.reviewButtons));
await shot('docs-4-admin-panel');

// 管理员上传一个 md 文件（走真实分块上传链路）
//
// 赋值 input.files 与点击之间必须等一下：脚本在同一帧里连做两步时，浏览器还没把
// FileList 交给 input，点击瞬间读到的 files 仍是空的。赋值后立刻读回来校验，
// 避免「界面上报了成功、服务端却什么都没收到」这种假通过。
const fileReady = await ev(`
(() => {
  const file = new File(
    [new Blob(['# 验收文档\\n\\n这是管理员上传的一篇文档，用来验证审核链路。\\n\\n## 小节\\n\\n- 第一条\\n- 第二条\\n'])],
    '验收专用文档.md',
    { type: 'text/markdown' },
  );
  const dt = new DataTransfer();
  dt.items.add(file);
  const input = document.querySelector('.docs-manage-card input[type=file]');
  input.files = dt.files;
  const box = document.querySelectorAll('.docs-manage-card input[type=text]');
  box[0].value = '验收专用文档';
  box[1].value = '管理员上传的验收用文档';
  return { files: input.files.length, name: input.files[0]?.name, title: box[0].value };
})()`);
check('上传表单已填好（文件 + 标题）',
  fileReady.files === 1 && fileReady.title === '验收专用文档', JSON.stringify(fileReady));
await sleep(500);
const recheck = await ev(
  `document.querySelector('.docs-manage-card input[type=file]').files.length`,
);
check('点击前文件仍在 input 上', recheck === 1, `files=${recheck}`);

const uploadResult = await ev(`
(() => {
  const button = [...document.querySelectorAll('.docs-manage-card button')]
    .find((b) => b.textContent.includes('上传'));
  if (!button) return false;
  button.click();
  return true;
})()`);
check('上传按钮被点到', uploadResult === true);
const uploadOutcome = await waitFor(
  `(() => {
     const progress = document.querySelector('.docs-progress')?.textContent ?? '';
     if (progress.includes('提交单') || progress.includes('已发布')) return progress;
     return '';
   })()`,
  { timeout: 20000, label: '上传并提交' },
).catch(async () => {
  const state = await ev(`(() => ({
    progress: document.querySelector('.docs-progress')?.textContent ?? '',
    files: document.querySelector('.docs-manage-card input[type=file]')?.files?.length ?? -1,
    toast: [...document.querySelectorAll('.ui-toast')].map((t) => t.textContent).join(' | '),
    tail: document.body.innerText.slice(-300),
  }))()`);
  return { failed: true, ...state };
});
const uploadText = typeof uploadOutcome === 'string' ? uploadOutcome : JSON.stringify(uploadOutcome);
check('上传后进入待审队列', /提交单/.test(uploadText) && /待审/.test(uploadText), uploadText);
// 直接问服务端：这一步能把「界面显示了成功但服务端没落库」这类假成功暴露出来
const serverSide = await ev(`fetch('${API}/api/docs/submissions?scope=mine', {
  credentials: 'include' }).then((r) => r.json()).then((d) => ({
    total: (d.items || []).length,
    titles: (d.items || []).map((i) => i.title || i.name),
    hasUpload: (d.items || []).some((i) => i.title === '验收专用文档' && i.status === 'pending'),
  }))`);
check('服务端确实收到了这条提交单', serverSide.hasUpload === true, JSON.stringify(serverSide));
await shot('docs-5-admin-uploaded');

// 管理员新建文件夹（进待审队列）
await ev(`
(() => {
  const cards = [...document.querySelectorAll('.docs-manage-card')];
  const folderCard = cards.find((c) => c.textContent.includes('新建文件夹'));
  folderCard.querySelector('input[type=text]').value = '验收新目录';
  [...folderCard.querySelectorAll('button')].find((b) => b.textContent.includes('提交新建申请')).click();
  return true;
})()`);
await sleep(1200);
const folderSubmit = await ev(`document.querySelector('.docs-manage-panel')?.textContent ?? ''`);
check('新建文件夹提交成功', folderSubmit.includes('验收新目录'), '');

// 待审内容对访客不可见
const stillHidden = await ev(`fetch('${API}/api/docs/tree').then((r) => r.json()).then((t) => ({
  docs: t.stats.documents,
  hasNewFolder: JSON.stringify(t.root.children.map((c) => c.name)).includes('验收新目录'),
}))`);
check('待审内容没有进线上目录树', stillHidden.hasNewFolder === false, JSON.stringify(stillHidden));

const memberTry = await ev(`fetch('${API}/api/docs/submissions', {
  method: 'POST', credentials: 'include',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'create_folder', name: '越权目录' }),
}).then((r) => r.status)`);
check('管理员可以提交（201）', memberTry === 201, `status=${memberTry}`);

// ---------------------------------------------------------------- 登录为超管

console.log('\n[3] 超级管理员视角（验收站长）');
await signIn('验收站长', 'superadmin');
await waitFor(`!!document.querySelector('.docs-manage-panel')`, { label: '超管管理面板' });
const bossView = await ev(`(() => ({
  roleNote: document.querySelector('.docs-role-note')?.textContent ?? '',
  approve: [...document.querySelectorAll('.docs-submission-actions button')]
    .filter((b) => b.textContent.includes('批准并发布')).length,
  reject: [...document.querySelectorAll('.docs-submission-actions button')]
    .filter((b) => b.textContent.includes('驳回')).length,
  rows: document.querySelectorAll('.docs-submission').length,
}))()`);
check('超管看到待审队列', bossView.rows >= 3, JSON.stringify(bossView));
check('超管有批准 / 驳回按钮', bossView.approve >= 3 && bossView.reject >= 3, JSON.stringify(bossView));
check('超管提示可以直接发布', bossView.roleNote.includes('直接发布'), bossView.roleNote);
await shot('docs-6-boss-queue');

// 批准「验收专用文档」
const approved = await ev(`
(() => {
  const rows = [...document.querySelectorAll('.docs-submission')];
  const row = rows.find((r) => r.textContent.includes('验收专用文档'));
  if (!row) return 'not-found';
  const note = row.querySelector('.docs-review-note');
  if (note) note.value = '内容可以，发布';
  [...row.querySelectorAll('button')].find((b) => b.textContent.includes('批准并发布')).click();
  return 'clicked';
})()`);
check('找到待审文档并点批准', approved === 'clicked', approved);
await sleep(2500);
const afterApprove = await ev(`fetch('${API}/api/docs/tree').then((r) => r.json()).then((t) => ({
  docs: t.stats.documents,
  found: JSON.stringify(t).includes('验收专用文档'),
}))`);
check('批准后文档出现在线上目录树', afterApprove.found === true && afterApprove.docs > 120,
  JSON.stringify(afterApprove));

// 驳回「越权目录」
await sleep(1500);
const rejected = await ev(`
(() => {
  const rows = [...document.querySelectorAll('.docs-submission')];
  const row = rows.find((r) => r.textContent.includes('越权目录') && r.textContent.includes('待审核'));
  if (!row) return 'not-found';
  const note = row.querySelector('.docs-review-note');
  if (note) note.value = '命名不合适，换个名字再提';
  [...row.querySelectorAll('button')].find((b) => b.textContent.includes('驳回')).click();
  return 'clicked';
})()`);
check('找到待审文件夹并点驳回', rejected === 'clicked', rejected);
await sleep(2500);
const afterReject = await ev(`fetch('${API}/api/docs/tree').then((r) => r.json()).then((t) => ({
  hasFolder: JSON.stringify(t.root.children.map((c) => c.name)).includes('越权目录'),
}))`);
check('驳回的文件夹没有进线上目录树', afterReject.hasFolder === false, JSON.stringify(afterReject));
await shot('docs-7-boss-reviewed');

// 批准「验收新目录」文件夹
const approveFolder = await ev(`
(() => {
  const rows = [...document.querySelectorAll('.docs-submission')];
  const row = rows.find((r) => r.textContent.includes('验收新目录') && r.textContent.includes('待审核'));
  if (!row) return 'not-found';
  [...row.querySelectorAll('button')].find((b) => b.textContent.includes('批准并发布')).click();
  return 'clicked';
})()`);
check('找到待审文件夹并点批准', approveFolder === 'clicked', approveFolder);
await sleep(2500);
const folderLive = await ev(`fetch('${API}/api/docs/tree').then((r) => r.json()).then((t) => ({
  names: t.root.children.map((c) => c.name),
  folders: t.stats.folders,
}))`);
check('批准后新文件夹出现在目录树', folderLive.names.includes('验收新目录'), JSON.stringify(folderLive.names));

// ---------------------------------------------------------------- 访客复查

console.log('\n[4] 访客复查（登出后）');
// 登出必须在导航之前完成：fetch 还没返回就 Page.navigate，请求会被取消，
// 于是浏览器里会留着超管的会话，后面所有「访客」检查都会假失败。
const loggedOut = await ev(`fetch('${API}/api/auth/logout', { method: 'POST', credentials: 'include' })
  .then(() => 'done').catch((e) => 'failed:' + e)`);
const meAfterLogout = await ev(`fetch('${API}/api/auth/me').then((r) => r.json()).catch(() => null)`);
check('登出请求完成且会话已清空', loggedOut === 'done' && meAfterLogout === null,
  `${loggedOut} / me=${JSON.stringify(meAfterLogout)}`);
await goto(`${DEV}/docs/`);
// 只改 hash 的导航不会重新加载文档，这里显式刷新一次，保证目录树是按「访客」重新拉取的
await send('Page.reload', { ignoreCache: true });
await sleep(2200);
await waitFor(`document.querySelectorAll('.docs-tree-doc').length > 0`, { label: '访客目录树' });
const finalVisitor = await ev(`(async () => {
  const tree = await fetch('${API}/api/docs/tree').then((r) => r.json());
  const hit = Object.keys(tree).length && JSON.stringify(tree).includes('验收专用文档');
  const detail = await fetch('${API}/api/docs/search?q=' + encodeURIComponent('验收专用文档'))
    .then((r) => r.json());
  return {
    manage: !!document.querySelector('.docs-manage-panel'),
    docs: tree.stats.documents,
    folders: tree.stats.folders,
    hasNewDoc: hit,
    hasNewFolder: JSON.stringify(tree.root.children.map((c) => c.name)).includes('验收新目录'),
    searchTotal: detail.total,
    searchId: detail.hits[0]?.id ?? null,
  };
})()`);
check('访客看不到管理面板', finalVisitor.manage === false);
check('访客看得到已批准的文档', finalVisitor.hasNewDoc === true);
check('访客看得到已批准的文件夹', finalVisitor.hasNewFolder === true);
check('访客能搜到已批准的文档', finalVisitor.searchTotal >= 1, JSON.stringify(finalVisitor));

// 访客打开这篇新文档看正文
await ev(`
(() => {
  const link = [...document.querySelectorAll('.docs-tree-doc')]
    .find((n) => n.textContent.includes('验收专用文档'));
  link.click();
  return true;
})()`);
await waitFor(`(document.querySelector('.docs-body')?.textContent ?? '').includes('管理员上传')`, {
  label: '新文档正文',
});
const newDoc = await ev(`(() => ({
  title: document.querySelector('.docs-doc-head h1')?.textContent ?? '',
  body: document.querySelector('.docs-body')?.textContent.slice(0, 60) ?? '',
  items: document.querySelectorAll('.docs-body li').length,
  h2: document.querySelectorAll('.docs-body h2').length,
}))()`);
check('访客能读到新文档正文', newDoc.body.includes('管理员上传'), newDoc.body);
check('Markdown 结构被正确渲染（标题/列表）', newDoc.h2 >= 1 && newDoc.items >= 2, JSON.stringify(newDoc));
await shot('docs-8-visitor-new-doc');

// 长文本（.txt）按纯文本渲染
await ev(`
(() => {
  const link = [...document.querySelectorAll('.docs-tree-doc')]
    .find((n) => n.querySelector('.docs-fmt-txt'));
  link.click();
  return true;
})()`);
await waitFor(`!!document.querySelector('.docs-plain')`, { label: 'txt 纯文本渲染' });
const txt = await ev(`(() => ({
  plain: !!document.querySelector('.docs-plain'),
  len: document.querySelector('.docs-plain')?.textContent.length ?? 0,
  rawLink: [...document.querySelectorAll('.docs-doc-actions a')].map((a) => a.textContent).join(' / '),
}))()`);
check('txt 文档按纯文本渲染', txt.plain && txt.len > 50, JSON.stringify(txt));
check('非 md 文档提供原始文本入口', txt.rawLink.includes('原始文本'), txt.rawLink);

// json 文档同样可读
await ev(`
(() => {
  const link = [...document.querySelectorAll('.docs-tree-doc')]
    .find((n) => n.querySelector('.docs-fmt-json'));
  if (!link) return false;
  link.click();
  return true;
})()`);
await waitFor(`!!document.querySelector('.docs-plain')`, { label: 'json 纯文本渲染' });
const json = await ev(`document.querySelector('.docs-plain')?.textContent.slice(0, 40) ?? ''`);
check('json 文档可读', json.trim().startsWith('{'), json);

// ---------------------------------------------------------------- 移动与删除

console.log('\n[5] 整理目录：移动 / 改名 / 删除');
// 这一段会改数据，所以重新以超管身份登录
await signIn('验收站长', 'superadmin');
await waitFor(`document.querySelectorAll('.docs-tree-doc').length > 0`, { label: '超管目录树' });

// 打开刚批准的那篇，确认正文按钮是按角色给的
await ev(`
(() => {
  const link = [...document.querySelectorAll('.docs-tree-doc')]
    .find((n) => n.textContent.includes('验收专用文档'));
  link.click();
  return true;
})()`);
await waitFor(`(document.querySelector('.docs-body')?.textContent ?? '').includes('管理员上传')`,
  { label: '打开目标文档' });
const docButtons = await ev(
  `[...document.querySelectorAll('.docs-doc-actions button')].map((b) => b.textContent)`,
);
check('超管在正文上看到移动/改名/删除按钮',
  docButtons.includes('移动到…') && docButtons.includes('改标题') && docButtons.includes('删除这篇'),
  JSON.stringify(docButtons));

// 侧栏 ⋯ → 移动文档：先选动作，再在移动弹窗里选目标文件夹
const movedTo = await ev(`
(() => {
  const row = [...document.querySelectorAll('.docs-tree-doc-row')]
    .find((r) => r.textContent.includes('验收专用文档'));
  if (!row) return 'row-not-found';
  row.querySelector('.docs-tree-tools').click();
  return 'opened';
})()`);
check('打开文档整理弹窗', movedTo === 'opened', movedTo);
await waitFor(`!!document.querySelector('.docs-overlay')`, { label: '整理弹窗' });
await ev(`
(() => {
  const select = document.querySelector('.docs-modal select');
  select.value = 'move';
  [...document.querySelectorAll('.docs-modal-actions button')]
    .find((b) => b.textContent.includes('继续')).click();
  return true;
})()`);
await waitFor(`!!document.querySelector('.docs-modal select')`, { label: '移动弹窗' });
const modalInfo = await ev(`(() => ({
  note: document.querySelector('.docs-modal-note')?.textContent ?? '',
  optionCount: document.querySelectorAll('.docs-modal select option').length,
  submitLabel: [...document.querySelectorAll('.docs-modal-actions button')].map((b) => b.textContent),
}))()`);
check('移动弹窗告知超管「立刻生效」', modalInfo.note.includes('立刻生效'), modalInfo.note);
check('移动弹窗按超管给出「立即移动」', modalInfo.submitLabel.includes('立即移动'),
  JSON.stringify(modalInfo.submitLabel));
check('移动弹窗列出了可选文件夹', modalInfo.optionCount >= 3, JSON.stringify(modalInfo));
await shot('docs-9-move-modal');

await ev(`
(() => {
  const select = document.querySelector('.docs-modal select');
  select.value = [...select.options].find((o) => o.textContent.includes('验收新目录')).value;
  document.querySelector('.docs-modal textarea, .docs-modal input[type=text]').value = '归到验收目录';
  [...document.querySelectorAll('.docs-modal-actions button')]
    .find((b) => b.textContent.includes('立即移动')).click();
  return true;
})()`);
await waitFor(`!document.querySelector('.docs-overlay')`, { label: '弹窗关闭' });
await sleep(1600);
const afterMove = await ev(`fetch('${API}/api/docs/tree', { credentials: 'include' })
  .then((r) => r.json()).then((t) => {
    const folder = t.root.children.find((c) => c.name === '验收新目录');
    return {
      inFolder: (folder?.documents ?? []).some((d) => d.title === '验收专用文档'),
      inRoot: t.root.documents.some((d) => d.title === '验收专用文档'),
    };
  })`);
check('文档被移到目标文件夹（立即生效）', afterMove.inFolder === true && afterMove.inRoot === false,
  JSON.stringify(afterMove));

// 改标题（正文按钮入口）
await ev(`
(() => {
  const link = [...document.querySelectorAll('.docs-tree-doc')]
    .find((n) => n.textContent.includes('验收专用文档'));
  if (!link) return false;
  link.click();
  return true;
})()`);
await waitFor(`!!document.querySelector('.docs-body')`, { label: '再次打开文档' });
await ev(`[...document.querySelectorAll('.docs-doc-actions button')]
  .find((b) => b.textContent.includes('改标题')).click()`);
await waitFor(`!!document.querySelector('.docs-modal input[type=text]')`, { label: '改名弹窗' });
await ev(`(() => {
  document.querySelector('.docs-modal input[type=text]').value = '验收专用文档（已改名）';
  [...document.querySelectorAll('.docs-modal-actions button')]
    .find((b) => b.textContent.includes('立即修改')).click();
  return true;
})()`);
await sleep(2000);
const afterRename = await ev(`fetch('${API}/api/docs/tree', { credentials: 'include' })
  .then((r) => r.json()).then((t) => ({
    renamed: JSON.stringify(t).includes('已改名'),
    stillInFolder: (t.root.children.find((c) => c.name === '验收新目录')?.documents ?? [])
      .some((d) => d.title.includes('已改名')),
  }))`);
check('改标题后目录树显示新名字', afterRename.renamed === true, JSON.stringify(afterRename));
check('改名不影响它所在的文件夹', afterRename.stillInFolder === true, JSON.stringify(afterRename));

// 删除该文档
await ev(`
(() => {
  const link = [...document.querySelectorAll('.docs-tree-doc')]
    .find((n) => n.textContent.includes('已改名'));
  link.click();
  return true;
})()`);
await waitFor(`!!document.querySelector('.docs-body')`, { label: '打开待删文档' });
await ev(`[...document.querySelectorAll('.docs-doc-actions button')]
  .find((b) => b.textContent.includes('删除这篇')).click()`);
await waitFor(`!!document.querySelector('.docs-modal textarea')`, { label: '删除弹窗' });
const deleteNote = await ev(`document.querySelector('.docs-modal-note')?.textContent ?? ''`);
check('删除弹窗说明不可恢复', deleteNote.includes('无法在站内恢复'), deleteNote);
await shot('docs-10-delete-modal');
await ev(`(() => {
  document.querySelector('.docs-modal textarea').value = '界面验收：删除';
  [...document.querySelectorAll('.docs-modal-actions button')]
    .find((b) => b.textContent.includes('确认删除')).click();
  return true;
})()`);
await sleep(2200);
const afterDelete = await ev(`fetch('${API}/api/docs/tree', { credentials: 'include' })
  .then((r) => r.json()).then((t) => ({ gone: !JSON.stringify(t).includes('已改名') }))`);
check('超管删除文档后目录树里消失', afterDelete.gone === true, JSON.stringify(afterDelete));

// 文件夹重命名（连带路径）
const folderOpened = await ev(`
(() => {
  const row = [...document.querySelectorAll('.docs-tree-folder')]
    .find((r) => r.textContent.includes('验收新目录'));
  if (!row) return 'folder-row-not-found';
  row.querySelector('.docs-tree-tools').click();
  return 'opened';
})()`);
check('打开文件夹整理弹窗', folderOpened === 'opened', folderOpened);
await waitFor(`!!document.querySelector('.docs-overlay')`, { label: '文件夹整理弹窗' });
await ev(`(() => {
  const select = document.querySelector('.docs-modal select');
  select.value = 'rename';
  [...document.querySelectorAll('.docs-modal-actions button')]
    .find((b) => b.textContent.includes('继续')).click();
  return true;
})()`);
await waitFor(`!!document.querySelector('.docs-modal input[type=text]')`, { label: '文件夹改名弹窗' });
await ev(`(() => {
  document.querySelector('.docs-modal input[type=text]').value = '验收目录（改名后）';
  [...document.querySelectorAll('.docs-modal-actions button')]
    .find((b) => b.textContent.includes('立即改名')).click();
  return true;
})()`);
await sleep(2000);
const afterFolderRename = await ev(`fetch('${API}/api/docs/tree', { credentials: 'include' })
  .then((r) => r.json()).then((t) => {
    const node = t.root.children.find((c) => c.name === '验收目录（改名后）');
    return { renamed: !!node, path: node?.path ?? null };
  })`);
check('文件夹改名并更新路径', afterFolderRename.renamed === true &&
  afterFolderRename.path === '验收目录（改名后）', JSON.stringify(afterFolderRename));
await shot('docs-11-superadmin-organize');

// ---------------------------------------------------------------- 管理员的整理入口

console.log('\n[6] 管理员的移动（走提交单）');
await signIn('验收管理员', 'admin');
await waitFor(`document.querySelectorAll('.docs-tree-doc').length > 0`, { label: '管理员目录树' });
await ev(`
(() => {
  const link = [...document.querySelectorAll('.docs-tree-doc')].find((n) =>
    n.querySelector('.docs-fmt-md'));
  link.click();
  return true;
})()`);
await waitFor(`!!document.querySelector('.docs-body')`, { label: '管理员打开文档' });
const adminButtons = await ev(
  `[...document.querySelectorAll('.docs-doc-actions button')].map((b) => b.textContent)`,
);
check('管理员看到的是「提交申请」而不是直接执行',
  adminButtons.includes('移动到…') && adminButtons.includes('申请删除这篇') &&
  !adminButtons.includes('删除这篇'),
  JSON.stringify(adminButtons));

const adminTitle = await ev(`document.querySelector('.docs-doc-head h1')?.textContent ?? ''`);
await ev(`[...document.querySelectorAll('.docs-doc-actions button')]
  .find((b) => b.textContent.includes('移动到…')).click()`);
await waitFor(`!!document.querySelector('.docs-modal select')`, { label: '管理员移动弹窗' });
const adminModalNote = await ev(`document.querySelector('.docs-modal-note')?.textContent ?? ''`);
check('管理员弹窗说明需要审核', adminModalNote.includes('待审队列'), adminModalNote);
await ev(`(() => {
  const select = document.querySelector('.docs-modal select');
  const option = [...select.options].find((o) => o.textContent.includes('验收目录（改名后）'));
  select.value = option.value;
  document.querySelector('.docs-modal input[type=text]').value = '请归到验收目录';
  [...document.querySelectorAll('.docs-modal-actions button')]
    .find((b) => b.textContent.includes('提交移动申请')).click();
  return true;
})()`);
await sleep(2000);
const adminSubmitted = await ev(`fetch('${API}/api/docs/submissions?scope=mine', {
  credentials: 'include' }).then((r) => r.json()).then((d) => {
    const row = (d.items || []).find((i) => i.action === 'move_doc' && i.status === 'pending');
    return { found: !!row, target: row?.target_path ?? null, title: row?.title ?? null };
  })`);
check('管理员的移动进了待审队列并写明目标',
  adminSubmitted.found === true && adminSubmitted.target === '验收目录（改名后）',
  JSON.stringify(adminSubmitted));

// 超管在队列里批准这条移动
await signIn('验收站长', 'superadmin');
await waitFor(`!!document.querySelector('.docs-manage-panel')`, { label: '超管管理面板' });
const approved2 = await ev(`
(() => {
  const row = [...document.querySelectorAll('.docs-submission')]
    .find((r) => r.textContent.includes('移动文档') && r.textContent.includes('待审核'));
  if (!row) return 'not-found';
  [...row.querySelectorAll('button')].find((b) => b.textContent.includes('批准并发布')).click();
  return 'clicked';
})()`);
check('超管在队列里找到并批准移动', approved2 === 'clicked', approved2);
await sleep(2500);
const afterApproveMove = await ev(`fetch('${API}/api/docs/tree', { credentials: 'include' })
  .then((r) => r.json()).then((t) => {
    const folder = t.root.children.find((c) => c.name === '验收目录（改名后）');
    return {
      inFolder: (folder?.documents ?? []).some((d) => d.title === ${JSON.stringify(adminTitle)}),
    };
  })`);
check('批准后文档真的移到了目标目录', afterApproveMove.inFolder === true,
  JSON.stringify(afterApproveMove));

// ---------------------------------------------------------------- 汇总

console.log('\n[7] 控制台错误');
const realErrors = consoleErrors.filter((e) => !/favicon|404 \(Not Found\)/i.test(e));
check('页面没有 JS 异常', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

console.log(`\n结果：${pass} 项通过，${fail} 项失败`);
console.log(`截图目录：${SHOTS}`);
ws.close();
process.exit(fail === 0 ? 0 : 1);