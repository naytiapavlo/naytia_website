// 演示用静态服务：把仓库根目录当静态站点，并把 /api/* 反代到后端。
// 用途：让 prototypes/ida-demo 能以同源方式访问 /api/reverse/*，
// 从而在 demo 里看到真实 IDA 数据（file:// 直接打开会被 CORS 拦住）。
//
// 用法：node tests/manual/serve-root.mjs [port] [upstream]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.argv[2] ?? 8011);
const UPSTREAM = process.argv[3] ?? 'http://127.0.0.1:8010';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname.startsWith('/api/')) {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (['host', 'origin', 'referer', 'connection'].includes(k)) continue;
      headers[k] = v;
    }
    const body = ['GET', 'HEAD'].includes(req.method)
      ? undefined
      : await new Promise((r) => {
          const chunks = [];
          req.on('data', (c) => chunks.push(c));
          req.on('end', () => r(Buffer.concat(chunks)));
        });
    try {
      const up = await fetch(`${UPSTREAM}${url.pathname}${url.search}`, {
        method: req.method, headers, body,
      });
      res.writeHead(up.status, {
        'content-type': up.headers.get('content-type') ?? 'application/json',
        'set-cookie': up.headers.getSetCookie?.() ?? [],
        'cache-control': 'no-store',
      });
      res.end(Buffer.from(await up.arrayBuffer()));
    } catch (err) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ detail: { code: 'proxy_failed', message: String(err) } }));
    }
    return;
  }

  let path = decodeURIComponent(url.pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = join(ROOT, normalize(path).replace(/^([/\\])+/, ''));
  try {
    const info = await stat(file);
    if (info.isDirectory()) {
      res.writeHead(302, { location: `${path.replace(/\/?$/, '/')}index.html` });
      res.end();
      return;
    }
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
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('read error');
  }
}).listen(PORT, () => console.log(`serving repo root + /api proxy on http://localhost:${PORT}`));
