import { defineConfig } from 'astro/config';

// 正式站点域名待 D05（托管与域名）定案后填写；当前占位不影响本地构建。
export default defineConfig({
  output: 'static',
  trailingSlash: 'ignore',
  build: { format: 'directory' },
});
