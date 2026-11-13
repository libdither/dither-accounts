/**
 * The schwab kind's pure half: what a page is, what a download is (Schwab's CSV and JSON exports, by their headers),
 * dither-finance's names for them (ledger/parsers/schwab_csv.py OUR_NAME), the ranges a pull asks for, and the status.
 */
import { expect, test } from 'bun:test';
import { refusalMessage } from '@dither-accounts/passkey';
import {
  shownRange,
  ADD_PASSKEY_MESSAGE,
  CAPTCHA_MESSAGE,
  CHALLENGE_MESSAGE,
  CHECK_MESSAGE,
  CHECK_SIGNED_OUT_MESSAGE,
  challengeOf,
  fileName,
  historyRanges,
  isPdf,
  keptTo,
  maskIn,
  pageKind,
  passkeyDetails,
  passkeyLayers,
  printName,
  realizedRanges,
  recognize,
  SIGN_IN_MESSAGE,
  signedInLayer,
  SIGNS_ITSELF_IN,
  state,
  us,
  type View,
} from '../src/schwab.ts';
import { exportCsv } from './fake-schwab.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const APP = 'https://client.schwab.com';

test('pages: client.schwab.com is the app unless it is a sign-in page; www and the gateway are signing in', () => {
  expect(pageKind(`${APP}/clientapps/accounts/summary/`, APP)).toBe('app');
  expect(pageKind(`${APP}/app/accounts/history/`, APP)).toBe('app');
  expect(pageKind(`${APP}/Areas/Access/Login`, APP)).toBe('signin');
  // Where the passkey is added: signed in, not a sign-in page (its 2-Step Verification section is no code prompt).
  expect(pageKind(`${APP}/retail/access/securitysettings/`, APP)).toBe('app');
  expect(pageKind(`${APP}/logout/`, APP)).toBe('signin');
  expect(pageKind('https://www.schwab.com/', APP)).toBe('signin');
  expect(pageKind('https://sws-gateway-nr.schwab.com/ui/host/', APP)).toBe('signin');
  expect(pageKind('https://international.schwab.com/', APP)).toBe('site');
  expect(pageKind('https://example.com/', APP)).toBe('other');
  expect(pageKind(null, APP)).toBe('none');
});

test('recognize: History (brokerage and bank) and Realized Gain/Loss by their headers, with rows and their days', () => {
  const b = recognize(enc(exportCsv('brokerage', '2026-01-01', '2026-03-31')), 'Brokerage_XXX111_Transactions_20261110-101010.csv');
  expect(b).toEqual({ layout: 'brokerage', ext: 'csv', mask: '111', rows: 6, span: ['2026-01-05', '2026-03-05'] });
  const k = recognize(enc('﻿' + exportCsv('bank', '2026-01-01', '2026-01-31')), 'Checking_XXX222_Transactions.csv');
  expect(k).toEqual({ layout: 'bank', ext: 'csv', mask: '222', rows: 2, span: ['2026-01-07', '2026-01-21'] });
  // The realized export names the account in its title when its file name does not.
  const r = recognize(enc(exportCsv('realized', '2025-01-01', '2026-12-31')), 'export.csv');
  expect(r).toEqual({ layout: 'realized', ext: 'csv', mask: '111', rows: 2, span: ['2025-03-02', '2026-03-02'] });
  // History's JSON export.
  const j = recognize(enc(JSON.stringify({ FromDate: '01/01/2026', BrokerageTransactions: [{ Date: '02/03/2026 as of 02/02/2026', Action: 'Buy' }] })), 'Individual_XXXX9111_Transactions.json');
  expect(j).toEqual({ layout: 'brokerage', ext: 'json', mask: '111', rows: 1, span: ['2026-02-03', '2026-02-03'] });
  // Anything else.
  expect(recognize(enc('a,b,c\n1,2,3\n'), 'x.csv')).toBeNull();
  expect(recognize(enc('Account Statement - (@x),,,\n'), 'venmo.csv')).toBeNull();
  expect(recognize(enc('%PDF-1.7\n'), 'x.pdf')).toBeNull();
  expect(isPdf(enc('%PDF-1.7\n'))).toBe(true);
});

test('masks: the last three digits, as schwab.com shows them', () => {
  expect(maskIn('Checking_XXX222_Transactions_20261107-101010.csv')).toBe('222');
  expect(maskIn('Individual_XXXX9111_GainLoss.csv')).toBe('111');
  expect(maskIn('Realized Gain/Loss - Lot Details for XXXX-9111 as of …')).toBe('111');
  expect(maskIn('Brokerage …111')).toBe('111');
  expect(maskIn('nothing here 20261107-101010')).toBeNull();
});

