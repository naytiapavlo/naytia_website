// 论坛附件与 3D 预览的浏览器端到端验证。
//
// 单元测试只能验证纯逻辑（载荷解码、面剔除、投影排序）与后端契约；
// 这一层验证真实浏览器里的完整链路：
//   注册 → 发帖（带 .mcstructure + 封面图）→ 服务端解析 → 材料清单 →
//   3D 渲染 → 封面展示与删除 → 回复。
//
// 用法：
//   cd backend && python -m uvicorn app.main:app --port 8020
//   node tests/manual/serve-dist.mjs 8021 http://127.0.0.1:8020 dist-e2e
//   msedge --headless=new --remote-debugging-port=9224 --user-data-dir=<临时目录> about:blank
//   node tests/manual/e2e-forum.mjs http://localhost:8021 http://127.0.0.1:9224 <小屋夹具> <封面夹具>
//
// 这是一次性验证脚本，不属于项目源码（与同目录其它 e2e-*.mjs 一致）。
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] ?? 'http://localhost:8021';
const DEBUG_URL = process.argv[3] ?? 'http://127.0.0.1:9224';
const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '..', '..');
const FIXTURE = process.argv[4] ?? join(REPO, '.tmp-e2e', 'house.mcstructure');
const COVER = process.argv[5] ?? join(REPO, '.tmp-e2e', 'cover.png');
const SHOTS = join(REPO, '.tmp-e2e', 'shots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`    [OK] ${message}`);
  else {
    failures += 1;
    console.log(`    [FAIL] ${message}`);
  }
}

