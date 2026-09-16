/**
 * 3D 预览控件：把 `voxel.ts` 算出来的东西画到 canvas 上，并处理交互。
 *
 * 交互沿用大家在看模型时的直觉：
 * - 拖动 = 旋转（左右转方位角，上下转俯仰角）
 * - 滚轮 = 缩放；双击 = 复位
 * - 键盘 `←→↑↓` 旋转、`+/-` 缩放、`0` 复位（画布可聚焦，键盘用户能用）
 * - 分层滑块：只显示 y 低于某高度的方块，用来一层层看内部结构
 *
 * 两条性能约定：
 * 1. **按需重绘**。没有动画循环在跑；只有相机/分层变化时才重画一帧。
 *    论坛页面上挂着一个 60fps 的空转循环，是白白耗别人的电。
 * 2. **排序只在旋转时重算**。缩放与画布尺寸变化不影响遮挡顺序，
 *    复用上一帧的 `FramePlan` 即可。
 */
import { blockColor } from './block-colors';
import {
  buildShell,
  cornerIndex,
  decodeRenderPayload,
  faceCorners,
  fitView,
  planFrame,
  shadedCss,
  viewBasis,
  type FramePlan,
  type RenderPayloadJson,
  type VoxelModel,
  type VoxelShell,
} from './voxel';

export interface VoxelViewOptions {
  /** 初始方位角（弧度） */
  yaw?: number;
  /** 初始俯仰角（弧度） */
  pitch?: number;
  /** 是否显示工具栏（分层滑块、复位按钮、统计） */
  controls?: boolean;
}

/**
 * 单帧绘制的可见面上限。
 *
 * 为什么要有：Canvas 2D 画的是多边形，不是三角形，一个面就是一次
 * `lineTo` 组合。十万级还能 30fps 左右，几十万级就会明显卡住拖动。
 * 超过这个数就按坐标抽稀（保留轮廓，丢掉细节），并在界面上**明说抽了多少**——
 * 让人以为「结构就长这样」比让人等两秒更糟。
 */
const MAX_DRAW_FACES = 200_000;

interface ViewState {
  model: VoxelModel;
  shell: VoxelShell;
  plan: FramePlan | null;
  yaw: number;
  pitch: number;
  zoom: number;
  maxY: number;
  /** 抽稀步长：1 = 全画 */
  stride: number;
  /** 抽稀前可绘制的方块数（用于如实显示「N 个可见方块，已抽稀」） */
  shellCountFull: number;
  dropped: number;
  dirty: boolean;
  raf: number;
}