test("names: dither-finance's, with the range only when the rows kept to it", () => {
  const at = Date.UTC(2026, 10, 10, 5, 30, 0);
  expect(fileName('brokerage', '111', 'csv', at, { from: '2026-01-01', to: '2026-11-10' })).toBe('schwab-brokerage-111-20260101-20261110-20261110T053000Z.csv');
  expect(fileName('bank', '222', 'csv', at)).toBe('schwab-bank-222-20261110T053000Z.csv');
  expect(printName(at)).toBe('schwab-print-20261110T053000Z.pdf');
  expect(() => fileName('bank', '62', 'csv', at)).toThrow();
  const r = recognize(enc(exportCsv('bank', '2026-01-01', '2026-02-28')), 'x_XXX222_.csv')!;
  expect(keptTo(r, { from: '2026-01-01', to: '2026-02-28' })).toBe(true);
  expect(keptTo(r, { from: '2026-02-01', to: '2026-02-28' })).toBe(false);
  expect(us('2026-03-07')).toBe('03/07/2026');
});

test('ranges: the first of last month to today; a backfill by whole years, newest first', () => {
  const today = new Date(2026, 10, 10);
  expect(historyRanges(today, null)).toEqual([{ from: '2026-10-01', to: '2026-11-10' }]);
  expect(historyRanges(new Date(2026, 0, 15), null)).toEqual([{ from: '2025-12-01', to: '2026-01-15' }]);
  expect(historyRanges(today, { since: 2024 })).toEqual([
    { from: '2026-01-01', to: '2026-11-10' },
    { from: '2025-01-01', to: '2025-12-31' },
    { from: '2024-01-01', to: '2024-12-31' },
  ]);
  expect(realizedRanges(today, null)).toEqual([{ from: '2026-01-01', to: '2026-11-10' }]);
});

const none = { enrolled: false, count: 0, newest: null };
const added = { enrolled: true, count: 1, newest: { idPrefix: 'AbCdEfGh', rpId: 'schwab.com', algorithm: 'ES256', createdAt: Date.UTC(2026, 10, 10), lastUsedAt: null, verifiedAt: null } };
const checked = { ...added, newest: { ...added.newest, lastUsedAt: Date.UTC(2026, 10, 10, 1), verifiedAt: Date.UTC(2026, 10, 10, 1) } };
const auto = { signingIn: false, hold: null, failed: null, lastOkAt: null };
const v: View = { signedIn: false, challenge: false, lastSignedInPull: null, now: 100 * 86400_000, passkey: none, auto };

test('status, the three steps: sign in, add a passkey, log out and in with it; then online signed in or out', () => {
  expect(state(v)).toEqual({ status: 'attention', attention: { kind: 'login', message: SIGN_IN_MESSAGE, liveView: true } });
  expect(state({ ...v, lastSignedInPull: v.now - 3 * 86400_000 }).attention?.kind).toBe('login');
  expect(state({ ...v, signedIn: true }).attention).toEqual({ kind: 'passkey', message: ADD_PASSKEY_MESSAGE, liveView: true });
  expect(state({ ...v, signedIn: true, passkey: added }).attention).toEqual({ kind: 'passkey_check', message: CHECK_MESSAGE, liveView: true });
  expect(state({ ...v, passkey: added }).attention).toEqual({ kind: 'passkey_check', message: CHECK_SIGNED_OUT_MESSAGE, liveView: true });
  expect(state({ ...v, signedIn: true, passkey: checked })).toEqual({ status: 'online', attention: null });
  // Signed out with a checked passkey: it signs itself in before each pull.
  expect(state({ ...v, passkey: checked })).toEqual({ status: 'online', attention: null });
  expect(signedInLayer({ ...v, passkey: checked })).toEqual({ name: 'signed in', state: 'ok', note: SIGNS_ITSELF_IN });
  expect(signedInLayer({ ...v, passkey: checked, auto: { ...auto, signingIn: true } }).note).toBe('signing in with the passkey');
});

