/**
 * Telegram accounts signed in through Telegram Desktop, through a throwaway manager process (main.ts) that offers it
 * (DITHER_TELEGRAM_DESKTOP=1), as the page and an app use them.
 *
 *   bun scripts/verify-telegram-desktop.ts [--keep]
 *     The fake Telegram (TELEGRAM_FAKE=1) and the fake Telegram Desktop (TELEGRAM_DESKTOP_FAKE=1) in the real
 *     sandbox: the form, the live view, a sign-in there made into the account's own session, notifications, links,
 *     downloads and file dialogs routed to an app, the shared fallback when Telegram refuses, a restart.
 *
 *   bun scripts/verify-telegram-desktop.ts --real [--shots dir] [--start-messaging] [--keep]
 *     The real Telegram Desktop (nixpkgs#telegram-desktop) in the sandbox, up to its sign-in screen and no further:
 *     it starts, renders on its display (screenshots with --shots), writes its tdata inside the account's directory
 *     where tdata.ts reads it (user 0, its keys), and talks to our services on the bus. --start-messaging presses
 *     "Start Messaging" to show its QR code. The extractor's own client stays on the fake Telegram: only Telegram
 *     Desktop itself reaches Telegram, as it does before anyone signs in. Never signs in.
 *
 * Port 18511, data under /tmp (deleted after unless --keep).
 */
import type { Subprocess } from 'bun';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { AccountsClient, register } from '@dither-accounts/client';
import { desktop, notifications } from '@dither-accounts/interfaces';
import { resolveBin } from '../packages/sandbox/src/bins.ts';
import { FAKE_IDS, fakeControl } from '../extractors/telegram/src/fake.ts';
import { keyFingerprint, readTdata, signedInAccount } from '../extractors/telegram/src/tdata.ts';

const ROOT = resolve(import.meta.dir, '..');
const PORT = 18511;
const MGR = `http://127.0.0.1:${PORT}`;
const T = mkdtempSync('/tmp/dacc-tgdeskverify-');
const argv = process.argv.slice(2);
const keep = argv.includes('--keep');
const real = argv.includes('--real');
const shots = argv.includes('--shots') ? resolve(argv[argv.indexOf('--shots') + 1]) : null;
const startMessaging = argv.includes('--start-messaging');