export function mountVoxelView(
  container: HTMLElement,
  payload: RenderPayloadJson,
  options: VoxelViewOptions = {},
): () => void {
  const model = decodeRenderPayload(payload);
  const showControls = options.controls !== false;

  container.replaceChildren();
  const root = document.createElement('div');
  root.className = 'voxel-view';
  root.innerHTML = `
    <div class="voxel-stage">
      <canvas class="voxel-canvas" tabindex="0" role="img"></canvas>
      <p class="voxel-hint">拖动旋转 · 滚轮缩放 · 双击复位</p>
    </div>
    ${
      showControls
        ? `<div class="voxel-tools">
      <label class="voxel-layer">
        <span>分层显示</span>
        <input type="range" data-part="layer" min="1" max="${model.size.y}" value="${model.size.y}" step="1" />
        <output data-part="layer-out">全部 ${model.size.y} 层</output>
      </label>
      <div class="voxel-buttons">
        <button type="button" class="voxel-btn" data-act="reset">复位视角</button>
        <button type="button" class="voxel-btn" data-act="spin" aria-pressed="false">自动旋转</button>
      </div>
      <p class="voxel-stats" data-part="stats"></p>
    </div>`
        : ''
    }`;

  const stage = root.querySelector<HTMLElement>('.voxel-stage')!;
  const canvas = root.querySelector<HTMLCanvasElement>('.voxel-canvas')!;
  const context = canvas.getContext('2d');
  if (!context) {
    container.replaceChildren();
    const fallback = document.createElement('p');
    fallback.className = 'voxel-fallback';
    fallback.textContent =
      '这个浏览器拿不到 Canvas 2D 上下文，无法显示 3D 预览。材料清单不受影响。';
    container.appendChild(fallback);
    return () => undefined;
  }
  const ctx = context;

  const layerInput = root.querySelector<HTMLInputElement>('[data-part="layer"]');
  const layerOut = root.querySelector<HTMLOutputElement>('[data-part="layer-out"]');
  const statsOut = root.querySelector<HTMLElement>('[data-part="stats"]');
  const spinButton = root.querySelector<HTMLButtonElement>('[data-act="spin"]');

  const state: ViewState = {
    model,
    shell: buildShell(model),
    plan: null,
    yaw: options.yaw ?? -0.62,
    pitch: options.pitch ?? 0.52,
    zoom: 1,
    maxY: model.size.y,
    stride: 1,
    shellCountFull: model.solidCount,
    dropped: 0,
    dirty: true,
    raf: 0,
  };
  // 视角变了才需要重新排序；只改缩放/尺寸时能复用
  let planValid = false;
  let spinHandle = 0;

  // ------------------------------------------------------------ 颜色缓存
  // 调色板 -> 每个面方向的 CSS 颜色。方块数量可能上万，每帧算颜色是不必要的开销。
  const faceStyles: string[][] = model.palette.map((name) => {
    const color = blockColor(name);
    return Array.from({ length: 6 }, (_, face) => shadedCss(color, face));
  });

  function announce(): void {
    const shown = state.shell.count;
    const parts = [
      `${state.model.size.x} × ${state.model.size.y} × ${state.model.size.z}`,
      `${shown.toLocaleString('zh-CN')} 个可见方块`,
    ];
    if (state.dropped > 0) {
      parts.push(
        `已按 1/${state.stride} 抽稀（原 ${state.shellCountFull.toLocaleString('zh-CN')} 个）以保证流畅`,
      );
    }
    if (state.shell.hidden > 0 && state.maxY >= state.model.size.y) {
      parts.push(`${state.shell.hidden.toLocaleString('zh-CN')} 个方块被完全包住，未绘制`);
    }
    if (state.maxY < state.model.size.y) {
      parts.push(`只显示 y < ${state.maxY} 的部分`);
    }
    if (statsOut) statsOut.textContent = parts.join(' · ');
    canvas.setAttribute(
      'aria-label',
      `结构 3D 预览：${parts.join('，')}。可拖动旋转、滚轮缩放。`,
    );
  }

  // ------------------------------------------------------------ 外壳与抽稀
  function rebuildShell(): void {
    const full = buildShell(model, { maxY: state.maxY });

    // 抽稀按**可见面数**判断而不是方块数：一个被包住的方块不占绘制开销，
    // 而一个孤立方块要画 3 个面，两者差三倍。按面数判断才对应真实代价。
    let faceCount = 0;
    for (let i = 0; i < full.count; i += 1) {
      let bits = full.faceMask[i];
      while (bits) {
        faceCount += bits & 1;
        bits >>= 1;
      }
    }
    let stride = 1;
    if (faceCount > MAX_DRAW_FACES) {
      stride = Math.min(5, Math.ceil(Math.sqrt(faceCount / MAX_DRAW_FACES)));
    }
    state.stride = stride;
    state.shellCountFull = full.count;

    if (stride === 1) {
      state.shell = full;
      state.dropped = 0;
    } else {
      const px: number[] = [];
      const py: number[] = [];
      const pz: number[] = [];
      const mask: number[] = [];
      const indices: number[] = [];
      for (let i = 0; i < full.count; i += 1) {
        // 按 (x+y+z) % stride 保留一个「斜向族」：四个面都均匀地掉一层，
        // 轮廓还在。直接截断前 N 个会把结构切掉一半，比抽稀难看得多。
        if ((full.px[i] + full.py[i] + full.pz[i]) % stride !== 0) continue;
        px.push(full.px[i]);
        py.push(full.py[i]);
        pz.push(full.pz[i]);
        mask.push(full.faceMask[i]);
        indices.push(full.paletteIndices[i]);
      }
      state.shell = {
        count: px.length,
        totalSolid: full.totalSolid,
        px: Int16Array.from(px),
        py: Int16Array.from(py),
        pz: Int16Array.from(pz),
        paletteIndices:
          model.indexBits === 8 ? Uint8Array.from(indices) : Uint16Array.from(indices),
        faceMask: Uint8Array.from(mask),
        hidden: full.hidden,
      };
      state.dropped = full.count - px.length;
    }
    planValid = false;
    state.dirty = true;
  }

  // ------------------------------------------------------------ 绘制
  function resize(): void {
    const rect = stage.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(Math.round(rect.width), 1);
    const height = Math.max(Math.round(rect.height), 1);
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw(): void {
    state.raf = 0;
    if (!state.dirty) return;
    state.dirty = false;

    resize();
    const rect = stage.getBoundingClientRect();
    const width = Math.max(rect.width, 1);
    const height = Math.max(rect.height, 1);

    const basis = viewBasis(state.yaw, state.pitch);
    if (!planValid || !state.plan) {
      state.plan = planFrame(state.shell, basis);
      planValid = true;
    }
    const plan = state.plan;
    const { scale, offsetX, offsetY } = fitView(
      plan.bounds,
      { width, height },
      state.zoom,
    );

    ctx.save();
    ctx.clearRect(0, 0, width, height);
    drawGroundGrid(ctx, scale, offsetX, offsetY);

    const { order, screenX, screenY, cornerX, cornerY } = plan;
    const visibleFaces = plan.visibleFaces;
    const shell = state.shell;
    const indices = shell.paletteIndices;
    const masks = shell.faceMask;

    let facesDrawn = 0;
    // 同一个颜色的连续面合并成一条路径：体素建筑里大片同色墙体很常见，
    // 合并之后 fill() 的调用次数通常降到几千次，是这一层最关键的一步优化。
    // 只有**相邻**的同色面才合并——跨过别的颜色合并会破坏画家算法的遮挡关系。
    let currentKey = -1;
    let pathOpen = false;

    for (let n = 0; n < order.length; n += 1) {
      const i = order[n];
      const drawn = masks[i] & visibleFaces;
      if (drawn === 0) continue;

      const bx = screenX[i] * scale + offsetX;
      const by = screenY[i] * scale + offsetY;
      const paletteIndex = indices[i];

      for (let face = 0; face < 6; face += 1) {
        if (!((drawn >> face) & 1)) continue;
        const key = paletteIndex * 6 + face;
        if (key !== currentKey) {
          if (pathOpen) ctx.fill();
          ctx.beginPath();
          ctx.fillStyle = faceStyles[paletteIndex][face];
          currentKey = key;
          pathOpen = true;
        }
        const corners = faceCorners(face);
        for (let c = 0; c < 4; c += 1) {
          const ci = cornerIndex(corners[c]);
          const cx = bx + cornerX[ci] * scale;
          const cy = by + cornerY[ci] * scale;
          if (c === 0) ctx.moveTo(cx, cy);
          else ctx.lineTo(cx, cy);
        }
        ctx.closePath();
        facesDrawn += 1;
      }
    }
    if (pathOpen) ctx.fill();
    ctx.restore();

    if (facesDrawn === 0 && model.solidCount === 0) {
      ctx.save();
      ctx.fillStyle = '#88758f';
      ctx.font = '14px "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('这个结构里没有方块', width / 2, height / 2);
      ctx.restore();
    }
    announce();
  }
  function requestDraw(): void {
    state.dirty = true;
    if (state.raf) return;
    state.raf = requestAnimationFrame(draw);
  }

  /** 地面参考网格：没有它，悬空结构的朝向很难判断。 */
  function drawGroundGrid(
    target: CanvasRenderingContext2D,
    scale: number,
    offsetX: number,
    offsetY: number,
  ): void {
    const { x: sx, z: sz } = model.size;
    if (sx > 64 || sz > 64) return; // 太大就没有参考价值了，省掉这笔开销
    const basis = viewBasis(state.yaw, state.pitch);
    const project = (x: number, z: number): [number, number] => {
      const wx = x;
      const wz = z;
      const px = wx * basis.right.x + 0 * basis.right.y + wz * basis.right.z;
      const py = -(wx * basis.up.x + 0 * basis.up.y + wz * basis.up.z);
      return [px * scale + offsetX, py * scale + offsetY];
    };
    target.save();
    target.strokeStyle = 'rgba(163, 69, 107, 0.14)';
    target.lineWidth = 1;
    target.beginPath();
    for (let x = 0; x <= sx; x += 1) {
      const [x1, y1] = project(x, 0);
      const [x2, y2] = project(x, sz);
      target.moveTo(x1, y1);
      target.lineTo(x2, y2);
    }
    for (let z = 0; z <= sz; z += 1) {
      const [x1, y1] = project(0, z);
      const [x2, y2] = project(sx, z);
      target.moveTo(x1, y1);
      target.lineTo(x2, y2);
    }
    target.stroke();
    target.restore();
  }

  // ------------------------------------------------------------ 交互
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  const onPointerDown = (event: PointerEvent): void => {
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add('is-dragging');
    stopSpin();
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (!dragging) return;
    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;
    state.yaw += dx * 0.011;
    // 俯仰限制在上下 85°：越过极点画面会翻转，看结构时很难受
    state.pitch = Math.max(-1.48, Math.min(1.48, state.pitch + dy * 0.011));
    planValid = false;
    requestDraw();
  };
  const onPointerUp = (event: PointerEvent): void => {
    dragging = false;
    canvas.classList.remove('is-dragging');
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };
  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.0012);
    state.zoom = Math.max(0.25, Math.min(6, state.zoom * factor));
    requestDraw();
  };
  const onDoubleClick = (): void => resetView();

  const onKeyDown = (event: KeyboardEvent): void => {
    const step = event.shiftKey ? 0.16 : 0.05;
    let handled = true;
    switch (event.key) {
      case 'ArrowLeft':
        state.yaw -= step;
        break;
      case 'ArrowRight':
        state.yaw += step;
        break;
      case 'ArrowUp':
        state.pitch = Math.max(-1.48, state.pitch - step);
        break;
      case 'ArrowDown':
        state.pitch = Math.min(1.48, state.pitch + step);
        break;
      case '+':
      case '=':
        state.zoom = Math.min(6, state.zoom * 1.15);
        break;
      case '-':
      case '_':
        state.zoom = Math.max(0.25, state.zoom / 1.15);
        break;
      case '0':
        resetView();
        return;
      default:
        handled = false;
    }
    if (handled) {
      event.preventDefault();
      planValid = false;
      requestDraw();
    }
  };

  function resetView(): void {
    state.yaw = options.yaw ?? -0.62;
    state.pitch = options.pitch ?? 0.52;
    state.zoom = 1;
    planValid = false;
    requestDraw();
  }

  function startSpin(): void {
    if (spinHandle) return;
    spinButton?.setAttribute('aria-pressed', 'true');
    const tick = (): void => {
      state.yaw += 0.012;
      planValid = false;
      requestDraw();
      spinHandle = requestAnimationFrame(tick);
    };
    spinHandle = requestAnimationFrame(tick);
  }
  function stopSpin(): void {
    if (spinHandle) cancelAnimationFrame(spinHandle);
    spinHandle = 0;
    spinButton?.setAttribute('aria-pressed', 'false');
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('dblclick', onDoubleClick);
  canvas.addEventListener('keydown', onKeyDown);

  layerInput?.addEventListener('input', () => {
    const value = Number(layerInput.value);
    state.maxY = value;
    if (layerOut) {
      layerOut.textContent =
        value >= model.size.y ? `全部 ${model.size.y} 层` : `只显示 y < ${value}`;
    }
    rebuildShell();
    requestDraw();
  });

  root.querySelector('[data-act="reset"]')?.addEventListener('click', resetView);
  spinButton?.addEventListener('click', () => {
    if (spinHandle) stopSpin();
    else startSpin();
  });

  const observer = new ResizeObserver(() => requestDraw());
  observer.observe(stage);

  container.appendChild(root);
  rebuildShell();
  requestDraw();

  return () => {
    stopSpin();
    observer.disconnect();
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerUp);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('dblclick', onDoubleClick);
    canvas.removeEventListener('keydown', onKeyDown);
    if (state.raf) cancelAnimationFrame(state.raf);
    container.replaceChildren();
  };
}
