import { expect, test } from 'bun:test';
import { type PasskeySummary, refusalMessage } from '@dither-accounts/passkey';
import {
  ADD_PASSKEY_MESSAGE,
  type AutoSignIn,
  autoFailedMessage,
  CAPTCHA_MESSAGE,
  CHECK_MESSAGE,
  CHECK_SIGNED_OUT_MESSAGE,
  CODE_MESSAGE,
  challengeOf,
  details,
  layers,
  type PageState,
  pageKind,
  SIGN_IN_MESSAGE,
  SIGNED_OUT_MESSAGE,
  SIGNS_ITSELF_IN,
  state,
  statementsBlocked,
  stepMessage,
  type View,
} from '../src/status.ts';

const APP = 'https://app.privacy.com';
const none: PasskeySummary = { enrolled: false, count: 0, newest: null };
const added: PasskeySummary = { enrolled: true, count: 1, newest: { idPrefix: 'AbCdEfGh', rpId: 'privacy.com', algorithm: 'ES256', createdAt: Date.UTC(2026, 10, 9, 12), lastUsedAt: null, verifiedAt: null } };
const checked: PasskeySummary = { ...added, newest: { ...added.newest!, lastUsedAt: Date.UTC(2026, 10, 9, 13), verifiedAt: Date.UTC(2026, 10, 9, 13) } };

const v = (o: Partial<View>): View => ({
  sandboxError: null,
  display: 81,
  liveView: true,
  browserAlive: true,
  attached: true,
  attachOverdue: false,
  page: `${APP}/login`,
  kind: 'signin',
  signedIn: false,
  passkey: none,
  lastRefusal: null,
  ...o,
});
const signedIn = { page: `${APP}/home`, kind: 'app' as const, signedIn: true };
const names = (x: View) => layers(x).map((l) => `${l.name}:${l.state}`);

test('pageKind: sign-in pages, the app, the rest of privacy.com, elsewhere', () => {
  expect(pageKind(`${APP}/login`, APP)).toBe('signin');
  expect(pageKind(`${APP}/Login/`, APP)).toBe('signin');
  expect(pageKind(`${APP}/signin`, APP)).toBe('signin');
  expect(pageKind(`${APP}/home`, APP)).toBe('app');
  expect(pageKind(`${APP}/`, APP)).toBe('app');
  expect(pageKind(`${APP}/login-history`, APP)).toBe('app');
  expect(pageKind('https://privacy.com/', APP)).toBe('site');
  expect(pageKind('https://www.privacy.com/login', APP)).toBe('signin');
  expect(pageKind('https://notprivacy.com/', APP)).toBe('other');
  expect(pageKind('chrome://newtab', APP)).toBe('other');
  expect(pageKind(null, APP)).toBe('none');
  expect(pageKind('http://localhost:4000/login', 'http://localhost:4000')).toBe('signin');
});

test('step 1: sign in', () => {
  const x = v({});
  expect(state(x)).toEqual({ status: 'attention', attention: { kind: 'login', message: SIGN_IN_MESSAGE, liveView: true } });
  expect(names(x)).toEqual(['display:ok', 'browser:ok', 'extension:ok', 'signed in:waiting', 'passkey:waiting', 'passkey sign-in:waiting']);
  // privacy.com's marketing site counts as not signed in too.
  expect(state(v({ page: 'https://privacy.com/', kind: 'site' })).attention?.kind).toBe('login');
});

test('step 2: signed in, add a passkey', () => {
  const x = v(signedIn);
  expect(state(x)).toEqual({ status: 'attention', attention: { kind: 'passkey', message: ADD_PASSKEY_MESSAGE, liveView: true } });
  expect(ADD_PASSKEY_MESSAGE).toContain('Security');
  expect(names(x)).toEqual(['display:ok', 'browser:ok', 'extension:ok', 'signed in:ok', 'passkey:waiting', 'passkey sign-in:waiting']);
});

