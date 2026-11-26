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
import { createManager, type Manager } from '@dither-accounts/manager';
import { resolveBins, resolveXdotool } from '../packages/browser/src/index.ts';
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
  const reg = await register(m.url, { name: 'signin-app', requests: [{ interface: 'accounts', level: 'manage', kinds: ['google', 'luma'] }, { interface: 'google.calendar', level: 'read' }, { interface: 'chat', level: 'read', accounts: '*' }] });
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
      other.continueWithGoogle(google.url);
      // The manager has answered which accounts could sign in: by then Luma's own request was stopped, or not.
      await until(() => /sign-in \S+: Google for http:\/\/127\.0\.0\.1:\d+, 1 account\(s\) could answer$/m.test(logOf(id)), 30_000, 'the chooser filled');
      expect(google.signIns.length).toBe(before);
      expect(other.googleCodes).toEqual([]);
      expect(logOf(id)).not.toContain('one remembered');

      // You, in the live view, once the chooser has drawn the accounts: Tab to the first account (the Google one), Enter. Real keys on the account's own display.
      await until(() => /sign-in \S+: the chooser shows the accounts$/m.test(logOf(id)), 30_000, 'the accounts drawn');
      const display = String(statusOf(id)?.layers?.find((x: any) => x.name === 'display')?.note ?? '').match(/^:(\d+)/)?.[1];
      expect(display).toBeTruthy();
      const xdotool = resolveXdotool(() => {});
      const keys = Bun.spawnSync([xdotool, 'key', '--delay', '150', 'Tab', 'Return'], { env: { ...process.env, DISPLAY: `:${display}` } });
      expect(keys.exitCode).toBe(0);
      await until(() => other.googleCodes.length > 0, 60_000, "Google's code at this Luma's /google");
      expect(google.signIns.length).toBe(before + 1);
      expect(google.signIns.at(-1)).toMatchObject({ redirectUri: `${other.url}/google`, signedIn: true });
      // "Use it next time" is on by default: the next sign-in goes ahead with it.
      expect(JSON.parse(m!.store.account(id)!.config).signInWith).toEqual({ google: g });
      await until(() => statusOf(id)?.status === 'online', 60_000, 'this Luma signed in');
    } finally {
      if (id) await app.admin({ do: 'delete', account: id });
      other.stop();
    }
  },
  120_000,
);
