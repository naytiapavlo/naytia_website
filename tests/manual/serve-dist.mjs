// 临时验证用静态服务器（不属于项目源码）。
// 目的：把构建产物放在与后端 API 相同的 origin 后面，绕开
// 「跨端口 + SameSite=Lax 会拦掉会话 Cookie」这一本地开发期的浏览器限制，
// 从而真实验证「登录 → 收藏」这条链路。
//
// 用法：serve-dist.mjs <port> <upstreamApi> [distRoot]
//   distRoot 默认是仓库的 dist/。多人（或多个 agent）同时在同一个仓库里开发时，
//   dist/ 会被别人的构建覆盖，验证跑到一半产物就变了；这时用 `astro build
//   --outDir dist-e2e` 生成一份自己的产物，并把 distRoot 指过去。
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.argv[2] ?? 8001);
const UPSTREAM = process.argv[3] ?? 'http://127.0.0.1:8000';
// tests/manual/ → 仓库根目录 → dist/
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOT = process.argv[4] ? resolve(process.argv[4]) : join(REPO, 'dist');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.gif': 'image/gif',
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // API 反向代理到 FastAPI：浏览器视角下同源，Cookie 可正常往返
  if (url.pathname.startsWith('/api/')) {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (k === 'host' || k === 'origin' || k === 'referer' || k === 'connection') continue;
      headers[k] = v;
    }
    const body = ['GET', 'HEAD'].includes(req.method)
      ? undefined
      : await new Promise((resolve) => {
          const chunks = [];
          req.on('data', (c) => chunks.push(c));
          req.on('end', () => resolve(Buffer.concat(chunks)));
        });
    const upstream = await fetch(`${UPSTREAM}${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body,
    });
    // 逐个转发有用的响应头，而不是整份照搬：`content-encoding` 与 `content-length`
    // 不能转发——Node 的 fetch 已经自动解压了正文，再带上 gzip 头会让浏览器
    // 把明文当压缩流解，直接报错（这是踩过的坑，不是理论风险）。
    const passthrough = [
      'content-type',
      'content-disposition',
      'x-content-type-options',
      'content-security-policy',
      'etag',
      'vary',
    ];
    const outHeaders = { 'cache-control': 'no-store' };
    for (const name of passthrough) {
      const value = upstream.headers.get(name);
      if (value !== null) outHeaders[name] = value;
    }
    res.writeHead(upstream.status, {
      ...outHeaders,
      'set-cookie': upstream.headers.getSetCookie?.() ?? [],
    });
    res.end(Buffer.from(await upstream.arrayBuffer()));
    return;
  }

  // 静态产物
  let path = decodeURIComponent(url.pathname);
  if (path.endsWith('/')) path += 'index.html';
  let file = join(ROOT, normalize(path).replace(/^([/\\])+/, ''));
  try {
    const info = await stat(file);
    if (info.isDirectory()) file = join(file, 'index.html');
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}).listen(PORT, () => console.log(`serving dist + /api proxy on http://localhost:${PORT}`));
