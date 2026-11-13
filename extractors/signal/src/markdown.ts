/**
 * Signal body ranges <-> dither-chat canonical Markdown (protocol MessageFact.body).
 *
 * Signal sends plain text plus ranges in UTF-16 code units (JS string indices):
 *   textStyles  BOLD ITALIC STRIKETHROUGH MONOSPACE SPOILER
 *   mentions    usually a single U+FFFC placeholder, replaced by `<@aci>`
 *
 * Markdown needs properly nested markers, Signal ranges may overlap freely, so
 * fromSignal() normalises first: same-style ranges are merged, emphasis is
 * split at newlines and trimmed of edge whitespace (`**x **` does not parse),
 * and nothing may start or end inside a code span.
 */

import type { SigMention, SigTextStyle } from './types.ts';

export type Style = 'BOLD' | 'ITALIC' | 'STRIKETHROUGH' | 'MONOSPACE' | 'SPOILER';
const STYLES: readonly Style[] = ['BOLD', 'ITALIC', 'STRIKETHROUGH', 'MONOSPACE', 'SPOILER'];
const MARK: Record<Exclude<Style, 'MONOSPACE'>, string> = { BOLD: '**', ITALIC: '*', STRIKETHROUGH: '~~', SPOILER: '||' };

export const MENTION_PLACEHOLDER = '￼';

interface Span {
  style: Style;
  s: number;
  e: number;
}

export interface FromSignalOptions {
  /** Called with each mentioned ACI; lets the caller compute mentionsSelf. */
  onMention?: (aci: string) => void;
}

/** Signal text + ranges -> canonical Markdown. */
export function fromSignal(text: string | null | undefined, styles?: SigTextStyle[] | null, mentions?: SigMention[] | null, opts: FromSignalOptions = {}): string {
  const src = text ?? '';
  const len = src.length;
  if (!len) return '';

  // Mentions: non-overlapping, in order.
  const ms: { s: number; e: number; token: string }[] = [];
  for (const m of [...(mentions ?? [])].sort((a, b) => a.start - b.start)) {
    const s = clamp(m.start, 0, len);
    const e = clamp(m.start + Math.max(1, m.length), 0, len);
    if (e <= s || (ms.length && s < ms[ms.length - 1].e)) continue;
    const who = m.uuid ?? null;
    if (who) opts.onMention?.(who);
    ms.push({ s, e, token: who ? `<@${who}>` : `@${m.number ?? m.name ?? 'unknown'}` });
  }

  let spans = normaliseSpans(src, styles ?? []);
  // A mention is atomic: no style boundary may fall strictly inside one.
  spans = spans.filter((sp) => !ms.some((m) => (sp.s > m.s && sp.s < m.e) || (sp.e > m.s && sp.e < m.e)));
  return emit(src, spans, ms);
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, Math.trunc(Number.isFinite(n) ? n : 0)));
}

const isWs = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ' ';

