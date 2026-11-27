/**
 * Signing in with an account you already have here (docs/signin-relay.md), end to end: a real manager runs a Google
 * account (extractors/google, signed in to the fake Google) and a Luma account (extractors/luma, signed out of the
 * fake Luma), each in its own Chromium on Xvfb. Luma's "Continue with Google" sends its tab to Google's authorize page;
 * Luma's extension holds it, the manager has the Google account's browser open the link, Google answers there with a
 * code, and Luma's tab loads Luma's redirect address with it. Skipped when Xvfb, chromium or x11vnc cannot be found.
 * Every process it starts is gone at the end.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountsClient, register } from '@dither-accounts/client';
import { browser } from '@dither-accounts/interfaces';
import { createManager, type Manager } from '@dither-accounts/manager';
import { DISPLAY_BINS, resolveBin, resolveBins } from '../packages/browser/src/index.ts';
import { type FakeGoogle, startFakeGoogle } from './fake-google.ts';
import { type FakeLuma, startFakeLuma } from './fake-luma.ts';

const WEB = {
  sapisid: 'sapisid-that-must-not-leak',
  pageKey: `AIza${'P'.repeat(35)}`,
  htmlKey: `AIza${'H'.repeat(35)}`,
  email: 'pat@example.com',
  mailKey: `AIza${'M'.repeat(35)}`,
  mailEmail: 'pat@example.com',
  labels: ['INBOX'],
  mailMark: 'Mk#7731',
  peopleKey: `AIza${'Q'.repeat(35)}`,
};

let bins: ReturnType<typeof resolveBins> | null = null;
try {
  bins = resolveBins(() => {});
} catch (e) {
  console.warn(`signin-relay: skipped, ${(e as Error).message}`);
}
const it = test.skipIf(!bins);

let google: FakeGoogle;
let luma: FakeLuma;
let m: Manager | null = null;
let dir: string;
let app: AccountsClient;
let g = '';
let l = '';
/** Every account made, for the check that none of their processes outlives the test. */
const made: string[] = [];
const events: Record<string, any[]> = {};

const until = async <T>(f: () => T | Promise<T>, ms: number, what: string): Promise<NonNullable<T>> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await f();
    if (v) return v as NonNullable<T>;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const statusOf = (a: string) => events[a]?.filter((e) => e.t === 'status').at(-1);
const create = async (kind: string, label: string, config: Record<string, unknown>) => ((await app.admin({ do: 'create', kind, label, config })) as { id: string }).id;
const logOf = (id: string) => readFileSync(join(m!.store.account(id)!.dir, 'adapter.log'), 'utf8');

function processesOf(ids: string[]): number[] {
  const needles = ids.map((id) => `DITHER_ACCOUNT_ID=${id}`);
  const out: number[] = [];
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d) || Number(d) === process.pid) continue;
    try {
      const env = readFileSync(`/proc/${d}/environ`, 'utf8').split('\0');
      if (needles.some((n) => env.includes(n))) out.push(Number(d));
    } catch {}
  }
  return out;
}

