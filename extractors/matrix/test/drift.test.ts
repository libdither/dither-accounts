/**
 * Schema drift on Matrix (src/drift.ts): an event type, a content key, a rel_type and a bundled relation the
 * extractor does not map are each logged once by name, the message still arrives as it did, and no value of the
 * event (its body, the unknown field's value, ids) is in the log line, the summary or the status details.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import type { HubLink } from '@dither-chat/protocol/client';
import { SchemaWatch } from '@dither-accounts/manager/schema-drift';
import { MatrixAdapter } from '../src/adapter.ts';
import { watchTimelineEvent } from '../src/drift.ts';
import type { MxEvent } from '../src/rooms.ts';

const ME = '@me:x.test';
const ALICE = '@alice:x.test';
const ROOM = '!room:x.test';
const SECRET = 'secret-value-7f3a';

const msg = (id: string, content: Record<string, unknown>, extra: Partial<MxEvent> = {}): MxEvent => ({ type: 'm.room.message', event_id: id, sender: ALICE, origin_server_ts: 1000, content, ...extra });

test('known events pass without a sighting; unknown names are counted, never their values', () => {
  const logs: string[] = [];
  const w = new SchemaWatch({ log: (_l, m) => logs.push(m) });
  watchTimelineEvent(w, msg('$a', { msgtype: 'm.text', body: 'hello', 'm.relates_to': { rel_type: 'm.thread', event_id: '$root', is_falling_back: true, 'm.in_reply_to': { event_id: '$root' } }, 'm.mentions': {} }, { unsigned: { 'm.relations': { 'm.thread': {} } } }));
  watchTimelineEvent(w, { type: 'm.reaction', event_id: '$r', sender: ALICE, origin_server_ts: 1, content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$a', key: '👍' } } });
  expect(w.size).toBe(0);

  watchTimelineEvent(w, msg('$b', { msgtype: 'm.text', body: SECRET, 'org.example.new_field': SECRET, 'm.relates_to': { rel_type: 'org.example.rel', event_id: '$a' } }, { unsigned: { 'm.relations': { 'org.example.bundle': { body: SECRET } } } }));
  watchTimelineEvent(w, { type: 'org.example.widget', event_id: '$w', sender: ALICE, origin_server_ts: 1, content: { body: SECRET } });
  watchTimelineEvent(w, msg('$c', { msgtype: 'org.example.msgtype', body: SECRET }));
  const names = w.summary().unknown.map((e) => `${e.surface} ${e.name}`).sort();
  expect(names).toEqual(['matrix.event.content org.example.new_field', 'matrix.event.type org.example.widget', 'matrix.msgtype org.example.msgtype', 'matrix.rel_type org.example.rel', 'matrix.unsigned.relations org.example.bundle']);
  const all = JSON.stringify([logs, w.summary(), w.details()]);
  expect(all).not.toContain(SECRET);
  expect(all).not.toContain('$b');
  expect(all).not.toContain(ALICE);
});

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});

async function until(what: () => boolean, label: string) {
  for (let i = 0; i < 300; i++) {
    if (what()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

test('the adapter logs an unknown content key once and still sends the message', async () => {
  const queue: unknown[] = [];
  let wake: (() => void) | null = null;
  let batch = 0;
  const sync = (res: unknown) => {
    queue.push(res);
    wake?.();
  };
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const p = decodeURIComponent(new URL(req.url).pathname);
      const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
      if (p.endsWith('/account/whoami')) return json({ user_id: ME, device_id: 'TESTDEV' });
      if (p.endsWith('/filter')) return json({ filter_id: '1' });
      if (p.endsWith('/sync')) {
        if (!queue.length) await Promise.race([new Promise<void>((r) => (wake = r)), Bun.sleep(1000)]);
        wake = null;
        return json({ next_batch: `s${++batch}`, ...(queue.shift() as object) });
      }
      if (p.endsWith('/joined_members')) return json({ joined: { [ME]: {}, [ALICE]: {} } });
      if (p.endsWith('/threads')) return json({ chunk: [] });
      if (p.includes('/profile/')) return json({});
      if (p.match(/\/presence\/.+\/status$/)) return json({ presence: 'offline' });
      return json({ errcode: 'M_UNRECOGNIZED', error: 'no' }, 404);
    },
  });
  const dir = mkdtempSync(join(tmpdir(), 'dither-matrix-drift-'));
  const secretFile = join(dir, 'secret.json');
  writeFileSync(secretFile, JSON.stringify({ accessToken: 'token' }), { mode: 0o600 });
  const events: any[] = [];
  const hub = {
    accountId: 'acc',
    accountDir: dir,
    config: { homeserver: `http://127.0.0.1:${server.port}` },
    label: '',
    emit: (e: any) => events.push(e),
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
  const state = (type: string, content: Record<string, unknown>, key: string, id: string): MxEvent => ({ type, content, sender: ME, event_id: id, origin_server_ts: 1, state_key: key });
  const timeline = [msg('$m1', { msgtype: 'm.text', body: SECRET, 'org.example.new_field': { nested: SECRET } }), msg('$m2', { msgtype: 'm.text', body: 'again', 'org.example.new_field': 1 })];
  sync({ rooms: { join: { [ROOM]: { state: { events: [state('m.room.create', {}, '', '$c'), state('m.room.member', { membership: 'join' }, ME, '$j1'), state('m.room.member', { membership: 'join' }, ALICE, '$j2')] }, timeline: { events: timeline, prev_batch: 'p0' } } } } });
  const sent = () => events.filter((e) => e.t === 'message').map((e) => (e.message as P.MessageFact).nativeId);
  await until(() => sent().includes('$m2'), 'both messages');
  expect(sent()).toEqual(['$m1', '$m2']);
  const drift = events.filter((e) => e.t === 'log' && String(e.msg).startsWith('schema drift:'));
  expect(drift.map((e) => e.msg)).toEqual(['schema drift: unknown key "org.example.new_field" on "matrix.event.content"']);
  expect(adapter.drift.summary().unknown).toMatchObject([{ surface: 'matrix.event.content', name: 'org.example.new_field', kind: 'unknown_key', count: 2 }]);
  expect(JSON.stringify([drift, adapter.drift.summary()])).not.toContain(SECRET);
});
