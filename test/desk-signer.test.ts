/**
 * The desk signer (apps/desk-signer) against a real manager: `pair` and `status` as a command (keys made, kept as
 * PKCS8 in a 0700 directory, files 0600), then the signer's link: it sends its keys as a `desk`, keeps the approve
 * requests it is sent, and signs only on an intent, after the presence check (a fake command standing in for
 * fprintd-verify, told by a file whether the finger matches): a match signs, a mismatch answers an error and keeps the
 * request, an action that needs no signature is answered without the check, and it never answers on its own.
 * Port 0, temp dirs, no network.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { answerText, askText, displayHash, fingerprint, messageHash, sha256hex, verifySignature } from '@dither-accounts/approval';
import { AccountsClient, register } from '@dither-accounts/client';
import { type ApprovalAnswer, type ApprovalDisplay, approvals } from '@dither-accounts/interfaces';
import { createManager, type Manager } from '@dither-accounts/manager';
import { DeskSigner, load, presence } from '../apps/desk-signer/src/signer.ts';

const MAIN = resolve(import.meta.dir, '../apps/desk-signer/src/main.ts');
let m: Manager;
let dir: string;
let state: string;
let app: AccountsClient;
const got: Record<string, any>[] = [];
let signer: DeskSigner;
const frames: { dir: 'in' | 'out'; m: Record<string, any> }[] = [];
/** The fake presence check reads `finger` (match / no-match) and appends a line to `checks` each time it runs. */
let finger: string;
let checks: string;
const FAKE_VERIFY = `const fs = require('fs'); fs.appendFileSync(process.argv[2], process.argv[3] + '\\n'); const f = fs.readFileSync(process.argv[1], 'utf8').trim(); if (f === 'match') { console.log('Verify result: verify-match (done)'); process.exit(0); } console.log('Verify result: verify-no-match (done)'); process.exit(1);`;

