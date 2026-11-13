/**
 * What a refusal from a paired phone does to signing in by itself (docs/approver.md, "What a refusal does";
 * packages/passkey signin.ts), without a browser, so CI runs it. The pieces are the real ones: the authenticator with a
 * remote credential, the fake phone (fake-device.ts, asked directly as the manager would ask it, with the name the
 * manager adds), the fake relying party, PasskeySignIn and the StatementsRunner with its daily slot. The site and the
 * kind's try are stand-ins: one try clicks the passkey option (again, up to three clicks, while nothing came back, as
 * privacy's and schwab's do), the page's get goes through the authenticator as the extension sends it, and the kind
 * hands a refusal to PasskeySignIn.note. Time is fake: the runner's timers (jest's fake timers, with the runner's own
 * clock) and the sign-in's backoff (a sleep that only records). The browser tests (extractors/{privacy,schwab}/test)
 * run the kinds' own loops where Chromium is.
 */
import { afterEach, beforeEach, expect, jest, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Link } from '@dither-accounts/link';
import { type Approver, answerOf, ApproverRefusal, Authenticator, PasskeySignIn, refusalMessage, respond, type StandingRefusal, type StoredCredential, type Trigger, type Try, WebAuthnError } from '../packages/passkey/src/index.ts';
import { FakeDevice } from '../packages/passkey/test/fake-device.ts';
import { FakeRp } from '../packages/passkey/test/fake-rp.ts';
import { NeedsYou, StatementsRunner, type Why } from '../extractors/statements-common/src/runner.ts';

const ORIGIN = 'https://app.privacy.com';
const HOUR = 3600_000;
const userId = Buffer.from('user-signin').toString('base64url');

