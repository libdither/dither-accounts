/**
 * The adapter against the fake Telegram, in process: sign-in (QR, two-step password, phone and code), the snapshot,
 * a restart on the saved session, every command, Telegram's updates as events, and the errors.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { readSecretFile, writeSecretFile } from '@dither-chat/protocol/secret-file';
import { type AdapterOptions, contactsHash, type Host, TELEGRAM_DESKTOP, TelegramAdapter } from '../src/adapter.ts';
import { FAKE_IDS, FAKE_INVITES, FakeTelegram } from '../src/fake.ts';

setDefaultTimeout(30_000);
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'dacc-tg-'));
  dirs.push(d);
  return d;
};

const S = FAKE_IDS.self;
const DM_ALICE = `dm:${S}:${FAKE_IDS.alice}`;
const DM_BOB = `dm:${S}:${FAKE_IDS.bob}`;
const DM_BOT = `dm:${S}:${FAKE_IDS.bot}`;
const GROUP = `group:${S}:${FAKE_IDS.group}`;
const DEVS = `channel:${FAKE_IDS.devs}`;
const FORUM = `channel:${FAKE_IDS.forum}`;
const NEWS = `channel:${FAKE_IDS.news}`;
const FAST = { spacing: { join: 0, dialogs: 0, history: 0, send: 0, read: 0, media: 0, light: 0 }, perChatSendMs: 0 };

type Ev = P.AdapterEvent;

class Harness {
  events: Ev[] = [];
  logs: string[] = [];
  fake: FakeTelegram;
  adapter: TelegramAdapter;
  constructor(
    readonly dir: string,
    o: { config?: Record<string, unknown>; opts?: Partial<AdapterOptions>; secret?: Record<string, unknown> } = {},
  ) {
    if (!existsSync(join(dir, 'secret.json'))) writeSecretFile(join(dir, 'secret.json'), o.secret ?? { apiHash: '0123456789abcdef0123456789abcdef' });
    this.fake = new FakeTelegram({ dir, qrMs: 400 });
    const host: Host = {
      emit: (e) => this.events.push(e),
      log: (l, m) => this.logs.push(`[${l}] ${m}`),
      accountDir: dir,
      config: o.config ?? { apiId: '12345' },
      secret: () => readSecretFile(join(dir, 'secret.json')),
      saveSecret: (v) => writeSecretFile(join(dir, 'secret.json'), v),
    };
    this.adapter = new TelegramAdapter(host, { backend: () => this.fake, fake: true, pacer: FAST, ...o.opts });
  }
  get status() {
    return [...this.events].reverse().find((e): e is Extract<Ev, { t: 'status' }> => e.t === 'status');
  }
  of<K extends Ev['t']>(t: K): Extract<Ev, { t: K }>[] {
    return this.events.filter((e): e is Extract<Ev, { t: K }> => e.t === t);
  }
  since(n: number) {
    return this.events.slice(n);
  }
  async until(f: () => unknown, what: string, ms = 4000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (f()) return;
      await Bun.sleep(10);
    }
    throw new Error(`timed out waiting for ${what}; last status ${JSON.stringify(this.status)}`);
  }
  cmd(c: Record<string, unknown>) {
    return this.adapter.command({ id: 'x', ...c } as P.AdapterCommand);
  }
  action(action: string, args?: unknown) {
    return this.cmd({ t: 'action', action, args });
  }
  secret() {
    return JSON.parse(readFileSync(join(this.dir, 'secret.json'), 'utf8'));
  }
  async signIn() {
    await this.adapter.start();
    await this.until(() => this.status?.attention?.qr, 'a QR code');
    await this.fake.control({ op: 'scan' });
    await this.until(() => this.status?.status === 'online', 'online');
  }
  async stop() {
    await this.adapter.shutdown();
  }
}

describe('sign-in', () => {
  test('with only one of api_id and api_hash it says what it needs', async () => {
    const h = new Harness(tmp(), { config: { apiId: '12345' }, secret: {}, opts: { fake: false } });
    await h.adapter.start();
    expect(h.status).toMatchObject({ status: 'error', attention: { kind: 'unknown' } });
    expect(h.status!.attention!.message).toContain('api_id and api_hash');
    expect(h.status!.layers![0]).toMatchObject({ name: 'api_id and api_hash', state: 'failed' });
    expect(await h.cmd({ t: 'send', conversation: DM_ALICE, body: 'x' }).catch((e) => e.message)).toBe('This account needs both api_id and api_hash, or neither');
    expect(h.of('hello')[0]).toMatchObject({ network: 'telegram', capabilities: expect.arrayContaining(['send', 'history', 'threads', 'media', 'sendMedia', 'forward', 'about', 'configure', 'profile']) });
  });

  test("with neither and no choice, it asks for an app instead of borrowing Telegram Desktop's", async () => {
    const h = new Harness(tmp(), { config: {}, secret: {}, opts: { fake: false } });
    await h.adapter.start();
    expect(h.status).toMatchObject({ status: 'error', attention: { kind: 'unknown' } });
    expect(h.status!.attention!.message).toContain("Telegram Desktop's app chosen");
  });

  test("an account signed in before the choice keeps Telegram Desktop's app", async () => {
    let creds: { apiId: number; apiHash: string } | null = null;
    const h: Harness = new Harness(tmp(), {
      config: {},
      secret: { session: 'an-old-session' },
      opts: {
        fake: false,
        backend: (c) => {
          creds = c;
          return h.fake;
        },
      },
    });
    await h.adapter.start();
    await h.until(() => creds, 'the backend');
    expect(creds!).toEqual(TELEGRAM_DESKTOP);
    await h.stop();
  });

  test("with neither and Telegram Desktop's app chosen, it signs in with that", async () => {
    let creds: { apiId: number; apiHash: string } | null = null;
    const h: Harness = new Harness(tmp(), {
      config: { app: 'desktop' },
      secret: {},
      opts: {
        fake: false,
        backend: (c) => {
          creds = c;
          return h.fake;
        },
      },
    });
    await h.adapter.start();
    await h.until(() => h.status?.attention?.qr, 'a QR code');
    expect(creds!).toEqual(TELEGRAM_DESKTOP);
    expect(h.status!.layers![0]).toMatchObject({ name: 'api_id and api_hash', state: 'ok', note: "api_id 611335, Telegram Desktop's" });
    await h.stop();
  });

  test('QR: the tg://login code is the attention, a fresh one as each expires or on New code; a scan signs in and keeps only the session', async () => {
    const h = new Harness(tmp());
    await h.adapter.start();
    await h.until(() => h.status?.attention?.qr, 'a QR code');
    const first = h.status!;
    expect(first).toMatchObject({ status: 'attention', attention: { kind: 'link_device', message: expect.stringContaining('Link Desktop Device') } });
    expect(first.attention!.qr).toMatch(/^tg:\/\/login\?token=[\w-]+$/);
    expect(first.attention!.qrRefreshAt!).toBeGreaterThan(Date.now());
    expect(first.layers!.map((l) => [l.name, l.state])).toEqual([
      ['api_id and api_hash', 'ok'],
      ['connection', 'ok'],
      ['signed in', 'waiting'],
      ['updates', 'waiting'],
    ]);
    await h.until(() => h.status!.attention?.qr && h.status!.attention.qr !== first.attention!.qr, 'a fresh code once it expired');
    const second = h.status!.attention!.qr;
    await h.action('refreshLink');
    await h.until(() => h.status!.attention?.qr && h.status!.attention.qr !== second, '"New code" makes another');
    await h.fake.control({ op: 'scan' });
    await h.until(() => h.status?.status === 'online', 'online');
    const st = h.status!;
    expect(st.self).toMatchObject({ nativeId: String(S), displayName: 'Test User', handle: '@testuser', isSelf: true });
    expect(st.attention).toBeNull();
    expect(st.layers!.every((l) => l.state === 'ok')).toBe(true);
    expect(st.details).toMatchObject({ connection: 'connected', signIn: 'signed in', session: 'in secret.json', userId: String(S), username: '@testuser', phone: '+99 ••• 34' });
    const secret = h.secret();
    expect(Object.keys(secret).sort()).toEqual(['apiHash', 'session', 'userId']);
    expect(secret.session).toStartWith('fake:');
    await h.stop();
  });

  test('two-step password: a wrong one is refused and asked again; the right one signs in and is never written down', async () => {
    const h = new Harness(tmp());
    await h.fake.control({ op: 'setPassword', password: 'hunter2', hint: 'my cat' });
    await h.adapter.start();
    await h.until(() => h.status?.attention?.qr, 'a QR code');
    expect(await h.action('relogin', { password: 'x' }).catch((e) => e.message)).toBe('Telegram is not asking for a password now');
    await h.fake.control({ op: 'scan' });
    await h.until(() => h.status?.attention?.kind === 'login', 'the password');
    expect(h.status!.attention!.message).toBe('Telegram asks for your two-step verification password (hint: “my cat”).');
    expect(h.status!.layers![2]).toMatchObject({ name: 'signed in', state: 'waiting', note: 'enter your two-step verification password' });
    expect(await h.action('relogin', { password: 'wrong' }).catch((e) => e.message)).toBe('That password is not right. Try again.');
    await h.until(() => /not right/.test(h.status?.attention?.message ?? ''), 'asked again');
    expect(await h.action('relogin', { password: 'hunter2' })).toEqual({ signedIn: true });
    await h.until(() => h.status?.status === 'online', 'online');
    const raw = readFileSync(join(h.dir, 'secret.json'), 'utf8') + (existsSync(join(h.dir, 'secret.json.bak')) ? readFileSync(join(h.dir, 'secret.json.bak'), 'utf8') : '');
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('wrong');
    await h.stop();
  });

  test('phone and code, then the password', async () => {
    const h = new Harness(tmp());
    await h.fake.control({ op: 'setPassword', password: 'pw' });
    await h.adapter.start();
    await h.until(() => h.status?.attention?.qr, 'a QR code');
    expect(await h.action('sendCode', { phone: '12' }).catch((e) => e.message)).toBe('Give the phone number with its country code, like +15551234567');
    expect(await h.action('sendCode', { phone: '+999 662 1234' })).toEqual({ sent: 'app', length: 5, timeout: 60 });
    expect(h.status).toMatchObject({ status: 'attention', attention: { kind: 'verify', detail: { code: { type: 'app', length: 5, next: 'sms' } } } });
    expect(h.status!.attention!.message).toContain('5-digit code to your other Telegram app');
    expect(await h.action('signIn', { code: '11111' }).catch((e) => e.message)).toBe('That code is not right');
    // Test numbers 99966XYYYY take X five times as their code, as on Telegram's test DCs.
    expect(await h.action('signIn', { code: '22222' })).toEqual({ password: true });
    await h.until(() => h.status?.attention?.kind === 'login', 'the password');
    expect(await h.action('relogin', { password: 'pw' })).toEqual({ signedIn: true });
    await h.until(() => h.status?.status === 'online', 'online');
    expect(h.secret().session).toStartWith('fake:');
    await h.stop();
  });

  test('a restart signs in with the saved session: no QR, the chats again', async () => {
    const dir = tmp();
    const a = new Harness(dir);
    await a.signIn();
    const session = a.secret().session;
    await a.stop();
    const b = new Harness(dir);
    await b.adapter.start();
    await b.until(() => b.status?.status === 'online', 'online again');
    expect(b.events.some((e) => e.t === 'status' && e.attention?.qr)).toBe(false);
    expect(b.secret().session).toBe(session);
    expect(b.of('conversation').some((e) => e.conversation.nativeId === DM_ALICE)).toBe(true);
    await b.stop();
  });

  test('a session ended elsewhere: dropped from secret.json, and a new QR code', async () => {
    const h = new Harness(tmp(), { opts: { healthEveryMs: 50 } });
    await h.signIn();
    await h.fake.control({ op: 'revoke' });
    await h.until(() => h.status?.attention?.qr && /signed this device out/.test(h.status.attention.message), 'back to the QR code');
    expect(h.secret().session).toBeUndefined();
    expect(h.secret().apiHash).toBeDefined();
    expect(await h.cmd({ t: 'send', conversation: DM_ALICE, body: 'x' }).catch((e) => e.message)).toBe('Telegram is not signed in yet');
    await h.stop();
  });
});

describe('signed in', () => {
  const h = new Harness(tmp(), { opts: { qrForMs: 60_000 } });
  const file = join(h.dir, 'pic.png');
  writeFileSync(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  const attachment = (name = 'pic.png'): P.OutgoingAttachment => ({ path: file, name, mime: 'image/png', size: 70, kind: 'image' });
  afterAll(() => h.stop());

  test('the snapshot: every kind of chat, a forum as a space with its topics as channels, people, read state, the last messages', async () => {
    await h.signIn();
    const convs = new Map(h.of('conversation').map((e) => [e.conversation.nativeId, e.conversation]));
    expect(convs.get(DM_ALICE)).toMatchObject({ shape: 'direct', participants: [String(S), String(FAKE_IDS.alice)], avatarUrl: `tg://avatar/u${FAKE_IDS.alice}/9101?dc=2` });
    expect(convs.get(`dm:${S}:${S}`)).toMatchObject({ shape: 'self', name: 'Saved Messages' });
    expect(convs.get(GROUP)).toMatchObject({ shape: 'group', variant: 'text', name: 'Weekend plans' });
    expect(convs.get(DEVS)).toMatchObject({ shape: 'group', variant: 'text', name: 'dither devs' });
    // A forum is a space with its topics as channels, as Discord's servers are; its own conversation is left.
    expect(convs.get(FORUM)).toBeUndefined();
    expect(h.of('space').find((e) => e.space.nativeId === FORUM)?.space).toMatchObject({ kind: 'community', name: 'Forum' });
    expect(h.of('leave')).toContainEqual({ t: 'leave', kind: 'conversation', nativeId: FORUM });
    expect(h.of('leave').filter((e) => e.nativeId === FORUM)).toHaveLength(1);
    expect(convs.get(NEWS)).toMatchObject({ shape: 'group', variant: 'announcement', mute: { level: 'none' } });
    for (const [t, name] of [[1, 'General'], [2, 'Releases'], [4, 'Bugs']] as const) {
      expect(convs.get(`${FORUM}/${t}`)).toMatchObject({ shape: 'channel', name, spaces: [{ nativeId: FORUM, position: `1:${String(t).padStart(12, '0')}` }] });
      expect(convs.get(`${FORUM}/${t}`)!.parentConversation).toBeUndefined();
    }
    // Reads of the forum as a whole are not the hub's: the topics carry their own.
    expect(h.of('read').some((e) => e.conversation === FORUM)).toBe(false);
    const ids = new Map(h.of('identity').map((e) => [e.identity.nativeId, e.identity]));
    expect(ids.get(String(FAKE_IDS.alice))).toMatchObject({ displayName: 'Alice Liddell', handle: '@alice', contact: true });
    expect(ids.get(String(FAKE_IDS.carol))).toMatchObject({ handle: '@carol_c' });
    expect(ids.get(String(FAKE_IDS.carol))!.contact).toBeUndefined();
    expect(ids.get(String(FAKE_IDS.bot))).toMatchObject({ isBot: true });
    expect(h.of('read').find((e) => e.conversation === DM_ALICE)).toMatchObject({ unread: 1 });
    expect(h.of('read').find((e) => e.conversation === DEVS)).toMatchObject({ unread: 0, upToTs: expect.any(Number) });
    const tops = h.events.filter((e): e is Extract<Ev, { t: 'message' }> => e.t === 'message');
    expect(tops.every((e) => e.live === false)).toBe(true);
    expect(tops.find((e) => e.message.nativeId === `${DM_ALICE}#3`)?.message).toMatchObject({ replyTo: `${DM_ALICE}#2`, reactions: [{ key: '❤️', authors: [String(S)] }] });
    expect(tops.find((e) => e.message.conversation === `${FORUM}/4`)?.message).toMatchObject({ body: 'found a crash', author: String(FAKE_IDS.bob) });
    expect(h.status!.details).toMatchObject({ chats: 7, forums: 1 });
  });

  test('send: Markdown as entities, the echo as a message fact, replies, topics', async () => {
    const n = h.events.length;
    const r = (await h.cmd({ t: 'send', conversation: DM_ALICE, body: 'see **you** at <@5000002>' })) as { nativeId: string };
    expect(r.nativeId).toMatch(new RegExp(`^${DM_ALICE}#\\d+$`));
    const echo = h.since(n).find((e): e is Extract<Ev, { t: 'message' }> => e.t === 'message' && e.message.nativeId === r.nativeId)!;
    expect(echo).toMatchObject({ live: true, message: { author: String(S), body: 'see **you** at <@5000002>', conversation: DM_ALICE } });
    const stored = h.fake.world.msgs[`user:${FAKE_IDS.alice}`].at(-1)!;
    expect(stored.text).toBe('see you at Alice Liddell');
    expect(stored.entities!.map((e) => e._)).toEqual(['messageEntityBold', 'messageEntityMentionName']);

    const reply = (await h.cmd({ t: 'send', conversation: GROUP, body: 'me!', replyTo: `${GROUP}#7` })) as { nativeId: string };
    expect(h.fake.world.msgs[`chat:${FAKE_IDS.group}`].at(-1)).toMatchObject({ text: 'me!', replyTo: 7 });
    expect(h.events.find((e) => e.t === 'message' && e.message.nativeId === reply.nativeId)).toMatchObject({ message: { replyTo: `${GROUP}#7` } });

    const inTopic = (await h.cmd({ t: 'send', conversation: `${FORUM}/2`, body: 'v0.2 too' })) as { nativeId: string };
    expect(h.fake.world.msgs[`channel:${FAKE_IDS.forum}`].at(-1)).toMatchObject({ text: 'v0.2 too', topic: 2 });
    expect(h.events.find((e) => e.t === 'message' && e.message.nativeId === inTopic.nativeId)).toMatchObject({ message: { conversation: `${FORUM}/2` } });
    await h.cmd({ t: 'send', conversation: `${FORUM}/1`, body: 'in general' });
    expect(h.fake.world.msgs[`channel:${FAKE_IDS.forum}`].at(-1)).toMatchObject({ text: 'in general', topic: 1 });
    expect(await h.cmd({ t: 'send', conversation: FORUM, body: 'x' }).catch((e) => e.message)).toBe('Pick a topic of this forum to write in');
    expect(await h.cmd({ t: 'send', conversation: NEWS, body: 'x' }).catch((e) => e.message)).toContain('CHAT_WRITE_FORBIDDEN');
  });

  test('a bot answers: an incoming message is a live fact', async () => {
    const n = h.events.length;
    await h.cmd({ t: 'send', conversation: DM_BOT, body: 'ping' });
    await h.until(() => h.since(n).some((e) => e.t === 'message' && e.message.author === String(FAKE_IDS.bot)), 'the answer');
    const ans = h.since(n).find((e): e is Extract<Ev, { t: 'message' }> => e.t === 'message' && e.message.author === String(FAKE_IDS.bot))!;
    expect(ans).toMatchObject({ live: true, message: { body: 'You said: ping', conversation: DM_BOT, mentionsSelf: true } });
  });

  test('files: one as a photo, several as an album, and fetchMedia gives the bytes back', async () => {
    const n = h.events.length;
    const one = (await h.cmd({ t: 'send', conversation: DM_BOB, body: 'look', attachments: [attachment()] })) as { nativeId: string };
    const fact = h.since(n).find((e): e is Extract<Ev, { t: 'message' }> => e.t === 'message' && e.message.nativeId === one.nativeId)!.message;
    expect(fact).toMatchObject({ body: 'look', kind: 'media', attachments: [{ kind: 'image', mime: 'image/jpeg' }] });
    const got = (await h.cmd({ t: 'fetchMedia', url: fact.attachments![0].url })) as { mime: string; base64: string };
    expect(Buffer.from(got.base64, 'base64')).toEqual(readFileSync(file));
    const m = h.events.length;
    await h.cmd({ t: 'send', conversation: DM_BOB, body: 'two', attachments: [attachment('a.png'), attachment('b.png')] });
    const album = h.since(m).filter((e): e is Extract<Ev, { t: 'message' }> => e.t === 'message');
    expect(album.length).toBe(2);
    expect(album[0].message.extra?.album).toBeDefined();
    expect(album[0].message.extra?.album).toBe(album[1].message.extra?.album);
    expect(album.map((e) => e.message.body)).toEqual(['two', '']);
    expect(h.fake.calls.filter((c) => c.method === 'messages.uploadMedia').length).toBe(2);
    // An avatar
    const av = (await h.cmd({ t: 'fetchMedia', url: `tg://avatar/u${FAKE_IDS.alice}/9101?dc=2` })) as { mime: string; base64: string };
    expect(av.mime).toBe('image/jpeg');
    expect(Buffer.from(av.base64, 'base64').subarray(1, 4).toString()).toBe('PNG');
    expect(await h.cmd({ t: 'fetchMedia', url: 'https://x' }).catch((e) => e.message)).toBe('not a Telegram media URL: https://x');
  });

  test('edit and delete your message', async () => {
    const { nativeId } = (await h.cmd({ t: 'send', conversation: DEVS, body: 'typo' })) as { nativeId: string };
    const n = h.events.length;
    await h.cmd({ t: 'edit', conversation: DEVS, message: nativeId, body: 'fixed *now*' });
    const edited = h.since(n).find((e): e is Extract<Ev, { t: 'message' }> => e.t === 'message' && e.message.nativeId === nativeId)!;
    expect(edited.message).toMatchObject({ body: 'fixed *now*' });
    expect(edited.message.editedTs).toBeGreaterThan(0);
    expect(await h.cmd({ t: 'edit', conversation: DEVS, message: `${DEVS}#1`, body: 'not mine' }).catch((e) => e.message)).toContain('MESSAGE_AUTHOR_REQUIRED');
    await h.cmd({ t: 'redact', conversation: DEVS, message: nativeId });
    expect(h.since(n).find((e) => e.t === 'delete')).toEqual({ t: 'delete', conversation: DEVS, nativeId });
    expect(h.fake.world.msgs[`channel:${FAKE_IDS.devs}`].some((m) => `${DEVS}#${m.id}` === nativeId)).toBe(false);
  });

  test('react: one reaction each, replaced or removed; who reacted', async () => {
    const msg = `${DEVS}#1`;
    let n = h.events.length;
    await h.cmd({ t: 'react', conversation: DEVS, message: msg, key: '👍' });
    await h.until(() => h.since(n).some((e) => e.t === 'reaction'), 'the reaction');
    expect(h.since(n).find((e) => e.t === 'reaction')).toEqual({ t: 'reaction', conversation: DEVS, message: msg, author: String(S), key: '👍' });
    await h.until(() => h.since(n).some((e) => e.t === 'message' && e.message.nativeId === msg), 'the snapshot');
    expect(h.since(n).find((e): e is Extract<Ev, { t: 'message' }> => e.t === 'message' && e.message.nativeId === msg)).toMatchObject({ live: false, message: { reactions: [{ key: '👍', authors: [String(S)] }] } });
    n = h.events.length;
    await h.cmd({ t: 'react', conversation: DEVS, message: msg, key: '🔥' });
    await h.until(() => h.since(n).filter((e) => e.t === 'reaction').length >= 2, 'replaced');
    expect(h.since(n).filter((e) => e.t === 'reaction').map((e) => [(e as any).key, !!(e as any).remove])).toEqual([
      ['🔥', false],
      ['👍', true],
    ]);
    expect(await h.cmd({ t: 'reactors', conversation: DEVS, message: msg, key: '🔥' })).toEqual({ authors: [String(S)] });
    n = h.events.length;
    await h.cmd({ t: 'react', conversation: DEVS, message: msg, key: '🔥', remove: true });
    await h.until(() => h.since(n).some((e) => e.t === 'reaction'), 'removed');
    expect(h.since(n).find((e) => e.t === 'reaction')).toMatchObject({ key: '🔥', remove: true });
    expect(h.fake.world.msgs[`channel:${FAKE_IDS.devs}`][0].reactions).toEqual({});
    expect(await h.cmd({ t: 'reactionContext', conversation: DEVS })).toEqual({ canReact: true, custom: [] });
  });

  test('markRead, typing (no more than Telegram’s own apps send), history', async () => {
    await h.cmd({ t: 'markRead', conversation: DM_ALICE, upTo: `${DM_ALICE}#3` });
    expect(h.fake.world.read[`user:${FAKE_IDS.alice}`].inbox).toBe(3);
    await h.cmd({ t: 'markRead', conversation: DEVS, upTo: `${DEVS}#3` });
    expect(h.fake.calls.at(-1)!.method).toBe('channels.readHistory');
    await h.cmd({ t: 'markRead', conversation: `${FORUM}/2`, upTo: `${FORUM}#3` });
    expect(h.fake.calls.at(-1)).toMatchObject({ method: 'messages.readDiscussion', req: { msgId: 2, readMaxId: 3 } });
    const before = h.fake.calls.filter((c) => c.method === 'messages.setTyping').length;
    await h.cmd({ t: 'typing', conversation: GROUP });
    await h.cmd({ t: 'typing', conversation: GROUP });
    await h.cmd({ t: 'typing', conversation: GROUP, stop: true });
    const typing = h.fake.calls.filter((c) => c.method === 'messages.setTyping').slice(before);
    expect(typing.map((c) => (c.req as any).action._)).toEqual(['sendMessageTypingAction', 'sendMessageCancelAction']);
    const n = h.events.length;
    expect(await h.cmd({ t: 'history', conversation: DEVS, limit: 2 })).toEqual({ count: 2, done: false });
    expect(await h.cmd({ t: 'history', conversation: DEVS, limit: 50 })).toMatchObject({ done: true });
    const hist = h.since(n).filter((e): e is Extract<Ev, { t: 'message' }> => e.t === 'message');
    expect(hist.every((e) => !e.live)).toBe(true);
    expect(hist.some((e) => e.message.nativeId === `${DEVS}#1`)).toBe(true);
    const m = h.events.length;
    await h.cmd({ t: 'history', conversation: `${FORUM}/4`, limit: 20 });
    expect(new Set(h.since(m).filter((e): e is Extract<Ev, { t: 'message' }> => e.t === 'message').map((e) => e.message.conversation))).toEqual(new Set([`${FORUM}/4`]));
    expect(h.fake.calls.at(-1)!.method).toBe('messages.getReplies');
  });

  test('search: words everywhere, people in a chat or anywhere, has:, a topic, dates; what Telegram cannot do, in words', async () => {
    const search = (query: P.NetworkQuery) => h.cmd({ t: 'search', scope: { kind: 'all' }, query, limit: 25 }) as Promise<P.NetworkSearchResult>;
    const n = h.events.length;
    const words = await search({ text: 'welcome' });
    expect(words.hits).toEqual(expect.arrayContaining([`${DEVS}#1`, `${NEWS}#1`]));
    expect(words.next).toBeNull();
    expect(h.fake.calls.at(-1)!.method).toBe('messages.searchGlobal');
    // The hits' facts came first, as history.
    const facts = h.since(n).filter((e): e is Extract<Ev, { t: 'message' }> => e.t === 'message');
    expect(facts.map((e) => e.message.nativeId)).toEqual(expect.arrayContaining(words.hits));
    expect(facts.every((e) => !e.live)).toBe(true);
    // "quoted" is not Telegram's syntax: the words still match.
    expect((await search({ text: '"big news"' })).hits).toEqual([`${NEWS}#2`]);

    const inGroup = await search({ text: '', authors: [String(FAKE_IDS.alice)], in: [GROUP] });
    expect(inGroup.hits).toEqual([`${GROUP}#7`]);
    expect(h.fake.calls.at(-1)).toMatchObject({ method: 'messages.search', req: { fromId: { _: 'inputPeerUser' } } });
    // Someone anywhere: private chats and groups at once, and with words, the global search held to them.
    const anywhere = await search({ text: 'saturday', authors: [String(FAKE_IDS.alice)] });
    expect(anywhere.hits).toContain(`${DM_ALICE}#1`);
    expect(h.fake.calls.slice(-2).map((c) => c.method)).toEqual(['messages.search', 'messages.searchGlobal']);
    expect((await search({ text: '', authors: [String(FAKE_IDS.bob)] })).hits).toEqual(expect.arrayContaining([`${DM_BOB}#4`, `${GROUP}#8`]));

    const images = (await search({ text: '', has: ['image'] })).hits;
    expect(images).toContain(`${DM_BOB}#4`);
    expect(images).not.toContain(`${DM_ALICE}#1`);
    expect(h.fake.calls.at(-1)).toMatchObject({ method: 'messages.searchGlobal', req: { filter: { _: 'inputMessagesFilterPhotos' } } });
    expect((await search({ text: 'crash', in: [`${FORUM}/4`] })).hits).toEqual([`${FORUM}#5`]);
    expect(h.fake.calls.at(-1)).toMatchObject({ method: 'messages.search', req: { topMsgId: 4 } });
    const t = (await search({ text: 'welcome', in: [DEVS] })).hits;
    expect(t).toEqual([`${DEVS}#1`]);
    const at = h.of('message').find((e) => e.message.nativeId === `${DEVS}#1`)!.message.ts;
    expect((await search({ text: 'welcome', in: [DEVS], after: at + 1 })).hits).toEqual([]);
    expect((await search({ text: 'welcome', in: [DEVS], before: at + 1 })).hits).toEqual([`${DEVS}#1`]);
    expect((await search({ text: 'welcome', in: [`dm:999:${FAKE_IDS.alice}`] })).hits).toEqual([]);

    await expect(search({ text: 'x', has: ['sticker'] })).rejects.toThrow('has:sticker');
    await expect(search({ text: 'x', mentions: [String(FAKE_IDS.bob)] })).rejects.toThrow('mentions of you only');
    await expect(search({ text: 'x', has: ['image', 'link'] })).rejects.toThrow('one kind at a time');
  });

  test('openDirect: by @username, phone or id; a public group; nobody', async () => {
    expect(await h.cmd({ t: 'openDirect', peer: '@carol_c' })).toEqual({ conversation: `dm:${S}:${FAKE_IDS.carol}`, existed: false, startsAtFirstSend: true });
    expect(h.of('conversation').some((e) => e.conversation.nativeId === `dm:${S}:${FAKE_IDS.carol}` && e.conversation.shape === 'direct')).toBe(true);
    expect(await h.cmd({ t: 'openDirect', peer: '+999 662 0001' })).toEqual({ conversation: DM_ALICE, existed: true });
    expect(await h.cmd({ t: 'openDirect', peer: String(FAKE_IDS.bob) })).toEqual({ conversation: DM_BOB, existed: true });
    expect(await h.cmd({ t: 'openDirect', peer: '@ditherdevs' })).toEqual({ conversation: DEVS, existed: true });
    expect(await h.cmd({ t: 'openDirect', peer: '@nobody_here' }).catch((e) => e.message)).toBe('No one on Telegram is @nobody_here');
    expect(await h.cmd({ t: 'openDirect', peer: '+15550000000' }).catch((e) => e.message)).toContain('No Telegram account has that number');
    expect(await h.cmd({ t: 'openDirect', peer: '987654' }).catch((e) => e.message)).toContain('use their @username or phone number');
  });

  test('forward, with a note; a chat that forbids it answers with a fallback', async () => {
    const n = h.events.length;
    const r = (await h.cmd({ t: 'forward', conversation: DEVS, source: { conversation: DM_ALICE, message: `${DM_ALICE}#1` }, note: 'from Alice' })) as { nativeId: string };
    expect(r.nativeId).toMatch(new RegExp(`^${DEVS}#\\d+$`));
    const msgs = h.since(n).filter((e): e is Extract<Ev, { t: 'message' }> => e.t === 'message');
    expect(msgs.map((e) => e.message.body)).toEqual(['from Alice', 'Hi! Are we still on for Saturday?']);
    expect(msgs[1].message.forward).toMatchObject({ author: String(FAKE_IDS.alice) });
    expect(await h.cmd({ t: 'forward', conversation: DEVS, source: { conversation: NEWS, message: `${NEWS}#1` } })).toEqual({ fallback: 'This chat does not let its messages be forwarded' });
  });

  test('about and configure: a supergroup you admin', async () => {
    const about = (await h.cmd({ t: 'about', target: { kind: 'conversation', nativeId: DEVS } })) as P.About;
    expect(about.noun).toBe('Group');
    expect(about.fields.name).toEqual({ value: 'dither devs', canEdit: true });
    expect(about.fields.topic).toEqual({ value: 'Talk about dither', canEdit: true });
    expect(about.fields.slowMode).toEqual({ value: 0, canEdit: true });
    expect(about.fields.joinApproval).toEqual({ value: false, canEdit: true });
    expect(about.members!.list.find((m) => m.id === String(FAKE_IDS.alice))).toMatchObject({ role: 'Owner' });
    expect(about.members!.list.find((m) => m.id === String(S))).toMatchObject({ role: 'Admin' });
    expect(about.members).toMatchObject({ total: 4, complete: true });
    expect(about.pinned).toEqual({ messages: [`${DEVS}#2`], canEdit: true });
    expect(about.invite).toMatchObject({ link: 'https://t.me/ditherdevs', canCreate: true, derived: true });
    expect(about.facts).toContainEqual({ label: 'Public link', value: 't.me/ditherdevs' });

    let n = h.events.length;
    const renamed = (await h.cmd({ t: 'configure', target: { kind: 'conversation', nativeId: DEVS }, change: { key: 'name', value: 'dither developers' } })) as P.About;
    expect(renamed.fields.name!.value).toBe('dither developers');
    expect(h.since(n).find((e) => e.t === 'conversation' && e.conversation.nativeId === DEVS)).toMatchObject({ conversation: { name: 'dither developers' } });
    expect(((await h.cmd({ t: 'configure', target: { kind: 'conversation', nativeId: DEVS }, change: { key: 'topic', value: 'New about' } })) as P.About).fields.topic!.value).toBe('New about');
    expect(((await h.cmd({ t: 'configure', target: { kind: 'conversation', nativeId: DEVS }, change: { key: 'slowMode', value: 30 } })) as P.About).fields.slowMode!.value).toBe(30);
    expect(((await h.cmd({ t: 'configure', target: { kind: 'conversation', nativeId: DEVS }, change: { key: 'joinApproval', value: true } })) as P.About).fields.joinApproval!.value).toBe(true);
    const made = (await h.cmd({ t: 'configure', target: { kind: 'conversation', nativeId: DEVS }, change: { key: 'invite', op: 'create' } })) as P.About;
    expect(made.invite!.link).toMatch(/^https:\/\/t\.me\/\+/);
    const revoked = (await h.cmd({ t: 'configure', target: { kind: 'conversation', nativeId: DEVS }, change: { key: 'invite', op: 'revoke' } })) as P.About;
    expect(revoked.invite!.link).toBe('https://t.me/ditherdevs');
    n = h.events.length;
    const pinned = (await h.cmd({ t: 'configure', target: { kind: 'conversation', nativeId: DEVS }, change: { key: 'pin', message: `${DEVS}#1` } })) as P.About;
    expect(pinned.pinned!.messages.sort()).toEqual([`${DEVS}#1`, `${DEVS}#2`]);
    expect(h.since(n).find((e) => e.t === 'pin')).toMatchObject({ conversation: DEVS, message: `${DEVS}#1`, pinned: true });
    // A topic's name
    n = h.events.length;
    const topic = (await h.cmd({ t: 'configure', target: { kind: 'conversation', nativeId: `${FORUM}/2` }, change: { key: 'name', value: 'Releases & notes' } })) as P.About;
    expect(topic).toMatchObject({ noun: 'Topic', fields: { name: { value: 'Releases & notes', canEdit: true } } });
    expect(h.since(n).some((e) => e.t === 'conversation' && e.conversation.nativeId === `${FORUM}/2` && e.conversation.name === 'Releases & notes')).toBe(true);
  });

  test('about: a basic group, a channel you only read, a private chat', async () => {
    const g = (await h.cmd({ t: 'about', target: { kind: 'conversation', nativeId: GROUP } })) as P.About;
    expect(g).toMatchObject({ noun: 'Group', members: { total: 3, complete: true }, you: { role: 'Member' } });
    expect(g.fields.name).toEqual({ value: 'Weekend plans', canEdit: false, reason: 'Only admins can change this group’s info' });
    // A forum is a space to the hub: its About is asked of the space.
    expect((await h.cmd({ t: 'about', target: { kind: 'space', nativeId: FORUM } })) as P.About).toMatchObject({ noun: 'Forum' });
    await expect(h.cmd({ t: 'about', target: { kind: 'space', nativeId: DEVS } })).rejects.toThrow('only a forum is one');
    const c = (await h.cmd({ t: 'about', target: { kind: 'conversation', nativeId: NEWS } })) as P.About;
    expect(c).toMatchObject({ noun: 'Channel', you: { role: 'Subscriber' } });
    expect(c.fields.name!.canEdit).toBe(false);
    expect(c.fields.slowMode).toBeUndefined();
    expect(c.members).toBeUndefined();
    const d = (await h.cmd({ t: 'about', target: { kind: 'conversation', nativeId: DM_ALICE } })) as P.About;
    expect(d).toMatchObject({ noun: 'Chat', members: { list: [{ id: String(S) }, { id: String(FAKE_IDS.alice) }], complete: true } });
    expect(await h.cmd({ t: 'configure', target: { kind: 'conversation', nativeId: DM_ALICE }, change: { key: 'name', value: 'x' } }).catch((e) => e.message)).toBe('A private chat has no settings to change');
  });

  test('profile: someone else, and you', async () => {
    const p = (await h.cmd({ t: 'profile', who: String(FAKE_IDS.alice) })) as P.PersonAbout;
    expect(p).toMatchObject({ displayName: 'Alice Liddell', handle: '@alice', bio: 'Down the rabbit hole', relationship: 'contact' });
    expect(p.links).toContainEqual({ label: 'Username', value: '@alice', url: 'https://t.me/alice' });
    expect(p.facts).toContainEqual({ label: 'Groups in common', value: '3' });
    const me = (await h.cmd({ t: 'profile', who: String(S) })) as P.PersonAbout;
    expect(me.friends!.sort()).toEqual([String(FAKE_IDS.alice), String(FAKE_IDS.bob)]);
    expect((await h.cmd({ t: 'profile', who: `channel:${FAKE_IDS.news}` })) as P.PersonAbout).toMatchObject({ displayName: 'Announcements', handle: '@ditherNews' });
  });

  test("Telegram's updates as events: messages, edits, deletes, reactions, typing, receipts, pins, renames", async () => {
    let n = h.events.length;
    const { id } = (await h.fake.control({ op: 'incoming', peer: `user:${FAKE_IDS.alice}`, from: FAKE_IDS.alice, text: 'are you there?' })) as { id: number };
    await h.until(() => h.since(n).some((e) => e.t === 'message'), 'the message');
    expect(h.since(n).find((e) => e.t === 'message')).toEqual({ t: 'message', live: true, message: { nativeId: `${DM_ALICE}#${id}`, conversation: DM_ALICE, author: String(FAKE_IDS.alice), ts: expect.any(Number), body: 'are you there?' } });
    n = h.events.length;
    await h.fake.control({ op: 'edit', peer: `user:${FAKE_IDS.alice}`, id, text: 'are you there??' });
    await h.until(() => h.since(n).some((e) => e.t === 'message'), 'the edit');
    expect(h.since(n).find((e) => e.t === 'message')).toMatchObject({ message: { body: 'are you there??', editedTs: expect.any(Number) } });
    n = h.events.length;
    await h.fake.control({ op: 'react', peer: `user:${FAKE_IDS.alice}`, id, from: FAKE_IDS.alice, key: '😂' });
    await h.until(() => h.since(n).some((e) => e.t === 'reaction'), 'the reaction');
    expect(h.since(n).find((e) => e.t === 'reaction')).toEqual({ t: 'reaction', conversation: DM_ALICE, message: `${DM_ALICE}#${id}`, author: String(FAKE_IDS.alice), key: '😂' });
    n = h.events.length;
    await h.fake.control({ op: 'delete', peer: `user:${FAKE_IDS.alice}`, ids: [id] });
    await h.until(() => h.since(n).some((e) => e.t === 'delete'), 'the delete');
    // Telegram names only the message id here; the adapter knows where it was.
    expect(h.since(n).find((e) => e.t === 'delete')).toEqual({ t: 'delete', conversation: DM_ALICE, nativeId: `${DM_ALICE}#${id}` });
    n = h.events.length;
    await h.fake.control({ op: 'typing', peer: `channel:${FAKE_IDS.forum}`, from: FAKE_IDS.bob, topic: 4 });
    await h.until(() => h.since(n).some((e) => e.t === 'typing'), 'typing');
    expect(h.since(n).find((e) => e.t === 'typing')).toEqual({ t: 'typing', conversation: `${FORUM}/4`, author: String(FAKE_IDS.bob), ttl: 6000, name: 'Bob' });
    n = h.events.length;
    await h.fake.control({ op: 'typing', peer: `user:${FAKE_IDS.alice}`, from: FAKE_IDS.alice, stop: true });
    await h.until(() => h.since(n).some((e) => e.t === 'typing'), 'typing stopped');
    expect(h.since(n).find((e) => e.t === 'typing')).toMatchObject({ conversation: DM_ALICE, stop: true });
    // Alice reads what you sent her
    const mine = (await h.cmd({ t: 'send', conversation: DM_ALICE, body: 'read me' })) as { nativeId: string };
    n = h.events.length;
    await h.fake.control({ op: 'readOutbox', peer: `user:${FAKE_IDS.alice}`, maxId: Number(mine.nativeId.split('#')[1]) });
    await h.until(() => h.since(n).some((e) => e.t === 'receipt'), 'the receipt');
    const receipt = h.since(n).find((e): e is Extract<Ev, { t: 'receipt' }> => e.t === 'receipt')!;
    expect(receipt).toMatchObject({ conversation: DM_ALICE, who: String(FAKE_IDS.alice), state: 'read' });
    expect(receipt.messages).toContain(mine.nativeId);
    n = h.events.length;
    await h.fake.control({ op: 'pin', peer: `chat:${FAKE_IDS.group}`, id: 7, pinned: true });
    await h.until(() => h.since(n).some((e) => e.t === 'pin'), 'the pin');
    expect(h.since(n).find((e) => e.t === 'pin')).toEqual({ t: 'pin', conversation: GROUP, message: `${GROUP}#7`, pinned: true });
    n = h.events.length;
    await h.fake.control({ op: 'rename', peer: `channel:${FAKE_IDS.news}`, title: 'Announcements!' });
    await h.until(() => h.since(n).some((e) => e.t === 'conversation' && e.conversation.nativeId === NEWS), 'the rename');
    expect(h.since(n).find((e) => e.t === 'conversation' && e.conversation.nativeId === NEWS)).toMatchObject({ conversation: { name: 'Announcements!', variant: 'announcement' } });
    // A message in a forum topic, and one in General
    n = h.events.length;
    await h.fake.control({ op: 'incoming', peer: `channel:${FAKE_IDS.forum}`, from: FAKE_IDS.alice, text: 'another bug', topic: 4 });
    await h.fake.control({ op: 'incoming', peer: `channel:${FAKE_IDS.forum}`, from: FAKE_IDS.alice, text: 'general chat', topic: 1 });
    await h.until(() => h.since(n).filter((e) => e.t === 'message').length >= 2, 'both');
    expect(h.since(n).filter((e): e is Extract<Ev, { t: 'message' }> => e.t === 'message').map((e) => e.message.conversation)).toEqual([`${FORUM}/4`, `${FORUM}/1`]);
  });

  test("mentionables: a group's people, a supergroup's from Telegram's member search for letters typed, nobody in a broadcast channel; no identity goes out", async () => {
    expect(h.of('hello').at(-1)!.capabilities).toContain('mentionables');
    const n = h.events.length;
    const ask = (conversation: string, query: string) => h.cmd({ t: 'mentionables', conversation, query, limit: 20 }) as Promise<P.Mentionables>;
    const group = await ask(GROUP, '');
    expect(group.people.map((p) => p.nativeId)).toEqual([String(FAKE_IDS.alice), String(FAKE_IDS.bob)]);
    expect(group.people[0]).toMatchObject({ handle: '@alice', avatar: `tg://avatar/u${FAKE_IDS.alice}/9101?dc=2` });
    expect(group.everyone).toBe(false);
    expect((await ask(GROUP, '@bo')).people.map((p) => p.handle)).toEqual(['@bob']);
    // A supergroup: no member search with nothing typed (the hub knows who wrote there); with letters, Telegram's own.
    expect(await ask(DEVS, '')).toEqual({ people: [], everyone: false });
    expect((await ask(DEVS, 'car')).people.map((p) => p.handle)).toEqual(['@carol_c']);
    expect(await ask(NEWS, 'a')).toEqual({ people: [], everyone: false });
    expect((await ask(DM_ALICE, '')).people.map((p) => p.nativeId)).toEqual([String(FAKE_IDS.alice)]);
    expect(h.since(n).filter((e) => e.t === 'identity')).toEqual([]);
  });

  test('errors: what does not belong to this account, FLOOD_WAIT in words and in the status', async () => {
    expect(await h.cmd({ t: 'send', conversation: 'dm:1:2', body: 'x' }).catch((e) => e.message)).toBe('that conversation belongs to another Telegram account');
    expect(await h.cmd({ t: 'send', conversation: 'nonsense', body: 'x' }).catch((e) => e.message)).toBe('not a Telegram conversation: nonsense');
    expect(await h.cmd({ t: 'redact', conversation: DEVS, message: 'x' }).catch((e) => e.message)).toBe('not a Telegram message: x');
    expect(await h.cmd({ t: 'call', call: 'c', op: 'leave' }).catch((e) => e.message)).toBe('Telegram calls are not supported');
    expect(await h.action('nope').catch((e) => e.message)).toStartWith('unknown action "nope"');
    expect(await h.action('refreshLink').catch((e) => e.message)).toContain('Already signed in');
    await h.fake.control({ op: 'flood', method: 'messages.sendMessage', seconds: 120 });
    expect(await h.cmd({ t: 'send', conversation: DEVS, body: 'x' }).catch((e) => e.message)).toBe('Telegram asks this account to wait 120 s before more messages.sendMessage');
    await h.until(() => /messages\.sendMessage/.test(String(h.status?.details?.floodWait)), 'the wait in the status');
    expect(h.status!.layers!.at(-1)).toMatchObject({ name: 'updates', state: 'waiting', note: expect.stringContaining('messages.sendMessage') });
    expect(h.logs.some((l) => l.includes('FLOOD_WAIT'))).toBe(true);
    // Other methods are not held
    expect(await h.cmd({ t: 'markRead', conversation: DEVS, upTo: `${DEVS}#1` })).toEqual({});
    expect(((await h.action('status')) as any).held['messages.sendMessage']).toBeGreaterThan(100);
  });
});

describe('adding: facts before the answer, requests only once known', () => {
  const tg = { network: 'telegram' } as const;
  const invite = (code: string) => ({ ...tg, kind: 'invite', code, url: `https://t.me/+${code}` });

  test('each answer comes after the facts it names: identity, conversation, contact, requestGone', async () => {
    const h = new Harness(tmp());
    try {
      await h.signIn();
      await h.until(() => h.of('requests').length, 'the requests list');
      // A lookup: the identity is out by the time the preview is.
      let n = h.events.length;
      const p = (await h.cmd({ t: 'resolve', ref: { ...tg, kind: 'name', name: 'opennotes' } })) as P.AddPreview;
      expect(p.nativeId).toBe(`channel:${FAKE_IDS.open}`);
      expect(h.since(n).some((e) => e.t === 'identity' && e.identity.nativeId === `channel:${FAKE_IDS.open}`)).toBe(true);
      // A join: the conversation, its last message and read state, then the answer.
      n = h.events.length;
      const joined = (await h.cmd({ t: 'add', ref: invite(FAKE_INVITES.film), action: 'join' })) as P.AddResult;
      const conv = `channel:${FAKE_IDS.film}`;
      expect(joined).toEqual({ conversation: conv });
      const out = h.since(n);
      const ci = out.findIndex((e) => e.t === 'conversation' && e.conversation.nativeId === conv);
      expect(ci).toBeGreaterThanOrEqual(0);
      expect(out.findIndex((e) => e.t === 'message' && e.message.conversation === conv)).toBeGreaterThan(ci);
      expect(out.some((e) => e.t === 'read' && e.conversation === conv)).toBe(true);
      expect(h.adapter.state.dialogs.has(conv)).toBe(true);
      // A contact: the identity as a contact, then the answer.
      n = h.events.length;
      await h.cmd({ t: 'add', ref: { ...tg, kind: 'name', name: 'erin_e' }, action: 'contact' });
      expect(h.since(n).find((e) => e.t === 'identity' && e.identity.nativeId === String(FAKE_IDS.erin))).toMatchObject({ identity: { contact: true } });
      const sent = h.fake.calls.filter((c) => c.method === 'contacts.addContact').at(-1)!.req as Record<string, unknown>;
      expect(sent.addPhonePrivacyException).toBe(false);
      // An answer: requestGone, then the answer; Telegram's update after it changes nothing more.
      const id = `join:channel:${FAKE_IDS.devs}:${FAKE_IDS.erin}`;
      n = h.events.length;
      await h.cmd({ t: 'answer', request: id, answer: 'accept' });
      expect(h.since(n).filter((e) => e.t === 'requestGone').map((e) => e.nativeId)).toEqual([id]);
      await Bun.sleep(100);
      expect(h.since(n).filter((e) => e.t === 'request' || e.t === 'requestGone').length).toBe(1);
    } finally {
      await h.stop();
    }
  });

  test('a peek and a bot check: in it for now; a check, nothing done', async () => {
    const h = new Harness(tmp());
    try {
      await h.signIn();
      const peek = (await h.cmd({ t: 'resolve', ref: invite(FAKE_INVITES.peek) })) as P.AddPreview;
      expect(peek).toMatchObject({ joined: { conversation: `channel:${FAKE_IDS.peek}` }, actions: ['join'] });
      expect(h.adapter.state.dialogs.has(`channel:${FAKE_IDS.peek}`)).toBe(false);
      const check = (await h.cmd({ t: 'add', ref: invite(FAKE_INVITES.checked), action: 'join' })) as P.AddResult;
      expect(check.check).toBe('captcha');
      expect(h.fake.world.chats.find((c) => c.id === FAKE_IDS.checked)!.members).not.toContain(S);
      // Not Telegram's: friend and follow, a Matrix address.
      expect(await h.cmd({ t: 'add', ref: { ...tg, kind: 'name', name: 'dave_d' }, action: 'friend' }).catch((e) => e.message)).toBe('Telegram has no friend requests: Add contact instead');
      expect(await h.cmd({ t: 'resolve', ref: { kind: 'place', network: 'matrix', address: '#a:example.org' } }).catch((e) => e.message)).toBe('That is not a Telegram link, name or number');
    } finally {
      await h.stop();
    }
  });

  test('a chat whose requests could not be read: what was found goes out as request, no requests list', async () => {
    const h = new Harness(tmp());
    try {
      await h.fake.control({ op: 'fail', method: 'messages.getChatInviteImporters', error: 'INTERNAL_SERVER_ERROR' });
      await h.signIn();
      await h.until(() => h.logs.some((l) => l.includes('join requests in')), 'the failed read logged');
      await h.until(() => h.of('request').length === 1, 'the one found');
      expect(h.of('requests')).toEqual([]);
      expect(h.status!.details!.joinRequests).toBeNull();
    } finally {
      await h.stop();
    }
  });

  test('no snapshot, no list: it does not know which chats it admins; the next snapshot that works lists them', async () => {
    const h = new Harness(tmp());
    try {
      await h.fake.control({ op: 'fail', method: 'messages.getDialogs', error: 'INTERNAL_SERVER_ERROR' });
      await h.signIn();
      await Bun.sleep(100);
      expect(h.logs.some((l) => l.includes('snapshot:'))).toBe(true);
      expect(h.of('requests').length + h.of('request').length).toBe(0);
      await h.action('resync');
      await h.until(() => h.of('requests').length === 1, 'the list after a snapshot');
      expect(h.of('requests')[0].requests.map((r) => r.nativeId).sort()).toEqual([`join:channel:${FAKE_IDS.devs}:${FAKE_IDS.erin}`, `join:channel:${FAKE_IDS.forum}:${FAKE_IDS.frank}`]);
      await Bun.sleep(50);
      expect(h.of('requests').length).toBe(1);
    } finally {
      await h.stop();
    }
  });
});

describe('contacts and blocks: relationships, changes, remove', () => {
  const ALICE = String(FAKE_IDS.alice);
  const BOB = String(FAKE_IDS.bob);
  const CAROL = String(FAKE_IDS.carol);
  const DAVE = String(FAKE_IDS.dave);
  const ERIN = String(FAKE_IDS.erin);
  const GRACE = String(FAKE_IDS.grace);
  /** No re-read by the clock unless a test asks; one soon after a sign. */
  const QUIET = { relations: { everyMs: 600_000, soonMs: 20, gapMs: 0 } };
  const byIdentity = (a: P.RelationshipFact, b: P.RelationshipFact) => a.identity.localeCompare(b.identity);
  const rels = (h: Harness, n = 0) => h.since(n).filter((e): e is Extract<Ev, { t: 'relationship' }> => e.t === 'relationship').map((e) => e.fact);
  const remove = (h: Harness, identity: string, relationship: P.PersonRelationship) => h.cmd({ t: 'remove', identity, relationship }) as Promise<P.AddResult>;
  const failure = (p: Promise<unknown>) => p.then(() => 'no error', (e) => String(e.message));
  const called = (h: Harness, method: string) => h.fake.calls.filter((c) => c.method === method);

  test("the hash of the contact list, as Telegram's apps fold it", () => {
    expect(contactsHash(0, []).toString()).toBe('0');
    expect(contactsHash(0, [5000003, 5000002]).toString()).toBe('163395811673430839');
    expect(contactsHash(1, [5000003, 5000001, 5000002]).toString()).toBe('-3162403624569787812');
  });

  test('after the snapshot: the whole list, contacts and blocked people, a blocked contact once as blocked, no chats; identities first', async () => {
    const h = new Harness(tmp(), { opts: QUIET });
    try {
      // Bob is a contact, and blocked (from a phone, before this account signed in).
      await h.fake.control({ op: 'block', user: FAKE_IDS.bob });
      await h.signIn();
      expect(h.of('hello')[0].capabilities).toEqual(expect.arrayContaining(['relationships', 'disconnect', 'connect']));
      const lists = h.of('relationships');
      expect(lists.length).toBe(1);
      expect([...lists[0].list].sort(byIdentity)).toEqual([
        { identity: ALICE, relationship: 'contact' },
        { identity: BOB, relationship: 'blocked', since: expect.any(Number) },
        { identity: GRACE, relationship: 'blocked', since: expect.any(Number) },
      ]);
      // Telegram's dates: when each was blocked.
      expect(lists[0].list.find((f) => f.identity === GRACE)!.since).toBe(h.fake.world.blocked!.find((b) => b.peer === `user:${FAKE_IDS.grace}`)!.date * 1000);
      // The blocked group is not a person; nobody else, and never you.
      expect(lists[0].list.map((f) => f.identity)).not.toContain(String(S));
      const at = h.events.indexOf(lists[0]);
      for (const who of [ALICE, BOB, GRACE]) expect(h.events.findIndex((e) => e.t === 'identity' && e.identity.nativeId === who)).toBeLessThan(at);
      // The first read of contacts asks for all of them (hash 0); both lists in their lanes, in the background.
      expect(String((called(h, 'contacts.getContacts')[0].req as { hash: unknown }).hash)).toBe('0');
      expect(called(h, 'contacts.getBlocked').length).toBe(1);
      expect(h.status!.details).toMatchObject({ contacts: 2, blocked: 2 });
      expect(rels(h)).toEqual([]);
      // The hub connecting again gets the list as it stands.
      const n = h.events.length;
      h.adapter.onHubConnect();
      expect(h.since(n).find((e) => e.t === 'relationships')).toEqual(lists[0]);
    } finally {
      await h.stop();
    }
  });

  test('a list that could not be read is not sent (never an empty one); the next snapshot that reads both sends it', async () => {
    const h = new Harness(tmp(), { opts: QUIET });
    try {
      await h.fake.control({ op: 'fail', method: 'contacts.getBlocked', error: 'INTERNAL_SERVER_ERROR' });
      await h.signIn();
      await Bun.sleep(50);
      expect(h.of('relationships')).toEqual([]);
      expect(rels(h)).toEqual([]);
      expect(h.logs.some((l) => l.includes('contacts and blocks not read'))).toBe(true);
      expect(h.status!.details).toMatchObject({ contacts: null, blocked: null });
      await h.fake.control({ op: 'fail', method: 'contacts.getContacts', error: 'INTERNAL_SERVER_ERROR' });
      await h.action('resync');
      expect(h.of('relationships')).toEqual([]);
      await h.action('resync');
      expect(h.of('relationships').length).toBe(1);
      expect(h.of('relationships')[0].list.map((f) => f.identity).sort()).toEqual([ALICE, BOB, GRACE].sort());
    } finally {
      await h.stop();
    }
  });

  test('changes: blocked and unblocked elsewhere (updatePeerBlocked), contacts added and removed elsewhere found by reading the lists again', async () => {
    const h = new Harness(tmp(), { opts: { relations: { everyMs: 150, soonMs: 20, gapMs: 0 } } });
    try {
      await h.signIn();
      await h.until(() => h.of('relationships').length, 'the list');
      // Read again with nothing changed: Telegram answers the list's hash with contactsNotModified, and nothing goes out.
      await h.until(() => called(h, 'contacts.getContacts').length >= 3, 'two reads again');
      expect(called(h, 'contacts.getContacts').slice(1).every((c) => String((c.req as { hash: unknown }).hash) !== '0')).toBe(true);
      expect(rels(h)).toEqual([]);
      let n = h.events.length;
      await h.fake.control({ op: 'block', user: FAKE_IDS.carol });
      await h.until(() => rels(h, n).length, 'Carol blocked');
      expect(rels(h, n)[0]).toEqual({ identity: CAROL, relationship: 'blocked' });
      await h.fake.control({ op: 'block', user: FAKE_IDS.grace, blocked: false });
      await h.until(() => rels(h, n).some((f) => f.identity === GRACE), 'Grace unblocked');
      expect(rels(h, n).find((f) => f.identity === GRACE)).toEqual({ identity: GRACE, relationship: 'stranger' });
      // No update for these: the next read of the lists finds them.
      n = h.events.length;
      await h.fake.control({ op: 'contact', user: FAKE_IDS.dave, silent: true });
      await h.fake.control({ op: 'contact', user: FAKE_IDS.alice, contact: false, silent: true });
      await h.until(() => rels(h, n).some((f) => f.identity === DAVE) && rels(h, n).some((f) => f.identity === ALICE), 'both found');
      expect(rels(h, n).filter((f) => f.identity === DAVE || f.identity === ALICE).sort(byIdentity)).toEqual([
        { identity: ALICE, relationship: 'stranger' },
        { identity: DAVE, relationship: 'contact' },
      ]);
      // Dave is known as a contact before his relationship is; Alice's identity is no contact's any more (Telegram sent
      // no user for her: the list said so).
      const di = h.events.findIndex((e, i) => i >= n && e.t === 'relationship' && e.fact.identity === DAVE);
      expect(h.events.findLastIndex((e, i) => i < di && e.t === 'identity' && e.identity.nativeId === DAVE && e.identity.contact === true)).toBeGreaterThanOrEqual(n);
      const ai = h.events.findIndex((e, i) => i >= n && e.t === 'relationship' && e.fact.identity === ALICE);
      const aliceNow = h.events.findLast((e, i): e is Extract<Ev, { t: 'identity' }> => i < ai && e.t === 'identity' && e.identity.nativeId === ALICE);
      expect(h.events.indexOf(aliceNow!)).toBeGreaterThanOrEqual(n);
      expect(aliceNow!.identity.contact).toBeUndefined();
      // Each change once: more reads find nothing more.
      const seen = rels(h, n).length;
      const reads = called(h, 'contacts.getContacts').length;
      await h.until(() => called(h, 'contacts.getContacts').length >= reads + 2, 'two more reads');
      expect(rels(h, n).length).toBe(seen);
      expect(h.of('relationships').length).toBe(1);
    } finally {
      await h.stop();
    }
  });

  test("a user's contact flag that disagrees with the list is a sign: the lists are read again soon", async () => {
    const h = new Harness(tmp(), { opts: QUIET });
    try {
      await h.signIn();
      const reads = called(h, 'contacts.getContacts').length;
      const n = h.events.length;
      // Added on a phone: Telegram's update carries Erin as a contact now.
      await h.fake.control({ op: 'contact', user: FAKE_IDS.erin });
      await h.until(() => rels(h, n).length, 'Erin as a contact');
      expect(rels(h, n)).toEqual([{ identity: ERIN, relationship: 'contact' }]);
      expect(called(h, 'contacts.getContacts').length).toBe(reads + 1);
    } finally {
      await h.stop();
    }
  });

  test("this account's own add and remove: a contact added, removed, an unblock; the relationship before the answer, each act sent once", async () => {
    const h = new Harness(tmp(), { opts: QUIET });
    try {
      await h.fake.control({ op: 'block', user: FAKE_IDS.bob });
      await h.signIn();
      // Add (the existing path) says so too.
      let n = h.events.length;
      expect(await h.cmd({ t: 'add', ref: { network: 'telegram', kind: 'name', name: 'dave_d' }, action: 'contact' })).toMatchObject({ identity: DAVE, relationship: 'contact' });
      expect(rels(h, n)).toEqual([{ identity: DAVE, relationship: 'contact' }]);
      // Remove a contact: Telegram is asked what they are first, then the contact goes.
      n = h.events.length;
      expect(await remove(h, ALICE, 'contact')).toEqual({ identity: ALICE, relationship: 'stranger', notes: ['Removed from your Telegram contacts'] });
      expect(rels(h, n)).toEqual([{ identity: ALICE, relationship: 'stranger' }]);
      const idAt = h.events.findIndex((e, i) => i >= n && e.t === 'identity' && e.identity.nativeId === ALICE);
      expect(h.events[idAt]).toMatchObject({ identity: { nativeId: ALICE } });
      expect((h.events[idAt] as Extract<Ev, { t: 'identity' }>).identity.contact).toBeUndefined();
      expect(h.fake.world.users.find((u) => u.id === FAKE_IDS.alice)!.contact).toBe(false);
      const deleted = called(h, 'contacts.deleteContacts');
      expect(deleted.length).toBe(1);
      expect((deleted[0].req as { id: { userId: number }[] }).id.map((x) => Number(x.userId))).toEqual([FAKE_IDS.alice]);
      const checks = h.fake.calls.map((c) => c.method);
      expect(checks.lastIndexOf('users.getFullUser')).toBeLessThan(checks.lastIndexOf('contacts.deleteContacts'));
      // Unblock someone who is not a contact: a stranger after.
      n = h.events.length;
      expect(await remove(h, GRACE, 'blocked')).toEqual({ identity: GRACE, relationship: 'stranger', notes: ['Unblocked'] });
      expect(rels(h, n)).toEqual([{ identity: GRACE, relationship: 'stranger' }]);
      expect(h.fake.world.blocked!.some((b) => b.peer === `user:${FAKE_IDS.grace}`)).toBe(false);
      // Unblock a blocked contact: a contact still.
      n = h.events.length;
      expect(await remove(h, BOB, 'blocked')).toEqual({ identity: BOB, relationship: 'contact', notes: ['Unblocked; they are still in your Telegram contacts'] });
      expect(rels(h, n)).toEqual([{ identity: BOB, relationship: 'contact' }]);
      expect(called(h, 'contacts.unblock').length).toBe(2);
      // Read again, the lists agree with what was said: nothing more goes out.
      n = h.events.length;
      await h.action('resync');
      expect([...h.of('relationships').at(-1)!.list].sort(byIdentity)).toEqual([
        { identity: BOB, relationship: 'contact' },
        { identity: DAVE, relationship: 'contact' },
      ]);
      expect(rels(h, n)).toEqual([]);
    } finally {
      await h.stop();
    }
  });

  test("refused: what changed since the owner looked, what Telegram does not have, what is not a person", async () => {
    const h = new Harness(tmp(), { opts: QUIET });
    try {
      await h.signIn();
      // Dave was never a contact.
      expect(await failure(remove(h, DAVE, 'contact'))).toBe('That changed; look again');
      // Alice was removed on a phone, and nothing said so yet: Telegram, asked first, says so; the hub hears of it.
      await h.fake.control({ op: 'contact', user: FAKE_IDS.alice, contact: false, silent: true });
      const n = h.events.length;
      expect(await failure(remove(h, ALICE, 'contact'))).toBe('That changed; look again');
      expect(rels(h, n)).toEqual([{ identity: ALICE, relationship: 'stranger' }]);
      // Grace is blocked, not a contact.
      expect(await failure(remove(h, GRACE, 'contact'))).toBe('That changed; look again');
      for (const r of ['friend', 'following', 'requested', 'requesting'] as const) expect(await failure(remove(h, BOB, r))).toBe('Telegram has no friends or follows; only contacts and blocks');
      expect(await failure(remove(h, BOB, 'stranger'))).toBe('They are not in your Telegram contacts and not blocked: there is nothing to remove');
      expect(await failure(remove(h, `channel:${FAKE_IDS.news}`, 'contact'))).toBe('A channel is not a contact on Telegram: leave it instead');
      expect(await failure(remove(h, 'nonsense', 'contact'))).toBe('That is not a Telegram person');
      expect(await failure(remove(h, String(S), 'contact'))).toBe('That is you');
      expect(called(h, 'contacts.deleteContacts').length + called(h, 'contacts.unblock').length).toBe(0);
      expect(h.fake.world.users.find((u) => u.id === FAKE_IDS.bob)!.contact).toBe(true);
    } finally {
      await h.stop();
    }
  });

  test('FLOOD_WAIT: a remove fails at once with when it frees up, and is not sent again', async () => {
    const h = new Harness(tmp(), { opts: QUIET });
    try {
      await h.signIn();
      await h.fake.control({ op: 'flood', method: 'contacts.deleteContacts', seconds: 300 });
      const e = await failure(remove(h, ALICE, 'contact'));
      expect(e).toMatch(/^Telegram asks this account to wait before removing more contacts: try again in 5 minutes \(after \d\d:\d\d UTC\)$/);
      // Held now: the next one fails without asking Telegram.
      expect(await failure(remove(h, ALICE, 'contact'))).toMatch(/^Telegram asks this account to wait before removing more contacts: try again in 5 minutes/);
      expect(called(h, 'contacts.deleteContacts').length).toBe(1);
      expect(h.fake.world.users.find((u) => u.id === FAKE_IDS.alice)!.contact).toBe(true);
      await h.fake.control({ op: 'flood', method: 'contacts.unblock', seconds: 7200 });
      expect(await failure(remove(h, GRACE, 'blocked'))).toMatch(/^Telegram asks this account to wait before unblocking more people: try again in about 2 hours \(after \d\d:\d\d UTC\)$/);
      expect(called(h, 'contacts.unblock').length).toBe(1);
      expect(rels(h)).toEqual([]);
    } finally {
      await h.stop();
    }
  });
});