function normaliseSpans(src: string, styles: SigTextStyle[]): Span[] {
  const len = src.length;
  // 1. clamp + merge per style
  const byStyle = new Map<Style, [number, number][]>();
  for (const st of styles) {
    if (!STYLES.includes(st.style as Style)) continue;
    const s = clamp(st.start, 0, len);
    const e = clamp(st.start + st.length, 0, len);
    if (e <= s) continue;
    (byStyle.get(st.style as Style) ?? byStyle.set(st.style as Style, []).get(st.style as Style)!).push([s, e]);
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

  // 2. nothing starts or ends inside code: drop spans inside a code span, clip partial overlaps
  const code = merged.filter((m) => m.style === 'MONOSPACE');
  let clipped = merged.filter((m) => m.style !== 'MONOSPACE');
  for (const c of code) {
    const next: Span[] = [];
    for (const r of clipped) {
      if (r.e <= c.s || r.s >= c.e) next.push(r); // disjoint
      else if (r.s <= c.s && r.e >= c.e) next.push(r); // contains the code span: nests fine
      else if (r.s >= c.s && r.e <= c.e) continue; // inside code: markers would be literal
      else if (r.s < c.s) next.push({ ...r, e: c.s }); // tail overlaps the code
      else next.push({ ...r, s: c.e }); // head overlaps the code
    }
    clipped = next.filter((r) => r.e > r.s);
  }

  // 3. emphasis: split at newlines, trim edge whitespace
  const emph: Span[] = [];
  for (const m of clipped) {
    let s = m.s;
    for (let i = m.s; i <= m.e; i++) {
      if (i === m.e || src[i] === '\n') {
        let a = s;
        let b = i;
        while (a < b && isWs(src[a])) a++;
        while (b > a && isWs(src[b - 1])) b--;
        if (b > a) emph.push({ style: m.style, s: a, e: b });
        s = i + 1;
      }
    }
  }
  return [...emph, ...code];
}

function openMarker(sp: Span, src: string) {
  if (sp.style !== 'MONOSPACE') return MARK[sp.style];
  return fenced(sp, src) ? '```\n' : '`';
}
function closeMarker(sp: Span, src: string) {
  if (sp.style !== 'MONOSPACE') return MARK[sp.style];
  return fenced(sp, src) ? '\n```' : '`';
}
function fenced(sp: Span, src: string) {
  const body = src.slice(sp.s, sp.e);
  return body.includes('\n') || body.includes('`');
}

function emit(src: string, spans: Span[], ms: { s: number; e: number; token: string }[]): string {
  const len = src.length;
  const cuts = new Set<number>([0, len]);
  for (const sp of spans) cuts.add(sp.s).add(sp.e);
  for (const m of ms) cuts.add(m.s).add(m.e);
  const points = [...cuts].sort((a, b) => a - b);
  const mentionAt = new Map(ms.map((m) => [m.s, m]));
  const starting = new Map<number, Span[]>();
  for (const sp of spans) (starting.get(sp.s) ?? starting.set(sp.s, []).get(sp.s)!).push(sp);

  // Outer spans first: the one that ends last; code is always innermost.
  const order = (a: Span, b: Span) => b.e - a.e || (a.style === 'MONOSPACE' ? 1 : 0) - (b.style === 'MONOSPACE' ? 1 : 0) || STYLES.indexOf(a.style) - STYLES.indexOf(b.style);

  const stack: Span[] = [];
  let out = '';
  for (let k = 0; k < points.length; k++) {
    const p = points[k];
    // close everything that ends here, plus whatever sits above it (reopened below)
    const reopen: Span[] = [];
    const lowest = stack.findIndex((sp) => sp.e <= p);
    if (lowest >= 0) {
      while (stack.length > lowest) {
        const sp = stack.pop()!;
        out += closeMarker(sp, src);
        if (sp.e > p) reopen.push({ ...sp, s: p });
      }
    }
    if (p >= len) break;
    const opening = [...reopen, ...(starting.get(p) ?? [])].sort(order);
    for (const sp of opening) {
      stack.push(sp);
      out += openMarker(sp, src);
    }
    const next = points[k + 1] ?? len;
    const m = mentionAt.get(p);
    out += m ? m.token : src.slice(p, next);
  }
  return out;
}

// ---------------------------------------------------------------- Markdown -> Signal

export interface SignalText {
  text: string;
  /** "start:length:STYLE" as signal-cli's --text-style expects. */
  textStyles: string[];
  /** "start:length:ACI" as signal-cli's --mention expects. */
  mentions: string[];
  styles: SigTextStyle[];
  mentionRanges: SigMention[];
}

type Tok =
  | { k: 'text'; v: string }
  | { k: 'code'; v: string }
  | { k: 'mention'; aci: string }
  | { k: 'mark'; v: string; canOpen: boolean; canClose: boolean };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MARK_STYLE: Record<string, Style | null> = { '**': 'BOLD', '*': 'ITALIC', _: 'ITALIC', '~~': 'STRIKETHROUGH', '||': 'SPOILER', __: null };
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
        const lang = body.match(/^[\w+-]*\n/);
        if (lang) body = body.slice(lang[0].length);
        body = body.replace(/\n$/, '');
        if (body) toks.push({ k: 'code', v: body });
        i = close + 3;
        continue;
      }
    }
    if (c === '`') {
      const close = md.indexOf('`', i + 1);
      if (close > i + 1) {
        toks.push({ k: 'code', v: md.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }
    if (c === '<') {
      const m = md.slice(i).match(/^<@!?([^>\s]+)>/);
      if (m && UUID.test(m[1])) {
        toks.push({ k: 'mention', aci: m[1].toLowerCase() });
        i += m[0].length;
        continue;
      }
    }
    if (c === '[') {
      const m = md.slice(i).match(/^\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/);
      if (m) {
        text(m[1] === m[2] ? m[2] : `${m[1]} (${m[2]})`);
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
        // snake_case_names stay literal
        canOpen &&= !isWordChar(before);
        canClose &&= !isWordChar(after);
      }
      let parts: string[] | null = null;
      if (c === '*' || c === '_') {
        if (n === 1) parts = [c];
        else if (n === 2) parts = [c + c];
        // `***x***`: bold outside italic, mirrored on the closing side
        else if (n === 3) parts = canOpen && !canClose ? [c + c, c] : [c, c + c];
      } else if (n === 2) parts = [c + c]; // ~~ and ||
      if (parts && (canOpen || canClose)) {
        for (const v of parts) toks.push({ k: 'mark', v, canOpen, canClose });
      } else text(md.slice(i, i + n));
      i += n;
      continue;
    }
    text(c);
    i++;
  }
  return toks;
}

/** Canonical Markdown -> Signal text + ranges. Unsupported constructs degrade to plain text. */
export function toSignal(md: string): SignalText {
  const toks = tokenize(md);
  // Pair markers with a stack; unpaired markers are literal text.
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
        stack.length = at; // markers opened after it stay literal
        return;
      }
    }
    if (t.canOpen) stack.push(idx);
  });

  let text = '';
  const styles: SigTextStyle[] = [];
  const mentionRanges: SigMention[] = [];
  const openAt = new Map<number, number>();
  toks.forEach((t, idx) => {
    switch (t.k) {
      case 'text':
        text += t.v;
        break;
      case 'code':
        styles.push({ style: 'MONOSPACE', start: text.length, length: t.v.length });
        text += t.v;
        break;
      case 'mention':
        mentionRanges.push({ uuid: t.aci, start: text.length, length: 1 });
        text += MENTION_PLACEHOLDER;
        break;
      case 'mark': {
        const other = pairOf.get(idx);
        if (other === undefined) {
          text += t.v;
        } else if (other > idx) {
          openAt.set(idx, text.length);
        } else {
          const start = openAt.get(other)!;
          const style = MARK_STYLE[t.v];
          if (style && text.length > start) styles.push({ style, start, length: text.length - start });
        }
        break;
      }
    }
  });
  styles.sort((a, b) => a.start - b.start || b.length - a.length);
  return {
    text,
    styles,
    mentionRanges,
    textStyles: styles.map((s) => `${s.start}:${s.length}:${s.style}`),
    mentions: mentionRanges.map((m) => `${m.start}:${m.length}:${m.uuid}`),
  };
}

/** Plain-text rendering of a Signal body (mentions as @name), for quotes and previews. */
export function plainText(text: string | null | undefined, mentions?: SigMention[] | null, nameOf?: (aci: string) => string | undefined): string {
  const src = text ?? '';
  if (!mentions?.length) return src;
  let out = '';
  let at = 0;
  for (const m of [...mentions].sort((a, b) => a.start - b.start)) {
    if (m.start < at) continue;
    out += src.slice(at, m.start) + '@' + ((m.uuid && nameOf?.(m.uuid)) || m.number || m.name || 'someone');
    at = m.start + Math.max(1, m.length);
  }
  return out + src.slice(at);
}