let failures = 0;
const check = (ok: unknown, what: string, detail: unknown = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail !== '' && !ok ? `  ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};
const until = async <T>(f: () => T | Promise<T>, ms: number, what: string): Promise<T | null> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await f();
      if (v) return v;
    } catch {}
    await Bun.sleep(150);
  }
  console.log(`     (gave up waiting for ${what})`);
  return null;
};
const get = async (path: string) => (await fetch(MGR + path)).json() as Promise<any>;
const post = async (path: string, body: unknown) => (await fetch(MGR + path, { method: 'POST', headers: { 'content-type': 'application/json', origin: MGR }, body: JSON.stringify(body) })).json() as Promise<any>;
const account = async (id: string) => (await get('/api/state')).accounts.find((a: any) => a.id === id);
const pane = async (id: string) => get(`/api/accounts/${id}`);
const accDir = (id: string) => join(T, 'data', 'accounts', id);
const chain = (st: any) => (st?.layers ?? []).map((l: any) => `${l.name}:${l.state}`).join(' → ');
const events = new Map<string, any[]>();
const evs = (id: string) => events.get(id) ?? [];

let seq = 0;
const desk = async (id: string, cmd: Record<string, unknown>) => {
  const inbox = join(accDir(id), 'desktop', 'home', '.fake-desktop');
  mkdirSync(inbox, { recursive: true });
  const name = `${String(++seq).padStart(4, '0')}.json`;
  writeFileSync(join(inbox, `${name}.tmp`), JSON.stringify(cmd));
  renameSync(join(inbox, `${name}.tmp`), join(inbox, name));
  const done = await until(() => existsSync(join(inbox, `${name}.done`)), 20_000, `the fake Telegram Desktop to ${cmd.do}`);
  if (!done) throw new Error(`the fake Telegram Desktop did not ${cmd.do}`);
  const r = JSON.parse(readFileSync(join(inbox, `${name}.done`), 'utf8'));
  if (!r.ok) throw new Error(r.error);
  return r.result;
};

/** The sandbox's display as a PNG, with ImageMagick's import (PATH, else nixpkgs#imagemagick). */
const shot = async (display: string, name: string) => {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  const bin = resolveBin({ name: 'import', env: 'IMPORT_BIN', nix: 'imagemagick' }, () => {});
  const p = Bun.spawn([bin, '-display', display, '-window', 'root', join(shots, name)], { stderr: 'pipe' });
  check((await p.exited) === 0, `screenshot ${join(shots, name)}`);
};

let mgr: Subprocess | null = null;
let app: AccountsClient | null = null;
try {
  console.log(`     workdir ${T}${real ? ' (the real Telegram Desktop)' : ''}`);
  mkdirSync(join(T, 'data'));
  const env: Record<string, string | undefined> = { ...process.env, DITHER_TELEGRAM_DESKTOP: '1', TELEGRAM_FAKE: '1', TELEGRAM_DESKTOP_POLL_MS: '500', TELEGRAM_DESKTOP_RETRY_MS: '2000' };
  if (!real) env.TELEGRAM_DESKTOP_FAKE = '1';
  else delete env.TELEGRAM_DESKTOP_FAKE;
  mgr = Bun.spawn(['bun', 'packages/manager/src/main.ts', '--data', join(T, 'data'), '--port', String(PORT), '--host', '127.0.0.1', '--web-dist', join(T, 'no-page')], {
    cwd: ROOT,
    env,
    stdout: Bun.file(join(T, 'manager.log')),
    stderr: Bun.file(join(T, 'manager.err')),
  });
  check(await until(async () => (await fetch(`${MGR}/api/health`)).ok, 20_000, 'the manager'), `a throwaway manager on ${PORT}`);

  const tg = (await get('/api/state')).kinds.find((k: any) => k.kind === 'telegram');
  check(JSON.stringify(tg?.add?.fields?.map((f: any) => f.key)) === '["signIn","apiId","apiHash","testDc"]', 'the add form asks how to sign in (empty or qr: a QR code; desktop: Telegram Desktop)', tg?.add?.fields);
  check(JSON.stringify(tg?.interfaces) === '["chat","notifications","desktop"]', 'the kind serves chat, notifications and desktop', tg?.interfaces);

  const reg = await register(MGR, {
    name: 'verify-telegram-desktop',
    requests: [
      { interface: 'chat', level: 'manage', accounts: '*' },
      { interface: 'notifications', level: 'write', accounts: '*' },
      { interface: 'desktop', level: 'write', accounts: '*' },
    ],
  });
  for (const r of reg.requests) await fetch(`${MGR}/api/requests/${r.id}/approve`, { method: 'POST', headers: { origin: MGR }, body: '{}' });
  app = new AccountsClient({ url: MGR, app: reg.app, token: reg.token, onEvents: (a, e) => (events.get(a) ?? events.set(a, []).get(a)!).push(...e) });
  check(await until(() => app!.connected, 5000, 'the app'), 'an app with grants on chat, notifications and desktop, connected');

  const added = await post('/api/accounts', { kind: 'telegram', label: real ? 'Telegram Desktop (real)' : 'Telegram Desktop (fake)', config: { signIn: 'desktop' } });
  check(added.id, 'added as the page adds it, with signIn: desktop', added);
  const id = added.id as string;
  const waiting = await until(async () => {
    const st = (await pane(id)).status;
    return st?.attention?.kind === 'login' && st.layers?.[1]?.state === 'ok' && st;
  }, real ? 60_000 : 30_000, 'Telegram Desktop running and the sign-in asked for');
  check(waiting, `the sandbox and ${real ? 'the real' : 'the fake'} Telegram Desktop run; it asks you to sign in there`, chain((await pane(id)).status));
  console.log(`     chain: ${chain(waiting)}`);
  const lv = waiting?.liveView;
  check(lv?.vncSocket && lv.width === 1280 && lv.height === 800, `a live view: VNC on ${lv?.vncSocket}, 1280×800`, lv);
  check((await account(id))?.liveView, 'the page offers the live view');
  const display = waiting?.details?.desktopDisplay as string;

  if (real) {
    // The real Telegram Desktop: its files where we expect them, its tdata readable, our services in use.
    const home = join(accDir(id), 'desktop', 'home');
    const tdata = join(home, '.local/share/TelegramDesktop/tdata');
    // key_datas comes first; the account's own file once it has keys for its DCs.
    const t = await until(() => {
      const r = readTdata(tdata);
      return r.accounts.length > 0 && r;
    }, 60_000, "Telegram Desktop's tdata with its account");
    check(t, `Telegram Desktop wrote its tdata inside the account's directory (${tdata})`);
    if (t) {
      check(t.version >= 7_000_000, `key_datas is in the format tdata.ts reads (version ${t.version})`);
      const a = t.accounts[0];
      check(a && a.userId === 0n && a.keys.length > 0 && a.keys.every((k) => k.key.length === 256), `its account 0: user 0 (not signed in), main DC ${a?.mainDcId}, keys for DC ${a?.keys.map((k) => k.dcId).join(', ')}`);
      check(signedInAccount(t) === null, 'nothing to import: nobody is signed in');
    }
    check(existsSync(join(home, '.local/share/TelegramDesktop/log.txt')), 'its log is in the sandbox too');
    const log = readFileSync(join(home, '.local/share/TelegramDesktop/log.txt'), 'utf8');
    check(!/portal\.Settings\.ReadAll failed|FileChooser version failed/.test(log), 'it found our portals on the bus (no "portal … failed" in its log)');
    check(/Working dir: \/home\/user\/\.local\/share\/TelegramDesktop\//.test(log), 'its working dir is the sandbox one (-workdir)');
    const realTd = join(homedir(), '.local/share/TelegramDesktop');
    check(!existsSync(join(realTd, 'tdata', 'key_datas')) || !readFileSync(join(realTd, 'tdata', 'key_datas')).equals(readFileSync(join(tdata, 'key_datas'))), "the user's own Telegram Desktop data (if any) is untouched");
    // The status action answers with the live details (the status itself is sent when something changes).
    const bus = await until(async () => {
      const r = await post(`/api/accounts/${id}/call`, { op: 'action', input: { action: 'status' } });
      const b = r?.result?.desktop?.desktopBus as string | null;
      return b?.includes('Notifications.GetCapabilities') && b;
    }, 30_000, 'Telegram Desktop on our bus');
    check(bus, `it uses our desktop services: ${bus}`);
    await shot(display, '1-welcome.png');
    if (startMessaging) {
      const xdotool = resolveBin({ name: 'xdotool', env: 'XDOTOOL_BIN', nix: 'xdotool' }, () => {});
      // "Start Messaging" sits in the middle of the window, which is fitted to the display.
      await Bun.sleep(4000);
      const p = Bun.spawn([xdotool, 'mousemove', '640', '505', 'click', '1'], { env: { DISPLAY: display } });
      await p.exited;
      await Bun.sleep(6000);
      await shot(display, '2-sign-in.png');
      check(true, 'pressed "Start Messaging": its own QR sign-in screen (see the screenshot)');
    }
    const st = (await pane(id)).status;
    check(st.layers?.[2]?.state === 'waiting' && st.layers?.[3]?.state === 'waiting', 'it waits there: signed in (Telegram Desktop) and session imported both waiting', chain(st));
    const statusText = JSON.stringify(st);
    check(!/[0-9a-f]{64}/.test(statusText), 'the status carries no key material');
  } else {
    // The fake Telegram Desktop: a sign-in, then what it hands out.
    const key = randomBytes(256);
    await fakeControl(accDir(id), { op: 'authorizeKey', fingerprint: keyFingerprint(key) });
    await desk(id, { do: 'signIn', userId: FAKE_IDS.self, dcId: 2, keyHex: key.toString('hex') });
    const online = await until(async () => (await account(id))?.online && (await pane(id)).status?.status === 'online' && (await pane(id)).status, 30_000, 'online');
    check(online, `signed in there: online as ${online?.self?.displayName}`, chain(online));
    console.log(`     chain: ${chain(online)}`);
    const secret = JSON.parse(readFileSync(join(accDir(id), 'secret.json'), 'utf8'));
    check(secret.sessionMode === 'own' && secret.session && secret.desktopKey === keyFingerprint(key), 'a session of its own (auth.acceptLoginToken), not a copy of Desktop’s key', Object.keys(secret));
    await desk(id, { do: 'notify', title: 'Alice', body: 'hello' });
    const note = await until(() => evs(id).find((e) => e.t === 'notify.new'), 10_000, 'notify.new');
    check(note?.notification?.title === 'Alice', "Telegram Desktop's notification reaches the app (notify.new)");
    await app.call(notifications, id, 'notify.markRead', { ids: [note.notification.id] });
    check(await until(() => readFileSync(join(accDir(id), 'desktop/home/.fake-desktop/actions.log'), 'utf8').includes('mail-mark-read'), 10_000, 'the button'), 'notify.markRead presses its "Mark as read"');
    await desk(id, { do: 'open', url: 'https://example.org/x' });
    check(await until(() => evs(id).some((e) => e.t === 'desktop.link'), 10_000, 'desktop.link'), 'a link it opens reaches the app (desktop.link), opened nowhere');
    await desk(id, { do: 'download', name: 'a.txt', text: 'A' });
    const dl = await until(() => evs(id).find((e) => e.t === 'desktop.download'), 15_000, 'desktop.download');
    const f = dl && (await app.call(desktop, id, 'desktop.fetch', { id: dl.download.id }));
    check(f && Buffer.from(f.base64, 'base64').toString() === 'A', 'a download is announced once whole, and fetched (desktop.fetch)');
    const saved = await desk(id, { do: 'save', name: 'b.txt', text: 'B' });
    check(saved.path === '/home/user/Downloads/b.txt', '"Save as" goes to the downloads folder (FileChooser portal)', saved);
    await app.call(desktop, id, 'desktop.offer', { name: 'c.txt', base64: Buffer.from('C').toString('base64') });
    const att = await desk(id, { do: 'attach' });
    check(att.files?.[0]?.text === 'C', '"Attach" is answered with what an app offered (desktop.offer)', att);
    await desk(id, { do: 'signOut' });
    check(await until(async () => (await pane(id)).status?.layers?.[2]?.state === 'off' && (await pane(id)).status?.status === 'online', 10_000, 'still online'), 'signed out in the live view: the account keeps its own session');

    const shared = await post('/api/accounts', { kind: 'telegram', label: 'shared', config: { signIn: 'desktop' } });
    await until(async () => (await pane(shared.id)).status?.layers?.[1]?.state === 'ok', 30_000, 'the second sandbox');
    await fakeControl(accDir(shared.id), { op: 'refuseAccept', error: 'SESSION_TOO_FRESH_86400' });
    const key2 = randomBytes(256);
    await fakeControl(accDir(shared.id), { op: 'authorizeKey', fingerprint: keyFingerprint(key2) });
    await desk(shared.id, { do: 'signIn', userId: FAKE_IDS.self, dcId: 2, keyHex: key2.toString('hex') });
    const sst = await until(async () => (await pane(shared.id)).status?.status === 'online' && (await pane(shared.id)).status, 30_000, 'online, shared');
    check(sst?.layers?.find((l: any) => l.name === 'session imported')?.note?.startsWith("shares Telegram Desktop's session"), 'refused by Telegram: it shares Telegram Desktop’s session, and says so', chain(sst));
    check(!JSON.parse(readFileSync(join(accDir(shared.id), 'secret.json'), 'utf8')).session, 'and keeps no copy of that key in secret.json');
    await post(`/api/accounts/${shared.id}/restart`, {});
    check(await until(async () => (await account(shared.id))?.online, 40_000, 'online after a restart'), 'a restart reads it from tdata again');
  }

  const log = readFileSync(join(accDir(id), 'adapter.log'), 'utf8');
  check(!/hello|example\.org|[0-9a-f]{64}/.test(log), 'its log carries no message text, link or key');
  const del = await fetch(`${MGR}/api/accounts/${id}?purge=1`, { method: 'DELETE', headers: { origin: MGR } });
  check(del.ok && (await until(() => !existsSync(accDir(id)), 15_000, 'the directory gone')), 'removed on the page with its directory');
  check(await until(() => !existsSync(`/tmp/.X11-unix/${display?.replace(':', 'X')}`), 15_000, 'the display gone'), `its display ${display} is gone with it`);
} catch (e) {
  check(false, `stopped: ${(e as Error).stack ?? e}`);
} finally {
  app?.close();
  mgr?.kill('SIGTERM');
  await mgr?.exited;
  if (!keep) rmSync(T, { recursive: true, force: true });
  else console.log(`     kept ${T}`);
  console.log(failures ? `${failures} FAILED` : 'all ok');
  process.exit(failures ? 1 : 0);
}