/** The kind, with the account's state: the parts privacy's and schwab's main.ts wire together. */
async function setup(o: { local?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dacc-signin-'));
  // 05:00 local, so the 06:00 slot is an hour away.
  let clock = new Date(2026, 10, 11, 5, 0, 0).getTime();
  const now = () => clock;
  const phone = await FakeDevice.make('Pixel A');
  phone.deviceId = 'dev_testphone0000001';
  phone.manager = 'test';
  let n = 0;
  // The manager's side, in short: the request as it sends it, `ignore` waits out its 3 minutes (expired), and a
  // refusal names the device.
  const approver: Approver = {
    createDevice: async () => (o.local ? null : { id: phone.deviceId!, name: phone.deviceId! }),
    request: async (ask) => {
      const r = { t: 'request', id: `apr_${String(++n).padStart(16, '0')}`, ...ask, account: { id: 'acc_signin', label: 'Privacy', kind: 'privacy' }, expiresAt: Date.now() + 180_000 };
      const a = (await phone.answer(r)) ?? { ok: false, reason: 'expired' };
      return answerOf(a.ok ? a : { ...a, deviceName: phone.name }, ask.op);
    },
  };
  let creds: StoredCredential[] = [];
  const auth = new Authenticator({ load: () => creds, save: (c) => void (creds = c) }, ['privacy.com'], now, 'top', undefined, approver);
  const rp = new FakeRp('privacy.com', ORIGIN);
  // Enrolled and checked (on the phone, or here for a local passkey).
  const ch = rp.challenge();
  const made = await auth.create(ORIGIN, { rp: { id: 'privacy.com', name: 'Privacy' }, user: { id: userId, name: 'me', displayName: 'Me' }, challenge: ch, pubKeyCredParams: [{ type: 'public-key', alg: -7 }] });
  rp.register(ch, made, userId);
  phone.requests.length = 0;

  // state.json's approval.
  let saved: StandingRefusal | null = null;
  const logs: string[] = [];
  const waits: number[] = [];
  const opts = {
    site: 'Privacy',
    backoff: [0, 20_000, 60_000],
    sleep: async (ms: number) => {
      waits.push(ms);
      clock += ms;
    },
    now,
    load: () => saved,
    save: (r: StandingRefusal | null) => void (saved = r),
    log: (_l: string, m: string) => void logs.push(m),
    needsYou: (message: string, kind: string) => new NeedsYou(message, kind),
  };
  const signin = new PasskeySignIn(opts);
  // The phone's line says what asks (as both kinds set it).
  auth.reasonFor = (op) => (op === 'create' ? 'Add a passkey' : signin.reason());

  // The site: signed in or not; `broken`: it takes the passkey but never finishes signing in (a local failure).
  const site = { signedIn: false, broken: false };
  let assertions = 0;
  /** One try, as the kinds make it (privacy's and schwab's signInOnce, without the page). */
  const once = async (): Promise<Try<never>> => {
    for (let click = 0; click < 3; click++) {
      if (signin.stopped) return { ok: false, reason: 'the approver refused' };
      const c = rp.challenge();
      const r = await respond(auth, { t: 'webauthn', sid: 's', op: 'get', options: { rpId: 'privacy.com', challenge: c, allowCredentials: [{ type: 'public-key', id: made.id }] }, origin: ORIGIN, page: `${ORIGIN}/login`, top: true });
      // The page gets the plain NotAllowedError either way; the kind hands the refusal on (its onWebauthn).
      if (r.refused) {
        expect(r.answer).toEqual({ ok: false, error: r.refused.message, code: 'NotAllowedError' });
        signin.note(r.refused);
        continue; // nothing came: the kind clicks again after RECLICK_MS, unless the approver refused
      }
      if (!r.used) return { ok: false, reason: 'no passkey' };
      assertions++;
      rp.authenticate(c, r.used);
      if (site.broken) return { ok: false, reason: 'Privacy did not finish the sign-in after the passkey answered' };
      site.signedIn = true;
      return { ok: true };
    }
    return { ok: false, reason: 'Privacy did not ask for the passkey' };
  };
  const ensureSignedIn = (trigger: Trigger) =>
    site.signedIn
      ? Promise.resolve()
      : signin.run(trigger, once, { done: () => site.signedIn, hold: () => new NeedsYou('held'), failed: (last) => `Signing in did not work (${last})` });

  const events: any[] = [];
  const link = { accountId: 'acc_signin', accountDir: dir, config: { pullAt: '06:00', jitterMinutes: 0 }, label: 'Test', emit: (e: unknown) => events.push(e), log: () => {}, secret: () => ({}), saveSecret: () => {}, connected: true, close: () => {} } as unknown as Link;
  const runner = new StatementsRunner({
    link,
    // The pull signs in first (both kinds), then hands a file over.
    pull: async (_o, why: Why) => {
      await ensureSignedIn(why);
      return { saved: 1 };
    },
    accounts: () => [],
    now,
  });
  const pulled = () => events.filter((e) => e.t === 'statements.pulled');
  /** Moves the clock and the runner's timers together, and lets a pull that starts finish. */
  const advance = async (ms: number) => {
    for (let left = ms; left > 0; ) {
      const step = Math.min(left, 10 * 60_000);
      clock += step;
      left -= step;
      const before = pulled().length;
      jest.advanceTimersByTime(step);
      if (runner.pulling) await until(() => pulled().length > before);
    }
  };
  /** A pull started now (statements.refresh with its why: a manual one, or schwab's after you sign in). */
  const pull = async (why: Why) => {
    const before = pulled().length;
    expect(runner.refresh({}, why)).toEqual({ started: true });
    await until(() => pulled().length > before);
    return pulled().at(-1);
  };
  return { dir, phone, auth, rp, signin, opts, site, runner, pulled, advance, pull, waits, logs, saved: () => saved, assertions: () => assertions, expire: () => void (site.signedIn = false), now };
}

/** Waits on promises only (WebCrypto), never on the clock. */
async function until(f: () => boolean) {
  for (let i = 0; i < 2000 && !f(); i++) await new Promise<void>((r) => queueMicrotask(r)).then(() => crypto.subtle.digest('SHA-256', new Uint8Array(1)));
  if (!f()) throw new Error('never happened');
}

let dirs: string[] = [];
beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

test('denied: the phone is asked once; nothing automatic asks again until a pull you start, which asks once more', async () => {
  const k = await setup();
  dirs.push(k.dir);
  k.phone.decide = () => 'deny';
  k.runner.start();
  expect(k.runner.nextAt).toBe(new Date(2026, 10, 11, 6, 0, 0).getTime());

  // The daily pull at 06:00: one request, denied; no second try, no second click.
  await k.advance(HOUR);
  expect(k.phone.requests).toHaveLength(1);
  expect(k.phone.requests[0]).toMatchObject({ op: 'get', reason: 'Sign in for the daily statements pull' });
  expect(k.waits).toEqual([]);
  const denied = refusalMessage('Privacy', { reason: 'denied', device: 'Pixel A', at: 0 });
  expect(denied).toContain('denied on Pixel A');
  expect(k.pulled()).toEqual([{ t: 'statements.pulled', ok: false, saved: 0, needs: denied }]);
  expect(k.runner.st.needs).toEqual({ kind: 'approval', message: denied });
  expect(k.saved()).toMatchObject({ reason: 'denied', device: 'Pixel A' });
  expect(k.signin.attention()).toEqual({ kind: 'approval', message: denied });

  // The runner's retry window (hourly, three times) passes: nothing, and the next pull is tomorrow's.
  await k.advance(4 * HOUR);
  expect(k.pulled()).toHaveLength(1);
  expect(k.runner.nextAt).toBe(new Date(2026, 10, 12, 6, 0, 0).getTime());
  // Schwab's pull after a sign-in (its 10-minute tick), and a start: nothing asked.
  expect((await k.pull('sign-in')).needs).toBe(denied);
  expect(k.signin.blocked('start')).toBe(denied);
  // A restart keeps it (state.json).
  expect(new PasskeySignIn(k.opts).blocked('daily')).toBe(denied);
  // Tomorrow's daily pull: nothing asked either.
  await k.advance(24 * HOUR);
  expect(k.pulled()).toHaveLength(3);
  expect(k.pulled().at(-1).needs).toBe(denied);
  expect(k.phone.requests).toHaveLength(1);

  // A pull you start asks once more. Denied again: one request, still stopped.
  expect((await k.pull('refresh')).needs).toBe(denied);
  expect(k.phone.requests).toHaveLength(2);
  expect(k.phone.requests[1].reason).toBe('Sign in for the statements pull you started');
  // Approved this time: signed in, the refusal is over, the daily pull may ask again.
  k.phone.decide = () => 'approve';
  expect(await k.pull('refresh')).toMatchObject({ ok: true, saved: 1 });
  expect(k.phone.requests).toHaveLength(3);
  expect(k.saved()).toBeNull();
  expect(k.signin.attention()).toBeNull();
  expect(k.signin.blocked('daily')).toBeNull();
  expect(k.waits).toEqual([]);
});

test('signed in by hand clears a denial', async () => {
  const k = await setup();
  dirs.push(k.dir);
  k.phone.decide = () => 'deny';
  expect((await k.pull('daily')).ok).toBe(false);
  expect(k.signin.blocked('daily')).not.toBeNull();
  // The kind sees the account signed in (you, in the live view): automatic sign-ins may ask again.
  k.signin.signedIn();
  expect(k.saved()).toBeNull();
  expect(k.signin.blocked('daily')).toBeNull();
  expect(k.phone.requests).toHaveLength(1);
});

test('not answered in time: one prompt per scheduled pull, and nothing in between', async () => {
  const k = await setup();
  dirs.push(k.dir);
  k.phone.decide = () => 'ignore';
  k.runner.start();
  await k.advance(HOUR);
  expect(k.phone.requests).toHaveLength(1);
  const expired = refusalMessage('Privacy', { reason: 'expired', device: 'Pixel A', at: 0 });
  expect(expired).toContain('not answered in time');
  expect(k.pulled().at(-1)).toMatchObject({ ok: false, needs: expired });
  expect(k.waits).toEqual([]);
  // Within the day: no retries, no tick, no start.
  await k.advance(6 * HOUR);
  expect((await k.pull('sign-in')).needs).toBe(expired);
  expect(k.signin.blocked('start')).toBe(expired);
  expect(k.signin.blocked('retry')).toBe(expired);
  expect(k.phone.requests).toHaveLength(1);
  // The next day's slot asks once more, and only once; so does a catch-up after a restart.
  await k.advance(18 * HOUR);
  expect(k.phone.requests).toHaveLength(2);
  expect(k.pulled().filter((p) => p.ok === false)).toHaveLength(3);
  expect(k.signin.blocked('catch-up')).toBeNull();
  // Answered: signed in, and the standing refusal is gone.
  k.phone.decide = () => 'approve';
  await k.advance(24 * HOUR);
  expect(k.phone.requests).toHaveLength(3);
  expect(k.pulled().at(-1)).toMatchObject({ ok: true });
  expect(k.saved()).toBeNull();
});

test('refused and unknown-credential wait for you like denied; no-device and error wait for the next scheduled pull', async () => {
  const k = await setup();
  dirs.push(k.dir);
  const cases: [string, Record<Trigger, boolean>][] = [
    ['refused', { start: false, daily: false, 'catch-up': false, retry: false, 'sign-in': false, refresh: true }],
    ['unknown-credential', { start: false, daily: false, 'catch-up': false, retry: false, 'sign-in': false, refresh: true }],
    ['no-device', { start: false, daily: true, 'catch-up': true, retry: false, 'sign-in': false, refresh: true }],
    ['error', { start: false, daily: true, 'catch-up': true, retry: false, 'sign-in': false, refresh: true }],
  ];
  for (const [reason, may] of cases) {
    k.expire();
    k.phone.decide = () => ({ reason, message: 'a check failed' });
    const before = k.phone.requests.length;
    const p = await k.pull('refresh');
    expect(k.phone.requests.length - before).toBe(1);
    expect(p.ok).toBe(false);
    expect(k.saved()).toMatchObject({ reason, device: 'Pixel A' });
    expect(k.runner.st.needs?.kind).toBe('approval');
    for (const [t, ok] of Object.entries(may)) expect([reason, t, k.signin.blocked(t as Trigger) === null]).toEqual([reason, t, ok]);
  }
  expect(k.waits).toEqual([]);
});

test('a refusal outside a sign-in (you, in the live view) stops nothing; a local refusal is not the approver’s', async () => {
  const k = await setup();
  dirs.push(k.dir);
  expect(k.signin.note(new ApproverRefusal('denied', 'Pixel A'))).toBe(false);
  expect(k.signin.blocked('daily')).toBeNull();
  const local = new WebAuthnError('NotAllowedError', 'passkeys are answered in the top frame only');
  expect(local instanceof ApproverRefusal).toBe(false);
});

test('a passkey kept here still gets its three tries with backoff, and nothing stands after', async () => {
  const k = await setup({ local: true });
  dirs.push(k.dir);
  k.site.broken = true;
  const p = await k.pull('daily');
  expect(p).toMatchObject({ ok: false, needs: 'Signing in did not work (Privacy did not finish the sign-in after the passkey answered)' });
  expect(k.runner.st.needs?.kind).toBe('login');
  expect(k.assertions()).toBe(3);
  expect(k.signin.tries).toBe(3);
  expect(k.waits).toEqual([20_000, 60_000]);
  expect(k.phone.requests).toHaveLength(0);
  expect(k.saved()).toBeNull();
  expect(k.signin.blocked('start')).toBeNull();
  expect(k.signin.failed).toBe('Privacy did not finish the sign-in after the passkey answered');
  // Fixed: the next pull signs in at once.
  k.site.broken = false;
  expect(await k.pull('daily')).toMatchObject({ ok: true });
  expect(k.signin.failed).toBeNull();
});
