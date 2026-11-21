/**
 * Approvals (docs/approver.md "Approvals", packages/manager/src/approvals.ts) against a real manager: the built-in
 * `approver` account in an app's list, the keys frame, and requests asked through the router by a test app holding an
 * `approvals` grant, answered by fake phones (packages/passkey/test/fake-device.ts): signed, unsigned, refused, bad
 * answers dropped, bad asks refused, cancel and expiry reaching the devices, wake-ups and resending on a new link, and
 * the answers kept for catch-up. A fake push server stands in for UnifiedPush. Port 0, temp data dirs, no network.
 */
import type { Server } from 'bun';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { answerText, askText, displayHash, fingerprint, messageHash, parseStatement, sha256hex, statementText, verifySignature } from '@dither-accounts/approval';
import { AccountsClient, CallFailed, register } from '@dither-accounts/client';
import { type ApprovalAnswer, type ApprovalDisplay, approvals } from '@dither-accounts/interfaces';
import { createManager, type Manager } from '@dither-accounts/manager';
import type { ApproversState } from '../packages/manager/src/api-types.ts';
import { FakeDevice } from '../packages/passkey/test/fake-device.ts';

let m: Manager;
let dir: string;
let push: Server<undefined>;
const pushes: string[] = [];
let app: AccountsClient;
const got: { account: string; ev: Record<string, any> }[] = [];
let a: FakeDevice;
let b: FakeDevice;

const until = async (f: () => boolean | Promise<boolean>, ms = 8000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const api = async <T = any>(path: string, method = 'GET', body?: unknown): Promise<T> => (await (await fetch(m.url + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })).json()) as T;
const call = <K extends keyof (typeof approvals)['ops'] & string>(op: K, input: any) => app.call(approvals, 'approver', op, input);
const answersFor = (id: string) => got.filter((g) => g.account === 'approver' && g.ev.t === 'approvals.answer' && g.ev.id === id).map((g) => g.ev as ApprovalAnswer & { t: string });
const audit = async (id: string) => (await api<ApproversState>('/api/approvers')).approvals.find((r) => r.id === id);
const pairDevice = async (d: FakeDevice, o: { push?: string | null } = {}) => {
  const p = await api<{ link: string }>('/api/approvers/pair', 'POST');
  expect((await d.pair(m.url, FakeDevice.parseLink(p.link).code)).status).toBe(200);
  await d.connect(m.url, o);
};
/**
 * A ping and its pong: the manager handles a link's frames in order, so everything the device sent before has been
 * handled, and everything the manager sent it before has arrived.
 */
const roundTrip = async (d: FakeDevice) => {
  const k = d.received.filter((x) => x.t === 'pong').length;
  d.send({ t: 'ping' });
  await until(() => d.received.filter((x) => x.t === 'pong').length > k, 4000, 'pong');
};
const kept = (id: string) => !!m.store.one('SELECT 1 FROM approval_answer WHERE id = ?', id);
const keyed = (d: FakeDevice) => until(() => m.approvers.keyedOnline(d.deviceId!), 8000, `${d.name}'s keys`);

