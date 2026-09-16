import { defineConfig } from 'astro/config';
import { loadEnv } from 'vite';

// 正式站点域名（D05）。构建期从环境变量取，写域名不动代码：
//   1) 根目录 .env 里的 SITE_URL=https://你的域名（推荐，见 .env.example）
//   2) 或临时：set SITE_URL=https://你的域名 && npm run build
// 只影响 canonical / 绝对 URL 之类的元信息；站点内部一律走相对路径，
// 所以留空或写错也不会让页面 404（改完重新构建即可）。
// 用 vite 的 loadEnv 而不是 astro/config：Astro 5.18 的 astro/config 没有导出 loadEnv。
const env = loadEnv(process.env.NODE_ENV ?? 'production', process.cwd(), '');

// 验收用的可选开发代理（默认关闭，正式构建不受影响）：
//   VITE_API_PROXY_TARGET=http://127.0.0.1:8124 npx astro dev
// 把 /api 反代到指定后端，让浏览器视角下前后端同源——本地跨端口时
// 会话 Cookie（SameSite=Lax）不会被带上，而验收脚本需要这一条。
// 由 tests/manual/verify-admin-users.mjs 通过环境变量启用；不设就完全不存在。
const proxyTarget = process.env.VITE_API_PROXY_TARGET;

export default defineConfig({
  output: 'static',
  trailingSlash: 'ignore',
  build: { format: 'directory' },
  site: env.SITE_URL || undefined,
  vite: proxyTarget
    ? {
        // 关掉文件监听：验收只看首屏渲染之后的行为，不需要 HMR；而 watch 整个仓库
        // 会撞上别人（另一次 pytest 运行）留下的临时文件，EBUSY 直接把 dev server 打挂。
        server: {
          watch: null,
          proxy: { '/api': { target: proxyTarget, changeOrigin: false } },
        },
      }
    : undefined,
});
