/**
 * Telegram text + entities <-> dither-chat canonical Markdown (protocol MessageFact.body):
 *   **bold** *italic* __underline__ ~~strike~~ `code` ```fenced``` ||spoiler|| > quote, [text](url), <@userId>
 *
 * Telegram's entities count UTF-16 code units, as JS strings do, and may overlap freely; Markdown needs nesting. So
 * fromTelegram() normalises the way the Signal extractor does: same-style spans merged, emphasis split at newlines
 * and trimmed of edge whitespace, nothing starting or ending inside an atomic piece (code, a link, a mention).
 * Links, hashtags and the like are text already and stay as they are; a plain @username stays too, unless it names a
 * user this account knows (`userByName`): then it is that user's mention, <@id>, as a mention by name is.
 */

/** The fields of a tl.TypeMessageEntity this reads. */
export interface TgEntity {
  _: string;
  offset: number;
  length: number;
  url?: string;
  language?: string;
  userId?: number | { toString(): string };
}

type Style = 'bold' | 'italic' | 'underline' | 'strike' | 'spoiler';
const STYLE_OF: Record<string, Style> = {
  messageEntityBold: 'bold',
  messageEntityItalic: 'italic',
  messageEntityUnderline: 'underline',
  messageEntityStrike: 'strike',
  messageEntitySpoiler: 'spoiler',
};
const STYLES: readonly Style[] = ['bold', 'italic', 'underline', 'strike', 'spoiler'];
const MARK: Record<Style, string> = { bold: '**', italic: '*', underline: '__', strike: '~~', spoiler: '||' };

interface Span {
  style: Style;
  s: number;
  e: number;
}
interface Atom {
  s: number;
  e: number;
  out: string;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.trunc(Number.isFinite(n) ? n : 0)));
const isWs = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ' ';

export interface FromOptions {
  /** Each user mentioned by name (messageEntityMentionName), or by a username `userByName` knows. */
  onMention?: (userId: string) => void;
  /** The id of the user with this @username (without the @), when this account knows them. */
  userByName?: (username: string) => string | null | undefined;
}

/** Telegram text + entities -> canonical Markdown. */
export function fromTelegram(text: string | null | undefined, entities?: readonly TgEntity[] | null, opts: FromOptions = {}): string {
  const src = text ?? '';
  const len = src.length;
  if (!len) return '';
  const ents = [...(entities ?? [])].map((e) => ({ ...e, s: clamp(e.offset, 0, len), e: clamp(e.offset + e.length, 0, len) })).filter((e) => e.e > e.s);

  // Atomic pieces: code, pre, text links and name mentions. Non-overlapping, first come first served.
  const atoms: Atom[] = [];
  for (const e of [...ents].sort((a, b) => a.s - b.s || b.e - a.e)) {
    const body = src.slice(e.s, e.e);
    let out: string | null = null;
    if (e._ === 'messageEntityCode') out = body.includes('`') ? '```\n' + body + '\n```' : '`' + body + '`';
    else if (e._ === 'messageEntityPre') out = '```' + (e.language && /^[\w+-]+$/.test(e.language) ? e.language : '') + '\n' + body.replace(/\n$/, '') + '\n```';
    else if (e._ === 'messageEntityTextUrl' && e.url) out = body === e.url ? e.url : `[${body.replace(/[[\]]/g, '')}](${e.url})`;
    else if (e._ === 'messageEntityMentionName' && e.userId !== undefined) {
      const id = e.userId.toString();
      opts.onMention?.(id);
      out = `<@${id}>`;
    } else if (e._ === 'messageEntityMention' && opts.userByName) {
      const id = /^@\w{1,32}$/.test(body) ? opts.userByName(body.slice(1)) : null;
      if (id) {
        opts.onMention?.(id);
        out = `<@${id}>`;
      }
    }
    if (out === null) continue;
    if (atoms.length && e.s < atoms[atoms.length - 1].e) continue;
    atoms.push({ s: e.s, e: e.e, out });
  }

  const spans = normalise(src, ents, atoms);
  const quotes = ents.filter((e) => e._ === 'messageEntityBlockquote').map((e) => [e.s, e.e] as const);
  return emit(src, spans, atoms, quotes);
}

