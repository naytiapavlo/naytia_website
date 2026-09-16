// 极简 CDP 客户端（不属于项目源码）：驱动无头浏览器验证真实页面。
// 用法见 verify-admin-users.mjs —— 这里只放「连上浏览器 + 发命令 + 读页面」的公共部分。
import { setTimeout as delay } from 'node:timers/promises';

export async function connect(port, { timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let target = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      // 等到一个可用的 page target（--headless=new 启动后会有 about:blank）
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (target) break;
    } catch {
      // 浏览器还没起来
    }
    await delay(250);
  }
  if (!target) throw new Error(`连不上浏览器调试端口 ${port}（是否用 --remote-debugging-port 启动？）`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`));
      else resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 30000);
    });

  await send('Page.enable');
  await send('Runtime.enable');

  return {
    send,
    events,
    /**
     * 求值：返回 JSON 可序列化的值；页面抛错时把异常抛出来，不静默变成 undefined。
     *
     * 包成 `async` IIFE 而不是同步函数：片段里经常要 `await fetch(...)` 造状态
     * （比如在页面上登录），而 await 出现在非 async 函数体里是语法错误。
     */
    async evaluate(expression) {
      const res = await send('Runtime.evaluate', {
        expression: `(async () => { ${expression} })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (res.exceptionDetails) {
        throw new Error(`页面求值失败：${res.exceptionDetails.exception?.description
          ?? res.exceptionDetails.text}`);
      }
      return res.result.value;
    },
    async goto(url) {
      await send('Page.navigate', { url });
      await this.waitFor('document.readyState === "complete"');
    },
    /** 轮询等到表达式为真；超时则把最后的值带进错误里，方便定位。 */
    async waitFor(expression, { timeoutMs = 15000, label } = {}) {
      const deadline = Date.now() + timeoutMs;
      let last;
      while (Date.now() < deadline) {
        last = await this.evaluate(`return (${expression});`);
        if (last) return last;
        await delay(150);
      }
      throw new Error(`等待超时：${label ?? expression}（最后的值：${JSON.stringify(last)}）`);
    },
    consoleErrors() {
      return this.events
        .filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')
        .map((e) => e.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    },
    close() {
      ws.close();
    },
  };
}

/** 一个极小的断言器：失败也继续跑，最后统一汇总（一次跑完看清所有问题）。 */
export function createChecker() {
  const results = [];
  return {
    check(name, ok, detail = '') {
      results.push({ name, ok: Boolean(ok), detail });
      console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
      return Boolean(ok);
    },
    get failed() {
      return results.filter((r) => !r.ok);
    },
    summary() {
      const failed = this.failed;
      console.log(`\n共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`);
      return failed.length === 0;
    },
  };
}

export { delay };
