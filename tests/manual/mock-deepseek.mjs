// 假 DeepSeek 服务：按顺序返回预置的 message，用于端到端验证 AI 助手。
// 绝不消耗真实额度。用法：node tests/manual/mock-deepseek.mjs [port]
import { createServer } from 'node:http';

const PORT = Number(process.argv[2] ?? 8020);
const scenario = process.argv[3] ?? 'tool-then-answer';

/** 每个请求按顺序取一条回复；用完后重复最后一条。 */
function repliesFor(name) {
  if (name === 'plain') {
    return [{ role: 'assistant', content: '这是一个直接回答，没有调用工具。' }];
  }
  return [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call_mock_1',
        type: 'function',
        function: { name: 'decompile', arguments: JSON.stringify({ addr: '0x7ff6871d3b90' }) },
      }],
    },
    {
      role: 'assistant',
      content: '这个函数是 BDS 的入口 main：它先做初始化，然后进入服务端主循环。'
        + '关键调用在 0x7ff6871d2f10（DedicatedServer::run）。',
    },
  ];
}

let served = 0;
createServer(async (req, res) => {
  if (!req.url.startsWith('/chat/completions')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":"not found"}');
    return;
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  const queue = repliesFor(scenario);
  const reply = queue[Math.min(served, queue.length - 1)];
  served += 1;

  // 把收到的工具定义数量记下来，便于确认前后端契约没断
  console.log(JSON.stringify({
    n: served,
    model: body.model,
    messages: body.messages.length,
    tools: (body.tools || []).length,
    toolChoice: body.tool_choice,
    lastRole: body.messages?.[body.messages.length - 1]?.role,
  }));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: reply }] }));
}).listen(PORT, () => console.log(`mock deepseek on http://127.0.0.1:${PORT}`));
