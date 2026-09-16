/**
 * 测试用模块解析钩子。
 *
 * 为什么需要它：生产代码按 Astro/Vite 的约定写「无扩展名」相对导入
 * （`from './engine'`），而 Node 的 ESM 解析要求写全扩展名；两边的规则不同。
 * 这里在测试侧用 Node 24 的同步解析钩子尝试补上 `.ts` / `/index.ts`，
 * 不改动生产代码，也不引入测试框架依赖。
 *
 * 注意：只处理「没有扩展名」的导入。已写扩展名的（例如 .astro、.mjs）
 * 一律原样交回，否则会把 Astro 组件路径改坏。
 *
 * 用法：node --import ./tests/resolve-ts.mjs --test tests/tools.test.ts
 */
import { registerHooks } from 'node:module';

const SUFFIXES = ['.ts', '/index.ts'];
/** 已带扩展名的导入不处理：末段含「.」即视为已写明扩展名 */
const HAS_EXTENSION = /\.[a-zA-Z0-9]+$/;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith('.') || specifier.startsWith('/')) &&
      !HAS_EXTENSION.test(specifier)
    ) {
      for (const suffix of SUFFIXES) {
        try {
          return nextResolve(`${specifier}${suffix}`, context);
        } catch {
          // 该后缀不存在，试下一个
        }
      }
    }
    return nextResolve(specifier, context);
  },
});
