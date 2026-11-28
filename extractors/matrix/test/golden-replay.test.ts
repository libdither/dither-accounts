/**
 * The golden fixtures in golden/ are real /sync responses from a continuwuity testbed (anonymized; made by
 * `bun scripts/capture-fixtures.ts matrix-golden`), one file per scenario: a send, then edits, reactions, replies and
 * redactions on it. This replays each through the adapter against a fake homeserver that hands them out in order, and
 * checks what the hub ends up with: one message per send, its latest text, who reacted, what it replies to, what was
 * deleted. No server needed.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import type { HubLink } from '@dither-chat/protocol/client';
import { assertNoConcreteLeaks } from '@dither-accounts/manager/wire-capture';
import { MatrixAdapter } from '../src/adapter.ts';

const GOLDEN = join(import.meta.dir, 'golden');

interface Golden {
  scenario: string;
  self: string;
  room: string;
  steps: { do: string; by: string; event: string; target?: string; body?: string; key?: string; reason?: string }[];
  syncs: { after: string; response: any }[];
}

const load = (name: string): Golden => JSON.parse(readFileSync(join(GOLDEN, `${name}.json`), 'utf8'));

/** The time the server gave an event, from the fixture's own syncs. */
function tsOf(g: Golden, id: string): number {
  for (const s of g.syncs) for (const room of Object.values<any>(s.response.rooms?.join ?? {})) for (const e of room.timeline?.events ?? []) if (e.event_id === id) return e.origin_server_ts;
  throw new Error(`${id} is not in ${g.scenario}`);
}

/** A homeserver that answers the adapter's first sync with the fixture's first response, each next one (asked with
 * the batch token before it) with the next, and holds the request after the last. */
function replayHomeserver(g: Golden) {
  let served = 0;
  const wrongSince: string[] = [];
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  let caughtUp!: () => void;
  const allServed = new Promise<void>((r) => (caughtUp = r));
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const u = new URL(req.url);
      const p = decodeURIComponent(u.pathname);
      const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
      if (p.endsWith('/account/whoami')) return json({ user_id: g.self, device_id: 'GOLDENDEV' });
      if (p.endsWith('/filter')) return json({ filter_id: 'golden' });
      if (p.endsWith('/sync')) {
        // The invites snapshot (an inline filter, no since) is not part of the trace.
        if (u.searchParams.get('filter')?.startsWith('{')) return json({ next_batch: 'invites', rooms: {} });
        if (served < g.syncs.length) {
          const want = served === 0 ? null : g.syncs[served - 1].response.next_batch;
          if (u.searchParams.get('since') !== want) wrongSince.push(`${served}: ${u.searchParams.get('since')} instead of ${want}`);
          return json(g.syncs[served++].response);
        }
        // Asked for the one after the last: every response in the trace has been read.
        caughtUp();
        await Promise.race([released, Bun.sleep(30_000)]);
        return json({ next_batch: g.syncs.at(-1)!.response.next_batch });
      }
      if (p.endsWith('/joined_members')) return json({ joined: {} });
      if (p.endsWith('/threads')) return json({ chunk: [] });
      if (p.includes('/presence/')) return json({ presence: 'offline' });
      return json({ errcode: 'M_UNRECOGNIZED', error: 'not in the golden trace' }, 404);
    },
  });
  return { server, wrongSince, allServed, release };
}

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});

async function replay(g: Golden) {
  const hs = replayHomeserver(g);
  const dir = mkdtempSync(join(tmpdir(), 'dither-matrix-golden-'));
  const secretFile = join(dir, 'secret.json');
  writeFileSync(secretFile, JSON.stringify({ accessToken: 'golden-token' }), { mode: 0o600 });
  const events: P.AdapterEvent[] = [];
  const hub = {
    accountId: 'acc',
    accountDir: dir,
    config: { homeserver: `http://127.0.0.1:${hs.server.port}` },
    label: '',
    emit: (e: P.AdapterEvent) => events.push(e),
    log: () => {},
    secret: () => JSON.parse(readFileSync(secretFile, 'utf8')),
    saveSecret: (v: unknown) => writeFileSync(secretFile, JSON.stringify(v), { mode: 0o600 }),
    connected: true,
    close: () => {},
  } as unknown as HubLink;
  const adapter = new MatrixAdapter();
  adapter.start(hub);
  cleanup.push(async () => {
    hs.release();
    await adapter.shutdown();
    hs.server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });
  // The adapter reads a sync whole before it asks for the next, so the ask after the last means all were read.
  await hs.allServed;
  expect(hs.wrongSince).toEqual([]);
  return events;
}

interface Converged {
  id: string;
  author: string;
  body: string;
  editedTs?: number;
  replyTo?: string;
  deleted?: true;
  reactions?: Record<string, string[]>;
}

