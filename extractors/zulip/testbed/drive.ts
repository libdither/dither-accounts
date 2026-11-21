/**
 * An end-to-end battery for the zulip extractor against the sandbox server (README.md): the real adapter, a stand-in
 * hub link (test/link.ts), and the other seeded people acting through plain REST calls.
 *
 *   eval "$(bun extractors/zulip/testbed/sandbox.ts env)"
 *   bun extractors/zulip/testbed/drive.ts [--only <name or prefix>[,<more>]] [--list] [--verbose]
 *
 * Each check is named `<group>.<what>`, waits for the exact event it asserts on, and prints PASS or FAIL with what it
 * saw. Exit status 1 when any failed. Everything it makes (topics, channels, a bot) carries this run's tag, so runs do
 * not trip over each other; it never resets the sandbox. The checks that cost a minute (`robust.rate-limit`) or change
 * the organization for a moment (`cmd.configure-org`) put things back.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { canonicalReactionKey } from '@dither-chat/protocol';
import { ZulipAdapter } from '../src/adapter.ts';
import { type TestLink, testLink } from '../test/link.ts';

// ---------------------------------------------------------------- the sandbox

const CREDS_FILE =
  process.env.ZULIP_SANDBOX_CREDS ??
  [join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'dither-zulip-sandbox', 'creds.json'), join(homedir(), '.cache', 'zulip-sandbox', 'creds.json')].find((f) => existsSync(f)) ??
  '';
if (!CREDS_FILE || !existsSync(CREDS_FILE)) {
  console.error('no creds.json: start the sandbox and set ZULIP_SANDBOX_CREDS (see testbed/README.md)');
  process.exit(2);
}
interface Who {
  email: string;
  apiKey: string;
  userId: number;
  password?: string;
}
const creds = JSON.parse(readFileSync(CREDS_FILE, 'utf8')) as {
  url: string;
  realm: string;
  users: Record<'quinn' | 'ann' | 'bob' | 'cara' | 'dave' | 'bot', Who>;
  channels: Record<string, number>;
  groups: Record<string, number>;
  messages: Record<string, number>;
  scheduledMessageId: number;
  reminderId: number;
};
const BASE = creds.url;
const HOST = new URL(BASE).host;
const { quinn, ann, bob, cara, dave, bot } = creds.users;
const CH = creds.channels;
const M = creds.messages;
const RUN = Date.now().toString(36);

const uid = (w: Who | number) => `${HOST}/u/${typeof w === 'number' ? w : w.userId}`;
const mid = (id: number) => `${HOST}/m/${id}`;
const chan = (stream: number) => `${HOST}/s/${stream}`;
const topicId = (stream: number, topic: string) => `${HOST}/s/${stream}/t/${encodeURIComponent(topic.toLowerCase())}`;
const dmId = (...users: (Who | number)[]) => `${HOST}/dm/${[...new Set(users.map((u) => (typeof u === 'number' ? u : u.userId)))].sort((a, b) => a - b).join(',')}`;
/** A topic name of this run. */
const tn = (name: string) => `drv ${RUN} ${name}`;

type Params = Record<string, unknown>;
const formOf = (params: Params) => {
  const f = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) f.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  return f;
};

/** One REST call as someone; a 429 is waited out. Answers the status and the JSON, whatever it is. */
async function restRaw(who: Who, method: string, path: string, params: Params = {}, form?: FormData): Promise<{ status: number; json: any; headers: Headers }> {
  for (;;) {
    let url = `${BASE}/api/v1${path}`;
    const headers: Record<string, string> = { Authorization: `Basic ${Buffer.from(`${who.email}:${who.apiKey}`).toString('base64')}`, 'User-Agent': 'dither-accounts-drive' };
    let body: BodyInit | undefined;
    if (form) body = form;
    else if (method === 'GET' || method === 'DELETE') {
      const q = formOf(params).toString();
      if (q) url += `?${q}`;
    } else {
      body = formOf(params);
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    const res = await fetch(url, { method, headers, body });
    const json = await res.json().catch(() => null);
    if (res.status === 429) {
      await Bun.sleep((Number(res.headers.get('retry-after') ?? json?.['retry-after'] ?? 2) + 0.2) * 1000);
      continue;
    }
    return { status: res.status, json, headers: res.headers };
  }
}
async function rest(who: Who, method: string, path: string, params: Params = {}, form?: FormData): Promise<any> {
  const r = await restRaw(who, method, path, params, form);
  if (r.status >= 400 || r.json?.result === 'error') throw new Error(`${method} ${path} as ${who.email}: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

type Dest = { stream: number; topic: string } | { dm: (Who | number)[] };
async function say(from: Who, to: Dest, content: string): Promise<number> {
  const params = 'stream' in to ? { type: 'stream', to: to.stream, topic: to.topic, content } : { type: 'direct', to: to.dm.map((u) => (typeof u === 'number' ? u : u.userId)), content };
  return (await rest(from, 'POST', '/messages', params)).id;
}
/** A message as the server has it: Markdown source, and the flags of whoever asks. */
async function raw(id: number, who: Who = quinn): Promise<any> {
  return (await rest(who, 'GET', `/messages/${id}`, { apply_markdown: false, allow_empty_topic_name: true })).message;
}
const CAPS = { archived_channels: true, empty_topic_name: true, notification_settings_null: true, bulk_message_deletion: true, user_avatar_url_field_optional: false, stream_typing_notifications: true, user_settings_object: true, linkifier_url_template: true, user_list_incomplete: true, include_deactivated_groups: true, simplified_presence_events: true };
/** Quinn's state as a fresh client would be told it. */
async function registered(types: string[]): Promise<any> {
  const r = await rest(quinn, 'POST', '/register', {
    fetch_event_types: types,
    event_types: ['heartbeat'],
    apply_markdown: false,
    client_capabilities: CAPS,
  });
  await rest(quinn, 'DELETE', '/events', { queue_id: r.queue_id }).catch(() => {});
  return r;
}
interface Unread {
  /** conversation → unread message ids */
  by: Map<string, number[]>;
  mentions: Set<number>;
}
async function serverUnread(): Promise<Unread> {
  const u = (await registered(['message', 'update_message_flags'])).unread_msgs;
  const by = new Map<string, number[]>();
  for (const s of u.streams ?? []) by.set(topicId(s.stream_id, s.topic), [...(by.get(topicId(s.stream_id, s.topic)) ?? []), ...s.unread_message_ids]);
  for (const p of u.pms ?? []) by.set(dmId(quinn, p.other_user_id ?? p.sender_id), p.unread_message_ids);
  for (const h of u.huddles ?? []) by.set(dmId(...String(h.user_ids_string).split(',').map(Number)), h.unread_message_ids);
  return { by, mentions: new Set(u.mentions ?? []) };
}

/** Someone else's event queue, to see what the extractor's commands make others hear. */
async function listen(who: Who, types: string[]) {
  const r = await rest(who, 'POST', '/register', { event_types: types, fetch_event_types: ['realm'], apply_markdown: false, client_capabilities: CAPS });
  let last = r.last_event_id as number;
  const heard: any[] = [];
  return {
    async next(match: (e: any) => boolean, ms = 8000): Promise<any | null> {
      const until = Date.now() + ms;
      for (;;) {
        const seen = heard.find(match);
        if (seen) return seen;
        if (Date.now() > until) return null;
        const e = await rest(who, 'GET', '/events', { queue_id: r.queue_id, last_event_id: last, dont_block: true });
        for (const ev of e.events ?? []) {
          last = Math.max(last, ev.id);
          heard.push(ev);
        }
        if (!(e.events ?? []).length) await Bun.sleep(150);
      }
    },
    close: () => rest(who, 'DELETE', '/events', { queue_id: r.queue_id }).catch(() => {}),
  };
}

const pngFile = (name: string, rgb?: [number, number, number]) => new File([png(rgb) as unknown as BlobPart], name, { type: 'image/png' });
function png(rgb: [number, number, number] = [40, 120, 200]): Uint8Array {
  // A 1x1 PNG, written by hand: signature, IHDR, IDAT (stored deflate), IEND.
  const crcTable = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 1);
  new DataView(ihdr.buffer).setUint32(4, 1);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const rawRow = new Uint8Array([0, ...rgb]);
  let a = 1;
  let b = 0;
  for (const x of rawRow) {
    a = (a + x) % 65521;
    b = (b + a) % 65521;
  }
  const idat = new Uint8Array([0x78, 0x01, 0x01, 4, 0, 0xfb, 0xff, ...rawRow, b >> 8, b & 0xff, a >> 8, a & 0xff]);
  return Buffer.concat([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array())]);
}
const TMP = mkdtempSync(join(tmpdir(), 'zulip-drive-'));
function tmpFile(name: string, bytes: Uint8Array | string): P.OutgoingAttachment {
  const path = join(TMP, name);
  writeFileSync(path, bytes);
  const mime = name.endsWith('.png') ? 'image/png' : 'text/plain';
  return { path, name, mime, size: typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.length, kind: name.endsWith('.png') ? 'image' : 'file' } as P.OutgoingAttachment;
}

// ---------------------------------------------------------------- the extractor under test

type Ev = P.AdapterEvent & Record<string, any>;
/** Requests the adapter makes pass these first: one may answer in the server's place, or hold a request back. */
const hooks: ((url: string, init: RequestInit) => Promise<Response | void> | Response | void)[] = [];
const hookedFetch = (async (input: any, init?: RequestInit) => {
  const url = String(typeof input === 'string' || input instanceof URL ? input : input.url);
  for (const h of [...hooks]) {
    const r = await h(url, init ?? {});
    if (r) return r;
  }
  return fetch(input, init);
}) as typeof fetch;

interface Session {
  a: ZulipAdapter;
  link: TestLink;
  /** Index of the first `online` status: everything before it is what the start said. */
  startEnd: number;
  /** Quinn's state on the server at that moment. */
  truth: any;
  unreadAtStart: Unread;
  newestAtStart: number[];
}
let cmdN = 0;
async function open(who: Who, secret: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<{ a: ZulipAdapter; link: TestLink }> {
  const link = testLink({ server: BASE, email: who.email }, secret);
  const a = new ZulipAdapter(fetchImpl);
  a.start(link);
  a.onConnect();
  return { a, link };
}
const isOnline = (e: Ev) => e.t === 'status' && e.status === 'online';
let sessionP: Promise<Session> | null = null;
function session(): Promise<Session> {
  sessionP ??= (async () => {
    await setup();
    const unreadAtStart = await serverUnread();
    const truth = await registered(['subscription', 'user_topic', 'recent_private_conversations', 'starred_messages', 'realm_user', 'muted_users', 'channel_folders', 'reminders', 'realm']);
    const newestAtStart = ((await rest(quinn, 'GET', '/messages', { anchor: 'newest', num_before: 100, num_after: 0, narrow: [], apply_markdown: false })).messages as any[]).map((m) => m.id);
    const { a, link } = await open(quinn, { apiKey: quinn.apiKey }, hookedFetch);
    opened.push(a);
    await link.next(isOnline, 60_000);
    return { a, link, startEnd: link.events.findIndex(isOnline), truth, unreadAtStart, newestAtStart };
  })();
  return sessionP;
}
const opened: ZulipAdapter[] = [];

/** Things the checks need that the seed does not make: typed profile fields with Ann's answers. Idempotent. */
let fieldIds: Record<string, number> = {};
async function setup() {
  let fields = (await rest(quinn, 'GET', '/realm/profile_fields')).custom_fields as any[];
  const want: [string, Params][] = [
    ['Pronouns (typed)', { field_type: 8, hint: 'As Zulip types them' }],
    ['Website', { field_type: 5, hint: 'A link' }],
    ['GitHub username', { field_type: 7, field_data: { subtype: 'github' } }],
  ];
  for (const [name, p] of want) if (!fields.some((f) => f.name === name)) await rest(quinn, 'POST', '/realm/profile_fields', { name, ...p });
  fields = (await rest(quinn, 'GET', '/realm/profile_fields')).custom_fields;
  fieldIds = Object.fromEntries(fields.map((f) => [f.name, f.id]));
  await rest(ann, 'PATCH', '/users/me/profile_data', {
    data: [
      { id: fieldIds['Pronouns (typed)'], value: 'she/her' },
      { id: fieldIds.Website, value: 'https://example.com/ann' },
      { id: fieldIds['GitHub username'], value: 'ann-example' },
    ],
  });
}

// ---------------------------------------------------------------- checks

const show = (v: unknown) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s === undefined ? 'undefined' : s.length > 1500 ? `${s.slice(0, 1500)}…` : s;
};

class T {
  fails: string[] = [];
  S!: Session;
  ok(cond: unknown, what: string, evidence?: unknown): boolean {
    if (!cond) this.fails.push(evidence !== undefined ? `${what}\n        got: ${show(evidence)}` : what);
    return !!cond;
  }
  eq(got: unknown, want: unknown, what: string): boolean {
    const same = Bun.deepEquals(got, want);
    if (!same) this.fails.push(`${what}\n        want: ${show(want)}\n        got:  ${show(got)}`);
    return same;
  }
  mark() {
    return this.S.link.events.length;
  }
  /** The first event from `from` on that matches, awaited; null (and a failure) when none comes. */
  async event(what: string, match: (e: Ev) => boolean, from: number, ms = 8000): Promise<Ev | null> {
    try {
      return (await this.S.link.next(match as any, ms, from)) as Ev;
    } catch {
      this.fails.push(`no event: ${what} (waited ${ms} ms)`);
      return null;
    }
  }
  /** As `event`, without failing: for telling what happened instead. */
  async maybe(match: (e: Ev) => boolean, from: number, ms = 3000): Promise<Ev | null> {
    return (this.S.link.next(match as any, ms, from) as Promise<Ev>).catch(() => null);
  }
  /** Events already heard since `from`. */
  heard(match: (e: Ev) => boolean, from = 0): Ev[] {
    return (this.S.link.events as Ev[]).slice(from).filter(match);
  }
  async cmd(c: Record<string, unknown> & { t: string }, what = c.t): Promise<any> {
    try {
      const r = await this.S.a.command({ id: `d${++cmdN}`, ...c } as any);
      return r === undefined ? null : r;
    } catch (e) {
      this.fails.push(`${what}: the command failed: ${(e as Error).message}`);
      return undefined;
    }
  }
  async refuses(c: Record<string, unknown> & { t: string }, what: string): Promise<string | null> {
    try {
      const r = await this.S.a.command({ id: `d${++cmdN}`, ...c } as any);
      this.fails.push(`${what}: expected a refusal`, show(r));
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }
  /** Waits until the extractor has heard everything the server said so far: Ann types to Quinn, and that is heard. */
  async settled() {
    const from = this.mark();
    await rest(ann, 'POST', '/typing', { op: 'start', type: 'direct', to: [quinn.userId] });
    await this.S.link.next((e: any) => e.t === 'typing' && e.author === uid(ann) && e.conversation === dmId(quinn, ann) && !e.stop, 8000, from).catch(() => this.fails.push('the extractor did not hear a typing notice used as a marker'));
  }
}

const checks: { name: string; run: (t: T) => Promise<void>; noSession?: boolean }[] = [];
function check(name: string, run: (t: T) => Promise<void>, opts: { noSession?: boolean } = {}) {
  checks.push({ name, run, ...opts });
}

const isMsg = (id: number) => (e: Ev) => e.t === 'message' && e.message.nativeId === mid(id);
const isConv = (id: string) => (e: Ev) => e.t === 'conversation' && e.conversation.nativeId === id;
const isRead = (conv: string, unread?: number) => (e: Ev) => e.t === 'read' && e.conversation === conv && (unread === undefined || e.unread === unread);

// ================================================================ start

check(
  'start.password-swap',
  async (t) => {
    const { a, link } = await open(quinn, { password: quinn.password });
    opened.push(a);
    const on = await link.next(isOnline, 60_000).catch(() => null);
    t.ok(on, 'online after signing in with a password', link.events.filter((e) => e.t === 'status').pop());
    t.eq(Object.keys(link.secretValue).sort(), ['apiKey', 'email'], 'the secret holds a key and the email, and the password is gone');
    t.eq(link.secretValue.apiKey, quinn.apiKey, 'the key is the account\'s own');
    t.eq(link.secretValue.email, quinn.email, 'the email kept is the one to sign in with');
    t.ok(!JSON.stringify([link.events.filter((e) => e.t === 'status'), link.logs]).includes(String(quinn.password)) && !JSON.stringify([link.events.filter((e) => e.t === 'status'), link.logs]).includes(quinn.apiKey), 'neither the password nor the key is in a status or a log line');
    await a.shutdown();
  },
  { noSession: true },
);

check(
  'start.wrong-password',
  async (t) => {
    const { a, link } = await open(quinn, { password: 'not-the-password' });
    opened.push(a);
    const st = (await link.next((e: any) => e.t === 'status' && e.status !== 'connecting', 30_000).catch(() => null)) as Ev | null;
    t.ok(st?.status === 'attention' && st.attention?.kind === 'login', 'a wrong password asks for a login', st);
    await a.shutdown();
  },
  { noSession: true },
);

check('start.hello', async (t) => {
  const hello = t.S.link.events.find((e) => e.t === 'hello') as Ev;
  t.ok(hello?.network === 'zulip' && hello.capabilities.includes('send'), 'hello names the network and its capabilities', hello);
  const on = t.S.link.events[t.S.startEnd] as Ev;
  t.eq(on.self?.nativeId, uid(quinn), 'the online status carries the account itself');
  t.eq(on.self?.handle, quinn.email, 'whose handle is the sign-in email');
});

check('start.org-and-folders', async (t) => {
  const start = (t.S.link.events as Ev[]).slice(0, t.S.startEnd);
  const org = start.find((e) => e.t === 'space' && e.space.nativeId === HOST);
  t.ok(org?.space.kind === 'community' && org.space.name === t.S.truth.realm_name, 'the organization is a community space with its name', org);
  for (const f of t.S.truth.channel_folders ?? []) {
    const s = start.find((e) => e.t === 'space' && e.space.nativeId === `${HOST}/f/${f.id}`);
    if (f.is_archived) t.ok(!s, `archived folder ${f.name} is not said`, s);
    else t.ok(s?.space.kind === 'section' && s.space.name === f.name && s.space.parents?.[0]?.nativeId === HOST, `folder ${f.name} is a section in the organization`, s);
  }
  t.ok((t.S.truth.channel_folders ?? []).length > 0, 'the sandbox has a channel folder');
});

check('start.channels', async (t) => {
  const start = (t.S.link.events as Ev[]).slice(0, t.S.startEnd);
  const folders = new Map<number, any>((t.S.truth.channel_folders ?? []).map((f: any) => [f.id, f]));
  for (const s of t.S.truth.subscriptions as any[]) {
    const facts = start.filter(isConv(chan(s.stream_id)));
    const c = facts[facts.length - 1]?.conversation;
    if (!t.ok(c, `#${s.name} is said`)) continue;
    const f = s.folder_id ? folders.get(s.folder_id) : null;
    t.eq(
      { shape: c.shape, variant: c.variant, name: c.name, topic: c.topic ?? '', archived: !!c.archived, muted: !!c.mute?.muted, space: c.spaces?.[0]?.nativeId },
      { shape: 'channel', variant: 'forum', name: s.name, topic: s.description ?? '', archived: !!s.is_archived, muted: !!s.is_muted, space: f && !f.is_archived ? `${HOST}/f/${f.id}` : HOST },
      `#${s.name} as a forum channel`,
    );
  }
  t.ok((t.S.truth.subscriptions as any[]).some((s) => s.is_archived), 'the server lists the archived channel among the subscriptions (so the check above covers it)');
  const stray = start.filter((e) => e.t === 'conversation' && e.conversation.shape === 'channel' && !(t.S.truth.subscriptions as any[]).some((s) => chan(s.stream_id) === e.conversation.nativeId));
  t.eq(stray.map((e) => e.conversation.name), [], 'no channel is said that the account is not in');
});

check('start.topics', async (t) => {
  const start = (t.S.link.events as Ev[]).slice(0, t.S.startEnd);
  const last = (id: string) => start.filter(isConv(id)).pop()?.conversation;
  const policy = new Map<string, number>((t.S.truth.user_topics as any[]).map((u) => [topicId(u.stream_id, u.topic_name), u.visibility_policy]));
  let seen = 0;
  const noTime: string[] = [];
  for (const s of t.S.truth.subscriptions as any[]) {
    if (s.is_archived) continue;
    const topics = (await rest(quinn, 'GET', `/users/me/${s.stream_id}/topics`, { allow_empty_topic_name: true })).topics as { name: string; max_id: number }[];
    for (const tp of topics.slice(0, 30)) {
      if (!last(topicId(s.stream_id, tp.name))?.lastMessageAt) noTime.push(`#${s.name} > ${tp.name}`);
      const id = topicId(s.stream_id, tp.name);
      const c = last(id);
      if (!t.ok(c, `topic #${s.name} > ${tp.name || '(empty)'} is said`)) continue;
      seen++;
      const pol = policy.get(id) ?? 0;
      t.eq(
        { shape: c.shape, parent: c.parentConversation, name: c.name, archived: !!c.archived, muted: !!c.mute?.muted, joined: !!c.thread?.joined },
        { shape: 'thread', parent: chan(s.stream_id), name: tp.name === '' ? 'general chat' : tp.name, archived: tp.name.startsWith('✔ '), muted: pol === 1 || (s.is_muted && pol === 0), joined: pol === 3 },
        `topic #${s.name} > ${tp.name || '(empty)'}`,
      );
      const parentAt = start.findIndex(isConv(chan(s.stream_id)));
      const selfAt = start.findIndex(isConv(id));
      t.ok(parentAt >= 0 && parentAt < selfAt, `#${s.name} is said before its topic ${tp.name}`);
    }
  }
  t.ok(seen > 10, 'topics were checked', seen);
  t.eq(noTime, [], 'every topic said at start has its last message\'s time (the hub sorts and dates by it)');
});

check('start.directs', async (t) => {
  const start = (t.S.link.events as Ev[]).slice(0, t.S.startEnd);
  for (const r of t.S.truth.recent_private_conversations as { user_ids: number[]; max_message_id: number }[]) {
    const all = [...r.user_ids, quinn.userId];
    const id = dmId(...all);
    const c = start.filter(isConv(id)).pop()?.conversation;
    if (!t.ok(c, `direct conversation ${id} is said`)) continue;
    const want = r.user_ids.length === 0 ? 'self' : r.user_ids.length === 1 ? 'direct' : 'group';
    t.eq({ shape: c.shape, participants: [...(c.participants ?? [])].sort() }, { shape: want, participants: [...new Set(all)].map((u) => uid(u)).sort() }, `direct conversation ${id}`);
    for (const p of c.participants ?? []) t.ok(start.some((e) => e.t === 'identity' && e.identity.nativeId === p), `identity ${p} is said for ${id}`);
    t.ok(c.name === undefined, 'a direct conversation has no name of its own', c.name);
  }
  for (const want of [dmId(quinn, ann), dmId(quinn, ann, bob), dmId(quinn), dmId(quinn, bot)]) t.ok(start.some(isConv(want)), `seeded ${want} is among them`);
});

check('start.identities', async (t) => {
  const start = (t.S.link.events as Ev[]).slice(0, t.S.startEnd);
  const idn = (w: Who) => start.filter((e) => e.t === 'identity' && e.identity.nativeId === uid(w)).pop()?.identity;
  const users = new Map<number, any>((t.S.truth.realm_users as any[]).map((u) => [u.user_id, u]));
  for (const [k, w] of Object.entries({ quinn, ann, bob, cara }) as [string, Who][]) {
    const i = idn(w);
    if (!t.ok(i, `${k} has an identity`)) continue;
    t.eq({ handle: i.handle, displayName: i.displayName, isSelf: !!i.isSelf, isBot: !!i.isBot }, { handle: w.email, displayName: users.get(w.userId).full_name, isSelf: k === 'quinn', isBot: false }, `${k}'s identity: the handle is the real sign-in email`);
    t.ok(typeof i.avatarUrl === 'string' && /^(zulip:\/|https:\/\/)/.test(i.avatarUrl), `${k} has a picture the hub can fetch`, i.avatarUrl);
  }
  const b = idn(bot);
  t.ok(b?.isBot === true, 'the bot is marked a bot', b);
  // Only people who appear: this account, authors, people in DMs, reactors and those mentioned. (Counting against the
  // directory's size misleads: bots made and deactivated by earlier runs still wrote messages.)
  const seen = new Set<string>([uid(quinn)]);
  for (const e of start as any[]) {
    if (e.t === 'message') {
      seen.add(e.message.author);
      for (const r of e.message.reactions ?? []) for (const a of r.authors ?? []) seen.add(a);
      for (const m of String(e.message.body ?? '').matchAll(/<@([^>&]+)>/g)) seen.add(m[1]);
    }
    if (e.t === 'conversation') for (const p of e.conversation.participants ?? []) seen.add(p);
  }
  const stray = [...new Set(start.filter((e) => e.t === 'identity').map((e: any) => e.identity.nativeId as string))].filter((id) => !seen.has(id));
  t.eq(stray, [], 'only people who appear are said, not the whole directory');
});

