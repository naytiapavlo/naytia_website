import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

/**
 * 内容集合 schema（契约见 docs/plans/03 第 2 节）。
 * status/verification 分离、兼容性声明等扩展字段在阶段 2 按需加入。
 */

const works = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './content/works' }),
  schema: z.object({
    title: z.string(),
    summary: z.string(),
    /** 作品类型：机制探索 / 机器设计 / 红石工程 等 */
    type: z.string(),
    edition: z.string().default('MCBE'),
    /** 像素图标 symbol id */
    icon: z.string().default('i-bolt'),
    /** 视频以外链优先（01 文档第 5 节） */
    videoUrl: z.string().url().optional(),
    videoLabel: z.string().default('B 站视频 ↗'),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
    date: z.coerce.date(),
  }),
});

const posts = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './content/posts' }),
  schema: z.object({
    title: z.string(),
    summary: z.string(),
    category: z.string().default('日常碎片'),
    tags: z.array(z.string()).default([]),
    /** 草稿不进入构建：列表、RSS、搜索统一过滤（04 文档第 2 节） */
    draft: z.boolean().default(false),
    date: z.coerce.date(),
    updated: z.coerce.date().optional(),
  }),
});

export const collections = { works, posts };
