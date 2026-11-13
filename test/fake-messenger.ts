/**
 * A fake Messenger and a fake Instagram for extractors/meta: the server side of test/fake-messenger-page.js.
 *
 * FakeMetaServer holds the chats and answers what the page's client sends (`/ls_req` tasks, `/maw` routes of the
 * encryption worker, `/graphql` mutations and queries, `/mqtt` publishes), and pushes what the real server would
 * (rows for Messenger's stored procedures, Slide deltas and typing for Instagram) through `poll`. The hook's unit
 * tests call it directly; startFakeMeta serves it with the pages over HTTP for a real Chromium. Every request is
 * logged with its path and the names of its fields (`calls`), so tests can hold the hook to the client's own shapes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type FakeSite = 'messenger' | 'instagram';
export interface FakeMetaOpts {
  site: FakeSite;
  signedIn?: boolean;
  /** Module names the page does not define (to exercise the hook's fallbacks). */
  missing?: string[];
  /** No `__debug` module: the hook must use `ifRequired` and its own trap. */
  noDebug?: boolean;
  /** Define IGDMAPIUnsendMessage (a name the public bundles do not show; tried by the hook). */
  unsendModule?: boolean;
  /** Messenger: a subscription manager whose method cannot be replaced. */
  frozenNotify?: boolean;
}
export interface FakeCall {
  path: string;
  name?: string;
  label?: string;
  queue?: string;
  keys: string[];
  route?: string;
  at: number;
}

export const SELF = { fb: '100000000000001', ig: '501', eimu: '17841400000000001' };
export const ALICE = { fb: '100000000000002', ig: '502', eimu: '17841400000000002', name: 'Alice Archer', username: 'alice.archer' };
export const BOB = { fb: '100000000000003', ig: '503', eimu: '17841400000000003', name: 'Bob Baker', username: 'bobbaker' };
/** Messenger threads: a 1:1 is keyed by the other person's id; 15 is an end-to-end encrypted 1:1; 2 a group. */
export const MS = { direct: ALICE.fb, e2ee: BOB.fb, group: '9000000000000001' };
/** Instagram threads by their messaging fbid, and their Instagram ids. */
export const IG = { direct: '340282366841710301', group: '340282366841710302', directIg: '7001', groupIg: '7002' };
export const PAGE_JS = readFileSync(join(import.meta.dir, 'fake-messenger-page.js'), 'utf8');

type Msg = { id: string; thread: string; sender: string; ts: number; text?: string | null; otid?: string; replyTo?: string; unsent?: boolean; edits?: number; reactions?: { emoji: string; sender: string; ts: number }[]; image?: { id: string; url: string; width: number; height: number }; mentions?: { at: number; len: number; id: string }[] };
type Ev = { kind?: string; sp?: string; [k: string]: unknown };

const rid = () => Math.random().toString(36).slice(2, 10);

export class FakeMetaServer {
  readonly events: Ev[] = [];
  readonly calls: FakeCall[] = [];
  /** Tasks shipped by the page, whoever queued them: label, queue and the payload's key set, for comparing. */
  readonly tasks: { label: string; queue: string; keys: string[]; consts: Record<string, unknown> }[] = [];
  readonly messages = new Map<string, Msg>();
  readonly typingOut: { thread: string; on: boolean }[] = [];
  readonly reads: { thread: string; message?: string }[] = [];
  private waiters: (() => void)[] = [];
  private seq = 0;
  mediaUrl = 'https://scontent.example/cat.png';
  readonly older: Msg[] = [];

  constructor(readonly opts: FakeMetaOpts) {
    if (opts.site === 'messenger') this.seedMessenger();
    else this.seedInstagram();
  }

  push(ev: Ev) {
    this.events.push(ev);
    for (const w of this.waiters.splice(0)) w();
  }
  async poll(since: number): Promise<{ events: Ev[]; next: number }> {
    if (since >= this.events.length) await new Promise<void>((res) => {
      this.waiters.push(res);
      setTimeout(res, 1000);
    });
    return { events: this.events.slice(since), next: this.events.length };
  }

