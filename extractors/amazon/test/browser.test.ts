/**
 * extractors/amazon end to end in a real Chromium (Xvfb, the extension, x11vnc) against the fake Amazon
 * (fake-amazon.ts), with a stand-in for the manager's /extractor socket. The two pulls make-fixtures.ts ran with
 * dither-finance's amazon.py (a backfill with a password prompt on the third details page, then a daily pull after a
 * new order) give the same bytes here, page for page, but for the stamp. Then: the authenticator code when Amazon
 * asks for one; the robot check and the "I am human" checkpoint each stop a pull (what was read is written), hold
 * the account as an attention with the live view until the live view shows it cleared, and are never answered here.
 * Skipped without Xvfb, chromium or x11vnc.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server, ServerWebSocket, Subprocess } from 'bun';
import { EMAIL, type FakeAmazon, PASSWORD, startFakeAmazon, TOTP_SECRET } from './fake-amazon.ts';
import { browserBins } from '../../../test/needs.ts';

const bins = browserBins('amazon browser');
const it = test.skipIf(!bins);
const FIX = join(import.meta.dir, 'fixtures');
const meta = JSON.parse(readFileSync(join(FIX, 'meta.json'), 'utf8'));

let fake: FakeAmazon;
let hub: Server<undefined>;
let sock: ServerWebSocket<undefined> | null = null;
let proc: Subprocess | null = null;
let dir: string;
const events: any[] = [];
const raw: string[] = [];
const replies = new Map<string, any>();

const lastStatus = () => events.filter((e) => e.t === 'status').at(-1);
const until = async (f: () => boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (f()) return;
    await Bun.sleep(100);
  }
  const st = lastStatus();
  throw new Error(`timed out waiting for ${what}; last status ${JSON.stringify(st && { status: st.status, attention: st.attention, layers: st.layers, details: st.details })}; fake ${JSON.stringify(fake.log.slice(-10))}`);
};
async function call(t: string, input: Record<string, unknown> = {}) {
  const rid = `r${Math.random().toString(36).slice(2)}`;
  sock!.send(JSON.stringify({ t, rid, ...input }));
  await until(() => replies.has(rid), 10_000, `a reply to ${t}`);
  const r = replies.get(rid);
  if (!r.ok) throw new Error(`${t}: ${r.error}`);
  return r.result;
}
const pulls = () => events.filter((e) => e.t === 'statements.pulled');
const files = () => events.filter((e) => e.t === 'statements.file').map((e) => e.file);
async function pullOnce(n: number, input: Record<string, unknown> = {}) {
  expect(await call('statements.refresh', input)).toEqual({ started: true });
  await until(() => pulls().length === n, 150_000, `pull ${n}`);
  return pulls()[n - 1];
}
async function body(file: any) {
  const f = await call('statements.fetch', { id: file.id });
  return Buffer.from(f.base64, 'base64').toString('utf8');
}
const unstamp = (file: any, text: string) => {
  const stamp = file.name.slice('amazon-'.length, -'.json'.length);
  expect(stamp).toMatch(/^\d{8}T\d{6}Z$/);
  expect(file.dir).toBe('amazon');
  return text.replace(`"pulled_at": "${stamp}"`, '"pulled_at": "STAMP"');
};

beforeAll(async () => {
  if (!bins) return;
  fake = startFakeAmazon();
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
        const s = String(m);
        raw.push(s);
        const e = JSON.parse(s);
        if (e.t === 'reply') replies.set(e.id, e);
        else events.push(e);
      },
    },
  });
  dir = mkdtempSync(join(tmpdir(), 'dacc-amazon-'));
  writeFileSync(join(dir, 'secret.json'), JSON.stringify({ email: EMAIL, password: PASSWORD, totpSecret: TOTP_SECRET }), { mode: 0o600 });
  proc = Bun.spawn(['bun', join(import.meta.dir, '../src/main.ts')], {
    env: {
      ...process.env,
      DITHER_HUB_URL: `ws://127.0.0.1:${hub.port}/extractor`,
      DITHER_ACCOUNT_ID: 'acc_amazontest',
      DITHER_ADAPTER_TOKEN: 'token',
      DITHER_ACCOUNT_DIR: dir,
      DITHER_ACCOUNT_CONFIG: JSON.stringify({ testOrigin: fake.origin, paceScale: 0.01, schedule: false }),
      DITHER_ACCOUNT_LABEL: 'Amazon test',
    },
    stdout: 'ignore',
    stderr: 'ignore',
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
  rmSync(dir, { recursive: true, force: true });
}, 30_000);

it(
  "two pulls write amazon.py's bytes; a code is answered; a robot check and a checkpoint hold the account for you",
  async () => {
    await until(() => events.some((e) => e.t === 'hello'), 20_000, 'hello');
    expect(events.find((e) => e.t === 'hello')).toMatchObject({ interfaces: ['statements', 'browser'], capabilities: ['liveView'] });
    await until(() => lastStatus()?.status === 'online', 60_000, 'online');

    // 1. The backfill, with the password asked for on the third details page: amazon.py's file and pages.
    fake.reauthAt(3);
    expect(await pullOnce(1)).toMatchObject({ ok: true, saved: 1 });
    // The fresh profile is signed out, so the stored password answers first (dither-finance's desk was signed in).
    const log1 = fake.log.splice(0);
    expect(log1.slice(0, 2)).toEqual(['email:ok', 'password:ok:remember']);
    expect(log1.slice(2)).toEqual(meta.log1);
    expect(unstamp(files()[0], await body(files()[0]))).toBe(readFileSync(join(FIX, 'run1.json'), 'utf8'));

    // 2. A new order, then the daily pull: this year's pages until nothing is new, then details never read.
    fake.addOrder();
    expect(await pullOnce(2)).toMatchObject({ ok: true, saved: 1 });
    expect(fake.log.splice(0)).toEqual(meta.log2);
    expect(unstamp(files()[1], await body(files()[1]))).toBe(readFileSync(join(FIX, 'run2.json'), 'utf8'));
    expect(lastStatus().details).toMatchObject({ ordersKnown: 44, backfilled: true, passwordStored: true, authenticatorStored: true });

    // 3. A code when Amazon asks for one: the stored authenticator secret answers.
    fake.addOrder();
    fake.reauthAt(1);
    fake.requireOtp(true);
    await pullOnce(3, { details: 1 });
    expect(fake.log).toContain('otp:ok:remember');
    expect(pulls()[2]).toMatchObject({ ok: true });
    fake.log.splice(0);

    // 4. The robot check on the first list page: stopped, held, the tab brought forward; no answer, no retry.
    fake.robotNext();
    const p4 = await pullOnce(4);
    expect(p4.ok).toBe(false);
    expect(p4.needs).toContain('robot check');
    await until(() => lastStatus()?.attention?.kind === 'captcha', 10_000, 'the captcha attention');
    expect(lastStatus().attention.liveView).toBe(true);
    expect(await call('statements.refresh')).toMatchObject({ started: false, reason: expect.stringContaining('waiting for you in the live view') });
    expect(fake.log.filter((l) => l === 'solved')).toEqual([]);
    // You solve it in the live view (the fake's page does): the hold lifts once the live view shows Amazon again.
    fake.push('solve');
    await until(() => lastStatus()?.status === 'online', 40_000, 'the hold lifted');
    expect(fake.log).toContain('solved');

    // 5. The "I am human" checkpoint on a details page: what was read before it is written.
    fake.log.splice(0);
    fake.addOrder();
    fake.humanNext('details');
    const n = files().length;
    const p5 = await pullOnce(5);
    expect(p5).toMatchObject({ ok: false, saved: 1 });
    expect(p5.needs).toContain('human');
    await until(() => lastStatus()?.attention?.kind === 'human', 10_000, 'the checkpoint attention');
    expect(files().length).toBe(n + 1);
    const partial = JSON.parse(await body(files()[n]));
    expect(partial.orders.length).toBeGreaterThan(0);
    fake.push('solve');
    await until(() => lastStatus()?.status === 'online', 40_000, 'the hold lifted again');

    // The password, the email and the authenticator secret never reach the manager.
    const wire = raw.join('\n');
    for (const s of [PASSWORD, EMAIL, TOTP_SECRET]) expect(wire).not.toContain(s);
  },
  400_000,
);

it(
  'the browser interface: its own tab on the site only, real clicks and keys, and no Buy Now below manage',
  async () => {
    await until(() => lastStatus()?.status === 'online', 60_000, 'online');
    await expect(call('browser.read')).rejects.toThrow(/no tab of this interface is open/);
    await expect(call('browser.open', { url: 'https://elsewhere.example.com/' })).rejects.toThrow(/not this account's site/);

    const opened = await call('browser.open', { url: `${fake.origin}/dp/B0TESTCART` });
    expect(opened).toMatchObject({ title: 'Amazon.com: Test mug', challenge: null });
    const tabId = opened.tabId;
    expect((await call('browser.tabs')).tabs).toEqual([expect.objectContaining({ tabId, active: true })]);

    const page = await call('browser.read');
    expect(page.text).toContain('Test mug, blue, 12 oz');
    const el = (name: string) => page.elements.find((e: any) => e.name === name);
    expect(el('Quantity')).toMatchObject({ role: 'combobox', value: '1' });
    expect(el('Gift note')).toMatchObject({ role: 'textbox', value: '' });
    expect(el('Add to cart')).toMatchObject({ role: 'button' });
    expect(el('Add to cart').guarded).toBeUndefined();
    expect(el('Buy Now')).toMatchObject({ role: 'button', guarded: true, inView: false });

    await call('browser.select', { ref: el('Quantity').ref, option: '2' });
    await call('browser.type', { ref: el('Gift note').ref, text: 'for the office' });
    await expect(call('browser.click', { ref: el('Buy Now').ref })).rejects.toThrow(/only browser.press/);
    const shot = await call('browser.shot');
    expect(Buffer.from(shot.base64, 'base64').subarray(1, 4).toString()).toBe('PNG');

    const after = await call('browser.click', { ref: el('Add to cart').ref });
    expect(after.url).toBe(`${fake.origin}/cart`);
    expect(fake.shop).toEqual([{ what: 'add', trusted: true, qty: '2', note: 'for the office' }]);
    await expect(call('browser.click', { ref: el('Add to cart').ref })).rejects.toThrow(/read the page again/);

    expect(await call('browser.close', { tabId })).toEqual({ closed: true });
    await expect(call('browser.read', { tabId })).rejects.toThrow(/not one this interface opened|closed/);
  },
  120_000,
);