async function main() {
  rmSync(SHOTS, { recursive: true, force: true });
  mkdirSync(SHOTS, { recursive: true });

  const targets = await (await fetch(`${DEBUG_URL}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('没有可用的页面目标');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('WebSocket 连接失败'));
  });

  let id = 0;
  const pending = new Map();
  const consoleErrors = [];
  const consoleLogs = [];
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(msg.params?.exceptionDetails?.exception?.description ?? '未知异常');
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params?.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
      if (msg.params?.type === 'error') consoleErrors.push(text);
      else consoleLogs.push(text);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      const timer = setTimeout(() => {
        pending.delete(msgId);
        reject(new Error(`CDP 调用超时：${method}`));
      }, 30000);
      pending.set(msgId, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.result?.exceptionDetails) {
      throw new Error(
        `页面脚本异常：${
          res.result.exceptionDetails.exception?.description ?? res.result.exceptionDetails.text
        }`,
      );
    }
    return res.result?.result?.value;
  };

  const waitFor = async (expression, timeout = 12000, step = 250) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        if (await evaluate(expression)) return true;
      } catch {
        /* 页面还在跳转，继续等 */
      }
      await sleep(step);
    }
    return false;
  };

  /**
   * 真正重新加载论坛页。
   *
   * 为什么不能直接 `Page.navigate` 到 `#/new`：同文档的 hash 跳转**不会重新执行页面脚本**，
   * 论坛界面里的状态还是上一次的。要验证「首次加载时的行为」就必须给 URL 加一个
   * 变化的查询串，强制走一次完整加载。这个坑在本脚本里踩过两次，所以做成辅助函数。
   */
  let loadSeq = 0;
  const reloadForum = async (hash = '', settle = 2400) => {
    loadSeq += 1;
    await send('Page.navigate', { url: `${BASE}/forum/?e2e=${loadSeq}${hash}` });
    await sleep(settle);
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('DOM.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });

  // ---------------------------------------------------------------- 1
  console.log('\n[1] 论坛页加载（未登录）');
  await reloadForum('', 2400);
  // 版块来自后端接口，首帧只有「全部」，要等筛选器补齐
  const tabsReady = await waitFor(`document.querySelectorAll('.forum-tab').length >= 5`, 15000);
  const guest = await evaluate(`(() => ({
    hasApp: !!document.querySelector('#forum-app .forum'),
    tabs: [...document.querySelectorAll('.forum-tab')].map(b => b.textContent.trim()),
    composerHint: !!document.querySelector('[data-act="new"]'),
    emptyText: (document.querySelector('.forum-empty')?.textContent ?? '').trim(),
  }))()`);
  assert(guest.hasApp, '论坛外壳已挂载');
  assert(tabsReady, `版块筛选来自后端（${guest.tabs.join(' / ')}）`);
  assert(
    ['机制研究', '作品展示', '问答互助', '站务公告'].every((c) => guest.tabs.includes(c)),
    '四个版块都出现在筛选器里',
  );
  assert(guest.composerHint, '未登录也能看到「发帖」入口（点进去才提示登录）');

  // ---------------------------------------------------------------- 2
  console.log('\n[2] 注册并登录（走站内 API，验证会话被论坛界面识别）');
  const account = await evaluate(`(async () => {
    const name = '结构测试员' + Math.floor(Math.random() * 100000);
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username: name, password: 'secret123' }),
    });
    return { status: res.status, name, body: await res.text() };
  })()`);
  assert(account.status === 201, `注册成功（${account.body.slice(0, 80)}）`);

  // 注册只改了 Cookie，页面上的会话状态还是旧的；走一次真实加载
  await reloadForum('#/new', 2600);
  const composerReady = await waitFor(`!!document.querySelector('[data-part="compose"]')`, 15000);
  const composer = await evaluate(`(() => ({
    hasForm: !!document.querySelector('[data-part="compose"]'),
    categories: [...document.querySelectorAll('#compose-category option')].map(o => o.value),
    hasFileInput: !!document.querySelector('input[type=file][data-part=file]'),
    hasCoverInput: !!document.querySelector('input[type=file][data-part=cover]'),
    coverAccept: document.querySelector('input[type=file][data-part=cover]')?.getAttribute('accept') ?? '',
    uploadWarning: (document.querySelector('.forum-upload-warning')?.textContent ?? '').replace(/\\s+/g,' '),
  }))()`);
  assert(composerReady && composer.hasForm, '登录后发帖表单可用');
  assert(composer.categories.length === 4, `版块下拉有 4 项（${composer.categories.join('/')}）`);
  assert(composer.hasFileInput, '表单里有 .mcstructure 文件输入');
  assert(composer.hasCoverInput, '表单里有封面图片输入');
  assert(
    composer.coverAccept.includes('image/png') && composer.coverAccept.includes('image/webp'),
    `封面输入限定了图片类型（${composer.coverAccept}）`,
  );
  assert(
    composer.uploadWarning.includes('上传到本站服务器'),
    '界面明确说明附件会上传（04 文档第 5 节）',
  );

  // ---------------------------------------------------------------- 3
  console.log('\n[3] 填表 + 选择结构文件与封面 + 提交（multipart）');
  const fixtureBytes = readFileSync(FIXTURE).length;
  const coverBytes = readFileSync(COVER).length;
  await evaluate(`(() => {
    const set = (sel, value) => {
      const el = document.querySelector(sel);
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('#compose-title', '我搭的小木屋（附结构文件与封面）');
    set('#compose-body', '石头地板 + 木板墙，四面各两格玻璃窗。材料清单见下方，欢迎照着搭。');
    const select = document.querySelector('#compose-category');
    select.value = '作品展示';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);

  const doc = await send('DOM.getDocument', { depth: -1 });
  const inputNode = await send('DOM.querySelector', {
    nodeId: doc.result.root.nodeId,
    selector: 'input[type=file][data-part=file]',
  });
  await send('DOM.setFileInputFiles', { nodeId: inputNode.result.nodeId, files: [FIXTURE] });
  const coverNode = await send('DOM.querySelector', {
    nodeId: doc.result.root.nodeId,
    selector: 'input[type=file][data-part=cover]',
  });
  await send('DOM.setFileInputFiles', { nodeId: coverNode.result.nodeId, files: [COVER] });
  await sleep(800);

  const picked = await evaluate(`(() => {
    const preview = document.querySelector('[data-part="cover-preview"]');
    const img = document.querySelector('[data-part="cover-preview-img"]');
    return {
      info: (document.querySelector('[data-part="file-info"]')?.textContent ?? '').replace(/\\s+/g,' '),
      fileHidden: document.querySelector('[data-part="file-info"]')?.hidden ?? true,
      coverPreviewShown: !(preview?.hidden ?? true),
      coverInfo: (document.querySelector('[data-part="cover-info"]')?.textContent ?? '').replace(/\\s+/g,' '),
      coverSrc: (img?.getAttribute('src') ?? '').slice(0, 5),
      hasClearButton: !!document.querySelector('[data-act="clear-cover"]'),
    };
  })()`);
  assert(!picked.fileHidden, '选中结构文件后显示文件信息');
  assert(picked.info.includes('house.mcstructure'), `文件信息含原名（${picked.info.slice(0, 60)}）`);
  assert(picked.coverPreviewShown, '选中封面后显示本地预览');
  assert(picked.coverSrc === 'blob:', `预览用的是本地 objectURL，不需要先上传（${picked.coverSrc}）`);
  assert(picked.coverInfo.includes('cover.png'), `封面信息含原名（${picked.coverInfo.slice(0, 70)}）`);
  assert(picked.coverInfo.includes('768 × 432'), `封面信息给出真实像素（${picked.coverInfo.slice(0, 70)}）`);
  assert(picked.hasClearButton, '提供「移除封面」按钮');

  await evaluate(`document.querySelector('[data-part="submit"]').click()`);
  const landed = await waitFor(`location.hash.startsWith('#/t/')`, 20000);
  assert(landed, '提交后跳转到帖子详情');

  const detail = await waitFor(`!!document.querySelector('.forum-structure')`, 15000);
  assert(detail, '详情里出现结构文件面板');

  // ---------------------------------------------------------------- 3b
  console.log('\n[3b] 封面在详情里的展示');
  const coverShown = await waitFor(`!!document.querySelector('.forum-cover img')`, 10000);
  assert(coverShown, '详情页顶部出现封面');
  const displayed = await evaluate(`(async () => {
    const img = document.querySelector('.forum-cover img');
    if (!img) return null;
    // 等图片真的解码出来（懒加载 + 网络），否则 naturalWidth 是 0
    if (!img.complete || !img.naturalWidth) {
      await new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
        setTimeout(resolve, 4000);
      });
    }
    return {
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      attrWidth: img.getAttribute('width'),
      attrHeight: img.getAttribute('height'),
      alt: img.getAttribute('alt'),
      caption: (document.querySelector('.forum-cover figcaption')?.textContent ?? '').replace(/\\s+/g,' '),
      hasDelete: !!document.querySelector('[data-act="delete-cover"]'),
    };
  })()`);
  assert(displayed.naturalWidth === 768 && displayed.naturalHeight === 432,
    `封面真的渲染出来了（${displayed.naturalWidth}×${displayed.naturalHeight}）`);
  assert(displayed.attrWidth === '768' && displayed.attrHeight === '432',
    '宽高写进了 img 属性，加载前就留好了位置（避免页面跳动）');
  assert(displayed.alt.includes('封面'), `有替代文本（${displayed.alt}）`);
  assert(displayed.caption.includes('cover.png'), `说明文字含文件名（${displayed.caption.slice(0, 80)}）`);
  assert(displayed.caption.includes('PNG'), '说明文字给出识别出的格式');
  assert(displayed.caption.includes('16:9'), `说明文字给出比例（${displayed.caption.slice(0, 80)}）`);
  assert(displayed.hasDelete, '作者能看到「删除封面」入口');

  // ---------------------------------------------------------------- 4
  console.log('\n[4] 材料清单');
  const materials = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.forum-table tbody tr')].map(tr => ({
      name: tr.children[1]?.textContent.trim(),
      states: tr.children[2]?.textContent.trim(),
      count: tr.children[3]?.textContent.trim(),
      ratio: tr.children[4]?.textContent.trim(),
      swatch: tr.querySelector('.forum-swatch')?.style.background ?? '',
    }));
    return {
      rows,
      foot: [...document.querySelectorAll('.forum-table tfoot td')].map(td => td.textContent.trim()),
      head: (document.querySelector('.forum-materials-head')?.innerText ?? '').replace(/\\s+/g,' '),
      facts: [...document.querySelectorAll('.forum-fact')].map(d => [
        d.querySelector('dt')?.textContent.trim(), d.querySelector('dd')?.textContent.trim(),
      ]),
      warnings: [...document.querySelectorAll('.forum-notes li')].map(li => li.textContent.trim()),
    };
  })()`);
  assert(materials.rows.length === 3, `材料清单列出 3 种方块（实际 ${materials.rows.length}）`);
  const byName = Object.fromEntries(materials.rows.map((r) => [r.name, r.count]));
  assert(byName['oak_planks'] === '113', `木板数量 113（实际 ${byName['oak_planks']}）`);
  assert(byName['stone'] === '49', `石头数量 49（实际 ${byName['stone']}）`);
  assert(byName['glass'] === '8', `玻璃数量 8（实际 ${byName['glass']}）`);
  assert(
    materials.rows[0].name === 'oak_planks',
    `按数量降序（第一行是 ${materials.rows[0].name}）`,
  );
  assert(
    materials.rows.every((r) => r.swatch.startsWith('rgb(')),
    '每行都有示意色块',
  );
  assert(
    !materials.rows.some((r) => r.name === 'air'),
    '空气没有被列进材料清单',
  );
  assert(materials.foot.some((t) => t.includes('3 种')), `合计行给出种类数（${materials.foot.join(' | ')}）`);
  assert(materials.facts.some(([k, v]) => k === '尺寸' && v === '7 × 5 × 7'), '结构尺寸显示 7 × 5 × 7');
  assert(
    materials.facts.some(([k]) => k === '世界原点'),
    '世界原点显示出来（夹具里是 0 / 64 / 0）',
  );
  assert(
    materials.warnings.some((w) => w.includes('空气')),
    `如实说明剔除了空气（${materials.warnings.length} 条提示）`,
  );

  // ---------------------------------------------------------------- 5
  console.log('\n[5] 3D 预览');
  const canvasReady = await waitFor(`!!document.querySelector('.voxel-canvas')`, 15000);
  assert(canvasReady, 'canvas 已挂载');
  await sleep(1200);

  const readCanvas = () => evaluate(`(() => {
    const canvas = document.querySelector('.voxel-canvas');
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const colors = new Map();
    let painted = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 8) continue;
      painted += 1;
      const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      colors.set(key, (colors.get(key) ?? 0) + 1);
    }
    const list = [...colors.entries()].sort((a, b) => b[1] - a[1]);
    const rgb = ([k]) => [(k >> 16) & 255, (k >> 8) & 255, k & 255];
    return {
      width: canvas.width,
      height: canvas.height,
      painted,
      distinct: colors.size,
      top: list.slice(0, 3).map((e) => [...rgb(e), e[1]]),
      // 三种材质的主色都要出现：木板偏棕（r>g>b）、石头偏灰（三分量接近）、
      // 玻璃偏浅蓝（b>r）。允许明暗系数把颜色压暗，所以只比相对关系。
      hasWood: list.some((e) => { const [r,g,b] = rgb(e); return r > g + 20 && g > b + 20; }),
      hasStone: list.some((e) => { const [r,g,b] = rgb(e); return Math.abs(r-g) < 10 && Math.abs(g-b) < 10 && r > 80 && r < 220; }),
      hasGlass: list.some((e) => { const [r,g,b] = rgb(e); return b > r + 20 && b > 150; }),
    };
  })()`);

  const first = await readCanvas();
  assert(first !== null, 'canvas 可以读取像素');
  assert(first.painted > 5000, `画布上确实画了东西（${first.painted} 个不透明像素）`);
  assert(first.distinct >= 6, `有明暗层次而不是纯色块（${first.distinct} 种颜色）`);
  assert(first.hasWood, `木板的示意色已绘出（前几名：${JSON.stringify(first.top)}）`);
  assert(first.hasStone, '石头的示意色已绘出');
  assert(first.hasGlass, '玻璃的示意色已绘出');

  // 分层滑块：切到一半高度，画面必须变（否则说明遮挡没有重算）
  const layerInfo = await evaluate(`(() => {
    const input = document.querySelector('[data-part="layer"]');
    if (!input) return null;
    const before = document.querySelector('[data-part="stats"]').textContent;
    input.value = '3';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return { before, max: input.max };
  })()`);
  assert(layerInfo !== null && layerInfo.max === '5', `分层滑块上限等于结构高度（${layerInfo?.max}）`);
  await sleep(900);
  const afterLayer = await readCanvas();
  const layerStats = await evaluate(
    `(document.querySelector('[data-part="stats"]')?.textContent ?? '')`,
  );
  assert(
    layerStats.includes('只显示 y < 3'),
    `分层状态如实显示（${layerStats.slice(0, 90)}）`,
  );
  assert(
    afterLayer.painted !== first.painted,
    `切到 3 层后画面变化（${first.painted} → ${afterLayer.painted} 像素）`,
  );

  // 旋转：拖动一下，遮挡顺序应当重算
  await evaluate(`(() => {
    const input = document.querySelector('[data-part="layer"]');
    input.value = input.max;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(600);
  const beforeRotate = await readCanvas();
  // 画布要**先滚进视口**再算坐标：详情页加了封面之后，预览被推到屏幕外面去了，
  // 而 Input.dispatchMouseEvent 用的是视口坐标——按页面坐标发事件会打空
  // （实测症状就是「拖动之后画面一点没变」，看起来像渲染器坏了）。
  const box = await evaluate(`(() => {
    const canvas = document.querySelector('.voxel-canvas');
    canvas.scrollIntoView({ block: 'center' });
    const r = canvas.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: r.width, h: r.height };
  })()`);
  await sleep(400);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + 160, y: box.y - 60, button: 'left' });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x + 160, y: box.y - 60, button: 'left', clickCount: 1 });
  await sleep(900);
  const afterRotate = await readCanvas();
  assert(
    afterRotate.painted !== beforeRotate.painted,
    `拖动旋转后画面变化（${beforeRotate.painted} → ${afterRotate.painted} 像素）`,
  );

  const stats = await evaluate(`(document.querySelector('[data-part="stats"]')?.textContent ?? '')`);
  assert(stats.includes('170 个可见方块'), `统计显示可见方块数（${stats.slice(0, 90)}）`);
  assert(stats.includes('7 × 5 × 7'), '统计显示结构尺寸');

  // ---------------------------------------------------------------- 6
  console.log('\n[6] 下载附件 + 回复');
  const dl = await evaluate(`(() => {
    const link = document.querySelector('.forum-structure-head a[href*="/structure/file"]');
    return link ? link.getAttribute('href') : null;
  })()`);
  assert(dl !== null, `结构面板提供下载链接（${dl}）`);
  const downloaded = await evaluate(`(async () => {
    const res = await fetch(${JSON.stringify(dl)}, { credentials: 'include' });
    const buf = new Uint8Array(await res.arrayBuffer());
    return {
      status: res.status,
      length: buf.length,
      disposition: res.headers.get('content-disposition'),
      nosniff: res.headers.get('x-content-type-options'),
      firstBytes: [...buf.slice(0, 4)],
    };
  })()`);
  assert(downloaded.status === 200 && downloaded.length === fixtureBytes, `下载字节数与上传一致（${downloaded.length}）`);
  assert(downloaded.nosniff === 'nosniff', '下载响应带 nosniff');
  assert(
    (downloaded.disposition ?? '').includes('attachment'),
    `下载响应是附件（${downloaded.disposition}）`,
  );

  await evaluate(`(() => {
    const box = document.querySelector('#reply-body');
    box.value = '这个结构真不错，已经照着搭了一个。';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('[data-part="reply-form"]').requestSubmit();
    return true;
  })()`);
  const replied = await waitFor(
    `[...document.querySelectorAll('.forum-reply')].some(r => r.textContent.includes('照着搭了一个'))`,
    12000,
  );
  assert(replied, '回复发表后立刻出现在页面上');

  // ---------------------------------------------------------------- 7
  console.log('\n[7] 回到列表：封面缩略图与结构徽标');
  await evaluate(`document.querySelector('[data-act="back"]').click()`);
  await sleep(2000);
  const list = await evaluate(`(() => ({
    cards: [...document.querySelectorAll('.forum-card')].map(c => ({
      title: c.querySelector('h2')?.textContent.trim(),
      badges: [...c.querySelectorAll('.forum-badge')].map(b => b.textContent.trim()),
      category: c.querySelector('.forum-cat')?.textContent.trim() ?? '',
      meta: (c.querySelector('.forum-card-meta')?.textContent ?? '').replace(/\\s+/g,' ').trim(),
      hasThumb: !!c.querySelector('.forum-card-thumb img'),
      thumbSrc: c.querySelector('.forum-card-thumb img')?.getAttribute('src') ?? '',
      thumbLazy: c.querySelector('.forum-card-thumb img')?.getAttribute('loading') ?? '',
      isGrid: getComputedStyle(c).display === 'grid',
    })),
  }))()`);
  assert(list.cards.length >= 1, `列表里有 ${list.cards.length} 个帖子`);
  const withCover = list.cards.find((c) => c.hasThumb);
  assert(!!withCover, '带封面的帖子在列表里显示缩略图');
  assert(withCover.thumbSrc.includes('/cover'), `缩略图指向封面接口（${withCover.thumbSrc.slice(0, 60)}）`);
  assert(withCover.thumbLazy === 'lazy', '缩略图用原生懒加载，不阻塞首屏');
  assert(withCover.isGrid, '有封面的卡片切换成横向布局');
  assert(
    withCover.badges.includes('封面') && withCover.badges.includes('结构文件'),
    `两个徽标都在（${withCover.badges.join('/')}）`,
  );
  assert(
    list.cards.some((c) => c.category === '作品展示' && c.meta.includes('1 条回复')),
    `卡片显示版块与回复数（${withCover.meta}）`,
  );

  // 缩略图真的能加载出来（服务端返回的 Content-Type 必须是浏览器认的图片类型）
  const thumbLoaded = await evaluate(`(async () => {
    const img = document.querySelector('.forum-card-thumb img');
    if (!img) return null;
    if (!img.complete || !img.naturalWidth) {
      await new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
        setTimeout(resolve, 4000);
      });
    }
    const res = await fetch(img.src, { credentials: 'include' });
    return {
      naturalWidth: img.naturalWidth,
      status: res.status,
      contentType: res.headers.get('content-type'),
      nosniff: res.headers.get('x-content-type-options'),
      csp: res.headers.get('content-security-policy') ?? '',
    };
  })()`);
  assert(thumbLoaded.naturalWidth === 768, `缩略图真的解码出来了（宽 ${thumbLoaded.naturalWidth}）`);
  assert(thumbLoaded.contentType === 'image/png',
    `封面按识别出的类型返回（${thumbLoaded.contentType}）`);
  assert(thumbLoaded.nosniff === 'nosniff', '封面响应带 nosniff');
  assert(thumbLoaded.csp.includes("default-src 'none'"),
    `封面响应带 CSP，直接打开也只是一张图（${thumbLoaded.csp}）`);

  const filtered = await evaluate(`(async () => {
    const tab = [...document.querySelectorAll('.forum-tab')].find(b => b.textContent.trim() === '机制研究');
    tab.click();
    await new Promise(r => setTimeout(r, 1500));
    // 重绘之后旧节点会被替换，必须重新查一次当前激活的页签
    const active = [...document.querySelectorAll('.forum-tab')].find(b => b.classList.contains('is-active'));
    return {
      empty: (document.querySelector('.forum-empty')?.textContent ?? '').trim(),
      cards: document.querySelectorAll('.forum-card').length,
      active: active?.textContent.trim() ?? '',
    };
  })()`);
  assert(filtered.active === '机制研究' && filtered.cards === 0, `版块筛选生效（${filtered.empty}）`);

  // ---------------------------------------------------------------- 8
  console.log('\n[8] 刷新后仍然一致（详情与预览都可复现）');
  const threadHash = await evaluate(`(() => {
    const a = document.querySelector('.forum-card');
    return a ? a.getAttribute('href') : null;
  })()`);
  await evaluate(`(() => {
    const tab = [...document.querySelectorAll('.forum-tab')].find(b => b.textContent.trim() === '全部');
    tab.click();
    return true;
  })()`);
  await sleep(1200);
  const href = await evaluate(`document.querySelector('.forum-card')?.getAttribute('href') ?? null`);
  // 真正的整页刷新（不是 hash 跳转），验证材料清单、预览、回复都可复现
  const reopened = await evaluate(`document.querySelector('.forum-card')?.getAttribute('href') ?? null`);
  await reloadForum(reopened ?? threadHash ?? '', 2800);
  const reloaded = await evaluate(`(() => ({
    title: document.querySelector('.forum-thread h1')?.textContent.trim() ?? '',
    rows: document.querySelectorAll('.forum-table tbody tr').length,
    canvas: !!document.querySelector('.voxel-canvas'),
    replies: document.querySelectorAll('.forum-reply').length,
  }))()`);
  assert(reloaded.title.includes('小木屋'), `刷新后标题正确（${reloaded.title}）`);
  assert(reloaded.rows === 3, `刷新后材料清单仍是 3 行（实际 ${reloaded.rows}）`);
  assert(reloaded.canvas, '刷新后 3D 预览仍然挂载');
  assert(reloaded.replies === 1, `刷新后回复数正确（${reloaded.replies}）`);
  assert(
    (await evaluate(`!!document.querySelector('.forum-cover img')`)),
    '刷新后封面仍在',
  );

  // ---------------------------------------------------------------- 8b
  console.log('\n[8b] 删除封面：帖子其余部分不受影响');
  await evaluate(`window.confirm = () => true`);
  await evaluate(`document.querySelector('[data-act="delete-cover"]').click()`);
  const coverGone = await waitFor(`!document.querySelector('.forum-cover img')`, 12000);
  assert(coverGone, '删除后封面从详情页消失');
  const afterCoverDelete = await evaluate(`(() => ({
    title: document.querySelector('.forum-thread h1')?.textContent.trim() ?? '',
    rows: document.querySelectorAll('.forum-table tbody tr').length,
    canvas: !!document.querySelector('.voxel-canvas'),
    coverStillServed: null,
  }))()`);
  assert(afterCoverDelete.title.includes('小木屋'), '帖子正文还在');
  assert(afterCoverDelete.rows === 3, '材料清单不受影响');
  assert(afterCoverDelete.canvas, '3D 预览不受影响');

  const coverStatus = await evaluate(`(async () => {
    const res = await fetch('/api/forum/threads/1/cover', { credentials: 'include' });
    return res.status;
  })()`);
  assert(coverStatus === 404, `删除后封面接口返回 404（实际 ${coverStatus}）`);

  // ---------------------------------------------------------------- 9
  console.log('\n[9] 版块接口不可用时的降级（回归：不能给一个空下拉框）');
  //
  // 真实故障复现：后端还在跑旧版本时 /api/forum/categories 返回 404，
  // 而 /api/forum/threads 存在（帖子照常能看）。此时如果发帖表单照常渲染，
  // 用户拿到的是一个**空的下拉框**——点开没得选、交不上去、也看不到原因。
  // 这里用注入的 fetch 包装把这个接口打成 404，验证界面明确报错而不是装死。
  const stub = await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const original = window.fetch;
      window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.includes('/api/forum/categories')) {
          return Promise.resolve(new Response(
            JSON.stringify({ detail: { code: 'not_found', message: 'Not Found' } }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          ));
        }
        return original.apply(this, arguments);
      };
    })();`,
  });
  await reloadForum('#/new', 2600);

  const degraded = await evaluate(`(() => {
    const select = document.querySelector('#compose-category');
    const alertText = (document.querySelector('.forum-alert')?.innerText ?? '').replace(/\\s+/g, ' ');
    return {
      options: select ? select.options.length : -1,
      hasRetry: !!document.querySelector('[data-act="retry-categories"]'),
      hasSubmit: !!document.querySelector('[data-part="submit"]'),
      alertText,
    };
  })()`);
  assert(degraded.options === -1, '不渲染空的下拉框，直接不给出表单');
  assert(!degraded.hasSubmit, '也不给一个交不上去的发布按钮');
  assert(degraded.hasRetry, '提供「重试加载版块」按钮');
  assert(
    degraded.alertText.includes('版块列表没能加载'),
    `明确说明发不了帖的原因（${degraded.alertText.slice(0, 70)}）`,
  );
  assert(
    degraded.alertText.includes('旧版本'),
    '对 404 给出可操作的提示（后端可能还在跑旧版本）',
  );

  // 列表页也要能看到这件事，而不是只显示一个「全部」页签
  await reloadForum('', 2400);
  const listDegraded = await evaluate(`(() => ({
    cards: document.querySelectorAll('.forum-card').length,
    hasRetry: !!document.querySelector('[data-act="retry-categories"]'),
  }))()`);
  assert(listDegraded.cards >= 1, `版块挂了帖子列表照样能用（${listDegraded.cards} 个帖子）`);
  assert(listDegraded.hasRetry, '列表页同样提示并给出重试入口');

  // 去掉包装后重新加载，应当恢复
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: stub.result.identifier });
  await reloadForum('#/new', 2800);
  const recovered = await evaluate(`(() => ({
    options: [...document.querySelectorAll('#compose-category option')].map(o => o.value),
    hasSubmit: !!document.querySelector('[data-part="submit"]'),
  }))()`);
  assert(recovered.options.length === 4, `接口恢复后版块下拉正常（${recovered.options.join('/')}）`);
  assert(recovered.hasSubmit, '发帖按钮回来了');

  // ---------------------------------------------------------------- 10
  console.log('\n[10] 控制台没有报错');
  const realErrors = consoleErrors.filter((e) => !/favicon/i.test(e));
  assert(realErrors.length === 0, `页面无 JS 异常（${realErrors.slice(0, 3).join(' | ') || '无'}）`);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(SHOTS, 'forum-detail.png'), Buffer.from(shot.result.data, 'base64'));
  console.log(`\n    截图：${join(SHOTS, 'forum-detail.png')}`);

  ws.close();
  console.log(`\n结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('\n脚本自身出错：', error);
  process.exit(2);
});