  // ------------------------------------------------------------- Messenger
  private seedMessenger() {
    const now = Date.now();
    for (const c of [
      { id: SELF.fb, name: 'Sam Self' },
      { id: ALICE.fb, name: ALICE.name, username: ALICE.username, picture: `${this.mediaUrl}?who=alice` },
      { id: BOB.fb, name: BOB.name },
    ])
      this.push({ sp: 'contact', contact: c });
    this.push({ sp: 'thread', thread: { id: MS.direct, type: 1, lastActivity: now - 60_000, lastRead: now - 120_000, unread: 1 } });
    this.push({ sp: 'thread', thread: { id: MS.e2ee, type: 15, lastActivity: now - 90_000, lastRead: now - 90_000 } });
    this.push({ sp: 'thread', thread: { id: MS.group, type: 2, name: 'Pelican Club', picture: `${this.mediaUrl}?group`, lastActivity: now - 30_000, lastRead: now - 30_000, muteUntil: -1 } });
    for (const [t, who] of [
      [MS.direct, [SELF.fb, ALICE.fb]],
      [MS.e2ee, [SELF.fb, BOB.fb]],
      [MS.group, [SELF.fb, ALICE.fb, BOB.fb]],
    ] as const)
      for (const c of who) this.push({ sp: 'participant', participant: { thread: t, contact: c, read: c === ALICE.fb ? now - 100_000 : 0 } });
    this.msMessage({ id: 'mid.$a1', thread: MS.direct, sender: ALICE.fb, ts: now - 200_000, text: 'hello from alice' });
    this.msMessage({ id: 'mid.$a2', thread: MS.direct, sender: SELF.fb, ts: now - 150_000, text: 'hi alice' }, { reactions: [{ emoji: '❤', sender: ALICE.fb, ts: now - 140_000 }] });
    this.msMessage({ id: 'mid.$a3', thread: MS.direct, sender: ALICE.fb, ts: now - 60_000, text: 'a picture' }, { image: true });
    this.msMessage({ id: 'mid.$e1', thread: MS.e2ee, sender: BOB.fb, ts: now - 90_000, text: 'secret plans, decrypted in the page' });
    this.msMessage({ id: 'mid.$g1', thread: MS.group, sender: BOB.fb, ts: now - 30_000, text: 'hey Sam, pelicans', mentions: [{ at: 4, len: 3, id: SELF.fb }] });
  }
  private msMessage(m: Msg, extra: { reactions?: Msg['reactions']; image?: boolean } = {}) {
    this.messages.set(m.id, { ...m, reactions: extra.reactions ?? [] });
    this.push({ sp: 'message', message: m });
    for (const r of extra.reactions ?? []) this.push({ sp: 'reaction', reaction: { thread: m.thread, message: m.id, actor: r.sender, emoji: r.emoji, ts: r.ts } });
    if (extra.image) this.push({ sp: 'attachment', attachment: { thread: m.thread, message: m.id, id: '700000000000001', name: 'cat.png', size: 68, url: this.mediaUrl, mime: 'image/png', width: 1, height: 1 } });
  }

  // ------------------------------------------------------------- Instagram
  private igThread(fbid: string) {
    const direct = fbid === IG.direct;
    return {
      fbid,
      igid: direct ? IG.directIg : IG.groupIg,
      title: direct ? ALICE.name : 'Heron Club',
      group: !direct,
      lastActivity: Date.now() - (direct ? 60_000 : 30_000),
      users: (direct ? [ALICE] : [ALICE, BOB]).map((u) => ({ pk: u.ig, fbid: u.eimu, username: u.username, name: u.name, picture: `${this.mediaUrl}?who=${u.ig}` })),
      receipts: [{ fbid: ALICE.eimu, ts: Date.now() - 100_000 }],
    };
  }
  private seedInstagram() {
    const now = Date.now();
    const msgs: Msg[] = [
      { id: 'mid.$ig1', thread: IG.direct, sender: ALICE.eimu, ts: now - 200_000, text: 'hello from alice on instagram' },
      { id: 'mid.$ig2', thread: IG.direct, sender: SELF.eimu, ts: now - 150_000, text: 'hi alice', reactions: [{ emoji: '😂', sender: ALICE.eimu, ts: now - 140_000 }] },
      { id: 'mid.$ig3', thread: IG.direct, sender: ALICE.eimu, ts: now - 60_000, text: null, image: { id: '800000000000001', url: this.mediaUrl, width: 1, height: 1 } },
      { id: 'mid.$ig4', thread: IG.group, sender: BOB.eimu, ts: now - 30_000, text: 'herons today', edits: [now - 20_000] as unknown as number },
    ];
    for (const m of msgs) this.messages.set(m.id, m);
    for (let i = 0; i < 5; i++) this.older.push({ id: `mid.$old${i}`, thread: IG.direct, sender: i % 2 ? SELF.eimu : ALICE.eimu, ts: now - 900_000 - i * 60_000, text: `older ${i}` });
    this.push({ kind: 'state', data: { threads: [this.igThread(IG.direct), this.igThread(IG.group)], messages: msgs.map((m) => this.igOut(m)) } });
  }
  private igOut(m: Msg) {
    return { ...m, edits: Array.isArray(m.edits) ? m.edits : undefined };
  }
  private igDelta(typename: string, m: Msg) {
    this.push({ kind: 'delta', delta: { __typename: typename, message: this.igOut(m), thread_read_state_effect: 'KEEP_AS_IS' } });
  }