/** What a hub holds after these events: each message as last sent, deletions, and who reacts with what. */
function converge(events: P.AdapterEvent[], room: string): Converged[] {
  const msgs = new Map<string, P.MessageFact>();
  const deleted = new Set<string>();
  const reactions = new Map<string, Map<string, Set<string>>>();
  for (const e of events) {
    if (e.t === 'message' && e.message.conversation === room) msgs.set(e.message.nativeId, e.message);
    else if (e.t === 'delete' && e.conversation === room) deleted.add(e.nativeId);
    else if (e.t === 'reaction' && e.conversation === room) {
      const byKey = reactions.get(e.message) ?? reactions.set(e.message, new Map()).get(e.message)!;
      const who = byKey.get(e.key) ?? byKey.set(e.key, new Set()).get(e.key)!;
      if (e.remove) who.delete(e.author);
      else who.add(e.author);
    }
  }
  return [...msgs.values()].map((m) => {
    const out: Converged = { id: m.nativeId, author: m.author, body: m.body };
    if (m.editedTs !== undefined) out.editedTs = m.editedTs;
    if (m.replyTo) out.replyTo = m.replyTo;
    if (deleted.has(m.nativeId)) out.deleted = true;
    const r = [...(reactions.get(m.nativeId) ?? [])].filter(([, who]) => who.size);
    if (r.length) out.reactions = Object.fromEntries(r.map(([k, who]) => [k, [...who].sort()]));
    return out;
  });
}

describe('golden Matrix traces', () => {
  test('every fixture is anonymized and passes the leak guard', () => {
    const files = readdirSync(GOLDEN).filter((f) => f.endsWith('.json'));
    expect(files.sort()).toEqual(['send-edit-edit.json', 'send-edit-react-unreact.json', 'send-edit-redact.json', 'send-edit-reply.json']);
    for (const f of files) {
      const text = readFileSync(join(GOLDEN, f), 'utf8');
      assertNoConcreteLeaks(text);
      expect(text).not.toContain('dither.test');
      const g = JSON.parse(text) as Golden;
      expect(g.self).toBe('@quinn:example.test');
      // The trace is whole: the setup sync, then at least one sync after each step, the step's event in the last.
      expect(g.syncs[0].after).toBe('setup');
      for (const [i, s] of g.steps.entries()) {
        expect(() => tsOf(g, s.event)).not.toThrow();
        expect(g.syncs.some((x) => x.after === String(i))).toBe(true);
      }
    }
  });

  test('send → edit → edit: one message, with the last edit’s text and time', async () => {
    const g = load('send-edit-edit');
    const [send, , edit2] = g.steps;
    const events = await replay(g);
    expect(converge(events, g.room)).toEqual([{ id: send.event, author: '@alice:example.test', body: 'golden: final draft', editedTs: tsOf(g, edit2.event) }]);
    // The send arrived live, and each edit re-sent the same message, live too.
    const facts = events.filter((e): e is Extract<P.AdapterEvent, { t: 'message' }> => e.t === 'message' && e.message.nativeId === send.event);
    expect(facts.map((e) => [e.message.body, e.live])).toEqual([
      ['golden: first draft', true],
      ['golden: second draft', true],
      ['golden: final draft', true],
    ]);
    // The edits are no messages of their own.
    expect(events.some((e) => e.t === 'message' && g.steps.slice(1).some((s) => s.event === e.message.nativeId))).toBe(false);
  });

  test('send → edit → react → unreact: the edited text stays, the reaction comes and goes', async () => {
    const g = load('send-edit-react-unreact');
    const [send, edit, react] = g.steps;
    const events = await replay(g);
    expect(converge(events, g.room)).toEqual([{ id: send.event, author: '@alice:example.test', body: 'golden: lunch at one?', editedTs: tsOf(g, edit.event) }]);
    const rx = events.filter((e) => e.t === 'reaction');
    expect(rx).toEqual([
      { t: 'reaction', conversation: g.room, message: send.event, author: '@bob:example.test', key: '👍', ts: tsOf(g, react.event) },
      { t: 'reaction', conversation: g.room, message: send.event, author: '@bob:example.test', key: '👍', remove: true, ts: tsOf(g, g.steps[3].event) },
    ]);
    expect(events.some((e) => e.t === 'delete')).toBe(false);
  });

  test('send → edit → reply: the reply points at the edited message, which keeps its new text', async () => {
    const g = load('send-edit-reply');
    const [send, edit, reply] = g.steps;
    const events = await replay(g);
    expect(converge(events, g.room)).toEqual([
      { id: send.event, author: '@alice:example.test', body: 'golden: the build is green again', editedTs: tsOf(g, edit.event) },
      { id: reply.event, author: '@quinn:example.test', body: 'golden: nice, thanks', replyTo: send.event },
    ]);
    // The self user's own reply came back through sync like anyone's, without a mention of itself.
    const own = events.find((e): e is Extract<P.AdapterEvent, { t: 'message' }> => e.t === 'message' && e.message.nativeId === reply.event)!;
    expect(own.message.mentionsSelf).toBeUndefined();
  });

  test('send → edit → redact: the message ends deleted, and the edit stays no message of its own', async () => {
    const g = load('send-edit-redact');
    const [send, edit] = g.steps;
    const events = await replay(g);
    expect(converge(events, g.room)).toEqual([{ id: send.event, author: '@bob:example.test', body: 'golden: wrong room, sorry!', editedTs: tsOf(g, edit.event), deleted: true }]);
    expect(events.filter((e) => e.t === 'delete')).toEqual([{ t: 'delete', conversation: g.room, nativeId: send.event }]);
  });
});
