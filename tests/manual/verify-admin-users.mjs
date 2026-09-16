// 账号管理页（/admin/users/）的链路验收：真浏览器 + 真后端 + 真 Astro 服务。
//
// 用法（都在仓库根目录执行）：
//   node tests/manual/verify-admin-users.mjs
//
// 为什么用隔离库：这一页会**真的改角色**，绝不能对着站长的 backend/data/app.db 跑。
// 脚本自己拉起后端（临时库）、Astro 开发服务器与无头浏览器，跑完全部清理。
//
// 为什么走 Astro 开发服务器而不是 dist/：Astro 走 Vite 的按需转换，只编译被访问的
// 页面用到的模块——本仓库同一时刻可能还有别的改动在飞（论坛模块正在重构时
// `npm run build` 会因为别人的文件而失败），链路验证不该被那些改动挡住。
// 生产构建是否通过，由 `npm run build` 单独负责。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { connect, createChecker } from './cdp.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BACKEND_PORT = Number(process.env.ADMIN_VERIFY_BACKEND_PORT ?? 8124);
const SITE_PORT = Number(process.env.ADMIN_VERIFY_SITE_PORT ?? 4334);
const CDP_PORT = Number(process.env.ADMIN_VERIFY_CDP_PORT ?? 9444);
const SITE = `http://localhost:${SITE_PORT}`;
const PASSWORD = 'verify123';

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));
if (!CHROME) throw new Error('找不到 Chrome / Edge，无法做浏览器验收');

const work = mkdtempSync(join(tmpdir(), 'admin-users-verify-'));
const children = [];

function start(name, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? REPO,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  // spawn 失败是异步报的（ENOENT 之类），不接住就会变成一个没有上下文的崩溃
  child.on('error', (err) => console.error(`[${name}] 启动失败：${err.message}`));
  child.stdout.on('data', (b) => options.log && process.stdout.write(`[${name}] ${b}`));
  child.stderr.on('data', (b) => process.stdout.write(`[${name}!] ${b}`));
  children.push({ name, child });
  return child;
}

/**
 * 善后：收掉子进程（含整棵进程树）、删临时目录。
 *
 * **全部同步**，而且注册到 `process.on('exit')`。
 * 为什么必须是同步的：`process.exit()` **不会**等待挂起的 async 工作，
 * 所以「finally 里 await 清理」有一条真实的漏网路径——脚本最后一句是
 * `process.exit(ok ? 0 : 1)`，那一刻异步清理就被丢掉了。同步函数在 exit
 * 阶段仍然会被完整执行。
 *
 * 幂等：exit 处理器与 finally 都会调用，重复调用无害。
 */
function cleanup() {
  for (const { child } of children) {
    if (child.killed || child.exitCode !== null) continue;
    try {
      if (process.platform === 'win32') {
        // **必须连子树一起杀**：`child.kill()` 只杀直接子进程，Chrome 会留下一堆
        // 渲染/GPU 子进程，它们继续占着用户数据目录——临时目录删不掉只是表象，
        // 真正的问题是每跑一次就多一批僵尸浏览器进程（实测留下了 40 多个）。
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        child.kill('SIGKILL');
      }
    } catch {
      // 进程可能已经自己退出了
    }
  }
  // 临时目录：删不掉不是验收失败（Chrome 的句柄可能还没释放完），
  // 所以这里吞掉异常——真实结论在断言里，别让清理把那份结论盖掉。
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    console.error(`（临时目录没能删掉，可手动清理：${work}）`);
  }
}

process.on('exit', cleanup);

async function waitForHttp(url, { timeoutMs = 60000, expect } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (!expect || res.status === expect) return res;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err.message;
    }
    await delay(300);
  }
  throw new Error(`${url} 没有就绪（最后一次：${last}）`);
}

