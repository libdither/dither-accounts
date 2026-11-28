/**
 * A fake Zulip server on 127.0.0.1, port 0: just enough of the REST API and the event queue for the adapter's tests.
 * Invented organization: Quinn Park (8, the account), Ann Lee (9), Bob Kim (10); channels general (3) and design (4).
 * A test pushes events with `push` and reads what the adapter asked for in `calls`.
 */
export interface Call {
  method: string;
  path: string;
  params: Record<string, any>;
}

const KEY = 'k'.repeat(32);

export interface FakeOptions {
  /** More of /register's answer (settings, presences, groups), over the defaults. */
  register?: Record<string, unknown>;
  /** More messages, after the three every test has. */
  messages?: any[];
  /** A channel's subscribers, for /streams/{id}/members (default: everyone). */
  subscribers?: Record<number, number[]>;
  /** Who has read which message, for /messages/{id}/read_receipts, from the start. */
  readers?: Record<number, number[]>;
  /** GET /realm/presence's answer, by API email (Zulip's legacy form). */
  realmPresence?: Record<string, unknown>;
  /** More people, or more about the three (by id: profile_data, bot_owner_id, date_joined...). */
  users?: Record<number, Record<string, unknown>>;
  /** GET /realm/profile_fields's answer. */
  profileFields?: any[];
  /**
   * Keep what is written, as a real server does: a message sent, edited, deleted or reacted to is stored and each
   * change goes out on the event queue (the sender's own queue too, as Zulip does), and `act` lets someone else do
   * the same server-side. Off, writes are answered and forgotten (the unit tests read `calls`).
   */
  live?: boolean;
}

