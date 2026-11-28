/**
 * A Discord bot on the REST API (v10), for the composition parity suite (docs/parity-testing.md,
 * docs/parity-discord.md). It is both sides the extractor is checked against:
 *
 * - **The other person (actor B):** it sends, edits its own messages, reacts and takes reactions back, replies
 *   (`message_reference`), deletes and pins, each as one request a bot's own client would make.
 * - **The oracle:** `oracleState()` reads the channel back from Discord itself (`GET /channels/{id}/messages`, the
 *   people behind each reaction from `GET .../reactions/{emoji}`, the pinned list from `GET .../messages/pins`) and
 *   folds it into the harness's NormalizedConversationState, never through the extractor.
 *
 * No dependencies: plain fetch. `baseUrl` points it at Discord (the default) or at a fake (fake-discord.ts). A 429
 * waits the `Retry-After` it gives and goes again; a fake that answers `Retry-After: 0` is retried at once, with no
 * sleep at all. The token goes only in the Authorization header: never in an error, a log line or a capture.
 */
import { normalize, type Handle, type NormalizedConversationState, type RawMessage } from './harness.ts';

export const DISCORD_API = 'https://discord.com/api/v10';

/** Discord's message types this suite compares: a plain message and a reply. The rest are its own notices. */
export const USER_MESSAGE_TYPES = new Set([0, 19]);

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  bot?: boolean;
}

export interface DiscordEmoji {
  id: string | null;
  name: string | null;
  animated?: boolean;
}

export interface DiscordReaction {
  emoji: DiscordEmoji;
  count: number;
  count_details?: { burst: number; normal: number };
  me: boolean;
  me_burst?: boolean;
  burst_count?: number;
  burst_colors?: string[];
}

export interface DiscordAttachment {
  id: string;
  filename: string;
  content_type?: string;
  size: number;
  url: string;
  proxy_url?: string;
  width?: number;
  height?: number;
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: DiscordUser;
  content: string;
  timestamp: string;
  edited_timestamp: string | null;
  type: number;
  tts: boolean;
  mention_everyone: boolean;
  mentions: DiscordUser[];
  attachments: DiscordAttachment[];
  embeds: unknown[];
  reactions?: DiscordReaction[];
  pinned: boolean;
  nonce?: string | number;
  message_reference?: { type?: number; message_id?: string; channel_id?: string; guild_id?: string };
  referenced_message?: DiscordMessage | null;
}

/** One request and its answer, for a capture (the token is never in it). */
export interface OracleExchange {
  method: string;
  path: string;
  status: number;
  request?: unknown;
  response?: unknown;
}

export interface DiscordBotOracleOptions {
  /** The bot's token, without "Bot ". */
  token: string;
  /** Default https://discord.com/api/v10. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** How a 429 waits. Not called for a wait of 0. */
  sleep?: (ms: number) => Promise<void>;
  /** 429s in a row before a request fails (default 8). */
  maxRetries?: number;
  /** Each exchange, for --capture. */
  onExchange?: (x: OracleExchange) => void;
}

export class DiscordApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    const code = body && typeof body === 'object' && 'code' in body ? ` (code ${(body as { code: unknown }).code})` : '';
    const msg = body && typeof body === 'object' && 'message' in body ? `: ${String((body as { message: unknown }).message)}` : '';
    super(`Discord answered ${method} ${path} with HTTP ${status}${code}${msg}`);
  }
}

/** A file sent with a message (multipart, as a bot sends one). */
export interface BotFile {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

export interface OracleStateOptions {
  /** The two people, by Discord user id (A the extractor's account, B this bot). */
  actorA: string;
  actorB: string;
  /** Only messages after this snowflake (a run's start): the channel's older history is not read. */
  after?: string;
  /** Message ids the run made: those no longer there are the deleted ones. */
  made?: Iterable<Handle>;
}

/** Discord's attachment kinds as the harness names them, from the content type and, without one, the file name. */
export function attachmentKindOf(a: Pick<DiscordAttachment, 'content_type' | 'filename'>): string {
  const ct = (a.content_type ?? '').toLowerCase();
  for (const k of ['image', 'video', 'audio']) if (ct.startsWith(`${k}/`)) return k;
  const name = a.filename.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|avif|jxl)$/.test(name)) return 'image';
  if (/\.(mp4|mov|webm|mkv|avi)$/.test(name)) return 'video';
  if (/\.(mp3|ogg|wav|flac|m4a|opus)$/.test(name)) return 'audio';
  return 'file';
}