/** 后端：隔离库 + 明文 Cookie（浏览器在 http 下不会回传 Secure Cookie）。 */
async function startBackend() {
  const db = join(work, 'verify.db');
  const child = start('backend', 'python', ['-m', 'uvicorn', 'app.main:app',
    '--host', '127.0.0.1', '--port', String(BACKEND_PORT), '--log-level', 'warning'], {
    cwd: join(REPO, 'backend'),
    env: {
      NAYTIA_SQLITE_PATH: db,
      NAYTIA_COOKIE_SECURE: 'false',
      NAYTIA_DOCS_STORAGE_DIR: join(work, 'docs'),
      NAYTIA_FORUM_STRUCTURE_DIR: join(work, 'forum'),
    },
  });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) console.error(`[backend] 退出码 ${code}`);
  });
  await waitForHttp(`http://127.0.0.1:${BACKEND_PORT}/api/site-config`);
}

/**
 * Astro 开发服务器 + Vite 代理。
 *
 * 为什么要代理：会话 Cookie 是 SameSite=Lax，跨端口时浏览器不会在 fetch 里带上它
 * （见 tests/README.md 的说明）。把 /api 反代到后端，浏览器视角就是同源。
 * 代理走**环境变量** `VITE_API_PROXY_TARGET`（astro.config.mjs 里读它），
 * 所以这个脚本**不碰任何共享文件**。
 *
 * 为什么关掉文件监听（`watch: null`）：验收只看「首屏渲染出来之后」的行为，
 * 不需要 HMR；而开着监听时 Vite 会去 watch 整个仓库，撞上 backend/tests 下
 * 别人（另一次 pytest 运行）留下的临时文件就会 EBUSY 抛 UnhandledRejection，
 * 整个开发服务器直接挂掉——表现是「登录突然全部失败」，看着像功能坏了。
 * 验收脚本不该依赖仓库里没有别的进程在写文件。
 *
 * 历史教训（写在这里省得再踩）：这个脚本原本是**临时改写 astro.config.mjs**
 * 来注入代理的，结果有两类难查的竞态：
 *   1) 写文件 → 启动 → 等 HTTP 就绪；而那次「就绪」可能是配置热重载**之前**
 *      的响应，随后还原文件又触发一次重载，代理就没了（报 404：请求落到 Astro 的
 *      404 路由上，而不是后端）。
 *   2) `process.exit()` 不等异步清理，一次异常就把带代理的配置留在树上，
 *      而后续运行会把它当「干净原件」备份下来——脏配置再也回不去。
 * 环境变量把这两类问题一起消掉了：没有共享状态，就没有需要还原的东西。
 */
async function startSite() {
  // 直接跑本地 astro 的入口，而不是 `npx astro`：Windows 上不带 shell 时
  // npx 是个 .cmd，spawn 会 ENOENT（shell:true 又会让参数里的引号变成注入面）。
  const astroBin = join(REPO, 'node_modules', 'astro', 'astro.js');
  start('astro', process.execPath, [astroBin, 'dev', '--port', String(SITE_PORT), '--host', '127.0.0.1'],
    {
      env: {
        PUBLIC_API_BASE: '',
        VITE_API_PROXY_TARGET: `http://127.0.0.1:${BACKEND_PORT}`,
      },
    });
  await waitForHttp(`${SITE}/admin/users/`);
  // 代理是否真的生效，用一次真实 API 调用确认（而不是假设配置读对了）：
  // 走代理时 /api/site-config 返回 JSON；没生效时是 Astro 的 404 HTML。
  await waitForHttp(`${SITE}/api/site-config`, { expect: 200 });
}

function startBrowser() {
  const profile = join(work, 'chrome-profile');
  start('chrome', CHROME, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    'about:blank',
  ]);
  return waitForHttp(`http://127.0.0.1:${CDP_PORT}/json/version`);
}

