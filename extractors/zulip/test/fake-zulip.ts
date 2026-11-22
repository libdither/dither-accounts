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
}

export function fakeZulip(opts: FakeOptions = {}) {
  const users = [
    { user_id: 8, email: 'user8@chat.example.org', delivery_email: 'quinn@example.com', full_name: 'Quinn Park', role: 100, is_active: true, avatar_url: '/user_avatars/2/q.png' },
    { user_id: 9, email: 'user9@chat.example.org', full_name: 'Ann Lee', role: 200, is_active: true, avatar_url: 'https://example.com/ann.png' },
    { user_id: 10, email: 'user10@chat.example.org', full_name: 'Bob Kim', role: 400, is_active: true },
  ];
  const sub = (stream_id: number, name: string, extra: object = {}) => ({ stream_id, name, description: '', invite_only: false, history_public_to_subscribers: true, is_muted: false, ...extra });
  let messages: any[] = [
    { id: 100, sender_id: 9, sender_full_name: 'Ann Lee', content: 'hello @**Quinn Park|8**', timestamp: 1_700_000_000, type: 'stream', stream_id: 3, subject: 'plans', display_recipient: 'general', reactions: [], submessages: [], flags: ['mentioned'] },
    { id: 101, sender_id: 8, sender_full_name: 'Quinn Park', content: 'hi', timestamp: 1_700_000_010, type: 'stream', stream_id: 3, subject: 'plans', display_recipient: 'general', reactions: [{ emoji_name: 'thumbs_up', emoji_code: '1f44d', reaction_type: 'unicode_emoji', user_id: 9 }], submessages: [], flags: ['read'] },
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
      if (url.pathname === '/static/generated/emoji/emoji_codes.json') return json({ name_to_codepoint: { thumbs_up: '1f44d', smile: '1f604' }, codepoint_to_name: { '1f44d': 'thumbs_up', '1f604': 'smile' } });
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
        const id = nextId++;
        return ok({ id });
      }
      if (path === '/messages/flags/narrow') {
        const before = Number(params.anchor);
        const hit = messages.filter((m) => m.id <= before && !m.flags.includes('read') && (params.narrow as any[]).every((n) => (n.operator === 'channel' ? m.stream_id === n.operand : n.operator === 'topic' ? m.subject === n.operand : true)));
        for (const m of hit) m.flags.push('read');
        return ok({ processed_count: hit.length, updated_count: hit.length, first_processed_id: hit[0]?.id ?? null, last_processed_id: hit.at(-1)?.id ?? null, found_oldest: true, found_newest: true });
      }
      if (/^\/messages\/\d+\/reactions$/.test(path)) return ok();
      if (/^\/messages\/\d+\/read_receipts$/.test(path)) return ok({ user_ids: readers.get(Number(path.split('/')[2])) ?? [] });
      if (path === '/realm/presence') return ok({ presences: opts.realmPresence ?? {}, server_timestamp: Date.now() / 1000 });
      if (/^\/streams\/\d+\/members$/.test(path)) return ok({ subscribers: opts.subscribers?.[Number(path.split('/')[2])] ?? users.map((u) => u.user_id) });
      if (/^\/messages\/\d+$/.test(path) && req.method === 'PATCH') return ok();
      if (/^\/users\/me\/muted_users\/\d+$/.test(path)) return ok();
      if (/^\/users\/me\/\d+\/topics$/.test(path)) {
        const stream = Number(path.split('/')[3]);
        const topics = new Map<string, number>();
        for (const m of messages) if (m.stream_id === stream) topics.set(m.subject, Math.max(topics.get(m.subject) ?? 0, m.id));
        return ok({ topics: [...topics].map(([name, max_id]) => ({ name, max_id })).sort((a, b) => b.max_id - a.max_id) });
      }
      if (path === '/user_topics' || path === '/typing' || path === '/users/me/subscriptions/properties') return ok();
      return json({ result: 'error', msg: `fake has no ${req.method} ${path}` }, 404);
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
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
