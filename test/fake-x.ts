/**
 * A fake of the parts of x.com the x extractor reaches (docs/x.md), on 127.0.0.1: the x-web host page, the XChat
 * embed drawn into a shadow root, and its Kotlin-shaped chat core (extractors/x/test/fake-page/), with the API that
 * core calls and an event stream standing in for XChat's WebSocket.
 *
 * As on x.com, the page is ES modules: a host bundle and an embed bundle, each with its own React 19 (real React,
 * built here with Bun.build and minified), and the core as its own module, `dm-core-<hash>.js`, with mangled export
 * names. Signed out, /i/chat sends the browser to X's onboarding sign-in, whose page loads the logged-out entry. With
 * `pin`, the chat page goes to /i/chat/pin/verify until `unlock()` (someone entering the PIN in the live view).
 *
 * Variants for the hook's fallbacks: `coreName` serves the core under another file name (found then from a stack),
 * `hideComposer` keeps the composer's event class out of the core's exports (sending is then not found: read-only),
 * `renameClasses` gives the Kotlin classes the hook knows by name other names (found then by their shapes),
 * `renameRequestsFactory` gives the graph's Requests-page factory another name (found then on the Requests page).
 *
 * Besides the inbox, a message request (Carol's, `REQUEST`), people only X's search finds (Dave) or that X lets nobody
 * message or add (Erin), and the calls the Requests page, New message, Create a group, Add people, Edit Group, the
 * forward dialog and the composer's typing make.
 *
 * The API records what the page's client did (sent, edited, unsent, reacted, read, uploaded), so a test can tell the
 * client's own requests happened, and that reading did not mark anything read.
 *
 * Signed in, the page is also x.com's own client around the chat ("responsive-web": a webpack runtime, a Redux store,
 * the Notifications tab's lazy chunk) with its GraphQL server for notifications and profiles: test/fake-x-feed.ts.
 */
import { join } from 'node:path';
import { type FeedFake, RW_SCRIPTS, startFeedFake } from './fake-x-feed.ts';

export const SELF = { id: '1001', screenName: 'pat_x', displayName: 'Pat X' };
export const ALICE = { id: '2002', screenName: 'alice_a', displayName: 'Alice A', avatarUrl: 'https://pbs.twimg.com/profile_images/2002/a_normal.jpg' };
export const BOB = { id: '3003', screenName: 'bob_b', displayName: 'Bob B' };
/** A stranger whose message waits as a request; someone only X's search finds; someone X lets nobody message or add. */
export const CAROL = { id: '8004', screenName: 'carol_c', displayName: 'Carol C' };
export const DAVE = { id: '8005', screenName: 'dave_d', displayName: 'Dave D' };
export const ERIN = { id: '8006', screenName: 'erin_e', displayName: 'Erin E', canSendMessage: false, canBeAddedToGroup: false };
/** A legacy one-to-one DM (the id is the two users' ids), an XChat group and an XChat one-to-one. */
export const LEGACY = '1001-2002';
export const GROUP = 'g9001';
export const DIRECT = '3003:1001';
/** Carol's message request (an XChat one-to-one: the two ids, the lower first). */
export const REQUEST = '1001:8004';
export const PIXEL = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

export interface FakeUser {
  id: string;
  screenName: string;
  displayName: string;
  avatarUrl?: string;
  /** X's search says you may not message them, or put them in a group. */
  canSendMessage?: boolean;
  canBeAddedToGroup?: boolean;
}
export interface FakeConv {
  id: string;
  group: boolean;
  legacy: boolean;
  title?: string;
  description?: string;
  members: string[];
  admins?: string[];
  adminOnlyEditGroupInfo?: boolean;
  adminOnlyAddMembers?: boolean;
  readSeq: number;
  created: number;
  /** A message request (not in the inbox, in Requests), from whom, and not yet looked at on the Requests page. */
  request?: boolean;
  from?: string;
  unseen?: boolean;
  /** Declined, blocked or left: gone from every list. */
  gone?: boolean;
  blocked?: boolean;
}
export interface FakeAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
}
export interface FakeMsg {
  id: string;
  conv: string;
  seq: number;
  ts: number;
  from: string;
  text: string;
  replyToSeq?: number | null;
  reactions: { emoji: string; user: string }[];
  attachments?: FakeAttachment[];
  edited?: number;
  deleted?: boolean;
  undecryptable?: boolean;
  forwarded?: boolean;
}

