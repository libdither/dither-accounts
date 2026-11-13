/**
 * amazon.ts's helpers against amazon.py's own answers (fixtures/helpers.json, from make-fixtures.ts), the TOTP
 * against RFC 6238, the detail-page order (todo) and what a file teaches the state (learn), and the status.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { py } from '@dither-accounts/statements-common';
import { type AmazonState, day, knownOf, learn, money, todo } from '../src/amazon.ts';
import { totp } from '../src/auth.ts';
import { state } from '../src/status.ts';
import { DAYS, MONEYS } from './helper-cases.ts';

const H = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/helpers.json'), 'utf8'));

test("money and day answer as amazon.py's _money and _day", () => {
  expect(MONEYS.map(money)).toEqual(H.money);
  expect(DAYS.map(day)).toEqual(H.day);
});

test('TOTP is RFC 6238 (SHA-1, 6 digits)', () => {
  // RFC 6238 appendix B, the SHA-1 key "12345678901234567890", last six digits.
  const key = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  expect(totp(key, 59)).toBe('287082');
  expect(totp(key, 1111111109)).toBe('081804');
  expect(totp(key.toLowerCase().replace(/(.{4})/g, '$1 '), 1234567890)).toBe('005924');
});

test("the details to read: this run's orders newest first (stable), then known ones never read", () => {
  const o = (id: string, placed: string | null, digital = false) =>
    new py.PyObj([
      ['id', id],
      ['placed', placed],
      ['digital', digital],
    ]);
  const orders = new py.PyObj([
    ['a', o('a', '2026-01-02')],
    ['b', o('b', '2026-03-01')],
    ['c', o('c', '2026-01-02')],
    ['d', o('d', null)],
    ['D1', o('D1', '2026-04-01', true)],
    ['e', o('e', '2026-02-01')],
  ]);
  const st: AmazonState = { orders: { e: { details: true }, x: { details: false }, Dz: { details: false }, a: { details: false } }, order: ['e', 'x', 'Dz', 'a'] };
  expect(todo(orders, knownOf(st))).toEqual(['b', 'a', 'c', 'd', 'x']);
  learn(st, [o('x', null), new py.PyObj([['id', 'x'], ['summary', new py.PyObj()]]), o('new', '2026-05-05')]);
  expect(st.orders.x.details).toBe(true);
  expect(st.order).toEqual(['e', 'x', 'Dz', 'a', 'new']);
});

test('status: a held pull is the attention; signed out is fine with a password', () => {
  const v = { hold: null, navSignedIn: null, hasPassword: true, page: null };
  expect(state(v)).toEqual({ status: 'online', attention: null });
  expect(state({ ...v, navSignedIn: false })).toEqual({ status: 'online', attention: null });
  expect(state({ ...v, navSignedIn: false, hasPassword: false }).attention?.kind).toBe('login');
  expect(state({ ...v, hold: { kind: 'captcha', message: 'm', since: 1 } })).toEqual({ status: 'attention', attention: { kind: 'captcha', message: 'm', liveView: true } });
});

test('the manifest: statements only; email, password and authenticator secret are secret fields', async () => {
  const m = (await import('../manifest.ts')).default;
  expect(m).toMatchObject({ kind: 'amazon', interfaces: ['statements'], entry: 'src/main.ts' });
  expect(m.add.fields!.map((f) => [f.key, !!f.secret, !!f.optional])).toEqual([
    ['email', true, false],
    ['password', true, false],
    ['totpSecret', true, true],
  ]);
});
