/**
 * A Telegram account signed in through Telegram Desktop, end to end: a throwaway manager offering it
 * (DITHER_TELEGRAM_DESKTOP=1), the extractor a real process on the fake Telegram (TELEGRAM_FAKE=1), and the fake
 * Telegram Desktop (extractors/telegram/test/fake-desktop.ts) running in the real sandbox: its own Xvfb and live view,
 * the private bus with our services, the xdg-open shim, the Downloads folder. An app with grants on chat,
 * notifications and desktop gets what the app inside hands out. Nothing reaches Telegram.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AccountsClient, register } from '@dither-accounts/client';
import { chat, desktop, notifications } from '@dither-accounts/interfaces';
import { createManager, kindOf, type Manager } from '@dither-accounts/manager';
import { telegramManifest } from '../extractors/telegram/manifest.ts';
import { rfbBanner } from '../packages/browser/test/inet.ts';
import { FAKE_IDS, fakeControl } from '../extractors/telegram/src/fake.ts';
import { keyFingerprint } from '../extractors/telegram/src/tdata.ts';
import type { AccountInfo } from '../packages/manager/src/api-types.ts';
import { sandbox, why } from './needs.ts';

const ok = why('the native-app sandbox (bubblewrap, Xvfb, x11vnc, dbus)', sandbox);
const it = test.skipIf(!ok);

setDefaultTimeout(90_000);
const ROOT = resolve(import.meta.dir, '..');
let m: Manager;
let dir: string;
let app: AccountsClient;
const events = new Map<string, { t: string; [k: string]: any }[]>();

const until = async <T>(f: () => T | undefined | null | false | Promise<T | undefined | null | false>, ms = 20_000, what = 'condition'): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = (await Promise.resolve().then(f).catch(() => null)) as T | null;
    if (v) return v;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const api = async <T = any>(path: string, body?: unknown): Promise<T> => (await fetch(m.url + path, { method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) })).json() as Promise<T>;
const account = async (id: string) => (await api<{ accounts: AccountInfo[] }>('/api/state')).accounts.find((a) => a.id === id);
const accDir = (id: string) => join(dir, 'mgr', 'accounts', id);
const evs = (id: string) => events.get(id) ?? [];
const lastStatus = (id: string) => evs(id).filter((e) => e.t === 'status').at(-1);
const layers = (st: any) => st.layers.map((l: any) => [l.name, l.state]);

/** A command for the fake Telegram Desktop in the sandbox, through its inbox in the sandbox's home. */
let seq = 0;
const desk = async (id: string, cmd: Record<string, unknown>) => {
  const inbox = join(accDir(id), 'desktop', 'home', '.fake-desktop');
  mkdirSync(inbox, { recursive: true });
  const name = `${String(++seq).padStart(4, '0')}.json`;
  writeFileSync(join(inbox, `${name}.tmp`), JSON.stringify(cmd));
  renameSync(join(inbox, `${name}.tmp`), join(inbox, name));
  const done = join(inbox, `${name}.done`);
  await until(() => existsSync(done), 20_000, `the fake Telegram Desktop to ${cmd.do}`);
  const r = JSON.parse(readFileSync(done, 'utf8'));
  if (!r.ok) throw new Error(r.error);
  return r.result;
};
/** Telegram Desktop signs in: Telegram knows the key, and the app writes it to its tdata. */
const desktopSignsIn = async (id: string) => {
  const key = randomBytes(256);
  await fakeControl(accDir(id), { op: 'authorizeKey', fingerprint: keyFingerprint(key) });
  await desk(id, { do: 'signIn', userId: FAKE_IDS.self, dcId: 2, keyHex: key.toString('hex') });
  return key;
};
const add = async (label: string) => {
  const r = await api<{ id?: string; error?: string }>('/api/accounts', { kind: 'telegram', label, config: { signIn: 'desktop' } });
  if (!r.id) throw new Error(r.error);
  return r.id;
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dacc-tgdesk-'));
  mkdirSync(join(dir, 'mgr'));
  m = await createManager({ openPage: true, dataDir: join(dir, 'mgr'), port: 0 });
  m.kinds.set('telegram', kindOf(telegramManifest(true), join(ROOT, 'extractors/telegram')));
  m.kinds.get('telegram')!.env = { TELEGRAM_FAKE: '1', TELEGRAM_DESKTOP_FAKE: '1', DITHER_TELEGRAM_DESKTOP: '1', TELEGRAM_DESKTOP_POLL_MS: '300', TELEGRAM_DESKTOP_RETRY_MS: '1000', TELEGRAM_FAKE_QR_MS: '3000' };
  const reg = await register(m.url, {
    name: 'telegram-desktop-test-app',
    requests: [
      { interface: 'chat', level: 'manage', accounts: '*' },
      { interface: 'notifications', level: 'write', accounts: '*' },
      { interface: 'desktop', level: 'write', accounts: '*' },
    ],
  });
  for (const r of reg.requests) await fetch(`${m.url}/api/requests/${r.id}/approve`, { method: 'POST', body: '{}' });
  app = new AccountsClient({ url: m.url, app: reg.app, token: reg.token, onEvents: (a, e) => (events.get(a) ?? events.set(a, []).get(a)!).push(...e) });
  await until(() => app.connected, 4000, 'the app connected');
});
afterAll(async () => {
  app?.close();
  await m?.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('the add form offers the sign-in through Telegram Desktop when the manager does', async () => {
  const tg = (await api<{ kinds: { kind: string; add: any; interfaces: string[] }[] }>('/api/state')).kinds.find((k) => k.kind === 'telegram')!;
  expect(tg.add.fields.map((f: any) => f.key)).toEqual(['signIn', 'app', 'apiId', 'apiHash', 'testDc']);
  expect(tg.interfaces).toEqual(['chat', 'notifications', 'desktop']);
  const bad = await api<{ error: string }>('/api/accounts', { kind: 'telegram', label: 'x', config: { signIn: 'browser' } });
  expect(bad.error).toContain('desktop: Telegram Desktop in a live view');
  // Off by default: the manifest as a manager without DITHER_TELEGRAM_DESKTOP loads it.
  expect(telegramManifest(false).add!.fields!.map((f) => f.key)).toEqual(['app', 'apiId', 'apiHash', 'testDc']);
});

let id: string;

it('added: the sandbox and Telegram Desktop come up with a live view, and it waits for the sign-in there', async () => {
  id = await add('Telegram (through Desktop)');
  const st = await until(() => lastStatus(id)?.attention?.kind === 'login' && lastStatus(id)!.layers[1].state === 'ok' && lastStatus(id), 30_000, 'the sign-in asked for');
  expect(st.attention).toMatchObject({ liveView: true, message: expect.stringContaining('Sign in to Telegram in the live view') });
  expect(st.attention.qr).toBeUndefined();
  expect(layers(st)).toEqual([
    ['sandbox', 'ok'],
    ['Telegram Desktop', 'ok'],
    ['signed in (Telegram Desktop)', 'waiting'],
    ['session imported', 'waiting'],
    ['connection', 'ok'],
    ['updates', 'waiting'],
  ]);
  // An app gets the size of the live view but not its socket; the page keeps the socket, in the sandbox's directory
  // (outside the app's home), and it answers RFB.
  expect(st.liveView).toEqual({ width: 1280, height: 800 });
  const pane = await api(`/api/accounts/${id}`);
  expect(pane.status.liveView.vncSocket).toBe(join(m.store.account(id)!.dir, 'desktop', 'vnc.sock'));
  expect(await rfbBanner(pane.status.liveView.vncSocket)).toMatch(/^RFB \d{3}\.\d{3}/);
  expect((await account(id))!.liveView).toBe(true);
  expect(pane.status.details).toMatchObject({ signInVia: 'Telegram Desktop', desktop: 'the fake Telegram Desktop', desktopNetwork: 'none', desktopApp: 'running', desktopSignIn: 'signed-out' });
});

it('signed in there: the account makes a session of its own and reads the chats', async () => {
  const key = await desktopSignsIn(id);
  // The manager's view and this test's event stream each have to have the online status.
  const online = await until(async () => {
    const a = await account(id);
    return a?.status?.status === 'online' && lastStatus(id)?.status === 'online' && a;
  }, 30_000, 'online');
  expect(online.self).toEqual({ name: 'Test User', detail: '@testuser', avatar: null });
  expect(layers(lastStatus(id))).toEqual([
    ['sandbox', 'ok'],
    ['Telegram Desktop', 'ok'],
    ['signed in (Telegram Desktop)', 'ok'],
    ['session imported', 'ok'],
    ['connection', 'ok'],
    ['updates', 'ok'],
  ]);
  const secret = JSON.parse(readFileSync(join(accDir(id), 'secret.json'), 'utf8'));
  expect(secret).toMatchObject({ sessionMode: 'own', desktopKey: keyFingerprint(key), session: expect.stringMatching(/^fake:/) });
  const calls = (await fakeControl(accDir(id), { op: 'calls' })) as { method: string }[];
  expect(calls.map((c) => c.method)).toContain('auth.acceptLoginToken');
  await until(() => evs(id).some((e) => e.t === 'conversation'), 10_000, 'the snapshot');
  expect(await app.call(chat, id, 'history', { conversation: `channel:${FAKE_IDS.devs}`, limit: 10 })).toEqual({ count: 3, done: true });
});

it("Telegram Desktop's notifications reach the app, and marking one read presses its button there", async () => {
  const { id: dbusId } = await desk(id, { do: 'notify', title: 'Alice', body: 'are you there?' });
  const ev = await until(() => evs(id).find((e) => e.t === 'notify.new'), 10_000, 'notify.new');
  expect(ev.notification).toMatchObject({ source: 'Telegram Desktop', title: 'Alice', body: 'are you there?', reason: 'message', unread: true });
  const list = await app.call(notifications, id, 'notify.list', {});
  expect(list.notifications.map((n) => n.id)).toEqual([ev.notification.id]);
  await app.call(notifications, id, 'notify.markRead', { ids: [ev.notification.id] });
  const log = join(accDir(id), 'desktop', 'home', '.fake-desktop', 'actions.log');
  await until(() => existsSync(log) && readFileSync(log, 'utf8').includes(`${dbusId} mail-mark-read`), 10_000, 'the button pressed');
  expect((await app.call(notifications, id, 'notify.list', { unreadOnly: true })).notifications).toEqual([]);
  // One the app takes back itself (read on another device) is read for the app too.
  const second = await desk(id, { do: 'notify', title: 'Bob', body: 'later' });
  const n2 = await until(() => evs(id).filter((e) => e.t === 'notify.new').at(1), 10_000, 'the second notification');
  await desk(id, { do: 'close', id: second.id });
  await until(() => evs(id).some((e) => e.t === 'notify.read' && e.ids.includes(n2.notification.id)), 10_000, 'notify.read');
  await expect(app.call(notifications, id, 'notify.mute', { id: n2.notification.id })).rejects.toThrow(/Mute the chat in Telegram/);
});

it('a link it opens, a file it downloads, a "Save as" and an "Attach" go through the channels the extractor owns', async () => {
  expect(await desk(id, { do: 'open', url: 'https://example.org/telegram?ref=1' })).toEqual({ code: 0 });
  const link = await until(() => evs(id).find((e) => e.t === 'desktop.link'), 10_000, 'desktop.link');
  expect(link.link).toMatchObject({ url: 'https://example.org/telegram?ref=1', via: 'xdg-open' });
  expect((await app.call(desktop, id, 'desktop.links', {})).links.map((l) => l.url)).toEqual(['https://example.org/telegram?ref=1']);

  await desk(id, { do: 'download', name: 'notes.txt', text: 'downloaded text' });
  const dl = await until(() => evs(id).find((e) => e.t === 'desktop.download'), 15_000, 'desktop.download');
  expect(dl.download).toMatchObject({ path: 'Telegram Desktop/notes.txt', name: 'notes.txt', size: 15, mime: 'text/plain' });
  const fetched = await app.call(desktop, id, 'desktop.fetch', { id: dl.download.id });
  expect(Buffer.from(fetched.base64, 'base64').toString()).toBe('downloaded text');

  const saved = await desk(id, { do: 'save', name: 'report.pdf', text: 'saved through the portal' });
  expect(saved.path).toBe('/home/user/Downloads/report.pdf');
  const req = await until(() => evs(id).find((e) => e.t === 'desktop.fileRequest'), 10_000, 'desktop.fileRequest');
  expect(req.request).toMatchObject({ kind: 'save', answer: 'downloads', files: ['report.pdf'] });
  await until(() => evs(id).some((e) => e.t === 'desktop.download' && e.download.name === 'report.pdf'), 15_000, 'the saved file announced');

  // Attach with nothing offered: cancelled. With a file offered by an app: that file.
  expect(await desk(id, { do: 'attach' })).toEqual({ cancelled: true });
  expect(await app.call(desktop, id, 'desktop.offer', { name: 'to-send.txt', base64: Buffer.from('from the app').toString('base64') })).toEqual({ name: 'to-send.txt' });
  expect(await desk(id, { do: 'attach' })).toEqual({ files: [{ path: '/home/user/Outbox/to-send.txt', text: 'from the app' }] });
  expect((await app.call(desktop, id, 'desktop.fileRequests', {})).requests.map((r) => [r.kind, r.answer])).toEqual([
    ['open', 'outbox'],
    ['open', 'cancelled'],
    ['save', 'downloads'],
  ]);
  // Status and the log carry counts, never what was in them.
  const st = await until(async () => {
    const s = (await api(`/api/accounts/${id}`)).status;
    return s.details.fileRequests === 3 && s;
  }, 10_000, 'the counts in the status');
  expect(st.details).toMatchObject({ notifications: 2, links: 1, downloads: 2, fileRequests: 3 });
  const text = JSON.stringify(st) + readFileSync(join(accDir(id), 'adapter.log'), 'utf8');
  for (const secret of ['are you there?', 'example.org', 'downloaded text', 'from the app', 'report.pdf']) expect(text).not.toContain(secret);
});

it('signed out in the live view: the account keeps its own session', async () => {
  await desk(id, { do: 'signOut' });
  await until(() => lastStatus(id)?.layers?.[2]?.state === 'off', 10_000, 'the sign-in layer off');
  expect(lastStatus(id)!.status).toBe('online');
  expect(lastStatus(id)!.layers[2].note).toContain('this account keeps its own session');
});

it("refused by Telegram: a second account shares Telegram Desktop's key, and a restart reads it from tdata again", async () => {
  const other = await add('Telegram (shared)');
  await until(() => lastStatus(other)?.attention?.kind === 'login' && lastStatus(other)!.layers[1].state === 'ok', 30_000, 'the sign-in asked for');
  await fakeControl(accDir(other), { op: 'refuseAccept', error: 'SESSION_TOO_FRESH_86400' });
  const key = await desktopSignsIn(other);
  await until(async () => (await account(other))?.status?.status === 'online', 30_000, 'online, shared');
  expect(lastStatus(other)!.layers.find((l: any) => l.name === 'session imported').note).toBe("shares Telegram Desktop's session (auth.acceptLoginToken refused: SESSION_TOO_FRESH_86400)");
  const secret = JSON.parse(readFileSync(join(accDir(other), 'secret.json'), 'utf8'));
  expect(secret).toEqual({ sessionMode: 'shared', userId: String(FAKE_IDS.self), desktopKey: keyFingerprint(key) });
  const before = evs(other).length;
  await api(`/api/accounts/${other}/restart`, {});
  await until(() => evs(other).slice(before).some((e) => e.t === 'status' && e.status === 'online'), 40_000, 'online after the restart');
  // Its sandbox was ended with the old process: one Xvfb per account.
  const r = await fetch(`${m.url}/api/accounts/${other}?purge=1`, { method: 'DELETE' });
  expect(r.ok).toBe(true);
});
