/**
 * A fake Discord for the composition parity suite (discord-parity.test.ts): the REST API (v9, as the web client
 * calls it, and v10, as a bot does) over one server and its channels, storing messages, edits, reactions, replies,
 * pins and deletes, and the gateway's dispatches that follow each change, told to every connected user as Discord's
 * gateway tells them (each one's own `me` on reactions). Bun.serve on port 0; everything invented.
 *
 * Shaped after Discord's API docs (Message, Reaction, Channel Pins, the gateway's MESSAGE_* events) and the client's
 * own requests the hook makes (hook.js `sendWithFiles`, `react`, `pinCommand`): a reaction taken back by the client
 * names its type (`/reactions/{emoji}/0/@me`), a bot's does not (`/reactions/{emoji}/@me`). A pin is a
 * MESSAGE_UPDATE, then Discord's "pinned a message" notice (type 6), then CHANNEL_PINS_UPDATE, as the gateway sends
 * them.
 */
import type { DiscordAttachment, DiscordMessage, DiscordUser } from './discord-bot-oracle.ts';

export const DISCORD_EPOCH = 1420070400000;

export interface FakeUser extends DiscordUser {
  token: string;
}

/** A gateway dispatch as Discord sends it (op 0): its name and its data, snake_case. */
export interface GatewayDispatch {
  t: string;
  d: any;
}

interface Stored {
  id: string;
  channel_id: string;
  author: string;
  content: string;
  timestamp: string;
  edited_timestamp: string | null;
  type: number;
  nonce?: string | number;
  reference?: { type: number; message_id: string; channel_id: string };
  attachments: DiscordAttachment[];
  /** emoji key → user ids, in the order they reacted */
  reactions: Map<string, string[]>;
  pinnedAt: string | null;
}

export interface FakeDiscordOptions {
  guildId?: string;
  channelId?: string;
  users: FakeUser[];
}

