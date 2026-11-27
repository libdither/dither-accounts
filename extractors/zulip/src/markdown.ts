/**
 * Zulip's Markdown (https://zulip.com/help/format-your-message-using-markdown) to and from the hub's body
 * (adapter.ts MessageFact.body: Discord-flavoured Markdown with <@id>, <#id>, <t:unix:style> and ||spoilers||).
 *
 * Messages are read as their Markdown source (`apply_markdown: false`), so this works on what the author typed:
 *
 *   @**Ann Lee|9**, @**Ann Lee**, @_**Ann Lee|9** (silent)   → <@host/u/9>
 *   @**all** @**everyone** @**channel** @**stream**           → @everyone        @**topic** → @here
 *   @*designers* (a user group)                              → @designers
 *   #**design**, #**design>colors**, #**design>colors@345**  → <#host/s/12>, <#host/s/12/t/colors>
 *   ```quote …```                                            → > lines
 *   ```spoiler Title …```                                    → **Title** ||…||
 *   :smile: (a Unicode emoji's name)                         → 😄; a custom emoji's :name: stays
 *   <time:2026-12-01T15:00:00Z>                              → <t:1764601200:F>
 *   [pic.png](/user_uploads/2/ab/xyz/pic.png)                → an attachment (zulip:/user_uploads/…), and the line goes
 *   @_**Ann Lee|9** [said](…/near/345):\n```quote\n…\n```    → replyTo the message 345, and the quote goes
 *
 * Code spans and fenced code are left exactly as written. Sending turns the hub's forms back into Zulip's.
 */
import type * as P from '@dither-chat/protocol';
import { attachmentKind } from '@dither-chat/protocol';
import { type Ids, linkedMessage } from './ids.ts';

export interface MdUser {
  user_id: number;
  full_name: string;
}

export interface MdCtx {
  ids: Ids;
  base: string;
  user(id: number): MdUser | undefined;
  userByName(name: string): MdUser | undefined;
  streamName(id: number): string | undefined;
  streamByName(name: string): number | undefined;
  /** A Unicode emoji's name (`smile`) → the emoji; undefined for a custom one or an unknown name. */
  emoji(name: string): string | undefined;
  /** The other way: an emoji → its Zulip name, for sending. */
  emojiName(char: string): string | undefined;
  group?(id: string): string | undefined;
  /** A user group by its name → its native id (`<host>/g/<id>`), for mentions of it. */
  groupByName?(name: string): string | undefined;
}

export interface Parsed {
  body: string;
  attachments: P.AttachmentFact[];
  replyTo?: string;
  /** People named with a mention (silent ones included), by native id. */
  mentioned: string[];
}

const UPLOAD = /^\/user_uploads\/\S+$/;
const EXT_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', heic: 'image/heic', avif: 'image/avif', jxl: 'image/jxl',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/opus', wav: 'audio/wav', m4a: 'audio/mp4', flac: 'audio/flac',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json', zip: 'application/zip', csv: 'text/csv', html: 'text/html',
};

export function mimeOf(name: string): string {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  return EXT_MIME[ext] ?? 'application/octet-stream';
}

/** A path on the server (`/user_uploads/…`), from a link as written: relative, or absolute on the server's origin. */
function serverPath(url: string, base: string): string | null {
  if (url.startsWith('/')) return url;
  try {
    const u = new URL(url);
    return u.origin === base ? u.pathname + u.search : null;
  } catch {
    return null;
  }
}

/** A URL the hub can fetch: the server's own files go through the extractor (fetchMedia), anything else as it is. */
export function mediaUrl(url: string | null | undefined, base: string): string | undefined {
  if (!url) return undefined;
  const p = serverPath(url, base);
  if (p) return `zulip:${p}`;
  return /^https?:\/\//.test(url) ? url : undefined;
}

// ---------------------------------------------------------------- reading

