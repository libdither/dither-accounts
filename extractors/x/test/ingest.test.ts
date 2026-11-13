import { expect, test } from 'bun:test';
import { ingestInbox, ingestMessages, XState } from '../src/ingest.ts';
import type { RawInbox, RawMessages } from '../src/raw.ts';
import { ALICE, BOB, conv, msg, SELF, T0 } from './fixtures.ts';

const inbox = (over: Partial<RawInbox> = {}): RawInbox => ({ conversations: [conv()], typing: [], loading: false, loadedFromDb: true, keysChecked: true, more: false, failed: false, ...over });
const open = (messages: RawMessages['messages'], over: Partial<RawMessages> = {}): RawMessages => ({ conv: '1001-2002', legacy: true, participants: [], readOnly: false, older: false, quiet: true, messages, other: {}, ...over });
const types = (evs: { t: string }[]) => evs.map((e) => e.t);

test('the inbox: people, then conversations, then read state; once each until something changes', () => {
  const st = new XState();
  st.selfId = SELF;
  const a = ingestInbox(st, inbox());
  expect(types(a.events)).toEqual(['identity', 'conversation', 'read']);
  expect(a.events[2]).toEqual({ t: 'read', conversation: '1001-2002', upToTs: T0, unread: 0 });
  // Nothing announced in it yet: worth a look.
  expect(a.newer).toEqual(['1001-2002']);
  expect(ingestInbox(st, inbox()).events).toEqual([]);
  const b = ingestInbox(st, inbox({ conversations: [conv({ unread: 2, lastSeq: '5', lastTs: T0 + 1000 })] }));
  expect(types(b.events)).toEqual(['conversation']);
  // Unread with no known message to put the mark at: no read event rather than a wrong one.
  expect(b.newer).toEqual(['1001-2002']);
});

test('after a restart, only conversations with something newer than what was announced', () => {
  const st = new XState({ '1001-2002': '3', g1: '9' });
  st.selfId = SELF;
  const r = ingestInbox(st, inbox({ conversations: [conv(), conv({ id: 'g1', group: true, lastSeq: '10' })] }));
  expect(r.newer).toEqual(['g1']);
});

test('typing: a start for who began, a stop for who ended', () => {
  const st = new XState();
  st.selfId = SELF;
  expect(ingestInbox(st, inbox({ typing: [{ conv: '1001-2002', users: [ALICE.id, SELF] }] })).events.filter((e) => e.t === 'typing')).toEqual([{ t: 'typing', conversation: '1001-2002', author: ALICE.id, ttl: 8000 }]);
  expect(ingestInbox(st, inbox({ typing: [] })).events.filter((e) => e.t === 'typing')).toEqual([{ t: 'typing', conversation: '1001-2002', author: ALICE.id, stop: true }]);
});

test('messages: backfill the first time; live once something is known and a newer one comes', () => {
  const st = new XState();
  st.selfId = SELF;
  ingestInbox(st, inbox());
  const first = ingestMessages(st, open([msg(), msg({ id: 'm2', seq: '2', ts: T0 + 1 })]), { now: T0 + 5000 });
  expect(first.filter((e) => e.t === 'message').map((e: any) => [e.message.nativeId, e.live])).toEqual([
    ['m1', false],
    ['m2', false],
  ]);
  // Alice was announced with the inbox: not again for her message.
  expect(first.filter((e) => e.t === 'identity')).toEqual([]);
  expect(st.seen.get('1001-2002')).toBe('2');
  const later = ingestMessages(st, open([msg(), msg({ id: 'm2', seq: '2', ts: T0 + 1 }), msg({ id: 'm3', seq: '3', ts: T0 + 60_000, sender: BOB.id, senderUser: BOB, text: 'new' })]), { now: T0 + 61_000 });
  expect(later.filter((e) => e.t === 'message').map((e: any) => [e.message.nativeId, e.live])).toEqual([['m3', true]]);
  // History is backfill whatever its times.
  const hist = ingestMessages(st, open([msg({ id: 'm0', seq: '0', ts: T0 - 1000 })]), { backfill: true, now: T0 + 62_000 });
  expect(hist.filter((e) => e.t === 'message').map((e: any) => e.live)).toEqual([false]);
});

test('an edit sends the message again with when it was seen; reactions are diffed per person', () => {
  const st = new XState();
  st.selfId = SELF;
  ingestMessages(st, open([msg({ reactions: [{ emoji: '👍', users: [ALICE.id], mine: false, attachmentId: null }] })]), { now: T0 });
  const ev = ingestMessages(st, open([msg({ text: 'hi there', edited: true, reactions: [{ emoji: '❤️', users: [], mine: true, attachmentId: null }] })]), { now: T0 + 9 });
  expect(ev).toEqual([
    { t: 'message', message: expect.objectContaining({ nativeId: 'm1', body: 'hi there', editedTs: T0 + 9, extra: expect.objectContaining({ edited: true }) }), live: false },
    { t: 'reaction', conversation: '1001-2002', message: 'm1', author: SELF, key: '❤️' },
    { t: 'reaction', conversation: '1001-2002', message: 'm1', author: ALICE.id, key: '👍', remove: true },
  ]);
  expect(ingestMessages(st, open([msg({ text: 'hi there', edited: true, reactions: [{ emoji: '❤️', users: [], mine: true, attachmentId: null }] })]), { now: T0 + 10 })).toEqual([]);
});

test('deletes: a message the page hides, and one gone from inside the loaded range', () => {
  const st = new XState();
  st.selfId = SELF;
  const three = [msg(), msg({ id: 'm2', seq: '2' }), msg({ id: 'm3', seq: '3' })];
  ingestMessages(st, open(three));
  expect(ingestMessages(st, open([three[0]!, { ...three[1]!, hidden: 'Deleted' }, three[2]!]))).toEqual([{ t: 'delete', conversation: '1001-2002', nativeId: 'm2' }]);
  ingestMessages(st, open(three));
  // m2 vanished between m1 and m3: deleted. A window that no longer reaches m1 deletes nothing.
  expect(ingestMessages(st, open([three[0]!, three[2]!]))).toEqual([{ t: 'delete', conversation: '1001-2002', nativeId: 'm2' }]);
  expect(ingestMessages(st, open([msg({ id: 'm3', seq: '3' }), msg({ id: 'm4', seq: '4' })])).filter((e) => e.t === 'delete')).toEqual([]);
});

test('replies name their target by sequence number once it is known; participants update the conversation', () => {
  const st = new XState();
  st.selfId = SELF;
  ingestInbox(st, inbox({ conversations: [conv({ id: 'g1', group: true, legacy: false, users: [ALICE] })] }));
  const ev = ingestMessages(st, open([msg({ conv: 'g1', id: 'a', seq: '1' }), msg({ conv: 'g1', id: 'b', seq: '2', replyTo: { seq: '1', id: null } })], { conv: 'g1', participants: [SELF, ALICE.id, BOB.id] }));
  expect(ev[0]).toEqual({ t: 'conversation', conversation: expect.objectContaining({ nativeId: 'g1', participants: [SELF, ALICE.id, BOB.id] }) });
  expect(ev.filter((e) => e.t === 'message').map((e: any) => e.message.replyTo)).toEqual([undefined, 'a']);
});