check('start.messages', async (t) => {
  const start = (t.S.link.events as Ev[]).slice(0, t.S.startEnd);
  const said = new Map<string, Ev>();
  for (const e of start) if (e.t === 'message') said.set(e.message.nativeId, e);
  const unreadIds = [...t.S.unreadAtStart.by.values()].flat();
  const missing = unreadIds.filter((id) => !said.has(mid(id)));
  t.eq(missing, [], `every one of the ${unreadIds.length} unread messages is said`);
  t.eq(t.S.newestAtStart.filter((id) => !said.has(mid(id))), [], 'the newest 100 messages are said');
  t.ok(start.filter((e) => e.t === 'message').every((e) => e.live === false), 'start messages are not live');
  for (const [conv, ids] of t.S.unreadAtStart.by) for (const id of ids) if (said.has(mid(id))) t.eq(said.get(mid(id))!.message.conversation, conv, `unread ${id} is in its conversation`);
  const order = start.filter((e) => e.t === 'message').map((e) => Number(e.message.nativeId.split('/').pop()));
  t.ok(order.every((v, i) => i === 0 || order[i - 1] < v), 'in order, oldest first, each once');
  // Each message's conversation and author were said before it.
  const known = new Set<string>();
  const early: string[] = [];
  for (const e of start) {
    if (e.t === 'conversation') known.add(e.conversation.nativeId);
    if (e.t === 'identity') known.add(e.identity.nativeId);
    if (e.t === 'message' && (!known.has(e.message.conversation) || !known.has(e.message.author))) early.push(e.message.nativeId);
  }
  t.eq(early, [], 'no message comes before its conversation and author');
});

check('start.read-counts', async (t) => {
  const start = (t.S.link.events as Ev[]).slice(0, t.S.startEnd);
  const lastRead = new Map<string, Ev>();
  for (const e of start) if (e.t === 'read') lastRead.set(e.conversation, e);
  const ts = new Map<string, number>();
  for (const e of start) if (e.t === 'message') ts.set(e.message.nativeId, e.message.ts);
  for (const [conv, ids] of t.S.unreadAtStart.by) {
    const r = lastRead.get(conv);
    if (!r) {
      t.ok(false, `a read event for ${conv} (${ids.length} unread)`);
      continue;
    }
    t.eq({ unread: r.unread, mentions: r.mentions }, { unread: ids.length, mentions: ids.filter((i) => t.S.unreadAtStart.mentions.has(i)).length }, `counts of ${conv}`);
    const oldest = Math.min(...ids.map((i) => ts.get(mid(i)) ?? Infinity));
    t.ok(r.upToTs < oldest && r.upToTs >= oldest - 1000, `${conv} is read up to just before its oldest unread message`, { upToTs: r.upToTs, oldest });
  }
  const wrong = [...lastRead.values()].filter((r) => !t.S.unreadAtStart.by.has(r.conversation) && r.unread !== 0);
  t.eq(wrong, [], 'conversations the server calls read are said with 0 unread');
  // A conversation that is all read is read up to its newest message.
  const read = lastRead.get(topicId(CH.general, 'history'));
  const newest = Math.max(...start.filter((e) => e.t === 'message' && e.message.conversation === topicId(CH.general, 'history')).map((e) => e.message.ts), 0);
  if (newest) t.eq(read?.upToTs, newest, 'a read topic is read up to its newest message');
});

check('start.saved', async (t) => {
  const start = (t.S.link.events as Ev[]).slice(0, t.S.startEnd);
  const saved = start.filter((e) => e.t === 'saved' && e.complete).pop();
  if (!saved) return void t.ok(false, 'a complete saved list at start');
  for (const id of t.S.truth.starred_messages as number[]) {
    const m = await raw(id);
    const conv = m.type === 'stream' ? topicId(m.stream_id, m.subject) : dmId(quinn, ...m.display_recipient.map((r: any) => r.id));
    const f = saved.saved.find((s: any) => s.message === mid(id) && s.dueAt === undefined);
    t.ok(f, `starred ${id} is in it`, saved.saved);
    if (f) t.eq(f.conversation, conv, `starred ${id} names its conversation (the hub cannot place a bare id it never loaded)`);
  }
  for (const r of t.S.truth.reminders as any[]) {
    const f = saved.saved.find((s: any) => s.message === mid(r.reminder_target_message_id) && s.dueAt === r.scheduled_delivery_timestamp * 1000);
    t.ok(f, `reminder ${r.reminder_id} is in it with its time`, saved.saved);
    if (f) t.ok(f.conversation, `reminder ${r.reminder_id} names its conversation (SavedFact: "a reminder always does")`, f);
  }
  const ign = start.find((e) => e.t === 'ignored');
  t.eq([...(ign?.identities ?? [])].sort(), (t.S.truth.muted_users as any[]).map((m) => uid(m.id)).sort(), 'the ignored list is the muted users');
});

check('start.reconnect', async (t) => {
  // The hub connecting again is told everything again.
  const from = t.mark();
  t.S.a.onConnect();
  const after = t.heard(() => true, from);
  t.ok(after.some((e) => e.t === 'hello'), 'hello again');
  t.ok(after.some(isOnline), 'status again');
  for (const s of t.S.truth.subscriptions as any[]) t.ok(after.some(isConv(chan(s.stream_id))), `#${s.name} again`);
  t.ok(after.some(isConv(dmId(quinn, ann))), 'the direct conversation with Ann again');
  t.ok(after.some((e) => e.t === 'identity' && e.identity.nativeId === uid(ann)), 'identities again (the hub may have been wiped)');
  t.ok(after.some((e) => e.t === 'saved' && e.complete), 'saved again');
  t.ok(after.some((e) => e.t === 'ignored'), 'ignored again');
});

check(
  'start.guest',
  async (t) => {
    const { a, link } = await open(dave, { apiKey: dave.apiKey });
    opened.push(a);
    const on = await link.next(isOnline, 60_000).catch(() => null);
    t.ok(on, 'a guest comes online', link.events.filter((e) => e.t === 'status').pop());
    const warn = link.logs.filter((l) => l.level === 'warn' || l.level === 'error');
    t.eq(warn, [], 'without warnings');
    const subs = (await rest(dave, 'GET', '/users/me/subscriptions')).subscriptions as any[];
    for (const s of subs) t.ok(link.events.some(isConv(chan(s.stream_id)) as any), `the guest's #${s.name} is said`);
    const self = (link.events as Ev[]).find((e) => e.t === 'identity' && e.identity.isSelf)?.identity;
    t.eq(self?.handle, dave.email, 'the guest\'s own handle is its sign-in email');
    const annSeen = (link.events as Ev[]).filter((e) => e.t === 'identity' && e.identity.nativeId === uid(ann)).pop()?.identity;
    t.ok(annSeen && (annSeen.handle === undefined || annSeen.handle === ann.email), 'someone whose address the guest may not see has no handle, rather than Zulip\'s stand-in address (user9@…)', annSeen);
    const about = (await a.command({ t: 'about', id: 'g1', target: { kind: 'conversation', nativeId: topicId(CH.general, 'formatting') } } as any).catch((e) => ({ error: String(e) }))) as any;
    t.eq([about?.fields?.name?.canEdit, about?.thread?.canArchive], [false, false], 'a guest is told it cannot rename or resolve a topic (about.ts says so for role 600)');
    const ch = (await a.command({ t: 'about', id: 'g2', target: { kind: 'conversation', nativeId: chan(CH.general) } } as any).catch((e) => ({ error: String(e) }))) as any;
    t.eq(ch?.adding?.can, false, 'nor add people to a channel');
    await a.shutdown();
  },
  { noSession: true },
);

// ================================================================ reading Zulip's Markdown (the seeded messages)

async function seeded(t: T, key: string): Promise<any> {
  const id = M[key];
  const got = t.heard(isMsg(id)).pop();
  if (got) return got.message;
  const m = await raw(id);
  const conv = m.type === 'stream' ? topicId(m.stream_id, m.subject) : dmId(quinn, ...m.display_recipient.map((r: any) => r.id));
  const from = t.mark();
  // Read the page that ends with it.
  await t.cmd({ t: 'history', conversation: conv, limit: 5, cursor: String(id + 1) }, `history to load seeded ${key}`);
  const e = await t.event(`seeded message ${key} (${id})`, isMsg(id), from);
  return e?.message ?? { body: '<never said>', reactions: [] };
}

const TIME_UNIX = Date.parse('2026-12-01T15:00:00Z') / 1000;
const SEEDED_BODIES: [string, (m: any) => unknown, unknown][] = [
  ['emphasis', (m) => m.body, 'Some **bold**, some *italic* and some ~~struck out~~ text.'],
  ['code', (m) => m.body, 'Inline `npm test`, and a block:\n```ts\nconst greeting = (name: string) => `hi ${name}`;\n```'],
  ['quote', (m) => m.body, '> Simplicity is prerequisite for reliability.\n\nA quote, and my reply under it.'],
  ['spoiler', (m) => m.body, '**The ending** ||The lighthouse keeper did it.||'],
  ['math', (m) => m.body, 'Pythagoras: $$a^2 + b^2 = c^2$$'],
  ['link', (m) => m.body, 'The style guide is [on the docs site](https://example.com/docs/style).'],
  ['emoji', (m) => m.body, 'Good morning 😄 ☕'],
  ['time', (m) => m.body, `The review is at <t:${TIME_UNIX}:F>.`],
  ['mention', (m) => [m.body, !!m.mentionsSelf, !!m.mentionsAll], [`<@${uid(quinn)}> could you look at the budget sheet today?`, true, false]],
  ['silentMention', (m) => [m.body, !!m.mentionsSelf], [`Thanks to <@${uid(ann)}> for the notes.`, false]],
  ['wildcardAll', (m) => [m.body, !!m.mentionsSelf, !!m.mentionsAll], ['@everyone the office is closed on Friday.', true, true]],
  ['wildcardTopic', (m) => m.body, '@here I moved the sync to Thursday.'],
  ['groupMention', (m) => [m.body, !!m.mentionsSelf], [`<@&${HOST}/g/${creds.groups.designers}> can someone review the new icons?`, false]],
  ['channelLink', (m) => m.body, `The palette is in <#${topicId(CH.design, 'colors')}>.`],
  ['quoteReply', (m) => [m.body, m.replyTo], ['Thanks, I read them.', mid(M.quoted)]],
  ['alertWord', (m) => m.body, 'I will deploy the new build tonight.'],
  ['emptyTopic', (m) => m.conversation, topicId(CH.general, '')],
  ['selfDm', (m) => m.conversation, dmId(quinn)],
  ['groupDm', (m) => m.conversation, dmId(quinn, ann, bob)],
  ['botDm', (m) => [m.conversation, m.author], [dmId(quinn, bot), uid(bot)]],
];
for (const [key, pick, want] of SEEDED_BODIES) check(`md.in.${key}`, async (t) => void t.eq(pick(await seeded(t, key)), want, `seeded ${key}, read`));

check('md.in.image', async (t) => {
  const m = await seeded(t, 'image');
  const src = (await raw(M.image)).content as string;
  const path = src.match(/\]\((\/user_uploads\/[^)]+)\)/)?.[1];
  t.eq(m.attachments, [{ nativeId: path, kind: 'image', mime: 'image/png', name: 'pic.png', url: `zulip:${path}` }], 'the picture is an attachment');
  t.eq(m.body, 'Here is the sketch:', 'and its link leaves the words');
  t.eq(m.kind, 'text', 'kind');
});
check('md.in.file', async (t) => {
  const m = await seeded(t, 'file');
  t.eq((m.attachments ?? []).map((a: any) => [a.kind, a.mime, a.name, a.url.startsWith('zulip:/user_uploads/')]), [['file', 'text/plain', 'notes.txt', true]], 'the file is an attachment');
});
check('md.in.poll', async (t) => {
  const m = await seeded(t, 'poll');
  t.eq(m.extra?.poll && { q: m.extra.poll.question, o: m.extra.poll.options, c: m.extra.poll.counts, v: m.extra.poll.voters, mine: m.extra.poll.mine }, { q: 'Lunch?', o: [{ id: 'canned,0', text: 'Tacos' }, { id: 'canned,1', text: 'Pizza' }], c: { 'canned,0': 1, 'canned,1': 1 }, v: 2, mine: [] }, 'the poll with its votes');
});
check('md.in.todo', async (t) => {
  const m = await seeded(t, 'todo');
  t.eq(m.body, '**Launch**\n☑ ~~Write docs~~\n☐ Ship', 'the to-do list as words, the struck task done');
});
check('md.in.edited', async (t) => {
  const m = await seeded(t, 'edited');
  const src = await raw(M.edited);
  t.eq([m.body, m.conversation], ['Logo v2 is up, with a lighter mark.', topicId(CH.design, 'logo')], 'the edited words, in the topic it moved to');
  t.eq(m.editedTs, src.last_edit_timestamp * 1000, 'editedTs is when its words changed (not when it moved)');
});
check('md.in.reactions', async (t) => {
  const m = await seeded(t, 'reacted');
  const by = Object.fromEntries((m.reactions ?? []).map((r: any) => [r.key, r]));
  const parrot = Object.entries<any>((await rest(quinn, 'GET', '/realm/emoji')).emoji).find(([, e]) => e.name === 'partyparrot' && !e.deactivated)!;
  t.eq([...(by['👍']?.authors ?? [])].sort(), [uid(quinn), uid(bob)].sort(), 'thumbs up by Bob and Quinn');
  t.ok(by['❤️'] || by['❤'], 'a heart', Object.keys(by));
  t.eq(by['zulip:zulip'] && [by['zulip:zulip'].authors, by['zulip:zulip'].emoji?.name], [[uid(bob)], 'zulip'], ':zulip: by Bob, as a custom emoji');
  const p = by[`realm:${parrot[0]}`];
  t.eq(p && [p.authors, p.emoji?.name, p.emoji?.url], [[uid(ann)], 'partyparrot', `zulip:${parrot[1].source_url}`], 'the organization\'s own emoji by Ann, with its picture');
});

// ================================================================ live events from other people

const fixtures = new Map<string, Promise<any>>();
function once<V>(key: string, make: () => Promise<V>): Promise<V> {
  if (!fixtures.has(key)) fixtures.set(key, make());
  return fixtures.get(key) as Promise<V>;
}
const G = () => CH.general;
const NO_NOTICE = { send_notification_to_old_thread: false, send_notification_to_new_thread: false };

check('live.channel-message', async (t) => {
  const topic = tn('live message');
  const conv = topicId(G(), topic);
  const from = t.mark();
  const id = await say(ann, { stream: G(), topic }, 'A new message, live.');
  const e = await t.event('the message', isMsg(id), from);
  if (!e) return;
  const src = await raw(id);
  t.eq({ live: e.live, conversation: e.message.conversation, author: e.message.author, body: e.message.body, ts: e.message.ts, kind: e.message.kind }, { live: true, conversation: conv, author: uid(ann), body: 'A new message, live.', ts: src.timestamp * 1000, kind: 'text' }, 'the message fact');
  t.ok(!e.message.mentionsSelf && !e.message.editedTs && !e.message.moved, 'no mention, edit or move on it', e.message);
  const all = t.S.link.events as Ev[];
  const at = all.indexOf(e);
  const fact = all.slice(from, at).filter(isConv(conv)).pop()?.conversation;
  t.eq(fact && { shape: fact.shape, parent: fact.parentConversation, name: fact.name, last: fact.lastMessageAt }, { shape: 'thread', parent: chan(G()), name: topic, last: src.timestamp * 1000 }, 'the new topic is said before its first message, with the name as written');
  await t.event('read: 1 unread, 0 mentions', (x) => isRead(conv, 1)(x) && x.mentions === 0, at);
});

check('live.dm', async (t) => {
  const conv = dmId(quinn, ann);
  const from = t.mark();
  const id = await say(ann, { dm: [quinn] }, 'A direct message, live.');
  const e = await t.event('the message', isMsg(id), from);
  if (!e) return;
  t.eq({ live: e.live, conversation: e.message.conversation, author: e.message.author, body: e.message.body }, { live: true, conversation: conv, author: uid(ann), body: 'A direct message, live.' }, 'the message fact');
  const want = (await serverUnread()).by.get(conv)?.length ?? 0;
  await t.event(`read with the server's count (${want})`, isRead(conv, want), t.S.link.events.indexOf(e));
});

check('live.group-dm', async (t) => {
  const conv = dmId(quinn, bob, cara, dave);
  const from = t.mark();
  const id = await say(bob, { dm: [quinn, cara, dave] }, 'A group message, live.');
  const e = await t.event('the message', isMsg(id), from);
  if (!e) return;
  t.eq(e.message.conversation, conv, 'in the group conversation');
  const fact = t.heard(isConv(conv), from)[0];
  t.ok(fact && t.S.link.events.indexOf(fact) < t.S.link.events.indexOf(e), 'the conversation is said before the message');
  t.eq(fact && { shape: fact.conversation.shape, participants: [...fact.conversation.participants].sort() }, { shape: 'group', participants: [quinn, bob, cara, dave].map((w) => uid(w)).sort() }, 'a group with everyone in it');
  for (const w of [bob, cara, dave]) t.ok(t.heard((x) => x.t === 'identity' && x.identity.nativeId === uid(w)).length, `identity of ${w.email} said`);
});

check('live.own-message-elsewhere', async (t) => {
  const topic = tn('own elsewhere');
  const conv = topicId(G(), topic);
  const from = t.mark();
  // As the apps send: read by its sender (a bare API send leaves the sender's own message unread).
  const id = (await rest(quinn, 'POST', '/messages', { type: 'stream', to: G(), topic, content: 'Written on my phone.', read_by_sender: true })).id as number;
  const e = await t.event('the message', isMsg(id), from);
  if (!e) return;
  t.eq([e.message.author, e.message.conversation], [uid(quinn), conv], 'by the account itself');
  const r = await t.event('a read event for its conversation', isRead(conv), t.S.link.events.indexOf(e));
  t.eq(r && [r.unread, r.upToTs], [0, e.message.ts], 'own message leaves nothing unread and the read point at it');
});

check('live.mention', async (t) => {
  const topic = tn('live mention');
  const conv = topicId(G(), topic);
  const from = t.mark();
  const bobName = (await rest(quinn, 'GET', `/users/${bob.userId}`)).user.full_name;
  const id = await say(ann, { stream: G(), topic }, `@**Quinn Park** a question for you, and @**${bobName}|${bob.userId}** too.`);
  const e = await t.event('the message', isMsg(id), from);
  if (!e) return;
  t.eq([!!e.message.mentionsSelf, !!e.message.mentionsAll], [true, false], 'mentionsSelf, not mentionsAll');
  t.ok(e.message.body.startsWith(`<@${uid(quinn)}> a question for you, and `) && e.message.body.includes(`<@${uid(bob)}>`), 'mentions are <@id>', e.message.body);
  await t.event('read: 1 unread, 1 mention', (x) => isRead(conv, 1)(x) && x.mentions === 1, from);
});

check('live.mention-wildcards', async (t) => {
  const topic = tn('live wildcards');
  const conv = topicId(G(), topic);
  await say(quinn, { stream: G(), topic }, 'I am taking part in this topic.');
  const cases: [Who, string, string, boolean][] = [
    [ann, '@**all** hello', '@everyone hello', true],
    [ann, '@**everyone** hello', '@everyone hello', true],
    [ann, '@**channel** hello', '@everyone hello', true],
    [bob, '@**topic** hello', '@here hello', true],
    [ann, '@**Quinn Park** and @**all**', `<@${uid(quinn)}> and @everyone`, false],
  ];
  let n = 0;
  for (const [who, text, body, all] of cases) {
    const from = t.mark();
    const id = await say(who, { stream: G(), topic }, text);
    const e = await t.event(`the message "${text}"`, isMsg(id), from);
    if (!e) continue;
    n++;
    t.eq([e.message.body, !!e.message.mentionsSelf, !!e.message.mentionsAll], [body, true, all], `"${text}"`);
  }
  await t.settled();
  const truth = await serverUnread();
  const ids = truth.by.get(conv) ?? [];
  const want = { unread: ids.length, mentions: ids.filter((i) => truth.mentions.has(i)).length };
  const last = t.heard(isRead(conv)).pop();
  t.eq(last && { unread: last.unread, mentions: last.mentions }, want, 'the last read event has the server\'s counts');
});

check('live.alert-word', async (t) => {
  const topic = tn('live alert');
  const from = t.mark();
  const id = await say(bob, { stream: G(), topic }, 'We should deploy before lunch.');
  const e = await t.event('the message', isMsg(id), from);
  if (!e) return;
  const src = await raw(id);
  t.ok(src.flags.includes('has_alert_word'), 'the server flagged the alert word', src.flags);
  t.eq(!!e.message.mentionsSelf, true, 'an alert word counts as a mention of the account');
});

check('live.edit', async (t) => {
  const topic = tn('live edit');
  const id = await say(ann, { stream: G(), topic }, 'First wording.');
  await t.event('the message', isMsg(id), 0);
  const from = t.mark();
  await rest(ann, 'PATCH', `/messages/${id}`, { content: 'Second wording, **edited**.' });
  const e = await t.event('the edited message', (x) => isMsg(id)(x) && x.message.body !== 'First wording.', from);
  if (!e) return;
  const src = await raw(id);
  t.eq({ body: e.message.body, editedTs: e.message.editedTs, live: e.live, conversation: e.message.conversation, ts: e.message.ts, moved: !!e.message.moved }, { body: 'Second wording, **edited**.', editedTs: src.last_edit_timestamp * 1000, live: false, conversation: topicId(G(), topic), ts: src.timestamp * 1000, moved: false }, 'the edit');
});

check('live.edit-adds-mention', async (t) => {
  const topic = tn('live edit mention');
  const conv = topicId(G(), topic);
  const id = await say(ann, { stream: G(), topic }, 'Nobody named yet.');
  await t.event('read: 1 unread, 0 mentions', (x) => isRead(conv, 1)(x) && x.mentions === 0, 0);
  let from = t.mark();
  await rest(ann, 'PATCH', `/messages/${id}`, { content: 'Now for @**Quinn Park**.' });
  const e = await t.event('the edited message', (x) => isMsg(id)(x) && x.message.body.includes('Now'), from);
  t.eq(!!e?.message.mentionsSelf, true, 'the edit made it a mention');
  t.ok((await serverUnread()).mentions.has(id), 'the server counts it an unread mention');
  await t.event('read: 1 unread, 1 mention after the edit', (x) => isRead(conv, 1)(x) && x.mentions === 1, from, 4000);
  from = t.mark();
  await rest(ann, 'PATCH', `/messages/${id}`, { content: 'Nobody again.' });
  const e2 = await t.event('the message edited back', (x) => isMsg(id)(x) && x.message.body === 'Nobody again.', from);
  t.eq(!!e2?.message.mentionsSelf, false, 'the second edit took the mention away');
  await t.event('read: 1 unread, 0 mentions after the mention is edited away', (x) => isRead(conv, 1)(x) && x.mentions === 0, from, 4000);
});