/** Splits text into fenced blocks and the rest. A fence is ``` or ~~~ (three or more) with an info string. */
function blocks(src: string): { fence?: { mark: string; info: string }; text: string }[] {
  const out: { fence?: { mark: string; info: string }; text: string }[] = [];
  const lines = src.split('\n');
  let plain: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^ {0,3}(`{3,}|~{3,})\s*([^`]*)$/);
    if (!open) {
      plain.push(lines[i]);
      continue;
    }
    const mark = open[1];
    let j = i + 1;
    const inner: string[] = [];
    let closed = false;
    for (; j < lines.length; j++) {
      const close = lines[j].match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === mark[0] && close[1].length >= mark.length) {
        closed = true;
        break;
      }
      inner.push(lines[j]);
    }
    if (plain.length) out.push({ text: plain.join('\n') });
    plain = [];
    // An unclosed fence runs to the end of the message, as in Zulip.
    out.push({ fence: { mark, info: open[2].trim() }, text: inner.join('\n') });
    i = closed ? j : lines.length;
  }
  if (plain.length) out.push({ text: plain.join('\n') });
  return out;
}

/** Applies f to the text outside `code spans`. */
function outsideCode(s: string, f: (t: string) => string): string {
  return s
    .split(/(`+[^`]*?`+)/)
    .map((part, i) => (i % 2 ? part : f(part)))
    .join('');
}

const WILD_ALL = new Set(['all', 'everyone', 'channel', 'stream']);

function inline(s: string, ctx: MdCtx, out: Parsed): string {
  return outsideCode(s, (t) => {
    // Person and wildcard mentions: @**Name|id**, @**Name**, silent @_**…**.
    t = t.replace(/@(_?)\*\*([^*\n]+?)\*\*/g, (whole, _silent: string, inner: string) => {
      const m = inner.match(/^(.*)\|(\d+)$/);
      if (!m && WILD_ALL.has(inner)) return '@everyone';
      if (!m && inner === 'topic') return '@here';
      const u = m ? ctx.user(Number(m[2])) : ctx.userByName(inner);
      if (!u) return m ? `@${m[1]}` : whole;
      const id = ctx.ids.user(u.user_id);
      if (!out.mentioned.includes(id)) out.mentioned.push(id);
      return `<@${id}>`;
    });
    // User groups: @*name*, silent @_*name*: the group's role mention where the organization has it.
    t = t.replace(/@_?\*([^*\n]+?)\*/g, (_, name: string) => {
      const id = ctx.groupByName?.(name);
      return id ? `<@&${id}>` : `@${name}`;
    });
    // Channel and topic links.
    t = t.replace(/#\*\*([^*\n]+?)\*\*/g, (whole, inner: string) => {
      const m = inner.match(/^(.*?)>(.*?)(?:@(\d+))?$/s);
      const name = m ? m[1] : inner;
      const stream = ctx.streamByName(name);
      if (stream === undefined) return whole;
      return m ? `<#${ctx.ids.topic(stream, m[2])}>` : `<#${ctx.ids.channel(stream)}>`;
    });
    // Global times.
    t = t.replace(/<time:([^>\n]+)>/g, (whole, iso: string) => {
      const ms = Date.parse(iso);
      return Number.isFinite(ms) ? `<t:${Math.floor(ms / 1000)}:F>` : whole;
    });
    // Emoji names.
    t = t.replace(/:([a-z0-9_+\-]+):/g, (whole, name: string) => ctx.emoji(name) ?? whole);
    // Uploads: links to the server's /user_uploads become attachments.
    // Zulip's web client writes a picture or a sound as an image link, `![name](…)`.
    t = t.replace(/!?\[([^\]\n]*)\]\(([^)\s]+)\)/g, (whole, text: string, url: string) => {
      const p = serverPath(url, ctx.base);
      if (!p || !UPLOAD.test(p.split('?')[0])) return whole;
      const name = decodeURIComponent(p.split('?')[0].split('/').pop() ?? '') || text || 'file';
      const mime = mimeOf(name);
      out.attachments.push({ nativeId: p, kind: attachmentKind(mime), mime, name: text || name, url: `zulip:${p}` });
      // Words of the writer's own stay where they were ("See [the sketch](…) please"); the file's name the upload
      // wrote by itself goes with the link, the attachment showing it.
      return `\u0000${text && text !== name ? text : ''}\u0001`;
    });
    return t;
  });
}