export interface FakeXOpts {
  signedIn?: boolean;
  pin?: boolean;
  coreName?: string;
  hideComposer?: boolean;
  renameClasses?: boolean;
  /** The graph's factory for the Requests page under another name (the page still has it): found then on the page. */
  renameRequestsFactory?: boolean;
}

export interface FakeX {
  url: string;
  users: Map<string, FakeUser>;
  convs: Map<string, FakeConv>;
  msgs: FakeMsg[];
  media: Map<string, { mime: string; data: Uint8Array }>;
  /** What the page's client asked for, in order. */
  calls: { op: string; conv?: string; id?: string; text?: string; emoji?: string; remove?: boolean; seq?: number; replyToSeq?: number | null; media?: string[]; name?: string; variables?: Record<string, unknown>; method?: string; q?: string; members?: string[]; title?: string | null; description?: string | null; to?: string[]; note?: string | null }[];
  /** The notifications and profiles behind the signed-in client (fake-x-feed.ts). */
  feed: FeedFake;
  /** Someone else writes in a conversation (as X's servers would push it). */
  deliver(conv: string, from: string, text: string, extra?: Partial<FakeMsg>): FakeMsg;
  react(conv: string, id: string, user: string, emoji: string, remove?: boolean): void;
  typing(conv: string, user: string, stop?: boolean): void;
  /** A new message request arrives (X's servers push it): a one-to-one, or (`group`) a group they put you in. */
  request(from: FakeUser, text: string, group?: { id: string; title: string; members: string[] }): FakeConv;
  unlock(): void;
  stop(): void;
}

const BUILT = new Map<string, Promise<string>>();
/** One bundle per entry (cached for the process): real React, production, minified, as x.com ships it. */
function bundle(entry: string): Promise<string> {
  let p = BUILT.get(entry);
  if (!p) {
    p = (async () => {
      const r = await Bun.build({
        entrypoints: [join(import.meta.dir, '../extractors/x/test/fake-page', entry)],
        target: 'browser',
        format: 'esm',
        minify: true,
        define: { 'process.env.NODE_ENV': '"production"' },
      });
      if (!r.success) throw new Error(`fake-x: building ${entry} failed: ${r.logs.map(String).join('\n')}`);
      return r.outputs[0]!.text();
    })();
    BUILT.set(entry, p);
  }
  return p;
}