check('live.topic-rename', async (t) => {
  const a = tn('rename from');
  const b = tn('rename to');
  const ids = [await say(ann, { stream: G(), topic: a }, 'One.'), await say(bob, { stream: G(), topic: a }, 'Two.')];
  await t.event('both messages', isMsg(ids[1]), 0);
  const from = t.mark();
  await rest(ann, 'PATCH', `/messages/${ids[0]}`, { topic: b, propagate_mode: 'change_all', ...NO_NOTICE });
  for (const id of ids) {
    const e = await t.event(`message ${id} again, moved`, (x) => isMsg(id)(x) && x.message.conversation === topicId(G(), b), from);
    if (e) t.eq([e.message.moved, e.live, e.message.editedTs], [true, false, undefined], 'moved: true, not live, and a move is not an edit of its words');
  }
  const fact = t.heard(isConv(topicId(G(), b)), from)[0];
  const first = t.heard((x) => x.t === 'message' && x.message.conversation === topicId(G(), b), from)[0];
  t.ok(fact && first && t.S.link.events.indexOf(fact) < t.S.link.events.indexOf(first), 'the new topic is said before its messages');
  t.eq(fact?.conversation.name, b, 'with its name');
  await t.event('read: the new topic has both unread', isRead(topicId(G(), b), 2), from);
  await t.event('read: the old topic has none', isRead(topicId(G(), a), 0), from);
  const topics = (await rest(quinn, 'GET', `/users/me/${G()}/topics`)).topics.map((x: any) => x.name);
  t.ok(!topics.includes(a), 'the server no longer lists the old topic');
  await t.event('the old topic, now gone on the server, is taken away (a leave for it), not left as an empty conversation', (x) => x.t === 'leave' && x.kind === 'conversation' && x.nativeId === topicId(G(), a), from, 3000);
});

check('live.topic-rename-case', async (t) => {
  // Zulip compares topics without case, so the id stays and only the name changes.
  const a = tn('case topic');
  const b = a.replace('case topic', 'Case Topic');
  const id = await say(ann, { stream: G(), topic: a }, 'One.');
  await t.event('the message', isMsg(id), 0);
  const from = t.mark();
  await rest(ann, 'PATCH', `/messages/${id}`, { topic: b, propagate_mode: 'change_all', ...NO_NOTICE });
  const f = await t.event('the topic with its new spelling', (x) => isConv(topicId(G(), a))(x) && x.conversation.name === b, from);
  if (!f) return;
  await t.settled();
  const ab = await t.cmd({ t: 'about', target: { kind: 'conversation', nativeId: topicId(G(), a) } });
  t.eq(ab?.fields?.name?.value, b, 'About names it as now written');
  const sent = await t.cmd({ t: 'send', conversation: topicId(G(), a), body: 'Into the renamed topic.' });
  const sid = Number(String(sent?.nativeId).split('/').pop());
  if (sid) t.eq((await raw(sid)).subject, b, 'a send lands in the topic as now written');
});

check('live.move-channel', async (t) => {
  const a = tn('move across');
  const ids = [await say(ann, { stream: G(), topic: a }, 'One.'), await say(bob, { stream: G(), topic: a }, 'Two.')];
  await t.event('both messages', isMsg(ids[1]), 0);
  const from = t.mark();
  await rest(ann, 'PATCH', `/messages/${ids[0]}`, { stream_id: CH.design, propagate_mode: 'change_all', ...NO_NOTICE });
  const to = topicId(CH.design, a);
  for (const id of ids) {
    const e = await t.event(`message ${id} again, in #design`, (x) => isMsg(id)(x) && x.message.conversation === to, from);
    if (e) t.eq(e.message.moved, true, 'moved: true');
  }
  const fact = t.heard(isConv(to), from)[0];
  t.eq(fact && [fact.conversation.parentConversation, fact.conversation.spaces?.[0]?.nativeId], [chan(CH.design), `${HOST}/f/1`], 'the topic now hangs off #design, in its folder');
  await t.event('read: both unread in the new place', isRead(to, 2), from);
  await t.event('read: none in the old', isRead(topicId(G(), a), 0), from);
  // One message of several moved out (propagate_mode change_one): the old topic stays.
  const b = tn('move one');
  const more = [await say(ann, { stream: G(), topic: b }, 'Stays.'), await say(ann, { stream: G(), topic: b }, 'Goes.')];
  await t.event('both messages', isMsg(more[1]), 0);
  const from2 = t.mark();
  await rest(ann, 'PATCH', `/messages/${more[1]}`, { topic: `${b} split`, propagate_mode: 'change_one', ...NO_NOTICE });
  const e = await t.event('the one message, moved', (x) => isMsg(more[1])(x) && x.message.conversation === topicId(G(), `${b} split`), from2);
  t.eq(e?.message.moved, true, 'moved: true');
  await t.event('read: one left in the old topic', isRead(topicId(G(), b), 1), from2);
  t.eq(t.heard((x) => isMsg(more[0])(x), from2).length, 0, 'the message that stayed is not said again');
  t.eq(t.heard((x) => x.t === 'leave' && x.nativeId === topicId(G(), b), from2).length, 0, 'and its topic is not taken away');
});

check('live.resolve', async (t) => {
  const a = tn('to resolve');
  const id = await say(ann, { stream: G(), topic: a }, 'Is this done?');
  await t.event('the message', isMsg(id), 0);
  let from = t.mark();
  // As the web client resolves: a rename to "✔ <topic>", with Notification Bot saying so in the topic.
  await rest(ann, 'PATCH', `/messages/${id}`, { topic: `✔ ${a}`, propagate_mode: 'change_all', send_notification_to_old_thread: false, send_notification_to_new_thread: true });
  const done = topicId(G(), `✔ ${a}`);
  const f = await t.event('the resolved topic', isConv(done), from);
  t.eq(f && [f.conversation.archived, f.conversation.name], [true, `✔ ${a}`], 'archived, with its ✔ name');
  const e = await t.event('the message in it, moved', (x) => isMsg(id)(x) && x.message.conversation === done, from);
  t.eq(e?.message.moved, true, 'moved: true');
  const note = await t.event('Notification Bot\'s line', (x) => x.t === 'message' && x.message.conversation === done && x.message.nativeId !== mid(id), from);
  t.eq(note?.message.kind, 'system', 'Notification Bot\'s "marked this topic as resolved" is a system line');
  from = t.mark();
  await rest(ann, 'PATCH', `/messages/${id}`, { topic: a, propagate_mode: 'change_all', send_notification_to_old_thread: false, send_notification_to_new_thread: true });
  await t.event('the message back in the unresolved topic', (x) => isMsg(id)(x) && x.message.conversation === topicId(G(), a) && x.message.moved === true, from);
  t.eq(t.heard(isConv(topicId(G(), a))).pop()?.conversation.archived, false, 'the topic as last said is not archived');
});

check('live.delete', async (t) => {
  const topic = tn('live delete');
  const conv = topicId(G(), topic);
  const ids = [await say(ann, { stream: G(), topic }, 'Stays.'), await say(ann, { stream: G(), topic }, '@**Quinn Park** goes.')];
  await t.event('read: 2 unread, 1 mention', (x) => isRead(conv, 2)(x) && x.mentions === 1, 0);
  const from = t.mark();
  await rest(ann, 'DELETE', `/messages/${ids[1]}`);
  const e = await t.event('the delete', (x) => x.t === 'delete' && x.nativeId === mid(ids[1]), from);
  t.eq(e?.conversation, conv, 'in its conversation');
  await t.event('read: 1 unread, 0 mentions', (x) => isRead(conv, 1)(x) && x.mentions === 0, from);
  // A direct message deleted.
  const d = await say(ann, { dm: [quinn] }, 'A direct message to delete.');
  await t.event('the direct message', isMsg(d), 0);
  const from2 = t.mark();
  await rest(ann, 'DELETE', `/messages/${d}`);
  const e2 = await t.event('the direct message\'s delete', (x) => x.t === 'delete' && x.nativeId === mid(d), from2);
  t.eq(e2?.conversation, dmId(quinn, ann), 'in the direct conversation');
});

check('live.reactions', async (t) => {
  const topic = tn('live reactions');
  const conv = topicId(G(), topic);
  const id = await say(ann, { stream: G(), topic }, 'React to me.');
  await t.event('the message', isMsg(id), 0);
  const parrot = Object.entries<any>((await rest(quinn, 'GET', '/realm/emoji')).emoji).find(([, e]) => e.name === 'partyparrot' && !e.deactivated)!;
  const cases: [string, Params, string, unknown][] = [
    ['unicode', { emoji_name: 'thumbs_up' }, '👍', undefined],
    ['unicode with a variation selector', { emoji_name: 'heart' }, '❤️', undefined],
    ['custom', { emoji_name: 'partyparrot', emoji_code: parrot[0], reaction_type: 'realm_emoji' }, `realm:${parrot[0]}`, { key: `realm:${parrot[0]}`, name: 'partyparrot', url: `zulip:${parrot[1].source_url}` }],
    [':zulip:', { emoji_name: 'zulip', emoji_code: 'zulip', reaction_type: 'zulip_extra_emoji' }, 'zulip:zulip', 'some'],
  ];
  for (const [what, p, key, emoji] of cases) {
    let from = t.mark();
    const r = await restRaw(bob, 'POST', `/messages/${id}/reactions`, p);
    if (r.status !== 200) {
      t.ok(false, `the server took the ${what} reaction`, r.json);
      continue;
    }
    const e = await t.event(`${what} reaction added`, (x) => x.t === 'reaction' && x.message === mid(id) && !x.remove, from);
    if (e) {
      t.eq({ conversation: e.conversation, author: e.author, key: canonicalReactionKey(e.key) }, { conversation: conv, author: uid(bob), key }, `${what}: the reaction`);
      if (emoji === 'some') t.ok(e.emoji?.name === 'zulip' && e.emoji.key === key && e.emoji.url, ':zulip: has a custom emoji fact', e.emoji);
      else t.eq(e.emoji, emoji, `${what}: its custom emoji fact`);
    }
    from = t.mark();
    const d = await restRaw(bob, 'DELETE', `/messages/${id}/reactions`, p);
    if (!t.ok(d.status === 200, `the server took the ${what} reaction away`, d.json)) continue;
    const e2 = await t.event(`${what} reaction removed`, (x) => x.t === 'reaction' && x.message === mid(id) && x.remove === true, from);
    if (e2) t.eq({ author: e2.author, key: canonicalReactionKey(e2.key) }, { author: uid(bob), key }, `${what}: the removal`);
  }
});

check('live.reaction-on-old-message', async (t) => {
  // A message the extractor has not loaded: the first of the 120 in the history topic.
  const from = t.mark();
  await restRaw(cara, 'DELETE', `/messages/${M.historyFirst}/reactions`, { emoji_name: 'eyes' });
  await rest(cara, 'POST', `/messages/${M.historyFirst}/reactions`, { emoji_name: 'eyes' });
  const e = await t.event('the reaction', (x) => x.t === 'reaction' && x.message === mid(M.historyFirst) && !x.remove, from);
  t.eq(e && [e.conversation, e.key, e.author], [topicId(G(), 'history'), '👀', uid(cara)], 'placed in its topic');
  await rest(cara, 'DELETE', `/messages/${M.historyFirst}/reactions`, { emoji_name: 'eyes' });
});

check('live.typing', async (t) => {
  const topic = tn('live typing');
  await say(ann, { stream: G(), topic }, 'A topic to type in.');
  const cases: [string, Params, string][] = [
    ['a direct conversation', { type: 'direct', to: [quinn.userId] }, dmId(quinn, bob)],
    ['a group conversation', { type: 'direct', to: [quinn.userId, ann.userId] }, dmId(quinn, ann, bob)],
    ['a topic', { type: 'stream', stream_id: G(), topic }, topicId(G(), topic)],
  ];
  for (const [what, p, conv] of cases) {
    let from = t.mark();
    await rest(bob, 'POST', '/typing', { op: 'start', ...p });
    const e = await t.event(`typing in ${what}`, (x) => x.t === 'typing' && x.author === uid(bob) && x.conversation === conv && !x.stop, from);
    t.ok(!e || (typeof e.ttl === 'number' && e.ttl >= 10_000), 'with how long it lasts', e);
    from = t.mark();
    await rest(bob, 'POST', '/typing', { op: 'stop', ...p });
    await t.event(`typing stopped in ${what}`, (x) => x.t === 'typing' && x.author === uid(bob) && x.conversation === conv && x.stop === true, from);
  }
});

check('live.read-elsewhere', async (t) => {
  const topic = tn('read elsewhere');
  const conv = topicId(G(), topic);
  const ids = [await say(ann, { stream: G(), topic }, 'One.'), await say(ann, { stream: G(), topic }, 'Two.'), await say(ann, { stream: G(), topic }, 'Three.')];
  await t.event('read: 3 unread', isRead(conv, 3), 0);
  const ts = await Promise.all(ids.map(async (i) => (await raw(i)).timestamp * 1000));
  let from = t.mark();
  await rest(quinn, 'POST', '/messages/flags', { messages: [ids[0]], op: 'add', flag: 'read' });
  const r1 = await t.event('read: 2 unread after the first is read elsewhere', isRead(conv, 2), from);
  t.ok(r1 && r1.upToTs < ts[1] && !r1.manual, 'read up to before the second', { r1, ts });
  from = t.mark();
  await rest(quinn, 'POST', '/messages/flags', { messages: ids.slice(1), op: 'add', flag: 'read' });
  const r2 = await t.event('read: 0 unread after the rest', isRead(conv, 0), from);
  t.eq(r2?.upToTs, ts[2], 'read up to the newest');
  from = t.mark();
  await rest(quinn, 'POST', '/messages/flags', { messages: ids.slice(1), op: 'remove', flag: 'read' });
  const r3 = await t.event('read: 2 unread again, marked unread elsewhere', isRead(conv, 2), from);
  t.ok(r3?.manual === true && r3.upToTs < ts[1], 'manual: true, with the read point moved back before the second', { r3, ts });
  // Mark all as read elsewhere, by narrow, as the web client does.
  from = t.mark();
  await rest(quinn, 'POST', '/messages/flags/narrow', { anchor: 'oldest', num_before: 0, num_after: 1000, narrow: [{ operator: 'channel', operand: G() }, { operator: 'topic', operand: topic }], op: 'add', flag: 'read' });
  await t.event('read: 0 unread after "mark topic as read"', isRead(conv, 0), from);
});

check('live.starred-elsewhere', async (t) => {
  const topic = tn('star elsewhere');
  const id = await say(ann, { stream: G(), topic }, 'Star me.');
  await t.event('the message', isMsg(id), 0);
  let from = t.mark();
  const before = Date.now();
  await rest(quinn, 'POST', '/messages/flags', { messages: [id], op: 'add', flag: 'starred' });
  const s = await t.event('saved', (x) => x.t === 'saved' && !x.complete && x.saved.some((f: any) => f.message === mid(id)), from);
  const f = s?.saved.find((x: any) => x.message === mid(id));
  t.ok(f && f.conversation === topicId(G(), topic) && f.savedAt >= before - 2000 && f.dueAt === undefined, 'with its conversation and a time', f);
  from = t.mark();
  await rest(quinn, 'POST', '/messages/flags', { messages: [id], op: 'remove', flag: 'starred' });
  const u = await t.event('unsaved', (x) => x.t === 'unsaved' && x.message === mid(id), from);
  t.eq(u?.conversation, topicId(G(), topic), 'with its conversation');
});

check('live.poll-vote', async (t) => {
  const topic = tn('live poll');
  const conv = topicId(G(), topic);
  const id = await say(ann, { stream: G(), topic }, '/poll Which day?\nMonday\nTuesday');
  const m = await t.event('the poll', isMsg(id), 0);
  t.eq(m?.message.extra?.poll && [m.message.extra.poll.question, m.message.extra.poll.options, m.message.extra.poll.counts], ['Which day?', [{ id: 'canned,0', text: 'Monday' }, { id: 'canned,1', text: 'Tuesday' }], { 'canned,0': 0, 'canned,1': 0 }], 'the poll as sent');
  t.eq(m?.message.body, 'Which day?', 'its body is the question');
  const vote = (who: Who, content: object) => rest(who, 'POST', '/submessage', { message_id: id, msg_type: 'widget', content: JSON.stringify(content) });
  let from = t.mark();
  await vote(bob, { type: 'vote', key: 'canned,0', vote: 1 });
  const u = await t.event('pollUpdate for Bob\'s vote', (x) => x.t === 'pollUpdate' && x.message === mid(id), from);
  t.eq(u && { conversation: u.conversation, counts: u.counts, voters: u.voters, mine: u.mine }, { conversation: conv, counts: { 'canned,0': 1, 'canned,1': 0 }, voters: 1, mine: [] }, 'the counts');
  from = t.mark();
  await vote(cara, { type: 'vote', key: 'canned,0', vote: 1 });
  await vote(cara, { type: 'vote', key: 'canned,1', vote: 1 });
  const u2 = await t.event('pollUpdate for Cara\'s two votes', (x) => x.t === 'pollUpdate' && x.message === mid(id) && x.counts?.['canned,1'] === 1, from);
  t.eq(u2 && [u2.counts, u2.voters], [{ 'canned,0': 2, 'canned,1': 1 }, 2], 'two voters, three votes');
  from = t.mark();
  await vote(bob, { type: 'vote', key: 'canned,0', vote: -1 });
  const u3 = await t.event('pollUpdate for Bob taking his vote back', (x) => x.t === 'pollUpdate' && x.message === mid(id), from);
  t.eq(u3 && [u3.counts, u3.voters], [{ 'canned,0': 1, 'canned,1': 1 }, 1], 'one voter left');
  from = t.mark();
  await vote(bob, { type: 'new_option', idx: 1, option: 'Friday' });
  const again = await t.event('the poll again with Bob\'s new option', (x) => isMsg(id)(x) && x.message.extra?.poll?.options.length === 3, from);
  t.eq(again?.message.extra.poll.options[2], { id: `${bob.userId},1`, text: 'Friday' }, 'the option, keyed as the web client keys it');
  from = t.mark();
  await vote(ann, { type: 'question', question: 'Which day, then?' });
  const q = await t.event('the poll again with its new question', (x) => isMsg(id)(x) && x.message.extra?.poll?.question === 'Which day, then?', from);
  t.eq(q?.message.editedTs, undefined, 'a changed question is not an edit of the message');
});

check('live.todo-strike', async (t) => {
  const topic = tn('live todo');
  const id = await say(ann, { stream: G(), topic }, '/todo Chores\nSweep: the hall\nDust');
  const m = await t.event('the list', isMsg(id), 0);
  t.eq(m?.message.body, '**Chores**\n☐ Sweep: the hall\n☐ Dust', 'the list as words');
  let from = t.mark();
  await rest(bob, 'POST', '/submessage', { message_id: id, msg_type: 'widget', content: JSON.stringify({ type: 'strike', key: '1,canned' }) });
  const e = await t.event('the list again, a task struck', (x) => isMsg(id)(x) && x.message.body.includes('☑'), from);
  t.eq(e && [e.message.body, e.live], ['**Chores**\n☐ Sweep: the hall\n☑ ~~Dust~~', false], 'Dust is done');
  from = t.mark();
  await rest(bob, 'POST', '/submessage', { message_id: id, msg_type: 'widget', content: JSON.stringify({ type: 'new_task', key: 2, task: 'Mop', desc: '', completed: false }) });
  const e2 = await t.event('the list again with a new task', (x) => isMsg(id)(x) && x.message.body.includes('Mop'), from);
  t.eq(e2?.message.body, '**Chores**\n☐ Sweep: the hall\n☑ ~~Dust~~\n☐ Mop', 'Mop is added');
});

/** A channel Ann makes and adds Quinn to, heard live. */
const liveChannel = () =>
  once('liveChannel', async () => {
    const S = await session();
    const name = `drv-${RUN}-live`;
    await rest(ann, 'POST', '/users/me/subscriptions', { subscriptions: [{ name, description: 'A channel made by the driver.' }], send_new_subscription_messages: false });
    const id = (await rest(ann, 'GET', '/get_stream_id', { stream: name })).stream_id as number;
    const from = S.link.events.length;
    await rest(ann, 'POST', '/users/me/subscriptions', { subscriptions: [{ name }], principals: [quinn.userId], send_new_subscription_messages: false });
    const added = (await S.link.next(isConv(chan(id)) as any, 8000, from).catch(() => null)) as Ev | null;
    return { id, name, added, from };
  });

check('live.subscription-add', async (t) => {
  const c = await liveChannel();
  t.eq(c.added && { shape: c.added.conversation.shape, variant: c.added.conversation.variant, name: c.added.conversation.name, topic: c.added.conversation.topic, space: c.added.conversation.spaces?.[0]?.nativeId, muted: !!c.added.conversation.mute?.muted }, { shape: 'channel', variant: 'forum', name: c.name, topic: 'A channel made by the driver.', space: HOST, muted: false }, 'being added to a channel says it');
  const topic = 'first';
  const from = t.mark();
  const id = await say(ann, { stream: c.id, topic }, 'Welcome.');
  const e = await t.event('a message in it', isMsg(id), from);
  t.eq(e?.message.conversation, topicId(c.id, topic), 'in its topic');
});

check('live.subscription-mute', async (t) => {
  const c = await liveChannel();
  const id = await say(ann, { stream: c.id, topic: 'mute me' }, 'A topic in a channel about to be muted.');
  await t.event('the message', isMsg(id), 0);
  let from = t.mark();
  await rest(quinn, 'POST', '/users/me/subscriptions/properties', { subscription_data: [{ stream_id: c.id, property: 'is_muted', value: true }] });
  const f = await t.event('the channel, muted', (x) => isConv(chan(c.id))(x) && x.conversation.mute?.muted === true, from);
  t.ok(f, 'muted elsewhere');
  await t.event('its topic, muted with it', (x) => isConv(topicId(c.id, 'mute me'))(x) && x.conversation.mute?.muted === true, from);
  from = t.mark();
  await rest(quinn, 'POST', '/users/me/subscriptions/properties', { subscription_data: [{ stream_id: c.id, property: 'is_muted', value: false }] });
  const u = await t.event('the channel, unmuted', (x) => isConv(chan(c.id))(x) && !x.conversation.mute?.muted, from);
  t.eq(u?.conversation.mute, {}, 'an empty mute clears it');
});

check('live.channel-rename', async (t) => {
  const c = await liveChannel();
  let from = t.mark();
  const name = `${c.name}-renamed`;
  await rest(ann, 'PATCH', `/streams/${c.id}`, { new_name: name });
  const f = await t.event('the channel with its new name', (x) => isConv(chan(c.id))(x) && x.conversation.name === name, from);
  t.ok(f, 'renamed');
  from = t.mark();
  await rest(ann, 'PATCH', `/streams/${c.id}`, { description: 'A new *description*.' });
  await t.event('the channel with its new description', (x) => isConv(chan(c.id))(x) && x.conversation.topic === 'A new *description*.', from);
  from = t.mark();
  await rest(ann, 'PATCH', `/streams/${c.id}`, { new_name: c.name });
  await t.event('the channel with its first name again', (x) => isConv(chan(c.id))(x) && x.conversation.name === c.name, from);
});

check('live.channel-folder', async (t) => {
  const c = await liveChannel();
  let from = t.mark();
  const made = await rest(quinn, 'POST', '/channel_folders/create', { name: `drv ${RUN}`, description: 'A folder made by the driver.' });
  const fid = made.channel_folder_id as number;
  const sp = await t.event('the new folder as a section', (x) => x.t === 'space' && x.space.nativeId === `${HOST}/f/${fid}`, from);
  t.eq(sp && [sp.space.kind, sp.space.name, sp.space.topic, sp.space.parents?.[0]?.nativeId], ['section', `drv ${RUN}`, 'A folder made by the driver.', HOST], 'the section');
  from = t.mark();
  await rest(quinn, 'PATCH', `/streams/${c.id}`, { folder_id: fid });
  await t.event('the channel, now in the folder', (x) => isConv(chan(c.id))(x) && x.conversation.spaces?.[0]?.nativeId === `${HOST}/f/${fid}`, from);
  from = t.mark();
  await rest(quinn, 'PATCH', `/channel_folders/${fid}`, { name: `drv ${RUN} renamed` });
  await t.event('the folder with its new name', (x) => x.t === 'space' && x.space.nativeId === `${HOST}/f/${fid}` && x.space.name === `drv ${RUN} renamed`, from);
  from = t.mark();
  await rest(quinn, 'PATCH', `/streams/${c.id}`, { folder_id: null });
  await t.event('the channel, back in the organization', (x) => isConv(chan(c.id))(x) && x.conversation.spaces?.[0]?.nativeId === HOST, from);
  from = t.mark();
  await rest(quinn, 'PATCH', `/channel_folders/${fid}`, { is_archived: true });
  await t.event('the archived folder is taken away (a leave for the space)', (x) => x.t === 'leave' && x.kind === 'space' && x.nativeId === `${HOST}/f/${fid}`, from, 3000);
});