function normalise(src: string, ents: { _: string; s: number; e: number }[], atoms: Atom[]): Span[] {
  const byStyle = new Map<Style, [number, number][]>();
  for (const e of ents) {
    const style = STYLE_OF[e._];
    if (!style) continue;
    (byStyle.get(style) ?? byStyle.set(style, []).get(style)!).push([e.s, e.e]);
  }
  const merged: Span[] = [];
  for (const [style, list] of byStyle) {
    list.sort((a, b) => a[0] - b[0]);
    let cur: [number, number] | null = null;
    for (const iv of list) {
      if (cur && iv[0] <= cur[1]) cur[1] = Math.max(cur[1], iv[1]);
      else {
        if (cur) merged.push({ style, s: cur[0], e: cur[1] });
        cur = [iv[0], iv[1]];
      }
    }
    if (cur) merged.push({ style, s: cur[0], e: cur[1] });
  }
  // Nothing starts or ends inside an atom: spans inside one go, spans overlapping one are clipped to its edge.
  let clipped = merged;
  for (const a of atoms) {
    const next: Span[] = [];
    for (const r of clipped) {
      if (r.e <= a.s || r.s >= a.e) next.push(r);
      else if (r.s <= a.s && r.e >= a.e) next.push(r);
      else if (r.s >= a.s && r.e <= a.e) continue;
      else if (r.s < a.s) next.push({ ...r, e: a.s });
      else next.push({ ...r, s: a.e });
    }
    clipped = next.filter((r) => r.e > r.s);
  }
  // Emphasis: split at newlines (outside atoms), trimmed of edge whitespace.
  const inAtom = (i: number) => atoms.some((a) => i >= a.s && i < a.e);
  const out: Span[] = [];
  for (const m of clipped) {
    let s = m.s;
    for (let i = m.s; i <= m.e; i++) {
      if (i === m.e || (src[i] === '\n' && !inAtom(i))) {
        let a = s;
        let b = i;
        while (a < b && isWs(src[a]) && !inAtom(a)) a++;
        while (b > a && isWs(src[b - 1]) && !inAtom(b - 1)) b--;
        if (b > a) out.push({ style: m.style, s: a, e: b });
        s = i + 1;
      }
    }
  }
  return out;
}

function emit(src: string, spans: Span[], atoms: Atom[], quotes: (readonly [number, number])[]): string {
  const len = src.length;
  const cuts = new Set<number>([0, len]);
  for (const sp of spans) cuts.add(sp.s).add(sp.e);
  for (const a of atoms) cuts.add(a.s).add(a.e);
  const inAtom = (i: number) => atoms.some((a) => i > a.s && i < a.e);
  const quoted = (p: number) => quotes.some(([s, e]) => p >= s && p < e);
  // Every line start inside a quote is a cut, so it can take its "> ".
  for (const [s, e] of quotes) {
    for (let i = s; i < e; i++) if ((i === s || src[i - 1] === '\n') && !inAtom(i)) cuts.add(i);
  }
  const points = [...cuts].sort((a, b) => a - b);
  const atomAt = new Map(atoms.map((a) => [a.s, a]));
  const starting = new Map<number, Span[]>();
  for (const sp of spans) (starting.get(sp.s) ?? starting.set(sp.s, []).get(sp.s)!).push(sp);
  const order = (a: Span, b: Span) => b.e - a.e || STYLES.indexOf(a.style) - STYLES.indexOf(b.style);

  const stack: Span[] = [];
  let out = '';
  let skipTo = -1;
  for (let k = 0; k < points.length; k++) {
    const p = points[k];
    if (p < skipTo) continue;
    const reopen: Span[] = [];
    const lowest = stack.findIndex((sp) => sp.e <= p);
    if (lowest >= 0) {
      while (stack.length > lowest) {
        const sp = stack.pop()!;
        out += MARK[sp.style];
        if (sp.e > p) reopen.push({ ...sp, s: p });
      }
    }
    if (p >= len) break;
    if ((p === 0 || src[p - 1] === '\n') && quoted(p)) out += '> ';
    for (const sp of [...reopen, ...(starting.get(p) ?? [])].sort(order)) {
      stack.push(sp);
      out += MARK[sp.style];
    }
    const a = atomAt.get(p);
    if (a) {
      out += a.out;
      skipTo = a.e;
      continue;
    }
    out += src.slice(p, points[k + 1] ?? len);
  }
  return out;
}