test('step 3: passkey added, sign in with it', () => {
  expect(state(v({ ...signedIn, passkey: added })).attention).toEqual({ kind: 'passkey_check', message: CHECK_MESSAGE, liveView: true });
  expect(state(v({ passkey: added })).attention).toEqual({ kind: 'passkey_check', message: CHECK_SIGNED_OUT_MESSAGE, liveView: true });
  const l = layers(v({ passkey: added }));
  expect(l[4]).toEqual({ name: 'passkey', state: 'ok', note: 'ES256 passkey AbCdEfGh… for privacy.com, added 2026-11-09' });
  expect(l[5]!.state).toBe('waiting');
});

test('done: signed in with the passkey, everything ok, nothing asked', () => {
  const x = v({ ...signedIn, passkey: checked });
  expect(state(x)).toEqual({ status: 'online', attention: null });
  expect(layers(x).every((l) => l.state === 'ok')).toBe(true);
  // Signed out later, with nothing that signs in by itself: sign in with the passkey again.
  expect(state(v({ passkey: checked })).attention).toEqual({ kind: 'login', message: SIGNED_OUT_MESSAGE, liveView: true });
});

test('the app still settling, or no page yet: no attention', () => {
  expect(state(v({ page: `${APP}/home`, kind: 'app' }))).toEqual({ status: 'connecting', attention: null });
  expect(state(v({ page: null, kind: 'none' }))).toEqual({ status: 'connecting', attention: null });
});

test('the sandbox: failing, starting, extension late', () => {
  expect(state(v({ sandboxError: 'no free X display', liveView: false })).status).toBe('error');
  expect(layers(v({ sandboxError: 'no free X display', liveView: false }))[0]!.state).toBe('failed');
  expect(state(v({ liveView: false }))).toEqual({ status: 'connecting', attention: null });
  expect(state(v({ attached: false }))).toEqual({ status: 'connecting', attention: null });
  const late = v({ attached: false, attachOverdue: true });
  expect(state(late).attention?.liveView).toBe(true);
  expect(layers(late)[2]!.state).toBe('failed');
});

test('details: facts only, no secrets', () => {
  const d = details(v({ ...signedIn, passkey: checked, lastRefusal: 'get: this authenticator only answers for privacy.com' }), { creations: 1, assertions: 2, refusals: 1 });
  expect(d).toMatchObject({ passkeyEnrolled: true, passkeys: 1, credentialIdPrefix: 'AbCdEfGh…', passkeyAlgorithm: 'ES256', passkeyCreated: '2026-11-09', signInsThisRun: 2, signedIn: true });
  expect(Object.keys(d).some((k) => /key$|secret|handle|count$/i.test(k) && k !== 'passkeys')).toBe(false);
});

test('signing itself in: signed out is online once the passkey is checked; a hold or failures ask for you', () => {
  const ready: AutoSignIn = { signingIn: false, hold: null, failed: null, lastOkAt: null };
  // Signed out (Privacy's short session) with a checked passkey: online, the passkey signs in before each pull.
  const out = v({ passkey: checked, auto: ready });
  expect(state(out)).toEqual({ status: 'online', attention: null });
  expect(layers(out)[3]).toEqual({ name: 'signed in', state: 'ok', note: SIGNS_ITSELF_IN });
  expect(layers(v({ passkey: checked, auto: { ...ready, signingIn: true } }))[3]).toEqual({ name: 'signed in', state: 'waiting', note: 'signing in with the passkey' });
  // Before the passkey is checked, nothing signs in by itself: the steps as before.
  expect(state(v({ passkey: added, auto: ready })).attention?.kind).toBe('passkey_check');
  expect(state(v({ auto: ready })).attention?.kind).toBe('login');
  // Privacy asked for a code: held, with its message.
  const held = v({ page: `${APP}/login/tfa`, passkey: checked, auto: { ...ready, hold: { what: 'code', message: CODE_MESSAGE, since: Date.UTC(2026, 10, 9, 14) } } });
  expect(state(held)).toEqual({ status: 'attention', attention: { kind: 'login', message: CODE_MESSAGE, liveView: true } });
  expect(layers(held)[3]).toMatchObject({ name: 'signed in', state: 'failed' });
  expect(details(held, { creations: 0, assertions: 1, refusals: 0 }).autoSignIn).toBe('held (code) since 2026-11-09 14:00 UTC');
  // Three failed tries.
  const failed = v({ passkey: checked, auto: { ...ready, failed: 'Privacy did not ask for the passkey' } });
  expect(state(failed).attention).toEqual({ kind: 'login', message: autoFailedMessage('Privacy did not ask for the passkey'), liveView: true });
  // Signed in again: online, whatever happened before.
  expect(state(v({ ...signedIn, passkey: checked, auto: { ...ready, failed: 'x' } }))).toEqual({ status: 'online', attention: null });
});