describe('adding people to groups: About says where, addMembers adds', () => {
  const ALICE = String(FAKE_IDS.alice);
  const DAVE = String(FAKE_IDS.dave);
  const ERIN = String(FAKE_IDS.erin);
  const FRANK = String(FAKE_IDS.frank);
  const BOT = String(FAKE_IDS.bot);
  const PRIVACY = "Their privacy settings don't let you add them";
  const ONLY_ADMINS = 'Only admins can add people here';
  const add = (h: Harness, conv: string, people: (number | string)[]) => h.cmd({ t: 'addMembers', target: { kind: 'conversation', nativeId: conv }, people: people.map(String) }) as Promise<P.AddMembersResult>;
  const about = async (h: Harness, conv: string) => (await h.cmd({ t: 'about', target: { kind: 'conversation', nativeId: conv } })) as P.About;
  const failure = (p: Promise<unknown>) => p.then(() => 'no error', (e) => String(e.message));
  const called = (h: Harness, method: string) => h.fake.calls.filter((c) => c.method === method);
  const chat = (h: Harness, id: number) => h.fake.world.chats.find((c) => c.id === id)!;
  const systemIn = (h: Harness, n: number, conv: string) => h.since(n).filter((e): e is Extract<Ev, { t: 'message' }> => e.t === 'message' && e.message.conversation === conv && e.message.kind === 'system').map((e) => e.message.body);

  test('About: a basic group its members may add to, with room; a supergroup you admin; a channel you only read; none on a private chat or a topic', async () => {
    const h = new Harness(tmp());
    try {
      await h.signIn();
      expect(h.of('hello')[0].capabilities).toContain('addMembers');
      expect((await about(h, GROUP)).adding).toEqual({ can: true, who: 'known', mode: 'add', room: 197 });
      expect((await about(h, DEVS)).adding).toEqual({ can: true, who: 'known', mode: 'add' });
      expect((await about(h, NEWS)).adding).toEqual({ can: false, reason: ONLY_ADMINS, who: 'known', mode: 'add' });
      expect((await about(h, DM_ALICE)).adding).toBeUndefined();
      expect((await about(h, `${FORUM}/2`)).adding).toBeUndefined();
      // Members may not add people: only admins may.
      const g = chat(h, FAKE_IDS.group);
      g.inviteBanned = true;
      expect((await about(h, GROUP)).adding).toEqual({ can: false, reason: ONLY_ADMINS, who: 'known', mode: 'add', room: 197 });
      const d = chat(h, FAKE_IDS.devs);
      d.admins = [];
      expect((await about(h, DEVS)).adding).toEqual({ can: true, who: 'known', mode: 'add' });
      d.inviteBanned = true;
      expect((await about(h, DEVS)).adding).toEqual({ can: false, reason: ONLY_ADMINS, who: 'known', mode: 'add' });
      // A channel you admin.
      chat(h, FAKE_IDS.news).admins.push(S);
      expect((await about(h, NEWS)).adding).toEqual({ can: true, who: 'known', mode: 'add' });
      // A full basic group.
      g.inviteBanned = false;
      g.members.push(...Array.from({ length: 197 }, (_, i) => 6_000_000 + i));
      expect((await about(h, GROUP)).adding).toEqual({ can: false, reason: 'This group is full: a basic group holds 200 people', who: 'known', mode: 'add', room: 0 });
    } finally {
      await h.stop();
    }
  });

  test('a basic group: one messages.addChatUser each; kept out by their privacy settings, in already, not yet seen; the service message before the answer', async () => {
    const h = new Harness(tmp());
    try {
      await h.fake.control({ op: 'privacy', user: FAKE_IDS.dave, add: 'nobody' });
      await h.signIn();
      const n = h.events.length;
      const r = await add(h, GROUP, [FAKE_IDS.erin, FAKE_IDS.dave, FAKE_IDS.alice, 5_009_999]);
      expect(r.added).toEqual([ALICE, ERIN]);
      expect(r.failed).toEqual([
        { id: '5009999', reason: 'Telegram needs to have seen them first' },
        { id: DAVE, reason: PRIVACY },
      ]);
      expect(r.invited).toBeUndefined();
      const sent = called(h, 'messages.addChatUser').map((c) => c.req as { chatId: number; userId: { userId: number }; fwdLimit: number });
      expect(sent.map((x) => [x.chatId, Number(x.userId.userId), x.fwdLimit])).toEqual([
        [FAKE_IDS.group, FAKE_IDS.erin, 100],
        [FAKE_IDS.group, FAKE_IDS.dave, 100],
      ]);
      expect(chat(h, FAKE_IDS.group).members).toContain(FAKE_IDS.erin);
      expect(chat(h, FAKE_IDS.group).members).not.toContain(FAKE_IDS.dave);
      // Telegram's own service message went out (before the answer: the command had not returned yet).
      expect(systemIn(h, n, GROUP)).toEqual(['added Erin']);
      // The About as it now stands.
      expect(r.about!.members!.list.map((m) => m.id)).toContain(ERIN);
      expect(r.about!.adding).toEqual({ can: true, who: 'known', mode: 'add', room: 196 });
    } finally {
      await h.stop();
    }
  });

  test('a supergroup: one channels.inviteToChannel with them all; one whom only Premium may add is refused; a channel you admin: no service message, a bot refused', async () => {
    const h = new Harness(tmp());
    try {
      await h.fake.control({ op: 'privacy', user: FAKE_IDS.frank, add: 'premium' });
      await h.signIn();
      let n = h.events.length;
      const r = await add(h, DEVS, [FAKE_IDS.dave, FAKE_IDS.erin, FAKE_IDS.frank]);
      expect(r.added).toEqual([DAVE, ERIN]);
      expect(r.failed).toEqual([{ id: FRANK, reason: 'They let only Telegram Premium users add them' }]);
      const invites = called(h, 'channels.inviteToChannel').map((c) => c.req as { channel: { channelId: number }; users: { userId: number }[] });
      expect(invites.length).toBe(1);
      expect(Number(invites[0].channel.channelId)).toBe(FAKE_IDS.devs);
      expect(invites[0].users.map((u) => Number(u.userId))).toEqual([FAKE_IDS.dave, FAKE_IDS.erin, FAKE_IDS.frank]);
      expect(systemIn(h, n, DEVS)).toEqual(['added Dave Doe, Erin']);
      expect(r.about!.members!.list.map((m) => m.id)).toEqual(expect.arrayContaining([DAVE, ERIN]));
      // A channel this account admins: subscribers come in without a message; a bot is refused, the other still goes.
      chat(h, FAKE_IDS.news).admins.push(S);
      n = h.events.length;
      const c = await add(h, NEWS, [FAKE_IDS.dave, FAKE_IDS.bot]);
      expect(c).toMatchObject({ added: [DAVE], failed: [{ id: BOT, reason: 'A bot joins a channel only as an admin' }] });
      expect(systemIn(h, n, NEWS)).toEqual([]);
      expect(chat(h, FAKE_IDS.news).members).toContain(FAKE_IDS.dave);
    } finally {
      await h.stop();
    }
  });

  test('refused before anything is sent: not a group, not allowed (read again, not taken from the hub), too many', async () => {
    const h = new Harness(tmp());
    try {
      await h.signIn();
      expect(await failure(add(h, DM_ALICE, [FAKE_IDS.dave]))).toBe('A private chat has nobody to add: make a group instead');
      expect(await failure(add(h, `${FORUM}/2`, [FAKE_IDS.dave]))).toBe('People are added to the whole forum, not to one topic');
      expect(await failure(add(h, NEWS, [FAKE_IDS.dave]))).toBe(ONLY_ADMINS);
      chat(h, FAKE_IDS.group).inviteBanned = true;
      expect(await failure(add(h, GROUP, [FAKE_IDS.dave]))).toBe(ONLY_ADMINS);
      expect(await failure(add(h, DEVS, Array.from({ length: 11 }, (_, i) => 5_000_100 + i)))).toBe('At most 10 people at a time');
      expect(await failure(add(h, DEVS, []))).toBe('Name someone to add');
      expect(await failure(h.cmd({ t: 'addMembers', target: { kind: 'space', nativeId: 'x' }, people: [DAVE] }))).toBe('Telegram has no such space: only a forum is one');
      expect(called(h, 'messages.addChatUser').length + called(h, 'channels.inviteToChannel').length).toBe(0);
      // Not people: a channel, you.
      const r = await add(h, DEVS, [`channel:${FAKE_IDS.news}`, String(S)]);
      expect(r).toMatchObject({ added: [], failed: [{ id: `channel:${FAKE_IDS.news}`, reason: 'That is not a Telegram person' }, { id: String(S), reason: 'That is you' }] });
      expect(called(h, 'channels.inviteToChannel').length).toBe(0);
    } finally {
      await h.stop();
    }
  });

  test("Telegram's refusals: one person's does not stop the rest; a flood wait or PEER_FLOOD does, saying so for each", async () => {
    const h = new Harness(tmp());
    try {
      await h.signIn();
      // Privacy as an error (as older layers answer): that one refused, the next added.
      await h.fake.control({ op: 'fail', method: 'messages.addChatUser', error: 'USER_PRIVACY_RESTRICTED' });
      expect(await add(h, GROUP, [FAKE_IDS.dave, FAKE_IDS.erin])).toMatchObject({ added: [ERIN], failed: [{ id: DAVE, reason: PRIVACY }] });
      // In already, as Telegram says: in. A code with no sentence here: in Telegram's words.
      await h.fake.control({ op: 'fail', method: 'messages.addChatUser', error: 'USER_ALREADY_PARTICIPANT' });
      expect(await add(h, GROUP, [FAKE_IDS.dave])).toMatchObject({ added: [DAVE] });
      await h.fake.control({ op: 'fail', method: 'messages.addChatUser', error: 'USER_BLOCKED' });
      expect((await add(h, GROUP, [FAKE_IDS.dave])).failed).toEqual([{ id: DAVE, reason: 'Telegram refused: USER_BLOCKED' }]);
      // A flood wait: that one and the rest refused with when it frees up; only the one sent.
      await h.fake.control({ op: 'flood', method: 'messages.addChatUser', seconds: 300 });
      let before = called(h, 'messages.addChatUser').length;
      const flooded = await add(h, GROUP, [FAKE_IDS.dave, FAKE_IDS.frank, FAKE_IDS.grace]);
      expect(flooded.added).toEqual([]);
      expect(flooded.failed!.map((f) => f.id)).toEqual([DAVE, FRANK, String(FAKE_IDS.grace)]);
      for (const f of flooded.failed!) expect(f.reason).toMatch(/^Telegram asks this account to wait before adding more people to groups: try again in 5 minutes \(after \d\d:\d\d UTC\)$/);
      expect(called(h, 'messages.addChatUser').length - before).toBe(1);
      // PEER_FLOOD on a supergroup: each refused with Telegram's limit; one call.
      await h.fake.control({ op: 'fail', method: 'channels.inviteToChannel', error: 'PEER_FLOOD' });
      before = called(h, 'channels.inviteToChannel').length;
      const limited = await add(h, DEVS, [FAKE_IDS.dave, FAKE_IDS.frank]);
      expect(limited.added).toEqual([]);
      expect(limited.failed!.map((f) => f.id)).toEqual([DAVE, FRANK]);
      for (const f of limited.failed!) expect(f.reason).toStartWith('Telegram limits this account for now');
      expect(called(h, 'channels.inviteToChannel').length - before).toBe(1);
      // Refused for one of several (Telegram does not say whom): each again on their own.
      await h.fake.control({ op: 'privacy', user: FAKE_IDS.dave, add: 'nobody' });
      await h.fake.control({ op: 'fail', method: 'channels.inviteToChannel', error: 'USER_PRIVACY_RESTRICTED' });
      before = called(h, 'channels.inviteToChannel').length;
      expect(await add(h, DEVS, [FAKE_IDS.dave, FAKE_IDS.frank])).toMatchObject({ added: [FRANK], failed: [{ id: DAVE, reason: PRIVACY }] });
      const again = called(h, 'channels.inviteToChannel').slice(before).map((c) => (c.req as { users: { userId: number }[] }).users.map((u) => Number(u.userId)));
      expect(again).toEqual([[FAKE_IDS.dave, FAKE_IDS.frank], [FAKE_IDS.dave], [FAKE_IDS.frank]]);
    } finally {
      await h.stop();
    }
  });
});

