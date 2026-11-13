/**
 * Matrix message bodies <-> the canonical body (protocol MessageFact.body):
 * a Discord-flavoured Markdown subset with mentions as <@nativeId>, so a
 * Matrix user mention is `<@@user:server>` and a room is `<#!room:server>`.
 *
 * Incoming: `formatted_body` (org.matrix.custom.html) is converted, text nodes
 * escaped so literal `*` or `__` don't turn into formatting; a plain `body` is
 * passed through, since Matrix clients put the Markdown the user typed there.
 * Outgoing: canonical Markdown becomes `body` (pills replaced by names) plus
 * `formatted_body` when there is any formatting or mention.
 */

// ------------------------------------------------------------------ HTML parsing

interface El {
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
}
type Node = El | string;

const VOID = new Set(['br', 'hr', 'img', 'wbr', 'input', 'meta', 'link', 'source', 'col', 'area', 'base', 'embed', 'param', 'track']);

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  middot: '·',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  times: '×',
  shy: '',
  zwj: '‍',
  zwnj: '‌',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (all, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : all;
    }
    return NAMED[e] ?? NAMED[e.toLowerCase()] ?? all;
  });
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}

/** A forgiving parser for the small HTML subset Matrix clients send. */
export function parseHtml(html: string): El {
  const root: El = { tag: '#root', attrs: {}, children: [] };
  const stack: El[] = [root];
  const top = () => stack[stack.length - 1];
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m.index > last) top().children.push(decodeEntities(html.slice(last, m.index)));
    last = re.lastIndex;
    if (m[0].startsWith('<!--')) continue;
    const tag = m[2].toLowerCase();
    if (m[1]) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    if ((tag === 'li' && top().tag === 'li') || (tag === 'p' && top().tag === 'p')) stack.pop();
    const el: El = { tag, attrs: parseAttrs(m[3] ?? ''), children: [] };
    top().children.push(el);
    if (!VOID.has(tag) && !m[4]) stack.push(el);
  }
  if (last < html.length) top().children.push(decodeEntities(html.slice(last)));
  return root;
}

function textContent(n: Node): string {
  if (typeof n === 'string') return n;
  if (n.tag === 'br') return '\n';
  if (n.tag === 'mx-reply') return '';
  return n.children.map(textContent).join('');
}

// ------------------------------------------------------------------ links

export type MatrixLink = { kind: 'user' | 'room' | 'alias'; id: string; event?: string };