export function fakeZulip(opts: FakeOptions = {}) {
  const users = [
    { user_id: 8, email: 'user8@chat.example.org', delivery_email: 'quinn@example.com', full_name: 'Quinn Park', role: 100, is_active: true, avatar_url: '/user_avatars/2/q.png' },
    { user_id: 9, email: 'user9@chat.example.org', full_name: 'Ann Lee', role: 200, is_active: true, avatar_url: 'https://example.com/ann.png', timezone: 'Europe/Berlin' },
    { user_id: 10, email: 'user10@chat.example.org', full_name: 'Bob Kim', role: 400, is_active: true },
  ];
  for (const [id, extra] of Object.entries(opts.users ?? {})) {
    const u = users.find((x) => x.user_id === Number(id));
    if (u) Object.assign(u, extra);
    else users.push({ user_id: Number(id), email: `user${id}@chat.example.org`, full_name: `User ${id}`, role: 400, is_active: true, ...extra } as (typeof users)[number]);
  }
  const sub = (stream_id: number, name: string, extra: object = {}) => ({ stream_id, name, description: '', invite_only: false, history_public_to_subscribers: true, is_muted: false, ...extra });
  let messages: any[] = [
    { id: 100, sender_id: 9, sender_full_name: 'Ann Lee', content: 'hello @**Quinn Park|8**', timestamp: 1_700_000_000, type: 'stream', stream_id: 3, subject: 'plans', display_recipient: 'general', reactions: [], submessages: [], flags: ['mentioned'] },
    { id: 101, sender_id: 8, sender_full_name: 'Quinn Park', content: 'hi', timestamp: 1_700_000_010, last_moved_timestamp: 1_700_000_050, type: 'stream', stream_id: 3, subject: 'plans', display_recipient: 'general', reactions: [{ emoji_name: 'thumbs_up', emoji_code: '1f44d', reaction_type: 'unicode_emoji', user_id: 9 }], submessages: [], flags: ['read'] },
    { id: 102, sender_id: 9, sender_full_name: 'Ann Lee', content: 'dm', timestamp: 1_700_000_020, type: 'private', display_recipient: [{ id: 8, email: 'user8@chat.example.org', full_name: 'Quinn Park' }, { id: 9, email: 'user9@chat.example.org', full_name: 'Ann Lee' }], reactions: [], submessages: [], flags: [] },
    ...(opts.messages ?? []),
  ];
  /** Who has read each message, for /messages/{id}/read_receipts; a test changes it as people read. */
  const readers = new Map<number, number[]>(Object.entries(opts.readers ?? {}).map(([k, v]) => [Number(k), v]));
  let nextId = 200;
  const queue: any[] = [];
  let eventId = -1;
  let waiting: (() => void) | null = null;
  const calls: Call[] = [];
  let queueId = 'q1';

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const ok = (body: object = {}) => json({ result: 'success', msg: '', ...body });
  const parse = (v: string) => {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  };

  const push = (ev: object) => {
    queue.push({ id: ++eventId, ...ev });
    waiting?.();
  };

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const params: Record<string, any> = {};
      for (const [k, v] of url.searchParams) params[k] = parse(v);
      if (req.method !== 'GET' && req.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) for (const [k, v] of new URLSearchParams(await req.text())) params[k] = parse(v);
      const path = url.pathname.replace(/^\/api\/v1/, '');
      calls.push({ method: req.method, path, params });
      if (url.pathname === '/static/generated/emoji/emoji_codes.json') return json({ name_to_codepoint: { thumbs_up: '1f44d', smile: '1f604', tada: '1f389' }, codepoint_to_name: { '1f44d': 'thumbs_up', '1f604': 'smile', '1f389': 'tada' } });
      if (path === '/server_settings') return ok({ zulip_version: '13.2', zulip_feature_level: 517, realm_name: 'Example Org' });
      const auth = req.headers.get('authorization') ?? '';
      if (path === '/fetch_api_key') return params.password === 'pw' ? ok({ api_key: KEY, email: 'quinn@example.com', user_id: 8 }) : json({ result: 'error', msg: 'Bad password', code: 'AUTHENTICATION_FAILED' }, 403);
      if (auth !== `Basic ${Buffer.from(`quinn@example.com:${KEY}`).toString('base64')}`) return json({ result: 'error', msg: 'Invalid API key', code: 'UNAUTHORIZED' }, 401);
      if (path === '/register') {
        queueId = `q${Date.now()}`;
        return ok({
          queue_id: queueId,
          last_event_id: eventId,
          user_id: 8,
          role: 100,
          realm_name: 'Example Org',
          realm_users: users,
          subscriptions: [sub(3, 'general'), sub(4, 'design', { folder_id: 1, is_muted: true })],
          channel_folders: [{ id: 1, name: 'Work', order: 0 }],
          realm_user_groups: [],
          realm_emoji: {},
          user_topics: [],
          recent_private_conversations: [{ user_ids: [9], max_message_id: 102 }],
          muted_users: [],
          starred_messages: [101],
          unread_msgs: { streams: [{ stream_id: 3, topic: 'plans', unread_message_ids: [100] }], pms: [{ other_user_id: 9, unread_message_ids: [102] }], huddles: [], mentions: [100] },
          ...opts.register,
        });
      }
      if (path === '/events' && req.method === 'GET') {
        if (params.queue_id !== queueId) return json({ result: 'error', msg: 'Bad event queue id', code: 'BAD_EVENT_QUEUE_ID' }, 400);
        const after = Number(params.last_event_id);
        if (!queue.some((e) => e.id > after)) await Promise.race([new Promise<void>((r) => (waiting = r)), Bun.sleep(2_000)]);
        waiting = null;
        return ok({ events: queue.filter((e) => e.id > after) });
      }
      if (path === '/events' && req.method === 'DELETE') return ok();
      if (path === '/messages' && req.method === 'GET') {
        if (params.message_ids) return ok({ messages: messages.filter((m) => params.message_ids.includes(m.id)) });
        const narrow: any[] = params.narrow ?? [];
        let list = messages.filter((m) =>
          narrow.every((n) => (n.operator === 'is' && n.operand === 'unread' ? !m.flags.includes('read') : n.operator === 'channel' ? m.stream_id === n.operand : n.operator === 'topic' ? (m.subject ?? '').toLowerCase() === String(n.operand).toLowerCase() : true)),
        );
        if (typeof params.anchor === 'number') list = list.filter((m) => m.id < params.anchor || (params.include_anchor !== false && m.id === params.anchor));
        list = list.slice(-Number(params.num_before || 0) || undefined);
        return ok({ messages: list, found_oldest: true, found_newest: true });
      }
      if (path === '/messages' && req.method === 'POST') {
        if (opts.live) {
          const to = params.type === 'stream' || params.type === 'channel' ? { stream: Number(params.to), topic: String(params.topic ?? '') } : { dm: (Array.isArray(params.to) ? params.to : [params.to]).map(Number) };
          return ok({ id: act.send(8, to, String(params.content)) });
        }
        const id = nextId++;
        return ok({ id });
      }
      if (opts.live && /^\/messages\/\d+\/reactions$/.test(path) && (req.method === 'POST' || req.method === 'DELETE')) {
        act.react(Number(path.split('/')[2]), 8, String(params.emoji_name), req.method === 'POST' ? 'add' : 'remove');
        return ok();
      }
      if (opts.live && /^\/messages\/\d+$/.test(path) && req.method === 'PATCH') {
        act.edit(Number(path.split('/')[2]), String(params.content), 8);
        return ok();
      }
      if (opts.live && /^\/messages\/\d+$/.test(path) && req.method === 'DELETE') {
        act.delete(Number(path.split('/')[2]));
        return ok();
      }
      if (path === '/messages/flags/narrow') {
        const before = Number(params.anchor);
        const hit = messages.filter((m) => m.id <= before && !m.flags.includes('read') && (params.narrow as any[]).every((n) => (n.operator === 'channel' ? m.stream_id === n.operand : n.operator === 'topic' ? m.subject === n.operand : true)));
        for (const m of hit) m.flags.push('read');
        return ok({ processed_count: hit.length, updated_count: hit.length, first_processed_id: hit[0]?.id ?? null, last_processed_id: hit.at(-1)?.id ?? null, found_oldest: true, found_newest: true });
      }
      if (/^\/messages\/\d+\/reactions$/.test(path)) return ok();
      if (/^\/messages\/\d+\/read_receipts$/.test(path)) return ok({ user_ids: readers.get(Number(path.split('/')[2])) ?? [] });
      if (/^\/users\/\d+$/.test(path) && req.method === 'GET') {
        const u = users.find((x) => x.user_id === Number(path.split('/')[2]));
        return u ? ok({ user: u }) : json({ result: 'error', msg: 'No such user', code: 'BAD_REQUEST' }, 400);
      }
      if (path === '/realm/profile_fields') return ok({ custom_fields: opts.profileFields ?? [] });
      if (path === '/realm/presence') return ok({ presences: opts.realmPresence ?? {}, server_timestamp: Date.now() / 1000 });
      if (/^\/streams\/\d+\/members$/.test(path)) return ok({ subscribers: opts.subscribers?.[Number(path.split('/')[2])] ?? users.map((u) => u.user_id) });
      if (/^\/messages\/\d+$/.test(path) && req.method === 'PATCH') return ok();
      if (/^\/users\/me\/muted_users\/\d+$/.test(path)) return ok();
      if (/^\/users\/\d+$/.test(path)) {
        const u = users.find((x) => x.user_id === Number(path.split('/')[2]));
        return u ? ok({ user: u }) : json({ result: 'error', msg: 'No such user' }, 400);
      }
      if (path === '/realm/profile_fields') return ok({ custom_fields: [] });
      if (/^\/users\/me\/\d+\/topics$/.test(path)) {
        const stream = Number(path.split('/')[3]);
        const topics = new Map<string, number>();
        for (const m of messages) if (m.stream_id === stream) topics.set(m.subject, Math.max(topics.get(m.subject) ?? 0, m.id));
        return ok({ topics: [...topics].map(([name, max_id]) => ({ name, max_id })).sort((a, b) => b.max_id - a.max_id) });
      }
      if (path === '/user_topics' || path === '/typing') return ok();
      return json({ result: 'error', msg: `fake has no ${req.method} ${path}` }, 404);
    },
  });

  const now = () => Math.floor(Date.now() / 1000);
  const find = (id: number) => {
    const m = messages.find((x) => x.id === id);
    if (!m) throw new Error(`the fake has no message ${id}`);
    return m;
  };
  const emojiCodes: Record<string, string> = { thumbs_up: '1f44d', smile: '1f604', tada: '1f389' };
  /** What the server does when someone writes (live mode): the message stored, and an event for it. */
  const act = {
    send(sender: number, to: { stream: number; topic: string } | { dm: number[] }, content: string): number {
      const id = nextId++;
      const who = users.find((u) => u.user_id === sender)!;
      const base = { id, sender_id: sender, sender_full_name: who.full_name, content, timestamp: now(), reactions: [] as any[], submessages: [], flags: sender === 8 ? ['read'] : [] };
      const m =
        'stream' in to
          ? { ...base, type: 'stream', stream_id: to.stream, subject: to.topic, display_recipient: to.stream === 3 ? 'general' : 'design' }
          : { ...base, type: 'private', display_recipient: [...new Set([sender, ...to.dm])].sort((a, b) => a - b).map((uid) => ({ id: uid, email: users.find((u) => u.user_id === uid)!.email, full_name: users.find((u) => u.user_id === uid)!.full_name })) };
      messages = [...messages, m];
      push({ type: 'message', message: { ...m, flags: undefined }, flags: m.flags });
      return id;
    },
    edit(id: number, content: string, by: number) {
      const m = find(id);
      const orig = m.content;
      m.content = content;
      m.last_edit_timestamp = now();
      push({ type: 'update_message', user_id: by, message_id: id, message_ids: [id], content, orig_content: orig, rendered_content: content, edit_timestamp: m.last_edit_timestamp, flags: m.flags, ...(m.type === 'stream' ? { stream_id: m.stream_id } : {}) });
    },
    delete(id: number) {
      const m = find(id);
      messages = messages.filter((x) => x.id !== id);
      push({ type: 'delete_message', message_id: id, message_ids: [id], message_type: m.type, ...(m.type === 'stream' ? { stream_id: m.stream_id, topic: m.subject } : {}) });
    },
    react(id: number, user: number, emojiName: string, op: 'add' | 'remove') {
      const m = find(id);
      const code = emojiCodes[emojiName] ?? emojiName;
      const r = { emoji_name: emojiName, emoji_code: code, reaction_type: 'unicode_emoji', user_id: user };
      const has = m.reactions.some((x: any) => x.user_id === user && x.emoji_code === code);
      if (op === 'add' && has) throw new Error('Reaction already exists');
      if (op === 'remove' && !has) throw new Error("Reaction doesn't exist");
      m.reactions = op === 'add' ? [...m.reactions, r] : m.reactions.filter((x: any) => !(x.user_id === user && x.emoji_code === code));
      push({ type: 'reaction', op, message_id: id, ...r });
    },
  };

  return {
    url: `http://127.0.0.1:${server.port}`,
    /** Someone writing on the server (live mode): what their client's requests would do. */
    act,
    /** The server's messages as they stand (the oracle of tests/chat-parity). */
    get messages(): readonly any[] {
      return messages;
    },
    key: KEY,
    calls,
    push,
    readers,
    addMessage(m: object) {
      messages = [...messages, m];
    },
    /** Deleted on the server, without an event (as while the adapter's queue was gone). */
    removeMessage(id: number) {
      messages = messages.filter((m) => m.id !== id);
    },
    /** The server forgets the adapter's queue (a restart, a long sleep). */
    dropQueue() {
      queueId = 'gone';
      waiting?.();
    },
    stop() {
      server.stop(true);
    },
  };
}