/** A reaction's key as the chat protocol names it: the glyph, or name:id for a server's own emoji. */
export const emojiKey = (e: DiscordEmoji): string => (e.id ? `${e.name ?? '_'}:${e.id}` : (e.name ?? ''));
/** The emoji as a URL path segment: the glyph URL-encoded, or name:id. */
export const emojiPath = (key: string): string => encodeURIComponent(key);

const bigMax = (a: string, b: string) => (BigInt(a) > BigInt(b) ? a : b);

export class DiscordBotOracle {
  readonly baseUrl: string;
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  /** 429s answered so far (a test checks the fake's were waited out). */
  rateLimited = 0;
  private self: DiscordUser | null = null;

  constructor(private readonly opts: DiscordBotOracleOptions) {
    if (!opts.token) throw new Error('DiscordBotOracle: no bot token');
    this.baseUrl = (opts.baseUrl ?? DISCORD_API).replace(/\/+$/, '');
    this.fetch = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = opts.maxRetries ?? 8;
  }

  /** One request: JSON or multipart in, JSON out; a 429 waited out and sent again. */
  async request<T>(method: string, path: string, body?: unknown, o: { form?: FormData; reason?: string } = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { authorization: `Bot ${this.opts.token}`, 'user-agent': 'DiscordBot (dither-accounts parity, 1)' };
      let payload: BodyInit | undefined;
      if (o.form) payload = o.form;
      else if (body !== undefined) {
        headers['content-type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      if (o.reason) headers['x-audit-log-reason'] = encodeURIComponent(o.reason);
      const res = await this.fetch(`${this.baseUrl}${path}`, { method, headers, body: payload });
      const text = await res.text();
      let json: unknown = undefined;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = text;
      }
      this.opts.onExchange?.({ method, path, status: res.status, ...(body !== undefined ? { request: body } : {}), ...(json !== undefined ? { response: json } : {}) });
      if (res.status === 429 && attempt < this.maxRetries) {
        this.rateLimited++;
        // Retry-After (seconds) is the header; the body's retry_after (seconds, fractional) is more exact.
        const fromBody = json && typeof json === 'object' && 'retry_after' in json ? Number((json as { retry_after: unknown }).retry_after) : NaN;
        const secs = Number.isFinite(fromBody) ? fromBody : Number(res.headers.get('retry-after') ?? 1);
        const ms = Math.max(0, Math.ceil(secs * 1000));
        if (ms > 0) await this.sleep(ms);
        continue;
      }
      if (!res.ok) throw new DiscordApiError(method, path, res.status, json);
      return json as T;
    }
  }

  /** The bot's own user. */
  async me(): Promise<DiscordUser> {
    return (this.self ??= await this.request<DiscordUser>('GET', '/users/@me'));
  }

  // ------------------------------------------------------------ the other person

  async send(channelId: string, content: string, o: { replyTo?: string; file?: BotFile } = {}): Promise<DiscordMessage> {
    const json: Record<string, unknown> = { content, allowed_mentions: { parse: [] } };
    if (o.replyTo) json.message_reference = { type: 0, message_id: o.replyTo, channel_id: channelId, fail_if_not_exists: true };
    if (!o.file) return this.request('POST', `/channels/${channelId}/messages`, json);
    json.attachments = [{ id: 0, filename: o.file.name }];
    const form = new FormData();
    form.append('payload_json', JSON.stringify(json));
    form.append('files[0]', new Blob([new Uint8Array(o.file.bytes)], { type: o.file.mime }), o.file.name);
    return this.request('POST', `/channels/${channelId}/messages`, json, { form });
  }

  reply(channelId: string, messageId: string, content: string): Promise<DiscordMessage> {
    return this.send(channelId, content, { replyTo: messageId });
  }

  edit(channelId: string, messageId: string, content: string): Promise<DiscordMessage> {
    return this.request('PATCH', `/channels/${channelId}/messages/${messageId}`, { content });
  }