function convert(src: string, ctx: MdCtx, out: Parsed): string {
  const parts: string[] = [];
  for (const b of blocks(src)) {
    if (!b.fence) {
      parts.push(inline(b.text, ctx, out));
      continue;
    }
    const info = b.fence.info;
    const kind = info.split(/\s+/)[0].toLowerCase();
    if (kind === 'quote') {
      const inner = convert(b.text, ctx, out);
      parts.push(inner.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n'));
    } else if (kind === 'spoiler') {
      const title = info.slice('spoiler'.length).trim();
      const inner = convert(b.text, ctx, out).trim();
      parts.push(`${title ? `**${inline(title, ctx, out)}** ` : ''}||${inner}||`);
    } else parts.push(`\`\`\`${info}\n${b.text}\n\`\`\``);
  }
  return parts.join('\n');
}

/** The quote Zulip's web client puts before a reply: `@_**Name|9** [said](…/near/345):` then a quote fence. */
// From another topic it adds ` in #**channel>topic@id**`, from a DM ` to @_**Name|id**` (its compose_reply.ts).
export const REPLY = /^@_?\*\*[^*\n]+?\*\* \[[^\]\n]+\]\(([^)\s]+)\)(?: in #\*\*[^\n]+?\*\*| to [^\n]+?)?:\n(`{3,}|~{3,})quote\n[\s\S]*?\n\2[ \t]*(?:\n|$)/;

export function fromZulip(content: string, ctx: MdCtx, opts: { keepReplyQuote?: boolean } = {}): Parsed {
  const out: Parsed = { body: '', attachments: [], mentioned: [] };
  let src = content.replace(/\r\n/g, '\n');
  const r = src.match(REPLY);
  if (r && !opts.keepReplyQuote) {
    const id = linkedMessage(r[1]);
    const path = serverPath(r[1], ctx.base);
    if (id !== null && path !== null) {
      out.replyTo = ctx.ids.message(id);
      src = src.slice(r[0].length).replace(/^\n+/, '');
    }
  }
  let body = convert(src, ctx, out);
  // An upload alone on its line takes the line with it; one inside a sentence leaves its name.
  body = body
    .split('\n')
    .filter((l) => !l.includes('\u0000') || l.replace(/\u0000[^\u0001]*\u0001/g, '').trim() !== '')
    .join('\n')
    .replace(/\u0000([^\u0001]*)\u0001/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  out.body = body;
  return out;
}

// ---------------------------------------------------------------- writing

/** The hub's body as Zulip Markdown. */
export function toZulip(body: string, ctx: MdCtx): string {
  const parts: string[] = [];
  for (const b of blocks(body)) {
    if (b.fence) {
      parts.push(`${b.fence.mark}${b.fence.info}\n${b.text}\n${b.fence.mark}`);
      continue;
    }
    parts.push(
      outsideCode(b.text, (t) => {
        t = t.replace(/<@!?([^>\s]+)>/g, (whole, id: string) => {
          const uid = ctx.ids.userId(id);
          const u = uid !== null ? ctx.user(uid) : undefined;
          return u ? `@**${u.full_name}|${u.user_id}**` : whole;
        });
        t = t.replace(/<@&([^>\s]+)>/g, (whole, id: string) => {
          const name = ctx.group?.(id);
          return name ? `@*${name}*` : whole;
        });
        t = t.replace(/(^|[\s(])@everyone\b/g, '$1@**all**').replace(/(^|[\s(])@here\b/g, '$1@**topic**');
        t = t.replace(/<#([^>\s]+)>/g, (whole, id: string) => {
          const p = ctx.ids.place(id);
          if (!p || p.kind === 'dm') return whole;
          const name = ctx.streamName(p.stream);
          if (!name) return whole;
          return p.kind === 'topic' ? `#**${name}>${p.topic}**` : `#**${name}**`;
        });
        t = t.replace(/<t:(-?\d{1,13})(?::[tTdDfFR])?>/g, (_, sec: string) => `<time:${new Date(Number(sec) * 1000).toISOString().replace('.000Z', 'Z')}>`);
        // Zulip has no inline spoiler: a spoiler block holds it.
        t = t.replace(/\|\|([\s\S]+?)\|\|/g, (_, inner: string) => `\n\`\`\`spoiler\n${inner}\n\`\`\`\n`);
        // Zulip's Markdown has no underline: __x__ is plain there. Keep the emphasis as italics.
        t = t.replace(/(^|[^\w_])__([^_\n]+)__(?=[^\w_]|$)/g, '$1*$2*');
        // Nor emphasis with single underscores: _x_ is italics in the hub, plain in Zulip.
        t = t.replace(/(^|[^\w_*])_([^_\s][^_\n]*?)_(?=[^\w_]|$)/g, '$1*$2*');
        return t;
      }),
    );
  }
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** The quote Zulip's web client writes for a reply (compose_reply.quote_message): who said it, a link, the text. */
export function replyQuote(author: MdUser | undefined, link: string, content: string): string {
  // A fence longer than any in the quoted text, as the web client does.
  const longest = Math.max(2, ...[...content.matchAll(/`{3,}/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  const who = author ? `@_**${author.full_name}|${author.user_id}** ` : '';
  return `${who}[said](${link}):\n${fence}quote\n${content}\n${fence}\n`;
}

/**
 * An edit's new content from the hub's new body (already Zulip Markdown) and the message as Zulip has it. The hub's
 * body never held what reading took out, so it is put back: the reply's quote, the uploads (as links on their own
 * lines, where the new words do not link them), and silent mentions staying silent, so an edit pings nobody new.
 */
export function editedContent(old: string, next: string): string {
  const src = old.replace(/\r\n/g, '\n');
  const quote = src.match(REPLY)?.[0] ?? '';
  const rest = src.slice(quote.length);
  const silent = new Set<string>();
  const uploads: string[] = [];
  for (const b of blocks(rest)) {
    if (b.fence && !/^(quote|spoiler)\b/i.test(b.fence.info)) continue;
    outsideCode(b.text, (t) => {
      for (const m of t.matchAll(/@_\*\*[^*\n]*?\|(\d+)\*\*/g)) silent.add(m[1]!);
      for (const m of t.matchAll(/!?\[[^\]\n]*\]\(([^)\s]+)\)/g)) if (/\/user_uploads\//.test(m[1]!) && !next.includes(m[1]!)) uploads.push(m[0]);
      return t;
    });
  }
  let out = next;
  if (silent.size)
    out = blocks(out)
      .map((b) => (b.fence ? `${b.fence.mark}${b.fence.info}\n${b.text}\n${b.fence.mark}` : outsideCode(b.text, (t) => t.replace(/@\*\*([^*\n]*?)\|(\d+)\*\*/g, (w, n: string, id: string) => (silent.has(id) ? `@_**${n}|${id}**` : w)))))
      .join('\n');
  const tail = uploads.length ? `${out ? '\n' : ''}${uploads.join('\n')}` : '';
  return `${quote}${out}${tail}`;
}

/** Zulip Markdown as plain words, for a line of text (a channel's description): emphasis, code and links undone. */
export function plainText(md: string): string {
  return md
    .replace(/@_?\*\*([^*|\n]+)(?:\|\d+)?\*\*/g, '@$1')
    .replace(/#\*\*([^*\n]+)\*\*/g, '#$1')
    .replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, (_, t: string, u: string) => (t && t !== u ? `${t} (${u})` : u))
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?=[^\w*]|$)/g, '$1$2')
    .replace(/~~([^~\n]+)~~/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1');
}