let n = 0;
/** A request as the hub makes it: the ask's eight lines and what to show, hashed to match. */
function request(o: { kind?: string; expiresIn?: number; actions?: ApprovalDisplay['actions']; title?: string; body?: string; payload?: string } = {}) {
  n++;
  const id = `apv_${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url')}`;
  const now = Date.now();
  const display: ApprovalDisplay = {
    kind: o.kind ?? 'merge',
    asker: 'review',
    title: o.title ?? `Merge review/fix-${n} into main (system-config)`,
    body: o.body ?? 'abc1234 Fix the thing\n 1 file changed, 2 insertions(+)',
    payload: o.payload ?? `dither-merge-v1\nrepo system-config\ntarget main\nbranch review/fix-${n}\nbase ${'a'.repeat(40)}\nhead ${'b'.repeat(40)}\ntree ${'c'.repeat(40)}\n`,
    urgency: 'normal',
    actions: o.actions ?? [
      { id: 'approve', label: 'Approve', needs: 'signed' },
      { id: 'deny', label: 'Deny', needs: 'any' },
    ],
  };
  const ask = askText({ id, kind: display.kind, asker: display.asker, created: now, expires: now + (o.expiresIn ?? 60_000), payloadSha256: sha256hex(display.payload), displaySha256: displayHash(display.title, display.body) });
  return { id, ask, display, expiresAt: now + (o.expiresIn ?? 60_000) };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dacc-approvals-'));
  push = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      pushes.push(await req.text());
      return new Response(null, { status: 201 });
    },
  });
  m = await createManager({ openPage: true, dataDir: dir, port: 0, kinds: new Map(), approverPushHttp: true });
  const reg = await register(m.url, { name: 'hub-test', requests: [{ interface: 'approvals', level: 'write', accounts: ['approver'] }] });
  const st = await api('/api/state');
  for (const x of st.apps) for (const r of x.requests) if (r.state === 'pending') await api(`/api/requests/${r.id}/approve`, 'POST', {});
  app = new AccountsClient({ url: m.url, app: reg.app, token: reg.token, onEvents: (account, evs) => got.push(...evs.map((ev) => ({ account, ev: ev as Record<string, any> }))) });
  await until(() => app.connected, 15_000, 'the app connected');
  a = await FakeDevice.make('Pixel A');
  b = await FakeDevice.make('Pixel B');
}, 30_000);
afterAll(async () => {
  app?.close();
  a?.close();
  b?.close();
  await m?.stop();
  push?.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

test('the built-in account: in the app’s list as online, with the approvals interface', async () => {
  await until(() => app.accounts?.some((x) => x.id === 'approver'), 4000, 'approver listed');
  expect(app.accounts.find((x) => x.id === 'approver')).toMatchObject({ id: 'approver', kind: 'approver', label: 'Approvers', interfaces: ['approvals'], running: true, online: true, enabled: true, grants: { approvals: 'write' }, manages: false });
  expect(await call('approvals.devices', {})).toEqual({ devices: [] });
}, 20_000);

describe('the keys frame', () => {
  test('a paired phone’s keys frame is checked and kept: kind and approval key, on the page and in approvals.devices', async () => {
    await pairDevice(a);
    await keyed(a);
    const saved = JSON.parse(readFileSync(join(dir, 'approvers.json'), 'utf8')).devices[0];
    expect(saved).toMatchObject({ id: a.deviceId, kind: 'phone', approvalKey: a.approvalSpki });
    expect(await call('approvals.devices', {})).toEqual({ devices: [{ id: a.deviceId!, name: 'Pixel A', kind: 'phone', approvalKey: a.approvalSpki, fingerprint: fingerprint(a.approvalSpki), online: true }] });
    const page = (await api<ApproversState>('/api/approvers')).devices[0];
    expect(page).toMatchObject({ kind: 'phone', approvalFingerprint: fingerprint(a.approvalSpki) });
    expect(page.approvalFingerprint).not.toBe(page.fingerprint);
  }, 20_000);

  test('one its identity key did not sign, or with a bad key or kind, is ignored', async () => {
    b.sendKeys = false;
    await pairDevice(b);
    const other = await FakeDevice.make();
    b.send(await b.keysFrame({ signWith: other.identity.privateKey }));
    b.send(await b.keysFrame({ kind: 'tablet' }));
    b.send(await b.keysFrame({ approval: Buffer.from('not a key').toString('base64') }));
    await roundTrip(b);
    expect(m.approvers.keyedOnline(b.deviceId!)).toBe(false);
    expect((await call('approvals.devices', {})).devices.find((d) => d.id === b.deviceId)).toMatchObject({ kind: null, approvalKey: null, fingerprint: null });
    // A good one, as an app that sends keys does on every link.
    b.send(await b.keysFrame());
    await keyed(b);
    expect((await call('approvals.devices', {})).devices.find((d) => d.id === b.deviceId)).toMatchObject({ kind: 'phone', approvalKey: b.approvalSpki });
  }, 20_000);
});

describe('asking', () => {
  test('ask → the phone signs → approvals.answer, whose statement verifies with its approval key; the other phone is cancelled', async () => {
    a.decideApproval = () => ({ action: 'approve', message: 'ok, but rebuild the other host after' });
    b.decideApproval = () => 'ignore';
    const r = request();
    expect(await call('approvals.ask', r)).toEqual({ devices: 2 });
    await until(() => answersFor(r.id).length === 1, 8000, 'the answer');
    const ev = answersFor(r.id)[0]!;
    expect(ev).toMatchObject({ id: r.id, ok: true, action: 'approve', message: 'ok, but rebuild the other host after', device: a.deviceId!, deviceName: 'Pixel A', deviceKind: 'phone' });
    if (!ev.ok) throw new Error('not ok');
    // What the device was sent is the ask, verbatim, and what to show.
    const sent = a.requests.find((x) => x.id === r.id)!;
    expect(sent).toMatchObject({ t: 'request', id: r.id, op: 'approve', ask: r.ask, display: r.display, expiresAt: r.expiresAt });
    // The statement: the ask's lines and the answer's, signed by the approval key (not the identity key).
    const statement = r.ask + answerText({ action: 'approve', messageSha256: messageHash(ev.message), device: a.deviceId!, signed: ev.signed });
    expect(ev.statement).toBe(statement);
    const parsed = parseStatement(statement);
    if (typeof parsed === 'string') throw new Error(parsed);
    expect(statementText(parsed)).toBe(statement);
    expect(await verifySignature(a.approvalSpki, statement, ev.signature!)).toBe(true);
    expect(await verifySignature(a.spki, statement, ev.signature!)).toBe(false);
    await until(() => b.cancels.includes(r.id), 4000, 'cancel on the other phone');
    expect(a.cancels).not.toContain(r.id);
    // The audit: op approve, the asker, the kind; never the title, body or message.
    expect(await audit(r.id)).toMatchObject({ op: 'approve', account: 'review', rpId: '', reason: 'merge', outcome: 'ok', message: 'approve', device: a.deviceId! });
    const row = m.store.one<Record<string, unknown>>('SELECT * FROM approval WHERE id = ?', r.id)!;
    expect(JSON.stringify(row)).not.toContain('rebuild the other host');
    expect(JSON.stringify(row)).not.toContain('Merge review');
    // Kept for catch-up.
    const { t: _t, ...plain } = ev;
    expect(await call('approvals.answers', { ids: [r.id, 'apv_nothing_like_this_00'] })).toEqual({ answers: [plain as ApprovalAnswer] });
    // Asked again (a hub that lost the answer): not sent again.
    expect(await call('approvals.ask', r)).toEqual({ devices: 0, answered: true } as any);
  }, 20_000);

  test('deny is answered without a signature', async () => {
    a.decideApproval = () => ({ action: 'deny', message: 'not now' });
    const r = request();
    await call('approvals.ask', r);
    await until(() => answersFor(r.id).length === 1, 8000, 'the answer');
    const ev = answersFor(r.id)[0]!;
    expect(ev).toMatchObject({ id: r.id, ok: true, action: 'deny', message: 'not now', device: a.deviceId! });
    expect('signature' in ev).toBe(false);
    expect('statement' in ev).toBe(false);
    expect(typeof (ev as any).signed).toBe('number');
    expect(await audit(r.id)).toMatchObject({ outcome: 'denied', message: 'deny' });
  }, 20_000);

  test('answers that do not check out are dropped and the request waits on', async () => {
    a.decideApproval = () => 'ignore';
    b.decideApproval = () => 'ignore';
    const r = request({ actions: [{ id: 'resume', label: 'Resume', needs: 'any' }, { id: 'rollback', label: 'Roll back', needs: 'signed' }, { id: 'deny', label: 'Deny', needs: 'any' }], kind: 'deploy', payload: 'dither-deploy-v1\nhost laptop\ncommit ' + 'd'.repeat(40) + '\nstate failed\nreason a unit failed\n' });
    await call('approvals.ask', r);
    await until(() => a.approvals.has(r.id) && b.approvals.has(r.id), 4000, 'both hold it');
    const re = (d: FakeDevice) => d.approvals.set(r.id, d.requests.find((x) => x.id === r.id)!);
    // A signed action without a signature; an action it was not offered; a signature over another message; one by
    // the identity key; a message too long.
    await a.answerApproval(r.id, 'rollback', null, false);
    re(a);
    await a.answerApproval(r.id, 'approve', null, true);
    re(a);
    await a.answerApproval(r.id, 'rollback', 'yes', true, (f) => (f.message = 'no'));
    re(a);
    await a.answerApproval(r.id, 'rollback', null, true, (f) => (f.signed += 1));
    re(a);
    await a.answerApproval(r.id, 'resume', 'x'.repeat(1001));
    re(a);
    // One for a request it doesn't know.
    a.send({ t: 'response', id: 'apv_AAAAAAAAAAAAAAAAAAAAAA', ok: true, op: 'approve', action: 'deny', message: null, signed: Date.now() });
    await roundTrip(a);
    expect(kept(r.id)).toBe(false);
    expect((await audit(r.id))?.outcome).toBe('waiting');
    // An action that needs none, unsigned, from the other phone: accepted, and the first event for it (events come in order).
    await b.answerApproval(r.id, 'resume', null);
    await until(() => answersFor(r.id).length > 0, 4000, 'the answer');
    expect(answersFor(r.id)).toMatchObject([{ ok: true, action: 'resume', device: b.deviceId! }]);
    await until(() => a.cancels.includes(r.id), 4000, 'cancelled on the other');
  }, 20_000);

  test('a refusal goes on as ok:false, and the request waits for the other devices', async () => {
    a.decideApproval = () => ({ reason: 'refused', message: 'the payload is not well formed' });
    b.decideApproval = () => 'ignore';
    const r = request();
    await call('approvals.ask', r);
    await until(() => answersFor(r.id).length === 1, 4000, 'the refusal');
    expect(answersFor(r.id)[0]).toEqual({ t: 'approvals.answer', id: r.id, ok: false, reason: 'refused', message: 'the payload is not well formed', device: a.deviceId!, deviceName: 'Pixel A' } as any);
    expect((await audit(r.id))?.outcome).toBe('waiting');
    // Not sent to it again on its next link; the other still holds it.
    a.close();
    await until(() => !m.approvers.online(a.deviceId!), 4000, 'a offline');
    a.requests = [];
    await a.connect();
    await keyed(a);
    await roundTrip(a);
    expect(b.approvals.has(r.id)).toBe(true);
    expect(a.requests.some((x) => x.id === r.id)).toBe(false);
    await call('approvals.cancel', { id: r.id });
    await until(() => b.cancels.includes(r.id), 4000, 'cancel');
  }, 20_000);

  test('bad asks are refused (invalid) before anything is sent', async () => {
    const bad = async (x: unknown) => {
      const e = (await call('approvals.ask', x).catch((err) => err)) as CallFailed;
      expect(e).toBeInstanceOf(CallFailed);
      expect(e.code).toBe('invalid');
      return e.message;
    };
    const r = request();
    expect(await bad({ ...r, display: { ...r.display, title: 'Something else' } })).toContain('display-sha256');
    expect(await bad({ ...r, display: { ...r.display, payload: r.display.payload.replace('main', 'dev') } })).toContain('payload-sha256');
    expect(await bad({ ...r, display: { ...r.display, asker: 'other' } })).toContain('asker');
    expect(await bad({ ...r, ask: r.ask.replace('\nkind merge', '\nkind  merge') })).toBeTruthy();
    expect(await bad({ ...r, ask: r.ask.slice(0, -1) })).toBeTruthy();
    expect(await bad({ ...r, expiresAt: r.expiresAt + 1 })).toContain('expires');
    const late = request({ expiresIn: -1000 });
    expect(await bad(late)).toContain('expired');
    const noDeny = request({ actions: [{ id: 'approve', label: 'Approve', needs: 'signed' }] });
    expect(await bad(noDeny)).toContain('deny');
    const signedDeny = request({ actions: [{ id: 'deny', label: 'Deny', needs: 'signed' }] });
    expect(await bad(signedDeny)).toContain('deny');
    expect(a.requests.some((x) => x.id === r.id) || b.requests.some((x) => x.id === r.id)).toBe(false);
    expect(await audit(r.id)).toBeUndefined();
    // The same id asked with other words, while the first waits.
    a.decideApproval = b.decideApproval = () => 'ignore';
    await call('approvals.ask', r);
    const other = request({ title: 'Another title' });
    expect(await bad({ ...other, id: r.id, ask: other.ask.replace(other.id, r.id) })).toContain('other words');
    await call('approvals.cancel', { id: r.id });
  }, 20_000);

  test('cancel reaches every device that holds it; a late answer is dropped', async () => {
    a.decideApproval = b.decideApproval = () => 'ignore';
    const r = request();
    await call('approvals.ask', r);
    await until(() => a.approvals.has(r.id) && b.approvals.has(r.id), 4000, 'both hold it');
    const held = a.approvals.get(r.id)!;
    expect(await call('approvals.cancel', { id: r.id, reason: 'a newer head' })).toEqual({});
    await until(() => a.cancels.includes(r.id) && b.cancels.includes(r.id), 4000, 'cancel on both');
    expect(await audit(r.id)).toMatchObject({ outcome: 'cancelled', message: null });
    a.approvals.set(r.id, held);
    await a.answerApproval(r.id, 'approve');
    await roundTrip(a);
    expect(kept(r.id)).toBe(false);
    expect((await audit(r.id))?.outcome).toBe('cancelled');
    // Cancelling one it doesn't hold is fine.
    expect(await call('approvals.cancel', { id: r.id })).toEqual({});
  }, 20_000);

  test('expiry: cancelled on the devices, audited, and nothing taken after', async () => {
    a.decideApproval = b.decideApproval = () => 'ignore';
    const r = request({ expiresIn: 600 });
    await call('approvals.ask', r);
    await until(() => a.cancels.includes(r.id) && b.cancels.includes(r.id), 6000, 'the expiry’s cancels');
    expect(Date.now()).toBeGreaterThanOrEqual(r.expiresAt);
    expect((await audit(r.id))?.outcome).toBe('expired');
    const e = (await call('approvals.intent', { id: r.id, action: 'deny' }).catch((x) => x)) as CallFailed;
    expect(e.code).toBe('invalid');
  }, 20_000);

  test('a device without a link is woken, and gets what waits once its keys come; intents go only to desk devices', async () => {
    const c = await FakeDevice.make('Pixel C');
    await pairDevice(c, { push: `http://127.0.0.1:${push.port}/up/c` });
    await keyed(c);
    c.close();
    await until(() => !m.approvers.online(c.deviceId!), 4000, 'c offline');
    pushes.length = 0;
    a.decideApproval = b.decideApproval = c.decideApproval = () => 'ignore';
    const r = request();
    expect(await call('approvals.ask', r)).toEqual({ devices: 2 });
    await until(() => pushes.length === 1, 4000, 'the wake-up');
    expect(pushes[0]).toBe('{"t":"wake"}');
    c.decideApproval = () => ({ action: 'approve' });
    await c.connect();
    await until(() => answersFor(r.id).length === 1, 4000, 'c answers once linked');
    expect(answersFor(r.id)[0]).toMatchObject({ ok: true, device: c.deviceId!, deviceName: 'Pixel C' });
    // Phones are not desk signers: an intent goes nowhere.
    const r2 = request();
    a.decideApproval = b.decideApproval = c.decideApproval = () => 'ignore';
    await call('approvals.ask', r2);
    await until(() => a.approvals.has(r2.id), 4000, 'a holds it');
    expect(await call('approvals.intent', { id: r2.id, action: 'approve', message: null })).toEqual({ sent: 0 });
    expect(((await call('approvals.intent', { id: r2.id, action: 'merge-it' }).catch((x) => x)) as CallFailed).code).toBe('invalid');
    await call('approvals.cancel', { id: r2.id });
    c.close();
  }, 20_000);

  test('an app with only read sees devices and answers but cannot ask', async () => {
    const reg = await register(m.url, { name: 'reader', requests: [{ interface: 'approvals', level: 'read', accounts: ['approver'] }] });
    const st = await api('/api/state');
    for (const x of st.apps) for (const r of x.requests) if (r.state === 'pending') await api(`/api/requests/${r.id}/approve`, 'POST', {});
    const reader = new AccountsClient({ url: m.url, app: reg.app, token: reg.token });
    try {
      await until(() => reader.connected && reader.accounts?.some((x) => x.id === 'approver'), 8000, 'reader connected');
      expect((await reader.call(approvals, 'approver', 'approvals.devices', {})).devices.length).toBeGreaterThan(0);
      const e = (await reader.call(approvals, 'approver', 'approvals.ask', request()).catch((x) => x)) as CallFailed;
      expect(e.code).toBe('denied');
    } finally {
      reader.close();
    }
  }, 20_000);
});

test('answers are kept a day only', async () => {
  const d2 = mkdtempSync(join(tmpdir(), 'dacc-approvals-keep-'));
  const m2 = await createManager({ openPage: true, dataDir: d2, port: 0, kinds: new Map(), startAccounts: false, approvalAnswersMs: 1 });
  try {
    m2.store.run('INSERT INTO approval_answer (id, answer, at) VALUES (?, ?, ?)', 'apv_kept_for_a_moment_00', JSON.stringify({ id: 'apv_kept_for_a_moment_00', ok: true }), Date.now() - 10);
    expect(await m2.approvals.handle('approvals.answers', { ids: ['apv_kept_for_a_moment_00'] })).toEqual({ answers: [] });
  } finally {
    await m2.stop();
    rmSync(d2, { recursive: true, force: true });
  }
}, 20_000);
