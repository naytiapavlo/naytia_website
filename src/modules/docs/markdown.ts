/**
 * 极简 Markdown 渲染器（文档树用）。
 *
 * 为什么不引第三方库：站上文档是**用户上传的内容**，渲染路径必须完全可控。
 * 这里全程用 `document.createElement` / `createTextNode` 拼 DOM，没有任何
 * `innerHTML`，所以即使正文里写了 `<script>` 也只会变成可见的文本——不依赖
 * 第三方库的转义实现是否正确，也不引入一个几十 KB 的依赖。
 *
 * 支持范围（够用就好，够不上就按纯文本显示，不猜）：
 * 标题、段落、粗体/斜体/行内代码、删除线、有序/无序列表、任务列表、
 * 引用、围栏代码块、表格、分隔线、链接、外链图片。
 */
import type { DocFormat } from './api';

export interface HeadingRef {
  level: number;
  text: string;
  id: string;
}

export interface RenderResult {
  nodes: Node[];
  headings: HeadingRef[];
}

export interface RenderOptions {
  /** 文档格式：非 md 一律按纯文本渲染（用 <pre> 保留原始排版） */
  format: DocFormat;
  /** 把链接目标解析成站内文档，返回 id 表示可以跳转；返回 undefined 表示保持原样 */
  resolveDocLink?: (href: string) => number | undefined;
}

const SAFE_EXTERNAL = /^https?:\/\//i;

export function renderDocument(source: string, options: RenderOptions): RenderResult {
  const text = source.replace(/\r\n?/g, '\n');
  if (options.format !== 'md') {
    // txt / json：原样保留空白，交给 CSS 处理换行与滚动
    const pre = document.createElement('pre');
    pre.className = 'docs-plain';
    pre.textContent = text;
    return { nodes: [pre], headings: [] };
  }
  const context: RenderContext = { headings: [], counter: 0, options };
  const nodes = renderBlocks(text.split('\n'), context);
  return { nodes, headings: context.headings };
}

interface RenderContext {
  headings: HeadingRef[];
  counter: number;
  options: RenderOptions;
}

// ----------------------------------------------------------------- 块级解析