  // ------------------------------------------------------------ the client
  /** What the page's client sends. */
  async handle(path: string, body: any): Promise<unknown> {
    const call: FakeCall = { path, keys: body && typeof body === 'object' ? Object.keys(body) : [], at: Date.now() };
    this.calls.push(call);
    switch (path) {
      case '/ls_req':
        return this.task(body, call);
      case '/maw':
        return this.maw(body, call);
      case '/graphql':
        return this.graphql(body, call);
      case '/mqtt':
        call.name = body?.topic;
        if (body?.payload?.action === 'indicate_activity') this.typingOut.push({ thread: String(body.payload.thread_id), on: body.payload.activity_status !== 0 });
        return {};
      default:
        return { error: `fake: no ${path}` };
    }
  }

  private task(t: { label: string; queue: string; payload: string }, call: FakeCall) {
    call.label = t.label;
    call.queue = t.queue;
    let p: any;
    try {
      p = JSON.parse(t.payload);
    } catch {
      return { error: 'bad payload' };
    }
    const consts: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(p)) if (typeof v === 'number' && !/thread|otid|timestamp|watermark|actor/.test(k)) consts[k] = v;
    this.tasks.push({ label: t.label, queue: t.queue.replace(/\d{6,}/g, '#').replace(/mid\.\$[\w]+/g, '@'), keys: Object.keys(p).sort(), consts });
    call.keys = Object.keys(p).sort();
    switch (t.label) {
      case '46': {
        const m: Msg = { id: `mid.$srv${++this.seq}`, thread: String(p.thread_id), sender: SELF.fb, ts: Date.now(), text: p.text, otid: String(p.otid), replyTo: p.reply_metadata?.reply_source_id };
        this.messages.set(m.id, m);
        setTimeout(() => this.push({ sp: 'message', message: m }), 150);
        return { ok: true };
      }
      case '29': {
        const m = this.messages.get(p.message_id);
        if (!m) return { error: 'no such message' };
        this.push({ sp: 'reaction', reaction: { thread: m.thread, message: m.id, actor: String(p.actor_id), emoji: p.reaction }, remove: !p.reaction });
        return { ok: true };
      }
      case '21':
        this.reads.push({ thread: String(p.thread_id) });
        this.push({ sp: 'thread', thread: { id: String(p.thread_id), type: String(p.thread_id) === MS.group ? 2 : 1, lastActivity: Date.now() - 1000, lastRead: Number(p.last_read_watermark_ts), unread: 0, ...(String(p.thread_id) === MS.group ? { name: 'Pelican Club', picture: `${this.mediaUrl}?group`, muteUntil: -1 } : {}) } });
        return { ok: true };
      case '742': {
        const m = this.messages.get(p.message_id);
        if (!m) return { error: 'no such message' };
        m.text = p.text;
        m.edits = (Number(m.edits) || 0) + 1;
        this.push({ sp: 'message', message: m });
        return { ok: true };
      }
      case '33': {
        const m = this.messages.get(p.message_id);
        if (!m) return { error: 'no such message' };
        m.unsent = true;
        this.push({ sp: 'message', message: { ...m, text: null } });
        return { ok: true };
      }
      default:
        return { error: `fake: no task ${t.label}` };
    }
  }

  private maw(b: { backend: string; route: string; payload: any }, call: FakeCall) {
    call.route = `${b.backend}/${b.route}`;
    call.keys = b.payload ? Object.keys(b.payload) : [];
    if (b.route === 'sendTextMessage') {
      const thread = String(b.payload.chatJid).split('@')[0];
      const m: Msg = { id: `mid.$srv${++this.seq}`, thread, sender: SELF.fb, ts: Date.now(), text: b.payload.text, otid: String(b.payload.otid) };
      this.messages.set(m.id, m);
      setTimeout(() => this.push({ sp: 'message', message: m }), 150);
      return { ok: true };
    }
    return { error: `fake: no route ${b.route}` };
  }

  private graphql(b: { name: string; variables: any }, call: FakeCall) {
    call.name = b.name;
    const v = b.variables ?? {};
    call.keys = Object.keys(v).sort();
    switch (b.name) {
      case 'IGDirectTextSendMutation': {
        const m: Msg = { id: `mid.$igsrv${++this.seq}`, thread: String(v.ig_thread_igid), sender: SELF.eimu, ts: Date.now(), text: v.text?.sensitive_string_value, otid: String(v.offline_threading_id), replyTo: v.reply_to_message_id ?? undefined };
        this.messages.set(m.id, m);
        setTimeout(() => this.igDelta('SlideUQPPNewMessage', m), 150);
        return { data: { xig_direct_text_send_with_slide_messaging_response: { message_id: m.id, timestamp_ms: String(m.ts) } } };
      }
      case 'IGDirectReactionSendMutation': {
        const m = this.messages.get(v.input?.message_id);
        if (!m) return { errors: [{ message: 'no such message' }] };
        m.reactions = (m.reactions ?? []).filter((r) => r.sender !== SELF.eimu);
        if (v.input.reaction_status === 'created') m.reactions.push({ emoji: v.input.emoji, sender: SELF.eimu, ts: Date.now() });
        this.igDelta(v.input.reaction_status === 'created' ? 'SlideUQPPCreateReaction' : 'SlideUQPPDeleteReaction', m);
        return { data: {} };
      }
      case 'IGDirectEditMessageMutation': {
        const m = this.messages.get(v.target_message_id);
        if (!m) return { errors: [{ message: 'no such message' }] };
        m.text = v.body?.sensitive_string_value;
        m.edits = [...(Array.isArray(m.edits) ? m.edits : []), Date.now()] as unknown as number;
        this.igDelta('SlideUQPPEditMessage', m);
        return { data: {} };
      }
      case 'IGDirectUnsendMessageMutation': {
        const m = this.messages.get(v.message_id);
        if (!m) return { errors: [{ message: 'no such message' }] };
        this.messages.delete(m.id);
        this.push({ kind: 'delta', delta: { __typename: 'SlideUQPPDeleteMessage', message_id: m.id, thread_fbid: m.thread } });
        return { data: {} };
      }
      case 'useIGDMarkThreadAsReadMutation': {
        const igid = v.metadata?.ig_thread_igid;
        const fbid = igid === IG.directIg ? IG.direct : igid === IG.groupIg ? IG.group : null;
        if (!fbid) return { errors: [{ message: 'no such thread' }] };
        this.reads.push({ thread: fbid, message: v.data?.message_id });
        const t = this.igThread(fbid);
        t.receipts.push({ fbid: SELF.eimu, ts: this.messages.get(v.data?.message_id)?.ts ?? Date.now() });
        this.push({ kind: 'delta', delta: { __typename: 'SlideUQPPReadReceipt', thread: t } });
        return { data: { xig_direct_item_seen_mutation_with_slide_messaging_response: {} } };
      }
      case 'IGDMessageListOffMsysQuery': {
        const fbid = String(v.id ?? '').replace(/^node:/, '');
        const before = v.older_than_message_id ? this.messages.get(v.older_than_message_id)?.ts ?? Infinity : Infinity;
        const page = this.older.filter((m) => m.thread === fbid && m.ts < before).slice(0, Number(v.first) || 20);
        for (const m of page) this.messages.set(m.id, m);
        return { data: { messages: page.map((m) => this.igOut(m)) } };
      }
      default:
        return { errors: [{ message: `fake: no operation ${b.name}` }] };
    }
  }

  // ------------------------------------------------- as if done elsewhere
  /** A message from someone else, as the server would push it. */
  deliver(thread: string, text: string, from = this.opts.site === 'messenger' ? ALICE.fb : ALICE.eimu): string {
    const m: Msg = { id: `mid.$in${++this.seq}${rid()}`, thread, sender: from, ts: Date.now(), text };
    this.messages.set(m.id, m);
    if (this.opts.site === 'messenger') this.push({ sp: 'message', message: m });
    else this.igDelta('SlideUQPPNewMessage', m);
    return m.id;
  }
  react(message: string, emoji: string, from = this.opts.site === 'messenger' ? ALICE.fb : ALICE.eimu) {
    const m = this.messages.get(message)!;
    if (this.opts.site === 'messenger') this.push({ sp: 'reaction', reaction: { thread: m.thread, message, actor: from, emoji } });
    else {
      m.reactions = [...(m.reactions ?? []).filter((r) => r.sender !== from), { emoji, sender: from, ts: Date.now() }];
      this.igDelta('SlideUQPPCreateReaction', m);
    }
  }
  unsendByThem(message: string) {
    const m = this.messages.get(message)!;
    if (this.opts.site === 'messenger') this.push({ sp: 'message', message: { ...m, text: null, unsent: true } });
    else this.push({ kind: 'delta', delta: { __typename: 'SlideUQPPDeleteMessage', message_id: m.id, thread_fbid: m.thread } });
  }
  typing(thread: string, on: boolean) {
    if (this.opts.site === 'messenger') this.push({ sp: 'typing', thread, sender: ALICE.fb, on });
    else {
      const igid = thread === IG.direct ? IG.directIg : IG.groupIg;
      this.push({ kind: 'typing', payload: { xdt_direct_realtime_event: { data: [{ path: `/direct_v2/threads/${igid}/activity_indicator_id/1`, value: JSON.stringify({ activity_status: on ? 1 : 0, sender_id: Number(ALICE.ig), timestamp: Date.now() * 1000, ttl: 12000 }) }] } } });
    }
  }
  /** Someone else read up to now. */
  readByAlice(thread: string) {
    if (this.opts.site === 'messenger') this.push({ sp: 'participant', participant: { thread, contact: ALICE.fb, read: Date.now() } });
    else {
      const t = this.igThread(thread);
      t.receipts = [{ fbid: ALICE.eimu, ts: Date.now() }];
      this.push({ kind: 'delta', delta: { __typename: 'SlideUQPPReadReceipt', thread: t } });
    }
  }
  /** Something done by hand in the live view: the page's client does it its own way. */
  userAction(action: { type: string; [k: string]: unknown }) {
    this.push({ kind: 'action', action });
  }
}

