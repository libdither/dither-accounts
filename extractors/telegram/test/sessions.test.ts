/**
 * Standing in for the phone: approving a sign-in on another device by its QR code (approveLogin), the account's
 * sessions (sessions) and ending one (endSession), against the fake Telegram; and Telegram's service chat (user
 * 777000, where login codes arrive) reaching the chat interface like any other.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { readSecretFile, writeSecretFile } from '@dither-chat/protocol/secret-file';
import { type Host, TelegramAdapter } from '../src/adapter.ts';
import { FAKE_IDS, FakeTelegram } from '../src/fake.ts';
import { HASH_CURRENT, HASH_MALFORMED, HASH_UNKNOWN, LINK_MALFORMED, NOT_SIGNED_IN, parseLoginLink, parseSessionHash, type SessionInfo, TOKEN_EXPIRED, TOKEN_UNKNOWN, TOKEN_USED, tooFreshMessage } from '../src/sessions.ts';

setDefaultTimeout(30_000);
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'dacc-tgs-'));
  dirs.push(d);
  return d;
};

const S = FAKE_IDS.self;
const DM_TELEGRAM = `dm:${S}:${FAKE_IDS.telegram}`;
const FAST = { spacing: { dialogs: 0, history: 0, send: 0, read: 0, media: 0, light: 0 }, perChatSendMs: 0 };
type Ev = P.AdapterEvent;

class Harness {
  events: Ev[] = [];
  logs: string[] = [];
  fake: FakeTelegram;
  adapter: TelegramAdapter;
  constructor(readonly dir: string) {
    if (!readSecretFile(join(dir, 'secret.json')).apiHash) writeSecretFile(join(dir, 'secret.json'), { apiHash: '0123456789abcdef0123456789abcdef' });
    this.fake = new FakeTelegram({ dir, qrMs: 60_000 });
    const host: Host = {
      emit: (e) => this.events.push(e),
      log: (l, m) => this.logs.push(`[${l}] ${m}`),
      accountDir: dir,
      config: { apiId: '12345' },
      secret: () => readSecretFile(join(dir, 'secret.json')),
      saveSecret: (v) => writeSecretFile(join(dir, 'secret.json'), v),
    };
    this.adapter = new TelegramAdapter(host, { backend: () => this.fake, fake: true, pacer: FAST });
  }
  get status() {
    return [...this.events].reverse().find((e): e is Extract<Ev, { t: 'status' }> => e.t === 'status');
  }
  of<K extends Ev['t']>(t: K): Extract<Ev, { t: K }>[] {
    return this.events.filter((e): e is Extract<Ev, { t: K }> => e.t === t);
  }
  async until(f: () => unknown, what: string, ms = 4000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (f()) return;
      await Bun.sleep(10);
    }
    throw new Error(`timed out waiting for ${what}`);
  }
  action(action: string, args?: unknown): Promise<any> {
    return this.adapter.command({ id: 'x', t: 'action', action, args } as P.AdapterCommand);
  }
  fails(action: string, args?: unknown): Promise<string> {
    return this.action(action, args).then(
      (r) => `answered ${JSON.stringify(r)}`,
      (e) => String(e.message),
    );
  }
  async signIn() {
    await this.adapter.start();
    await this.until(() => this.status?.attention?.qr, 'a QR code');
    await this.fake.control({ op: 'scan' });
    await this.until(() => this.status?.status === 'online', 'online');
  }
}

const tokenOf = (link: string) => link.slice('tg://login?token='.length);

describe('reading what the app gives', () => {
  test('a tg://login link or the bare token; anything else is not a sign-in code', () => {
    const token = Buffer.from(Array.from({ length: 32 }, (_, i) => i * 7)).toString('base64url');
    const bytes = Buffer.from(token, 'base64url');
    expect(Buffer.from(parseLoginLink(`tg://login?token=${token}`)).equals(bytes)).toBe(true);
    expect(Buffer.from(parseLoginLink(`  TG://login?token=${token}  `)).equals(bytes)).toBe(true);
    expect(Buffer.from(parseLoginLink(`tg://login?foo=1&token=${token}&bar=2`)).equals(bytes)).toBe(true);
    expect(Buffer.from(parseLoginLink(token)).equals(bytes)).toBe(true);
    for (const bad of ['', '   ', 'tg://login', 'tg://login?token=', 'tg://resolve?domain=telegram', 'https://t.me/telegram', 'tg://login?token=a b', 'abc', '!!!!!!!!!!!!!!!!', 'x'.repeat(5000), null, 42, { link: token }]) {
      expect(() => parseLoginLink(bad)).toThrow(LINK_MALFORMED);
    }
  });

  test("a session's hash: a signed 64-bit number; 0 is this session", () => {
    expect(parseSessionHash('1290348756102938475')).toBe('1290348756102938475');
    expect(parseSessionHash(' -4783920175539012345 ')).toBe('-4783920175539012345');
    expect(parseSessionHash('9223372036854775807')).toBe('9223372036854775807');
    expect(parseSessionHash(12345)).toBe('12345');
    for (const bad of ['', 'abc', '1.5', '9223372036854775808', '-9223372036854775809', '12 34', undefined, null, 1.5]) expect(() => parseSessionHash(bad)).toThrow(HASH_MALFORMED);
    expect(() => parseSessionHash('0')).toThrow(HASH_CURRENT);
    expect(() => parseSessionHash('-0')).toThrow(HASH_CURRENT);
  });

  test('the too-new refusal names the session and says when', () => {
    const now = Date.UTC(2026, 10, 7, 12);
    const current: SessionInfo = { hash: '0', current: true, device: 'dither-accounts', platform: 'Linux', app: 'Telegram Desktop', appVersion: '7.2.9', country: null, region: null, createdAt: now - 3 * 3600_000, activeAt: now };
    expect(tooFreshMessage('end other sessions', current, now)).toBe(
      "Telegram does not let a session that is less than a day old end other sessions, and this account's own session (Telegram Desktop on dither-accounts, signed in 3 hours ago) is too new. It can in about 21 hours; until then, do it from a device that has been signed in for longer.",
    );
    expect(tooFreshMessage('end other sessions', null, now)).toBe(
      "Telegram does not let a session that is less than a day old end other sessions, and this account's own session is that new. Try again tomorrow, or do it from a device that has been signed in for longer.",
    );
    expect(tooFreshMessage('end other sessions', { ...current, createdAt: now - 3 * 86_400_000 }, now)).toContain('signed in 3 days ago) is too new. Try again in a while;');
  });
});

describe('before signing in', () => {
  test('every session action says to sign in first', async () => {
    const h = new Harness(tmp());
    await h.adapter.start();
    await h.until(() => h.status?.attention?.qr, 'a QR code');
    const { link } = (await h.fake.control({ op: 'loginToken' })) as { link: string };
    expect(await h.fails('approveLogin', { link })).toBe(NOT_SIGNED_IN);
    expect(await h.fails('sessions')).toBe(NOT_SIGNED_IN);
    expect(await h.fails('endSession', { hash: '1290348756102938475' })).toBe(NOT_SIGNED_IN);
    expect(h.fake.calls.some((c) => /^(auth\.acceptLoginToken|account\.)/.test(c.method))).toBe(false);
    expect(h.logs.filter((l) => / refused: not signed in$/.test(l))).toHaveLength(3);
    await h.adapter.shutdown();
  });
});

describe('signed in', () => {
  const h = new Harness(tmp());
  afterAll(() => h.adapter.shutdown());
  const secrets: string[] = [];
  const keep = (...s: string[]) => (secrets.push(...s.filter(Boolean)), s[0]);

  test('sessions: this one first (hash 0), then the others by when they were last active, without their IPs', async () => {
    await h.signIn();
    const { sessions } = await h.action('sessions');
    expect(sessions.map((s: SessionInfo) => [s.device, s.current])).toEqual([
      ['dither-accounts', true],
      ['iPhone 15', false],
      ['Desktop', false],
    ]);
    for (const s of sessions) expect(Object.keys(s).sort()).toEqual(['activeAt', 'app', 'appVersion', 'country', 'createdAt', 'current', 'device', 'hash', 'platform', 'region'].sort());
    expect(sessions[0]).toMatchObject({ hash: '0', app: 'Telegram Desktop', appVersion: '7.2.9', platform: 'Linux' });
    expect(sessions[1]).toMatchObject({ hash: '-4783920175539012345', app: 'Telegram iOS', platform: 'iOS', country: 'Netherlands', region: 'North Holland' });
    expect(sessions[2]).toMatchObject({ hash: '1290348756102938475', country: 'Germany', region: null });
    expect(sessions[1].createdAt).toBeLessThan(Date.now() - 199 * 86_400_000);
    expect(sessions[1].activeAt).toBeGreaterThan(Date.now() - 3600_000);
    const json = JSON.stringify(sessions);
    for (const ip of ['203.0.113.7', '198.51.100.20', '192.0.2.10']) expect(json).not.toContain(ip);
    keep(...sessions.flatMap((s: SessionInfo) => [s.hash === '0' ? '' : s.hash, s.device, s.country ?? '', s.region ?? '']));
  });

  test('approveLogin: the QR code another device shows signs it in; the answer says what it is, and its hash undoes it', async () => {
    const { link } = (await h.fake.control({ op: 'loginToken', device: 'Firefox 133, Linux', app: 'Telegram Web', appVersion: '2.2 A', platform: 'Web', country: 'Belgium', region: 'Flanders' })) as { link: string };
    const r = await h.action('approveLogin', { link });
    expect(Object.keys(r)).toEqual(['session']);
    expect(Object.keys(r.session).sort()).toEqual(['app', 'appVersion', 'country', 'createdAt', 'device', 'hash', 'platform', 'region'].sort());
    expect(r.session).toMatchObject({ device: 'Firefox 133, Linux', platform: 'Web', app: 'Telegram Web', appVersion: '2.2 A', country: 'Belgium', region: 'Flanders' });
    expect(r.session.hash).toMatch(/^-?\d+$/);
    expect(Math.abs(r.session.createdAt - Date.now())).toBeLessThan(5000);
    expect(JSON.stringify(r)).not.toContain('203.0.113.99');
    const listed = (await h.action('sessions')).sessions.find((s: SessionInfo) => s.hash === r.session.hash);
    expect(listed).toMatchObject({ current: false, device: 'Firefox 133, Linux' });
    keep(tokenOf(link), r.session.hash, 'Firefox', 'Belgium', 'Flanders');
    // The same code again: used.
    expect(await h.fails('approveLogin', { link })).toBe(TOKEN_USED);
    // The bare token works as well as the link.
    const second = (await h.fake.control({ op: 'loginToken' })) as { token: string };
    expect((await h.action('approveLogin', { link: second.token })).session.app).toBe('Telegram Web');
    keep(second.token);
  });

  test('approveLogin refusals, in words: expired, unknown, not a sign-in code', async () => {
    const expired = (await h.fake.control({ op: 'loginToken', ttlMs: 0 })) as { link: string };
    expect(await h.fails('approveLogin', { link: expired.link })).toBe('That code has expired: show a new one on the other device');
    expect(TOKEN_EXPIRED).toBe('That code has expired: show a new one on the other device');
    const unknown = `tg://login?token=${Buffer.from('a token Telegram never made').toString('base64url')}`;
    expect(await h.fails('approveLogin', { link: unknown })).toBe(TOKEN_UNKNOWN);
    expect(await h.fails('approveLogin', { link: 'https://example.com/login?token=abc' })).toBe(LINK_MALFORMED);
    expect(await h.fails('approveLogin', {})).toBe(LINK_MALFORMED);
    keep(tokenOf(expired.link), tokenOf(unknown));
  });

  test('endSession: refused while this session is under a day old, naming it; once older, it ends the session', async () => {
    const { sessions } = await h.action('sessions');
    const web = sessions.find((s: SessionInfo) => s.app === 'Telegram Web' && s.device.startsWith('Firefox'))!;
    const n = h.fake.calls.length;
    const fresh = await h.fails('endSession', { hash: web.hash });
    expect(fresh).toStartWith('Telegram does not let a session that is less than a day old end other sessions, and this account\'s own session (Telegram Desktop on dither-accounts, signed in 1 minute ago) is too new. It can in about 24 hours;');
    expect(h.fake.calls.slice(n).map((c) => c.method)).toEqual(['account.resetAuthorization', 'account.getAuthorizations']);
    expect((await h.action('sessions')).sessions.some((s: SessionInfo) => s.hash === web.hash)).toBe(true);

    await h.fake.control({ op: 'ageSession', hours: 25 });
    expect(await h.action('endSession', { hash: web.hash })).toEqual({});
    expect((await h.action('sessions')).sessions.some((s: SessionInfo) => s.hash === web.hash)).toBe(false);
    expect(await h.fails('endSession', { hash: web.hash })).toBe(HASH_UNKNOWN);
    expect(await h.fails('endSession', { hash: '0' })).toBe(HASH_CURRENT);
    expect(await h.fails('endSession', { hash: 'the phone' })).toBe(HASH_MALFORMED);
    // A negative hash goes back to Telegram as the same 64-bit number.
    expect(await h.action('endSession', { hash: '-4783920175539012345' })).toEqual({});
    expect((await h.action('sessions')).sessions.map((s: SessionInfo) => s.device)).not.toContain('iPhone 15');
  });

  test('the log says which action ran and how it ended, never the code, a hash, a device or a place', () => {
    const lines = h.logs.filter((l) => /approveLogin|endSession|sessions:/.test(l));
    expect(lines).toEqual(
      expect.arrayContaining([
        '[info] sessions: listed 3',
        '[info] approveLogin: approved a sign-in on another device',
        '[info] approveLogin: refused by Telegram (AUTH_TOKEN_ALREADY_ACCEPTED)',
        '[info] approveLogin: refused by Telegram (AUTH_TOKEN_EXPIRED)',
        '[info] approveLogin: refused by Telegram (AUTH_TOKEN_INVALID)',
        '[info] approveLogin: refused: not a sign-in code',
        '[info] endSession: refused by Telegram (FRESH_RESET_AUTHORISATION_FORBIDDEN)',
        '[info] endSession: ended a session',
        '[info] endSession: refused by Telegram (HASH_INVALID)',
        '[info] endSession: refused: not the hash of another session',
      ]),
    );
    const all = h.logs.join('\n');
    for (const s of new Set(secrets)) expect(all).not.toContain(s);
    for (const s of ['dither-accounts', 'iPhone', 'Netherlands', 'Germany', 'Utrecht']) expect(lines.join('\n')).not.toContain(s);
  });
});

describe("Telegram's service chat (777000), where login codes arrive", () => {
  test('a login code arrives live in a chat of its own, named, with its message; history and a restart keep it', async () => {
    const dir = tmp();
    const h = new Harness(dir);
    await h.signIn();
    expect(h.of('conversation').some((e) => e.conversation.nativeId === DM_TELEGRAM)).toBe(false);
    const n = h.events.length;
    await h.fake.control({ op: 'loginCode', code: '27182' });
    await h.until(() => h.of('message').some((e) => e.message.conversation === DM_TELEGRAM), 'the login code');
    const after = h.events.slice(n);
    const convAt = after.findIndex((e) => e.t === 'conversation' && e.conversation.nativeId === DM_TELEGRAM);
    const msgAt = after.findIndex((e) => e.t === 'message' && e.message.conversation === DM_TELEGRAM);
    expect(convAt).toBeGreaterThanOrEqual(0);
    expect(convAt).toBeLessThan(msgAt);
    expect(after[convAt]).toMatchObject({ conversation: { shape: 'direct', participants: [String(S), String(FAKE_IDS.telegram)] } });
    const code = after[msgAt] as Extract<Ev, { t: 'message' }>;
    expect(code.live).toBe(true);
    expect(code.message.author).toBe(String(FAKE_IDS.telegram));
    expect(code.message.body).toStartWith('Login code: **27182**. Do not give this code to anyone');
    expect(h.of('identity').find((e) => e.identity.nativeId === String(FAKE_IDS.telegram))?.identity).toMatchObject({ displayName: 'Telegram' });
    // A second code: the chat is known, so no second conversation.
    await h.fake.control({ op: 'loginCode', code: '31415' });
    await h.until(() => h.of('message').some((e) => e.message.body.includes('31415')), 'the second code');
    expect(h.of('conversation').filter((e) => e.conversation.nativeId === DM_TELEGRAM)).toHaveLength(1);
    const hist = await h.adapter.command({ id: 'x', t: 'history', conversation: DM_TELEGRAM, limit: 10 } as P.AdapterCommand);
    expect(hist).toMatchObject({ count: 2 });
    await h.adapter.shutdown();

    const again = new Harness(dir);
    await again.adapter.start();
    await again.until(() => again.status?.status === 'online', 'online again');
    expect(again.of('conversation').find((e) => e.conversation.nativeId === DM_TELEGRAM)?.conversation).toMatchObject({ shape: 'direct' });
    expect(again.of('message').find((e) => e.message.conversation === DM_TELEGRAM)?.message.body).toContain('31415');
    await again.adapter.shutdown();
  });

  test('someone new writing gets their chat first as well', async () => {
    const h = new Harness(tmp());
    await h.signIn();
    const carol = `dm:${S}:${FAKE_IDS.carol}`;
    expect(h.of('conversation').some((e) => e.conversation.nativeId === carol)).toBe(false);
    await h.fake.control({ op: 'incoming', peer: `user:${FAKE_IDS.carol}`, from: FAKE_IDS.carol, text: 'hi, new here' });
    await h.until(() => h.of('message').some((e) => e.message.conversation === carol), 'her message');
    const i = h.events.findIndex((e) => e.t === 'conversation' && e.conversation.nativeId === carol);
    const j = h.events.findIndex((e) => e.t === 'message' && e.message.conversation === carol);
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i).toBeLessThan(j);
    await h.adapter.shutdown();
  });
});
