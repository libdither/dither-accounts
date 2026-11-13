/**
 * Writing a post or a reply on a network that has posts (docs/feed.md "Answering"): how long it may be and how the
 * network counts, what the counter shows and when, the network's own words, and what can be done to a post. One
 * composer draws every network from these rules: X's ring that fills and counts down from 20, Reddit's 10,000
 * characters of Markdown. Pure, so the hub checks a post with the same count the page shows.
 */

export interface PostRules {
  /** The network's words: its button, its placeholder, a reply's. */
  words: { post: string; reply: string; quote: string; placeholder: string; replyPlaceholder: string; quotePlaceholder: string };
  /** At most this long, as `count` counts. */
  maxLength: number;
  /**
   * How length is counted. 'weighted' (X, twitter-text v3): most Latin, Cyrillic, Greek and punctuation count one,
   * other characters (CJK, most symbols) and each emoji two, every link `urlLength`; the limit is in those units.
   * 'chars': characters as the reader sees them (graphemes).
   */
  count: 'weighted' | 'chars';
  /** What a link counts as under 'weighted'. */
  urlLength: number;
  /**
   * The counter: 'ring' (X: a ring filling as you type; from `warnAt` left it grows and shows what is left, past the
   * limit a negative count in red, and the ring goes once you are more than 10 over), or 'text' ("1,204 left", shown
   * from `warnAt` left).
   */
  counter: 'ring' | 'text';
  warnAt: number;
  /** Written in Markdown (Reddit), or plain as it shows (X). */
  markdown: boolean;
  /** What a post here can have done to it. */
  actions: { like: boolean; repost: boolean; quote: boolean; reply: boolean };
  /**
   * Who may see who liked a post: only its author (X since 2024), everyone, or nobody (a count only: Reddit, YouTube).
   * Who reposted is public where reposts are.
   */
  likersVisible: 'author' | 'all' | 'none';
}

const X_RULES: PostRules = {
  words: { post: 'Post', reply: 'Reply', quote: 'Quote', placeholder: "What's happening?", replyPlaceholder: 'Post your reply', quotePlaceholder: 'Add a comment' },
  maxLength: 280,
  count: 'weighted',
  urlLength: 23,
  counter: 'ring',
  warnAt: 20,
  markdown: false,
  actions: { like: true, repost: true, quote: true, reply: true },
  likersVisible: 'author',
};

/** Reddit's comment box, for when a Reddit account comes: the same composer, its own rules. */
export const REDDIT_RULES: PostRules = {
  words: { post: 'Post', reply: 'Comment', quote: 'Crosspost', placeholder: 'Title', replyPlaceholder: 'Add a comment', quotePlaceholder: 'Add a comment' },
  maxLength: 10_000,
  count: 'chars',
  urlLength: 0,
  counter: 'text',
  warnAt: 1_000,
  markdown: true,
  actions: { like: true, repost: false, quote: false, reply: true },
  likersVisible: 'none',
};

/** The rules of each network that has posts. */
export const POST_RULES: Readonly<Record<string, PostRules>> = { x: X_RULES, reddit: REDDIT_RULES };
export const postRulesFor = (network: string): PostRules | null => POST_RULES[network] ?? null;

// twitter-text v3: code points in these ranges weigh 100 (one), all others 200 (two); scale 100.
const LIGHT: readonly [number, number][] = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247],
];
const light = (cp: number) => LIGHT.some(([a, b]) => cp >= a && cp <= b);
// A link as X sees one (twitter-text's extractUrls, simplified): with its scheme anywhere; bare, on a known ending,
// not inside an email address or an @handle. A bare two-letter (country) ending counts only with a path, except .co
// and .tv, as twitter-text has it.
const GENERIC = 'com|org|net|edu|gov|mil|int|info|biz|name|pro|io|ai|app|dev|page|link|live|news|blog|site|online|store|tech|club|xyz|art|wiki|social|space|studio|world|zone|tools|codes|cafe|moe|ink|garden|email|today|top|shop|games|media|network|cloud|software|systems';
const COUNTRY = '[a-z]{2}';
const URL = new RegExp(
  `(?<![\\p{L}\\p{N}_@.\\-/])(?:https?://[^\\s<>"]+|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:(${GENERIC})|(${COUNTRY}))(?![\\p{L}\\p{N}_\\-@])(/[^\\s<>"]*)?)`,
  'giu',
);
// An emoji as X counts one (two): shown as a picture by default, asked for with VS16, a flag, a keycap, a ZWJ sequence.
// © and ® alone are text (one).
const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\ufe0f|\p{Regional_Indicator}|\u20e3|\u200d/u;
/** What does not count as something to send: spaces, and the invisible joiners and marks. */
const BLANK = /[\s\u200b-\u200d\u2060\ufeff]/gu;