beforeAll(async () => {
  if (!bins) return;
  google = startFakeGoogle({ web: WEB });
  google.addCalendar({ id: WEB.email, summary: WEB.email, timeZone: 'UTC', accessRole: 'owner', primary: true, selected: true, backgroundColor: '#9fe1e7' });
  luma = startFakeLuma({ signedIn: false });
  dir = mkdtempSync(join(tmpdir(), 'dacc-signin-'));
  m = await createManager({ openPage: true, dataDir: dir, port: 0 });
  const reg = await register(m.url, { name: 'signin-app', requests: [{ interface: 'accounts', level: 'manage', kinds: ['google', 'luma', 'site'] }, { interface: 'google.calendar', level: 'read' }, { interface: 'chat', level: 'read', accounts: '*' }, { interface: 'browser', level: 'write', accounts: '*' }] });
  for (const r of reg.requests) expect((await fetch(`${m.url}/api/requests/${r.id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(200);
  app = new AccountsClient({ url: m.url, app: reg.app, token: reg.token, onEvents: (a, list) => (events[a] ??= []).push(...list) });
  await until(() => app.connected, 5000, 'the app connected');
}, 60_000);

afterAll(async () => {
  if (!bins) return;
  app?.close();
  await m?.stop();
  const left = processesOf(made);
  for (const pid of left) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
  google?.stop();
  luma?.stop();
  rmSync(dir, { recursive: true, force: true });
  expect(left).toEqual([]);
}, 30_000);

it(
  "Luma's Continue with Google is answered by the Google account's browser, and Luma's tab finishes the sign-in",
  async () => {
    g = await create('google', 'Google (test)', { authuser: 0, testOrigin: google.url, apiBase: google.url, mail: false });
    made.push(g);
    await until(() => statusOf(g)?.status === 'online', 60_000, 'Google online');
    // Remembered from an earlier pick on the chooser, so this one goes ahead without one.
    l = await create('luma', 'Luma (test)', { testOrigin: luma.url, testSignInOrigins: { google: google.url }, signInWith: { google: g } });
    made.push(l);
    await until(() => statusOf(l)?.attention?.kind === 'login', 60_000, 'Luma asking for a sign-in');

    luma.continueWithGoogle(google.url);
    await until(() => luma.googleCodes.length > 0, 60_000, "Google's code at Luma's /google");

    // A linked account: Google's chooser and its Continue were pressed for you, with real input (trusted events).
    expect(google.presses).toEqual([
      { step: 'choose', trusted: true },
      { step: 'consent', trusted: true },
    ]);
    expect(logOf(g)).toContain('pressed this account in the chooser');
    expect(logOf(g)).toContain('pressed Continue');
    // Google saw the link in its own, signed-in browser; Luma's never went there.
    expect(google.signIns).toHaveLength(1);
    expect(google.signIns[0]).toMatchObject({ clientId: 'luma-web.apps.example.com', redirectUri: `${luma.url}/google`, signedIn: true });
    expect(luma.googleCodes).toEqual([expect.stringMatching(/^4\/fake-code-\d+$/)]);
    await until(() => statusOf(l)?.status === 'online', 60_000, 'Luma signed in');

    // Neither log nor status has the code, the state or the link.
    for (const id of [g, l]) {
      const log = logOf(id);
      expect(log).toContain('sign-in');
      for (const secret of [luma.googleCodes[0]!, 'state-123', 'luma-web.apps.example.com', WEB.sapisid]) expect(log).not.toContain(secret);
      expect(JSON.stringify(events[id])).not.toContain(luma.googleCodes[0]!);
    }
    // The Google account went back to as it was: no sign-in tab left, nothing asked of you.
    await until(() => statusOf(g)?.status === 'online' && !statusOf(g)?.attention, 10_000, 'Google back to online');
  },
  240_000,
);


it(
  'with no account remembered, the tab waits on the chooser with Google hearing nothing; a pick there signs in, and is remembered',
  async () => {
    const other = startFakeLuma({ signedIn: false });
    let id = '';
    try {
      id = await create('luma', 'Luma (chooser)', { testOrigin: other.url, testSignInOrigins: { google: google.url } });
      made.push(id);
      await until(() => statusOf(id)?.attention?.kind === 'login', 60_000, 'Luma asking for a sign-in');
      const before = google.signIns.length;
      const pressed = google.presses.length;
      other.continueWithGoogle(google.url);
      // The manager has answered which accounts could sign in: by then Luma's own request was stopped, or not.
      await until(() => /sign-in \S+: Google for http:\/\/127\.0\.0\.1:\d+, 1 account\(s\) could answer$/m.test(logOf(id)), 30_000, 'the chooser filled');
      expect(google.signIns.length).toBe(before);
      expect(other.googleCodes).toEqual([]);
      expect(logOf(id)).not.toContain('one remembered');

      // You, in the live view, once the chooser has drawn the accounts: Tab to the first account (the Google one), Enter. Real keys on the account's own display.
      await until(() => /sign-in \S+: the chooser shows the accounts$/m.test(logOf(id)), 30_000, 'the accounts drawn');
      const display = String(statusOf(id)?.layers?.find((x: any) => x.name === 'display')?.note ?? '').match(/:(\d+)/)?.[1];
      expect(display).toBeTruthy();
      const xdotool = resolveBin(DISPLAY_BINS.xdotool, () => {});
      const keys = Bun.spawnSync([xdotool, 'key', '--delay', '150', 'Tab', 'Return'], { env: { ...process.env, DISPLAY: `:${display}` } });
      expect(keys.exitCode).toBe(0);
      await until(() => other.googleCodes.length > 0, 60_000, "Google's code at this Luma's /google");
      expect(google.signIns.length).toBe(before + 1);
      expect(google.signIns.at(-1)).toMatchObject({ redirectUri: `${other.url}/google`, signedIn: true });
      // "Link it" is on by default: Google's screens were gone through for you, and the next sign-in goes ahead with it.
      expect(google.presses.slice(pressed)).toEqual([
        { step: 'choose', trusted: true },
        { step: 'consent', trusted: true },
      ]);
      expect(JSON.parse(m!.store.account(id)!.config).signInWith).toEqual({ google: g });
      await until(() => statusOf(id)?.status === 'online', 60_000, 'this Luma signed in');
    } finally {
      if (id) await app.admin({ do: 'delete', account: id });
      other.stop();
    }
  },
  120_000,
);

it(
  "a pick that is not linked leaves Google's screens to you: Google's account asks for you, and nothing is pressed until you do",
  async () => {
    const other = startFakeLuma({ signedIn: false });
    let id = '';
    try {
      id = await create('luma', 'Luma (unlinked)', { testOrigin: other.url, testSignInOrigins: { google: google.url } });
      made.push(id);
      await until(() => statusOf(id)?.attention?.kind === 'login', 60_000, 'Luma asking for a sign-in');
      const before = google.signIns.length;
      const pressed = google.presses.length;
      const count = (re: RegExp) => (logOf(g).match(re) ?? []).length;
      const answering = count(/answering a sign-in to /g);
      const screens = google.oauthReady.length;
      const linked = count(/going through the provider's screens/g);
      other.continueWithGoogle(google.url);
      await until(() => /sign-in \S+: the chooser shows the accounts$/m.test(logOf(id)), 30_000, 'the accounts drawn');
      const displayOf = (a: string) => String(statusOf(a)?.layers?.find((x: any) => x.name === 'display')?.note ?? '').match(/:(\d+)/)?.[1];
      const xdotool = resolveBin(DISPLAY_BINS.xdotool, () => {});
      const keys = (a: string, ...k: string[]) => {
        const d = displayOf(a);
        expect(d).toBeTruthy();
        expect(Bun.spawnSync([xdotool, 'key', '--delay', '150', ...k], { env: { ...process.env, DISPLAY: `:${d}` } }).exitCode).toBe(0);
      };
      // You, on Luma's chooser: the account (Tab), off with "Link it" (Tab, space), back to the account, Enter.
      keys(id, 'Tab', 'Tab', 'space', 'shift+Tab', 'Return');
      await until(() => google.signIns.length > before, 30_000, "the link opened in Google's browser");
      // Google's account asks for you, and nothing is pressed for you.
      const asks = await until(() => (statusOf(g)?.attention?.kind === 'verify' ? statusOf(g).attention : null), 30_000, "Google's account asking for you");
      expect(asks.message).toContain('may be asking you to allow a sign-in');
      expect(google.presses.length).toBe(pressed);
      expect(count(/answering a sign-in to /g)).toBe(answering + 1);
      expect(count(/going through the provider's screens/g)).toBe(linked);

      // You, in Google's live view: a click on the account, then on Continue (real clicks on its display).
      const click = (step: string) => {
        const at = google.oauthReady.slice(screens).findLast((x) => x.step === step)!;
        expect(Bun.spawnSync([xdotool, 'mousemove', '--sync', String(at.x), String(at.y), 'click', '1'], { env: { ...process.env, DISPLAY: `:${displayOf(g)}` } }).exitCode).toBe(0);
      };
      await until(() => google.oauthReady.slice(screens).some((x) => x.step === 'choose'), 30_000, "Google's chooser shown");
      click('choose');
      await until(() => google.oauthReady.slice(screens).some((x) => x.step === 'consent'), 30_000, "Google's Continue screen shown");
      click('consent');
      await until(() => other.googleCodes.length > 0, 60_000, "Google's code at this Luma's /google");
      expect(google.presses.slice(pressed)).toEqual([
        { step: 'choose', trusted: true },
        { step: 'consent', trusted: true },
      ]);
      // Not linked: the next sign-in asks again.
      expect(JSON.parse(m!.store.account(id)!.config).signInWith).toBeUndefined();
      await until(() => statusOf(g)?.status === 'online' && !statusOf(g)?.attention, 10_000, 'Google back to online');
    } finally {
      if (id) await app.admin({ do: 'delete', account: id });
      other.stop();
    }
  },
  120_000,
);

it(
  "the general site kind: any site by its address signs in with the linked Google account, and lends its browser on that site only",
  async () => {
    const other = startFakeLuma({ signedIn: false });
    let id = '';
    try {
      id = await create('site', 'Website (test)', { url: `${other.url}/`, testOrigin: other.url, testSignInOrigins: { google: google.url }, signInWith: { google: g } });
      made.push(id);
      await until(() => statusOf(id)?.status === 'online', 60_000, 'the site online');
      expect(statusOf(id).layers.find((x: any) => x.name === 'site')).toMatchObject({ state: 'ok', note: '127.0.0.1' });
      const pressed = google.presses.length;
      const before = google.signIns.length;
      other.continueWithGoogle(google.url);
      await until(() => other.googleCodes.length > 0, 60_000, "Google's code at the site's /google");
      expect(google.signIns.length).toBe(before + 1);
      expect(google.signIns.at(-1)).toMatchObject({ redirectUri: `${other.url}/google`, signedIn: true });
      expect(google.presses.slice(pressed)).toEqual([
        { step: 'choose', trusted: true },
        { step: 'consent', trusted: true },
      ]);
      expect(logOf(id)).toMatch(/sign-in \S+: the answer went to the tab/);
      for (const secret of [other.googleCodes[0]!, 'state-123', 'luma-web.apps.example.com']) expect(logOf(id)).not.toContain(secret);

      // The browser interface, on its site: a tab opened there and read; anywhere else is refused.
      const opened = (await app.call(browser, id, 'browser.open', { url: `${other.url}/` })) as { tabId: number; url: string };
      expect(opened.url).toBe(`${other.url}/`);
      const read = (await app.call(browser, id, 'browser.read', { tabId: opened.tabId })) as { text: string };
      // Signed in by the relay: the site's page is its signed-in one.
      expect(read.text).toContain('Home');
      await expect(app.call(browser, id, 'browser.open', { url: 'https://example.com/' })).rejects.toThrow();
      await app.call(browser, id, 'browser.close', { tabId: opened.tabId });
    } finally {
      if (id) await app.admin({ do: 'delete', account: id });
      other.stop();
    }
  },
  120_000,
);

it(
  "an account added with a Google account to sign in with signs itself in: its browser presses Luma's Sign in and Continue with Google, the Google account the rest",
  async () => {
    const other = startFakeLuma({ signedIn: false, google: google.url });
    let id = '';
    try {
      const pressed = google.presses.length;
      const before = google.signIns.length;
      // As the page's add form sends it.
      const r = await fetch(`${m!.url}/api/accounts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'luma', label: 'Luma (signs itself in)', config: { testOrigin: other.url, testSignInOrigins: { google: google.url } }, signInWith: { google: g } }),
      });
      expect(r.status).toBe(200);
      const added = (await r.json()) as { id: string; signIn: { running: boolean; account: string } };
      id = added.id;
      made.push(id);
      expect(added.signIn).toMatchObject({ running: true, account: g, provider: 'google' });
      expect(JSON.parse(m!.store.account(id)!.config).signInWith).toEqual({ google: g });

      // Nobody touches either screen: the site's own Sign in and its Google button, then Google's chooser and Continue.
      await until(() => other.googleCodes.length > 0, 90_000, "Google's code at Luma's /google");
      expect(other.pressed).toEqual([
        { what: 'sign in', trusted: true },
        { what: 'google', trusted: true },
      ]);
      expect(google.signIns.length).toBe(before + 1);
      expect(google.signIns.at(-1)).toMatchObject({ redirectUri: `${other.url}/google`, signedIn: true });
      expect(google.presses.slice(pressed)).toEqual([
        { step: 'choose', trusted: true },
        { step: 'consent', trusted: true },
      ]);
      const done = await until(async () => {
        const s = ((await (await fetch(`${m!.url}/api/accounts/${id}/sign-in`)).json()) as { signIn: { running: boolean; ok: boolean; note: string } }).signIn;
        return s && !s.running ? s : null;
      }, 30_000, 'the started sign-in to end');
      expect(done).toMatchObject({ ok: true });
      await until(() => statusOf(id)?.status === 'online', 60_000, 'Luma signed in');
      expect(logOf(id)).toContain("pressed the site's own Sign in");
      expect(logOf(id)).toContain("pressed the site's Google button");
      for (const secret of [other.googleCodes[0]!, 'state-123', 'luma-web.apps.example.com']) expect(logOf(id)).not.toContain(secret);
    } finally {
      if (id) await app.admin({ do: 'delete', account: id });
      other.stop();
    }
  },
  150_000,
);