function renderBlocks(lines: string[], context: RenderContext): Node[] {
  const out: Node[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    // 围栏代码块：``` 或 ~~~，可以带语言标注
    const fence = /^\s*(`{3,}|~{3,})\s*([\w+#-]*)\s*$/.exec(line);
    if (fence) {
      const marker = fence[1][0];
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^\\s*${marker}{3,}\\s*$`).test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1; // 跳过收尾围栏（没有收尾时正好越界，循环自然结束）
      const pre = document.createElement('pre');
      pre.className = 'docs-code';
      const code = document.createElement('code');
      code.textContent = body.join('\n');
      if (fence[2]) code.dataset.language = fence[2];
      pre.appendChild(code);
      out.push(pre);
      continue;
    }

    // 分隔线
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      out.push(document.createElement('hr'));
      index += 1;
      continue;
    }

    // 标题
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const element = document.createElement(`h${level}`) as HTMLHeadingElement;
      const plain = heading[2].trim();
      const id = `docs-h-${context.counter++}`;
      element.id = id;
      appendInline(element, plain, context.options);
      context.headings.push({ level, text: plain, id });
      out.push(element);
      index += 1;
      continue;
    }

    // 表格：当前行有 |，下一行是分隔行
    if (line.includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1])) {
      const header = splitRow(line);
      const align = splitRow(lines[index + 1]).map((cell) =>
        cell.startsWith(':') && cell.endsWith(':') ? 'center'
        : cell.endsWith(':') ? 'right'
        : 'left',
      );
      const table = document.createElement('table');
      table.className = 'docs-table';
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      header.forEach((cell, column) => {
        const th = document.createElement('th');
        th.textContent = cell;
        th.style.textAlign = align[column] ?? 'left';
        headRow.appendChild(th);
      });
      thead.appendChild(headRow);
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        const row = document.createElement('tr');
        splitRow(lines[index]).forEach((cell, column) => {
          const td = document.createElement('td');
          td.style.textAlign = align[column] ?? 'left';
          appendInline(td, cell, context.options);
          row.appendChild(td);
        });
        tbody.appendChild(row);
        index += 1;
      }
      table.appendChild(tbody);
      out.push(table);
      continue;
    }

    // 引用：连续的 > 行作为一段处理
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      const blockquote = document.createElement('blockquote');
      const nested = renderBlocks(quote, context);
      blockquote.append(...nested);
      out.push(blockquote);
      continue;
    }

    // 列表：连续的同类标记算一个列表（-、*、+ 或 数字.），支持任务列表与续行缩进
    const bullet = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      const ordered = /\d/.test(bullet[1]);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      while (index < lines.length) {
        const item = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[index]);
        if (!item || /\d/.test(item[1]) !== ordered) break;
        let body = item[2];
        index += 1;
        // 续行：缩进且不是新条目，拼到同一项里
        while (
          index < lines.length &&
          lines[index].trim() &&
          /^\s{2,}/.test(lines[index]) &&
          !/^\s*([-*+]|\d+[.)])\s+/.test(lines[index])
        ) {
          body += ` ${lines[index].trim()}`;
          index += 1;
        }
        const li = document.createElement('li');
        const task = /^\[([ xX])\]\s+(.*)$/.exec(body);
        if (task) {
          const box = document.createElement('span');
          box.className = 'docs-task';
          box.textContent = task[1].toLowerCase() === 'x' ? '☑' : '☐';
          li.append(box, document.createTextNode(' '));
          appendInline(li, task[2], context.options);
        } else {
          appendInline(li, body, context.options);
        }
        list.appendChild(li);
      }
      out.push(list);
      continue;
    }

    // 段落：吃到一个空行为止
    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^(#{1,6})\s/.test(lines[index]) &&
      !/^\s*>/.test(lines[index]) &&
      !/^\s*(`{3,}|~{3,})/.test(lines[index]) &&
      !/^\s*([-*+]|\d+[.)])\s+/.test(lines[index]) &&
      !(lines[index].includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1]))
    ) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    const p = document.createElement('p');
    appendInline(p, paragraph.join(' '), context.options);
    out.push(p);
  }

  return out;
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes('-');
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

// ----------------------------------------------------------------- 行内解析

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~~[^~]+~~)|(!?\[[^\]]*\]\([^)\s]+\))/g;

function appendInline(parent: HTMLElement, text: string, options: RenderOptions): void {
  let cursor = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > cursor) parent.appendChild(document.createTextNode(text.slice(cursor, start)));
    parent.appendChild(inlineNode(match[0], options));
    cursor = start + match[0].length;
  }
  if (cursor < text.length) parent.appendChild(document.createTextNode(text.slice(cursor)));
}

function inlineNode(token: string, options: RenderOptions): Node {
  if (token.startsWith('`')) {
    const code = document.createElement('code');
    code.textContent = token.slice(1, -1);
    return code;
  }
  if (token.startsWith('**') || token.startsWith('__')) {
    const strong = document.createElement('strong');
    strong.textContent = token.slice(2, -2);
    return strong;
  }
  if (token.startsWith('~~')) {
    const del = document.createElement('del');
    del.textContent = token.slice(2, -2);
    return del;
  }
  if (token.startsWith('*') || token.startsWith('_')) {
    const em = document.createElement('em');
    em.textContent = token.slice(1, -1);
    return em;
  }
  // 链接 / 图片
  const isImage = token.startsWith('!');
  const body = isImage ? token.slice(1) : token;
  const split = body.indexOf('](');
  const label = body.slice(1, split);
  const href = body.slice(split + 2, -1);

  if (isImage && SAFE_EXTERNAL.test(href)) {
    const img = document.createElement('img');
    img.src = href;
    img.alt = label;
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.className = 'docs-image';
    return img;
  }

  // 站内文档互链：解析得到 id 就渲染成可点击的文档跳转
  const target = options.resolveDocLink?.(href);
  if (target !== undefined) {
    const link = document.createElement('a');
    link.href = `#/doc/${target}`;
    link.className = 'docs-internal-link';
    link.dataset.docId = String(target);
    link.textContent = label;
    return link;
  }

  if (SAFE_EXTERNAL.test(href)) {
    const link = document.createElement('a');
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer nofollow';
    link.textContent = label;
    return link;
  }

  // 相对路径（多半指向资料目录里的图片或未收录的文件）：不做猜测，按文本显示
  const span = document.createElement('span');
  span.className = 'docs-unsafe-link';
  span.textContent = isImage ? `[图片：${label}]` : `${label}（${href}）`;
  span.title = '这个链接指向站外或未收录的资源，未做跳转';
  return span;
}
