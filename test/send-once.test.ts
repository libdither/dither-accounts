/**
 * SendOnce (packages/link once.ts), mail.send's idempotencyKey as each mail extractor keeps it: a key sends at most
 * once, also across the extractor's restarts (a new SendOnce on the same file); a key whose send may have gone is
 * refused `unsure`; one that surely did not go may try again.
 */
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StatusError } from '@dither-accounts/link';
import { KEEP_MS, SendOnce } from '@dither-accounts/link/once';

const dir = mkdtempSync(join(tmpdir(), 'dacc-sendonce-'));
let path: string;
let n = 0;
beforeEach(() => {
  path = join(dir, `send-keys-${++n}.json`);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A send that counts itself and answers its own number. */
function sender() {
  let sent = 0;
  return {
    get sent() {
      return sent;
    },
    send: async (sending: () => void) => {
      sending();
      sent++;
      return { messageId: `<m${sent}@example.com>`, sentId: `s${sent}` };
    },
  };
}

test('no key: sends every time; a key: once, the repeat answers the first answer, also after a restart', async () => {
  const s = sender();
  const once = new SendOnce(path);
  await once.run(undefined, s.send);
  await once.run(undefined, s.send);
  expect(s.sent).toBe(2);
  const first = await once.run('k-1', s.send);
  expect(first).toEqual({ messageId: '<m3@example.com>', sentId: 's3' });
  expect(await once.run('k-1', s.send)).toEqual(first);
  expect(await new SendOnce(path).run('k-1', s.send)).toEqual(first);
  expect(s.sent).toBe(3);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test('a repeat while the first still sends waits for its answer', async () => {
  let release!: () => void;
  let started!: () => void;
  const sending = new Promise<void>((r) => (started = r));
  let runs = 0;
  const once = new SendOnce(path);
  const slow = (handing: () => void) => {
    handing();
    runs++;
    started();
    return new Promise<{ ok: number }>((res) => (release = () => res({ ok: runs })));
  };
  const a = once.run('k', slow);
  const b = once.run('k', slow);
  await sending;
  const c = once.run('k', slow);
  release();
  expect(await Promise.all([a, b, c])).toEqual([{ ok: 1 }, { ok: 1 }, { ok: 1 }]);
  expect(runs).toBe(1);
});

test('started and never finished (the extractor stopped mid-send): refused unsure, nothing sent', async () => {
  const once = new SendOnce(path);
  void once.run('k', (sending) => {
    sending();
    return new Promise(() => {});
  });
  const s = sender();
  const e = await new SendOnce(path).run('k', s.send).catch((x) => x);
  expect(e).toBeInstanceOf(StatusError);
  expect([e.status, e.callCode]).toEqual([504, 'unsure']);
  expect(s.sent).toBe(0);
});

test('a failure after the send was handed over that may have sent keeps the key: unsure; a refusal (4xx) forgets it', async () => {
  const once = new SendOnce(path);
  const timedOut = (sending: () => void) => {
    sending();
    return Promise.reject(new StatusError('no answer in time', 504));
  };
  await expect(once.run('k-504', timedOut)).rejects.toMatchObject({ status: 504 });
  const s = sender();
  await expect(once.run('k-504', s.send)).rejects.toMatchObject({ status: 504, callCode: 'unsure' });
  // A plain error after the hand-over may have sent too.
  await expect(once.run('k-err', (sending) => (sending(), Promise.reject(new Error('socket closed'))))).rejects.toThrow('socket closed');
  await expect(once.run('k-err', s.send)).rejects.toMatchObject({ callCode: 'unsure' });
  // Refused outright: nothing went, the same key may send.
  await expect(once.run('k-422', (sending) => (sending(), Promise.reject(new StatusError('recipient refused', 422, 'recipients'))))).rejects.toMatchObject({ status: 422 });
  expect(await once.run('k-422', s.send)).toEqual({ messageId: '<m1@example.com>', sentId: 's1' });
  expect(s.sent).toBe(1);
});

test('a failure before the hand-over forgets the key, whatever it was; `unknown` decides for a send that cannot say', async () => {
  const once = new SendOnce(path);
  const s = sender();
  await expect(once.run('k', () => Promise.reject(new StatusError('the page is not up', 503)))).rejects.toMatchObject({ status: 503 });
  await expect(once.run('k', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  expect(await once.run('k', s.send)).toMatchObject({ sentId: 's1' });
  // Gmail's way: 504 may have sent, anything else did not.
  const unknown = (e: unknown) => !(e instanceof StatusError) || e.status === 504;
  await expect(once.run('g', () => Promise.reject(new StatusError('late; in Drafts', 502)), { unknown })).rejects.toMatchObject({ status: 502 });
  expect(await once.run('g', s.send, { unknown })).toMatchObject({ sentId: 's2' });
  await expect(once.run('g2', () => Promise.reject(new StatusError('may have sent', 504)), { unknown })).rejects.toMatchObject({ status: 504 });
  await expect(once.run('g2', s.send, { unknown })).rejects.toMatchObject({ callCode: 'unsure' });
  expect(s.sent).toBe(2);
});

test('done but its answer not kept: duplicate (409); keys go after 7 days; a bad key is 400 and sends nothing', async () => {
  let now = 1_000_000;
  const s = sender();
  writeFileSync(path, JSON.stringify({ v: 1, keys: { old: { at: now, state: 'done' } } }), { mode: 0o600 });
  const once = new SendOnce(path, () => now);
  await expect(once.run('old', s.send)).rejects.toMatchObject({ status: 409, callCode: 'duplicate' });
  expect(s.sent).toBe(0);
  now += KEEP_MS;
  expect(await once.run('old', s.send)).toMatchObject({ sentId: 's1' });
  expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')).keys)).toEqual(['old']);
  for (const bad of ['', 3, 'x'.repeat(201)]) await expect(once.run(bad, s.send)).rejects.toMatchObject({ status: 400 });
  expect(s.sent).toBe(1);
});