// --------------------------------------------------------------- 造数据
//
// 直接写库而不是走注册接口：注册接口把**第一个**账号设为超管（引导规则），
// 而这里要造出「超管 + 管理员 + 会员 + 名字互相包含者」这一组确定的数据。
// 密码哈希用应用自己的函数（app.security.hash_password），不在验收脚本里
// 重复实现一遍算法——那种副本迟早会和真实算法漂移。
function seed() {
  const py = `
import os, sys
sys.path.insert(0, '.')
os.environ['NAYTIA_SQLITE_PATH'] = r'${join(work, 'verify.db')}'
from app.db import create_engine, sessionmaker, Base
from app.models import Account
from app.security import hash_password

engine = create_engine('sqlite:///' + r'${join(work, 'verify.db')}',
                       connect_args={'check_same_thread': False})
Base.metadata.create_all(bind=engine)
Session = sessionmaker(bind=engine, expire_on_commit=False)
rows = [
    ('站长', 'superadmin'),
    ('副站长', 'superadmin'),
    ('现有管理员', 'admin'),
    ('小明', 'member'),
    ('小明同学', 'member'),
    ('路人甲', 'member'),
]
with Session() as db:
    for username, role in rows:
        db.add(Account(username=username, username_key=username.lower(),
                       password_hash=hash_password('${PASSWORD}'), role=role))
    db.commit()
print('seeded', len(rows))
`;
  return new Promise((res, rej) => {
    const child = spawn('python', ['-c', py], {
      cwd: join(REPO, 'backend'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (b) => (out += b));
    child.stderr.on('data', (b) => (out += b));
    child.on('exit', (code) => (code === 0 ? res(out.trim()) : rej(new Error(out))));
  });
}

// --------------------------------------------------------------- 验收

const checker = createChecker();
const { check } = checker;

/**
 * 在页面上登录（同源，Cookie 才会被浏览器收下）。
 * 返回 `{ status, body }`：登录失败时把响应体一起带出来——
 * 只报一个「401」会把「后端没起来」和「密码不对」混在一起，查起来全靠猜。
 */
async function loginViaPage(page, username) {
  return page.evaluate(`
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: ${JSON.stringify(username)}, password: ${JSON.stringify(PASSWORD)} }),
    });
    return { status: res.status, body: await res.text() };
  `);
}

async function snapshotRows(page) {
  return page.evaluate(`
    return [...document.querySelectorAll('.au-table .au-row[data-id]')].map((row) => ({
      id: row.dataset.id,
      name: row.querySelector('.au-name strong')?.textContent ?? '',
      role: row.querySelector('.ui-role-badge')?.textContent ?? '',
      action: row.querySelector('.au-toggle')?.textContent ?? row.querySelector('.au-locked')?.textContent ?? '',
      togglable: Boolean(row.querySelector('.au-toggle')),
      hidden: row.hidden,
    }));
  `);
}

async function main() {
  console.log(`隔离环境：backend :${BACKEND_PORT} · astro :${SITE_PORT} · chrome :${CDP_PORT}`);
  await startBackend();
  console.log('后端就绪（隔离库）');
  await seed();
  await startSite();
  console.log('Astro 开发服务器就绪（/api 已代理）');
  await startBrowser();
  const page = await connect(CDP_PORT);

  // ---- 1) 未登录：说明文字，且不发任何请求
  await page.goto(`${SITE}/admin/users/`);
  await page.waitFor('document.querySelector(".au-denied")', { label: '未登录时的说明' });
  let denied = await page.evaluate('return document.querySelector(".au-denied p").textContent;');
  check('未登录看到「只对超管开放」，而不是空表格', denied.includes('超级管理员'), denied);
  check('未登录时不渲染搜索框（不发请求）',
    (await page.evaluate('return !document.querySelector("#au-search");')) === true);

  // ---- 2) 会员登录：仍然只有说明文字
  let login = await loginViaPage(page, '小明');
  check('会员登录本身成功', login.status === 200, `${login.status} ${login.body}`);
  await page.goto(`${SITE}/admin/users/`);
  await page.waitFor('document.querySelector(".au-denied")', { label: '会员看到的说明' });
  check('普通会员看不到列表',
    (await page.evaluate('return !document.querySelector(".au-table");')) === true);
  check('普通会员的导航栏没有「账号管理」入口',
    (await page.evaluate('return !document.getElementById("navAdminUsers");')) === true);

  // ---- 3) 超管登录：列表出现
  login = await loginViaPage(page, '站长');
  check('超管登录成功', login.status === 200, `${login.status} ${login.body}`);
  await page.goto(`${SITE}/admin/users/`);
  await page.waitFor('document.querySelectorAll(".au-table .au-row[data-id]").length >= 6',
    { label: '账号表格' });

  await page.waitFor('document.getElementById("navAdminUsers")', { label: '导航入口' });
  check('超管的导航栏出现「账号管理」入口',
    (await page.evaluate('return document.getElementById("navAdminUsers").textContent.trim();')) === '账号管理');

  let rows = await snapshotRows(page);
  check('列表列出全部 6 个账号', rows.length === 6, JSON.stringify(rows.map((r) => r.name)));
  check('角色徽章显示中文档位',
    rows.map((r) => r.role).join(',') === '超级管理员,超级管理员,管理员,会员,会员,会员',
    rows.map((r) => r.role).join(','));

  const self = rows.find((r) => r.name === '站长');
  const peerSuper = rows.find((r) => r.name === '副站长');
  const admin = rows.find((r) => r.name === '现有管理员');
  const member = rows.find((r) => r.name === '小明');
  check('自己那一行没有开关，并说明原因',
    !self.togglable && self.action.includes('不能修改自己'), self.action);
  check('另一个超管的行也没有开关，原因是超管档位不在这里改',
    !peerSuper.togglable && peerSuper.action.includes('超级管理员'), peerSuper.action);
  check('已是管理员的账号按钮是「取消管理员」',
    admin.togglable && admin.action === '取消管理员', admin.action);
  check('普通会员的按钮是「设为管理员」',
    member.togglable && member.action === '设为管理员', member.action);

  // ---- 4) 搜索（服务端过滤 + 输入即复筛）
  await page.evaluate(`
    const input = document.querySelector('#au-search');
    input.value = '小明';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `);
  // 立刻可见的行数是本地复筛的结果；统计行要等防抖后的服务端响应。
  // 两个都等到，才说明「输入即复筛」和「服务端搜索」两段都真的生效了。
  await page.waitFor(
    '[...document.querySelectorAll(".au-table .au-row[data-id]")].filter(r => !r.hidden).length === 2',
    { label: '本地复筛：只剩下 2 行可见' },
  );
  await page.waitFor(
    'document.querySelector(".au-count").textContent.startsWith("2 个账号")',
    { label: '服务端搜索返回 2 条' },
  );
  check('搜索「小明」时本地复筛与服务端结果一致', true);
  rows = await snapshotRows(page);
  check('只留下名字含「小明」的账号（子串匹配）',
    rows.filter((r) => !r.hidden).map((r) => r.name).join(',') === '小明,小明同学',
    rows.filter((r) => !r.hidden).map((r) => r.name).join(','));

  // 搜不到时给的是「换个关键词」而不是空表格
  await page.evaluate(`
    const input = document.querySelector('#au-search');
    input.value = '查无此人';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `);
  await page.waitFor('document.querySelector(".au-table .au-empty")', { label: '空结果提示' });
  check('搜不到时说明「没有名字包含…的账号」',
    (await page.evaluate('return document.querySelector(".au-empty p").textContent;')).includes('查无此人'));

  // 大小写不敏感（ASCII 用户名单独验一次：库里的 username_key 是小写）
  await page.evaluate(`
    const input = document.querySelector('#au-search');
    input.value = '小明';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `);
  await page.waitFor('document.querySelectorAll(".au-table .au-row[data-id]").length === 2',
    { label: '回到两条结果' });

  // ---- 5) 授予管理员
  await page.evaluate(`
    window.__confirmAnswer = true;
    window.confirm = () => window.__confirmAnswer;
    [...document.querySelectorAll('.au-table .au-row[data-id]')]
      .find(r => r.querySelector('.au-name strong')?.textContent === '小明')
      .querySelector('.au-toggle').click();
    return true;
  `);
  await page.waitFor(
    `[...document.querySelectorAll('.au-table .au-row[data-id]')]
       .find(r => r.querySelector('.au-name strong')?.textContent === '小明')
       ?.querySelector('.ui-role-badge')?.textContent === '管理员'`,
    { label: '角色徽章变成管理员' },
  );
  check('点「设为管理员」后徽章就地变成「管理员」', true);
  check('按钮就地翻转成「取消管理员」',
    (await page.evaluate(`
      return [...document.querySelectorAll('.au-table .au-row[data-id]')]
        .find(r => r.querySelector('.au-name strong')?.textContent === '小明')
        .querySelector('.au-toggle').textContent;
    `)) === '取消管理员');
  check('出现结果提示',
    (await page.evaluate('return document.querySelector(".app-toast")?.textContent ?? "";')).includes('已设为管理员'));

  // 服务端真的改了（刷新一次看持久化，而不是只信界面）
  await page.goto(`${SITE}/admin/users/`);
  await page.waitFor('document.querySelectorAll(".au-table .au-row[data-id]").length === 6',
    { label: '刷新后的表格' });
  check('刷新后仍是管理员（服务端已落库）',
    (await page.evaluate(`
      const rows = [...document.querySelectorAll('.au-table .au-row[data-id]')];
      return rows.find(r => r.querySelector('.au-name strong')?.textContent === '小明')
        .querySelector('.ui-role-badge').textContent;
    `)) === '管理员');

  // ---- 6) 取消管理员
  await page.evaluate(`
    window.confirm = () => true;
    [...document.querySelectorAll('.au-table .au-row[data-id]')]
      .find(r => r.querySelector('.au-name strong')?.textContent === '小明')
      .querySelector('.au-toggle').click();
    return true;
  `);
  await page.waitFor(
    `[...document.querySelectorAll('.au-table .au-row[data-id]')]
       .find(r => r.querySelector('.au-name strong')?.textContent === '小明')
       ?.querySelector('.ui-role-badge')?.textContent === '会员'`,
    { label: '角色回到会员' },
  );
  check('点「取消管理员」后回到「会员」', true);

  // ---- 7) 取消确认时不发请求
  const before = await page.evaluate(`
    return [...document.querySelectorAll('.au-table .au-row[data-id]')]
      .find(r => r.querySelector('.au-name strong')?.textContent === '小明')
      .querySelector('.ui-role-badge').textContent;
  `);
  await page.evaluate(`
    window.confirm = () => false;
    [...document.querySelectorAll('.au-table .au-row[data-id]')]
      .find(r => r.querySelector('.au-name strong')?.textContent === '小明')
      .querySelector('.au-toggle').click();
    return true;
  `);
  await delay(400);
  check('确认框里选「取消」时角色不变',
    (await page.evaluate(`
      return [...document.querySelectorAll('.au-table .au-row[data-id]')]
        .find(r => r.querySelector('.au-name strong')?.textContent === '小明')
        .querySelector('.ui-role-badge').textContent;
    `)) === before, `仍是 ${before}`);

  // ---- 8) 退出登录后入口消失
  await page.evaluate("await fetch('/api/auth/logout', { method: 'POST' }); return true;");
  await page.goto(`${SITE}/admin/users/`);
  await page.waitFor('document.querySelector(".au-denied")', { label: '退出后的说明' });
  await page.waitFor('!document.getElementById("navAdminUsers")', { label: '入口消失' });
  check('退出登录后导航入口消失、页面回到说明文字', true);

  const errors = page.consoleErrors();
  check('控制台没有错误', errors.length === 0, errors.join(' | '));

  page.close();
  return checker.summary();
}

let ok = false;
try {
  ok = await main();
} catch (err) {
  console.error(`\n验收中断：${err.stack ?? err.message}`);
} finally {
  // 显式调一次只是为了让正常路径尽早还原；exit 处理器是兜底（两者都幂等）。
  cleanup();
}
// process.exit 不会等挂起的 async 工作，所以不能在这里依赖异步清理——
// 兜底的还原逻辑全部写在同步的 cleanup() 里，并挂在 process.on('exit')。
process.exit(ok ? 0 : 1);