check('live.subscription-remove', async (t) => {
  const c = await liveChannel();
  const id = await say(ann, { stream: c.id, topic: 'last words' }, 'Before Quinn is removed.');
  await t.event('the message', isMsg(id), 0);
  let from = t.mark();
  await rest(ann, 'DELETE', '/users/me/subscriptions', { subscriptions: [c.name], principals: [quinn.userId] });
  await t.event('leave for the channel', (x) => x.t === 'leave' && x.kind === 'conversation' && x.nativeId === chan(c.id), from);
  await t.event('leave for its topic', (x) => x.t === 'leave' && x.kind === 'conversation' && x.nativeId === topicId(c.id, 'last words'), from);
  const r = await t.maybe((x) => isRead(topicId(c.id, 'last words'), 0)(x), from, 2000);
  t.ok(r || !(await serverUnread()).by.has(topicId(c.id, 'last words')) === false, 'its unread messages no longer count once it is left (a read with 0, or the leave alone if the hub drops them)', r);
  // Added back, then archived by an administrator.
  from = t.mark();
  await rest(ann, 'POST', '/users/me/subscriptions', { subscriptions: [{ name: c.name }], principals: [quinn.userId], send_new_subscription_messages: false });
  await t.event('the channel again', isConv(chan(c.id)), from);
  from = t.mark();
  await rest(ann, 'DELETE', `/streams/${c.id}`);
  await t.event('the channel, archived', (x) => isConv(chan(c.id))(x) && x.conversation.archived === true, from);
});

check('live.user-status', async (t) => {
  let from = t.mark();
  await rest(cara, 'POST', '/users/me/status', { status_text: 'In a meeting', emoji_name: 'calendar', emoji_code: '1f4c5', reaction_type: 'unicode_emoji' });
  const e = await t.event('customStatus for Cara', (x) => x.t === 'customStatus' && x.who === uid(cara), from);
  t.eq(e && [e.text, e.emoji], ['In a meeting', '📅'], 'text and emoji');
  from = t.mark();
  await rest(cara, 'POST', '/users/me/status', { status_text: 'Still in it' });
  const e2 = await t.event('customStatus with only the text changed', (x) => x.t === 'customStatus' && x.who === uid(cara), from);
  t.eq(e2 && [e2.text, e2.emoji], ['Still in it', '📅'], 'the emoji stays');
  from = t.mark();
  await rest(cara, 'POST', '/users/me/status', { status_text: '', emoji_name: '' });
  const e3 = await t.event('customStatus cleared', (x) => x.t === 'customStatus' && x.who === uid(cara), from);
  t.eq(e3 && [e3.text, e3.emoji], [undefined, undefined], 'no text and no emoji');
});

check('live.user-rename', async (t) => {
  const was = (await rest(quinn, 'GET', `/users/${cara.userId}`)).user.full_name as string;
  let from = t.mark();
  await rest(ann, 'PATCH', `/users/${cara.userId}`, { full_name: `${was} Renamed` });
  try {
    const e = await t.event('identity with the new name', (x) => x.t === 'identity' && x.identity.nativeId === uid(cara) && x.identity.displayName === `${was} Renamed`, from);
    t.eq(e?.identity.handle, cara.email, 'still with the real email as handle');
    // A mention written with the old name and no id no longer resolves; one with the new name does.
    const topic = tn('renamed mention');
    const id = await say(ann, { stream: G(), topic }, `Hello @**${was} Renamed**.`);
    const m = await t.event('a message mentioning the new name', isMsg(id), from);
    t.eq(m?.message.body, `Hello <@${uid(cara)}>.`, 'the new name resolves to the person');
  } finally {
    from = t.mark();
    await rest(ann, 'PATCH', `/users/${cara.userId}`, { full_name: was });
    await t.event('identity with the old name back', (x) => x.t === 'identity' && x.identity.nativeId === uid(cara) && x.identity.displayName === was, from);
  }
});