describe('making a group: createGroup is one messages.createChat', () => {
  const ALICE = String(FAKE_IDS.alice);
  const DAVE = String(FAKE_IDS.dave);
  const ERIN = String(FAKE_IDS.erin);
  const FRANK = String(FAKE_IDS.frank);
  const PRIVACY = "Their privacy settings don't let you add them";
  const make = (h: Harness, name: string | undefined, people: (number | string)[]) => h.cmd({ t: 'createGroup', ...(name === undefined ? {} : { name }), people: people.map(String) }) as Promise<P.CreateGroupResult>;
  const failure = (p: Promise<unknown>) => p.then(() => 'no error', (e) => String(e.message));
  const called = (h: Harness, method: string) => h.fake.calls.filter((c) => c.method === method);

  test('one call with the title and everyone; kept out by privacy, not yet seen: refused; identities, the group with its people, then the answer', async () => {
    const h = new Harness(tmp());
    try {
      await h.fake.control({ op: 'privacy', user: FAKE_IDS.dave, add: 'nobody' });
      await h.fake.control({ op: 'privacy', user: FAKE_IDS.frank, add: 'premium' });
      await h.signIn();
      expect(h.of('hello')[0].capabilities).toContain('createGroup');
      const n = h.events.length;
      const r = await make(h, '  Crag rats ', [FAKE_IDS.erin, FAKE_IDS.dave, FAKE_IDS.alice, FAKE_IDS.frank, 5_009_999, S]);
      const sent = called(h, 'messages.createChat').map((c) => c.req as { title: string; users: { userId: number }[] });
      expect(sent.map((x) => [x.title, x.users.map((u) => Number(u.userId))])).toEqual([['Crag rats', [FAKE_IDS.erin, FAKE_IDS.dave, FAKE_IDS.alice, FAKE_IDS.frank]]]);
      const made = h.fake.world.chats.find((c) => c.title === 'Crag rats')!;
      expect(made).toMatchObject({ kind: 'chat', creator: S, members: [S, FAKE_IDS.erin, FAKE_IDS.alice] });
      const conv = `group:${S}:${made.id}`;
      expect(r).toEqual({
        conversation: conv,
        added: [ERIN, ALICE],
        failed: [
          { id: '5009999', reason: 'Telegram needs to have seen them first' },
          { id: DAVE, reason: PRIVACY },
          { id: FRANK, reason: 'They let only Telegram Premium users add them' },
        ],
      });
      // The hub hears of the people, then the group with them in it, then (the command returning) the answer.
      const evs = h.since(n);
      const facts = evs.filter((e): e is Extract<Ev, { t: 'conversation' }> => e.t === 'conversation' && e.conversation.nativeId === conv);
      expect(facts.at(-1)!.conversation).toMatchObject({ shape: 'group', name: 'Crag rats', participants: [String(S), ERIN, ALICE] });
      const first = evs.findIndex((e) => e.t === 'conversation' && e.conversation.nativeId === conv);
      const erin = h.events.findIndex((e) => e.t === 'identity' && e.identity.nativeId === ERIN);
      expect(erin).toBeGreaterThanOrEqual(0);
      expect(erin).toBeLessThan(n + first);
      expect(evs.filter((e): e is Extract<Ev, { t: 'message' }> => e.t === 'message' && e.message.conversation === conv).map((e) => e.message.body)).toEqual(['created the group “Crag rats”']);
      // A later fact for it (a rename) does not carry that first list of people.
      h.fake.world.chats.find((c) => c.id === made.id)!.title = 'Crag rats!';
      await h.cmd({ t: 'configure', target: { kind: 'conversation', nativeId: conv }, change: { key: 'name', value: 'Crag rats 2' } });
      const later = h.of('conversation').filter((e) => e.conversation.nativeId === conv).at(-1)!.conversation;
      expect(later.name).toBe('Crag rats 2');
      expect(later.participants).toBeUndefined();
    } finally {
      await h.stop();
    }
  });

  test('refused before anything is sent: no name, too long, nobody, too many, nobody it has seen', async () => {
    const h = new Harness(tmp());
    try {
      await h.signIn();
      expect(await failure(make(h, undefined, [FAKE_IDS.alice]))).toBe('Give the group a name');
      expect(await failure(make(h, '   ', [FAKE_IDS.alice]))).toBe('Give the group a name');
      expect(await failure(make(h, 'x'.repeat(129), [FAKE_IDS.alice]))).toMatch(/at most 128 characters/);
      expect(await failure(make(h, 'Nobody', []))).toMatch(/at least 1/);
      expect(await failure(make(h, 'Me', [S]))).toMatch(/at least 1/);
      expect(await failure(make(h, 'Crowd', Array.from({ length: 11 }, (_, i) => 5_000_100 + i)))).toMatch(/at most 10/);
      expect(await failure(make(h, 'Strangers', [5_009_999]))).toBe('Telegram needs to have seen them first');
      expect(await failure(make(h, 'Channels', [`channel:${FAKE_IDS.news}`, 5_009_999]))).toBe('Nobody here can be put in a Telegram group from this account');
      expect(called(h, 'messages.createChat').length).toBe(0);
    } finally {
      await h.stop();
    }
  });

  test('a flood wait or PEER_FLOOD: nothing made, said with when, sent once and never again on its own', async () => {
    const h = new Harness(tmp());
    try {
      await h.signIn();
      const groups = h.fake.world.chats.length;
      await h.fake.control({ op: 'fail', method: 'messages.createChat', error: 'PEER_FLOOD' });
      expect(await failure(make(h, 'Crag rats', [FAKE_IDS.alice]))).toStartWith('Telegram limits this account for now');
      expect(called(h, 'messages.createChat').length).toBe(1);
      // Telegram refusing the only one asked for, as an error: in addMembers' words.
      await h.fake.control({ op: 'fail', method: 'messages.createChat', error: 'USER_PRIVACY_RESTRICTED' });
      expect(await failure(make(h, 'Crag rats', [FAKE_IDS.alice]))).toBe(PRIVACY);
      expect(called(h, 'messages.createChat').length).toBe(2);
      // The other codes layer 232 lists for messages.createChat (mtcute 0.32.7 tl/raw-errors.json), in words.
      await h.fake.control({ op: 'fail', method: 'messages.createChat', error: 'CHAT_ID_GENERATE_FAILED' });
      expect(await failure(make(h, 'Crag rats', [FAKE_IDS.alice]))).toBe('Telegram could not make the group just now: nothing was made, try again in a minute');
      await h.fake.control({ op: 'fail', method: 'messages.createChat', error: 'CHAT_MEMBER_ADD_FAILED' });
      expect(await failure(make(h, 'Crag rats', [FAKE_IDS.alice]))).toBe('Telegram could not put them in a new group: try with someone else, or add them after');
      expect(called(h, 'messages.createChat').length).toBe(4);
      await h.fake.control({ op: 'flood', method: 'messages.createChat', seconds: 300 });
      const wait = /^Telegram asks this account to wait before making more groups: try again in (5 minutes|4 minutes) \(after \d\d:\d\d UTC\)$/;
      expect(await failure(make(h, 'Crag rats', [FAKE_IDS.alice]))).toMatch(wait);
      expect(called(h, 'messages.createChat').length).toBe(5);
      // Asked again while Telegram still waits: said again, and nothing sent.
      expect(await failure(make(h, 'Crag rats', [FAKE_IDS.alice]))).toMatch(wait);
      expect(called(h, 'messages.createChat').length).toBe(5);
      expect(h.fake.world.chats.length).toBe(groups);
    } finally {
      await h.stop();
    }
  });
});
