/**
 * Taking back a reaction the adapter never saw (made before its window, or from another client) asks the server's
 * relations endpoint which of yours to redact. continuwuity (26.9) answers for a message with the relations of its
 * replies too (a reply counts as related to its parent there), so the answer is checked: only reactions to that
 * message go. Found by the composition parity suite (test/chat-parity/matrix-oracle.test.ts).
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import type { HubLink } from '@dither-chat/protocol/client';
import { MatrixAdapter } from '../src/adapter.ts';

const ME = '@me:x.test';
const ALICE = '@alice:x.test';
const ROOM = '!dm:x.test';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});

test("taking back a reaction asks the server, and leaves the same reaction on a reply alone", async () => {
  const redacted: string[] = [];
  let synced = false;
  const ev = (id: string, sender: string, ts: number, content: Record<string, unknown>, type = 'm.room.message') => ({ type, event_id: id, sender, origin_server_ts: ts, content });
  const member = (u: string) => ({ type: 'm.room.member', state_key: u, sender: u, event_id: `$m-${u}`, origin_server_ts: 1, content: { membership: 'join' } });
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const p = decodeURIComponent(new URL(req.url).pathname);
      const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
      if (p.endsWith('/account/whoami')) return json({ user_id: ME, device_id: 'DEV' });
      if (p.endsWith('/filter')) return json({ filter_id: '1' });
      if (p.endsWith('/sync')) {
        // One sync with the room, then nothing more: the next waits until the adapter stops.
        if (synced) return new Promise<Response>(() => {});
        synced = true;
        return json({
          next_batch: 's1',
          rooms: {
            join: {
              [ROOM]: {
                state: { events: [{ type: 'm.room.create', state_key: '', sender: ALICE, event_id: '$c', origin_server_ts: 1, content: { room_version: '10' } }, member(ME), member(ALICE)] },
                timeline: { events: [ev('$p', ALICE, 10, { msgtype: 'm.text', body: 'parent' }), ev('$r', ALICE, 20, { msgtype: 'm.text', body: 'reply', 'm.relates_to': { 'm.in_reply_to': { event_id: '$p' } } })] },
              },
            },
          },
        });
      }
      // continuwuity's answer for the parent: your reaction to it, and your reaction to its reply.
      if (p.endsWith('/relations/$p/m.annotation/m.reaction'))
        return json({
          chunk: [
            ev('$mine-on-r', ME, 5, { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$r', key: '👍' } }, 'm.reaction'),
            ev('$mine-on-p', ME, 4, { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$p', key: '👍' } }, 'm.reaction'),
          ],
        });
      const r = p.match(/\/redact\/([^/]+)\//);
      if (r) {
        redacted.push(r[1]!);
        return json({ event_id: `$redaction${redacted.length}` });
      }
      return json({ errcode: 'M_UNRECOGNIZED', error: p }, 404);
    },
  });
  const dir = mkdtempSync(join(tmpdir(), 'dither-matrix-relations-'));
  const secretFile = join(dir, 'secret.json');
  writeFileSync(secretFile, JSON.stringify({ accessToken: 'token' }), { mode: 0o600 });
  const events: P.AdapterEvent[] = [];
  let heard: () => void = () => {};
  const hub = {
    accountId: 'acc',
    accountDir: dir,
    config: { homeserver: `http://127.0.0.1:${server.port}` },
    label: '',
    emit: (e: P.AdapterEvent) => {
      events.push(e);
      heard();
    },
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
  // The reply has been read (it comes after its parent).
  while (!events.some((e) => e.t === 'message' && e.message.nativeId === '$r')) await new Promise<void>((r) => (heard = r));

  expect(await adapter.command({ t: 'react', id: '1', conversation: ROOM, message: '$p', key: '👍', remove: true })).toEqual({ removed: 1 });
  expect(redacted).toEqual(['$mine-on-p']);
});
