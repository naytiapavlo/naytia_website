/**
 * 工具宿主：统一加载、状态显示、执行与失败隔离（05 文档阶段 3 验收项）。
 *
 * 职责边界：
 * - 宿主负责：状态门槛、schema 校验 → engine.run → 统一错误/结果协议、计时、收藏入口。
 * - 工具负责：自己的输入界面与结果呈现，不自己调 engine（通过 context.compute）。
 * - 单个工具失败只影响自己的结果区，页面与其他工具继续工作（01 文档第 10 节）。
 */
import { currentSession } from '../../modules/account';
import { ApiError } from '../../shared/api-client';
import { toast } from '../../shared/toast';
import { addFavorite, fetchFavorites, removeFavorite } from './favorites-api';
import { isRunnable, toolStatusLabels, type ToolManifest } from './manifest';
import { getToolModule } from '../registry';
import type { ErasedToolConfig, ToolResult } from './types';

/** 当前正在运行的工具清理函数，切换工具/重新挂载时调用，避免遗留事件监听。 */
let activeCleanup: (() => void) | undefined;

export function initToolHost(container: HTMLElement): void {
  const slug = container.dataset.tool ?? '';

  container.replaceChildren();
  activeCleanup?.();
  activeCleanup = undefined;

  const module = getToolModule(slug);
  if (!module) {
    container.appendChild(
      notice('未找到这个工具', '注册表里没有这个 slug，链接可能已经失效。'),
    );
    return;
  }

  const { manifest, reference } = module;
  if (!isRunnable(manifest.status)) {
    // 规划中的工具诚实显示状态，不给出任何可运行入口
    container.appendChild(
      notice(
        `${manifest.title}还在开发中`,
        `当前状态：${toolStatusLabels[manifest.status]}。工具上线后这里会出现输入界面；现在不提供可运行的按钮，避免出现「点了没反应」的入口。`,
      ),
    );
    return;
  }

  const actions = document.createElement('div');
  const stage = document.createElement('div');
  container.append(actions, stage);

  try {
    const cleanup = reference.mount(stage, { compute: createCompute(reference), examples: [] });
    if (typeof cleanup === 'function') activeCleanup = cleanup;
  } catch (error) {
    // 视图初始化失败只毁掉自己的结果区，不影响页面其他部分
    container.replaceChildren(
      notice('工具界面加载失败', error instanceof Error ? error.message : '未知错误'),
    );
    return;
  }

  void mountFavorites(actions, manifest);
}

/** 把「用户原始输入」变成「结果或结构化错误」，所有工具走同一条路径。 */
function createCompute(config: ErasedToolConfig): ToolCompute {
  return async (raw: unknown): Promise<ToolResult<unknown>> => {
    const parsed = config.schema.parse(raw);
    if (!parsed.ok) return { ok: false, error: parsed.error };

    try {
      return await config.engine.run(parsed.value, {
        rulesetId: config.rulesetId,
        signal: new AbortController().signal,
      });
    } catch (error) {
      // 内部故障：不吞掉堆栈，但也不把它甩给用户（03 文档第 5 节错误分类）
      console.error('[toolbox] 计算失败', error);
      return {
        ok: false,
        error: {
          code: 'internal_error',
          message: '计算过程中出现内部错误，请重试或调整输入',
          retryable: true,
        },
      };
    }
  };
}

type ToolCompute = (raw: unknown) => Promise<ToolResult<unknown>>;

async function mountFavorites(actions: HTMLElement, manifest: ToolManifest): Promise<void> {
  const bar = document.createElement('div');
  bar.className = 'tool-actions-bar';

  const favorite = document.createElement('button');
  favorite.type = 'button';
  favorite.className = 'tool-secondary';

  const status = document.createElement('span');
  status.className = 'tool-actions-note';

  bar.append(favorite, status);
  actions.replaceChildren(bar);

  let signedIn = await currentSession().catch(() => null);
  let isFavorite = false;

  function paint(): void {
    if (!signedIn) {
      favorite.textContent = '登录后可收藏';
      favorite.dataset.state = 'locked';
      status.textContent = '工具计算在本地完成，无需登录；登录只用于保存收藏。';
      return;
    }
    favorite.textContent = isFavorite ? '已收藏 ✓' : '收藏这个工具';
    favorite.dataset.state = isFavorite ? 'on' : 'off';
    status.textContent = '收藏保存在你的账号里。';
  }

  paint();

  if (signedIn) {
    try {
      const list = await fetchFavorites();
      isFavorite = list.tools.includes(manifest.id);
      paint();
    } catch {
      status.textContent = '暂时读不到收藏列表（后端未启动），不影响使用工具。';
    }
  }

  favorite.addEventListener('click', async () => {
    if (!signedIn) {
      // 登录入口由 account 模块的导航角标承载，这里只负责把用户带过去
      const trigger = document.querySelector<HTMLButtonElement>('#navAccount button');
      if (trigger) {
        trigger.click();
      } else {
        toast('请先点击右上角「登录 / 注册」');
      }
      return;
    }
    favorite.disabled = true;
    try {
      const list = isFavorite
        ? await removeFavorite(manifest.id)
        : await addFavorite(manifest.id);
      isFavorite = list.tools.includes(manifest.id);
      toast(isFavorite ? '已加入收藏' : '已取消收藏');
      paint();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        signedIn = null;
        toast('登录状态已过期，请重新登录');
        paint();
      } else {
        toast(error instanceof Error ? error.message : '收藏操作失败');
      }
    } finally {
      favorite.disabled = false;
    }
  });
}

function notice(title: string, body: string): HTMLElement {
  const box = document.createElement('div');
  box.className = 'tool-notice';
  const strong = document.createElement('strong');
  strong.textContent = title;
  const p = document.createElement('p');
  p.textContent = body;
  box.append(strong, p);
  return box;
}
