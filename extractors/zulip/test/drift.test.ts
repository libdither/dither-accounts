/**
 * Schema drift on Zulip (src/drift.ts): an event type, an op and a message key Zulip does not document yet are each
 * logged once by name; the message still arrives, and no value (its words, the new field's value) is in the log,
 * the summary or the status details.
 */
import { afterEach, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { SchemaWatch } from '@dither-accounts/manager/schema-drift';
import { ZulipAdapter } from '../src/adapter.ts';
import { watchEvent, watchMessage } from '../src/drift.ts';
import { fakeZulip } from './fake-zulip.ts';
import { testLink } from './link.ts';

const SECRET = 'secret-words-4c1d';

let stops: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const s of stops.reverse()) await s();
  stops = [];
});

test('documented types, ops and message keys pass; others are counted by name', () => {
  const w = new SchemaWatch();
  watchEvent(w, { type: 'reaction', op: 'add' });
  watchEvent(w, { type: 'realm_emoji', op: 'update' });
  watchEvent(w, { type: 'alert_words' });
  watchMessage(w, { id: 1, sender_id: 2, content: 'x', timestamp: 1, type: 'stream', stream_id: 3, subject: 's', display_recipient: 'general', flags: [], reactions: [], submessages: [] });
  expect(w.size).toBe(0);
  watchEvent(w, { type: 'reaction', op: 'swap' });
  watchEvent(w, { type: 'example_new_event', op: 'add' });
  expect(w.summary().unknown.map((e) => `${e.surface} ${e.name}`)).toEqual(['zulip.event.op reaction/swap', 'zulip.event example_new_event']);
});

test('the adapter logs an unknown event, op and message key once, and the message still arrives', async () => {
  const z = fakeZulip();
  const link = testLink({ server: z.url, email: 'quinn@example.com' }, { apiKey: z.key });
  const a = new ZulipAdapter();
  a.start(link);
  a.onConnect();
  stops.push(() => z.stop(), () => a.shutdown());
  await link.next((e) => e.t === 'status' && e.status === 'online');
  const host = new URL(z.url).host;
  const from = link.events.length;
  z.push({ type: 'example_new_event', detail: SECRET });
  z.push({ type: 'example_new_event', detail: SECRET });
  z.push({ type: 'typing', op: 'example_pause', sender: { user_id: 9 } });
  const msg = { id: 160, sender_id: 9, sender_full_name: 'Ann Lee', content: SECRET, timestamp: 1_700_000_100, type: 'stream', stream_id: 3, subject: 'plans', display_recipient: 'general', reactions: [], submessages: [], example_new_field: SECRET };
  z.addMessage({ ...msg, flags: [] });
  z.push({ type: 'message', message: msg, flags: [] });
  const live = await link.next<Extract<P.AdapterEvent, { t: 'message' }>>((e) => e.t === 'message' && e.message.nativeId === `${host}/m/160`, 10_000, from);
  expect(live.message).toMatchObject({ conversation: `${host}/s/3/t/plans`, body: SECRET });
  const drift = link.logs.filter((l) => l.msg.startsWith('schema drift:')).map((l) => l.msg);
  expect(drift).toEqual([
    'schema drift: unknown tag "example_new_event" on "zulip.event"',
    'schema drift: unknown tag "typing/example_pause" on "zulip.event.op"',
    'schema drift: unknown key "example_new_field" on "zulip.message"',
  ]);
  expect(a.drift.summary().unknown.find((e) => e.name === 'example_new_event')?.count).toBe(2);
  expect(a.drift.details()).toMatchObject({ schemaDrift: 3 });
  expect(JSON.stringify([drift, a.drift.summary(), a.drift.details()])).not.toContain(SECRET);
});
