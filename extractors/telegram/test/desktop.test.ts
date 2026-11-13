/**
 * The adapter signed in through Telegram Desktop, in process: Telegram Desktop's side is a stub (its sign-in state set
 * by the test), Telegram is the fake. No QR code of its own; a sign-in there becomes a session of its own through
 * auth.acceptLoginToken, or, refused, Telegram Desktop's key shared and read from tdata each start; an ended session
 * is not imported again by itself. test/telegram-desktop.test.ts runs the real sandbox with the fake Telegram Desktop.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { readSecretFile, writeSecretFile } from '@dither-chat/protocol/secret-file';
import { type AdapterOptions, type Host, TelegramAdapter } from '../src/adapter.ts';
import type { DesktopKey } from '../src/backend.ts';
import type { DesktopHost, DesktopSignIn } from '../src/desktop.ts';
import { FAKE_IDS, FakeTelegram } from '../src/fake.ts';
import { keyFingerprint } from '../src/tdata.ts';

setDefaultTimeout(30_000);
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const FAST = { spacing: { dialogs: 0, history: 0, send: 0, read: 0, media: 0, light: 0 }, perChatSendMs: 0 };
type Ev = P.AdapterEvent;
type Status = Extract<Ev, { t: 'status' }>;

class StubDesktop implements DesktopHost {
  signIn: DesktopSignIn = { state: 'signed-out' };
  passcode = '';
  restarted = 0;
  stopped = false;
  async start() {}
  async stop() {
    this.stopped = true;
  }
  liveView() {
    return { vncSocket: '/run/user/1000/vnc.sock', width: 1280, height: 800 };
  }
  layers(needed: boolean) {
    const s = this.signIn.state;
    return [
      { name: 'sandbox', state: 'ok' as const },
      { name: 'Telegram Desktop', state: 'ok' as const },
      s === 'signed-in' ? { name: 'signed in (Telegram Desktop)', state: 'ok' as const } : { name: 'signed in (Telegram Desktop)', state: needed ? ('waiting' as const) : ('off' as const), note: s },
    ];
  }
  details() {
    return { desktopSignIn: this.signIn.state };
  }
  command(cmd: { t: string }) {
    if (cmd.t === 'notify.list') return Promise.resolve({ notifications: [{ id: 'tdesktop:x:1' }], next: null });
    if (cmd.t === 'desktop.links') return Promise.resolve({ links: [] });
    return undefined;
  }
  setPasscode(p: string) {
    this.passcode = p;
  }
  async restartApp() {
    this.restarted++;
  }
}

const newKey = (): DesktopKey => {
  const authKey = randomBytes(256);
  return { userId: BigInt(FAKE_IDS.self), dcId: 2, authKey, fingerprint: keyFingerprint(authKey) };
};

class Harness {
  events: Ev[] = [];
  logs: string[] = [];
  profiles: (string | undefined)[] = [];
  fake: FakeTelegram;
  desktop = new StubDesktop();
  adapter: TelegramAdapter;
  constructor(
    readonly dir: string,
    o: { opts?: Partial<AdapterOptions>; desktop?: StubDesktop; config?: Record<string, unknown> } = {},
  ) {
    if (!existsSync(join(dir, 'secret.json'))) writeSecretFile(join(dir, 'secret.json'), {});
    if (o.desktop) this.desktop = o.desktop;
    this.fake = new FakeTelegram({ dir, qrMs: 600 });
    const host: Host = {
      emit: (e) => this.events.push(e),
      log: (l, m) => this.logs.push(`[${l}] ${m}`),
      accountDir: dir,
      config: o.config ?? { signIn: 'desktop' },
      secret: () => readSecretFile(join(dir, 'secret.json')),
      saveSecret: (v) => writeSecretFile(join(dir, 'secret.json'), v),
    };
    this.adapter = new TelegramAdapter(host, {
      backend: (_c, profile) => {
        this.profiles.push(profile);
        return this.fake;
      },
      fake: true,
      pacer: FAST,
      desktop: { session: this.desktop, deskClient: (k) => this.fake.desktopClient(k), sharedSession: async (k) => FakeTelegram.keySession(k), retryMs: 150, catchUpMs: 50 },
      ...o.opts,
    });
  }
  get status(): Status | undefined {
    return [...this.events].reverse().find((e): e is Status => e.t === 'status');
  }
  layers() {
    return this.status!.layers!.map((l) => [l.name, l.state]);
  }
  async until(f: () => unknown, what: string, ms = 6000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (f()) return;
      await Bun.sleep(10);
    }
    throw new Error(`timed out waiting for ${what}; last status ${JSON.stringify(this.status)}`);
  }
  action(action: string, args?: unknown) {
    return this.adapter.command({ t: 'action', id: 'x', action, args } as P.AdapterCommand);
  }
  secret() {
    return JSON.parse(readFileSync(join(this.dir, 'secret.json'), 'utf8'));
  }
  /** Telegram Desktop signs in with this key (Telegram knows it; tdata says so). */
  async desktopSignsIn(key = newKey()) {
    await this.fake.control({ op: 'authorizeKey', fingerprint: key.fingerprint });
    this.desktop.signIn = { state: 'signed-in', key };
    this.adapter.desktopChanged();
    return key;
  }
}