test('a paired phone that refused is the attention approval, saying what asks again', () => {
  const ready: AutoSignIn = { signingIn: false, hold: null, failed: null, lastOkAt: null };
  const denied = { reason: 'denied' as const, device: 'Pixel A', at: Date.UTC(2026, 10, 11, 6) };
  const out = v({ passkey: checked, auto: { ...ready, approval: denied } });
  expect(state(out)).toEqual({ status: 'attention', attention: { kind: 'approval', message: refusalMessage('Privacy', denied), liveView: true } });
  expect(state(out).attention!.message).toContain('denied on Pixel A');
  expect(layers(out)[3]).toEqual({ name: 'signed in', state: 'failed', note: 'the passkey sign-in stopped: denied on Pixel A; waits for a pull you start' });
  expect(details(out, { creations: 0, assertions: 0, refusals: 1 }).autoSignIn).toBe('stopped: denied on Pixel A at 2026-11-11 06:00 UTC');
  const late = v({ passkey: checked, auto: { ...ready, approval: { ...denied, reason: 'no-device' } } });
  expect(state(late).attention!.message).toContain('not paired here');
  // Signed in: online.
  expect(state(v({ ...signedIn, passkey: checked, auto: { ...ready, approval: denied } }))).toEqual({ status: 'online', attention: null });
});

test('what Privacy asks for on a sign-in page: a code, a captcha, another step; the plain form is not a question', () => {
  const login: PageState = { path: '/login', passkeyButton: true, passwordInput: true, codeInput: false, captcha: false };
  expect(challengeOf(login, false)).toBeNull();
  expect(challengeOf(login, true)).toBeNull();
  // A code field next to the form is only a question once the passkey has answered.
  expect(challengeOf({ ...login, codeInput: true }, false)).toBeNull();
  expect(challengeOf({ ...login, codeInput: true }, true)).toEqual({ what: 'code', message: CODE_MESSAGE });
  expect(challengeOf({ ...login, path: '/login/tfa' }, false)).toEqual({ what: 'code', message: CODE_MESSAGE });
  expect(challengeOf({ ...login, path: '/verify-device' }, true)?.what).toBe('code');
  expect(challengeOf({ ...login, path: '/login/password' }, true)).toEqual({ what: 'step', message: stepMessage('/login/password') });
  expect(challengeOf({ ...login, captcha: true }, false)).toEqual({ what: 'captcha', message: CAPTCHA_MESSAGE });
});

test('what blocks a pull: no browser, no passkey, an unchecked one, a hold; signed out does not', () => {
  const b = (o: Partial<Parameters<typeof statementsBlocked>[0]>) => statementsBlocked({ attached: true, passkey: checked, hold: null, ...o });
  expect(b({})).toBeNull();
  expect(b({ attached: false })).toMatch(/not up yet/);
  expect(b({ passkey: none })).toMatch(/no passkey yet/);
  expect(b({ passkey: added })).toMatch(/not checked yet/);
  expect(b({ hold: { what: 'code', message: CODE_MESSAGE, since: 1 } })).toBe(`Privacy is waiting for you in the live view: ${CODE_MESSAGE}`);
});