const until = async (f: () => boolean | Promise<boolean>, ms = 8000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await f()) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const api = async <T = any>(path: string, method = 'GET', body?: unknown): Promise<T> => (await (await fetch(m.url + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })).json()) as T;
const answersFor = (id: string) => got.filter((e) => e.t === 'approvals.answer' && e.id === id) as (ApprovalAnswer & { t: string })[];
const checksRun = () => readFileSync(checks, 'utf8').split('\n').filter(Boolean);
/** The command, run as its own process (not spawnSync: the manager answering it runs in this one). */
const cli = async (args: string[], env: Record<string, string> = {}) => {
  const p = Bun.spawn([process.execPath, MAIN, ...args], { env: { ...process.env, DESK_SIGNER_STATE: state, ...env }, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
};

let n = 0;
function request(o: { expiresIn?: number; actions?: ApprovalDisplay['actions'] } = {}) {
  n++;
  const id = `apv_${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url')}`;
  const now = Date.now();
  const display: ApprovalDisplay = {
    kind: 'rebuild',
    asker: 'nrb',
    title: `Rebuild laptop (${n})`,
    body: 'closure: +2 -1 paths',
    payload: `dither-rebuild-v1\nhost laptop\nrunning ${'e'.repeat(40)}\ndiff-sha256 ${'f'.repeat(64)}\nsystem /nix/store/example-nixos-system\n`,
    urgency: 'high',
    actions: o.actions ?? [
      { id: 'approve', label: 'Approve', needs: 'signed' },
      { id: 'deny', label: 'Deny', needs: 'any' },
    ],
  };
  const expires = now + (o.expiresIn ?? 60_000);
  const ask = askText({ id, kind: display.kind, asker: display.asker, created: now, expires, payloadSha256: sha256hex(display.payload), displaySha256: displayHash(display.title, display.body) });
  return { id, ask, display, expiresAt: expires };
}
/** The signer has checked and kept this request. */
const held = (id: string) => until(() => signer.requests.has(id), 4000, `the signer holds ${id}`);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dacc-desk-'));
  state = join(dir, 'signer-state');
  finger = join(dir, 'finger');
  checks = join(dir, 'checks');
  writeFileSync(finger, 'match');
  writeFileSync(checks, '');
  m = await createManager({ openPage: true, dataDir: join(dir, 'manager'), port: 0, kinds: new Map() });
  const reg = await register(m.url, { name: 'hub-test', requests: [{ interface: 'approvals', level: 'write', accounts: ['approver'] }] });
  const st = await api('/api/state');
  for (const x of st.apps) for (const r of x.requests) if (r.state === 'pending') await api(`/api/requests/${r.id}/approve`, 'POST', {});
  app = new AccountsClient({ url: m.url, app: reg.app, token: reg.token, onEvents: (account, evs) => account === 'approver' && got.push(...(evs as Record<string, any>[])) });
  await until(() => app.connected, 15_000, 'the app connected');
}, 30_000);
afterAll(async () => {
  signer?.stop();
  app?.close();
  await m?.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('pair: keys made and kept private, the device paired; status shows both fingerprints', async () => {
  const p = await api<{ link: string }>('/api/approvers/pair', 'POST');
  expect((await cli(['pair'])).code).toBe(64);
  const r = await cli(['pair', p.link, '--url', m.url, '--name', 'Test desk']);
  expect(r.err).toBe('');
  expect(r.code).toBe(0);
  expect(statSync(state).mode & 0o777).toBe(0o700);
  expect(readdirSync(state).sort()).toEqual(['approval.pk8', 'device.json', 'identity.pk8']);
  for (const f of readdirSync(state)) expect(statSync(join(state, f)).mode & 0o777).toBe(0o600);
  const device = JSON.parse(readFileSync(join(state, 'device.json'), 'utf8'));
  expect(device.deviceId).toMatch(/^dev_/);
  expect(device).toMatchObject({ url: m.url, name: 'Test desk' });
  expect(r.out).toContain(fingerprint(device.approvalKey));
  const st = await api('/api/approvers');
  expect(st.devices).toMatchObject([{ id: device.deviceId, name: 'Test desk', fingerprint: fingerprint(device.publicKey), kind: null }]);
  // Twice: refused without --force; and a used code is refused by the manager.
  expect((await cli(['pair', p.link, '--url', m.url])).code).toBe(1);
  const s = await cli(['status']);
  expect(s.code).toBe(0);
  expect(s.out).toContain(device.deviceId);
  expect(s.out).toContain(fingerprint(device.publicKey));
  expect(s.out).toContain(fingerprint(device.approvalKey));
  expect(s.out).toContain('(private)');
  // run needs whose finger counts.
  expect((await cli(['run'])).code).toBe(64);
}, 20_000);

test('run: it links as a desk and sends its approval key', async () => {
  const st = await load(state);
  signer = new DeskSigner(st, { user: 'alice', verify: [process.execPath, '-e', FAKE_VERIFY, finger, checks, '{user}'], log: () => {}, onFrame: (d, x) => frames.push({ dir: d, m: x }) });
  signer.start();
  await until(() => m.approvers.keyedOnline(st.device.deviceId), 8000, 'the signer keyed');
  expect((await app.call(approvals, 'approver', 'approvals.devices', {})).devices).toEqual([{ id: st.device.deviceId, name: 'Test desk', kind: 'desk', approvalKey: st.device.approvalKey, fingerprint: fingerprint(st.device.approvalKey), online: true }]);
}, 20_000);

test('an intent with a matching finger: checked, signed with the approval key, answered', async () => {
  const st = await load(state);
  const r = request();
  expect(await app.call(approvals, 'approver', 'approvals.ask', r)).toEqual({ devices: 1 });
  await held(r.id);
  // It never answers on its own.
  expect(frames.some((f) => f.dir === 'out' && f.m.t === 'response' && f.m.id === r.id)).toBe(false);
  expect(await app.call(approvals, 'approver', 'approvals.intent', { id: r.id, action: 'approve', message: 'go ahead' })).toEqual({ sent: 1 });
  await until(() => answersFor(r.id).length > 0, 8000, 'the answer');
  const ev = answersFor(r.id)[0]!;
  expect(ev).toMatchObject({ id: r.id, ok: true, action: 'approve', message: 'go ahead', device: st.device.deviceId, deviceName: 'Test desk', deviceKind: 'desk' });
  if (!ev.ok) throw new Error('not ok');
  const statement = r.ask + answerText({ action: 'approve', messageSha256: messageHash('go ahead'), device: st.device.deviceId, signed: ev.signed });
  expect(ev.statement).toBe(statement);
  expect(await verifySignature(st.device.approvalKey, statement, ev.signature!)).toBe(true);
  expect(checksRun()).toEqual(['alice']);
  expect(signer.requests.has(r.id)).toBe(false);
}, 20_000);

test('a finger that does not match: an error answer, nothing signed, the request still held; then a match signs', async () => {
  const r = request();
  await app.call(approvals, 'approver', 'approvals.ask', r);
  await held(r.id);
  writeFileSync(finger, 'no-match');
  writeFileSync(checks, '');
  await app.call(approvals, 'approver', 'approvals.intent', { id: r.id, action: 'approve' });
  await until(() => answersFor(r.id).length > 0, 8000, 'the error');
  expect(answersFor(r.id)).toEqual([{ t: 'approvals.answer', id: r.id, ok: false, reason: 'error', message: 'the finger did not match', device: signer['st'].device.deviceId, deviceName: 'Test desk' } as any]);
  expect(frames.some((f) => f.dir === 'out' && f.m.id === r.id && f.m.signature)).toBe(false);
  expect(signer.requests.has(r.id)).toBe(true);
  expect(checksRun()).toEqual(['alice']);
  // Tried again.
  writeFileSync(finger, 'match');
  expect(await app.call(approvals, 'approver', 'approvals.intent', { id: r.id, action: 'approve' })).toEqual({ sent: 1 });
  await until(() => answersFor(r.id).length > 1, 8000, 'the signed answer');
  expect(answersFor(r.id)[1]).toMatchObject({ ok: true, action: 'approve', deviceKind: 'desk', signature: expect.any(String) });
  expect(checksRun()).toEqual(['alice', 'alice']);
}, 20_000);

test('an action that needs no signature is answered without the fingerprint', async () => {
  writeFileSync(checks, '');
  const r = request();
  await app.call(approvals, 'approver', 'approvals.ask', r);
  await held(r.id);
  await app.call(approvals, 'approver', 'approvals.intent', { id: r.id, action: 'deny', message: null });
  await until(() => answersFor(r.id).length > 0, 8000, 'the answer');
  expect(answersFor(r.id)[0]).toMatchObject({ ok: true, action: 'deny', message: null, deviceKind: 'desk' });
  expect('signature' in answersFor(r.id)[0]!).toBe(false);
  expect(checksRun()).toEqual([]);
}, 20_000);

test('a cancelled request is dropped by the signer; a bad request is refused, not kept', async () => {
  const r = request();
  await app.call(approvals, 'approver', 'approvals.ask', r);
  await held(r.id);
  await app.call(approvals, 'approver', 'approvals.cancel', { id: r.id });
  await until(() => !signer.requests.has(r.id), 4000, 'dropped');
  expect(((await app.call(approvals, 'approver', 'approvals.intent', { id: r.id, action: 'approve' }).catch((e) => e)) as { code: string }).code).toBe('invalid');
}, 20_000);

test('presence: a timeout and a missing command are no match', async () => {
  expect(await presence([process.execPath, '-e', 'setTimeout(() => {}, 10000)'], 'alice', 200)).toEqual({ ok: false, why: 'no finger within 0 s' });
  expect((await presence(['/nonexistent/fprintd-verify', '{user}'], 'alice')).ok).toBe(false);
  // Exit 0 without a match is not a match either.
  expect((await presence([process.execPath, '-e', 'console.log("Verify started")'], 'alice')).ok).toBe(false);
}, 20_000);