/** Trailing punctuation that ends a sentence, not a link; a closing bracket stays when the link opened one. */
function trimLink(raw: string): string {
  let t = raw.replace(/[.,;:!?'"\]]+$/u, '');
  while (t.endsWith(')') && (t.match(/\(/g)?.length ?? 0) < (t.match(/\)/g)?.length ?? 0)) t = t.slice(0, -1).replace(/[.,;:!?'"\]]+$/u, '');
  return t;
}

// Made on first use: nothing runs when the module loads, so a bundle that does not count drops it.
let segmenter: Intl.Segmenter | null | undefined;
const graphemes = (s: string): string[] => {
  segmenter ??= typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  return segmenter ? [...segmenter.segment(s)].map((g) => g.segment) : Array.from(s);
};

/** Each piece of the text and what it counts for: so the page can tell where the limit falls. */
function pieces(text: string, rules: PostRules): { at: number; end: number; weight: number }[] {
  const t = text.normalize('NFC');
  const out: { at: number; end: number; weight: number }[] = [];
  if (rules.count === 'chars') {
    let at = 0;
    for (const g of graphemes(t)) out.push({ at, end: (at += g.length), weight: 1 });
    return out;
  }
  const links: [number, number][] = [];
  for (const m of t.matchAll(URL)) {
    // A bare country ending with no path is not a link ("read.me now"), but .co and .tv are.
    if (m[2] && !m[3] && m[2].toLowerCase() !== 'co' && m[2].toLowerCase() !== 'tv') continue;
    const raw = trimLink(m[0]);
    if (raw) links.push([m.index!, m.index! + raw.length]);
  }
  let at = 0;
  let li = 0;
  while (at < t.length) {
    const link = links[li];
    if (link && at === link[0]) {
      out.push({ at, end: link[1], weight: rules.urlLength });
      at = link[1];
      li++;
      continue;
    }
    const stop = link ? link[0] : t.length;
    for (const g of graphemes(t.slice(at, stop))) {
      const weight = EMOJI.test(g) ? 2 : Array.from(g).reduce((n, ch) => n + (light(ch.codePointAt(0)!) ? 1 : 2), 0);
      out.push({ at, end: at + g.length, weight });
      at += g.length;
    }
  }
  return out;
}

/** The text's length as the network counts it. */
export const postLength = (text: string, rules: PostRules) => pieces(text, rules).reduce((n, p) => n + p.weight, 0);

export interface ComposeState {
  length: number;
  remaining: number;
  /** How full, 0 to 1 (the ring). */
  progress: number;
  /** 'ok', 'warn' (within `warnAt` of the limit), 'over'. */
  level: 'ok' | 'warn' | 'over';
  /** Show the number: within `warnAt` of the limit or past it. */
  showCount: boolean;
  /** The ring: until more than 10 over (X). */
  showRing: boolean;
  /** Where in the text (a string index, NFC) it first goes past the limit, for marking what is too much; null within. */
  overFrom: number | null;
  /** Something to send, and not too long. */
  sendable: boolean;
}

/** What the composer shows for this text. */
export function composeState(text: string, rules: PostRules): ComposeState {
  const ps = pieces(text, rules);
  let length = 0;
  let overFrom: number | null = null;
  for (const p of ps) {
    length += p.weight;
    if (overFrom === null && length > rules.maxLength) overFrom = p.at;
  }
  const remaining = rules.maxLength - length;
  const level = remaining < 0 ? 'over' : remaining <= rules.warnAt ? 'warn' : 'ok';
  return {
    length,
    remaining,
    progress: Math.min(1, length / rules.maxLength),
    level,
    showCount: level !== 'ok',
    showRing: rules.counter === 'ring' && remaining >= -10,
    overFrom,
    sendable: text.replace(BLANK, '').length > 0 && remaining >= 0,
  };
}