const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'dacc-tgd-'));
  dirs.push(d);
  return d;
};

describe('through Telegram Desktop', () => {
  test('it waits for the sign-in in the live view: no QR code of its own, and the chain from the sandbox down', async () => {
    const h = new Harness(tmp());
    await h.adapter.start();
    await h.until(() => h.status?.attention?.kind === 'login', 'the sign-in asked for');
    expect(h.status).toMatchObject({ status: 'attention', attention: { kind: 'login', liveView: true, message: expect.stringContaining('Sign in to Telegram in the live view') }, liveView: { vncSocket: '/run/user/1000/vnc.sock', width: 1280, height: 800 } });
    expect(h.status!.attention!.qr).toBeUndefined();
    expect(h.layers()).toEqual([
      ['sandbox', 'ok'],
      ['Telegram Desktop', 'ok'],
      ['signed in (Telegram Desktop)', 'waiting'],
      ['session imported', 'waiting'],
      ['connection', 'ok'],
      ['updates', 'waiting'],
    ]);
    expect(await h.action('refreshLink').catch((e) => e.message)).toBe('This account signs in through Telegram Desktop: use the live view');
    expect(await h.action('sendCode', { phone: '+15551234567' }).catch((e) => e.message)).toContain('log in with your phone number there');
    expect(h.fake.calls.some((c) => c.method === 'auth.exportLoginToken')).toBe(false);
    await h.adapter.shutdown();
    expect(h.desktop.stopped).toBe(true);
  });

  test("Telegram Desktop signs in: this account makes a session of its own, which outlives Desktop's sign-out", async () => {
    const h = new Harness(tmp());
    await h.adapter.start();
    await h.until(() => h.status?.attention?.kind === 'login', 'the sign-in asked for');
    const key = await h.desktopSignsIn();
    await h.until(() => h.status?.status === 'online', 'online');
    const methods = h.fake.calls.map((c) => c.method);
    expect(methods).toContain('auth.exportLoginToken');
    expect(methods).toContain('auth.acceptLoginToken');
    expect(h.secret()).toMatchObject({ sessionMode: 'own', desktopKey: key.fingerprint, userId: String(FAKE_IDS.self), session: expect.stringMatching(/^fake:/) });
    // Its own, not Desktop's: a different session in Telegram's list.
    expect(h.secret().session).not.toBe(FakeTelegram.keySession(key));
    expect(h.status!.layers!.find((l) => l.name === 'session imported')).toMatchObject({ state: 'ok', note: expect.stringContaining('its own session') });
    expect(h.profiles.every((p) => p === undefined)).toBe(true);
    // Signed out in the live view: the account stays online on its own session.
    h.desktop.signIn = { state: 'signed-out' };
    h.adapter.desktopChanged();
    expect(h.status!.status).toBe('online');
    expect(h.status!.layers![2]).toMatchObject({ name: 'signed in (Telegram Desktop)', state: 'off' });
    // Nothing secret in the logs: not the key, nor its session string.
    const log = h.logs.join('\n');
    expect(log).not.toContain(Buffer.from(key.authKey).toString('hex').slice(0, 32));
    expect(log).not.toContain(h.secret().session);
    await h.adapter.shutdown();
  });

  test('with a two-step password, the pane asks for it for the own session', async () => {
    const h = new Harness(tmp());
    await h.fake.control({ op: 'setPassword', password: 'pw', hint: 'two letters' });
    await h.adapter.start();
    await h.until(() => h.status?.attention?.kind === 'login', 'the sign-in asked for');
    await h.desktopSignsIn();
    await h.until(() => h.status?.attention?.message?.includes("for this account's own session"), 'the password asked for');
    expect(h.status!.layers!.find((l) => l.name === 'session imported')).toMatchObject({ state: 'waiting', note: expect.stringContaining('two-step') });
    expect(await h.action('relogin', { password: 'pw' })).toEqual({ signedIn: true });
    await h.until(() => h.status?.status === 'online', 'online');
    expect(h.secret().sessionMode).toBe('own');
    await h.adapter.shutdown();
  });

  test("refused: it shares Telegram Desktop's key, read from tdata at each start, and catches up", async () => {
    const dir = tmp();
    const h = new Harness(dir);
    await h.fake.control({ op: 'refuseAccept', error: 'SESSION_TOO_FRESH_86400' });
    await h.adapter.start();
    const key = await h.desktopSignsIn();
    await h.until(() => h.status?.status === 'online', 'online, shared');
    expect(h.secret()).toEqual({ sessionMode: 'shared', userId: String(FAKE_IDS.self), desktopKey: key.fingerprint });
    expect(h.status!.layers!.find((l) => l.name === 'session imported')).toMatchObject({ state: 'ok', note: "shares Telegram Desktop's session (auth.acceptLoginToken refused: SESSION_TOO_FRESH_86400)" });
    expect(h.status!.details).toMatchObject({ session: "Telegram Desktop's (shared, read from its tdata)" });
    expect(h.profiles).toContain('desktop');
    await h.adapter.shutdown();

    // A restart: the session comes from Telegram Desktop again, nothing from secret.json.
    const desktop = new StubDesktop();
    desktop.signIn = { state: 'signed-in', key };
    const again = new Harness(dir, { desktop, opts: { healthEveryMs: 50 } });
    await again.adapter.start();
    await again.until(() => again.status?.status === 'online', 'online after a restart');
    expect(again.profiles[0]).toBe('desktop');
    // Telegram Desktop's session ends (signed out there, or from another device): this one goes with it, and waits.
    await again.fake.control({ op: 'endKey', fingerprint: key.fingerprint });
    await again.until(() => again.status?.attention?.kind === 'login', 'back to the sign-in');
    expect(again.secret().desktopEnded).toBe(key.fingerprint);
    expect(again.secret().sessionMode).toBeUndefined();
    // A new sign-in there (a new key) is imported by itself.
    await again.fake.control({ op: 'refuseAccept', error: null });
    await again.desktopSignsIn();
    await again.until(() => again.status?.status === 'online', 'online on the new sign-in');
    expect(again.secret().sessionMode).toBe('own');
    await again.adapter.shutdown();
  });

  test('logout ends its own session, and the same Desktop sign-in is not imported again until importDesktop', async () => {
    const h = new Harness(tmp());
    await h.adapter.start();
    const key = await h.desktopSignsIn();
    await h.until(() => h.status?.status === 'online', 'online');
    expect(await h.action('logout')).toEqual({});
    await h.until(() => h.status?.attention?.message?.includes('own session was ended'), 'ended');
    expect(h.secret().desktopEnded).toBe(key.fingerprint);
    h.adapter.desktopChanged();
    await Bun.sleep(300);
    expect(h.status!.status).toBe('attention');
    expect(h.status!.layers!.find((l) => l.name === 'session imported')!.note).toContain('run importDesktop');
    expect(await h.action('importDesktop')).toMatchObject({ phase: 'online', session: 'own' });
    expect(h.secret().desktopEnded).toBeUndefined();
    await h.adapter.shutdown();
  });

  test("a local passcode and an unreadable tdata say so; the passcode goes to Desktop's side and nowhere else", async () => {
    const h = new Harness(tmp());
    h.desktop.signIn = { state: 'passcode', wrong: false };
    await h.adapter.start();
    await h.until(() => h.status?.attention?.message?.includes('local passcode'), 'the passcode asked for');
    expect(await h.action('desktopPasscode', { passcode: '1234' })).toEqual({ signIn: 'passcode' });
    expect(h.desktop.passcode).toBe('1234');
    expect(readFileSync(join(h.dir, 'secret.json'), 'utf8')).not.toContain('1234');
    h.desktop.signIn = { state: 'unreadable', error: 'key_datas lists 9 accounts' };
    h.adapter.desktopChanged();
    expect(h.status!.attention!.message).toContain('key_datas lists 9 accounts');
    expect(await h.action('restartDesktop')).toEqual({});
    expect(h.desktop.restarted).toBe(1);
    await h.adapter.shutdown();
  });

  test("notify.* and desktop.* go to Telegram Desktop's side, signed in or not; a QR account has none", async () => {
    const h = new Harness(tmp());
    await h.adapter.start();
    expect(await h.adapter.command({ t: 'notify.list', id: 'x' } as never)).toEqual({ notifications: [{ id: 'tdesktop:x:1' }], next: null });
    expect(await h.adapter.command({ t: 'desktop.links', id: 'x' } as never)).toEqual({ links: [] });
    await h.adapter.shutdown();
    const qr = new Harness(tmp(), { config: {}, opts: { desktop: undefined } });
    expect(await qr.adapter.command({ t: 'notify.list', id: 'x' } as never)).toEqual({ notifications: [], next: null });
    expect(await qr.adapter.command({ t: 'desktop.links', id: 'x' } as never).catch((e) => e.message)).toBe('This account has no Telegram Desktop (it signs in by QR code)');
    expect(await qr.action('importDesktop').catch((e) => e.message)).toBe('This account signs in by QR code, not through Telegram Desktop');
  });
});
