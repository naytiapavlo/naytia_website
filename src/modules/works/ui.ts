/**
 * 作品页的客户端增强：封面灯箱 + 时间轴动效。
 *
 * 设计口径（`src/modules/README.md` 第 4 条「静态优先」）：
 * 这里只做增强，不做渲染。脚本缺失、报错或浏览器能力不足时，
 * 封面滚动与时间轴仍按静态顺序完整可读，首屏不被阻塞。
 * 动效一律尊重 `prefers-reduced-motion`（见 `src/styles/works.css`）。
 */

interface LightboxItem {
  src: string;
  title: string;
  caption: string;
  tags: string;
  videoUrl: string;
}

/** 初始化作品页的动态部分；找不到对应节点时静默返回。 */
export function initWorksShowcase(root: ParentNode = document): void {
  initLightbox(root);
  initTimeline(root);
}

/** 封面灯箱：点击封面放大，← → 切换，Esc 或点击空白处关闭。 */
function initLightbox(root: ParentNode): void {
  const dialog = root.querySelector<HTMLDialogElement>('[data-lightbox]');
  const cards = Array.from(root.querySelectorAll<HTMLElement>('[data-image]'));
  if (!dialog || cards.length === 0 || typeof dialog.showModal !== 'function') return;

  const image = dialog.querySelector<HTMLImageElement>('[data-lightbox-image]');
  const title = dialog.querySelector<HTMLElement>('[data-lightbox-title]');
  const caption = dialog.querySelector<HTMLElement>('[data-lightbox-caption]');
  const tags = dialog.querySelector<HTMLElement>('[data-lightbox-tags]');
  const counter = dialog.querySelector<HTMLElement>('[data-lightbox-counter]');
  const link = dialog.querySelector<HTMLAnchorElement>('[data-lightbox-link]');
  if (!image || !title || !caption || !counter) return;

  // 两行滚动轨道用的是同一批封面，按图去重，灯箱里每张只出现一次。
  const items: LightboxItem[] = [];
  cards.forEach((card) => {
    const src = card.dataset.image ?? '';
    if (src.length === 0 || items.some((item) => item.src === src)) return;
    items.push({
      src,
      title: card.dataset.title ?? '',
      caption: card.dataset.caption ?? '',
      tags: card.dataset.tags ?? '',
      videoUrl: card.dataset.video ?? '',
    });
  });
  if (items.length === 0) return;

  let current = 0;
  let lastFocus: HTMLElement | null = null;

  const render = (index: number): void => {
    current = (index + items.length) % items.length;
    const item = items[current];
    image.src = item.src;
    image.alt = item.title ? `${item.title}：${item.caption}` : item.caption;
    title.textContent = item.title;
    caption.textContent = item.caption;
    counter.textContent = `${String(current + 1).padStart(2, '0')} / ${String(items.length).padStart(2, '0')}`;
    if (tags) {
      tags.textContent = item.tags;
      tags.hidden = item.tags.length === 0;
    }
    if (link) {
      // 没有确切视频地址就不给入口，不做「猜链接」的跳转。
      link.hidden = item.videoUrl.length === 0;
      if (item.videoUrl) link.href = item.videoUrl;
      else link.removeAttribute('href');
    }
  };

  cards.forEach((card) => {
    card.addEventListener('click', () => {
      const index = items.findIndex((item) => item.src === (card.dataset.image ?? ''));
      lastFocus = card;
      render(index < 0 ? 0 : index);
      dialog.showModal();
      document.documentElement.classList.add('wk-lightbox-open');
    });
  });

  dialog.querySelector('[data-lightbox-close]')?.addEventListener('click', () => dialog.close());
  dialog.querySelector('[data-lightbox-prev]')?.addEventListener('click', () => render(current - 1));
  dialog.querySelector('[data-lightbox-next]')?.addEventListener('click', () => render(current + 1));
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      render(current - 1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      render(current + 1);
    }
  });
  dialog.addEventListener('close', () => {
    document.documentElement.classList.remove('wk-lightbox-open');
    lastFocus?.focus();
  });

  // 先把第一张的内容填进灯箱，避免点开瞬间出现空图。
  render(0);
}

/** 时间轴：节点随滚动浮现，进度线随阅读位置推进并高亮当前节点。 */
function initTimeline(root: ParentNode): void {
  const timeline = root.querySelector<HTMLElement>('[data-timeline]');
  if (!timeline) return;

  const items = Array.from(timeline.querySelectorAll<HTMLElement>('[data-timeline-item]'));
  if (items.length === 0) return;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion || typeof IntersectionObserver === 'undefined') {
    items.forEach((item) => item.classList.add('wk-visible'));
  } else {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('wk-visible');
          observer.unobserve(entry.target);
        });
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.15 },
    );
    items.forEach((item) => observer.observe(item));
  }

  const rail = timeline.querySelector<HTMLElement>('[data-timeline-rail]');
  const fill = timeline.querySelector<HTMLElement>('[data-timeline-fill]');
  if (!fill) return;

  // 圆点中心相对节点顶部的偏移：.wk-dot 的 top 22px + 高 12px 的一半（见 works.css）
  const DOT_CENTER = 28;
  const last = items[items.length - 1];

  let frame = 0;
  const update = (): void => {
    frame = 0;
    const rect = timeline.getBoundingClientRect();
    if (rect.height <= 0) return;
    const railRect = rail?.getBoundingClientRect();
    const railTop = railRect ? railRect.top - rect.top : 0;
    const railHeight = railRect && railRect.height > 0 ? railRect.height : rect.height;
    // 以视口 55% 处作为「阅读线」，它走过多少时间轴，进度线就画多少。
    const line = window.innerHeight * 0.55 - rect.top;
    // 进度终点 = 最后一个节点的圆点中心：走到它就算读完，线不会停在半空。
    const span = Math.max(last.offsetTop + DOT_CENTER - railTop, 1);
    const passed = Math.min(Math.max(line - railTop, 0), span);
    fill.style.height = `${(passed / railHeight) * 100}%`;

    let active = -1;
    items.forEach((item, index) => {
      // 直接跳到页尾（End 键、锚点链接）时不经过 IntersectionObserver，这里补上显示
      if (line >= item.offsetTop) item.classList.add('wk-visible');
      if (line >= item.offsetTop + DOT_CENTER) active = index;
    });
    items.forEach((item, index) => item.classList.toggle('wk-active', index === active));
  };
  const schedule = (): void => {
    if (frame) return;
    frame = window.requestAnimationFrame(update);
  };

  update();
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  window.addEventListener('load', schedule);
}