check('live.user-avatar', async (t) => {
  const from = t.mark();
  const fd = new FormData();
  fd.append('file', pngFile('face.png', [200, 40, 40]));
  await rest(cara, 'POST', '/users/me/avatar', {}, fd);
  const e = await t.event('identity with a new picture', (x) => x.t === 'identity' && x.identity.nativeId === uid(cara), from);
  t.ok(/^zulip:\/user_avatars\//.test(e?.identity.avatarUrl ?? ''), 'a picture on the server, to fetch through the extractor', e?.identity);
  if (e?.identity.avatarUrl?.startsWith('zulip:')) {
    const media = await t.cmd({ t: 'fetchMedia', url: e.identity.avatarUrl });
    t.ok(media?.mime?.startsWith('image/') && media.base64?.length > 20, 'and it fetches', media && { mime: media.mime, n: media.base64?.length });
  }
  await rest(cara, 'DELETE', '/users/me/avatar');
});

check('live.realm-emoji', async (t) => {
  const name = `drv${RUN}`;
  const topic = tn('live emoji');
  const id = await say(ann, { stream: G(), topic }, 'For a brand new emoji.');
  await t.event('the message', isMsg(id), 0);
  const fd = new FormData();
  fd.append('file', pngFile(`${name}.png`, [240, 200, 20]));
  await rest(quinn, 'POST', `/realm/emoji/${name}`, {}, fd);
  const [code, e0] = Object.entries<any>((await rest(quinn, 'GET', '/realm/emoji')).emoji).find(([, e]) => e.name === name)!;
  let from = t.mark();
  await rest(bob, 'POST', `/messages/${id}/reactions`, { emoji_name: name });
  const e = await t.event('a reaction with the new emoji', (x) => x.t === 'reaction' && x.message === mid(id), from);
  t.eq(e && [e.key, e.emoji], [`realm:${code}`, { key: `realm:${code}`, name, url: `zulip:${e0.source_url}` }], 'known at once, with its picture');
  const ctx = await t.cmd({ t: 'reactionContext', conversation: topicId(G(), topic) });
  t.ok(ctx?.custom?.[0]?.emoji.some((x: any) => x.key === `realm:${code}`), 'and offered in the picker');
  // In a message's words a custom emoji stays :name:.
  from = t.mark();
  const id2 = await say(bob, { stream: G(), topic }, `Look :${name}: and :smile:`);
  const m = await t.event('a message using it', isMsg(id2), from);
  t.eq(m?.message.body, `Look :${name}: and 😄`, 'the custom one stays as its name');
  await rest(quinn, 'DELETE', `/realm/emoji/${name}`);
  await t.settled();
  const ctx2 = await t.cmd({ t: 'reactionContext', conversation: topicId(G(), topic) });
  t.ok(ctx2 && !ctx2.custom[0].emoji.some((x: any) => x.key === `realm:${code}`), 'a deactivated emoji is no longer offered');
});

check('live.user-group', async (t) => {
  const name = `drv-${RUN}`;
  const conv = topicId(CH.design, 'colors');
  const gid = (await rest(ann, 'POST', '/user_groups/create', { name, description: 'A group made by the driver.', members: [quinn.userId, bob.userId] })).group_id as number;
  await t.settled();
  const role = async () => ((await t.cmd({ t: 'mentionables', conversation: conv, query: 'drv', limit: 20 }))?.roles ?? []).find((r: any) => r.id === `${HOST}/g/${gid}`);
  t.eq(await role(), { id: `${HOST}/g/${gid}`, name, count: 2 }, 'a new group is offered in the @ picker');
  const from = t.mark();
  const id = await say(ann, { stream: G(), topic: tn('live group') }, `@*${name}* hello group`);
  const m = await t.event('a message mentioning the group', isMsg(id), from);
  t.eq(m && [m.message.body, !!m.message.mentionsSelf, !!m.message.mentionsAll], [`<@&${HOST}/g/${gid}> hello group`, true, false], 'a group mention is a role mention (rich.ts: <@&id>), and one of a group the account is in mentions it');
  await rest(ann, 'POST', `/user_groups/${gid}/members`, { add: [cara.userId] });
  await t.settled();
  t.eq((await role())?.count, 3, 'a member added');
  await rest(ann, 'POST', `/user_groups/${gid}/members`, { delete: [bob.userId] });
  await t.settled();
  t.eq((await role())?.count, 2, 'a member removed');
  await rest(ann, 'PATCH', `/user_groups/${gid}`, { name: `${name}-x` });
  await t.settled();
  t.eq((await role())?.name, `${name}-x`, 'renamed');
  await rest(ann, 'POST', `/user_groups/${gid}/deactivate`);
  await t.settled();
  t.eq(await role(), undefined, 'a deactivated group is no longer offered');
});

check('live.muted-user', async (t) => {
  await restRaw(quinn, 'DELETE', `/users/me/muted_users/${dave.userId}`);
  let from = t.mark();
  await rest(quinn, 'POST', `/users/me/muted_users/${dave.userId}`);
  const e = await t.event('ignored with Dave', (x) => x.t === 'ignored' && x.identities.includes(uid(dave)), from);
  t.ok(e, 'muted elsewhere');
  from = t.mark();
  await rest(quinn, 'DELETE', `/users/me/muted_users/${dave.userId}`);
  await t.event('ignored without Dave', (x) => x.t === 'ignored' && !x.identities.includes(uid(dave)), from);
});

check('live.topic-policy-elsewhere', async (t) => {
  const topic = tn('policy elsewhere');
  const conv = topicId(G(), topic);
  const id = await say(ann, { stream: G(), topic }, 'Follow, mute, forget.');
  await t.event('the message', isMsg(id), 0);
  const set = async (p: number) => {
    const from = t.mark();
    await rest(quinn, 'POST', '/user_topics', { stream_id: G(), topic, visibility_policy: p });
    return from;
  };
  const f3 = await t.event('followed', (x) => isConv(conv)(x) && x.conversation.thread?.joined === true, await set(3));
  t.eq(f3 && [f3.conversation.thread.notify, f3.conversation.mute], ['all', { level: 'all' }], 'following notifies of everything');
  const f1 = await t.event('muted', (x) => isConv(conv)(x) && x.conversation.mute?.muted === true, await set(1));
  t.eq(f1?.conversation.thread?.joined, false, 'a muted topic is not followed');
  const f0 = await t.event('back to the channel\'s setting', (x) => isConv(conv)(x) && !x.conversation.mute?.muted && x.conversation.thread?.joined === false, await set(0));
  t.eq(f0?.conversation.mute, {}, 'an empty mute clears what was said');
});

check('live.org-change', async (t) => {
  const was = (await registered(['realm'])).realm_description as string;
  let from = t.mark();
  await rest(ann, 'PATCH', '/realm', { description: `Changed by the driver ${RUN}.` });
  try {
    const e = await t.event('the organization with its new description', (x) => x.t === 'space' && x.space.nativeId === HOST && x.space.topic === `Changed by the driver ${RUN}.`, from);
    if (!e) t.ok(false, 'what was said of the organization instead', t.heard((x) => x.t === 'space', from));
  } finally {
    from = t.mark();
    await rest(ann, 'PATCH', '/realm', { description: was });
    await t.event('the organization with its old description', (x) => x.t === 'space' && x.space.nativeId === HOST && (x.space.topic ?? '') === was, from);
  }
});

// ================================================================ commands

const cleanups: (() => Promise<unknown>)[] = [];
const sentId = (r: any) => Number(String(r?.nativeId ?? '').split('/').pop()) || 0;
/** Zulip's web client's encoding of a part of a #narrow link (web/shared/src/internal_url.ts encodeHashComponent). */
const hashEnc = (s: string) => encodeURIComponent(s).replace(/[%!'()*.]/g, (c) => ({ '%': '.', '!': '.21', "'": '.27', '(': '.28', ')': '.29', '*': '.2A', '.': '.2E' })[c]!);
const policyOf = async (stream: number, topic: string): Promise<number> => ((await registered(['user_topic'])).user_topics as any[]).find((u) => u.stream_id === stream && u.topic_name.toLowerCase() === topic.toLowerCase())?.visibility_policy ?? 0;
const subOf = async (stream: number) => ((await rest(quinn, 'GET', '/users/me/subscriptions')).subscriptions as any[]).find((s) => s.stream_id === stream);
const streamOf = async (stream: number) => (await rest(quinn, 'GET', `/streams/${stream}`)).stream;

/** A fresh topic in #general with one message by Ann, which the extractor has heard. */
async function freshTopic(t: T, name: string, text = 'A topic for a command.'): Promise<{ topic: string; conv: string; first: number }> {
  const topic = tn(name);
  const first = await say(ann, { stream: G(), topic }, text);
  await t.event(`the first message of ${topic}`, isMsg(first), 0);
  return { topic, conv: topicId(G(), topic), first };
}
/** A channel of Quinn's own (Quinn made it, Ann is in it), for settings. */
const ownChannel = () =>
  once('ownChannel', async () => {
    const S = await session();
    const name = `drv-${RUN}-own`;
    const from = S.link.events.length;
    await rest(quinn, 'POST', '/users/me/subscriptions', { subscriptions: [{ name, description: 'Made by the driver, for settings.' }], principals: [quinn.userId, ann.userId], send_new_subscription_messages: false });
    const id = (await rest(quinn, 'GET', '/get_stream_id', { stream: name })).stream_id as number;
    await S.link.next(isConv(chan(id)) as any, 8000, from);
    cleanups.push(() => restRaw(quinn, 'DELETE', `/streams/${id}`));
    return { id, name };
  });

check('cmd.send-topic', async (t) => {
  const { conv, topic } = await freshTopic(t, 'send');
  const from = t.mark();
  const r = await t.cmd({ t: 'send', conversation: conv, body: 'Hello from the hub.' });
  const id = sentId(r);
  if (!t.ok(id, 'the reply names the sent message', r)) return;
  const e = await t.event('the echo', isMsg(id), from);
  t.eq(e && [e.message.author, e.message.conversation, e.message.body], [uid(quinn), conv, 'Hello from the hub.'], 'the echo');
  const src = await raw(id);
  t.eq([src.content, src.subject, src.stream_id, src.flags.includes('read')], ['Hello from the hub.', topic, G(), true], 'as the server has it, read by its sender');
  t.eq(t.heard(isMsg(id), from).length, 1, 'said once');
});

check('cmd.send-direct', async (t) => {
  for (const [what, people] of [['a direct conversation', [quinn, cara]], ['the self conversation', [quinn]], ['a group conversation', [quinn, ann, bob]]] as [string, Who[]][]) {
    const conv = dmId(...people);
    const from = t.mark();
    const r = await t.cmd({ t: 'send', conversation: conv, body: `To ${what}, ${RUN}.` });
    const id = sentId(r);
    if (!t.ok(id, `${what}: the reply names the message`, r)) continue;
    const e = await t.event(`${what}: the echo`, isMsg(id), from);
    t.eq(e && [e.message.conversation, e.message.author], [conv, uid(quinn)], `${what}: the echo`);
    const src = await raw(id);
    t.eq([src.type, src.display_recipient.map((x: any) => x.id).sort((a: number, b: number) => a - b)], ['private', people.map((p) => p.userId).sort((a, b) => a - b)], `${what}: as the server has it`);
    const r2 = await t.maybe(isRead(conv), from, 3000);
    t.ok(r2 && r2.upToTs >= src.timestamp * 1000 - 1 === (r2.unread === 0) , `${what}: a read event after an own message agrees with itself`, r2);
  }
});

check('cmd.send-refusals', async (t) => {
  const why = await t.refuses({ t: 'send', conversation: chan(G()), body: 'Into a channel without a topic.' }, 'a send to a channel itself');
  t.ok(why && /topic/i.test(why), 'the refusal says to open a topic', why);
  await t.refuses({ t: 'send', conversation: `${HOST}/s/99999/t/x`, body: 'Nowhere.' }, 'a send to a channel that does not exist');
  await t.refuses({ t: 'send', conversation: 'other.example:1/s/1/t/x', body: 'Another server.' }, 'a send to another server\'s id');
  await t.refuses({ t: 'send', conversation: topicId(G(), 'formatting'), body: '   ' }, 'an empty send');
  await t.refuses({ t: 'forward', conversation: topicId(G(), 'formatting'), source: { conversation: topicId(G(), 'formatting'), message: mid(M.plain) } }, 'a command it does not have');
});

check('cmd.send-empty-topic', async (t) => {
  const from = t.mark();
  const r = await t.cmd({ t: 'send', conversation: topicId(G(), ''), body: 'Into general chat.' });
  const id = sentId(r);
  if (!id) return void t.ok(false, 'a send to the empty topic', r);
  const e = await t.event('the echo', isMsg(id), from);
  t.eq(e?.message.conversation, topicId(G(), ''), 'in the empty topic');
  t.eq((await raw(id)).subject, '', 'the server has it in the empty topic');
});

check('cmd.send-attachments', async (t) => {
  const { conv } = await freshTopic(t, 'send files');
  const note = tmpFile(`drive note (${RUN}).txt`, `A note from run ${RUN}.\n`);
  const pic = tmpFile(`dot-${RUN}.png`, png());
  let from = t.mark();
  const r = await t.cmd({ t: 'send', conversation: conv, body: 'Two files.', attachments: [note, pic] });
  const id = sentId(r);
  if (!t.ok(id, 'the reply names the message', r)) return;
  const e = await t.event('the echo', isMsg(id), from);
  const src = await raw(id);
  t.ok(/^Two files\.\n\[drive note \([a-z0-9]+\)\.txt\]\(\/user_uploads\/\S+\)\n\[dot-[a-z0-9]+\.png\]\(\/user_uploads\/\S+\)$/.test(src.content), 'the server has the words and a link for each file', src.content);
  t.eq(e && [e.message.body, e.message.kind, (e.message.attachments ?? []).map((a: any) => [a.name, a.kind, a.mime])], ['Two files.', 'text', [[note.name, 'file', 'text/plain'], [pic.name, 'image', 'image/png']]], 'the echo has both attachments, by their names');
  for (const [i, f] of [note, pic].entries()) {
    const a = e?.message.attachments?.[i];
    if (!a) continue;
    t.ok(/^zulip:\/user_uploads\//.test(a.url), 'an attachment\'s url goes through the extractor', a.url);
    const media = await t.cmd({ t: 'fetchMedia', url: a.url });
    t.eq(media && [media.mime, media.base64], [f.mime, readFileSync(f.path).toString('base64')], `${f.name} fetched back is the file sent`);
  }
  from = t.mark();
  const r2 = await t.cmd({ t: 'send', conversation: conv, body: '', attachments: [pic] });
  const e2 = await t.event('a file alone', isMsg(sentId(r2)), from);
  t.eq(e2 && [e2.message.body, e2.message.kind, e2.message.attachments?.length], ['', 'media', 1], 'a file alone is a media message with no words');
});

check('cmd.send-reply', async (t) => {
  const quoted = 'Notes for the reply check.';
  const { conv, topic, first } = await freshTopic(t, 'reply', quoted);
  const from = t.mark();
  const r = await t.cmd({ t: 'send', conversation: conv, body: 'The reply.', replyTo: mid(first) });
  const id = sentId(r);
  if (!t.ok(id, 'the reply names the message', r)) return;
  const e = await t.event('the echo', isMsg(id), from);
  const annName = (await rest(quinn, 'GET', `/users/${ann.userId}`)).user.full_name;
  const want = `@_**${annName}|${ann.userId}** [said](${BASE}/#narrow/channel/${G()}-general/topic/${hashEnc(topic)}/near/${first}):\n\`\`\`quote\n${quoted}\n\`\`\`\nThe reply.`;
  t.eq((await raw(id)).content, want, 'the server has the quote as Zulip\'s web client writes it');
  t.eq(e && [e.message.replyTo, e.message.body], [mid(first), 'The reply.'], 'the echo is a reply with only its own words');
});

check('cmd.send-reply-odd-places', async (t) => {
  // A topic whose name has parentheses and a dot, a quoted message with a code block, and a direct conversation.
  const { conv, first } = await freshTopic(t, 'reply (v1.2) [x]', 'Quoted in an oddly named topic.');
  let from = t.mark();
  let r = await t.cmd({ t: 'send', conversation: conv, body: 'Reply in the odd topic.', replyTo: mid(first) });
  let e = await t.event('the echo in the odd topic', isMsg(sentId(r)), from);
  t.eq(e && [e.message.replyTo, e.message.body], [mid(first), 'Reply in the odd topic.'], 'a reply in a topic named with ( ) . [ ] comes back as a reply');
  if (sentId(r)) {
    const html = (await rest(quinn, 'GET', `/messages/${sentId(r)}`, { apply_markdown: true })).message.content as string;
    t.ok(html.includes(`/near/${first}"`) || html.includes(`/near/${first}&quot;`) || new RegExp(`near/${first}["<]`).test(html), 'and Zulip renders its "said" link whole', html.slice(0, 400));
  }
  from = t.mark();
  r = await t.cmd({ t: 'send', conversation: topicId(G(), 'formatting'), body: 'Reply to code.', replyTo: mid(M.code) });
  e = await t.event('the echo of a reply to a message with a code block', isMsg(sentId(r)), from);
  t.eq(e && [e.message.replyTo, e.message.body], [mid(M.code), 'Reply to code.'], 'a reply to a message with a ``` block');
  if (sentId(r)) t.ok(/\n````quote\n[\s\S]*\n````\n/.test((await raw(sentId(r))).content), 'quoted inside a longer fence', (await raw(sentId(r))).content);
  const d = await say(ann, { dm: [quinn] }, 'Quoted in a direct conversation.');
  await t.event('Ann\'s direct message', isMsg(d), 0);
  from = t.mark();
  r = await t.cmd({ t: 'send', conversation: dmId(quinn, ann), body: 'Reply in a direct conversation.', replyTo: mid(d) });
  e = await t.event('the echo in the direct conversation', isMsg(sentId(r)), from);
  t.eq(e && [e.message.replyTo, e.message.body], [mid(d), 'Reply in a direct conversation.'], 'a reply in a direct conversation');
  if (sentId(r)) t.ok((await raw(sentId(r))).content.includes(`/#narrow/dm/${quinn.userId},${ann.userId}-dm/near/${d})`), 'with the web client\'s link to a direct message', (await raw(sentId(r))).content);
});

check('cmd.edit', async (t) => {
  const { conv } = await freshTopic(t, 'edit');
  const r = await t.cmd({ t: 'send', conversation: conv, body: 'Before.' });
  const id = sentId(r);
  await t.event('the echo', isMsg(id), 0);
  const from = t.mark();
  const res = await t.cmd({ t: 'edit', conversation: conv, message: mid(id), body: `After, for <@${uid(ann)}>.` });
  t.ok(res !== undefined, 'edit answers');
  const e = await t.event('the message again', (x) => isMsg(id)(x) && x.message.body !== 'Before.', from);
  const src = await raw(id);
  t.eq(src.content, `After, for @**${(await rest(quinn, 'GET', `/users/${ann.userId}`)).user.full_name}|${ann.userId}**.`, 'the server has the new words');
  t.eq(e && [e.message.body, e.message.editedTs], [`After, for <@${uid(ann)}>.`, src.last_edit_timestamp * 1000], 'the edit, with its time');
  const why = await t.refuses({ t: 'edit', conversation: conv, message: mid(M.plain), body: 'Not mine.' }, 'editing someone else\'s message');
  t.ok(why && why.length > 5, 'with the server\'s reason', why);
});

check('cmd.edit-keeps-reply-quote', async (t) => {
  const { conv, first } = await freshTopic(t, 'edit reply', 'Quoted, then the reply is edited.');
  const r = await t.cmd({ t: 'send', conversation: conv, body: 'Reply, first wording.', replyTo: mid(first) });
  const id = sentId(r);
  await t.event('the echo', isMsg(id), 0);
  const from = t.mark();
  await t.cmd({ t: 'edit', conversation: conv, message: mid(id), body: 'Reply, second wording.' });
  const e = await t.event('the message again', (x) => isMsg(id)(x) && x.message.body.includes('second'), from);
  const src = (await raw(id)).content as string;
  t.ok(src.includes('```quote\nQuoted, then the reply is edited.\n```') && src.endsWith('Reply, second wording.'), 'editing a reply keeps its quote on the server (the hub\'s body never had it, so an edit must put it back)', src);
  t.eq(e?.message.replyTo, mid(first), 'and it is still a reply');
});

check('cmd.edit-keeps-attachment', async (t) => {
  const { conv } = await freshTopic(t, 'edit file');
  const pic = tmpFile(`edit-${RUN}.png`, png([10, 200, 10]));
  const r = await t.cmd({ t: 'send', conversation: conv, body: 'Caption, first wording.', attachments: [pic] });
  const id = sentId(r);
  await t.event('the echo', isMsg(id), 0);
  const from = t.mark();
  await t.cmd({ t: 'edit', conversation: conv, message: mid(id), body: 'Caption, second wording.' });
  const e = await t.event('the message again', (x) => isMsg(id)(x) && x.message.body.includes('second'), from);
  const src = (await raw(id)).content as string;
  t.ok(/\/user_uploads\//.test(src), 'editing the caption keeps the file\'s link on the server (the hub\'s body never had it)', src);
  t.eq(e?.message.attachments?.length, 1, 'and the message still has its attachment');
});

check('cmd.edit-keeps-mention-kinds', async (t) => {
  // What the hub holds for a silent mention and a group mention must go back as what they were.
  const annName = (await rest(quinn, 'GET', `/users/${ann.userId}`)).user.full_name;
  const { conv } = await freshTopic(t, 'edit mentions');
  const id = (await rest(quinn, 'POST', '/messages', { type: 'stream', to: G(), topic: tn('edit mentions'), content: `Thanks @_**${annName}|${ann.userId}** and @*designers*.`, read_by_sender: true })).id as number;
  const e = await t.event('the message', isMsg(id), 0);
  if (!e) return;
  const from = t.mark();
  await t.cmd({ t: 'edit', conversation: conv, message: mid(id), body: `${e.message.body} Edited.` });
  await t.event('the message again', (x) => isMsg(id)(x) && x.message.body.endsWith('Edited.'), from);
  const src = (await raw(id)).content as string;
  t.ok(src.includes(`@_**${annName}|${ann.userId}**`), 'a silent mention stays silent through an edit of the hub\'s body (else the edit pings her)', src);
  t.ok(src.includes('@*designers*'), 'a group mention stays a group mention through an edit', src);
});

check('cmd.redact', async (t) => {
  const { conv } = await freshTopic(t, 'redact');
  const r = await t.cmd({ t: 'send', conversation: conv, body: 'To be deleted.' });
  const id = sentId(r);
  await t.event('the echo', isMsg(id), 0);
  const from = t.mark();
  await t.cmd({ t: 'redact', conversation: conv, message: mid(id) });
  const e = await t.event('the delete', (x) => x.t === 'delete' && x.nativeId === mid(id), from);
  t.eq(e?.conversation, conv, 'in its conversation');
  t.eq((await restRaw(quinn, 'GET', `/messages/${id}`)).json?.code, 'BAD_REQUEST', 'gone from the server');
});

check('cmd.react', async (t) => {
  const { conv, first } = await freshTopic(t, 'react');
  const parrot = Object.entries<any>((await rest(quinn, 'GET', '/realm/emoji')).emoji).find(([, e]) => e.name === 'partyparrot' && !e.deactivated)!;
  const cases: [string, string, { emoji_code: string; reaction_type: string }][] = [
    ['a Unicode emoji', '👍', { emoji_code: '1f44d', reaction_type: 'unicode_emoji' }],
    ['one typed with a variation selector', '❤️', { emoji_code: '2764', reaction_type: 'unicode_emoji' }],
    ['a flag', '🇯🇵', { emoji_code: '1f1ef-1f1f5', reaction_type: 'unicode_emoji' }],
    ['a keycap', '1️⃣', { emoji_code: '0031-20e3', reaction_type: 'unicode_emoji' }],
    ['the organization\'s own', `realm:${parrot[0]}`, { emoji_code: parrot[0], reaction_type: 'realm_emoji' }],
    [':zulip:', 'zulip:zulip', { emoji_code: 'zulip', reaction_type: 'zulip_extra_emoji' }],
  ];
  for (const [what, key, want] of cases) {
    let from = t.mark();
    const r = await t.cmd({ t: 'react', conversation: conv, message: mid(first), key }, `react with ${what}`);
    if (r === undefined) continue;
    const mine = ((await raw(first)).reactions as any[]).filter((x) => x.user_id === quinn.userId).map((x) => ({ emoji_code: x.emoji_code, reaction_type: x.reaction_type }));
    t.eq(mine, [want], `${what}: on the server`);
    const e = await t.event(`${what}: the reaction heard back`, (x) => x.t === 'reaction' && x.message === mid(first) && x.author === uid(quinn) && !x.remove, from);
    t.eq(e && canonicalReactionKey(e.key), canonicalReactionKey(key), `${what}: under the same key`);
    from = t.mark();
    await t.cmd({ t: 'react', conversation: conv, message: mid(first), key, remove: true }, `unreact ${what}`);
    t.eq(((await raw(first)).reactions as any[]).filter((x) => x.user_id === quinn.userId).length, 0, `${what}: taken off on the server`);
    await t.event(`${what}: the removal heard back`, (x) => x.t === 'reaction' && x.message === mid(first) && x.author === uid(quinn) && x.remove === true, from);
  }
  await t.refuses({ t: 'react', conversation: conv, message: mid(first), key: 'not an emoji' }, 'free text as a reaction');
});

check('cmd.reactionContext', async (t) => {
  const ctx = await t.cmd({ t: 'reactionContext', conversation: topicId(CH.design, 'colors') });
  if (!ctx) return;
  t.eq([ctx.canReact, ctx.custom?.[0]?.id, ctx.custom?.[0]?.name], [true, HOST, creds.realm], 'reactions allowed, with the organization\'s set');
  const names = (ctx.custom?.[0]?.emoji ?? []).map((e: any) => e.name);
  t.ok(names.includes('partyparrot') && names.includes('zulip'), 'partyparrot and zulip are offered', names);
  for (const e of ctx.custom?.[0]?.emoji ?? []) {
    if (e.name !== 'partyparrot' && e.name !== 'zulip') continue;
    try {
      const media = await t.S.a.command({ t: 'fetchMedia', id: `d${++cmdN}`, url: e.url } as any) as any;
      t.ok(media?.mime?.startsWith('image/'), `the picture of :${e.name}: fetches`, media?.mime);
    } catch (err) {
      t.ok(false, `the picture of :${e.name}: fetches (${e.url})`, (err as Error).message);
    }
  }
});

check('cmd.reactors', async (t) => {
  const conv = topicId(CH.design, 'colors');
  const ask = async (key: string) => [...((await t.cmd({ t: 'reactors', conversation: conv, message: mid(M.reacted), key }))?.authors ?? [])].sort();
  t.eq(await ask('👍'), [uid(quinn), uid(bob)].sort(), 'thumbs up');
  t.eq(await ask('zulip:zulip'), [uid(bob)], ':zulip:');
  t.eq(await ask(canonicalReactionKey('❤')), [uid(quinn)], 'the heart, asked for by the hub\'s canonical key (with its variation selector)');
});

check('cmd.markRead', async (t) => {
  const topic = tn('mark read');
  const conv = topicId(G(), topic);
  const ids: number[] = [];
  for (const w of ['One.', 'Two.', 'Three.']) ids.push(await say(ann, { stream: G(), topic }, w));
  await t.event('read: 3 unread', isRead(conv, 3), 0);
  const flags = async () => Promise.all(ids.map(async (i) => (await raw(i)).flags.includes('read')));
  let from = t.mark();
  await t.cmd({ t: 'markRead', conversation: conv, upTo: mid(ids[1]) });
  t.eq(await flags(), [true, true, false], 'only that message and earlier are read on the server');
  const r = await t.event('read: 1 unread', isRead(conv, 1), from);
  t.ok(r && !r.manual, 'not manual', r);
  from = t.mark();
  await t.cmd({ t: 'markRead', conversation: conv, upTo: mid(ids[2]) });
  t.eq(await flags(), [true, true, true], 'then all of it');
  await t.event('read: 0 unread', isRead(conv, 0), from);
  // A direct conversation, and other conversations left alone.
  const other = await say(bob, { stream: G(), topic: tn('mark read other') }, 'Not to be marked.');
  const d = [await say(cara, { dm: [quinn] }, 'Direct one.'), await say(cara, { dm: [quinn] }, 'Direct two.')];
  await t.event('the second direct message', isMsg(d[1]), 0);
  await t.cmd({ t: 'markRead', conversation: dmId(quinn, cara), upTo: mid(d[0]) });
  t.eq([(await raw(d[0])).flags.includes('read'), (await raw(d[1])).flags.includes('read'), (await raw(other)).flags.includes('read')], [true, false, false], 'a direct conversation up to its first; nothing else touched');
  await t.cmd({ t: 'markRead', conversation: dmId(quinn, cara), upTo: mid(d[1]) });
});

check('cmd.markReadMany', async (t) => {
  const a = tn('many a');
  const b = tn('many b');
  const ia = [await say(ann, { stream: G(), topic: a }, 'A1.'), await say(ann, { stream: G(), topic: a }, 'A2.')];
  const ib = [await say(ann, { stream: G(), topic: b }, 'B1.'), await say(ann, { stream: G(), topic: b }, 'B2.')];
  await t.event('the last of them', isMsg(ib[1]), 0);
  const from = t.mark();
  const r = await t.cmd({ t: 'markReadMany', items: [{ conversation: topicId(G(), a), upTo: mid(ia[1]) }, { conversation: topicId(G(), b), upTo: mid(ib[0]) }] });
  t.eq(await Promise.all([...ia, ...ib].map(async (i) => (await raw(i)).flags.includes('read'))), [true, true, true, false], 'each read up to its message on the server');
  await t.event('read: topic a 0 unread', isRead(topicId(G(), a), 0), from);
  await t.event('read: topic b 1 unread', isRead(topicId(G(), b), 1), from);
  t.eq(r, { marked: 2 }, 'answers { marked } (attention.ts)');
});

check('cmd.markUnread', async (t) => {
  const topic = tn('mark unread');
  const conv = topicId(G(), topic);
  const ids: number[] = [];
  for (const w of ['One.', 'Two.', 'Three.']) ids.push(await say(ann, { stream: G(), topic }, w));
  await t.event('the third', isMsg(ids[2]), 0);
  await t.cmd({ t: 'markRead', conversation: conv, upTo: mid(ids[2]) });
  await t.event('read: 0 unread', isRead(conv, 0), 0);
  const from = t.mark();
  await t.cmd({ t: 'markUnread', conversation: conv, from: mid(ids[1]) });
  t.eq(await Promise.all(ids.map(async (i) => (await raw(i)).flags.includes('read'))), [true, false, false], 'unread from that message on, on the server');
  const r = await t.event('read: 2 unread, manual', (x) => isRead(conv, 2)(x) && x.manual === true, from);
  const ts1 = (await raw(ids[1])).timestamp * 1000;
  t.ok(r && r.upToTs < ts1, 'with the read point before that message', { r, ts1 });
});

check('cmd.typing', async (t) => {
  const { topic, conv } = await freshTopic(t, 'typing out');
  const ears = await listen(ann, ['typing']);
  try {
    await t.cmd({ t: 'typing', conversation: dmId(quinn, ann) });
    const e = await ears.next((x) => x.type === 'typing' && x.op === 'start' && x.message_type === 'direct' && x.sender.user_id === quinn.userId);
    t.ok(e, 'Ann hears Quinn typing to her');
    await t.cmd({ t: 'typing', conversation: dmId(quinn, ann), stop: true });
    t.ok(await ears.next((x) => x.type === 'typing' && x.op === 'stop' && x.message_type === 'direct' && x.sender.user_id === quinn.userId), 'and stopping');
    await t.cmd({ t: 'typing', conversation: conv });
    const s = await ears.next((x) => x.type === 'typing' && x.op === 'start' && x.message_type === 'stream' && x.sender.user_id === quinn.userId);
    t.eq(s && [s.stream_id, s.topic], [G(), topic], 'Ann hears Quinn typing in the topic');
    await t.cmd({ t: 'typing', conversation: conv, stop: true });
    t.ok(await ears.next((x) => x.type === 'typing' && x.op === 'stop' && x.message_type === 'stream' && x.sender.user_id === quinn.userId), 'and stopping there');
    t.ok((await t.cmd({ t: 'typing', conversation: dmId(quinn) })) !== undefined, 'typing to oneself is quietly nothing');
  } finally {
    await ears.close();
  }
});

check('cmd.history', async (t) => {
  const conv = topicId(G(), 'history');
  const all = ((await rest(quinn, 'GET', '/messages', { anchor: 'newest', num_before: 1000, num_after: 0, narrow: [{ operator: 'channel', operand: G() }, { operator: 'topic', operand: 'history' }], apply_markdown: false })).messages as any[]).map((m) => ({ id: m.id, ts: m.timestamp * 1000 }));
  t.ok(all.length >= 120, 'the seeded topic has its 120 messages', all.length);
  let from = t.mark();
  const p1 = await t.cmd({ t: 'history', conversation: conv, limit: 50 });
  if (!p1) return;
  const newest50 = all.slice(-50);
  t.eq({ count: p1.count, done: p1.done, oldest: p1.oldest, next: p1.next }, { count: 50, done: false, oldest: newest50[0].ts, next: String(newest50[0].id) }, 'the newest page');
  const said = t.heard((x) => x.t === 'message' && x.message.conversation === conv, from);
  t.eq(said.map((x) => x.message.nativeId), newest50.map((m) => mid(m.id)), 'its messages are said, oldest first');
  t.ok(said.every((x) => x.live === false), 'none live');
  const got = new Set(newest50.map((m) => m.id));
  let cursor = p1.next as string | undefined;
  let done = false;
  let pages = 1;
  while (!done && cursor && pages < 10) {
    from = t.mark();
    const p = await t.cmd({ t: 'history', conversation: conv, limit: 50, cursor });
    if (!p) return;
    pages++;
    const ids = t.heard((x) => x.t === 'message' && x.message.conversation === conv, from).map((x) => Number(x.message.nativeId.split('/').pop()));
    t.eq(ids.length, p.count, `page ${pages} says as many messages as it counts`);
    t.eq(ids.filter((i) => got.has(i)), [], `page ${pages} repeats nothing`);
    for (const i of ids) got.add(i);
    done = p.done;
    cursor = p.next;
  }
  t.eq([done, got.size, pages], [true, all.length, Math.ceil(all.length / 50) + (all.length % 50 === 0 ? 1 : 0)], 'paging by cursor reaches the start with every message once');
  // By time: the page just before a moment.
  const pivot = all[Math.floor(all.length / 2)];
  const before = all.filter((m) => m.ts < pivot.ts);
  if (before.length >= 10) {
    from = t.mark();
    const p = await t.cmd({ t: 'history', conversation: conv, limit: 10, beforeTs: pivot.ts });
    const ids = t.heard((x) => x.t === 'message' && x.message.conversation === conv, from).map((x) => Number(x.message.nativeId.split('/').pop()));
    t.eq([p?.count, ids], [10, before.slice(-10).map((m) => m.id)], 'beforeTs gives the 10 messages just before that time');
    t.eq(p?.done, false, 'and is not the start');
  }
  // A whole channel and a direct conversation.
  from = t.mark();
  const pc = await t.cmd({ t: 'history', conversation: chan(CH.design), limit: 10 });
  const inDesign = t.heard((x) => x.t === 'message', from);
  t.ok(pc?.count === 10 && inDesign.length === 10 && inDesign.every((x) => x.message.conversation.startsWith(`${chan(CH.design)}/t/`)), 'a channel\'s history is its topics\' messages', { count: pc?.count, n: inDesign.length });
  from = t.mark();
  const pd = await t.cmd({ t: 'history', conversation: dmId(quinn, bot), limit: 20 });
  t.ok(pd?.done === true && pd.count >= 1 && t.heard(isMsg(M.botDm), from).length === 1, 'a direct conversation\'s history, to its start', pd);
});

check('cmd.search', async (t) => {
  const ids = (r: any) => (r?.hits ?? []).map((h: string) => Number(h.split('/').pop()));
  let from = t.mark();
  let r = await t.cmd({ t: 'search', scope: { kind: 'all' }, query: { text: 'teal' } });
  t.ok(ids(r).includes(M.reacted) && ids(r).includes(M.starred), 'text: both "teal" messages', r);
  t.ok(ids(r).every((i: number) => t.heard(isMsg(i), from).length >= 1), 'each hit\'s message fact came before the reply');
  r = await t.cmd({ t: 'search', scope: { kind: 'conversation', id: topicId(CH.design, 'colors') }, query: { text: 'contrast' } });
  t.eq(ids(r), [M.starred], 'in one topic');
  r = await t.cmd({ t: 'search', scope: { kind: 'all' }, query: { text: 'teal', authors: [uid(bob)] } });
  t.eq(ids(r), [M.starred], 'by author');
  r = await t.cmd({ t: 'search', scope: { kind: 'space', id: HOST }, query: { text: 'teal', in: [chan(CH.general)] } });
  t.eq(ids(r), [], 'in: a channel without it');
  r = await t.cmd({ t: 'search', scope: { kind: 'conversation', id: topicId(G(), 'files') }, query: { text: '', has: ['file'] } });
  t.eq(ids(r).sort(), [M.image, M.file].sort(), 'has: file');
  r = await t.cmd({ t: 'search', scope: { kind: 'conversation', id: topicId(G(), 'files') }, query: { text: '', has: ['image'] } });
  t.eq(ids(r), [M.image], 'has: image');
  r = await t.cmd({ t: 'search', scope: { kind: 'conversation', id: topicId(G(), 'formatting') }, query: { text: '', has: ['link'] } });
  t.ok(ids(r).includes(M.link), 'has: link', r);
  r = await t.cmd({ t: 'search', scope: { kind: 'conversation', id: topicId(G(), 'mentions') }, query: { text: '', mentions: [uid(quinn)] } });
  t.ok(ids(r).includes(M.mention) && !ids(r).includes(M.silentMention), 'mentions of the account', r);
  r = await t.cmd({ t: 'search', scope: { kind: 'conversation', id: topicId(G(), 'mentions') }, query: { text: '', mentions: [uid(ann)] } });
  t.ok(!ids(r).includes(M.plain) && ids(r).length <= 2, 'mentions of someone else are not answered with every message (a refusal or only hers)', r);
  // Paging: 120 hits, 25 at a time, newest first.
  const scope = { kind: 'conversation', id: topicId(G(), 'history') };
  const query = { text: 'History message' };
  const seen: number[] = [];
  let offset: number | null = 0;
  let pages = 0;
  while (offset !== null && pages < 10) {
    r = await t.cmd({ t: 'search', scope, query, offset, limit: 25 });
    if (!r) break;
    pages++;
    if (pages === 1) t.eq([r.hits.length, r.next, ids(r)[0]], [25, 25, M.historyLast], 'the first page: 25, newest first, more to come');
    seen.push(...ids(r));
    offset = r.next;
  }
  t.eq([seen.length, new Set(seen).size, seen[seen.length - 1]], [120, 120, M.historyFirst], 'paging by offset reaches all 120 once, ending at the oldest');
  r = await t.cmd({ t: 'search', scope, query: { ...query, sort: 'oldest' }, limit: 5 });
  t.eq(ids(r), [0, 1, 2, 3, 4].map((i) => M.historyFirst + i), 'oldest first');
  // A time window the newest page does not reach: the hits are further back.
  const first = await raw(M.historyFirst);
  const last = await raw(M.historyLast);
  if (last.timestamp - first.timestamp >= 2) {
    const before = (first.timestamp + 1) * 1000;
    const all: number[] = [];
    offset = 0;
    pages = 0;
    while (offset !== null && pages < 10) {
      r = await t.cmd({ t: 'search', scope, query: { ...query, before }, offset, limit: 25 });
      if (!r) break;
      pages++;
      all.push(...ids(r));
      offset = r.next;
    }
    t.ok(all.includes(M.historyFirst), `"before" a time ${last.timestamp - first.timestamp} s before the newest hit still finds the old hits (paged ${pages} time(s))`, all);
  }
});

check('cmd.fetchMedia', async (t) => {
  const img = await seeded(t, 'image');
  const url = img.attachments?.[0]?.url as string;
  const media = await t.cmd({ t: 'fetchMedia', url });
  const direct = await fetch(`${BASE}${url.replace(/^zulip:/, '')}`, { headers: { Authorization: `Basic ${Buffer.from(`${quinn.email}:${quinn.apiKey}`).toString('base64')}` } });
  t.eq(media && [media.mime, media.base64], ['image/png', Buffer.from(await direct.arrayBuffer()).toString('base64')], 'an upload, byte for byte');
  const me = t.heard((x) => x.t === 'identity' && x.identity.nativeId === uid(quinn)).pop()?.identity;
  const av = await t.cmd({ t: 'fetchMedia', url: me.avatarUrl });
  t.ok(av?.mime?.startsWith('image/') && av.base64.length > 100, 'an avatar', av && { mime: av.mime, n: av.base64.length });
  let asked = 0;
  const spy = (u: string) => {
    if (!u.startsWith(BASE)) asked++;
  };
  hooks.push(spy);
  try {
    for (const bad of ['zulip://example.com/user_uploads/x', 'zulip:https://example.com/x', 'https://example.com/x', `zulip:/\\example.com/x`]) await t.refuses({ t: 'fetchMedia', url: bad }, `fetching ${bad} with the key`);
  } finally {
    hooks.splice(hooks.indexOf(spy), 1);
  }
  t.eq(asked, 0, 'and no request left for another host');
});

check('cmd.openDirect', async (t) => {
  const has = async (w: Who) => ((await rest(quinn, 'GET', '/messages', { anchor: 'newest', num_before: 1, num_after: 0, narrow: [{ operator: 'dm', operand: [w.userId] }] })).messages as any[]).length > 0;
  for (const [what, peer, w] of [['by email', cara.email, cara], ['by native id', uid(dave), dave], ['by email in other case', bob.email.toUpperCase(), bob]] as [string, string, Who][]) {
    const from = t.mark();
    const r = await t.cmd({ t: 'openDirect', peer }, `openDirect ${what}`);
    if (!r) continue;
    const existed = await has(w);
    t.eq(r, { conversation: dmId(quinn, w), existed, ...(existed ? {} : { startsAtFirstSend: true }) }, `${what}: the answer`);
    const f = t.heard(isConv(dmId(quinn, w)), from)[0];
    t.eq(f && [f.conversation.shape, [...f.conversation.participants].sort()], ['direct', [uid(quinn), uid(w)].sort()], `${what}: the conversation was said before the answer`);
  }
  const self = await t.cmd({ t: 'openDirect', peer: quinn.email });
  t.eq(self?.conversation, dmId(quinn), 'oneself: the self conversation');
  await t.refuses({ t: 'openDirect', peer: 'nobody@example.com' }, 'someone who is not in the organization');
});

check('cmd.createGroup', async (t) => {
  const from = t.mark();
  const r = await t.cmd({ t: 'createGroup', people: [uid(cara), uid(dave)] });
  const conv = dmId(quinn, cara, dave);
  t.eq(r && [r.conversation, [...r.added].sort()], [conv, [uid(cara), uid(dave)].sort()], 'the answer');
  const f = t.heard(isConv(conv), from)[0];
  t.eq(f && [f.conversation.shape, [...f.conversation.participants].sort()], ['group', [uid(quinn), uid(cara), uid(dave)].sort()], 'a group conversation with its people, said before the answer');
  const s = await t.cmd({ t: 'send', conversation: conv, body: `First words in the group, ${RUN}.` });
  t.ok(sentId(s), 'and it can be written to', s);
});

check('cmd.threads', async (t) => {
  const topics = (await rest(quinn, 'GET', `/users/me/${G()}/topics`, { allow_empty_topic_name: true })).topics as { name: string; max_id: number }[];
  let from = t.mark();
  const r = await t.cmd({ t: 'threads', conversation: chan(G()), archived: false, offset: 0 });
  if (!r) return;
  t.eq([r.count, r.ids?.length], [Math.min(50, r.ids?.length ?? 0), r.count], 'counts its page');
  t.eq(r.ids, topics.slice(0, r.count).map((x) => topicId(G(), x.name)), 'the page is the server\'s order, newest activity first');
  t.eq(r.more, topics.length > r.count, 'more');
  for (const id of r.ids ?? []) {
    const f = t.heard(isConv(id)).pop();
    if (!f || f.conversation.parentConversation !== chan(G())) t.ok(false, `topic ${id} is said, hanging off its channel`, f);
  }
  const times = (r.ids ?? []).map((id: string) => t.heard(isConv(id)).pop()?.conversation.lastMessageAt ?? 0);
  t.ok(times.every((x: number) => x > 0), 'each with its last message\'s time', times.slice(0, 5));
  if (r.more) {
    from = t.mark();
    const r2 = await t.cmd({ t: 'threads', conversation: chan(G()), archived: false, offset: r.count });
    t.eq(r2?.ids, topics.slice(r.count, r.count + (r2?.count ?? 0)).map((x) => topicId(G(), x.name)), 'the next page carries on');
    t.ok(r2 && (r2.ids ?? []).every((id: string) => !(r.ids ?? []).includes(id)), 'without repeats');
  }
  const d = (await rest(quinn, 'GET', `/users/me/${CH.design}/topics`)).topics as { name: string }[];
  const ra = await t.cmd({ t: 'threads', conversation: chan(CH.design), archived: true, offset: 0 });
  const rn = await t.cmd({ t: 'threads', conversation: chan(CH.design), archived: false, offset: 0 });
  const resolved = d.filter((x) => x.name.startsWith('✔ ')).map((x) => topicId(CH.design, x.name));
  t.ok(resolved.length > 0, 'the sandbox has a resolved topic in #design');
  t.eq([...(ra?.ids ?? [])].sort(), [...resolved].sort(), 'archived: the resolved topics (the extractor calls a resolved topic archived)');
  t.eq((rn?.ids ?? []).filter((id: string) => resolved.includes(id)), [], 'and they are not among the active ones');
  await t.refuses({ t: 'threads', conversation: topicId(G(), 'history'), archived: false, offset: 0 }, 'threads of a topic');
});

check('cmd.createPost', async (t) => {
  const name = tn('Post Title');
  const from = t.mark();
  const r = await t.cmd({ t: 'createPost', conversation: chan(G()), name, body: 'The first message of a new topic.' });
  if (!r) return;
  t.eq(r.conversation, topicId(G(), name), 'answers the new topic');
  const atReply = t.mark();
  const f = t.heard(isConv(topicId(G(), name)), from)[0];
  t.eq(f && [f.conversation.name, f.conversation.parentConversation, t.S.link.events.indexOf(f) < atReply], [name, chan(G()), true], 'the topic is said before the answer, with its name as written');
  const m = await t.event('its first message', (x) => x.t === 'message' && x.message.conversation === topicId(G(), name), from);
  t.eq(m && [m.message.body, m.message.author], ['The first message of a new topic.', uid(quinn)], 'the first message');
  t.ok(m && t.S.link.events.indexOf(m) < atReply, 'the first message is said before the answer (threads.ts createPost)');
  if (m) t.eq((await raw(Number(m.message.nativeId.split('/').pop()))).subject, name, 'on the server, in the topic as named');
  // A name longer than Zulip's 60 characters: Zulip cuts it, and the answer must name the topic that exists.
  const long = `${tn('long')} ${'x'.repeat(70)}`;
  const from2 = t.mark();
  let res: any;
  try {
    res = await t.S.a.command({ t: 'createPost', id: `d${++cmdN}`, conversation: chan(G()), name: long, body: 'In a topic with a long name.' } as any);
  } catch (e) {
    res = { refused: (e as Error).message };
  }
  if (!res.refused) {
    const m2 = await t.event('the long-named topic\'s first message', (x) => x.t === 'message' && x.message.author === uid(quinn) && x.message.body === 'In a topic with a long name.', from2);
    t.eq(res.conversation, m2?.message.conversation, 'a name over 60 characters (the hub allows 100): the answer names the topic the message is really in');
  }
});

check('cmd.followThread', async (t) => {
  const { conv, topic } = await freshTopic(t, 'follow');
  let from = t.mark();
  const r = await t.cmd({ t: 'followThread', conversation: conv, follow: true });
  t.eq(await policyOf(G(), topic), 3, 'followed on the server');
  const f = await t.event('the topic, followed', (x) => isConv(conv)(x) && x.conversation.thread?.joined === true, from);
  t.eq(f?.conversation.thread?.notify, 'all', 'notifying of everything');
  t.eq(r && r.joined, true, 'answers the ThreadFact as it now stands (threads.ts)');
  from = t.mark();
  const r2 = await t.cmd({ t: 'followThread', conversation: conv, follow: false });
  t.eq(await policyOf(G(), topic), 0, 'unfollowed on the server');
  await t.event('the topic, not followed', (x) => isConv(conv)(x) && x.conversation.thread?.joined === false, from);
  t.eq(r2 && r2.joined, false, 'answers the ThreadFact after unfollowing');
  await t.refuses({ t: 'followThread', conversation: chan(G()), follow: true }, 'following a channel');
});

check('cmd.threadNotify', async (t) => {
  const { conv, topic } = await freshTopic(t, 'notify');
  const set = async (c: Params) => {
    await t.cmd({ t: 'threadNotify', conversation: conv, ...c });
    return policyOf(G(), topic);
  };
  t.eq(await set({ notify: 'all' }), 3, 'notify all: followed');
  t.eq(await set({ muted: true }), 1, 'muted: muted');
  t.eq(await set({ muted: false }), 0, 'unmuted: back to the channel\'s setting');
  t.eq(await set({ notify: 'none' }), 1, 'notify none: muted');
  t.eq(await set({ notify: 'mentions' }), 0, 'notify mentions: the channel\'s setting');
  await set({ notify: 'all' });
  t.eq(await set({ muted: false }), 3, 'unmuting a followed topic leaves it followed ("only the fields given change")');
  await set({ notify: 'mentions' });
});

check('cmd.threadState', async (t) => {
  const { conv, topic, first } = await freshTopic(t, 'state');
  let from = t.mark();
  const r = await t.cmd({ t: 'threadState', conversation: conv, archived: true });
  const done = topicId(G(), `✔ ${topic}`);
  t.eq((await raw(first)).subject, `✔ ${topic}`, 'resolved on the server');
  const f = await t.event('the resolved topic', isConv(done), from);
  t.eq(f?.conversation.archived, true, 'archived');
  await t.event('its message, moved', (x) => isMsg(first)(x) && x.message.conversation === done && x.message.moved === true, from);
  t.ok(r && r.thread?.archived === true, 'answers the About as it now stands (threads.ts), archived', r);
  from = t.mark();
  await t.cmd({ t: 'threadState', conversation: done, archived: false });
  t.eq((await raw(first)).subject, topic, 'unresolved on the server');
  await t.event('its message, moved back', (x) => isMsg(first)(x) && x.message.conversation === conv && x.message.moved === true, from);
  await t.refuses({ t: 'threadState', conversation: conv, locked: true }, 'locking a topic');
});

check('cmd.mute', async (t) => {
  const c = await ownChannel();
  const id = await say(ann, { stream: c.id, topic: 'mute' }, 'A topic to mute.');
  await t.event('the message', isMsg(id), 0);
  const conv = topicId(c.id, 'mute');
  let from = t.mark();
  let r = await t.cmd({ t: 'mute', target: { kind: 'conversation', nativeId: chan(c.id) }, muted: true });
  t.eq((await subOf(c.id))?.is_muted, true, 'the channel is muted on the server');
  await t.event('the channel, muted', (x) => isConv(chan(c.id))(x) && x.conversation.mute?.muted === true, from);
  t.eq(r, { muted: true }, 'answers the NativeMute as it now stands (attention.ts)');
  // In a muted channel, unmuting a topic is Zulip's "unmuted" policy.
  r = await t.cmd({ t: 'mute', target: { kind: 'conversation', nativeId: conv }, muted: false });
  t.eq(await policyOf(c.id, 'mute'), 2, 'a topic unmuted in a muted channel');
  await t.event('the topic, not muted', (x) => isConv(conv)(x) && !x.conversation.mute?.muted, from);
  from = t.mark();
  r = await t.cmd({ t: 'mute', target: { kind: 'conversation', nativeId: chan(c.id) }, muted: false });
  t.eq((await subOf(c.id))?.is_muted, false, 'the channel is unmuted on the server');
  await t.event('the channel, unmuted', (x) => isConv(chan(c.id))(x) && !x.conversation.mute?.muted, from);
  t.eq(r, {}, 'answers {} when nothing is set');
  from = t.mark();
  r = await t.cmd({ t: 'mute', target: { kind: 'conversation', nativeId: conv }, muted: true });
  t.eq(await policyOf(c.id, 'mute'), 1, 'the topic is muted on the server');
  await t.event('the topic, muted', (x) => isConv(conv)(x) && x.conversation.mute?.muted === true, from);
  t.eq(r, { muted: true }, 'answers the topic\'s NativeMute');
  await t.cmd({ t: 'mute', target: { kind: 'conversation', nativeId: conv }, muted: false });
  t.eq(await policyOf(c.id, 'mute'), 0, 'and unmuted');
  await t.refuses({ t: 'mute', target: { kind: 'conversation', nativeId: dmId(quinn, ann) }, muted: true }, 'muting a direct conversation');
  await t.refuses({ t: 'mute', target: { kind: 'space', nativeId: HOST }, muted: true }, 'muting the organization');
});

check('cmd.pollCreate-and-vote', async (t) => {
  const { conv } = await freshTopic(t, 'poll out');
  let from = t.mark();
  const r = await t.cmd({ t: 'pollCreate', conversation: conv, poll: { question: 'Tea or coffee?', options: ['Tea', 'Coffee', 'Water'], multi: true } });
  const id = sentId(r);
  if (!t.ok(id, 'answers the poll\'s message', r)) return;
  const m = await t.event('the poll', (x) => isMsg(id)(x) && !!x.message.extra?.poll, from);
  t.eq(m?.message.extra?.poll, { question: 'Tea or coffee?', options: [{ id: 'canned,0', text: 'Tea' }, { id: 'canned,1', text: 'Coffee' }, { id: 'canned,2', text: 'Water' }], multi: true, counts: { 'canned,0': 0, 'canned,1': 0, 'canned,2': 0 }, voters: 0, mine: [] }, 'the poll as made');
  const votes = async () => {
    const tally: Record<string, number> = {};
    for (const s of (await raw(id)).submessages as any[]) {
      const d = JSON.parse(s.content);
      if (d.type === 'vote' && s.sender_id === quinn.userId) tally[d.key] = (tally[d.key] ?? 0) + d.vote;
    }
    return Object.entries(tally).filter(([, v]) => v > 0).map(([k]) => k).sort();
  };
  from = t.mark();
  await t.cmd({ t: 'pollVote', conversation: conv, message: mid(id), options: ['canned,0'] });
  t.eq(await votes(), ['canned,0'], 'a vote, on the server');
  const u = await t.event('pollUpdate', (x) => x.t === 'pollUpdate' && x.message === mid(id) && !!x.mine?.includes('canned,0'), from);
  t.eq(u && [u.counts, u.mine, u.voters], [{ 'canned,0': 1, 'canned,1': 0, 'canned,2': 0 }, ['canned,0'], 1], 'counted');
  from = t.mark();
  await t.cmd({ t: 'pollVote', conversation: conv, message: mid(id), options: ['canned,1', 'canned,2'] });
  t.eq(await votes(), ['canned,1', 'canned,2'], 'changed to two others, on the server');
  const u2 = await t.event('pollUpdate after the change', (x) => x.t === 'pollUpdate' && x.message === mid(id) && Bun.deepEquals(x.mine, ['canned,1', 'canned,2']), from);
  t.eq(u2?.counts, { 'canned,0': 0, 'canned,1': 1, 'canned,2': 1 }, 'counted');
  from = t.mark();
  await t.cmd({ t: 'pollVote', conversation: conv, message: mid(id), options: [] });
  t.eq(await votes(), [], 'taken back, on the server');
  const u3 = await t.event('pollUpdate after taking it back', (x) => x.t === 'pollUpdate' && x.message === mid(id) && x.mine?.length === 0, from);
  t.eq(u3 && [u3.counts, u3.voters], [{ 'canned,0': 0, 'canned,1': 0, 'canned,2': 0 }, 0], 'nobody voted');
  await t.refuses({ t: 'pollVote', conversation: conv, message: mid(M.plain), options: ['canned,0'] }, 'voting on a message that is no poll');
  await t.refuses({ t: 'pollCreate', conversation: conv, poll: { question: 'One only?', options: ['A', 'B'], multi: false } }, 'a single-choice poll (Zulip\'s polls always take several choices)');
});

check('cmd.save', async (t) => {
  const { conv, first } = await freshTopic(t, 'save');
  let from = t.mark();
  let r = await t.cmd({ t: 'save', conversation: conv, message: mid(first) });
  t.ok((await raw(first)).flags.includes('starred'), 'starred on the server');
  const s = await t.event('saved', (x) => x.t === 'saved' && x.saved.some((f: any) => f.message === mid(first)), from);
  t.eq(s?.saved.find((f: any) => f.message === mid(first))?.conversation, conv, 'with its conversation');
  t.eq(r?.message, mid(first), 'answers the SavedFact (sending.ts)');
  from = t.mark();
  r = await t.cmd({ t: 'save', conversation: conv, message: mid(first), remove: true });
  t.ok(!(await raw(first)).flags.includes('starred'), 'unstarred on the server');
  await t.event('unsaved', (x) => x.t === 'unsaved' && x.message === mid(first), from);
  // With a time: Zulip's reminder.
  const dueAt = (Math.floor(Date.now() / 1000) + 3600) * 1000;
  from = t.mark();
  r = await t.cmd({ t: 'save', conversation: conv, message: mid(first), dueAt });
  const mine = ((await rest(quinn, 'GET', '/reminders')).reminders as any[]).filter((x) => x.reminder_target_message_id === first);
  t.eq(mine.map((x) => x.scheduled_delivery_timestamp * 1000), [dueAt], 'a reminder on the server at that time');
  const s2 = await t.event('saved with the reminder', (x) => x.t === 'saved' && x.saved.some((f: any) => f.message === mid(first) && f.dueAt === dueAt), from);
  t.eq(s2?.saved.find((f: any) => f.message === mid(first))?.conversation, conv, 'with its conversation');
  t.eq(r && [r.message, r.dueAt], [mid(first), dueAt], 'answers the SavedFact with its time');
  from = t.mark();
  await t.cmd({ t: 'save', conversation: conv, message: mid(first), remove: true });
  t.eq(((await rest(quinn, 'GET', '/reminders')).reminders as any[]).filter((x) => x.reminder_target_message_id === first).length, 0, 'the reminder is gone from the server');
  await t.event('saved again without it, or unsaved', (x) => (x.t === 'saved' && x.complete && !x.saved.some((f: any) => f.message === mid(first))) || (x.t === 'unsaved' && x.message === mid(first)), from);
});

check('cmd.savedList', async (t) => {
  const from = t.mark();
  const r = await t.cmd({ t: 'savedList' });
  const starred = ((await rest(quinn, 'GET', '/messages', { anchor: 'newest', num_before: 100, num_after: 0, narrow: [{ operator: 'is', operand: 'starred' }] })).messages as any[]).map((m) => m.id);
  t.ok(starred.includes(M.starred), 'the seeded star is on the server');
  t.ok(Array.isArray(r?.saved) && typeof r.more === 'boolean', 'answers { saved, more } (sending.ts SavedListResult)', r);
  for (const id of starred) t.ok(t.heard(isMsg(id), from).length === 1, `starred ${id} is said`);
  const s = t.heard((x) => x.t === 'saved' && x.complete === true, from).pop();
  t.eq(starred.filter((id) => !s?.saved.some((f: any) => f.message === mid(id) && f.conversation)), [], 'and the saved list names each with its conversation');
});

check('cmd.nativeScheduled', async (t) => {
  const due = Math.floor(Date.now() / 1000) + 7200;
  const made = (await rest(quinn, 'POST', '/scheduled_messages', { type: 'direct', to: [ann.userId], content: `Scheduled by the driver ${RUN}, for @**all**.`, scheduled_delivery_timestamp: due })).scheduled_message_id as number;
  await t.settled();
  const r = await t.cmd({ t: 'nativeScheduled' });
  t.eq(r?.enabled, true, 'enabled');
  const seededOne = (r?.scheduled ?? []).find((s: any) => s.nativeId === String(creds.scheduledMessageId));
  const server = ((await rest(quinn, 'GET', '/scheduled_messages')).scheduled_messages as any[]).find((s) => s.scheduled_message_id === creds.scheduledMessageId);
  if (server) t.eq(seededOne, { nativeId: String(creds.scheduledMessageId), conversation: topicId(CH.design, server.topic), body: 'Reminder: final colors are due today.', dueAt: server.scheduled_delivery_timestamp * 1000 }, 'the seeded one, in its topic');
  t.eq((r?.scheduled ?? []).find((s: any) => s.nativeId === String(made)), { nativeId: String(made), conversation: dmId(quinn, ann), body: `Scheduled by the driver ${RUN}, for @everyone.`, dueAt: due * 1000 }, 'one for a direct conversation');
  await t.cmd({ t: 'cancelScheduled', nativeId: String(made) });
  t.ok(!((await rest(quinn, 'GET', '/scheduled_messages')).scheduled_messages as any[]).some((s) => s.scheduled_message_id === made), 'cancelled on the server');
  await t.refuses({ t: 'cancelScheduled', nativeId: 'abc' }, 'cancelling nonsense');
});

check('cmd.setPresence', async (t) => {
  const status = async () => (await rest(quinn, 'GET', `/users/${quinn.userId}/status`)).status;
  let from = t.mark();
  let r = await t.cmd({ t: 'setPresence', change: { status: { text: 'Heads down', emoji: '🌴' } } });
  let s = await status();
  t.eq([s.status_text, s.emoji_code, s.reaction_type], ['Heads down', '1f334', 'unicode_emoji'], 'text and emoji on the server');
  const st = await t.event('selfState with the status', (x) => x.t === 'selfState' && x.state.presence?.status?.text === 'Heads down', from);
  t.eq(st?.state.presence.status, { text: 'Heads down', emoji: '🌴' }, 'the status');
  t.eq(r?.status, { text: 'Heads down', emoji: '🌴' }, 'answers the OwnPresence as it now stands (self.ts)');
  r = await t.cmd({ t: 'setPresence', change: { status: { text: 'Party', emoji: ':partyparrot:' } } });
  s = await status();
  t.eq([s.status_text, s.emoji_name, s.reaction_type], ['Party', 'partyparrot', 'realm_emoji'], 'a custom emoji as :name:');
  from = t.mark();
  await t.cmd({ t: 'setPresence', change: { status: null } });
  s = await status();
  t.eq([s.status_text ?? '', s.emoji_name ?? ''], ['', ''], 'cleared on the server');
  await t.event('selfState without a status', (x) => x.t === 'selfState' && !x.state.presence?.status, from);
  from = t.mark();
  await t.cmd({ t: 'setPresence', change: { state: 'invisible' } });
  try {
    t.eq((await registered(['user_settings'])).user_settings.presence_enabled, false, 'invisible on the server');
    await t.event('selfState saying invisible', (x) => x.t === 'selfState' && x.state.presence?.state === 'invisible', from, 4000);
  } finally {
    from = t.mark();
    await t.cmd({ t: 'setPresence', change: { state: 'online' } });
    t.eq((await registered(['user_settings'])).user_settings.presence_enabled, true, 'visible again on the server');
  }
  await t.refuses({ t: 'setPresence', change: { state: 'dnd' } }, 'do not disturb');
});

check('cmd.ignore', async (t) => {
  const muted = async () => ((await registered(['muted_users'])).muted_users as any[]).map((m) => m.id);
  await restRaw(quinn, 'DELETE', `/users/me/muted_users/${cara.userId}`);
  await t.settled();
  let from = t.mark();
  let r = await t.cmd({ t: 'ignore', identity: uid(cara), ignored: true });
  t.ok((await muted()).includes(cara.userId), 'muted on the server');
  await t.event('ignored with Cara', (x) => x.t === 'ignored' && x.identities.includes(uid(cara)), from);
  t.eq(r, { ignored: true }, 'answers { ignored } (self.ts)');
  from = t.mark();
  r = await t.cmd({ t: 'ignore', identity: uid(cara), ignored: false });
  t.ok(!(await muted()).includes(cara.userId), 'unmuted on the server');
  await t.event('ignored without Cara', (x) => x.t === 'ignored' && !x.identities.includes(uid(cara)), from);
  t.eq(r, { ignored: false }, 'answers { ignored: false }');
});

check('cmd.walkMembers', async (t) => {
  const users = ((await rest(quinn, 'GET', '/users')).members as any[]).filter((u) => u.is_active);
  let from = t.mark();
  let r = await t.cmd({ t: 'walkMembers', space: HOST, query: 'a', limit: 50 });
  let ev = t.heard((x) => x.t === 'members' && x.source === 'walk', from)[0];
  const want = users.filter((u) => u.full_name.toLowerCase().startsWith('a') || (u.delivery_email ?? '').toLowerCase().startsWith('a')).map((u) => uid(u.user_id)).sort();
  t.eq(ev && [ev.space, ev.members.map((m: any) => m.who).sort()], [HOST, want], 'those whose name (or real address) starts with "a", said before the answer');
  t.eq(ev?.members.find((m: any) => m.who === uid(ann))?.roles, ['Administrator'], 'with their role');
  t.eq(r && [r.count, r.total], [want.length, ev?.total], 'the answer counts them, and its total is the event\'s');
  from = t.mark();
  r = await t.cmd({ t: 'walkMembers', space: HOST, query: 'user', limit: 50 });
  ev = t.heard((x) => x.t === 'members' && x.source === 'walk', from)[0];
  t.eq((ev?.members ?? []).map((m: any) => m.who), users.filter((u) => u.full_name.toLowerCase().startsWith('user')).map((u) => uid(u.user_id)), '"user" matches nobody by the stand-in addresses (user9@…) the API gives');
});

check('cmd.mentionables', async (t) => {
  const conv = topicId(CH.design, 'colors');
  const subs = (await rest(quinn, 'GET', `/streams/${CH.design}/members`)).subscribers as number[];
  const users = new Map<number, any>(((await rest(quinn, 'GET', '/users')).members as any[]).map((u) => [u.user_id, u]));
  const r = await t.cmd({ t: 'mentionables', conversation: conv, query: '', limit: 50 });
  if (!r) return;
  t.eq(r.people.map((p: any) => p.nativeId).sort(), subs.filter((u) => u !== quinn.userId && users.get(u)?.is_active).map((u) => uid(u)).sort(), 'the channel\'s people, without the account itself');
  const a = r.people.find((p: any) => p.nativeId === uid(ann));
  t.eq(a && [a.name, a.handle], [users.get(ann.userId).full_name, ann.email], 'by name, with the real address as handle (as the identity has it)');
  const g = (await rest(quinn, 'GET', '/user_groups')).user_groups.find((x: any) => x.id === creds.groups.designers);
  t.eq(r.roles?.find((x: any) => x.id === `${HOST}/g/${g.id}`), { id: `${HOST}/g/${g.id}`, name: 'designers', count: g.members.length }, 'the designers group');
  t.ok(!(r.roles ?? []).some((x: any) => x.name.startsWith('role:')), 'no system groups', r.roles);
  t.eq(r.everyone, true, '@everyone is offered in a channel');
  const b = await t.cmd({ t: 'mentionables', conversation: conv, query: 'bo', limit: 50 });
  t.eq(b?.people.map((p: any) => p.nativeId), [uid(bob)], 'by prefix');
  const one = await t.cmd({ t: 'mentionables', conversation: conv, query: '', limit: 1 });
  t.eq(one?.people.length, 1, 'at most the limit');
  const d = await t.cmd({ t: 'mentionables', conversation: dmId(quinn, ann), query: '', limit: 50 });
  t.eq(d && [d.people.map((p: any) => p.nativeId), !!d.everyone], [[uid(ann)], false], 'a direct conversation: the other person, no @everyone');
});

check('cmd.about', async (t) => {
  const users = ((await rest(quinn, 'GET', '/users')).members as any[]).filter((u) => u.is_active && !u.is_bot);
  const org = await t.cmd({ t: 'about', target: { kind: 'space', nativeId: HOST } });
  t.eq(org && [org.noun, org.fields.name.value, org.members.total, org.you.role], ['organization', (await registered(['realm'])).realm_name, users.length, 'Owner'], 'the organization');
  t.eq(org && [org.fields.name.canEdit, org.fields.topic.canEdit, org.you.rank], [true, true, 100], 'its owner may rename and describe it (the hub checks canEdit before it sends configure)');
  t.eq((org?.members.list ?? []).filter((m: any) => !t.heard((x) => x.t === 'identity' && x.identity.nativeId === m.id).length), [], 'identity facts for its members came first');
  t.eq(org?.members.list.find((m: any) => m.id === uid(dave))?.role, 'Guest', 'a guest\'s role');
  const folder = await t.cmd({ t: 'about', target: { kind: 'space', nativeId: `${HOST}/f/1` } });
  t.eq(folder && [folder.noun, folder.fields.name.value, folder.fields.name.canEdit], ['folder', 'Work', false], 'a folder');
  const ch = await t.cmd({ t: 'about', target: { kind: 'conversation', nativeId: chan(CH.design) } });
  const subs = (await rest(quinn, 'GET', `/streams/${CH.design}/members`)).subscribers as number[];
  t.eq(ch && [ch.noun, ch.fields.name.value, ch.fields.topic.value, ch.fields.joinRule.value, ch.fields.history.value, ch.fields.announceOnly?.value, ch.members.list.map((m: any) => m.id).sort(), ch.leaving?.can], ['channel', 'design', 'Colors, type and layout for the **new site**.', 'open', 'shared', false, subs.map((u) => uid(u)).sort(), true], 'a public channel');
  t.eq(ch && [ch.fields.name.canEdit, ch.fields.topic.canEdit, ch.fields.joinRule.canEdit], [true, true, true], 'an owner may change a channel\'s settings');
  const priv = await t.cmd({ t: 'about', target: { kind: 'conversation', nativeId: chan(CH['ops-private']) } });
  t.eq(priv && [priv.fields.joinRule.value, !!priv.leaving?.warning], ['invite', true], 'a private channel');
  const ann2 = await t.cmd({ t: 'about', target: { kind: 'conversation', nativeId: chan(CH.announce) } });
  t.eq(ann2?.fields.announceOnly?.value, true, 'an administrators-only channel is announceOnly');
  const tp = await t.cmd({ t: 'about', target: { kind: 'conversation', nativeId: topicId(CH['ops-private'], 'incident') } });
  t.eq(tp && [tp.noun, tp.fields.name.value, tp.thread.archived, tp.thread.joined, tp.thread.canArchive], ['topic', 'incident', false, true, true], 'a followed topic');
  const res = (await rest(quinn, 'GET', `/users/me/${CH.design}/topics`)).topics.find((x: any) => x.name.startsWith('✔ '));
  const rt = await t.cmd({ t: 'about', target: { kind: 'conversation', nativeId: topicId(CH.design, res.name) } });
  t.eq(rt && [rt.fields.name.value, rt.thread.archived], [res.name, true], 'a resolved topic');
  const dm = await t.cmd({ t: 'about', target: { kind: 'conversation', nativeId: dmId(quinn, ann) } });
  t.eq(dm && [dm.noun, dm.members.list.map((m: any) => m.id).sort(), dm.leaving?.can], ['conversation', [uid(quinn), uid(ann)].sort(), false], 'a direct conversation');
  const gr = await t.cmd({ t: 'about', target: { kind: 'conversation', nativeId: dmId(quinn, ann, bob) } });
  t.eq(gr && [gr.noun, gr.members.total, gr.adding?.can], ['group conversation', 3, false], 'a group conversation');
});

check('cmd.configure-channel', async (t) => {
  const c = await ownChannel();
  const target = { kind: 'conversation', nativeId: chan(c.id) };
  let from = t.mark();
  let r = await t.cmd({ t: 'configure', target, change: { key: 'name', value: `${c.name}-x` } });
  t.eq((await streamOf(c.id)).name, `${c.name}-x`, 'renamed on the server');
  await t.event('the channel with its new name', (x) => isConv(chan(c.id))(x) && x.conversation.name === `${c.name}-x`, from);
  t.eq(r?.fields?.name?.value, `${c.name}-x`, 'answers the About with the new name');
  from = t.mark();
  r = await t.cmd({ t: 'configure', target, change: { key: 'topic', value: 'A description set by the hub.' } });
  t.eq((await streamOf(c.id)).description, 'A description set by the hub.', 'described on the server');
  await t.event('the channel with its new description', (x) => isConv(chan(c.id))(x) && x.conversation.topic === 'A description set by the hub.', from);
  t.eq(r?.fields?.topic?.value, 'A description set by the hub.', 'answers the About with it');
  r = await t.cmd({ t: 'configure', target, change: { key: 'joinRule', value: 'invite' } });
  t.eq([(await streamOf(c.id)).invite_only, r?.fields?.joinRule?.value], [true, 'invite'], 'made private');
  r = await t.cmd({ t: 'configure', target, change: { key: 'history', value: 'joined' } });
  t.eq([(await streamOf(c.id)).history_public_to_subscribers, r?.fields?.history?.value], [false, 'joined'], 'history only since joining');
  r = await t.cmd({ t: 'configure', target, change: { key: 'history', value: 'shared' } });
  t.eq([(await streamOf(c.id)).history_public_to_subscribers, r?.fields?.history?.value], [true, 'shared'], 'history shared');
  r = await t.cmd({ t: 'configure', target, change: { key: 'joinRule', value: 'open' } });
  t.eq([(await streamOf(c.id)).invite_only, r?.fields?.joinRule?.value], [false, 'open'], 'made public');
  r = await t.cmd({ t: 'configure', target, change: { key: 'announceOnly', value: true } });
  t.eq([(await streamOf(c.id)).can_send_message_group, r?.fields?.announceOnly?.value], [creds.groups['role:administrators'], true], 'only administrators post');
  t.eq((await restRaw(cara, 'POST', '/messages', { type: 'stream', to: c.id, topic: 'x', content: 'May I?' })).status >= 400, true, 'and a member cannot');
  r = await t.cmd({ t: 'configure', target, change: { key: 'announceOnly', value: false } });
  t.eq(r?.fields?.announceOnly?.value, false, 'everyone posts again');
  await t.cmd({ t: 'configure', target, change: { key: 'name', value: c.name } });
  await t.refuses({ t: 'configure', target, change: { key: 'slowMode', value: 5 } }, 'a setting Zulip has not');
});

check('cmd.configure-topic', async (t) => {
  const { conv, topic, first } = await freshTopic(t, 'retitle');
  const next = `${topic} renamed`;
  const from = t.mark();
  const r = await t.cmd({ t: 'configure', target: { kind: 'conversation', nativeId: conv }, change: { key: 'name', value: next } });
  t.eq((await raw(first)).subject, next, 'renamed on the server');
  await t.event('the message, moved', (x) => isMsg(first)(x) && x.message.conversation === topicId(G(), next) && x.message.moved === true, from);
  await t.event('the new topic', (x) => isConv(topicId(G(), next))(x) && x.conversation.name === next, from);
  t.eq(r?.fields?.name?.value, next, 'answers the About of the topic as renamed');
});

check('cmd.configure-org', async (t) => {
  const was = await registered(['realm']);
  const target = { kind: 'space', nativeId: HOST };
  let from = t.mark();
  try {
    const r = await t.cmd({ t: 'configure', target, change: { key: 'name', value: `${was.realm_name} ${RUN}` } });
    t.eq((await registered(['realm'])).realm_name, `${was.realm_name} ${RUN}`, 'renamed on the server');
    await t.event('the organization with its new name', (x) => x.t === 'space' && x.space.nativeId === HOST && x.space.name === `${was.realm_name} ${RUN}`, from);
    t.eq(r?.fields?.name?.value, `${was.realm_name} ${RUN}`, 'answers the About');
    from = t.mark();
    await t.cmd({ t: 'configure', target, change: { key: 'topic', value: `Described by the hub ${RUN}.` } });
    t.eq((await registered(['realm'])).realm_description, `Described by the hub ${RUN}.`, 'described on the server');
    await t.event('the organization with its description', (x) => x.t === 'space' && x.space.nativeId === HOST && x.space.topic === `Described by the hub ${RUN}.`, from);
  } finally {
    await rest(quinn, 'PATCH', '/realm', { name: was.realm_name });
    await rest(quinn, 'PATCH', '/realm', { description: was.realm_description });
  }
  await t.settled();
  const last = t.heard((x) => x.t === 'space' && x.space.nativeId === HOST).pop();
  t.eq([last?.space.name, last?.space.topic ?? ''], [was.realm_name, was.realm_description], 'put back elsewhere, the organization as last said is as it is');
});

check('cmd.profile', async (t) => {
  const p = await t.cmd({ t: 'profile', who: uid(ann) });
  if (!p) return;
  const u = (await rest(quinn, 'GET', `/users/${ann.userId}`, { include_custom_profile_fields: true })).user;
  t.eq([p.displayName, p.handle], [u.full_name, ann.email], 'name, and the real address as handle');
  t.eq(p.bio, 'Design lead. Ask me about **colors** and type.', 'the long text field is the bio');
  t.eq(p.pronouns, 'she/her', 'the pronouns field');
  t.eq(p.status, { text: 'Out until Monday', emoji: '🌴' }, 'her status');
  t.eq((p.links ?? []).map((l: any) => [l.label, l.value, l.url]).sort(), [['GitHub username', 'ann-example', 'https://github.com/ann-example'], ['Website', 'https://example.com/ann', 'https://example.com/ann']], 'links');
  t.ok((p.facts ?? []).some((f: any) => f.label === 'Role' && f.value === 'Administrator'), 'her role', p.facts);
  t.ok((p.facts ?? []).some((f: any) => f.label === 'Pronouns' && f.value === 'she/her'), 'the plain-text field named Pronouns is a fact', p.facts);
  t.eq(p.createdAt, Date.parse(u.date_joined), 'when she joined');
  t.ok(typeof p.avatar === 'string' && /^(zulip:\/|https:)/.test(p.avatar), 'a picture', p.avatar);
  t.ok(t.heard((x) => x.t === 'identity' && x.identity.nativeId === uid(ann)).length > 0, 'her identity is said');
  const me = await t.cmd({ t: 'profile', who: uid(quinn) });
  t.eq([...(me?.editable ?? [])].sort(), ['avatar', 'bio', 'emoji', 'name', 'pronouns'], 'the account\'s own profile says what it can change');
  const b = await t.cmd({ t: 'profile', who: uid(bot) });
  t.ok(b?.facts?.some((f: any) => f.label === 'Role' && f.value === 'Bot') && b.facts.some((f: any) => f.label === 'Owner'), 'a bot, with its owner', b?.facts);
});

check('cmd.setProfile', async (t) => {
  const me = async () => (await rest(quinn, 'GET', `/users/${quinn.userId}`, { include_custom_profile_fields: true })).user;
  const was = await me();
  let r = await t.cmd({ t: 'setProfile', change: { bio: `Bio from the hub ${RUN}.`, pronouns: 'they/them' } });
  let u = await me();
  t.eq([u.profile_data?.[fieldIds.About]?.value, u.profile_data?.[fieldIds['Pronouns (typed)']]?.value], [`Bio from the hub ${RUN}.`, 'they/them'], 'bio and pronouns on the server');
  t.eq(r && [r.bio, r.pronouns], [`Bio from the hub ${RUN}.`, 'they/them'], 'answers the PersonAbout as it now stands (adapter.ts setProfile)');
  r = await t.cmd({ t: 'setProfile', change: { bio: '', pronouns: '' } });
  u = await me();
  t.eq([u.profile_data?.[fieldIds.About]?.value ?? '', u.profile_data?.[fieldIds['Pronouns (typed)']]?.value ?? ''], ['', ''], 'cleared on the server');
  let from = t.mark();
  try {
    await t.cmd({ t: 'setProfile', change: { name: `${was.full_name} X` } });
    t.eq((await me()).full_name, `${was.full_name} X`, 'renamed on the server');
    await t.event('own identity with the new name', (x) => x.t === 'identity' && x.identity.nativeId === uid(quinn) && x.identity.displayName === `${was.full_name} X`, from);
  } finally {
    await rest(quinn, 'PATCH', '/settings', { full_name: was.full_name });
  }
  from = t.mark();
  const picBefore = t.heard((x) => x.t === 'identity' && x.identity.nativeId === uid(quinn)).pop()?.identity.avatarUrl;
  await t.cmd({ t: 'setProfile', change: { avatar: tmpFile(`face-${RUN}.png`, png([90, 20, 160])) } });
  const withPic = await me();
  t.ok(withPic.avatar_url !== was.avatar_url && /user_avatars/.test(withPic.avatar_url ?? ''), 'a new picture on the server', [was.avatar_url, withPic.avatar_url]);
  await t.event('own identity with the new picture', (x) => x.t === 'identity' && x.identity.nativeId === uid(quinn) && x.identity.avatarUrl !== undefined && x.identity.avatarUrl !== picBefore, from, 4000);
  await t.cmd({ t: 'setProfile', change: { emoji: '🌴' } });
  t.eq((await rest(quinn, 'GET', `/users/${quinn.userId}/status`)).status.emoji_code, '1f334', 'the status emoji on the server');
  await t.cmd({ t: 'setProfile', change: { emoji: '' } });
  await t.refuses({ t: 'setProfile', change: { username: 'quinn' } }, 'a username');
});

check('cmd.leave', async (t) => {
  const name = `drv-${RUN}-leave`;
  let from = t.mark();
  await rest(ann, 'POST', '/users/me/subscriptions', { subscriptions: [{ name }], principals: [quinn.userId, ann.userId], send_new_subscription_messages: false });
  const id = (await rest(ann, 'GET', '/get_stream_id', { stream: name })).stream_id as number;
  cleanups.push(() => restRaw(ann, 'DELETE', `/streams/${id}`));
  await t.event('the channel', isConv(chan(id)), from);
  const ab = await t.cmd({ t: 'about', target: { kind: 'conversation', nativeId: chan(id) } });
  t.eq(ab?.leaving?.can, true, 'About says it can be left');
  from = t.mark();
  const r = await t.cmd({ t: 'leave', target: { kind: 'conversation', nativeId: chan(id) } });
  const atReply = t.mark();
  t.eq(await subOf(id), undefined, 'left on the server');
  const e = await t.event('leave for the channel', (x) => x.t === 'leave' && x.kind === 'conversation' && x.nativeId === chan(id), from);
  t.ok(e && t.S.link.events.indexOf(e) < atReply, 'the leave event comes before the answer (servers.ts LeaveResult)');
  t.eq(r, { left: true }, 'answers { left: true }');
  await t.refuses({ t: 'leave', target: { kind: 'conversation', nativeId: dmId(quinn, ann) } }, 'leaving a direct conversation');
});

check('cmd.addMembers', async (t) => {
  const c = await ownChannel();
  const r = await t.cmd({ t: 'addMembers', target: { kind: 'conversation', nativeId: chan(c.id) }, people: [uid(cara), uid(ann)] });
  const subs = (await rest(quinn, 'GET', `/streams/${c.id}/members`)).subscribers as number[];
  t.ok(subs.includes(cara.userId), 'Cara is in the channel on the server', subs);
  t.eq(r?.added, [uid(cara)], 'answers who was added, as native ids (about.ts AddMembersResult)');
  const ab = await t.cmd({ t: 'about', target: { kind: 'conversation', nativeId: chan(c.id) } });
  t.ok(ab?.members.list.some((m: any) => m.id === uid(cara)), 'and About lists her at once', ab?.members.list.map((m: any) => m.id));
  await t.refuses({ t: 'addMembers', target: { kind: 'conversation', nativeId: dmId(quinn, ann) }, people: [uid(cara)] }, 'adding to a direct conversation');
});

check('cmd.resolve', async (t) => {
  const random = await streamOf(CH.random);
  const want = { what: 'channel', name: 'random', nativeId: chan(CH.random), description: 'Anything goes.', actions: ['join'] };
  const pick = (r: any) => r && { what: r.what, name: r.name, nativeId: r.nativeId, description: r.description, actions: r.actions };
  for (const [what, ref] of [
    ['a channel link', { kind: 'place', network: 'zulip', address: `${BASE}/#narrow/channel/${CH.random}-random` }],
    ['an old-style link', { kind: 'place', network: 'zulip', address: `${BASE}/#narrow/stream/${CH.random}-random/topic/cats` }],
    ['#name', { kind: 'name', network: 'zulip', name: '#random' }],
    ['#**name**', { kind: 'name', network: 'zulip', name: '#**random**' }],
  ] as [string, object][]) {
    const r = await t.cmd({ t: 'resolve', ref }, `resolve ${what}`);
    t.eq(pick(r), want, what);
    if (r && random.subscriber_count !== undefined) t.eq(r.members, random.subscriber_count, `${what}: its member count`);
    t.ok(r && !r.joined, `${what}: not joined`, r?.joined);
  }
  const joined = await t.cmd({ t: 'resolve', ref: { kind: 'name', network: 'zulip', name: '#design' } });
  t.eq(joined && [joined.joined, joined.actions], [{ conversation: chan(CH.design), space: HOST }, []], 'a channel the account is in');
  const p = await t.cmd({ t: 'resolve', ref: { kind: 'person', network: 'zulip', handle: bob.email } });
  t.eq(p && [p.what, p.nativeId, p.actions], ['person', uid(bob), ['message']], 'a person by email');
  await t.refuses({ t: 'resolve', ref: { kind: 'place', network: 'zulip', address: `https://other.example/#narrow/channel/${CH.random}-random` } }, 'a link to another server');
  await t.refuses({ t: 'resolve', ref: { kind: 'name', network: 'zulip', name: '#no-such-channel' } }, 'a channel that does not exist');
  await t.refuses({ t: 'resolve', ref: { kind: 'person', network: 'zulip', handle: 'nobody@example.com' } }, 'a person who does not exist');
});

check('cmd.add-join', async (t) => {
  t.eq(await subOf(CH.random), undefined, 'not in #random to begin with');
  const from = t.mark();
  try {
    const r = await t.cmd({ t: 'add', ref: { kind: 'place', network: 'zulip', address: `${BASE}/#narrow/channel/${CH.random}-random` }, action: 'join' });
    const atReply = t.mark();
    t.ok(await subOf(CH.random), 'subscribed on the server');
    t.eq(r && [r.space, r.conversation], [HOST, chan(CH.random)], 'answers the channel');
    const f = t.heard(isConv(chan(CH.random)), from)[0];
    t.ok(f && t.S.link.events.indexOf(f) < atReply && f.conversation.name === 'random', 'the channel is said before the answer', f);
    const tp = t.heard(isConv(topicId(CH.random, 'cats')), from)[0];
    t.ok(tp && t.S.link.events.indexOf(tp) < atReply && tp.conversation.lastMessageAt > 0, 'and its topics, with their times', tp);
    const id = await say(ann, { stream: CH.random, topic: 'cats' }, 'Welcome to random.');
    await t.event('a message there afterwards', isMsg(id), from);
  } finally {
    const f2 = t.mark();
    await restRaw(quinn, 'DELETE', '/users/me/subscriptions', { subscriptions: ['random'] });
    await t.event('leave when unsubscribed elsewhere', (x) => x.t === 'leave' && x.nativeId === chan(CH.random), f2);
  }
  await t.refuses({ t: 'add', ref: { kind: 'person', network: 'zulip', handle: bob.email }, action: 'friend' }, 'befriending someone');
});

check('cmd.action-resync', async (t) => {
  const { conv, topic } = await freshTopic(t, 'resync');
  const from = t.mark();
  await t.cmd({ t: 'action', action: 'resync' });
  await t.event('online again after a resync', isOnline, from, 20_000);
  const mark = t.mark();
  const id = await say(ann, { stream: G(), topic }, 'After the resync.');
  const e = await t.event('a live message after it', isMsg(id), mark);
  t.eq(e && [e.live, e.message.conversation], [true, conv], 'live, in its topic');
  await t.refuses({ t: 'action', action: 'no-such-action' }, 'an action it does not have');
});

// ================================================================ writing Zulip's Markdown

const mdTopic = () =>
  once('mdTopic', async () => {
    const topic = tn('markdown');
    await say(ann, { stream: G(), topic }, 'A topic for Markdown.');
    return { topic, conv: topicId(G(), topic) };
  });
const TS = 1764601200;
const U_ANN = () => `<@${uid(ann)}>`;
/** Hub body → [what Zulip must store (text or a pattern), what the echo's body must be (text, a pattern, or the same body)]. */
const MD_OUT: [string, () => string, (annName: string) => string | RegExp, (() => string | RegExp) | null][] = [
  ['mention', () => `Hi ${U_ANN()}!`, (n) => `Hi @**${n}|${ann.userId}**!`, null],
  ['channel-links', () => `See <#${topicId(CH.design, 'colors')}> and <#${chan(CH.design)}>.`, () => 'See #**design>colors** and #**design**.', null],
  ['time', () => `At <t:${TS}:F>.`, () => 'At <time:2025-12-01T15:00:00Z>.', null],
  ['spoiler', () => 'The butler ||did it|| indeed.', () => /^The butler ?\n```spoiler ?\ndid it\n```\n ?indeed\.$/, () => /^The butler ?\n\|\|did it\|\|\n ?indeed\.$/],
  ['spoiler-lines', () => '||line one\nline two||', () => '```spoiler\nline one\nline two\n```', null],
  ['underline', () => 'An __underlined__ word.', () => 'An *underlined* word.', () => 'An *underlined* word.'],
  ['code-fence', () => `\`\`\`\n${U_ANN()} ||x|| @everyone <t:${TS}> __u__ :smile:\n\`\`\``, () => `\`\`\`\n${U_ANN()} ||x|| @everyone <t:${TS}> __u__ :smile:\n\`\`\``, null],
  ['code-span', () => `Use \`${U_ANN()}\` and \`@everyone\` and \`||x||\`.`, () => `Use \`${U_ANN()}\` and \`@everyone\` and \`||x||\`.`, null],
  ['everyone', () => '@everyone hello', () => '@**all** hello', null],
  ['here', () => 'Listen @here now', () => 'Listen @**topic** now', null],
  ['not-everyone', () => 'Write to someone@everyone.example or me@here.example.', () => 'Write to someone@everyone.example or me@here.example.', null],
  ['group', () => `<@&${HOST}/g/${creds.groups.designers}> look`, () => '@*designers* look', null],
  ['emoji', () => 'Nice 👍 and ❤️', () => 'Nice 👍 and ❤️', null],
  // An emoji name typed in words is an emoji in Zulip (its Markdown has no escape for it), and reads back as one.
  ['literal-emoji-name', () => 'The setting is called :smile: here', () => /^The setting is called :smile: here$/, () => 'The setting is called 😄 here'],
];
for (const [name, body, wantRaw, wantEcho] of MD_OUT)
  check(`md.out.${name}`, async (t) => {
    const { conv } = await mdTopic();
    const annName = (await rest(quinn, 'GET', `/users/${ann.userId}`)).user.full_name as string;
    const from = t.mark();
    const r = await t.cmd({ t: 'send', conversation: conv, body: body() });
    const id = sentId(r);
    if (!id) return;
    const e = await t.event('the echo', isMsg(id), from);
    const src = (await raw(id)).content as string;
    const wr = wantRaw(annName);
    t.ok(typeof wr === 'string' ? src === wr : wr.test(src), `Zulip stores ${typeof wr === 'string' ? JSON.stringify(wr) : wr}`, src);
    const we = wantEcho ? wantEcho() : body();
    t.ok(typeof we === 'string' ? e?.message.body === we : we.test(e?.message.body ?? ''), `the body comes back as ${typeof we === 'string' ? JSON.stringify(we) : we}`, e?.message.body);
  });

check('md.out.zulip-renders-it', async (t) => {
  // What the hub's Markdown means must be what Zulip shows: its own renderer decides.
  const render = async (body: string) => {
    const { toZulip } = await import('../src/markdown.ts');
    const z = toZulip(body, t.S.a.mdCtx());
    return [z, (await rest(quinn, 'POST', '/messages/render', { content: z })).rendered as string];
  };
  for (const [what, body, want] of [
    ['*italic*', '*leaning*', /<em>leaning<\/em>/],
    ['_italic_ (Discord also writes italics so)', '_slanted_', /<em>slanted<\/em>/],
    ['**bold**', '**heavy**', /<strong>heavy<\/strong>/],
    ['***bold italic***', '***both***', /<strong><em>both<\/em><\/strong>|<em><strong>both<\/strong><\/em>/],
    ['~~strike~~', '~~gone~~', /<del>gone<\/del>/],
    ['> quote', '> said', /<blockquote>\s*<p>said<\/p>/],
    ['a link', '[text](https://example.com/x)', /<a href="https:\/\/example\.com\/x">text<\/a>/],
    ['<@id> in a quote', `> ${U_ANN()} said`, /user-mention/],
    ['a spoiler', 'a ||b|| c', /spoiler-block/],
    ['a list after a line (Zulip wants no blank line, as Discord)', 'Things:\n- one\n- two', /<ul>\s*<li>one<\/li>/],
    ['a heading', '# Title', /<h1>Title<\/h1>/],
  ] as [string, string, RegExp][]) {
    const [z, html] = await render(body);
    t.ok(want.test(html), `${what}: ${JSON.stringify(body)} is sent as ${JSON.stringify(z)}, which Zulip shows as wanted`, html);
  }
});

// ---------------------------------------------------------------- reading, what the web client and people write

const seededUpload = async () => ((await raw(M.image)).content as string).match(/\]\((\/user_uploads\/[^)]+)\)/)![1];
const MD_IN: [string, (up: string, annName: string) => string, (up: string) => { body?: string | RegExp; attachments?: number; replyTo?: string; kind?: string }][] = [
  ['web-image-syntax', (up) => `![pic.png](${up})`, () => ({ body: '', attachments: 1, kind: 'media' })],
  ['web-image-with-words', (up) => `Look at this:\n![pic.png](${up})\nNice, no?`, () => ({ body: 'Look at this:\nNice, no?', attachments: 1 })],
  ['upload-in-a-sentence', (up) => `See [the sketch](${up}) please.`, () => ({ body: 'See the sketch please.', attachments: 1 })],
  ['upload-absolute-link', (up) => `[pic.png](${BASE}${up})`, () => ({ body: '', attachments: 1 })],
  ['quote-from-another-topic', (_u, n) => `@_**${n}|${ann.userId}** [said](${BASE}/#narrow/channel/${G()}-general/topic/mentions/near/${M.quoted}) in #**general>mentions@${M.quoted}**:\n\`\`\`quote\nNotes from the meeting are in the shared folder.\n\`\`\`\nMy take on it.`, () => ({ body: 'My take on it.', replyTo: mid(M.quoted) })],
  ['quote-from-a-direct-message', (_u, n) => `@_**${n}|${ann.userId}** [said](${BASE}/#narrow/dm/${quinn.userId},${ann.userId}-dm/near/${M.dmRead}) to @_**Quinn Park|${quinn.userId}**:\n\`\`\`quote\nHi Quinn, are you free for a call tomorrow?\n\`\`\`\nAnswering here.`, () => ({ body: 'Answering here.', replyTo: mid(M.dmRead) })],
  ['tilde-quote', () => '~~~quote\nline one\nline two\n~~~\nafter', () => ({ body: '> line one\n> line two\nafter' })],
  ['spoiler-in-quote', () => '````quote\n```spoiler Twist\nIt was a dream.\n```\n````', () => ({ body: '> **Twist** ||It was a dream.||' })],
  ['mention-in-code', () => 'Type `@**Quinn Park**` to ping, and `:smile:` for a smile.', () => ({ body: 'Type `@**Quinn Park**` to ping, and `:smile:` for a smile.' })],
  ['me-message', () => '/me waves', () => ({ body: /^\*.+\* waves$/ })],
  ['silent-group-mention', () => 'Ask @_*designers* later.', () => ({ body: `Ask <@&${HOST}/g/${creds.groups.designers}> later.` })],
  ['mention-of-nobody', () => 'Thanks @**Ghost|99999**.', () => ({ body: 'Thanks @Ghost.' })],
  ['time-with-offset', () => 'At <time:2026-12-01T10:00:00-05:00>.', () => ({ body: `At <t:${Date.parse('2026-12-01T15:00:00Z') / 1000}:F>.` })],
  ['channel-link-to-message', () => `As said in #**general>mentions@${M.quoted}**.`, () => ({ body: `As said in <#${topicId(G(), 'mentions')}>.` })],
  ['math-block', () => '```math\n\\int_0^1 x\\,dx\n```', () => ({ body: '```math\n\\int_0^1 x\\,dx\n```' })],
  ['windows-newlines', () => 'one\r\ntwo', () => ({ body: 'one\ntwo' })],
];
for (const [name, text, want] of MD_IN)
  check(`md.in.live.${name}`, async (t) => {
    const { topic } = await mdTopic();
    const up = await seededUpload();
    const annName = (await rest(quinn, 'GET', `/users/${ann.userId}`)).user.full_name as string;
    const from = t.mark();
    const id = await say(ann, { stream: G(), topic }, text(up, annName));
    const e = await t.event('the message', isMsg(id), from);
    if (!e) return;
    const w = want(up);
    if (w.body !== undefined) t.ok(typeof w.body === 'string' ? e.message.body === w.body : w.body.test(e.message.body), `body is ${typeof w.body === 'string' ? JSON.stringify(w.body) : w.body}`, e.message.body);
    if (w.attachments !== undefined) t.eq((e.message.attachments ?? []).map((a: any) => a.url), Array(w.attachments).fill(`zulip:${up}`), 'its attachment');
    if ('replyTo' in w) t.eq(e.message.replyTo, w.replyTo, 'replyTo');
    if (w.kind) t.eq(e.message.kind, w.kind, 'kind');
  });

// ================================================================ robustness

/** Holds the extractor's next POST /register until released; `asked` resolves when it tries. */
function holdRegister() {
  let release!: () => void;
  let sawIt!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const asked = new Promise<void>((r) => (sawIt = r));
  const hook = async (url: string) => {
    if (url.endsWith('/api/v1/register')) {
      sawIt();
      await gate;
    }
  };
  hooks.push(hook);
  return {
    asked,
    release: () => {
      hooks.splice(hooks.indexOf(hook), 1);
      release();
    },
  };
}

check('robust.queue-deleted', async (t) => {
  // Things heard before the gap, to be changed during it.
  const topic = tn('gap');
  const conv = topicId(G(), topic);
  const toEdit = await say(ann, { stream: G(), topic }, 'To be edited in the gap.');
  const toDelete = await say(ann, { stream: G(), topic }, 'To be deleted in the gap.');
  const toReact = await say(ann, { stream: G(), topic }, 'To be reacted to in the gap.');
  await t.event('read: 3 unread before the gap', isRead(conv, 3), 0);
  const other = tn('gap read');
  const toRead = await say(ann, { stream: G(), topic: other }, 'To be read elsewhere in the gap.');
  await t.event('read: 1 unread in the other topic', isRead(topicId(G(), other), 1), 0);
  const queue = (t.S.a as any).queue as { id: string } | null;
  if (!t.ok(queue?.id, 'the extractor has an event queue')) return;
  const hold = holdRegister();
  const from = t.mark();
  let m1 = 0;
  let m2 = 0;
  try {
    await rest(quinn, 'DELETE', '/events', { queue_id: queue!.id });
    const tried = await Promise.race([hold.asked.then(() => true), Bun.sleep(20_000).then(() => false)]);
    t.ok(tried, 'with its queue deleted on the server, the extractor registers again');
    // The gap: nothing is heard now.
    m1 = await say(ann, { stream: G(), topic }, 'Sent in the gap, to the topic.');
    m2 = await say(ann, { dm: [quinn] }, 'Sent in the gap, directly.');
    await rest(ann, 'PATCH', `/messages/${toEdit}`, { content: 'Edited in the gap.' });
    await rest(ann, 'DELETE', `/messages/${toDelete}`);
    await rest(bob, 'POST', `/messages/${toReact}/reactions`, { emoji_name: 'tada' });
    await rest(quinn, 'POST', '/messages/flags', { messages: [toRead], op: 'add', flag: 'read' });
  } finally {
    hold.release();
  }
  await t.event('online again', isOnline, from, 30_000);
  const end = t.mark();
  const after = (t.S.link.events as Ev[]).slice(from, end);
  for (const [what, id, c] of [['the topic message', m1, conv], ['the direct message', m2, dmId(quinn, ann)]] as [string, number, string][]) {
    const said = after.filter(isMsg(id));
    t.eq(said.length, 1, `${what} sent in the gap is said once`);
    t.eq(said[0] && [said[0].message.conversation, said[0].live, said[0].late], [c, false, true], `${what}: caught up, not live, but late news`);
  }
  t.ok(after.some((e) => isMsg(toEdit)(e) && e.message.body === 'Edited in the gap.' && e.message.editedTs), 'the edit made in the gap is said');
  t.ok(after.some((e) => isMsg(toReact)(e) && e.message.reactions.some((r: any) => r.key === '🎉' && r.authors.includes(uid(bob)))), 'the reaction made in the gap is said');
  t.ok(after.some((e) => e.t === 'delete' && e.nativeId === mid(toDelete)), 'the delete made in the gap is said (else the hub keeps a message that is gone)');
  const r = after.filter(isRead(conv)).pop();
  t.eq(r && [r.unread], [3], 'the topic\'s unread count after the gap is the server\'s (3: two left and one new)');
  const r2 = after.filter(isRead(topicId(G(), other))).pop();
  t.eq(r2?.unread, 0, 'what was read elsewhere in the gap is read');
  const dup = new Map<string, number>();
  for (const e of after) if (e.t === 'message') dup.set(e.message.nativeId, (dup.get(e.message.nativeId) ?? 0) + 1);
  t.eq([...dup].filter(([, n]) => n > 1), [], 'no message is said twice in the catch-up');
  // And live again.
  const live = await say(ann, { stream: G(), topic }, 'After the gap.');
  const e = await t.event('a live message after the gap', isMsg(live), end);
  t.eq(e?.live, true, 'live');
});

check('robust.network-drop', async (t) => {
  const topic = tn('outage');
  await say(ann, { stream: G(), topic }, 'Before the outage.');
  await t.settled();
  let drops = 0;
  const hook = (url: string) => {
    if (url.includes('/api/v1/events') && drops < 1) {
      drops++;
      throw new TypeError('connection reset (the driver)');
    }
  };
  const from = t.mark();
  hooks.push(hook);
  try {
    // The poll in flight returns when something happens; the next one fails.
    const id0 = await say(ann, { stream: G(), topic }, 'Just before the connection drops.');
    await t.event('the message before the drop', isMsg(id0), from);
    const bad = await t.event('a status that is not online', (x) => x.t === 'status' && x.status !== 'online', from, 15_000);
    t.eq(bad && [bad.status, bad.attention ?? null], ['error', null], 'a dropped connection is an error, not a call for the owner');
    const id = await say(ann, { stream: G(), topic }, 'During the outage.');
    await t.event('online again', isOnline, t.S.link.events.indexOf(bad as any) + 1, 30_000);
    await t.event('the message sent meanwhile', isMsg(id), from, 10_000);
  } finally {
    hooks.splice(hooks.indexOf(hook), 1);
  }
});

check('robust.rate-limit-retry', async (t) => {
  // The server's own 429, played once to one send: waited out, sent once.
  const { conv, topic } = await freshTopic(t, 'limit');
  let played = 0;
  const hook = (url: string, init: RequestInit) => {
    if (url.endsWith('/api/v1/messages') && init.method === 'POST' && played === 0) {
      played++;
      return new Response(JSON.stringify({ result: 'error', msg: 'API usage exceeded rate limit', code: 'RATE_LIMIT_HIT', 'retry-after': 1.5 }), { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '1.5', 'X-RateLimit-Remaining': '0' } });
    }
  };
  hooks.push(hook);
  const from = t.mark();
  const t0 = Date.now();
  try {
    const r = await t.cmd({ t: 'send', conversation: conv, body: `Through a 429, ${RUN}.` });
    t.ok(sentId(r), 'the send succeeds after the wait', r);
    t.ok(Date.now() - t0 >= 1400, 'having waited as Retry-After said', Date.now() - t0);
  } finally {
    hooks.splice(hooks.indexOf(hook), 1);
  }
  await t.settled();
  const mine = ((await rest(quinn, 'GET', '/messages', { anchor: 'newest', num_before: 10, num_after: 0, narrow: [{ operator: 'channel', operand: G() }, { operator: 'topic', operand: topic }], apply_markdown: false })).messages as any[]).filter((m) => m.content === `Through a 429, ${RUN}.`);
  t.eq(mine.length, 1, 'and the message is on the server once');
  t.eq(t.heard((x) => x.t === 'status' && x.status !== 'online', from).length, 0, 'the account stayed online');
});

check('robust.rate-limit-real', async (t) => {
  // Spend Quinn's 200 requests a minute for real, then ask the extractor to work.
  const { conv, topic } = await freshTopic(t, 'limit real');
  const auth = { Authorization: `Basic ${Buffer.from(`${quinn.email}:${quinn.apiKey}`).toString('base64')}` };
  let hit = false;
  for (let i = 0; i < 260 && !hit; i++) {
    const res = await fetch(`${BASE}/api/v1/users/me`, { headers: auth });
    hit = res.status === 429;
    await res.arrayBuffer();
  }
  if (!t.ok(hit, 'the sandbox limits requests (a 429 after ~200 in a minute)')) return;
  const from = t.mark();
  const t0 = Date.now();
  const r = await t.cmd({ t: 'send', conversation: conv, body: `Through the real limit, ${RUN}.` });
  t.ok(sentId(r), `a send during the limit succeeds once the window opens (${Date.now() - t0} ms)`, r);
  const id = await say(ann, { stream: G(), topic }, 'Said while Quinn was limited.');
  await t.event('events still arrive', isMsg(id), from, 90_000);
  await t.settled();
  const mine = ((await rest(quinn, 'GET', '/messages', { anchor: 'newest', num_before: 10, num_after: 0, narrow: [{ operator: 'channel', operand: G() }, { operator: 'topic', operand: topic }], apply_markdown: false })).messages as any[]).filter((m) => m.content === `Through the real limit, ${RUN}.`);
  t.eq(mine.length, 1, 'the message is on the server once');
  t.eq(t.heard((x) => x.t === 'status' && x.status !== 'online', from).map((x) => x.status), [], 'the account stayed online through it');
  t.eq(t.S.link.logs.filter((l) => l.level === 'warn' && /rate|429/.test(l.msg)).map((l) => l.msg), [], 'without dropping its event queue over a 429');
});

/**
 * A second extractor in its own process, started with a small window (the newest message only, one topic a channel),
 * as one is after the organization has grown past what a start reads: it sends into an old topic and says what it
 * told the hub.
 */
const smallStart = () =>
  once('smallStart', async () => {
    const topic = `Drv ${RUN} Old Case`;
    const first = await say(ann, { stream: CH.design, topic }, 'A topic with capitals.');
    await rest(quinn, 'POST', '/messages/flags', { messages: [first], op: 'add', flag: 'read' });
    // Newer activity, so the topic is neither the newest message nor its channel's newest topic.
    await rest(quinn, 'POST', '/messages', { type: 'stream', to: CH.design, topic: tn('newer'), content: 'Newer than the old topic.', read_by_sender: true });
    const child = Bun.spawn([process.execPath, import.meta.path, '--child-send', topicId(CH.design, topic), `Into the old topic, ${RUN}.`], { env: { ...process.env, DITHER_ZULIP_START_MESSAGES: '1', DITHER_ZULIP_START_TOPICS: '1' }, stdout: 'pipe', stderr: 'pipe' });
    const out = (await new Response(child.stdout).text()) + (await new Response(child.stderr).text());
    await child.exited;
    return { topic, out, sent: Number(out.match(/SENT (\d+)/)?.[1]) || 0, topics: Number(out.match(/TOPICS (\d+)/)?.[1]) || 0, noTime: (out.match(/NOTIME (.*)/)?.[1] ?? '').split('|').filter(Boolean) };
  });

check(
  'robust.restart-topic-case',
  async (t) => {
    // The hub remembers a topic by its id (lower case). An extractor started later, which has not read that topic
    // again, must still write into it under its name as written.
    const c = await smallStart();
    if (!t.ok(c.sent, 'a freshly started extractor sends into the old topic', c.out)) return;
    t.eq((await raw(c.sent)).subject, c.topic, 'the message is in the topic as it was written, not a lower-case twin');
    const names = ((await rest(quinn, 'GET', `/users/me/${CH.design}/topics`)).topics as any[]).filter((x) => x.name.toLowerCase() === c.topic.toLowerCase()).map((x) => x.name);
    t.eq(names, [c.topic], 'and Zulip still shows the topic under its name');
  },
  { noSession: true },
);

check(
  'start.topic-times',
  async (t) => {
    const c = await smallStart();
    t.ok(c.topics > 5, 'the small start said topics', c.out);
    t.eq(c.noTime, [], `each of the ${c.topics} topics said at start has its last message's time, also when that message is older than the start's window`);
  },
  { noSession: true },
);

check('robust.low-budget-events', async (t) => {
  // The extractor is told its request budget is nearly spent (as after a burst of history pages). The server would
  // still answer; what is said in the meantime must be heard, not held until the window's reset.
  const { topic } = await freshTopic(t, 'budget');
  const hook = async (url: string, init: RequestInit) => {
    if (!url.endsWith('/api/v1/scheduled_messages')) return;
    const res = await fetch(url, init);
    const h = new Headers(res.headers);
    h.set('X-RateLimit-Remaining', '1');
    h.set('X-RateLimit-Reset', String(Math.floor(Date.now() / 1000) + 30));
    return new Response(await res.arrayBuffer(), { status: res.status, headers: h });
  };
  hooks.push(hook);
  try {
    await t.cmd({ t: 'nativeScheduled' });
  } finally {
    hooks.splice(hooks.indexOf(hook), 1);
  }
  let from = t.mark();
  // The poll in flight brings the first; the next poll is the one that may be held.
  const a = await say(ann, { stream: G(), topic }, 'First, on the poll in flight.');
  await t.event('the first message', isMsg(a), from);
  from = t.mark();
  const t0 = Date.now();
  const b = await say(ann, { stream: G(), topic }, 'Second, on the next poll.');
  const e = await t.event('the second message within 8 s (the reserve wait holds the event poll until the reset, here 30 s)', isMsg(b), from, 8000);
  if (!e) await t.maybe(isMsg(b), from, 40_000).then((late) => t.ok(false, `it came after ${Date.now() - t0} ms`, late ? 'heard late' : 'never heard'));
});

check(
  'robust.revoked-key',
  async (t) => {
    // A bot of Quinn's stands in for an account whose key is revoked, so no seeded person's key changes.
    const made = await rest(quinn, 'POST', '/bots', { full_name: `Drive Bot ${RUN}`, short_name: `drv-${RUN}`, bot_type: 1 });
    const botUser = (await rest(quinn, 'GET', `/users/${made.user_id}`)).user;
    const botEmail = (botUser.delivery_email ?? botUser.email) as string;
    const me: Who = { email: botEmail, apiKey: made.api_key, userId: made.user_id };
    const { a, link } = await open(me, { apiKey: me.apiKey });
    opened.push(a);
    try {
      if (!t.ok(await link.next(isOnline, 60_000).catch(() => null), 'the stand-in account comes online', link.events.filter((e) => e.t === 'status').pop())) return;
      const from = link.events.length;
      const fresh = (await rest(quinn, 'POST', `/bots/${me.userId}/api_key/regenerate`)).api_key as string;
      // Something happens, so the poll in flight returns and the next one meets the dead key.
      await say(quinn, { dm: [me.userId] }, 'Wake up.');
      const st = (await link.next((e: any) => e.t === 'status' && e.status === 'attention', 100_000, from).catch(() => null)) as Ev | null;
      t.eq(st && [st.status, st.attention?.kind], ['attention', 'login'], 'a revoked key asks the owner to sign in again');
      t.ok(st && !JSON.stringify(st).includes(me.apiKey), 'without the key in the status');
      const refused = await a.command({ t: 'send', id: 'r1', conversation: dmId(me.userId, quinn), body: 'x' } as any).then(() => null, (e) => e as Error);
      t.ok(refused && /key|sign|login|API/i.test(refused.message), 'a command meanwhile is refused with the reason', refused?.message);
      // The owner sets the new key; the account's relogin action takes it up.
      link.saveSecret({ apiKey: fresh, email: me.email });
      const at = link.events.length;
      const acted = await a.command({ t: 'action', id: 'r2', action: 'relogin' } as any).then(() => null, (e) => e as Error);
      t.ok(!acted, 'the relogin action is taken while signed out (it is what signs in again)', acted?.message);
      t.ok(await link.next(isOnline, 20_000, at).catch(() => null), 'and the account is online again with the new key');
    } finally {
      await a.shutdown().catch(() => {});
      await restRaw(quinn, 'DELETE', `/bots/${me.userId}`);
    }
  },
  { noSession: true },
);

// ================================================================ running

/**
 * Zulip allows each person 200 requests a minute, and the checks ask the server about Quinn as Quinn. A check starts
 * with room in that budget, so none of them fails for having run after a busy one (robust.low-budget-events and
 * robust.rate-limit-real are the checks of what the extractor does when the budget is short).
 */
async function headroom() {
  const r = await restRaw(quinn, 'GET', '/users/me');
  const left = Number(r.headers.get('x-ratelimit-remaining'));
  const reset = Number(r.headers.get('x-ratelimit-reset'));
  if (Number.isFinite(left) && left < 90 && Number.isFinite(reset)) await Bun.sleep(Math.max(0, reset * 1000 - Date.now()) + 1500);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--child-send') {
    // robust.restart-topic-case: a second extractor, started with what the parent put in the environment.
    const { a, link } = await open(quinn, { apiKey: quinn.apiKey });
    await link.next(isOnline, 60_000);
    const r = (await a.command({ t: 'send', id: 'c1', conversation: args[1], body: args[2] } as any)) as any;
    console.log(`SENT ${String(r?.nativeId).split('/').pop()}`);
    const threads = (link.events as Ev[]).slice(0, link.events.findIndex(isOnline)).filter((e) => e.t === 'conversation' && e.conversation.shape === 'thread');
    const lastOf = new Map<string, any>(threads.map((e) => [e.conversation.nativeId, e.conversation]));
    console.log(`TOPICS ${lastOf.size}`);
    console.log(`NOTIME ${[...lastOf.values()].filter((c) => !c.lastMessageAt).map((c) => c.nativeId).join('|')}`);
    await a.shutdown();
    process.exit(0);
  }
  const onlyAt = args.indexOf('--only');
  const only = onlyAt >= 0 ? (args[onlyAt + 1] ?? '').split(',').filter(Boolean) : null;
  const verbose = args.includes('--verbose');
  const chosen = checks.filter((c) => !only || only.some((o) => c.name === o || c.name.startsWith(o)));
  if (args.includes('--list')) {
    for (const c of chosen) console.log(c.name);
    return;
  }
  if (!chosen.length) {
    console.error(`no check matches ${only?.join(', ')}`);
    process.exit(2);
  }
  process.on('unhandledRejection', (e) => console.error(`  (unhandled rejection: ${(e as Error)?.message ?? e})`));
  const results: { name: string; ok: boolean; ms: number }[] = [];
  for (const c of chosen) {
    const t = new T();
    const t0 = Date.now();
    try {
      if (!c.noSession) t.S = await session();
      await headroom();
      await c.run(t);
    } catch (e) {
      t.fails.push(`the check itself threw: ${(e as Error).stack ?? e}`);
    }
    const ok = t.fails.length === 0;
    results.push({ name: c.name, ok, ms: Date.now() - t0 });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}  (${Date.now() - t0} ms)`);
    for (const f of t.fails) console.log(`      - ${f}`);
    if (verbose && t.S) for (const l of t.S.link.logs.splice(0)) console.log(`      [${l.level}] ${l.msg}`);
  }
  for (const c of cleanups) await c().catch(() => {});
  for (const a of opened) await a.shutdown().catch(() => {});
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed${failed.length ? `: ${failed.map((r) => r.name).join(', ')}` : ''}`);
  process.exit(failed.length ? 1 : 0);
}

await main();
