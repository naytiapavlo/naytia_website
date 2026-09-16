// 作品页动态部分的手动验证（封面滚动 / 时间轴 / 灯箱 / 响应式 / 降低动效）。
// 依赖无头 Edge 以 --remote-debugging-port=9222 启动，口径见 tests/README.md。
//
// 用法：node tests/manual/e2e-works-showcase.mjs [base] [shotDir]
//   base     默认 http://127.0.0.1:4400（npm run preview 的产物地址）
//   shotDir  默认当前目录，截图写这里
const BASE = process.argv[2] ?? 'http://127.0.0.1:4400';
const SHOTS = process.argv[3] ?? '.';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = await import('node:fs');

// 自己开一个空白标签页再连：无头 Edge 的默认 page target 可能被别的验证脚本共用，
// 共用时对方的跳转会打断本脚本的断言（独立 target 互不干扰）。
const created = await fetch('http://127.0.0.1:9222/json/new?about:blank', { method: 'PUT' });
const page = await created.json();
if (!page?.webSocketDebuggerUrl) throw new Error('无法新建 CDP target');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res) => (ws.onopen = res));

let id = 0;
const pending = new Map();
const errors = [];
const failedRequests = [];
const requestUrls = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  }
  if (m.method === 'Network.requestWillBeSent') requestUrls.set(m.params.requestId, m.params.request.url);
  if (m.method === 'Network.loadingFailed') {
    failedRequests.push(`${m.params.errorText} ${requestUrls.get(m.params.requestId) ?? '(未知请求)'}`);
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
  if (r.result?.exceptionDetails) return { ERR: r.result.exceptionDetails.exception?.description };
  return r.result?.result?.value;
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(r.result.data, 'base64'));
};
const mouse = (type, x, y, button = 'none') =>
  send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button,
    buttons: button === 'left' ? 1 : 0,
    clickCount: type === 'mouseMoved' ? 0 : 1,
  });
const click = async (x, y) => {
  await mouse('mouseMoved', x, y);
  await mouse('mousePressed', x, y, 'left');
  await mouse('mouseReleased', x, y, 'left');
};
const key = (type, keyName, code, windowsVirtualKeyCode) =>
  send('Input.dispatchKeyEvent', { type, key: keyName, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode });

const out = { base: BASE };

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

const load = async (url) => {
  await send('Page.navigate', { url });
  for (let i = 0; i < 40; i += 1) {
    await sleep(250);
    const ready = await ev(`document.readyState === 'complete' && !!document.querySelector('.wk-card')`);
    if (ready === true) break;
  }
  await sleep(400);
};

/* ---------- 1. 封面滚动 ---------- */
await load(`${BASE}/works/`);
out.structure = await ev(`(() => {
  const cards = document.querySelectorAll('.wk-card:not(.is-clone)');
  const clones = document.querySelectorAll('.wk-card.is-clone');
  const rows = [...document.querySelectorAll('.wk-row')];
  const groups = [...document.querySelectorAll('.wk-group')];
  return {
    interactiveCards: cards.length,
    cloneCards: clones.length,
    selectableCards: document.querySelectorAll('[data-image]').length,
    rows: rows.length,
    groups: groups.length,
    rowWidth: rows.map((r) => Math.round(r.getBoundingClientRect().width)),
    groupWidths: groups.map((g) => Math.round(g.getBoundingClientRect().width)),
    trackWidths: [...document.querySelectorAll('.wk-track')].map((t) => Math.round(t.getBoundingClientRect().width)),
    imagesLoaded: [...document.querySelectorAll('.wk-card img')].filter((i) => i.naturalWidth > 0).length,
    timelineItems: document.querySelectorAll('[data-timeline-item]').length,
    achievements: document.querySelectorAll('.wk-work').length,
    // 作品档案区块已按要求移除：DOM 里不应再出现
    archiveSection: document.querySelectorAll('.wk-archive').length,
    archiveGrid: document.querySelectorAll('.work-grid').length,
    // 成果清单应为纯文本：没有标签胶囊、没有跳转链接
    achievementChips: document.querySelectorAll('.wk-work-tags, .wk-work-tag').length,
    achievementLinks: document.querySelectorAll('.wk-work a').length,
  };
})()`);
// 无缝循环的前提：两份分组等宽，轨道宽 = 2 × 分组宽
out.seamless = await ev(`(() => {
  const groups = [...document.querySelectorAll('.wk-group')];
  const [a, b] = groups;
  const track = document.querySelector('.wk-track');
  return {
    groupWidthEqual: Math.abs(a.getBoundingClientRect().width - b.getBoundingClientRect().width) < 0.5,
    trackIsDouble: Math.abs(track.getBoundingClientRect().width - 2 * a.getBoundingClientRect().width) < 0.5,
  };
})()`);

