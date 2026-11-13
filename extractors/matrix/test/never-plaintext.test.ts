/**
 * The invariant: nothing readable by the server ever goes to an encrypted room. The adapter runs
 * against a fake homeserver that records every write, with crypto off, and with it on but failing.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HubLink } from '@dither-chat/protocol/client';
import { MatrixAdapter } from '../src/adapter.ts';

const ENCRYPTED = '!encrypted:fake.test';
const WEIRD = '!unknown-algorithm:fake.test';
const DOWNGRADED = '!downgraded:fake.test';
const PLAIN = '!plain:fake.test';
const ME = '@me:fake.test';
const SECRET_TEXT = 'THE SECRET TEXT';

const state = (type: string, content: unknown, key = '', id = `$${type}${Math.random()}`) => ({ type, state_key: key, content, event_id: id, sender: ME, origin_server_ts: 1 });
const roomState = (encryption: unknown) => ({ state: { events: [state('m.room.create', {}), state('m.room.member', { membership: 'join' }, ME), ...(encryption ? [state('m.room.encryption', encryption)] : [])] }, timeline: { events: [] } });

type Fail = 'members' | 'keysQuery' | null;

function fakeHomeserver(fail: Fail = null) {
  const writes: { method: string; path: string; body: string }[] = [];
  let synced = 0;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      const body = req.method === 'GET' ? '' : await req.text();
      const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
      if (p.endsWith('/account/whoami')) return json({ user_id: ME, device_id: 'TESTDEV' });
      if (p.includes('/profile/')) return json({});
      if (p.endsWith('/filter')) return json({ filter_id: '1' });
      if (p.endsWith('/sync')) {
        synced++;
        if (synced === 1) {
          return json({
            next_batch: 's1',
            rooms: {
              join: {
                [ENCRYPTED]: roomState({ algorithm: 'm.megolm.v1.aes-sha2' }),
                [WEIRD]: roomState({ algorithm: 'm.something.else' }),
                [PLAIN]: roomState(null),
                [DOWNGRADED]: roomState({ algorithm: 'm.megolm.v1.aes-sha2' }),
              },
            },
          });
        }
        if (synced === 2) return json({ next_batch: 's2', rooms: { join: { [DOWNGRADED]: { state: { events: [state('m.room.encryption', {})] }, timeline: { events: [] } } } } });
        await Bun.sleep(50);
        return json({ next_batch: `s${synced}` });
      }
      if (p.endsWith('/joined_members')) return json({ joined: { [ME]: {} } });
      if (p.endsWith('/members')) return fail === 'members' ? json({ errcode: 'M_FORBIDDEN', error: 'no' }, 403) : json({ chunk: [state('m.room.member', { membership: 'join' }, ME)] });
      if (p.endsWith('/threads')) return json({ chunk: [] });
      if (p.endsWith('/keys/query')) {
        if (fail === 'keysQuery' && body.includes('device_keys') && !body.includes('TESTDEV')) return json({ errcode: 'M_UNKNOWN', error: 'down' }, 403);
        return json({ device_keys: { [ME]: {} }, failures: {} });
      }
      if (p.endsWith('/keys/upload')) return json({ one_time_key_counts: { signed_curve25519: 50 } });
      if (p.endsWith('/keys/claim')) return json({ one_time_keys: {}, failures: {} });
      if (p.includes('/room_keys/version')) return json({ errcode: 'M_NOT_FOUND', error: 'none' }, 404);
      if (p.includes('/rooms/') && (p.includes('/send/') || p.includes('/state/'))) {
        writes.push({ method: req.method, path: decodeURIComponent(p), body });
        return json({ event_id: '$sent' });
      }
      if (p.includes('/media/') && p.endsWith('/upload')) {
        writes.push({ method: req.method, path: p, body });
        return json({ content_uri: 'mxc://fake.test/uploaded' });
      }
      return json({ errcode: 'M_UNRECOGNIZED', error: p }, 404);
    },
  });
  return { server, writes };
}

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});

async function startAdapter(fail: Fail, e2ee: boolean) {
  const { server, writes } = fakeHomeserver(fail);
  const dir = mkdtempSync(join(tmpdir(), 'dither-never-plaintext-'));
  const secretFile = join(dir, 'secret.json');
  writeFileSync(secretFile, JSON.stringify({ accessToken: 'token', ...(e2ee ? { e2ee: { on: true, storeKey: Buffer.alloc(32, 7).toString('base64') } } : {}) }), { mode: 0o600 });
  const events: any[] = [];
  const hub = {
    accountId: 'acc',
    accountDir: dir,
    config: { homeserver: `http://127.0.0.1:${server.port}` },
    label: '',
    emit: (ev: any) => events.push(ev),
    log: () => {},
    secret: () => JSON.parse(readFileSync(secretFile, 'utf8')),
    saveSecret: (v: unknown) => writeFileSync(secretFile, JSON.stringify(v), { mode: 0o600 }),
    connected: true,
    close: () => {},
  } as unknown as HubLink;
  const adapter = new MatrixAdapter();
  adapter.start(hub);
  cleanup.push(async () => {
    await adapter.shutdown();
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 200 && !events.some((e) => e.t === 'conversation' && e.conversation.nativeId === DOWNGRADED); i++) await Bun.sleep(25);
  await Bun.sleep(200); // the second sync, with the downgrade
  const spool = join(dir, 'f.txt');
  writeFileSync(spool, SECRET_TEXT);
  const attachment = { path: spool, name: SECRET_TEXT, mime: 'text/plain', size: SECRET_TEXT.length, kind: 'file' };
  return { adapter, writes, events, attachment };
}

const everyWrite = (room: string, attachment: unknown) => [
  { t: 'send', id: '1', conversation: room, body: SECRET_TEXT },
  { t: 'send', id: '2', conversation: room, body: SECRET_TEXT, attachments: [attachment] },
  { t: 'send', id: '3', conversation: `${room}|$root`, body: SECRET_TEXT },
  { t: 'edit', id: '4', conversation: room, message: '$old', body: SECRET_TEXT },
  { t: 'react', id: '5', conversation: room, message: '$old', key: SECRET_TEXT },
];

const leaked = (writes: { path: string; body: string }[]) => writes.filter((w) => w.path.includes('/media/') || w.body.includes(SECRET_TEXT) || (w.path.includes('/send/') && !w.path.includes('/send/m.room.encrypted/')));

describe('nothing goes to an encrypted room in plaintext', () => {
  test('crypto off: every kind of write is refused, and pointed at the setup', async () => {
    const { adapter, writes, attachment } = await startAdapter(null, false);
    for (const room of [ENCRYPTED, DOWNGRADED, WEIRD]) {
      for (const cmd of everyWrite(room, attachment)) await expect(adapter.command(cmd as any)).rejects.toThrow(/Set up encryption/);
    }
    expect(writes).toEqual([]);
  });

  test('crypto off: unencrypted rooms still work', async () => {
    const { adapter, writes } = await startAdapter(null, false);
    await adapter.command({ t: 'send', id: '1', conversation: PLAIN, body: 'hello' } as any);
    expect(writes.length).toBe(1);
    expect(writes[0].path).toContain('/send/m.room.message/');
  });

  test('crypto off: an encrypted attachment is not served as ciphertext', async () => {
    const { adapter } = await startAdapter(null, false);
    await expect(adapter.command({ t: 'fetchMedia', id: '1', url: 'mxc://fake.test/x#$event' } as any)).rejects.toThrow(/encrypted/);
  });

  test('crypto on but the member list fails: refused, no fallback', async () => {
    const { adapter, writes, attachment, events } = await startAdapter('members', true);
    expect(events.some((e) => e.t === 'hello' && e.capabilities.includes('e2ee'))).toBe(true);
    for (const cmd of everyWrite(ENCRYPTED, attachment).filter((c) => !('attachments' in c))) await expect(adapter.command(cmd as any)).rejects.toThrow();
    expect(leaked(writes)).toEqual([]);
  });

  test('crypto on but device lists fail: refused, no fallback', async () => {
    const { adapter, writes, attachment } = await startAdapter('keysQuery', true);
    for (const cmd of everyWrite(ENCRYPTED, attachment).filter((c) => !('attachments' in c))) await expect(adapter.command(cmd as any)).rejects.toThrow();
    expect(leaked(writes)).toEqual([]);
  });

  test('crypto on: a room with an algorithm we do not have refuses', async () => {
    const { adapter, writes } = await startAdapter(null, true);
    await expect(adapter.command({ t: 'send', id: '1', conversation: WEIRD, body: SECRET_TEXT } as any)).rejects.toThrow(/algorithm/);
    expect(leaked(writes)).toEqual([]);
  });

  test('crypto on: a state event that seems to turn encryption off changes nothing', async () => {
    const { adapter, writes } = await startAdapter(null, true);
    await adapter.command({ t: 'send', id: '1', conversation: DOWNGRADED, body: SECRET_TEXT } as any);
    expect(writes.length).toBe(1);
    expect(writes[0].path).toContain('/send/m.room.encrypted/');
    expect(leaked(writes)).toEqual([]);
  });

  test('crypto on: files go up as ciphertext, without their name or type', async () => {
    const { adapter, writes, attachment } = await startAdapter(null, true);
    await adapter.command({ t: 'send', id: '1', conversation: ENCRYPTED, body: '', attachments: [attachment] } as any);
    const upload = writes.find((w) => w.path.includes('/media/'))!;
    expect(upload.body).not.toContain(SECRET_TEXT);
    expect(upload.path).not.toContain('f.txt');
    expect(writes.filter((w) => w.path.includes('/send/m.room.encrypted/')).length).toBe(1);
    expect(leaked(writes.filter((w) => !w.path.includes('/media/')))).toEqual([]);
  });

  test('a store that cannot open leaves the account up, and encrypted rooms refuse', async () => {
    const { server, writes } = fakeHomeserver();
    const dir = mkdtempSync(join(tmpdir(), 'dither-never-plaintext-'));
    const secretFile = join(dir, 'secret.json');
    writeFileSync(secretFile, JSON.stringify({ accessToken: 'token', e2ee: { on: true, storeKey: 'too short' } }));
    const events: any[] = [];
    const hub = { accountId: 'acc', accountDir: dir, config: { homeserver: `http://127.0.0.1:${server.port}` }, label: '', emit: (ev: any) => events.push(ev), log: () => {}, secret: () => JSON.parse(readFileSync(secretFile, 'utf8')), saveSecret: () => {}, connected: true, close: () => {} } as unknown as HubLink;
    const adapter = new MatrixAdapter();
    adapter.start(hub);
    cleanup.push(async () => {
      await adapter.shutdown();
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    });
    for (let i = 0; i < 200 && !events.some((e) => e.t === 'conversation' && e.conversation.nativeId === ENCRYPTED); i++) await Bun.sleep(25);
    await expect(adapter.command({ t: 'send', id: '1', conversation: ENCRYPTED, body: SECRET_TEXT } as any)).rejects.toThrow(/not working/);
    await adapter.command({ t: 'send', id: '2', conversation: PLAIN, body: 'fine' } as any);
    expect(writes.filter((w) => w.path.includes(ENCRYPTED))).toEqual([]);
    expect(writes.length).toBe(1);
  });
});