// ----------------------------------------------------------------- HTTP
function page(opts: FakeMetaOpts, signedIn: boolean): string {
  const o = { site: opts.site, signedIn, self: SELF, missing: opts.missing ?? [], noDebug: !!opts.noDebug, unsendModule: !!opts.unsendModule, frozenNotify: !!opts.frozenNotify };
  return `<!doctype html><html><head><meta charset="utf-8"><title>${opts.site === 'messenger' ? 'Messenger' : 'Instagram'}</title></head><body>
<script>__d_stub=[];__d=function(e,t,n,r){__d_stub.push([e,t,n,r])};</script>
<script>__d("FakeEarlyModule",[],function(t,n,r,o,a,i,l){l.early=true},98);</script>
<script src="/fake/page.js"></script>
<script>
window.__fake = installFakeMeta(window, Object.assign(${JSON.stringify(o)}, { transport: {
  post: (p, b) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.json()),
  poll: (since) => fetch('/fake/poll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ since }) }).then((r) => r.json()),
} }));
history.replaceState(null, '', location.pathname + '?secret=query#secret-hash');
</script></body></html>`;
}

export async function startFakeMeta(opts: FakeMetaOpts) {
  const fake = new FakeMetaServer(opts);
  const signedIn = opts.signedIn !== false;
  const html = (s: string, status = 200) => new Response(s, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;
      if (path === '/fake/page.js') return new Response(PAGE_JS, { headers: { 'content-type': 'text/javascript' } });
      if (path === '/fake/poll') return Response.json(await fake.poll(Number((await req.json()).since) || 0));
      if (req.method === 'POST' && ['/ls_req', '/maw', '/graphql', '/mqtt'].includes(path)) return Response.json(await fake.handle(path, await req.json()));
      if (path === '/media/cat.png') return new Response(png, { headers: { 'content-type': 'image/png' } });
      if (opts.site === 'messenger') {
        if (path === '/login/' || path === '/login') return html('<!doctype html><title>Log in</title><body>Log in</body>');
        if (path === '/' || /^\/(e2ee\/)?t\//.test(path)) return html(page(opts, signedIn));
      } else {
        if (path.startsWith('/accounts/login')) return html('<!doctype html><title>Login • Instagram</title><body>Log in</body>');
        if (path === '/' || path.startsWith('/direct/')) return signedIn ? html(page(opts, true)) : Response.redirect(`${base}/accounts/login/?next=${encodeURIComponent(path)}`, 302);
      }
      return new Response('not found', { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  fake.mediaUrl = `${base}/media/cat.png`;
  // The seed named the stand-in CDN before the port was known: point it here.
  for (const e of fake.events) {
    const s = JSON.stringify(e);
    if (s.includes('scontent.example')) Object.assign(e, JSON.parse(s.replaceAll('https://scontent.example/cat.png', fake.mediaUrl)));
  }
  return { url: base, fake, stop: () => server.stop(true) };
}
export type FakeMeta = Awaited<ReturnType<typeof startFakeMeta>>;