const transforms = async () =>
  ev(`[...document.querySelectorAll('.wk-track')].map((t) => new DOMMatrixReadOnly(getComputedStyle(t).transform).m41)`);
const before = await transforms();
await sleep(900);
const after = await transforms();
out.scrolling = {
  before,
  after,
  // 只有一行，向左滚动（x 变小）
  tracks: before.length,
  rowMovesLeft: after[0] < before[0] - 1,
  animation: await ev(`(() => {
    const t = getComputedStyle(document.querySelector('.wk-track'));
    return { name: t.animationName, duration: t.animationDuration, timing: t.animationTimingFunction, playState: t.animationPlayState };
  })()`),
};
await shot('20-works-top');

// 悬停暂停（真实鼠标移动才会触发 :hover）
const rowBox = await ev(`(() => { const r = document.querySelector('.wk-row').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
await mouse('mouseMoved', rowBox.x, rowBox.y);
await sleep(250);
out.hoverPaused = await ev(`[...document.querySelectorAll('.wk-track')].map((t) => getComputedStyle(t).animationPlayState)`);
// 悬停暂停后再量卡片，此时卡片不再移动，能量准 hover 状态
const cardBox = await ev(`(() => {
  const c = document.querySelector('.wk-card:not(.is-clone)');
  const r = c.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + 26 };
})()`);
await mouse('mouseMoved', cardBox.x, cardBox.y);
await sleep(300);
out.cardHover = await ev(`(() => {
  const c = document.querySelector('.wk-card:not(.is-clone)');
  const s = getComputedStyle(c);
  return {
    hovered: c.matches(':hover'),
    transform: s.transform,
    borderColor: s.borderColor,
    titleColor: getComputedStyle(c.querySelector('b')).color,
  };
})()`);
await mouse('mouseMoved', 10, 10);
await sleep(200);
out.afterHoverLeave = await ev(`getComputedStyle(document.querySelector('.wk-track')).animationPlayState`);

/* ---------- 2. 时间轴 ---------- */
out.timelineBeforeScroll = await ev(`(() => ({
  visible: document.querySelectorAll('[data-timeline-item].wk-visible').length,
  fillHeight: document.querySelector('[data-timeline-fill]').getBoundingClientRect().height,
  active: document.querySelectorAll('[data-timeline-item].wk-active').length,
}))()`);

await ev(`document.querySelector('[data-timeline]').scrollIntoView({ block: 'center' })`);
await sleep(700);
await shot('21-works-timeline-first');

await ev(`document.querySelectorAll('[data-timeline-item]')[2].scrollIntoView({ block: 'center' })`);
await sleep(900);
out.timelineAfterScroll = await ev(`(() => {
  const wrap = document.querySelector('[data-timeline]');
  const items = [...document.querySelectorAll('[data-timeline-item]')];
  const fill = document.querySelector('[data-timeline-fill]');
  return {
    visible: items.filter((i) => i.classList.contains('wk-visible')).length,
    total: items.length,
    fillPercent: Math.round((fill.getBoundingClientRect().height / wrap.getBoundingClientRect().height) * 100),
    activeIndex: items.findIndex((i) => i.classList.contains('wk-active')),
    activeOpacity: getComputedStyle(items[2]).opacity,
    opacity: items.map((i) => getComputedStyle(i).opacity),
  };
})()`);
await shot('22-works-timeline-last');

// 回到顶部后再滚到底：进度线应该回退（不是只增不减）
await ev(`window.scrollTo(0, 0)`);
await sleep(600);
out.timelineReset = await ev(`(() => {
  const wrap = document.querySelector('[data-timeline]');
  const fill = document.querySelector('[data-timeline-fill]');
  return { fillPercent: Math.round((fill.getBoundingClientRect().height / wrap.getBoundingClientRect().height) * 100) };
})()`);

/* ---------- 3. 灯箱 ---------- */
out.lightboxClosed = await ev(`document.querySelector('[data-lightbox]').open`);
await ev(`document.querySelector('.wk-card:not(.is-clone)').click()`);
await sleep(400);
out.lightboxOpen = await ev(`(() => {
  const d = document.querySelector('[data-lightbox]');
  return {
    open: d.open,
    modal: d.matches(':modal'),
    image: d.querySelector('[data-lightbox-image]').getAttribute('src'),
    imageLoaded: d.querySelector('[data-lightbox-image]').naturalWidth > 0,
    title: d.querySelector('[data-lightbox-title]').textContent,
    caption: d.querySelector('[data-lightbox-caption]').textContent,
    counter: d.querySelector('[data-lightbox-counter]').textContent,
    linkHidden: d.querySelector('[data-lightbox-link]').hidden,
    scrollLocked: getComputedStyle(document.documentElement).overflow,
  };
})()`);
await shot('23-works-lightbox');

await key('keyDown', 'ArrowRight', 'ArrowRight', 39);
await key('keyUp', 'ArrowRight', 'ArrowRight', 39);
await sleep(300);
out.lightboxAfterArrow = await ev(`(() => {
  const d = document.querySelector('[data-lightbox]');
  return {
    counter: d.querySelector('[data-lightbox-counter]').textContent,
    image: d.querySelector('[data-lightbox-image]').getAttribute('src'),
    title: d.querySelector('[data-lightbox-title]').textContent,
  };
})()`);

// 倒数第五张（箱子纠缠）应当出现 B 站链接
await ev(`document.querySelector('[data-lightbox-prev]').click()`);
await sleep(200);
await ev(`document.querySelector('[data-lightbox-prev]').click()`);
await sleep(300);
out.lightboxLink = await ev(`(() => {
  const l = document.querySelector('[data-lightbox-link]');
  return { hidden: l.hidden, href: l.getAttribute('href'), counter: document.querySelector('[data-lightbox-counter]').textContent };
})()`);

await key('keyDown', 'Escape', 'Escape', 27);
await key('keyUp', 'Escape', 'Escape', 27);
await sleep(400);
out.lightboxAfterEscape = await ev(`(() => ({
  open: document.querySelector('[data-lightbox]').open,
  scrollLocked: getComputedStyle(document.documentElement).overflow,
  focusOnCard: document.activeElement?.classList.contains('wk-card') ?? false,
}))()`);

// 点击遮罩关闭（真实鼠标按下抬起，坐标在对话框之外）
await ev(`document.querySelector('.wk-card:not(.is-clone)').click()`);
await sleep(300);
await click(12, 12);
await sleep(300);
out.lightboxAfterBackdropClick = await ev(`document.querySelector('[data-lightbox]').open`);

/* ---------- 4. 键盘可达：Tab 能落到封面按钮 ---------- */
out.keyboard = await ev(`(() => {
  const card = document.querySelector('.wk-card:not(.is-clone)');
  card.focus();
  return { focusable: document.activeElement === card, ariaLabel: card.getAttribute('aria-label') };
})()`);

/* ---------- 5. 降低动效 ---------- */
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
await load(`${BASE}/works/`);
out.reducedMotion = await ev(`(() => {
  const t = getComputedStyle(document.querySelector('.wk-track'));
  const row = getComputedStyle(document.querySelector('.wk-row'));
  const items = [...document.querySelectorAll('[data-timeline-item]')];
  return {
    animationName: t.animationName,
    rowOverflowX: row.overflowX,
    itemOpacity: items.map((i) => getComputedStyle(i).opacity),
    transitions: getComputedStyle(items[0]).transitionDuration,
  };
})()`);
await shot('24-works-reduced-motion');
await send('Emulation.setEmulatedMedia', { features: [] });

/* ---------- 6. 移动端 ---------- */
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await load(`${BASE}/works/`);
out.mobile = await ev(`(() => ({
  scrollWidth: document.documentElement.scrollWidth,
  innerWidth: window.innerWidth,
  noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth + 1,
  cardWidth: Math.round(document.querySelector('.wk-card').getBoundingClientRect().width),
  headingHintHidden: getComputedStyle(document.querySelector('.wk-heading .hint')).display,
}))()`);
// 超出视口的元素点名（判断横向溢出是不是本次新增板块造成的）
out.mobileOverflowCulprits = await ev(`(() => {
  const limit = document.documentElement.clientWidth;
  return [...document.querySelectorAll('body *')]
    .filter((el) => el.getBoundingClientRect().right > limit + 1 && getComputedStyle(el).position !== 'fixed')
    .slice(0, 12)
    .map((el) => ({ tag: el.tagName.toLowerCase(), cls: el.className.toString().slice(0, 40), right: Math.round(el.getBoundingClientRect().right) }));
})()`);
// 对照：同一视口下的其它页面，用来区分「本次新增」与「原本就有」
await send('Page.navigate', { url: `${BASE}/tools/` });
await sleep(1200);
out.mobileOtherPage = await ev(`({ page: location.pathname, scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth })`);
// 页头在两页之间应当一致（确认新增样式没有影响公共外壳）
const headerProbe = `(() => {
  const h = document.querySelector('header');
  return { page: location.pathname, headerHeight: Math.round(h.getBoundingClientRect().height), headerTop: Math.round(h.getBoundingClientRect().top), navDisplay: getComputedStyle(document.querySelector('.nav-links')).display, scrollY: Math.round(window.scrollY) };
})()`;
out.mobileHeaderOther = await ev(headerProbe);
await load(`${BASE}/works/`);
out.mobileAfterReload = await ev(`({ scrollY: Math.round(window.scrollY), innerWidth: window.innerWidth })`);
out.mobileHeaderWorks = await ev(headerProbe);
await ev(`document.querySelector('[data-timeline]').scrollIntoView({ block: 'start' })`);
await sleep(600);
await shot('25-works-mobile-timeline');
await ev(`window.scrollTo(0, 0)`);
await sleep(400);
await shot('26-works-mobile-top');
await ev(`document.querySelector('.wk-card:not(.is-clone)').click()`);
await sleep(400);
await shot('27-works-mobile-lightbox');
out.mobileLightbox = await ev(`(() => {
  const d = document.querySelector('[data-lightbox]');
  const r = d.getBoundingClientRect();
  return { open: d.open, width: Math.round(r.width), left: Math.round(r.left), fitsViewport: r.left >= -1 && r.right <= window.innerWidth + 1 };
})()`);
await ev(`document.querySelector('[data-lightbox-close]').click()`);
await sleep(200);

/* ---------- 7. 滚到页面底部：进度线应当走到底、最后一个节点高亮 ---------- */
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await load(`${BASE}/works/`);
await ev(`scrollTo(0, document.body.scrollHeight)`);
await sleep(900);
out.timelineAtPageBottom = await ev(`(() => {
  const wrap = document.querySelector('[data-timeline]');
  const rail = document.querySelector('[data-timeline-rail]');
  const fill = document.querySelector('[data-timeline-fill]');
  const items = [...document.querySelectorAll('[data-timeline-item]')];
  const lastDot = items[items.length - 1].querySelector('.wk-dot').getBoundingClientRect();
  const fillRect = fill.getBoundingClientRect();
  return {
    fillPercentOfRail: Math.round((fillRect.height / rail.getBoundingClientRect().height) * 100),
    // 线应当画到最后一个节点的圆点中心
    fillReachesLastDot: fillRect.bottom >= lastDot.top + lastDot.height / 2 - 1,
    activeIndex: items.findIndex((i) => i.classList.contains('wk-active')),
    visibleItems: items.filter((i) => i.classList.contains('wk-visible')).length,
  };
})()`);

/* ---------- 8. 全页截图（桌面） ---------- */
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 2400, deviceScaleFactor: 1, mobile: false });
await load(`${BASE}/works/`);
await ev(`scrollTo(0, 0)`);
await sleep(500);
await shot('28-works-full-top');
await ev(`scrollTo(0, document.body.scrollHeight)`);
await sleep(900);
await shot('29-works-full-bottom');

out.consoleErrors = errors;
out.failedRequests = failedRequests;

console.log(JSON.stringify(out, null, 2));
ws.close();
// 关掉自己开的标签页；已经不在也不该让脚本以失败退出
await fetch(`http://127.0.0.1:9222/json/close/${page.id}`).catch(() => {});
