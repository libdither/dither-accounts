/**
 * A long-form post's HTML as the Markdown of `PostFact.article` (feed.ts): what a Substack post or a LessWrong post
 * says, in a form dither-chat draws in its own theme. Pure, no DOM: it runs in an extractor.
 *
 * Kept: paragraphs, headings, bold, italic, strikethrough, inline and block code, links, pictures (with their caption
 * under them), quotes, lists (nested), tables (GitHub's pipes), rules and line breaks. A video or frame becomes a link
 * to it. Dropped with everything inside: scripts, styles, forms and their buttons, svg, math markup a renderer would
 * need (its text alternative stays where there is one), and whatever `drop` matches (a site's subscribe boxes and
 * share buttons). Links and pictures are http(s) only; anything else keeps its words and loses the link.
 */

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
/** Elements dropped with all they hold. */
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'title', 'form', 'button', 'input', 'select', 'textarea', 'svg', 'math', 'object', 'canvas', 'dialog', 'nav', 'audio']);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'figure', 'figcaption', 'blockquote', 'ul', 'ol', 'li', 'pre', 'hr', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'dl', 'dt', 'dd', 'details', 'summary', 'iframe', 'video', 'picture']);
/** An open element closed by the start of one of these (HTML's implied end tags, the common cases). */
const CLOSED_BY: Record<string, Set<string>> = {
  p: new Set(['p', 'div', 'ul', 'ol', 'blockquote', 'pre', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'figure', 'hr', 'section']),
  li: new Set(['li']),
  dt: new Set(['dt', 'dd']),
  dd: new Set(['dt', 'dd']),
  tr: new Set(['tr']),
  td: new Set(['td', 'th', 'tr']),
  th: new Set(['td', 'th', 'tr']),
};

