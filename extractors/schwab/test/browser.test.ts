/**
 * extractors/schwab end to end in a real Chromium (Xvfb, the extension, x11vnc) against the fake Schwab
 * (fake-schwab.ts), with a stand-in for the manager's /extractor socket: signed out it asks you to sign in; after the
 * password Schwab asks for a code and the account says so (the attention `verify`), answering nothing; once you are
 * in, the pull follows by itself: History for each account (the menu picker, Custom range, Search, Export, CSV in the
 * format dialog) and Realized Gain/Loss, each file from Chromium's Downloads into the spool under dither-finance's
 * name, byte for byte what Schwab sent. A file saved in Downloads by hand goes over too.
 *
 * Then the passkey, whose ceremonies run in the fake's sign-in widget: a frame from another origin of the same site
 * (as sws-gateway*.schwab.com's), so every passkey request comes from a subframe. The three attentions in turn
 * (login, passkey, passkey_check), a passkey enrolled in the settings frame and checked by the relying party (the
 * frame's origin, crossOrigin and the top origin as Chromium writes them), log out and in with it; then, with the
 * session gone, a pull signs itself in (clicking the widget's button, which ignores clicks until it has hydrated) and
 * pulls; after an idle logout that leaves a sign-in page whose passkey option asks for nothing, a pull loads a fresh
 * one and signs in there; then a code asked for after the passkey holds every pull, typing nothing, until you are in. No key, credential
 * id or user handle on the wire to the manager. Skipped without Xvfb, chromium or x11vnc.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server, ServerWebSocket, Subprocess } from 'bun';
import { resolveBins } from '../../../packages/browser/src/index.ts';
import { ADD_PASSKEY_MESSAGE, CHALLENGE_MESSAGE, CHECK_MESSAGE, CHECK_SIGNED_OUT_MESSAGE, iso, SIGN_IN_MESSAGE } from '../src/schwab.ts';
import { exportCsv, type FakeSchwab, startFakeSchwab } from './fake-schwab.ts';

let bins: ReturnType<typeof resolveBins> | null = null;
try {
  bins = resolveBins(() => {});
} catch (e) {
  console.warn(`schwab browser: skipped, ${(e as Error).message}`);
}
const it = test.skipIf(!bins);

let fake: FakeSchwab;
let hub: Server<undefined>;
let sock: ServerWebSocket<undefined> | null = null;
let proc: Subprocess | null = null;
let dir: string;
const events: any[] = [];
const replies = new Map<string, any>();

const lastStatus = () => events.filter((e) => e.t === 'status').at(-1);
const until = async (f: () => boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (f()) return;
    await Bun.sleep(100);
  }
  const st = lastStatus();
  const logs = events.filter((e) => e.t === 'log').slice(-12).map((e) => `${e.level} ${e.msg} ${e.data ? JSON.stringify(e.data).slice(0, 400) : ''}`);
  throw new Error(`timed out waiting for ${what}; last status ${JSON.stringify(st && { status: st.status, attention: st.attention, layers: st.layers, details: st.details })}; fake ${JSON.stringify(fake.log)}; logs ${logs.join(' | ')}`);
};
async function call(t: string, input: Record<string, unknown> = {}) {
  const rid = `r${Math.random().toString(36).slice(2)}`;
  sock!.send(JSON.stringify({ t, rid, ...input }));
  await until(() => replies.has(rid), 10_000, `a reply to ${t}`);
  return replies.get(rid);
}
const pulls = () => events.filter((e) => e.t === 'statements.pulled');
const files = () => events.filter((e) => e.t === 'statements.file').map((e) => e.file);

// The extractor keeps the machine's own time zone; "today" is the local calendar day.
const [Y, M, D] = Bun.spawnSync(['date', '+%Y %m %d']).stdout.toString().trim().split(' ').map(Number);
const today = iso(new Date(Y, M - 1, D));
const thisYear = { from: `${Y}-01-01`, to: today };
const lastYear = { from: `${Y - 1}-01-01`, to: `${Y - 1}-12-31` };
const c = (d: string) => d.replaceAll('-', '');

beforeAll(async () => {
  if (!bins) return;
  fake = startFakeSchwab();
  hub = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req, server) {
      return server.upgrade(req) ? undefined : new Response('no', { status: 400 });
    },
    websocket: {
      open(ws) {
        sock = ws;
      },
      message(_ws, m) {
        const e = JSON.parse(String(m));
        if (e.t === 'reply') replies.set(e.id, e);
        else events.push(e);
      },
    },
  });
  dir = mkdtempSync(join(tmpdir(), 'dacc-schwab-'));
  proc = Bun.spawn(['bun', join(import.meta.dir, '../src/main.ts')], {
    env: {
      ...process.env,
      DITHER_HUB_URL: `ws://127.0.0.1:${hub.port}/extractor`,
      DITHER_ACCOUNT_ID: 'acc_schwabtest',
      DITHER_ADAPTER_TOKEN: 'token',
      DITHER_ACCOUNT_DIR: dir,
      DITHER_ACCOUNT_CONFIG: JSON.stringify({ testOrigin: fake.origin, testFrameOrigin: fake.frameOrigin, paceScale: 0.05, schedule: false }),
      DITHER_ACCOUNT_LABEL: 'Schwab test',
    },
    stdout: process.env.KEEP ? Bun.file(join(dir, 'stdout.log')) : 'ignore',
    stderr: process.env.KEEP ? Bun.file(join(dir, 'stderr.log')) : 'ignore',
  });
}, 30_000);

afterAll(async () => {
  if (!bins) return;
  try {
    sock?.send(JSON.stringify({ t: 'shutdown' }));
  } catch {}
  const exited = proc ? await Promise.race([proc.exited, Bun.sleep(8000).then(() => null)]) : 0;
  if (exited === null) proc?.kill('SIGKILL');
  hub?.stop(true);
  fake?.stop();
  if (process.env.KEEP) writeFileSync(join(dir, 'events.json'), JSON.stringify(events.filter((e) => e.t === 'log'), null, 0));
  if (!process.env.KEEP) rmSync(dir, { recursive: true, force: true });
}, 30_000);

it(
  'asks for a sign-in, shows the code page as needing you, pulls every export after it, then enrolls a passkey in a frame and signs itself in with it',
  async () => {
    await until(() => events.some((e) => e.t === 'hello'), 20_000, 'hello');
    expect(events.find((e) => e.t === 'hello')).toMatchObject({ kind: 'schwab', interfaces: ['statements'], capabilities: ['liveView'] });

    // Signed out, never pulled: the sign-in attention (step 1 of 3).
    await until(() => lastStatus()?.attention?.kind === 'login', 60_000, 'the sign-in attention');
    expect(lastStatus().attention).toEqual({ kind: 'login', message: SIGN_IN_MESSAGE, liveView: true });

    // The password; Schwab asks for a code: the account says so, and waits.
    fake.push('password');
    await until(() => lastStatus()?.attention?.kind === 'verify', 30_000, 'the code attention');
    expect(lastStatus().details.challenge).toBe(true);
    await Bun.sleep(1500);
    expect(fake.log).toEqual(['password']);
    expect(pulls()).toHaveLength(0);

    // You answer it; the pull follows by itself: last year and this year for each account, then realized.
    fake.push('code');
    await until(() => pulls().length === 1, 120_000, 'the pull after the sign-in');
    expect(pulls()[0]).toMatchObject({ ok: true, saved: 6 });
    expect(fake.exports.map((e) => `${e.layout} ${e.mask} ${e.from}..${e.to} ${e.ok}`)).toEqual([
      `brokerage 111 ${thisYear.from}..${thisYear.to} true`,
      `brokerage 111 ${lastYear.from}..${lastYear.to} true`,
      `bank 222 ${thisYear.from}..${thisYear.to} true`,
      `bank 222 ${lastYear.from}..${lastYear.to} true`,
      `realized 111 ${thisYear.from}..${thisYear.to} true`,
      `realized 111 ${lastYear.from}..${lastYear.to} true`,
    ]);
    const got = files();
    expect(got.map((f) => f.name.replace(/-\d{8}T\d{6}Z/, '-STAMP'))).toEqual([
      `schwab-brokerage-111-${c(thisYear.from)}-${c(thisYear.to)}-STAMP.csv`,
      `schwab-brokerage-111-${c(lastYear.from)}-${c(lastYear.to)}-STAMP.csv`,
      `schwab-bank-222-${c(thisYear.from)}-${c(thisYear.to)}-STAMP.csv`,
      `schwab-bank-222-${c(lastYear.from)}-${c(lastYear.to)}-STAMP.csv`,
      `schwab-realized-111-${c(thisYear.from)}-${c(thisYear.to)}-STAMP.csv`,
      `schwab-realized-111-${c(lastYear.from)}-${c(lastYear.to)}-STAMP.csv`,
    ]);
    expect(new Set(got.map((f) => f.dir))).toEqual(new Set(['schwab']));
    const f0 = await call('statements.fetch', { id: got[0].id });
    expect(Buffer.from(f0.result.base64, 'base64').toString('utf8')).toBe(exportCsv('brokerage', thisYear.from, thisYear.to));
    const f2 = await call('statements.fetch', { id: got[2].id });
    expect(Buffer.from(f2.result.base64, 'base64').toString('utf8')).toBe(exportCsv('bank', thisYear.from, thisYear.to));
    expect((await call('statements.accounts')).result.accounts.map((a: any) => [a.id, a.kind])).toEqual([
      ['schwab-111', 'brokerage'],
      ['schwab-222', 'bank'],
    ]);
    // Signed in with no passkey yet: step 2 of 3.
    await until(() => lastStatus()?.attention?.kind === 'passkey', 10_000, 'the add-a-passkey attention');
    expect(lastStatus().attention).toEqual({ kind: 'passkey', message: ADD_PASSKEY_MESSAGE, liveView: true });
    expect(lastStatus().layers.map((l: any) => `${l.name}:${l.state}`)).toEqual(['display:ok', 'browser:ok', 'extension:ok', 'signed in:ok', 'passkey:waiting', 'passkey sign-in:waiting', 'pull:ok']);
    expect(lastStatus().details.backfilled).toEqual(['history:111', 'history:222', 'realized:111']);
    // Downloads is empty again: every file went to the spool.
    expect(readdirSync(join(dir, 'downloads'))).toEqual([]);

    // A file you save yourself in the live view (an export, a page printed to PDF) goes over by itself.
    writeFileSync(join(dir, 'downloads', 'Checking_XXX222_Transactions_20261110-111111.csv'), exportCsv('bank', '2025-06-01', '2025-06-30'));
    writeFileSync(join(dir, 'downloads', 'History.pdf'), '%PDF-1.7\nnot really\n');
    writeFileSync(join(dir, 'downloads', 'notes.txt'), 'hello');
    await until(() => files().length === 8, 20_000, 'the hand-saved files');
    expect(files().slice(6).map((f) => f.name.replace(/-\d{8}T\d{6}Z/, '-STAMP'))).toEqual(expect.arrayContaining(['schwab-bank-222-STAMP.csv', 'schwab-print-STAMP.pdf']));
    await Bun.sleep(1000);
    expect(readdirSync(join(dir, 'downloads'))).toEqual(['notes.txt']);
    expect(lastStatus().details.downloadsIgnored).toBe(1);

    // You open Schwab's passkey settings (a frame from the widget's origin) and add one: the extractor makes it.
    fake.push('security', 'register');
    await until(() => fake.log.includes('passkey-registered'), 30_000, 'the passkey registered');
    await until(() => lastStatus()?.attention?.kind === 'passkey_check', 10_000, 'the check attention');
    expect(lastStatus().attention).toEqual({ kind: 'passkey_check', message: CHECK_MESSAGE, liveView: true });
    expect([...fake.rp.creds.values()].map((c) => [c.alg, c.counter])).toEqual([[-7, 0]]);
    expect(lastStatus().details).toMatchObject({ passkeyEnrolled: true, passkeys: 1, passkeyAlgorithm: 'ES256', passkeyRpId: 'localhost', passkeysMadeThisRun: 1, refusedThisRun: 0 });
    const enrolled = JSON.parse(readFileSync(join(dir, 'secret.json'), 'utf8'));
    expect(enrolled.passkeys).toHaveLength(1);
    expect(statSync(join(dir, 'secret.json')).mode & 0o777).toBe(0o600);

    // Step 3: log out, then log in with the passkey (you click it in the widget's frame).
    fake.push('logout');
    await until(() => lastStatus()?.attention?.message === CHECK_SIGNED_OUT_MESSAGE, 30_000, 'signed out, the check attention');
    fake.push('passkey');
    await until(() => lastStatus()?.status === 'online', 60_000, 'online after the passkey sign-in');
    expect([...fake.rp.creds.values()].map((c) => c.counter)).toEqual([1]);
    expect(lastStatus().layers.map((l: any) => `${l.name}:${l.state}`)).toEqual(['display:ok', 'browser:ok', 'extension:ok', 'signed in:ok', 'passkey:ok', 'passkey sign-in:ok', 'pull:ok']);
    expect(lastStatus().details.autoSignIn).toBe('ready');

    // The session ends behind the app's page: a pull finds History signed out, signs itself in with the passkey
    // (clicking the widget's button: the first click may land before it is hydrated) and pulls.
    fake.expire();
    fake.hydrateMs = 300;
    const n = fake.exports.length;
    expect((await call('statements.refresh')).result).toEqual({ started: true });
    await until(() => pulls().length === 2, 120_000, 'the pull that signs itself in');
    expect(pulls()[1]).toMatchObject({ ok: true });
    expect(fake.exports.length).toBeGreaterThan(n);
    expect(fake.exports.slice(n).every((e) => e.ok)).toBe(true);
    expect([...fake.rp.creds.values()].map((c) => c.counter)).toEqual([2]);
    expect(fake.log.filter((l) => l === 'passkey-signin')).toHaveLength(2);
    await until(() => lastStatus()?.status === 'online', 10_000, 'online after signing itself in');
    expect(lastStatus().details.autoSignInsThisRun).toBeGreaterThanOrEqual(1);
    expect(lastStatus().details.lastAutoSignIn).toBeString();

    // Schwab logs the idle session out and leaves the tab on a sign-in page whose passkey option asks for nothing: a pull
    // loads a fresh sign-in page instead of clicking that one, and signs in there.
    fake.push('idle');
    await until(() => fake.log.includes('idle-logout') && lastStatus()?.details?.pageKind === 'signin', 30_000, 'logged out for inactivity');
    expect((await call('statements.refresh')).result).toEqual({ started: true });
    await until(() => pulls().length === 3, 120_000, 'the pull after the idle logout');
    expect(pulls()[2]).toMatchObject({ ok: true });
    expect([...fake.rp.creds.values()].map((c) => c.counter)).toEqual([3]);
    expect(fake.log.filter((l) => l === 'passkey-signin')).toHaveLength(3);

    // Schwab asks for a code after the passkey: the account holds, types nothing, and refuses pulls until you are in.
    fake.expire();
    fake.codeAfterPasskey = true;
    const logged = fake.log.length;
    expect((await call('statements.refresh')).result).toEqual({ started: true });
    await until(() => pulls().length === 4, 120_000, 'the held pull');
    expect(pulls()[3]).toMatchObject({ ok: false, needs: CHALLENGE_MESSAGE });
    expect(fake.log.slice(logged)).toEqual(['passkey-signin']);
    expect([...fake.rp.creds.values()].map((c) => c.counter)).toEqual([4]);
    await until(() => String(lastStatus()?.details?.autoSignIn).startsWith('held (code)'), 10_000, 'held');
    expect(['verify', 'login']).toContain(lastStatus().attention?.kind);
    expect(lastStatus().attention.message).toBe(CHALLENGE_MESSAGE);
    expect((await call('statements.refresh')).result).toMatchObject({ started: false });
    await Bun.sleep(1500);
    expect(fake.log.slice(logged)).toEqual(['passkey-signin']);
    // You enter the code: signed in, the hold lifts.
    fake.codeAfterPasskey = false;
    fake.push('code');
    await until(() => lastStatus()?.details?.autoSignIn === 'ready', 60_000, 'the hold lifted');
    await until(() => lastStatus()?.status === 'online', 30_000, 'online again');
    // The pull that was held goes once you are in.
    await until(() => pulls().length === 5, 120_000, 'the pull after the hold');
    expect(pulls()[4]).toMatchObject({ ok: true });

    // Nothing secret went to the manager: no key, no full credential id, no user handle.
    const secret = JSON.parse(readFileSync(join(dir, 'secret.json'), 'utf8')).passkeys[0];
    expect(secret.signCount).toBe(4);
    const wire = JSON.stringify(events);
    for (const x of [secret.privateKey, secret.id, secret.userHandle]) expect(wire).not.toContain(x);
    expect(existsSync(join(dir, 'profile', 'Default', 'Preferences'))).toBe(true);
  },
  600_000,
);