test('status: a code page is verify; a hold or three failed tries ask for you (login), with the reason', () => {
  expect(state({ ...v, challenge: true }).attention).toEqual({ kind: 'verify', message: CHALLENGE_MESSAGE, liveView: true });
  expect(state({ ...v, challenge: true, passkey: checked }).attention?.kind).toBe('verify');
  const hold = { what: 'code' as const, message: CHALLENGE_MESSAGE, since: v.now };
  expect(state({ ...v, passkey: checked, auto: { ...auto, hold } }).attention).toEqual({ kind: 'login', message: CHALLENGE_MESSAGE, liveView: true });
  expect(signedInLayer({ ...v, passkey: checked, auto: { ...auto, hold } })).toMatchObject({ state: 'failed', note: expect.stringContaining('a code or an approval') });
  const failed = state({ ...v, passkey: checked, auto: { ...auto, failed: 'Schwab did not ask for the passkey' } }).attention!;
  expect(failed.kind).toBe('login');
  expect(failed.message).toContain('Schwab did not ask for the passkey');
  // Signed in again: online, the hold no longer shown.
  expect(state({ ...v, signedIn: true, passkey: checked, auto: { ...auto, hold } }).status).toBe('online');
});

test('status: a paired phone that refused is the attention approval, saying what asks again; signed in, it is gone', () => {
  const denied = { reason: 'denied' as const, device: 'Pixel A', at: Date.UTC(2026, 10, 11, 6) };
  const out = { ...v, passkey: checked, auto: { ...auto, approval: denied } };
  expect(state(out)).toEqual({ status: 'attention', attention: { kind: 'approval', message: refusalMessage('Schwab', denied), liveView: true } });
  expect(state(out).attention!.message).toBe('The sign-in to Schwab was denied on Pixel A, so nothing signs in by itself any more. A pull from the page asks your phone once more, or sign in by hand in the live view.');
  expect(signedInLayer(out)).toEqual({ name: 'signed in', state: 'failed', note: 'the passkey sign-in stopped: denied on Pixel A; waits for a pull you start' });
  expect(passkeyDetails(out).autoSignIn).toBe('stopped: denied on Pixel A at 2026-11-11 06:00 UTC');
  const expired = { ...out, auto: { ...auto, approval: { ...denied, reason: 'expired' as const } } };
  expect(state(expired).attention!.message).toContain('waited for your approval on Pixel A, and it was not answered in time. The next scheduled pull asks once more');
  expect(signedInLayer(expired).note).toBe('the passkey sign-in stopped: not answered in time on Pixel A; the next scheduled pull asks again');
  // A hold from Schwab itself comes first; signed in, neither shows.
  const hold = { what: 'code' as const, message: CHALLENGE_MESSAGE, since: v.now };
  expect(state({ ...out, auto: { ...out.auto, hold } }).attention?.message).toBe(CHALLENGE_MESSAGE);
  expect(state({ ...out, signedIn: true })).toEqual({ status: 'online', attention: null });
});

test('challenges: before the passkey only a code field or a captcha; after it, words asking for a code too', () => {
  expect(challengeOf({ otp: false, challenge: true, captcha: false }, false)).toBeNull();
  expect(challengeOf({ otp: true, challenge: true, captcha: false }, false)).toBe('code');
  expect(challengeOf({ otp: false, challenge: true, captcha: false }, true)).toBe('code');
  expect(challengeOf({ otp: false, challenge: false, captcha: true }, false)).toBe('captcha');
  expect(challengeOf({ otp: false, challenge: false, captcha: false }, true)).toBeNull();
  expect(CAPTCHA_MESSAGE).toContain('captcha');
});

test('passkey layers and details: facts only, no secrets', () => {
  expect(passkeyLayers(v).map((l) => `${l.name}:${l.state}`)).toEqual(['passkey:waiting', 'passkey sign-in:waiting']);
  expect(passkeyLayers({ ...v, passkey: checked }).map((l) => `${l.name}:${l.state}`)).toEqual(['passkey:ok', 'passkey sign-in:ok']);
  expect(passkeyLayers({ ...v, passkey: checked })[0]!.note).toBe('ES256 passkey AbCdEfGh… for schwab.com, added 2026-11-10');
  const d = passkeyDetails({ ...v, passkey: checked });
  expect(d).toMatchObject({ passkeyEnrolled: true, passkeys: 1, credentialIdPrefix: 'AbCdEfGh…', passkeyAlgorithm: 'ES256', passkeyRpId: 'schwab.com', autoSignIn: 'ready' });
});

test('shownRange: the dates a page says it shows', () => {
  expect(shownRange('Date range | Transactions found from 05/10/2026 to 11/10/2026 | Brokerage')).toEqual({ from: '2026-05-10', to: '2026-11-10' });
  expect(shownRange('No transactions')).toBeNull();
});