// ---------------------------------------------------------------- Markdown -> Telegram

export type OutEntityType = 'bold' | 'italic' | 'underline' | 'strike' | 'spoiler' | 'code' | 'pre' | 'textUrl' | 'mentionName' | 'blockquote';
export interface OutEntity {
  type: OutEntityType;
  offset: number;
  length: number;
  url?: string;
  language?: string;
  userId?: string;
}

type Tok =
  | { k: 'text'; v: string }
  | { k: 'code'; v: string; block: boolean; lang?: string }
  | { k: 'mention'; id: string }
  | { k: 'link'; text: string; url: string }
  | { k: 'mark'; v: string; canOpen: boolean; canClose: boolean };

const QS = '\uE000';
const QE = '\uE001';
const MARK_STYLE: Record<string, Style> = { '**': 'bold', '*': 'italic', _: 'italic', __: 'underline', '~~': 'strike', '||': 'spoiler' };
const PUNCT = /[\\`*_{}[\]()#+\-.!|~<>]/;
const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}_]/u.test(c);
const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);

function tokenize(md: string): Tok[] {
  const toks: Tok[] = [];
  const text = (v: string) => {
    const last = toks[toks.length - 1];
    if (last?.k === 'text') last.v += v;
    else toks.push({ k: 'text', v });
  };
  let i = 0;
  while (i < md.length) {
    const c = md[i];
    if (c === '\\' && i + 1 < md.length && PUNCT.test(md[i + 1])) {
      text(md[i + 1]);
      i += 2;
      continue;
    }
    if (md.startsWith('```', i)) {
      const close = md.indexOf('```', i + 3);
      if (close >= i + 3) {
        let body = md.slice(i + 3, close);
        const lang = body.match(/^([\w+-]*)\n/);
        if (lang) body = body.slice(lang[0].length);
        body = body.replace(/\n$/, '');
        if (body) toks.push({ k: 'code', v: body, block: true, ...(lang?.[1] ? { lang: lang[1] } : {}) });
        i = close + 3;
        continue;
      }
    }
    if (c === '`') {
      const close = md.indexOf('`', i + 1);
      if (close > i + 1) {
        toks.push({ k: 'code', v: md.slice(i + 1, close), block: false });
        i = close + 1;
        continue;
      }
    }
    if (c === '<') {
      const m = md.slice(i).match(/^<@!?(\d+)>/);
      if (m) {
        toks.push({ k: 'mention', id: m[1] });
        i += m[0].length;
        continue;
      }
    }
    if (c === '[') {
      const m = md.slice(i).match(/^\[([^\]\n]+)\]\(((?:https?|tg):\/\/[^)\s]+)\)/);
      if (m) {
        toks.push({ k: 'link', text: m[1], url: m[2] });
        i += m[0].length;
        continue;
      }
    }
    if (c === '*' || c === '_' || c === '~' || c === '|') {
      let n = 1;
      while (md[i + n] === c) n++;
      const before = md[i - 1];
      const after = md[i + n];
      let canOpen = !isSpace(after);
      let canClose = !isSpace(before);
      if (c === '_') {
        canOpen &&= !isWordChar(before);
        canClose &&= !isWordChar(after);
      }
      let parts: string[] | null = null;
      if (c === '*' || c === '_') {
        if (n === 1) parts = [c];
        else if (n === 2) parts = [c + c];
        else if (n === 3) parts = canOpen && !canClose ? [c + c, c] : [c, c + c];
      } else if (n === 2) parts = [c + c];
      if (parts && (canOpen || canClose)) for (const v of parts) toks.push({ k: 'mark', v, canOpen, canClose });
      else text(md.slice(i, i + n));
      i += n;
      continue;
    }
    text(c);
    i++;
  }
  return toks;
}

