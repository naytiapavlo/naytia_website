/**
 * AI 助手悬浮窗（docs/plans/11）。
 *
 * 定位：嵌在逆向工作台右下角的可折叠窗口。用户选中某个函数后直接问
 * "这个函数在做什么"，模型通过只读工具自己去查反编译与引用，再用人话解释。
 *
 * 关键约束：
 * - 对话历史只存在浏览器 localStorage，服务端不落库（少一份隐私负担）。
 *   每轮把历史整体回传，服务端按 ai_max_messages / ai_max_chars 截断。
 * - 配额（每 5 小时 3 轮）由服务端判定；这里只负责显示剩余轮数，
 *   不做任何"前端拦住就不扣"的假设。
 * - 未配置 DeepSeek key 时后端返回 configured=false，窗口显示"未配置"而不是报错。
 */
import { aiApi, humanizeReset, type ChatMessage, type QuotaInfo } from './ai-api';

const HISTORY_KEY = 'naytia:ida:ai:history';
const OPEN_KEY = 'naytia:ida:ai:open';
/** 本地最多留多少条历史（服务端还会再截断一次） */
const MAX_LOCAL_MESSAGES = 24;

export interface AiPanelOptions {
  /** 组装当前工作台上下文，让模型知道用户在看哪个函数 */
  getContext: () => {
    module?: string | null;
    base_address?: string | null;
    selected_name?: string | null;
    selected_addr?: string | null;
    total_functions?: number | null;
  };
  /** 当前实例端口 */
  getPort: () => number | null;
  /** 点击回答里的地址时跳转 */
  onJump?: (addr: string) => void;
}