  async react(channelId: string, messageId: string, key: string, remove = false): Promise<void> {
    await this.request(remove ? 'DELETE' : 'PUT', `/channels/${channelId}/messages/${messageId}/reactions/${emojiPath(key)}/@me`);
  }

  async delete(channelId: string, messageId: string): Promise<void> {
    await this.request('DELETE', `/channels/${channelId}/messages/${messageId}`);
  }

  async pin(channelId: string, messageId: string, pinned: boolean): Promise<void> {
    await this.request(pinned ? 'PUT' : 'DELETE', `/channels/${channelId}/messages/pins/${messageId}`);
  }

  // ------------------------------------------------------------------ the oracle

  /** One message, or null when Discord has none by that id (deleted). */
  async message(channelId: string, messageId: string): Promise<DiscordMessage | null> {
    try {
      return await this.request<DiscordMessage>('GET', `/channels/${channelId}/messages/${messageId}`);
    } catch (e) {
      if (e instanceof DiscordApiError && e.status === 404) return null;
      throw e;
    }
  }

  /** Every message after `after` (oldest first), a page of 100 at a time. */
  async messages(channelId: string, after = '0'): Promise<DiscordMessage[]> {
    const out: DiscordMessage[] = [];
    for (let cursor = after; ; ) {
      const page = await this.request<DiscordMessage[]>('GET', `/channels/${channelId}/messages?after=${cursor}&limit=100`);
      if (!page.length) break;
      out.push(...page);
      cursor = page.map((m) => m.id).reduce(bigMax);
      if (page.length < 100) break;
    }
    return out.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  }

  /** Everyone who reacted with this emoji (normal reactions), a page of 100 at a time. */
  async reactors(channelId: string, messageId: string, key: string): Promise<DiscordUser[]> {
    const out: DiscordUser[] = [];
    for (let after = '0'; ; ) {
      const page = await this.request<DiscordUser[]>('GET', `/channels/${channelId}/messages/${messageId}/reactions/${emojiPath(key)}?type=0&limit=100&after=${after}`);
      out.push(...page);
      if (page.length < 100) break;
      after = page.map((u) => u.id).reduce(bigMax);
    }
    return out;
  }

  /** The channel's pinned message ids, every page. */
  async pins(channelId: string): Promise<Set<string>> {
    const ids = new Set<string>();
    for (let before: string | undefined; ; ) {
      const page = await this.request<{ items: { pinned_at: string; message: DiscordMessage }[]; has_more: boolean }>('GET', `/channels/${channelId}/messages/pins?limit=50${before ? `&before=${encodeURIComponent(before)}` : ''}`);
      for (const p of page.items) ids.add(p.message.id);
      if (!page.has_more || !page.items.length) break;
      before = page.items[page.items.length - 1]!.pinned_at;
    }
    return ids;
  }

  /** The channel as Discord holds it, as the harness compares it. Discord's own notices (a pin's) are left out. */
  async oracleState(channelId: string, o: OracleStateOptions): Promise<NormalizedConversationState> {
    const [list, pinned] = await Promise.all([this.messages(channelId, o.after), this.pins(channelId)]);
    const live: RawMessage[] = [];
    for (const m of list) {
      if (!USER_MESSAGE_TYPES.has(m.type)) continue;
      const reactions: { author: string; key: string }[] = [];
      for (const r of m.reactions ?? []) {
        if (!(r.count_details?.normal ?? r.count)) continue;
        const key = emojiKey(r.emoji);
        for (const u of await this.reactors(channelId, m.id, key)) reactions.push({ author: u.id, key });
      }
      const ref = m.message_reference;
      live.push({
        id: m.id,
        author: m.author.id,
        body: m.content,
        edited: m.edited_timestamp != null,
        replyTo: m.type === 19 && ref?.message_id && (ref.type ?? 0) === 0 ? ref.message_id : null,
        reactions,
        pinned: pinned.has(m.id),
        attachments: m.attachments.map((a) => ({ kind: attachmentKindOf(a), name: a.filename })),
      });
    }
    const there = new Set(live.map((m) => m.id));
    const all = new Set(list.map((m) => m.id));
    return normalize(o, live, [...(o.made ?? [])].filter((h) => !there.has(h) && !all.has(h)));
  }
}
