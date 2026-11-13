/**
 * Haveno accounts over the real wire: a manager with the haveno kind, an account added through its HTTP API as the
 * page adds it, the extractor talking gRPC to a fake daemon (extractors/haveno/test/fake-haveno.ts), and an app with an
 * exchange write grant. Covers: locked → unlock (wrong, then right) → syncing → online; every read op and the
 * mapping; trading ops and their refusals; notifications as events (trade, chat, error); a daemon restart that
 * reopens the account from the password in memory; remember/forget in secret.json; a wrong API password; and the
 * desktop handover: openApp stops the node, runs the app in the sandbox with a live view, and when the app quits the
 * node is back and opened again.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AccountsClient, CallFailed, register } from '@dither-accounts/client';
import { exchange } from '@dither-accounts/interfaces';
import { createManager, type Manager } from '@dither-accounts/manager';
import { kindOf } from '@dither-accounts/manager/kinds';
import manifest from '../extractors/haveno/manifest.ts';
import { type FakeHaveno, PEER, startFakeHaveno, tradeInfo } from '../extractors/haveno/test/fake-haveno.ts';
import { sandbox, why } from './needs.ts';

const ok = why('the native-app sandbox (bubblewrap, Xvfb, x11vnc, dbus)', sandbox);
const it = test.skipIf(!ok);

setDefaultTimeout(60_000);
const ROOT = resolve(import.meta.dir, '..');
const sleepBin = realpathSync(Bun.which('sleep') ?? '/run/current-system/sw/bin/sleep');
const ENV = {
  DITHER_HAVENO_CHECK_MS: '300',
  DITHER_HAVENO_POLL_MS: '500',
  DITHER_HAVENO_HANDOVER_MS: '5000',
  DITHER_HAVENO_APP_COMMAND: JSON.stringify([sleepBin, '3']),
  DITHER_HAVENO_APP_NETWORK: 'none',
};
let fake: FakeHaveno;
let m: Manager;
let dir: string;
let dataDir: string;
let app: AccountsClient;
let account: string;
const saved: Record<string, string | undefined> = {};
type Ev = { account: string; t: string; [k: string]: any };
const events: Ev[] = [];

const until = async (f: () => unknown | Promise<unknown>, ms = 10_000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const api = (path: string, init: RequestInit = {}) => fetch(m.url + path, { ...init, headers: { 'content-type': 'application/json', origin: m.url, ...(init.headers ?? {}) } });
const detail = async (id = account) => (await (await api(`/api/accounts/${id}`)).json()) as any;
const status = async (id = account) => (await detail(id)).status as any;
const phase = async (id = account) => (await status(id))?.details?.phase;
const page = async (action: string, args?: Record<string, unknown>, id = account) => {
  const r = await api(`/api/accounts/${id}/call`, { method: 'POST', body: JSON.stringify({ op: 'action', input: { action, ...(args ? { args } : {}) } }) });
  return (await r.json()) as { ok: boolean; result?: any; error?: { message: string; code?: string } };
};
const call = (op: keyof (typeof exchange)['ops'] & string, input: any = {}, id = account) => app.call(exchange, id, op as any, input) as Promise<any>;
const secretOf = (id = account) => {
  try {
    return JSON.parse(readFileSync(join(dir, 'accounts', id, 'secret.json'), 'utf8'));
  } catch {
    return {};
  }
};

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  fake = await startFakeHaveno();
  dir = mkdtempSync(join(tmpdir(), 'dacc-haveno-'));
  dataDir = mkdtempSync(join(tmpdir(), 'dacc-haveno-data-'));
  m = await createManager({ openPage: true, dataDir: dir, port: 0, kinds: new Map([['haveno', kindOf(manifest, join(ROOT, 'extractors/haveno'))]]) });
  const reg = await register(m.url, { name: 'trader', requests: [{ interface: 'exchange', level: 'write' }] });
  expect((await api(`/api/requests/${reg.requests[0].id}/approve`, { method: 'POST', body: '{}' })).status).toBe(200);
  app = new AccountsClient({ url: m.url, app: reg.app, token: reg.token, onEvents: (a, evs) => events.push(...evs.map((e) => ({ ...e, account: a }) as Ev)) });
  await until(() => app.connected, 4000, 'the app connected');
  const r = await api('/api/accounts', { method: 'POST', body: JSON.stringify({ kind: 'haveno', label: 'Haveno', config: { address: fake.address, dataDir }, secret: { apiPassword: fake.apiPassword } }) });
  expect(r.status).toBe(200);
  account = ((await r.json()) as any).id;
});
afterAll(async () => {
  app?.close();
  await m?.stop();
  fake?.stop();
  rmSync(dir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test('a locked account asks for its password, and apps are told why they cannot read', async () => {
  await until(async () => (await phase()) === 'locked', 10_000, 'locked');
  const s = await status();
  expect(s.status).toBe('attention');
  expect(s.attention.kind).toBe('login');
  expect(s.layers.map((l: any) => [l.name, l.state])).toContainEqual(['account open', 'failed']);
  const e = await call('exchange.balances').catch((x) => x);
  expect(e).toBeInstanceOf(CallFailed);
  expect(String(e.message)).toMatch(/locked/);
});

test('unlock: a wrong password is refused, the right one opens the account, and it goes online', async () => {
  const bad = await page('unlock', { password: 'nope' });
  expect(bad.ok).toBe(false);
  expect(bad.error?.message).toMatch(/did not open/);
  const good = await page('unlock', { password: fake.accountPassword });
  expect(good.ok).toBe(true);
  await until(async () => (await phase()) === 'online', 10_000, 'online');
  const s = await status();
  expect(s.status).toBe('online');
  expect(s.details.passwordKept).toBe('memory');
  expect(s.details.balance).toBe('1.2505 XMR');
  expect(secretOf().accountPassword).toBeUndefined();
  expect(JSON.stringify(s)).not.toContain(fake.accountPassword);
});

test('reads: balances, prices, the offer book, trades, a chat, payment accounts', async () => {
  const b = await call('exchange.balances');
  expect(b).toMatchObject({ currency: 'XMR', decimals: 12, balance: '1250500000000', available: '1250500000000' });
  const p = await call('exchange.prices', { currencies: ['usd'] });
  expect(p.prices).toEqual([{ currency: 'USD', price: 604.3 }]);
  const o = await call('exchange.offers', { direction: 'SELL', currency: 'USD' });
  expect(o.offers.map((x: any) => x.id)).toEqual(['offer-1', 'offer-2']);
  expect(o.offers[0]).toMatchObject({ direction: 'SELL', currency: 'USD', price: '612.50', amount: '1000000000000', paymentMethod: 'ZELLE', mine: false, paymentAccountId: null, marketMarginPct: null, securityDepositPct: 0.15 });
  const t = await call('exchange.trades');
  expect(t.trades).toHaveLength(1);
  expect(t.trades[0]).toMatchObject({ id: 'trade-aaaaaaaa', shortId: 'trade-a', peer: PEER, depositsUnlocked: true, paymentSent: false, deadline: 1800086400000 });
  const c = await call('exchange.chat', { tradeId: 'trade-aaaaaaaa' });
  expect(c.messages).toEqual([expect.objectContaining({ uid: 'c1', from: 'peer', text: 'hello', at: 1800000001000 })]);
  const a = await call('exchange.paymentAccounts');
  expect(a.accounts).toEqual([{ id: 'acct-zelle', name: 'Zelle: me', method: 'ZELLE', currencies: ['USD'], currency: 'USD', at: 1732400000000 }]);
});

test('trading: post and cancel an offer, take one, confirm a payment, chat; refusals say why', async () => {
  const both = await call('exchange.postOffer', { direction: 'BUY', currency: 'USD', amount: '100000000000', price: '600', marketMarginPct: 1, paymentAccountId: 'acct-zelle' }).catch((x) => x);
  expect(String(both.message)).toMatch(/either price/);
  const badAmount = await call('exchange.postOffer', { direction: 'BUY', currency: 'USD', amount: '0.1', marketMarginPct: 1, paymentAccountId: 'acct-zelle' }).catch((x) => x);
  expect(String(badAmount.message)).toMatch(/piconero/);
  const posted = await call('exchange.postOffer', { direction: 'BUY', currency: 'USD', amount: '100000000000', marketMarginPct: -1.5, paymentAccountId: 'acct-zelle' });
  expect(posted.offer).toMatchObject({ mine: true, direction: 'BUY', marketMarginPct: -1.5, minAmount: '100000000000', paymentAccountId: 'acct-zelle' });
  expect((await call('exchange.myOffers')).offers).toHaveLength(1);
  await call('exchange.cancelOffer', { id: posted.offer.id });
  expect((await call('exchange.myOffers')).offers).toHaveLength(0);
  const gone = await call('exchange.cancelOffer', { id: 'nope' }).catch((x) => x);
  expect(String(gone.message)).toMatch(/not found/);

  const taken = await call('exchange.takeOffer', { offerId: 'offer-1', paymentAccountId: 'acct-zelle' });
  expect(taken.trade.id).toBe('trade-offer-1');
  const lost = await call('exchange.takeOffer', { offerId: 'offer-gone', paymentAccountId: 'acct-zelle' }).catch((x) => x);
  expect(String(lost.message)).toMatch(/already taken/);

  await call('exchange.paymentSent', { tradeId: 'trade-aaaaaaaa' });
  expect((await call('exchange.trade', { id: 'trade-aaaaaaaa' })).trade.paymentSent).toBe(true);
  await call('exchange.sendChat', { tradeId: 'trade-aaaaaaaa', text: 'sent it' });
  const c = await call('exchange.chat', { tradeId: 'trade-aaaaaaaa' });
  expect(c.messages.at(-1)).toMatchObject({ from: 'me', text: 'sent it' });
});

test('the write grant does not reach payment accounts or account actions', async () => {
  const e = await call('exchange.deletePaymentAccount', { id: 'acct-zelle' }).catch((x) => x);
  expect(e).toBeInstanceOf(CallFailed);
  expect(e.code).toBe('denied');
  const a = await call('action', { action: 'openApp' }).catch((x) => x);
  expect(a.code).toBe('denied');
});

test("the node's notifications become events: a trade update, a chat message, an error", async () => {
  await until(() => fake.calls.includes('RegisterNotificationListener'), 5000, 'the stream');
  await Bun.sleep(200);
  fake.notify({ type: 'TRADE_UPDATE', trade: tradeInfo('trade-aaaaaaaa', { isPaymentReceived: true, phase: 'PAYMENT_RECEIVED' }) });
  fake.notify({ type: 'CHAT_MESSAGE', trade: tradeInfo('trade-aaaaaaaa'), chatMessage: { uid: 'c9', tradeId: 'trade-aaaaaaaa', date: '1800000009000', message: 'got it', senderNodeAddress: { hostName: 'peerpeerpeer.onion', port: 9999 } } });
  fake.notify({ type: 'ERROR', title: 'Error', message: 'something broke' });
  await until(() => events.some((e) => e.t === 'exchange.notice'), 5000, 'the events');
  expect(events.find((e) => e.t === 'exchange.trade' && e.trade.phase === 'PAYMENT_RECEIVED')?.trade.paymentReceived).toBe(true);
  expect(events.find((e) => e.t === 'exchange.chat')?.message).toMatchObject({ uid: 'c9', from: 'peer', text: 'got it' });
  expect(events.find((e) => e.t === 'exchange.notice')?.notice).toMatchObject({ kind: 'error', message: 'something broke' });
});

test('a polled trade that moved on is announced once', async () => {
  const before = events.filter((e) => e.t === 'exchange.trade' && e.trade.id === 'trade-aaaaaaaa').length;
  fake.trades[0].payoutState = 'PAYOUT_PUBLISHED';
  fake.trades[0].isPayoutPublished = true;
  await until(() => events.some((e) => e.t === 'exchange.trade' && e.trade.payoutPublished), 5000, 'the polled change');
  await Bun.sleep(1200);
  expect(events.filter((e) => e.t === 'exchange.trade' && e.trade.id === 'trade-aaaaaaaa').length).toBe(before + 1);
});

test('a daemon restart: the account opens again from the password in memory', async () => {
  const opens = fake.state.opens;
  fake.down();
  await until(async () => (await phase()) === 'down', 5000, 'down');
  expect((await status()).status).toBe('offline');
  await fake.up();
  await until(async () => (await phase()) === 'online', 10_000, 'online again');
  expect(fake.state.opens).toBe(opens + 1);
});

test('remember keeps the password in secret.json; forget takes it out of both', async () => {
  expect((await page('unlock', { password: fake.accountPassword, remember: true })).ok).toBe(true);
  expect(secretOf().accountPassword).toBe(fake.accountPassword);
  expect(secretOf().apiPassword).toBe(fake.apiPassword);
  await until(async () => (await status()).details.passwordKept === 'memory and secret.json', 3000, 'remembered');
  expect((await page('forget')).ok).toBe(true);
  expect(secretOf().accountPassword).toBeUndefined();
  expect(secretOf().apiPassword).toBe(fake.apiPassword);
  await until(async () => (await status()).details.passwordKept === 'no', 3000, 'forgotten');
  // Open again for what follows.
  expect((await page('unlock', { password: fake.accountPassword })).ok).toBe(true);
});

it('openApp: the node stops, the app runs in the sandbox with a live view, and when it quits the node is back', async () => {
  await until(async () => (await phase()) === 'online', 10_000, 'online');
  const stops = fake.state.stops;
  const r = await page('openApp');
  expect(r.ok).toBe(true);
  expect(fake.state.stops).toBe(stops + 1);
  const s = await status();
  expect(s.details.phase).toBe('app');
  expect(s.attention).toMatchObject({ kind: 'app', liveView: true });
  expect((await detail()).liveView ?? s.liveView).toBeTruthy();
  const e = await call('exchange.balances').catch((x) => x);
  expect(String(e.message)).toMatch(/desktop app/);
  // The stand-in app quits after 3 s; systemd would bring the node back, here the test does.
  await until(async () => (await phase()) !== 'app', 10_000, 'the app quit');
  await fake.up();
  await until(async () => (await phase()) === 'online', 10_000, 'online after the app');
  expect((await status()).liveView).toBeUndefined();
});

test('a wrong API password says so', async () => {
  const r = await api('/api/accounts', { method: 'POST', body: JSON.stringify({ kind: 'haveno', label: 'Wrong', config: { address: fake.address, dataDir }, secret: { apiPassword: 'wrong' } }) });
  const id = ((await r.json()) as any).id;
  await until(async () => (await phase(id)) === 'denied', 10_000, 'denied');
  expect((await status(id)).attention.kind).toBe('config');
});
