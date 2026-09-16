// 收藏功能的浏览器验证（登录门槛 + 登录后收藏/取消）。
//
// 通过 CDP 驱动真实无头浏览器。两个要点：
//  1. 页面发出的 API 请求用的是**构建时注入的** PUBLIC_API_BASE（见 src/shared/api-client.ts），
//     所以本脚本里所有"直接调后端"的地方必须用同一个基地址，否则会写到另一个后端。
//     这里从打包产物里读出这个地址，避免手写不一致。
//  2. 后端必须允许该页面的 origin（NAYTIA_CORS_ORIGINS），否则带凭据的请求会被浏览器拦掉。
//
// 用法：node tests/manual/e2e-favorites.mjs [base] [debugPort]
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] ?? 'http://localhost:4399';
const DEBUG_PORT = process.argv[3] ?? '9223';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 从打包产物里读出前端实际使用的 API 基地址。
 *
 * 为什么要这么做：页面里的 API 地址由 `PUBLIC_API_BASE` 在**构建时**注入
 * （见 src/shared/api-client.ts），默认值是 `http://127.0.0.1:8000`。
 * 脚本若自己写死一个地址，就可能写到另一个后端上，表现为
 * 「注册返回 201，但页面刷新后仍是未登录」——排查成本很高，干脆直接读产物。
 *
 * 注意地址在**懒加载的工具 chunk** 里，不在首屏脚本里，所以要扫整个 dist/_astro。
 */
function readApiBase() {
  const dir = join(REPO, 'dist', '_astro');
  const found = new Set();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.js')) continue;
    const text = readFileSync(join(dir, file), 'utf8');
    for (const m of text.matchAll(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+/g)) {
      found.add(m[0]);
    }
  }
  const list = [...found];
  if (list.length === 0) {
    // 产物里没有硬编码地址 = PUBLIC_API_BASE 为空 = 前端走相对路径。
    // 这正是「同源部署」的口径（前端与 API 同一来源，Cookie 天然可携带），
    // 也是本脚本最稳的运行方式：所有 API 请求都打到 BASE，由它反代到后端。
    console.log('  （产物无硬编码 API 地址 → 前端走相对路径，与页面同源）');
    return '';
  }
  if (list.length > 1) {
    console.log(`  注意：产物里有多个 API 地址 ${list.join(', ')}，取第一个`);
  }
  return list[0];
}

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`  [OK] ${message}`);
  else {
    failures += 1;
    console.log(`  [FAIL] ${message}`);
  }
}

async function connect() {
  const targets = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('没有可用的页面目标');
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
    new Promise((resolve) => {
      const msgId = ++id;
      pending.set(msgId, resolve);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.result?.exceptionDetails) {
      throw new Error(res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text);
    }
    return res.result?.result?.value;
  };
  await send('Page.enable');
  await send('Runtime.enable');
  return { send, evaluate, close: () => ws.close() };
}

/** 当前工具箱里唯一的工具。 */
const TOOL_PATH = '/tools/mcstructure-editor/';
const TOOL_ID = 'mcstructure-editor';

async function main() {
  const apiBase = readApiBase();
  console.log(`页面 API 基地址：${apiBase === '' ? '(相对路径，与页面同源)' : apiBase}`);
  // 相对路径时 apiBase 为空串，拼接结果正好是 '/api/...'，无需特判
  const api = (path) => `${apiBase}${path}`;
  console.log(`页面来源：${BASE}`);

  const { send, evaluate, close } = await connect();
  const user = `e2e${Date.now().toString().slice(-6)}`;

  // ---- 场景 1：未登录点收藏 → 登录弹窗
  await send('Page.navigate', { url: `${BASE}${TOOL_PATH}` });
  await sleep(2800);
  const locked = await evaluate(`document.querySelector('.tool-actions-bar button')?.innerText`);
  assert((locked ?? '').includes('登录'), `未登录时按钮提示登录（"${locked}"）`);

  await evaluate(`document.querySelector('.tool-actions-bar button').click()`);
  await sleep(900);
  const dialog = await evaluate(`(() => {
    const d = document.getElementById('account-dialog');
    return { shown: !!d && !d.hidden, title: d?.querySelector('h2')?.innerText ?? '' };
  })()`);
  assert(dialog.shown, '点收藏打开了登录弹窗（不是空按钮）');
  await evaluate(`document.querySelector('.ui-dialog-close')?.click()`);
  await sleep(300);

  // ---- 场景 2：注册（直接打到页面用的那个后端，并保持同源凭据）
  const reg = await evaluate(`fetch('${api('/api/auth/register')}', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: '${user}', password: 'secret123' })
  }).then(async r => ({ status: r.status, body: (await r.text()).slice(0, 80) }))`);
  assert(reg.status === 201, `注册成功（HTTP ${reg.status}）`);

  const me = await evaluate(`fetch('${api('/api/auth/me')}', { credentials: 'include' }).then(r => r.json())`);
  assert(me?.username === user, `会话建立（/me 返回 ${me?.username}）`);

  // ---- 场景 3：刷新页面 → 按钮解锁
  await send('Page.navigate', { url: `${BASE}${TOOL_PATH}` });
  await sleep(3200);
  const unlocked = await evaluate(`document.querySelector('.tool-actions-bar button')?.innerText`);
  assert((unlocked ?? '').includes('收藏这个工具'), `刷新后按钮解锁（"${unlocked}"）`);

  // ---- 场景 4：收藏 → 后端写入
  await evaluate(`document.querySelector('.tool-actions-bar button').click()`);
  await sleep(1800);
  const afterAdd = await evaluate(`document.querySelector('.tool-actions-bar button')?.innerText`);
  const serverFavs = await evaluate(
    `fetch('${api('/api/favorites')}', { credentials: 'include' }).then(r => r.json())`,
  );
  assert((afterAdd ?? '').includes('已收藏'), `状态变成已收藏（"${afterAdd}"）`);
  assert(
    Array.isArray(serverFavs?.tools) && serverFavs.tools.includes(TOOL_ID),
    `后端收藏列表含 ${TOOL_ID}（${JSON.stringify(serverFavs?.tools)}）`,
  );

  // ---- 场景 5：再点一次取消
  await evaluate(`document.querySelector('.tool-actions-bar button').click()`);
  await sleep(1800);
  const afterRemove = await evaluate(`document.querySelector('.tool-actions-bar button')?.innerText`);
  const favsAfter = await evaluate(
    `fetch('${api('/api/favorites')}', { credentials: 'include' }).then(r => r.json())`,
  );
  assert((afterRemove ?? '').includes('收藏这个工具'), `取消后按钮回到可收藏（"${afterRemove}"）`);
  assert(
    Array.isArray(favsAfter?.tools) && !favsAfter.tools.includes(TOOL_ID),
    `后端已移除（${JSON.stringify(favsAfter?.tools)}）`,
  );

  close();
  console.log(failures === 0 ? '\n收藏链路全部通过。' : `\n有 ${failures} 项失败。`);
  return failures;
}

main().then(
  (failed) => process.exit(failed === 0 ? 0 : 1),
  (error) => {
    console.error('\n脚本失败：', error.message);
    process.exit(1);
  },
);