export function mountAiPanel(root: HTMLElement, options: AiPanelOptions): () => void {
  const disposers: Array<() => void> = [];
  const on = (target: EventTarget, type: string, handler: EventListener): void => {
    target.addEventListener(type, handler);
    disposers.push(() => target.removeEventListener(type, handler));
  };

  let history: ChatMessage[] = loadHistory();
  let quota: QuotaInfo | null = null;
  let busy = false;

  // 注意：这是个 const 箭头函数，必须在任何调用之前声明
  // （之前踩过一次：先把 DOM 建好、再声明 el，运行时直接 TDZ 报错）。
  const el = (tag: string, className: string): HTMLElement => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  };

  // ---------- 外壳 ----------
  const panel = el('div', 'ai-panel');
  const header = el('div', 'ai-header');
  const title = el('strong', 'ai-title');
  title.textContent = 'AI 助手';
  const quotaChip = el('span', 'ai-chip');
  quotaChip.textContent = '配额检查中…';
  const btnToggle = document.createElement('button');
  btnToggle.type = 'button';
  btnToggle.className = 'ai-iconbtn';
  btnToggle.textContent = '−';
  btnToggle.title = '收起 / 展开';
  header.append(title, quotaChip, el('span', 'ai-grow'), btnToggle);

  const body = el('div', 'ai-body');
  const log = el('div', 'ai-log');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-live', 'polite');
  log.setAttribute('aria-label', '对话记录');

  const form = document.createElement('form');
  form.className = 'ai-form';
  const input = document.createElement('textarea');
  input.className = 'ai-input';
  input.rows = 2;
  input.placeholder = '问点什么，例如：这个函数在做什么？';
  input.maxLength = 4000;
  input.setAttribute('aria-label', '向 AI 提问');
  const send = document.createElement('button');
  send.type = 'submit';
  send.className = 'ai-send';
  send.textContent = '发送';
  const hint = el('div', 'ai-hint');
  form.append(input, send);
  body.append(log, form, hint);

  const bubbleBtn = document.createElement('button');
  bubbleBtn.type = 'button';
  bubbleBtn.className = 'ai-bubble';
  bubbleBtn.innerHTML = '<span aria-hidden="true">AI</span>';
  bubbleBtn.title = '打开 AI 助手';
  bubbleBtn.setAttribute('aria-label', '打开 AI 助手');

  panel.append(header, body);
  root.append(panel, bubbleBtn);

  // ---------- 展开 / 收起 ----------
  function setOpen(open: boolean): void {
    panel.classList.toggle('is-open', open);
    bubbleBtn.hidden = open;
    if (open) input.focus();
    try {
      localStorage.setItem(OPEN_KEY, open ? '1' : '0');
    } catch { /* 忽略 */ }
  }
  on(btnToggle, 'click', () => setOpen(false));
  on(bubbleBtn, 'click', () => setOpen(true));

  // ---------- 历史持久化 ----------
  function loadHistory(): ChatMessage[] {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((m): m is ChatMessage =>
          typeof m === 'object' && m !== null && typeof (m as ChatMessage).content === 'string')
        .slice(-MAX_LOCAL_MESSAGES);
    } catch {
      return [];
    }
  }
  function saveHistory(): void {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-MAX_LOCAL_MESSAGES)));
    } catch { /* 隐私模式等：不记住也能聊 */ }
  }
  function clearHistory(): void {
    history = [];
    saveHistory();
    paintLog();
  }

  // ---------- 绘制 ----------
  function paintQuota(): void {
    if (!quota) {
      quotaChip.textContent = '配额检查中…';
      quotaChip.dataset.tone = '';
      return;
    }
    if (!quota.configured) {
      quotaChip.textContent = '未配置';
      quotaChip.dataset.tone = 'bad';
      return;
    }
    quotaChip.textContent = `剩 ${quota.remaining}/${quota.limit} 轮`;
    quotaChip.dataset.tone = quota.remaining === 0 ? 'bad' : quota.remaining === 1 ? 'warn' : 'ok';
  }

  function messageNode(message: ChatMessage): HTMLElement {
    const wrap = el('div', `ai-msg is-${message.role}`);
    const who = el('span', 'ai-who');
    who.textContent = message.role === 'user' ? '你' : 'AI';
    const text = el('div', 'ai-text');
    text.appendChild(renderRich(message.content));
    wrap.append(who, text);
    return wrap;
  }

  /** 工具调用记录：让用户看到"AI 查了什么"，而不是黑箱。 */
  function toolNode(label: string, ok: boolean): HTMLElement {
    const node = el('div', 'ai-tool');
    node.textContent = `${ok ? '🔍' : '⚠'} ${label}`;
    return node;
  }

  /** 行内地址（0x…）做成可点跳转；其余按纯文本处理，不用 innerHTML。 */
  function renderRich(text: string): DocumentFragment {
    const frag = document.createDocumentFragment();
    const pattern = /(0x[0-9a-fA-F]{4,16})/g;
    let last = 0;
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (index > last) frag.appendChild(document.createTextNode(text.slice(last, index)));
      const addr = match[1]!;
      if (options.onJump) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ai-addr';
        b.textContent = addr;
        b.title = `跳转到 ${addr}`;
        b.addEventListener('click', () => options.onJump?.(addr));
        frag.appendChild(b);
      } else {
        frag.appendChild(document.createTextNode(addr));
      }
      last = index + addr.length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }

  function paintLog(): void {
    log.replaceChildren();
    if (history.length === 0) {
      const empty = el('div', 'ai-empty');
      empty.textContent = '选中一个函数后可以直接问，例如「这个函数在做什么」「谁调用了它」。';
      log.appendChild(empty);
      return;
    }
    for (const message of history) {
      // 只展示对话双方，工具消息不直接展示（它的结果已并入回答）
      if (message.role === 'tool') continue;
      if (message.role === 'assistant' && !message.content.trim()) continue;
      log.appendChild(messageNode(message));
    }
    log.scrollTop = log.scrollHeight;
  }

  function paintHint(text: string, tone = ''): void {
    hint.textContent = text;
    hint.dataset.tone = tone;
  }

  function paintBusy(): void {
    const blocked = busy || quota?.configured === false || quota?.remaining === 0;
    send.disabled = blocked;
    // 输入框与按钮的禁用状态必须一致，否则"能打字但发不出去"看起来像卡死
    input.disabled = blocked;
    if (busy) paintHint('AI 正在查询 IDA…', 'busy');
  }

  // ---------- 发送 ----------
  on(form, 'submit', (event) => {
    event.preventDefault();
    void submit();
  });
  // Ctrl/⌘ + Enter 也发送
  on(input, 'keydown', (event) => {
    const keyboard = event as KeyboardEvent;
    if (keyboard.key === 'Enter' && (keyboard.ctrlKey || keyboard.metaKey)) {
      keyboard.preventDefault();
      void submit();
    }
  });

  async function submit(): Promise<void> {
    const text = input.value.trim();
    if (!text || busy) return;
    if (quota && !quota.configured) {
      paintHint('站点未配置 DeepSeek API key，AI 助手不可用', 'bad');
      return;
    }
    if (quota && quota.remaining === 0) {
      paintHint(`额度已用完，${humanizeReset(quota.reset_in)}后恢复`, 'bad');
      return;
    }

    busy = true;
    input.value = '';
    history.push({ role: 'user', content: text });
    paintLog();
    paintBusy();

    // 先把"正在查"的占位放出来，长问题要等几秒
    const pending = el('div', 'ai-msg is-assistant');
    const pendingWho = el('span', 'ai-who');
    pendingWho.textContent = 'AI';
    const pendingText = el('div', 'ai-text');
    pendingText.textContent = '思考中…';
    pending.append(pendingWho, pendingText);
    log.appendChild(pending);
    log.scrollTop = log.scrollHeight;

    try {
      const response = await aiApi.chat({
        message: text,
        history: history.slice(0, -1),   // 本轮消息单独传，不重复
        context: options.getContext(),
        port: options.getPort(),
      });

      pending.remove();
      // 工具调用记录要作为**常驻**元素留在对话流里，让用户看到"AI 查了什么"。
      // 陷阱：append 之后再调 paintLog() 会把 log 清空重建，刚加的节点就没了
      //（之前的 bug 正是如此——节点确实建了，紧接着被一次重绘抹掉）。
      // 顺序：先记下来 → 重绘历史气泡 → 再把工具记录追加到末尾。
      const toolNodes: HTMLElement[] = response.tool_calls.map((c) => toolNode(c.label, c.ok));
      history = response.messages;
      saveHistory();
      paintLog();
      for (const node of toolNodes) log.appendChild(node);
      log.scrollTop = log.scrollHeight;

      quota = {
        configured: true,
        limit: response.limit,
        used: response.limit - response.remaining,
        remaining: response.remaining,
        reset_in: response.reset_in,
        identity: quota?.identity ?? 'ip',
      };
      paintQuota();

      if (response.truncated) {
        paintHint('这轮工具查询次数过多，没能得出结论——把问题问得更具体些再试', 'warn');
      } else if (response.remaining === 0) {
        paintHint(`额度已用完，${humanizeReset(response.reset_in)}后恢复`, 'warn');
      } else {
        // 说清总账：这个窗口一共几轮、用了多少、还剩多少
        paintHint(`每 5 小时 ${response.limit} 轮，本轮已用 1 次，还剩 ${response.remaining} 轮`, '');
      }
    } catch (error) {
      pending.remove();
      history.pop();                   // 失败就把这条用户消息撤回，不占历史
      saveHistory();
      paintLog();
      const message = error instanceof Error ? error.message : '请求失败';
      paintHint(message, 'bad');
      // 429 时刷新配额，让计数显示与服务端一致
      if (/429|额度/.test(message)) void refreshQuota();
    } finally {
      busy = false;
      paintBusy();
    }
  }

  async function refreshQuota(): Promise<void> {
    try {
      quota = await aiApi.quota();
    } catch {
      quota = { configured: false, limit: 3, used: 0, remaining: 0, reset_in: 0, identity: 'ip' };
    }
    paintQuota();
    paintBusy();
    if (quota.configured === false) {
      paintHint('站点还没配置 DeepSeek API key，AI 助手暂不可用', 'warn');
    } else if (quota.remaining === 0) {
      paintHint(`额度已用完，${humanizeReset(quota.reset_in)}后恢复`, 'warn');
    } else {
      paintHint(`每 5 小时 ${quota.limit} 轮，当前还剩 ${quota.remaining} 轮`, '');
    }
  }

  // ---------- 启动 ----------
  paintLog();
  void refreshQuota();
  const wasOpen = (() => {
    try { return localStorage.getItem(OPEN_KEY) === '1'; } catch { return false; }
  })();
  setOpen(wasOpen);

  return () => {
    for (const dispose of disposers) dispose();
    disposers.length = 0;
    panel.remove();
    bubbleBtn.remove();
  };
}