it(
  'a website account signs in when asked to with a Google account here, which is then linked for it',
  async () => {
    const other = startFakeLuma({ signedIn: false, google: google.url });
    let id = '';
    try {
      id = await create('site', 'Website (asked to sign in)', { url: `${other.url}/`, testOrigin: other.url, testSignInOrigins: { google: google.url } });
      made.push(id);
      await until(() => statusOf(id)?.status === 'online', 60_000, 'the site online');
      // A Google account it cannot be: refused at once, and nothing linked.
      const wrong = await fetch(`${m!.url}/api/accounts/${id}/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: id }) });
      expect(wrong.status).toBe(400);
      expect(JSON.parse(m!.store.account(id)!.config).signInWith).toBeUndefined();

      const r = await fetch(`${m!.url}/api/accounts/${id}/sign-in`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: 'google', account: g }) });
      expect(r.status).toBe(200);
      await until(() => other.googleCodes.length > 0, 90_000, "Google's code at the site's /google");
      expect(other.pressed).toEqual([
        { what: 'sign in', trusted: true },
        { what: 'google', trusted: true },
      ]);
      expect(JSON.parse(m!.store.account(id)!.config).signInWith).toEqual({ google: g });
      const done = await until(async () => {
        const s = ((await (await fetch(`${m!.url}/api/accounts/${id}/sign-in`)).json()) as { signIn: { running: boolean; ok: boolean } }).signIn;
        return s && !s.running ? s : null;
      }, 30_000, 'the started sign-in to end');
      expect(done.ok).toBe(true);
    } finally {
      if (id) await app.admin({ do: 'delete', account: id });
      other.stop();
    }
  },
  150_000,
);