export function fakeDiscord(o: FakeDiscordOptions) {
  const guildId = o.guildId ?? '200000000000000001';
  const channelId = o.channelId ?? '300000000000000001';
  const users = new Map(o.users.map((u) => [u.id, u]));
  const byToken = new Map(o.users.map((u) => [u.token, u]));
  const channels = new Map<string, Map<string, Stored>>([[channelId, new Map()]]);
  const uploads = new Map<string, { bytes: Uint8Array; mime: string }>();
  const listeners = new Map<string, Set<(d: GatewayDispatch) => void>>();
  const changeListeners = new Set<() => void>();
  /** Each request, for a test that checks what the client asked. */
  const requests: { method: string; path: string; user: string }[] = [];
  let lastId = 0n;
  let rateLimitNext = 0;

  const snowflake = () => {
    const now = BigInt(Date.now() - DISCORD_EPOCH) << 22n;
    lastId = now > lastId ? now : lastId + 1n;
    return lastId.toString();
  };
  const iso = () => new Date().toISOString();
  const publicUser = (id: string): DiscordUser => {
    const u = users.get(id)!;
    return { id: u.id, username: u.username, global_name: u.global_name ?? null, ...(u.bot ? { bot: true } : {}) };
  };

  /** A message as `viewer` reads it (REST) or hears it (gateway): `me` on reactions is theirs. */
  function view(m: Stored, viewer: string, withReferenced = true): DiscordMessage {
    const reactions = [...m.reactions].filter(([, who]) => who.length).map(([key, who]) => {
      const [name, id] = key.includes(':') ? [key.slice(0, key.lastIndexOf(':')), key.slice(key.lastIndexOf(':') + 1)] : [key, null];
      return { emoji: { id, name }, count: who.length, count_details: { burst: 0, normal: who.length }, burst_colors: [], me_burst: false, burst_me: false, me: who.includes(viewer), burst_count: 0 };
    });
    const parent = m.reference ? channels.get(m.reference.channel_id)?.get(m.reference.message_id) : undefined;
    return {
      id: m.id,
      channel_id: m.channel_id,
      guild_id: guildId,
      author: publicUser(m.author),
      content: m.content,
      timestamp: m.timestamp,
      edited_timestamp: m.edited_timestamp,
      type: m.type,
      tts: false,
      mention_everyone: false,
      mentions: [],
      attachments: m.attachments,
      embeds: [],
      ...(reactions.length ? { reactions } : {}),
      pinned: m.pinnedAt !== null,
      ...(m.nonce !== undefined ? { nonce: m.nonce } : {}),
      ...(m.reference ? { message_reference: { type: m.reference.type, message_id: m.reference.message_id, channel_id: m.reference.channel_id, guild_id: guildId } } : {}),
      ...(m.reference && m.type === 19 && withReferenced ? { referenced_message: parent ? view(parent, viewer, false) : null } : {}),
    };
  }

  /** One dispatch to every connected user; `data` is built for each (their own `me`). */
  function dispatch(t: string, data: (viewer: string) => unknown) {
    for (const [user, fns] of listeners) for (const fn of [...fns]) fn({ t, d: data(user) });
    for (const fn of [...changeListeners]) fn();
  }

  const err = (status: number, code: number, message: string) => Response.json({ message, code }, { status });
  const channelOf = (id: string) => channels.get(id);

  function create(user: string, chan: string, body: { content?: string; nonce?: string | number; message_reference?: { message_id?: string; type?: number }; attachments?: { id: string | number; filename: string; uploaded_filename?: string }[] }, files: { name: string; mime: string; bytes: Uint8Array }[] = []): Stored | Response {
    const ch = channelOf(chan)!;
    const ref = body.message_reference?.message_id;
    if (ref && !ch.has(ref)) return err(400, 50035, 'Invalid Form Body: Unknown message');
    const attachments: DiscordAttachment[] = [];
    for (const [i, a] of (body.attachments ?? []).entries()) {
      // The client's cloud upload names the file it PUT; a bot's multipart sends it in files[n].
      const up = a.uploaded_filename ? uploads.get(a.uploaded_filename) : undefined;
      const f = up ? { name: a.filename, mime: up.mime, bytes: up.bytes } : files[Number(a.id)] ?? files[i];
      if (!f) return err(400, 50035, 'Invalid Form Body: attachment not uploaded');
      const id = snowflake();
      attachments.push({ id, filename: a.filename, content_type: f.mime, size: f.bytes.length, url: `https://cdn.example.com/attachments/${chan}/${id}/${a.filename}`, proxy_url: `https://media.example.com/attachments/${chan}/${id}/${a.filename}`, ...(f.mime.startsWith('image/') ? { width: 1, height: 1 } : {}) });
    }
    if (!body.content && !attachments.length) return err(400, 50006, 'Cannot send an empty message');
    const m: Stored = {
      id: snowflake(),
      channel_id: chan,
      author: user,
      content: body.content ?? '',
      timestamp: iso(),
      edited_timestamp: null,
      type: ref ? 19 : 0,
      ...(body.nonce !== undefined ? { nonce: body.nonce } : {}),
      ...(ref ? { reference: { type: body.message_reference?.type ?? 0, message_id: ref, channel_id: chan } } : {}),
      attachments,
      reactions: new Map(),
      pinnedAt: null,
    };
    ch.set(m.id, m);
    dispatch('MESSAGE_CREATE', (viewer) => ({ ...view(m, viewer), ...(viewer !== user ? { nonce: undefined } : {}) }));
    return m;
  }

  function setPinned(user: string, m: Stored, pinned: boolean) {
    if ((m.pinnedAt !== null) === pinned) return;
    m.pinnedAt = pinned ? iso() : null;
    dispatch('MESSAGE_UPDATE', (viewer) => view(m, viewer));
    if (pinned) {
      // Discord's own notice: who pinned which (type 6, CHANNEL_PINNED_MESSAGE), a message in the channel.
      const notice: Stored = { id: snowflake(), channel_id: m.channel_id, author: user, content: '', timestamp: iso(), edited_timestamp: null, type: 6, reference: { type: 0, message_id: m.id, channel_id: m.channel_id }, attachments: [], reactions: new Map(), pinnedAt: null };
      channelOf(m.channel_id)!.set(notice.id, notice);
      dispatch('MESSAGE_CREATE', (viewer) => view(notice, viewer));
    }
    const latest = [...channelOf(m.channel_id)!.values()].map((x) => x.pinnedAt).filter((x): x is string => !!x).sort().pop() ?? null;
    dispatch('CHANNEL_PINS_UPDATE', () => ({ guild_id: guildId, channel_id: m.channel_id, last_pin_timestamp: latest }));
  }

  function react(user: string, m: Stored, key: string, remove: boolean) {
    const who = m.reactions.get(key) ?? [];
    if (remove ? !who.includes(user) : who.includes(user)) return;
    m.reactions.set(key, remove ? who.filter((x) => x !== user) : [...who, user]);
    const [name, id] = key.includes(':') ? [key.slice(0, key.lastIndexOf(':')), key.slice(key.lastIndexOf(':') + 1)] : [key, null];
    dispatch(remove ? 'MESSAGE_REACTION_REMOVE' : 'MESSAGE_REACTION_ADD', () => ({ user_id: user, channel_id: m.channel_id, message_id: m.id, guild_id: guildId, emoji: { id, name }, burst: false, type: 0, ...(remove ? {} : { message_author_id: m.author, burst_colors: [] }) }));
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const method = req.method;
    // An upload's own URL (the client's cloud upload), no token: the slot is the permission.
    const upload = url.pathname.match(/^\/upload\/([^/]+)$/);
    if (upload && method === 'PUT') {
      uploads.set(decodeURIComponent(upload[1]!), { bytes: new Uint8Array(await req.arrayBuffer()), mime: req.headers.get('content-type') ?? 'application/octet-stream' });
      return new Response(null, { status: 200 });
    }
    const api = url.pathname.match(/^\/api\/v(?:9|10)(\/.*)$/);
    if (!api) return err(404, 0, '404: Not Found');
    const path = api[1]!;
    const auth = req.headers.get('authorization') ?? '';
    const me = byToken.get(auth.replace(/^Bot /, ''));
    // A bot's token says "Bot "; a user's says nothing before it.
    if (!me || auth.startsWith('Bot ') !== !!me.bot) return err(401, 0, '401: Unauthorized');
    requests.push({ method, path, user: me.id });
    if (rateLimitNext > 0) {
      rateLimitNext--;
      return Response.json({ message: 'You are being rate limited.', retry_after: 0, global: false }, { status: 429, headers: { 'retry-after': '0', 'x-ratelimit-scope': 'user' } });
    }
    const json = async () => {
      const ct = req.headers.get('content-type') ?? '';
      if (ct.startsWith('multipart/form-data')) {
        const form = await req.formData();
        const files: { name: string; mime: string; bytes: Uint8Array }[] = [];
        for (const [k, v] of form) {
          const n = k.match(/^files\[(\d+)\]$/);
          if (n && typeof v !== 'string') files[Number(n[1])] = { name: v.name, mime: v.type, bytes: new Uint8Array(await v.arrayBuffer()) };
        }
        return { body: JSON.parse(String(form.get('payload_json') ?? '{}')), files };
      }
      const text = await req.text();
      return { body: text ? JSON.parse(text) : {}, files: [] };
    };

    if (path === '/users/@me' && method === 'GET') return Response.json(publicUser(me.id));

    const ch = path.match(/^\/channels\/(\d+)(\/.*)?$/);
    if (!ch) return err(404, 0, '404: Not Found');
    const chan = ch[1]!;
    const rest = ch[2] ?? '';
    const msgs = channelOf(chan);
    if (!msgs) return err(404, 10003, 'Unknown Channel');

    if (rest === '/attachments' && method === 'POST') {
      const { body } = await json();
      const attachments = (body.files ?? []).map((f: { id: string; filename: string }) => {
        const name = `${crypto.randomUUID()}/${f.filename}`;
        return { id: f.id, upload_filename: name, upload_url: `${url.origin}/upload/${encodeURIComponent(name)}` };
      });
      return Response.json({ attachments });
    }

    if (rest === '/messages' && method === 'GET') {
      const limit = Math.min(100, Number(url.searchParams.get('limit') ?? 50));
      const after = url.searchParams.get('after');
      const before = url.searchParams.get('before');
      let list = [...msgs.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      if (after) list = list.filter((m) => BigInt(m.id) > BigInt(after)).slice(0, limit);
      else {
        if (before) list = list.filter((m) => BigInt(m.id) < BigInt(before));
        list = list.slice(-limit);
      }
      // Newest first, as Discord gives them.
      return Response.json(list.reverse().map((m) => view(m, me.id)));
    }
    if (rest === '/messages' && method === 'POST') {
      const { body, files } = await json();
      const m = create(me.id, chan, body, files);
      return m instanceof Response ? m : Response.json(view(m, me.id));
    }

    const pinsPaged = rest === '/messages/pins';
    if ((pinsPaged || rest === '/pins') && method === 'GET') {
      const pinned = [...msgs.values()].filter((m) => m.pinnedAt).sort((a, b) => b.pinnedAt!.localeCompare(a.pinnedAt!));
      if (!pinsPaged) return Response.json(pinned.map((m) => view(m, me.id)));
      const limit = Math.min(50, Number(url.searchParams.get('limit') ?? 50));
      const before = url.searchParams.get('before');
      const page = pinned.filter((m) => !before || m.pinnedAt! < before);
      return Response.json({ items: page.slice(0, limit).map((m) => ({ pinned_at: m.pinnedAt, message: view(m, me.id) })), has_more: page.length > limit });
    }
    const pin = rest.match(/^\/(?:messages\/)?pins\/(\d+)$/);
    if (pin && (method === 'PUT' || method === 'DELETE')) {
      const m = msgs.get(pin[1]!);
      if (!m) return err(404, 10008, 'Unknown Message');
      setPinned(me.id, m, method === 'PUT');
      return new Response(null, { status: 204 });
    }

    const one = rest.match(/^\/messages\/(\d+)(\/.*)?$/);
    if (!one) return err(404, 0, '404: Not Found');
    const m = msgs.get(one[1]!);
    if (!m) return err(404, 10008, 'Unknown Message');
    const tail = one[2] ?? '';
    if (!tail && method === 'GET') return Response.json(view(m, me.id));
    if (!tail && method === 'PATCH') {
      if (m.author !== me.id) return err(403, 50005, 'Cannot edit a message authored by another user');
      const { body } = await json();
      if (typeof body.content === 'string') m.content = body.content;
      m.edited_timestamp = iso();
      dispatch('MESSAGE_UPDATE', (viewer) => view(m, viewer));
      return Response.json(view(m, me.id));
    }
    if (!tail && method === 'DELETE') {
      // A bot needs Manage Messages for someone else's; this fake's people may delete only their own.
      if (m.author !== me.id) return err(403, 50013, 'Missing Permissions');
      msgs.delete(m.id);
      dispatch('MESSAGE_DELETE', () => ({ id: m.id, channel_id: chan, guild_id: guildId }));
      return new Response(null, { status: 204 });
    }
    const r = tail.match(/^\/reactions\/([^/]+)(?:\/(0|1))?(?:\/(@me))?$/);
    if (r) {
      const key = decodeURIComponent(r[1]!);
      if (r[3] === '@me' && (method === 'PUT' || method === 'DELETE')) {
        react(me.id, m, key, method === 'DELETE');
        return new Response(null, { status: 204 });
      }
      if (!r[3] && method === 'GET') {
        const after = url.searchParams.get('after') ?? '0';
        const limit = Math.min(100, Number(url.searchParams.get('limit') ?? 25));
        const who = (m.reactions.get(key) ?? []).filter((id) => BigInt(id) > BigInt(after)).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
        return Response.json(who.slice(0, limit).map(publicUser));
      }
    }
    return err(404, 0, '404: Not Found');
  }

  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req) => handle(req).catch((e) => err(500, 0, String(e?.message ?? e))) });
  const origin = `http://127.0.0.1:${server.port}`;

  return {
    origin,
    /** A bot's base URL (the oracle's). */
    botBase: `${origin}/api/v10`,
    guildId,
    channelId,
    channels,
    requests,
    /** The gateway, for one user: each dispatch Discord would send them. */
    gateway(user: string, fn: (d: GatewayDispatch) => void): () => void {
      const set = listeners.get(user) ?? listeners.set(user, new Set()).get(user)!;
      set.add(fn);
      return () => set.delete(fn);
    },
    /** Resolves at the next change in the world. */
    changed(): Promise<void> {
      return new Promise((resolve) => {
        const f = () => {
          changeListeners.delete(f);
          resolve();
        };
        changeListeners.add(f);
      });
    },
    /** The next `n` requests are answered 429 with Retry-After: 0. */
    rateLimit(n: number) {
      rateLimitNext = n;
    },
    stop() {
      server.stop(true);
    },
  };
}

export type FakeDiscord = ReturnType<typeof fakeDiscord>;