/**
 * Canonical Markdown -> Telegram text + entities. `nameOf` gives the text a <@id> mention shows (Telegram mentions
 * a user by a span of text that links to them). Unsupported constructs stay plain text.
 */
export function toTelegram(md: string, nameOf: (userId: string) => string | undefined = () => undefined): { text: string; entities: OutEntity[] } {
  // Quotes: "> " at a line's start; consecutive quoted lines are one quote. Their edges ride through as two private
  // characters, taken out (and the offsets moved) once the text is built.
  const lines = md.split('\n');
  const quoted = lines.map((l) => /^> ?/.test(l));
  const body = lines
    .map((l, i) => {
      if (!quoted[i]) return l;
      const t = l.replace(/^> ?/, '');
      return (quoted[i - 1] ? '' : QS) + t + (quoted[i + 1] ? '' : QE);
    })
    .join('\n');
  const toks = tokenize(body);
  const pairOf = new Map<number, number>();
  const stack: number[] = [];
  toks.forEach((t, idx) => {
    if (t.k !== 'mark') return;
    if (t.canClose) {
      let at = stack.length - 1;
      while (at >= 0 && (toks[stack[at]] as { v: string }).v !== t.v) at--;
      if (at >= 0 && idx - stack[at] > 1) {
        pairOf.set(stack[at], idx);
        pairOf.set(idx, stack[at]);
        stack.length = at;
        return;
      }
    }
    if (t.canOpen) stack.push(idx);
  });

  let text = '';
  const entities: OutEntity[] = [];
  const openAt = new Map<number, number>();
  toks.forEach((t, idx) => {
    switch (t.k) {
      case 'text':
        text += t.v;
        break;
      case 'code':
        entities.push({ type: t.block ? 'pre' : 'code', offset: text.length, length: t.v.length, ...(t.lang ? { language: t.lang } : {}) });
        text += t.v;
        break;
      case 'mention': {
        const name = nameOf(t.id) || t.id;
        entities.push({ type: 'mentionName', offset: text.length, length: name.length, userId: t.id });
        text += name;
        break;
      }
      case 'link':
        entities.push({ type: 'textUrl', offset: text.length, length: t.text.length, url: t.url });
        text += t.text;
        break;
      case 'mark': {
        const other = pairOf.get(idx);
        if (other === undefined) text += t.v;
        else if (other > idx) openAt.set(idx, text.length);
        else {
          const start = openAt.get(other)!;
          if (text.length > start) entities.push({ type: MARK_STYLE[t.v], offset: start, length: text.length - start });
        }
        break;
      }
    }
  });

  if (text.includes(QS) || text.includes(QE)) {
    // Where each character of the text lands once the markers are out.
    const map: number[] = [];
    let clean = '';
    let open = -1;
    const quotes: [number, number][] = [];
    for (let i = 0; i <= text.length; i++) {
      map[i] = clean.length;
      const c = text[i];
      if (c === QS) open = clean.length;
      else if (c === QE) {
        if (open >= 0 && clean.length > open) quotes.push([open, clean.length]);
        open = -1;
      } else if (c !== undefined) clean += c;
    }
    for (const e of entities) {
      const s0 = map[e.offset];
      const e0 = map[e.offset + e.length];
      e.offset = s0;
      e.length = e0 - s0;
    }
    text = clean;
    for (const [a, b] of quotes) entities.push({ type: 'blockquote', offset: a, length: b - a });
  }
  const out = entities.filter((e) => e.length > 0);
  out.sort((a, b) => a.offset - b.offset || b.length - a.length);
  return { text, entities: out };
}

/** Plain text of a body, for previews and service messages: markers dropped. */
export function plain(md: string): string {
  return toTelegram(md).text;
}