interface El {
  tag: string;
  attrs: Record<string, string>;
  kids: Node[];
}
type Node = El | string;

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘',
  rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', times: '×', laquo: '«',
  raquo: '»', zwj: '‍', zwnj: '‌', shy: '',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function parseAttrs(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (let m; (m = re.exec(src)); ) out[m[1]!.toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}

/** The HTML as a tree, forgiving as a browser is of what is left open or closed twice. */
export function parseHtml(html: string): El {
  const root: El = { tag: '#root', attrs: {}, kids: [] };
  const stack: El[] = [root];
  const top = () => stack[stack.length - 1]!;
  const re = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[^>]*>|<\/\s*([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+|<)/g;
  for (let m; (m = re.exec(html)); ) {
    if (m[4] !== undefined) {
      top().kids.push(decodeEntities(m[4]));
    } else if (m[2]) {
      const tag = m[2].toLowerCase();
      while (stack.length > 1 && CLOSED_BY[top().tag]?.has(tag)) stack.pop();
      const el: El = { tag, attrs: parseAttrs(m[3] ?? ''), kids: [] };
      top().kids.push(el);
      if (SKIP.has(tag) && !VOID.has(tag) && !/\/\s*$/.test(m[3] ?? '')) {
        // Raw text up to its own end tag: nothing inside is read as markup.
        const end = html.toLowerCase().indexOf(`</${tag}`, re.lastIndex);
        re.lastIndex = end < 0 ? html.length : end;
        continue;
      }
      if (!VOID.has(tag) && !/\/\s*$/.test(m[3] ?? '')) stack.push(el);
    } else if (m[1]) {
      const tag = m[1].toLowerCase();
      const at = stack.map((e) => e.tag).lastIndexOf(tag);
      if (at > 0) stack.length = at;
    }
  }
  return root;
}

export interface ArticleOpts {
  /** Elements to leave out with what they hold (a site's subscribe box, share buttons, its own footnote back links). */
  drop?: (el: { tag: string; attrs: Record<string, string> }) => boolean;
  /** Where relative links and pictures point from (the post's own address). */
  base?: string;
  /** The longest the result may be; longer is cut at a paragraph with a line saying so. Default 200 000. */
  max?: number;
}

const httpUrl = (raw: string | undefined, base?: string): string | null => {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim(), base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
};

/** Characters Markdown would read as markup, escaped in plain words. */
const escText = (s: string) => s.replace(/([\\`*_[\]<>~|])/g, '\\$1');
/** A line that would start a heading, quote, list or rule otherwise. */
const escLineStart = (s: string) => s.replace(/^(\s*)([#>+-]|\d+[.)])(?=\s|$)/gm, '$1\\$2').replace(/^(\s*)(=+|-{3,})\s*$/gm, '$1\\$2');
const urlPart = (u: string) => u.replace(/[()<> ]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));

/** A picture's address: its src, else the first in its srcset, else a lazy loader's data-src. */
function imgSrc(el: El, base?: string): string | null {
  const a = el.attrs;
  return httpUrl(a.src, base) ?? httpUrl(a['data-src'], base) ?? httpUrl((a.srcset ?? a['data-srcset'] ?? '').split(',')[0]?.trim().split(/\s+/)[0], base);
}

function textOf(n: Node): string {
  return typeof n === 'string' ? n : n.kids.map(textOf).join('');
}

export function htmlToMarkdown(html: string | null | undefined, o: ArticleOpts = {}): string {
  if (!html) return '';
  const max = o.max ?? 200_000;
  const keep = (el: El) => !SKIP.has(el.tag) && !(o.drop && o.drop(el));

  /** Inline content: words with their emphasis and links, whitespace as one space. */
  const inline = (nodes: Node[], inLink = false): string => {
    let out = '';
    for (const n of nodes) {
      if (typeof n === 'string') {
        out += escText(n.replace(/[\s ]+/g, (w) => (w.includes(' ') && !/[\t\n\r ]/.test(w) ? ' ' : ' ')));
        continue;
      }
      // Math: its TeX, from MathML's alttext or MathJax's rendered span (aria-label), instead of its glyphs.
      const tex = n.tag === 'math' ? n.attrs.alttext : /\bmjx-math\b/.test(n.attrs.class ?? '') ? n.attrs['aria-label'] : undefined;
      if (tex) {
        out += `$${tex.replace(/\s+/g, ' ').trim()}$`;
        continue;
      }
      if (!keep(n) || /\bMJX_Assistive_MathML\b/.test(n.attrs.class ?? '')) continue;
      const inner = () => inline(n.kids, inLink);
      switch (n.tag) {
        case 'br':
          out += '  \n';
          break;
        case 'strong':
        case 'b':
          out += wrap(inner(), '**');
          break;
        case 'em':
        case 'i':
        case 'cite':
          out += wrap(inner(), '*');
          break;
        case 's':
        case 'del':
        case 'strike':
          out += wrap(inner(), '~~');
          break;
        case 'code':
        case 'kbd':
        case 'samp': {
          const t = textOf(n).replace(/\s+/g, ' ');
          if (!t.trim()) break;
          const ticks = '`'.repeat(Math.max(1, ...Array.from(t.matchAll(/`+/g), (m) => m[0].length + 1)));
          out += `${ticks}${/^`|`$/.test(t) ? ' ' : ''}${t}${/^`|`$/.test(t) ? ' ' : ''}${ticks}`;
          break;
        }
        case 'a': {
          const href = httpUrl(n.attrs.href, o.base);
          const words = inline(n.kids, true);
          if (!words.trim()) break;
          out += href && !inLink ? `[${words.trim()}](${urlPart(href)})` : words;
          break;
        }
        case 'img': {
          const src = imgSrc(n, o.base);
          if (src) out += `![${escText((n.attrs.alt ?? '').replace(/\s+/g, ' ').trim())}](${urlPart(src)})`;
          break;
        }
        default:
          out += inner();
      }
    }
    return out;
  };
  const wrap = (s: string, mark: string) => {
    const m = s.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
    return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : s;
  };

  /** Block content: a list of blocks, each a run of Markdown lines. */
  const blocks = (nodes: Node[], listDepth = 0): string[] => {
    const out: string[] = [];
    let run: Node[] = [];
    const flush = () => {
      const t = escLineStart(
        inline(run)
          .replace(/[ \t]*\n[ \t]*/g, (m) => (m.includes('  \n') ? '  \n' : '\n'))
          .replace(/^[ \t]+|[ \t]+$/g, '')
          .replace(/ {2,}(?!\n)/g, ' '),
      ).trim();
      if (t) out.push(t);
      run = [];
    };
    for (const n of nodes) {
      if (typeof n === 'string' || !BLOCK.has(n.tag)) {
        if (typeof n !== 'string' && n.tag === 'img' && keep(n)) {
          // A picture on its own is a block of its own.
          flush();
          const s = inline([n]);
          if (s) out.push(s);
          continue;
        }
        run.push(n);
        continue;
      }
      flush();
      if (!keep(n)) continue;
      const m = n.tag.match(/^h([1-6])$/);
      if (m) {
        const t = inline(n.kids).replace(/\s+/g, ' ').trim();
        if (t) out.push(`${'#'.repeat(+m[1]!)} ${t}`);
        continue;
      }
      switch (n.tag) {
        case 'hr':
          out.push('---');
          break;
        case 'pre': {
          const code = textOf(n).replace(/\n$/, '');
          const fence = '`'.repeat(Math.max(3, ...Array.from(code.matchAll(/`{3,}/g), (x) => x[0].length + 1)));
          const lang = (n.attrs.class ?? (n.kids.find((k): k is El => typeof k !== 'string' && k.tag === 'code')?.attrs.class ?? '')).match(/language-([\w+-]+)/)?.[1] ?? '';
          if (code.trim()) out.push(`${fence}${lang}\n${code}\n${fence}`);
          break;
        }
        case 'blockquote': {
          const inner = blocks(n.kids, listDepth).join('\n\n');
          if (inner) out.push(inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n'));
          break;
        }
        case 'ul':
        case 'ol': {
          let i = Number.parseInt(n.attrs.start ?? '1', 10);
          if (!Number.isFinite(i)) i = 1;
          const items: string[] = [];
          for (const li of n.kids) {
            if (typeof li === 'string') {
              if (li.trim()) items.push(`${n.tag === 'ol' ? `${i++}.` : '-'} ${escText(li.trim())}`);
              continue;
            }
            if (!keep(li)) continue;
            const marker = n.tag === 'ol' ? `${i++}.` : '-';
            const body = blocks(li.tag === 'li' ? li.kids : [li], listDepth + 1).join('\n\n');
            const pad = ' '.repeat(marker.length + 1);
            items.push(`${marker} ${body.split('\n').map((l, j) => (j && l ? pad + l : l)).join('\n')}`);
          }
          if (items.length) out.push(items.join('\n'));
          break;
        }
        case 'table': {
          const rows: string[][] = [];
          const walk = (e: El) => {
            for (const k of e.kids) {
              if (typeof k === 'string' || !keep(k)) continue;
              if (k.tag === 'tr') rows.push(k.kids.filter((c): c is El => typeof c !== 'string' && (c.tag === 'td' || c.tag === 'th')).map((c) => blocks(c.kids).join(' ').replace(/\n+/g, ' ')));
              else walk(k);
            }
          };
          walk(n);
          const w = Math.max(0, ...rows.map((r) => r.length));
          if (!w) break;
          const line = (r: string[]) => `| ${Array.from({ length: w }, (_, j) => r[j] ?? '').join(' | ')} |`;
          out.push([line(rows[0]!), `|${' --- |'.repeat(w)}`, ...rows.slice(1).map(line)].join('\n'));
          break;
        }
        case 'iframe':
        case 'video': {
          const src = httpUrl(n.attrs.src, o.base) ?? httpUrl(n.kids.find((k): k is El => typeof k !== 'string' && k.tag === 'source')?.attrs.src, o.base);
          if (src) out.push(`[${n.tag === 'video' ? 'Video' : 'Embedded'}: ${escText(new URL(src).host)}](${urlPart(src)})`);
          break;
        }
        case 'figure':
        case 'picture': {
          const inner = blocks(n.kids, listDepth);
          out.push(...inner);
          break;
        }
        case 'figcaption': {
          const t = inline(n.kids).replace(/\s+/g, ' ').trim();
          if (t) out.push(`_${t}_`);
          break;
        }
        default:
          out.push(...blocks(n.kids, listDepth));
      }
    }
    flush();
    return out;
  };

  let md = blocks(parseHtml(html).kids).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  if (md.length > max) {
    const cut = md.lastIndexOf('\n\n', max);
    md = `${md.slice(0, cut > max / 2 ? cut : max).trimEnd()}\n\n*(The rest is too long to show here: open it on the site.)*`;
  }
  return md;
}

/** Plain words of an article's HTML, for a card's preview: the first paragraphs, up to `max` characters. */
export function htmlPreview(html: string | null | undefined, max = 600): string {
  if (!html) return '';
  const md = htmlToMarkdown(html, { max: max * 4 });
  const plain = md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#+\s|^>\s?|[*_~`]|\\(?=.)/gm, '')
    .replace(/\n{2,}/g, '\n\n')
    .trim();
  if (plain.length <= max) return plain;
  const cut = plain.lastIndexOf(' ', max);
  return `${plain.slice(0, cut > max / 2 ? cut : max)}…`;
}