export async function startFakeX(opts: FakeXOpts = {}): Promise<FakeX> {
  const signedIn = opts.signedIn !== false;
  let unlocked = !opts.pin;
  const coreFile = opts.coreName ?? 'dm-core-Bq9FaKe1.js';
  const [host, embed] = await Promise.all([bundle('host.js'), bundle('embed.js')]);
  let core = await Bun.file(join(import.meta.dir, '../extractors/x/test/fake-page/dm-core.js')).text();
  if (opts.hideComposer) core = core.replace('  ChatComposerEvent as c,\n', '') + '\nwindow.__FAKE_COMPOSER__ = ChatComposerEvent;\n';
  if (opts.renameRequestsFactory) core = core.replace('M(WebDmObjectGraph).messageRequestsComponent =', 'M(WebDmObjectGraph).messageRequestsComponentV2 =');
  if (opts.renameClasses) core = core.replace(/F\((WebDmObjectGraph|DefaultConversationListComponent|DefaultDmComponent|DmEvent|ChatComposerEvent|ConversationListEvent|KtList|ReactionPickerItem), '(\w+)'/g, (_, c: string, n: string) => `F(${c}, '${n}V2'`);

  const now = Date.now();
  const users = new Map<string, FakeUser>([SELF, ALICE, BOB, CAROL, DAVE, ERIN].map((u) => [u.id, u]));
  const convs = new Map<string, FakeConv>([
    [LEGACY, { id: LEGACY, group: false, legacy: true, members: [SELF.id, ALICE.id], readSeq: 30, created: now - 40 * 3600_000 }],
    [GROUP, { id: GROUP, group: true, legacy: false, title: 'Weekend plans', members: [SELF.id, ALICE.id, BOB.id], readSeq: 0, created: now - 20 * 3600_000 }],
    [DIRECT, { id: DIRECT, group: false, legacy: false, members: [SELF.id, BOB.id], readSeq: 2, created: now - 10 * 3600_000 }],
    [REQUEST, { id: REQUEST, group: false, legacy: false, members: [SELF.id, CAROL.id], readSeq: 0, created: now - 6 * 3600_000, request: true, from: CAROL.id, unseen: true }],
  ]);
  // The group: Alice made it and runs it.
  Object.assign(convs.get(GROUP)!, { admins: [ALICE.id], description: 'Saturday, somewhere warm' });
  const msgs: FakeMsg[] = [];
  const media = new Map<string, { mime: string; data: Uint8Array }>();
  let seq = 0;
  const add = (m: Omit<FakeMsg, 'seq' | 'id' | 'reactions'> & Partial<FakeMsg>) => {
    seq++;
    const msg: FakeMsg = { id: m.id ?? `m${seq}`, seq: m.seq ?? msgs.filter((x) => x.conv === m.conv).length + 1, reactions: [], ...m } as FakeMsg;
    msgs.push(msg);
    return msg;
  };
  // The legacy DM: thirty messages, so history has to scroll; a reply, a reaction and a picture among them.
  for (let i = 1; i <= 30; i++) add({ conv: LEGACY, ts: now - (31 - i) * 3600_000, from: i % 3 === 0 ? SELF.id : ALICE.id, text: `legacy line ${i}` });
  media.set('att1', { mime: 'image/png', data: PIXEL });
  const pic = msgs.find((m) => m.conv === LEGACY && m.seq === 28)!;
  pic.attachments = [{ id: 'att1', name: 'pixel.png', mime: 'image/png', size: PIXEL.length, width: 1, height: 1 }];
  msgs.find((m) => m.conv === LEGACY && m.seq === 29)!.replyToSeq = 28;
  msgs.find((m) => m.conv === LEGACY && m.seq === 30)!.reactions.push({ emoji: '👍', user: SELF.id });
  add({ conv: GROUP, ts: now - 3 * 3600_000, from: ALICE.id, text: 'who is in for saturday' });
  add({ conv: GROUP, ts: now - 2 * 3600_000, from: BOB.id, text: '', undecryptable: true });
  add({ conv: GROUP, ts: now - 1 * 3600_000, from: SELF.id, text: 'count me in' });
  add({ conv: DIRECT, ts: now - 5 * 3600_000, from: BOB.id, text: 'hey pat' });
  add({ conv: DIRECT, ts: now - 4 * 3600_000, from: SELF.id, text: 'hi bob' });
  add({ conv: REQUEST, ts: now - 6 * 3600_000, from: CAROL.id, text: 'hello, we met at the conference' });
  add({ conv: REQUEST, ts: now - 5.5 * 3600_000, from: CAROL.id, text: 'are you free to talk next week' });

  const calls: FakeX['calls'] = [];
  const feed = await startFeedFake({ id: SELF.id, handle: SELF.screenName, name: SELF.displayName });
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const enc = new TextEncoder();
  const push = (d: unknown) => {
    for (const c of streams) {
      try {
        c.enqueue(enc.encode(`data: ${JSON.stringify(d)}\n\n`));
      } catch {
        streams.delete(c);
      }
    }
  };
  // As X's inbox: the server counts what is unread, not the page.
  const convOut = (c: FakeConv) => ({ ...c, total: msgs.filter((m) => m.conv === c.id).length, unread: msgs.filter((m) => m.conv === c.id && !m.deleted && m.from !== SELF.id && m.seq > c.readSeq).length });
  const usersOut = () => [...users.values()];
  const lastOf = (conv: string) =>
    msgs
      .filter((m) => m.conv === conv && !m.deleted)
      .sort((a, b) => b.seq - a.seq)
      .slice(0, 1);
  const pushMsg = (m: FakeMsg) => push({ users: usersOut(), conversations: [convOut(convs.get(m.conv)!)], messages: [m] });
  const pushConv = (c: FakeConv) => push({ users: usersOut(), conversations: [convOut(c)], messages: lastOf(c.id) });
  /** A one-to-one XChat id with you that nobody has written in yet: made by the first message (openDirect). */
  const newDirect = (id: string): FakeConv | null => {
    const m = /^(\d+):(\d+)$/.exec(id);
    if (!m || (m[1] !== SELF.id && m[2] !== SELF.id)) return null;
    const peer = m[1] === SELF.id ? m[2]! : m[1]!;
    if (!users.has(peer)) return null;
    const c: FakeConv = { id, group: false, legacy: false, members: [SELF.id, peer], readSeq: 0, created: Date.now() };
    convs.set(id, c);
    return c;
  };
  let groupSeq = 9100;
  const isAdmin = (c: FakeConv) => (c.admins ?? []).includes(SELF.id);

  const LOGGED_OUT_ENTRY = '/x-web/x-web/entry-client-logged-out-FaKe0002.js';
  const LOGGED_IN_ENTRY = '/x-web/x-web/entry-client-logged-in-FaKe0001.js';
  const EMBED = '/x-web/xchat/embed/assets/xchat-Fk3eAbC1.js';
  const CORE = `/x-web/xchat/embed/assets/${coreFile}`;
  const shell = () =>
    `<!doctype html><html><head><meta charset="utf-8"><title>X</title><script>window.__FAKE_USER__=${JSON.stringify(SELF.id)};window.__EMBED__=${JSON.stringify(EMBED)};window.__DM_CORE__=${JSON.stringify(CORE)};${opts.renameRequestsFactory ? "window.__REQUESTS_FACTORY__='messageRequestsComponentV2';" : ''}</script>${RW_SCRIPTS.map((u) => `<script src="${u}"></script>`).join('')}<script type="module" src="${LOGGED_IN_ENTRY}"></script></head><body style="margin:0"><div id="react-root"></div></body></html>`;
  const loginPage = `<!doctype html><html><head><meta charset="utf-8"><title>Log in to X</title><script type="module" src="${LOGGED_OUT_ENTRY}"></script></head><body><h1>Sign in to X</h1><input name="text" autocomplete="username"></body></html>`;
  const html = (body: string, extra: Record<string, string> = {}) => new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', ...extra } });
  const js = (body: string) => new Response(body, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' } });
  const json = (v: unknown, status = 200) => Response.json(v, { status });
  const authed = (req: Request) => /(?:^|;\s*)auth_token=fake-session/.test(req.headers.get('cookie') ?? '');

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      if (p === LOGGED_IN_ENTRY) return js(host);
      if (p === LOGGED_OUT_ENTRY) return js('document.documentElement.dataset.loggedOut = "1";');
      if (p === EMBED) return js(embed);
      if (p === CORE) return js(core);
      if (p === '/' || p === '/home' || p === '/i/chat' || p.startsWith('/i/chat/')) {
        if (!signedIn) return Response.redirect(`${url.origin}/i/jf/onboarding/web?redirect_after_login=${encodeURIComponent(p)}&mode=login`, 307);
        if (p === '/') return Response.redirect(`${url.origin}/home`, 302);
        const res = html(shell());
        res.headers.append('set-cookie', 'auth_token=fake-session; Path=/; HttpOnly; SameSite=Lax');
        res.headers.append('set-cookie', `twid=u%3D${SELF.id}; Path=/; SameSite=Lax`);
        return res;
      }
      if (p === '/i/jf/onboarding/web' || p === '/i/flow/login') return html(loginPage);
      const fed = await feed.route(req, url, calls);
      if (fed) return fed;
      if (p.startsWith('/__fake/media/')) {
        if (!authed(req)) return new Response('no', { status: 401 });
        const m = media.get(decodeURIComponent(p.slice('/__fake/media/'.length)));
        return m ? new Response(m.data as Uint8Array<ArrayBuffer>, { headers: { 'content-type': m.mime } }) : new Response('gone', { status: 404 });
      }
      if (!p.startsWith('/__fake/api/')) return new Response('not found', { status: 404 });
      if (!authed(req)) return json({ error: 'unauthorized' }, 401);
      const op = p.slice('/__fake/api/'.length);
      const body = req.method === 'POST' && op !== 'upload' ? ((await req.json()) as Record<string, any>) : {};
      switch (op) {
        case 'keys':
          return json({ unlocked });
        case 'inbox':
          return json({ users: usersOut(), conversations: [...convs.values()].map(convOut), messages: [...convs.keys()].flatMap(lastOf) });
        case 'messages': {
          const conv = url.searchParams.get('conv') ?? '';
          const limit = Number(url.searchParams.get('limit') ?? 20);
          const c = convs.get(conv);
          // A one-to-one nobody has written in yet: the page opens it empty.
          if (!c) return /^\d+:\d+$/.test(conv) ? json({ users: usersOut(), conversations: [], messages: [] }) : json({ error: 'no such conversation' }, 404);
          const all = msgs.filter((m) => m.conv === conv).sort((a, b) => a.seq - b.seq);
          return json({ users: usersOut(), conversations: [convOut(c)], messages: all.slice(-limit) });
        }
        case 'events': {
          let ctl: ReadableStreamDefaultController<Uint8Array>;
          const stream = new ReadableStream<Uint8Array>({
            start(c) {
              ctl = c;
              streams.add(c);
              c.enqueue(enc.encode(': hi\n\n'));
            },
            cancel() {
              streams.delete(ctl);
            },
          });
          return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } });
        }
        case 'send': {
          const c = convs.get(body.conv) ?? newDirect(body.conv);
          if (!c) return json({ error: 'no such conversation' }, 404);
          const atts = (body.media ?? []).map((id: string) => ({ id, name: `upload-${id}`, mime: media.get(id)?.mime ?? 'application/octet-stream', size: media.get(id)?.data.length ?? 0 }));
          calls.push({ op: 'send', conv: c.id, text: body.text, replyToSeq: body.replyToSeq ? Number(body.replyToSeq) : null, media: body.media ?? [] });
          const m = add({ conv: c.id, ts: Date.now(), from: SELF.id, text: body.text ?? '', replyToSeq: body.replyToSeq ? Number(body.replyToSeq) : null, ...(atts.length ? { attachments: atts } : {}) });
          c.readSeq = m.seq;
          pushMsg(m);
          return json({ id: m.id });
        }
        case 'edit': {
          const m = msgs.find((x) => x.conv === body.conv && x.id === body.id);
          if (!m || m.from !== SELF.id) return json({ error: 'not yours' }, 403);
          calls.push({ op: 'edit', conv: m.conv, id: m.id, text: body.text });
          m.text = body.text;
          m.edited = Date.now();
          pushMsg(m);
          return json({ ok: true });
        }
        case 'unsend': {
          const m = msgs.find((x) => x.conv === body.conv && x.id === body.id);
          if (!m || m.from !== SELF.id) return json({ error: 'not yours' }, 403);
          calls.push({ op: 'unsend', conv: m.conv, id: m.id });
          m.deleted = true;
          pushMsg(m);
          return json({ ok: true });
        }
        case 'react': {
          const m = msgs.find((x) => x.conv === body.conv && x.id === body.id);
          if (!m) return json({ error: 'no such message' }, 404);
          calls.push({ op: 'react', conv: m.conv, id: m.id, emoji: body.emoji, remove: !!body.remove });
          m.reactions = m.reactions.filter((r) => !(r.user === SELF.id && r.emoji === body.emoji));
          if (!body.remove) m.reactions.push({ emoji: body.emoji, user: SELF.id });
          pushMsg(m);
          return json({ ok: true });
        }
        case 'read': {
          const c = convs.get(body.conv);
          if (!c) return json({ error: 'no such conversation' }, 404);
          calls.push({ op: 'read', conv: c.id, seq: Number(body.seq) });
          c.readSeq = Math.max(c.readSeq, Number(body.seq));
          push({ conversations: [convOut(c)] });
          return json({ ok: true });
        }
        // The Requests page's first fetch, which X follows with marking the priority requests seen.
        case 'requests': {
          calls.push({ op: 'requestsSeen' });
          const asks = [...convs.values()].filter((c) => c.request && !c.gone);
          for (const c of asks) c.unseen = false;
          return json({ users: usersOut(), conversations: asks.map(convOut), messages: asks.flatMap((c) => lastOf(c.id)) });
        }
        case 'acceptRequest':
        case 'deleteRequest':
        case 'blockRequest': {
          const c = convs.get(body.conv);
          if (!c || !c.request || c.gone) return json({ error: 'no such request' }, 404);
          calls.push({ op, conv: c.id });
          if (op === 'acceptRequest') c.request = false;
          else c.gone = true;
          if (op === 'blockRequest') c.blocked = true;
          return json({ users: usersOut(), conversations: [convOut(c)], messages: lastOf(c.id) });
        }
        case 'search': {
          const q = (url.searchParams.get('q') ?? '').toLowerCase().replace(/^@/, '');
          calls.push({ op: 'search', q });
          return json({ users: [...users.values()].filter((u) => u.id !== SELF.id && q && (u.screenName.toLowerCase().startsWith(q) || u.displayName.toLowerCase().startsWith(q))) });
        }
        case 'createGroup': {
          const members = (body.members ?? []).map(String);
          calls.push({ op: 'createGroup', members, title: body.title ?? null });
          if (!members.length || members.some((m: string) => users.get(m)?.canBeAddedToGroup === false)) return json({ error: 'cannot' }, 400);
          const c: FakeConv = { id: `g${groupSeq++}`, group: true, legacy: false, ...(body.title ? { title: body.title } : {}), members: [SELF.id, ...members], admins: [SELF.id], readSeq: 0, created: Date.now() };
          convs.set(c.id, c);
          pushConv(c);
          return json({ conv: c.id, users: usersOut(), conversations: [convOut(c)], messages: [] });
        }
        case 'addMembers': {
          const c = convs.get(body.conv);
          const members = (body.members ?? []).map(String);
          calls.push({ op: 'addMembers', conv: body.conv, members });
          if (!c || !c.group) return json({ error: 'no such group' }, 404);
          if (c.adminOnlyAddMembers && !isAdmin(c)) return json({ error: 'admins only' }, 403);
          for (const m of members) if (!c.members.includes(m)) c.members.push(m);
          pushConv(c);
          return json({ users: usersOut(), conversations: [convOut(c)], messages: [] });
        }
        case 'editGroup': {
          const c = convs.get(body.conv);
          calls.push({ op: 'editGroup', conv: body.conv, ...('title' in body ? { title: body.title } : {}), ...('description' in body ? { description: body.description } : {}) });
          if (!c || !c.group) return json({ error: 'no such group' }, 404);
          if (c.adminOnlyEditGroupInfo && !isAdmin(c)) return json({ error: 'admins only' }, 403);
          if (typeof body.title === 'string') c.title = body.title;
          if (typeof body.description === 'string') c.description = body.description;
          pushConv(c);
          return json({ users: usersOut(), conversations: [convOut(c)], messages: [] });
        }
        case 'forward': {
          const src = msgs.find((m) => m.conv === body.from && m.id === body.id);
          const to = (body.to ?? []).map(String);
          calls.push({ op: 'forward', conv: body.from, id: body.id, to, note: body.note ?? null });
          if (!src) return json({ error: 'no such message' }, 404);
          const out: FakeMsg[] = [];
          for (const t of to) {
            const c = convs.get(t);
            if (!c) continue;
            const m = add({ conv: t, ts: Date.now(), from: SELF.id, text: src.text, forwarded: true });
            out.push(m);
            if (body.note) out.push(add({ conv: t, ts: Date.now(), from: SELF.id, text: String(body.note) }));
          }
          for (const m of out) pushMsg(m);
          return json({ users: usersOut(), conversations: to.map((t: string) => convs.get(t)).filter(Boolean).map((c: FakeConv) => convOut(c)), messages: out });
        }
        case 'typing': {
          calls.push({ op: 'typing', conv: body.conv });
          return json({ ok: true });
        }
        case 'upload': {
          const id = `up${media.size + 1}`;
          media.set(id, { mime: url.searchParams.get('mime') ?? 'application/octet-stream', data: new Uint8Array(await req.arrayBuffer()) });
          calls.push({ op: 'upload', id });
          return json({ id });
        }
        default:
          return json({ error: 'no such call' }, 404);
      }
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    users,
    convs,
    msgs,
    media,
    calls,
    feed,
    deliver(conv, from, text, extra = {}) {
      const m = add({ conv, ts: Date.now(), from, text, ...extra });
      pushMsg(m);
      return m;
    },
    react(conv, id, user, emoji, remove) {
      const m = msgs.find((x) => x.conv === conv && x.id === id)!;
      m.reactions = m.reactions.filter((r) => !(r.user === user && r.emoji === emoji));
      if (!remove) m.reactions.push({ emoji, user });
      pushMsg(m);
    },
    typing(conv, user, stop) {
      push({ typing: { conv, user, stop: !!stop } });
    },
    request(from, text, group) {
      users.set(from.id, from);
      const id = group ? group.id : BigInt(from.id) < BigInt(SELF.id) ? `${from.id}:${SELF.id}` : `${SELF.id}:${from.id}`;
      const c: FakeConv = convs.get(id) ?? (group ? { id, group: true, legacy: false, title: group.title, members: [SELF.id, ...group.members], admins: [from.id], readSeq: 0, created: Date.now(), request: true, from: from.id, unseen: true } : { id, group: false, legacy: false, members: [SELF.id, from.id], readSeq: 0, created: Date.now(), request: true, from: from.id, unseen: true });
      convs.set(id, c);
      const m = add({ conv: id, ts: Date.now(), from: from.id, text });
      pushMsg(m);
      return c;
    },
    unlock() {
      unlocked = true;
    },
    stop() {
      for (const c of streams) {
        try {
          c.close();
        } catch {}
      }
      server.stop(true);
    },
  };
}