/** https://matrix.to/#/@u:s, https://matrix.to/#/!r:s/$e?via=s, matrix:u/u:s, matrix:roomid/r:s/e/e */
export function parseMatrixLink(href: string): MatrixLink | null {
  const dec = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  let m = href.match(/^https?:\/\/matrix\.to\/#\/([^?]+)/i);
  if (m) {
    const [first, second] = m[1].split('/').map(dec);
    if (!first) return null;
    const kind = first[0] === '@' ? 'user' : first[0] === '!' ? 'room' : first[0] === '#' ? 'alias' : null;
    return kind ? { kind, id: first, ...(second && second[0] === '$' ? { event: second } : {}) } : null;
  }
  m = href.match(/^matrix:(u|user|roomid|r|room)\/([^?#/]+)(?:\/e\/([^?#/]+))?/i);
  if (m) {
    const t = m[1].toLowerCase();
    const id = dec(m[2]);
    const event = m[3] ? '$' + dec(m[3]) : undefined;
    if (t === 'u' || t === 'user') return { kind: 'user', id: '@' + id };
    if (t === 'roomid') return { kind: 'room', id: '!' + id, ...(event ? { event } : {}) };
    return { kind: 'alias', id: '#' + id };
  }
  return null;
}

// ------------------------------------------------------------------ HTML -> canonical Markdown

const isWord = (c: string) => !!c && /[\p{L}\p{N}]/u.test(c);
const URL_RE = /\b(?:https?:\/\/|mailto:|matrix:)[^\s<>"]+/g;

function escapeChunk(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const prev = s[i - 1] ?? '';
    const next = s[i + 1] ?? '';
    if (c === '\\' && /[\\*_~`|<>]/.test(next)) out += '\\\\';
    else if (c === '*' || c === '`') out += '\\' + c;
    else if (c === '~' && (next === '~' || prev === '~')) out += '\\~';
    else if (c === '|' && (next === '|' || prev === '|')) out += '\\|';
    else if (c === '_' && (!isWord(prev) || !isWord(next))) out += '\\_';
    else if (c === '<' && (next === '@' || next === '#')) out += '\\<';
    else out += c;
  }
  return out;
}

/** Escape text so it renders literally in the canonical Markdown subset. URLs are left intact. */
export function escapeMarkdown(s: string): string {
  let out = '';
  let last = 0;
  for (const m of s.matchAll(URL_RE)) {
    out += escapeChunk(s.slice(last, m.index));
    out += m[0];
    last = m.index! + m[0].length;
  }
  return out + escapeChunk(s.slice(last));
}

interface Ctx {
  /** Finished blocks (code, lists) kept out of whitespace normalization, referenced as \0<n>\0. */
  pre: string[];
}

const BLOCK = (s: string) => `\n${s}\n`;

function protect(ctx: Ctx, block: string): string {
  ctx.pre.push(block);
  return BLOCK(`\u0000${ctx.pre.length - 1}\u0000`);
}

/** Put protected blocks back; continuation lines inherit the indentation or quote prefix of the placeholder. */
function expand(out: string, pre: string[]): string {
  for (let k = 0; k < 32 && out.includes('\u0000'); k++) {
    const next = out.replace(/^([ \t>]*)\u0000(\d+)\u0000/gm, (_, prefix: string, i: string) =>
      (pre[Number(i)] ?? '')
        .split('\n')
        .map((l) => (prefix + l).replace(/^(>+) $/, '$1'))
        .join('\n'),
    );
    // Only placeholders in the middle of a line are left: insert them as-is.
    out = next !== out ? next : out.replace(/\u0000(\d+)\u0000/, (_, i: string) => pre[Number(i)] ?? '');
  }
  return out;
}

function wrap(inner: string, mark: string): string {
  const m = inner.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
  if (!m[2]) return inner;
  return `${m[1]}${mark}${m[2]}${mark}${m[3]}`;
}

function renderChildren(el: El, ctx: Ctx): string {
  return el.children.map((c) => render(c, ctx)).join('');
}

function render(n: Node, ctx: Ctx): string {
  if (typeof n === 'string') return escapeMarkdown(n.replace(/[ \t\r\n\f]+/g, ' '));
  switch (n.tag) {
    case 'mx-reply':
    case 'head':
    case 'style':
    case 'script':
      return '';
    case 'br':
      return '\n';
    case 'hr':
      return BLOCK('---');
    case 'p':
      return `\n\n${renderChildren(n, ctx)}\n\n`;
    case 'div':
    case 'section':
    case 'article':
    case 'caption':
    case 'summary':
    case 'details':
      return BLOCK(renderChildren(n, ctx));
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return BLOCK(wrap(renderChildren(n, ctx).trim(), '**'));
    case 'strong':
    case 'b':
      return wrap(renderChildren(n, ctx), '**');
    case 'em':
    case 'i':
    case 'cite':
      return wrap(renderChildren(n, ctx), '*');
    case 'u':
    case 'ins':
      return wrap(renderChildren(n, ctx), '__');
    case 'del':
    case 's':
    case 'strike':
      return wrap(renderChildren(n, ctx), '~~');
    case 'span':
    case 'font':
      if ('data-mx-spoiler' in n.attrs) return wrap(renderChildren(n, ctx), '||');
      return renderChildren(n, ctx);
    case 'code': {
      const raw = textContent(n);
      if (!raw) return '';
      return raw.includes('`') ? `\`\` ${raw} \`\`` : `\`${raw}\``;
    }
    case 'pre': {
      const code = n.children.find((c): c is El => typeof c !== 'string' && c.tag === 'code');
      const lang = (code?.attrs.class ?? '').match(/language-([\w+#.-]+)/)?.[1] ?? '';
      const raw = textContent(code ?? n).replace(/\n+$/, '');
      return protect(ctx, '```' + lang + '\n' + raw + '\n```');
    }
    case 'blockquote': {
      const inner = normalize(renderChildren(n, ctx));
      return BLOCK(inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n'));
    }
    case 'ul':
    case 'ol': {
      let i = Number(n.attrs.start ?? '1') || 1;
      const lines: string[] = [];
      for (const c of n.children) {
        if (typeof c === 'string') continue;
        const item = normalize(c.tag === 'li' ? renderChildren(c, ctx) : render(c, ctx));
        if (!item) continue;
        const bullet = n.tag === 'ol' ? `${i++}.` : '-';
        lines.push(`${bullet} ${item.replace(/\n/g, '\n  ')}`);
      }
      // Protected like <pre>: normalize() would strip the nested indentation.
      return protect(ctx, lines.join('\n'));
    }
    case 'li':
      return BLOCK(`- ${normalize(renderChildren(n, ctx))}`);
    case 'table':
    case 'thead':
    case 'tbody':
    case 'tfoot':
      return BLOCK(renderChildren(n, ctx));
    case 'tr':
      return BLOCK(
        n.children
          .filter((c): c is El => typeof c !== 'string')
          .map((c) => normalize(renderChildren(c, ctx)))
          .join(' | '),
      );
    case 'img': {
      const alt = n.attrs.alt || n.attrs.title || '';
      if ('data-mx-emoticon' in n.attrs) return alt ? `:${alt.replace(/^:|:$/g, '')}:` : '';
      return escapeMarkdown(alt || '[image]');
    }
    case 'a': {
      const href = (n.attrs.href ?? '').trim();
      const inner = renderChildren(n, ctx);
      const mx = parseMatrixLink(href);
      if (mx?.kind === 'user') return `<@${mx.id}>`;
      if (mx?.kind === 'room' && !mx.event) return `<#${mx.id}>`;
      if (!href || !/^(https?:|mailto:|matrix:)/i.test(href)) return inner;
      const shown = textContent(n).trim();
      if (!shown || shown === href || shown === href.replace(/^(https?:\/\/|mailto:)/i, '')) return href;
      return `[${inner.trim()}](${href.replace(/\)/g, '%29').replace(/ /g, '%20')})`;
    }
    default:
      return renderChildren(n, ctx);
  }
}

function normalize(s: string): string {
  return s
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function htmlToMarkdown(html: string): string {
  const ctx: Ctx = { pre: [] };
  return expand(normalize(render(parseHtml(html), ctx)), ctx.pre);
}

/** Plain text of an HTML body (for names and previews). */
export function htmlToText(html: string): string {
  return textContent(parseHtml(html));
}

/**
 * Strip the legacy reply fallback from a plain body: leading "> " lines, then
 * a blank line. Only call this when the event has m.in_reply_to.
 */
export function stripReplyFallback(body: string): string {
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].startsWith('>')) i++;
  if (i === 0 || i >= lines.length || lines[i].trim() !== '') return body;
  return lines.slice(i + 1).join('\n');
}

/** A one-line plain snippet, e.g. for thread names. Mention tokens become names. */
export function snippet(text: string, max = 60, name: (userId: string) => string = (u) => u): string {
  const t = text
    .replace(/<@([^>\s]+)>/g, (_, id: string) => name(id))
    .replace(/<#([^>\s]+)>/g, (_, id: string) => id)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\\([\\*_~`|<>])/g, '$1')
    .replace(/(\*\*|__|~~|\|\||`)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
}

// ------------------------------------------------------------------ canonical Markdown -> Matrix

export interface OutgoingBody {
  body: string;
  formatted?: string;
  /** User ids mentioned with <@...> tokens. */
  mentions: string[];
}

export interface NameResolver {
  user(id: string): string | undefined;
  room(id: string): string | undefined;
}

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface InlineOut {
  html: string;
  formatted: boolean;
}

/** Find the closing delimiter, skipping escapes and code spans. */
function findClose(s: string, from: number, delim: string): number {
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '`') {
      let n = 1;
      while (s[i + n] === '`') n++;
      const close = s.indexOf('`'.repeat(n), i + n);
      if (close > 0) {
        i = close + n - 1;
        continue;
      }
    }
    if (s.startsWith(delim, i)) {
      if (delim.length === 1 && (s[i + 1] === delim || s[i - 1] === delim)) {
        // part of a double delimiter (e.g. ** inside *...*): skip it
        if (s[i + 1] === delim) i++;
        continue;
      }
      if (i === from) continue;
      if (/\s/.test(s[i - 1])) continue;
      if (delim === '_' && isWord(s[i + 1] ?? '')) continue;
      return i;
    }
  }
  return -1;
}

const PAIRS: [string, string, string][] = [
  ['**', '<strong>', '</strong>'],
  ['__', '<u>', '</u>'],
  ['~~', '<del>', '</del>'],
  ['||', '<span data-mx-spoiler>', '</span>'],
  ['*', '<em>', '</em>'],
  ['_', '<em>', '</em>'],
];

function inline(s: string, names: NameResolver, mentions: Set<string>): InlineOut {
  let html = '';
  let formatted = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && /[\\*_~`|<>#\[\]()!-]/.test(s[i + 1])) {
      html += escHtml(s[i + 1]);
      i += 2;
      continue;
    }
    if (c === '`') {
      let n = 1;
      while (s[i + n] === '`') n++;
      const close = s.indexOf('`'.repeat(n), i + n);
      if (close > i + n - 1) {
        let code = s.slice(i + n, close);
        if (n > 1 && code.startsWith(' ') && code.endsWith(' ')) code = code.slice(1, -1);
        html += `<code>${escHtml(code)}</code>`;
        formatted = true;
        i = close + n;
        continue;
      }
    }
    if (c === '<') {
      const m = s.slice(i).match(/^<([@#])([^>\s]+)>/);
      if (m) {
        const id = m[2];
        if (m[1] === '@' && id.startsWith('@')) {
          mentions.add(id);
          html += `<a href="https://matrix.to/#/${escHtml(id)}">${escHtml(names.user(id) ?? id)}</a>`;
          formatted = true;
          i += m[0].length;
          continue;
        }
        if (m[1] === '#' && (id.startsWith('!') || id.startsWith('#'))) {
          const label = names.room(id);
          html += `<a href="https://matrix.to/#/${escHtml(id)}">${escHtml(label ? `#${label}` : id)}</a>`;
          formatted = true;
          i += m[0].length;
          continue;
        }
      }
    }
    if (c === '[') {
      const m = s.slice(i).match(/^\[([^\]\n]+)\]\(((?:https?:|mailto:|matrix:)[^)\s]+)\)/);
      if (m) {
        const inner = inline(m[1], names, mentions);
        html += `<a href="${escHtml(m[2])}">${inner.html}</a>`;
        formatted = true;
        i += m[0].length;
        continue;
      }
    }
    let matched = false;
    for (const [delim, open, close] of PAIRS) {
      if (!s.startsWith(delim, i)) continue;
      if (delim.length === 1 && s[i + 1] === delim) continue;
      if (delim === '_' && isWord(s[i - 1] ?? '')) continue;
      const start = i + delim.length;
      if (start >= s.length || /\s/.test(s[start])) continue;
      const end = findClose(s, start, delim);
      if (end < 0) continue;
      const inner = inline(s.slice(start, end), names, mentions);
      html += open + inner.html + close;
      formatted = true;
      i = end + delim.length;
      matched = true;
      break;
    }
    if (matched) continue;
    html += escHtml(c);
    i++;
  }
  return { html, formatted };
}

/** Canonical Markdown -> Matrix m.text content parts. */
export function markdownToMatrix(md: string, names: NameResolver): OutgoingBody {
  const text = md.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  const mentions = new Set<string>();
  const parts: string[] = [];
  let formatted = false;

  const segments: { code?: string; lang?: string; text?: string }[] = [];
  let last = 0;
  for (const m of text.matchAll(/```([\w+#.-]*)\n?([\s\S]*?)```/g)) {
    if (m.index! > last) segments.push({ text: text.slice(last, m.index) });
    segments.push({ code: m[2].replace(/\n$/, ''), lang: m[1] });
    last = m.index! + m[0].length;
  }
  if (last < text.length) segments.push({ text: text.slice(last) });

  for (const seg of segments) {
    if (seg.code !== undefined) {
      parts.push(`<pre><code${seg.lang ? ` class="language-${escHtml(seg.lang)}"` : ''}>${escHtml(seg.code)}\n</code></pre>`);
      formatted = true;
      continue;
    }
    let lines = seg.text!.split('\n');
    // Newlines that only separate a fenced block from text are not line breaks.
    if (lines[0] === '' && parts.length) lines = lines.slice(1);
    if (lines.length && lines[lines.length - 1] === '') lines = lines.slice(0, -1);
    let quote: string[] = [];
    let row: string[] = [];
    const flushRow = () => {
      if (row.length) parts.push(row.join('<br />'));
      row = [];
    };
    const flushQuote = () => {
      if (!quote.length) return;
      const inner = quote.map((l) => inline(l, names, mentions).html).join('<br />');
      parts.push(`<blockquote>${inner}</blockquote>`);
      formatted = true;
      quote = [];
    };
    for (const line of lines) {
      const q = line.match(/^>\s?(.*)$/);
      if (q) {
        flushRow();
        quote.push(q[1]);
        continue;
      }
      flushQuote();
      const r = inline(line, names, mentions);
      if (r.formatted) formatted = true;
      row.push(r.html);
    }
    flushQuote();
    flushRow();
  }

  const body = text
    .replace(/<@(@[^>\s]+)>/g, (_, id: string) => names.user(id) ?? id)
    .replace(/<#([!#][^>\s]+)>/g, (_, id: string) => {
      const n = names.room(id);
      return n ? `#${n}` : id;
    });
  return { body, ...(formatted ? { formatted: parts.join('') } : {}), mentions: [...mentions] };
}
