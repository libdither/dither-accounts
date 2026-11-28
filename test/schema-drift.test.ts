/**
 * SchemaWatch (packages/manager/src/schema-drift.ts): unknown keys and tags are counted by name, once logged, bounded,
 * and nothing of a payload but key and tag names ever reaches a log line, the summary or the status details.
 */
import { expect, test } from 'bun:test';
import { known, SchemaWatch, schemaName, VALUE_LIKE } from '../packages/manager/src/schema-drift.ts';
import { SIGNAL_KEYS, watchSignalEnvelope } from '../packages/manager/src/schema-drift-signal.ts';

const SECRET = 'secret-words-0b8c';
const KNOWN = known('id', 'body', 'ts');

function watch(o: { max?: number } = {}) {
  const logs: string[] = [];
  let now = 1_000;
  const w = new SchemaWatch({ ...o, log: (level, msg) => logs.push(`[${level}] ${msg}`), now: () => now });
  return { w, logs, tick: (ms: number) => (now += ms) };
}

test('known keys and tags pass; unknown ones are counted, logged once, with first and last seen', () => {
  const { w, logs, tick } = watch();
  expect(w.checkKeys('net.message', { id: 1, body: SECRET, ts: 2 }, KNOWN)).toBe(0);
  expect(w.checkTag('net.event', 'body', KNOWN)).toBe(false);
  expect(w.size).toBe(0);

  expect(w.checkKeys('net.message', { id: 1, body: SECRET, color: SECRET, shape: { x: SECRET } }, KNOWN)).toBe(2);
  tick(500);
  w.checkKeys('net.message', { id: 2, color: 'blue' }, KNOWN);
  expect(w.checkTag('net.event', 'example_new_event', KNOWN)).toBe(true);
  w.checkTag('net.event', 'example_new_event', KNOWN);
  expect(logs).toEqual([
    '[info] schema drift: unknown key "color" on "net.message"',
    '[info] schema drift: unknown key "shape" on "net.message"',
    '[info] schema drift: unknown tag "example_new_event" on "net.event"',
  ]);
  expect(w.summary()).toEqual({
    unknown: [
      { surface: 'net.message', name: 'color', kind: 'unknown_key', count: 2, firstSeen: 1_000, lastSeen: 1_500 },
      { surface: 'net.event', name: 'example_new_event', kind: 'unknown_tag', count: 2, firstSeen: 1_500, lastSeen: 1_500 },
      { surface: 'net.message', name: 'shape', kind: 'unknown_key', count: 1, firstSeen: 1_000, lastSeen: 1_000 },
    ],
    overflow: 0,
  });
  expect(w.details()).toEqual({ schemaDrift: 3, schemaDriftTop: 'net.message key:color ×2, net.event tag:example_new_event ×2, net.message key:shape ×1' });
});

test('a key whose value is null or undefined is an optional field left out, not drift', () => {
  const { w, logs } = watch();
  expect(w.checkKeys('net.message', { id: 1, extra: null, more: undefined }, KNOWN)).toBe(0);
  expect(w.size).toBe(0);
  expect(logs).toEqual([]);
  // Not an object: nothing to check.
  for (const v of [null, undefined, 'text', 5, [1, 2]]) expect(w.checkKeys('net.message', v, KNOWN)).toBe(0);
  expect(w.details()).toEqual({});
});

test('the same key on another surface, or as a tag, is its own entry', () => {
  const { w } = watch();
  w.checkKeys('a.one', { color: 1 }, KNOWN);
  w.checkKeys('a.two', { color: 1 }, KNOWN);
  w.checkTag('a.one', 'color', KNOWN);
  expect(w.size).toBe(3);
});

test('at most `max` entries; sightings of new names past it are only counted, and logged never', () => {
  const { w, logs } = watch({ max: 3 });
  for (let i = 0; i < 10; i++) w.checkTag('net.event', `type_${String.fromCharCode(97 + i)}`, KNOWN);
  w.checkTag('net.event', 'type_a', KNOWN);
  expect(w.size).toBe(3);
  expect(logs).toHaveLength(3);
  expect(w.summary().overflow).toBe(7);
  expect(w.summary().unknown[0]).toMatchObject({ name: 'type_a', count: 2 });
  expect(w.details()).toMatchObject({ schemaDrift: 3, schemaDriftOverflow: 7 });
});

test('names that look like values (ids, digit runs, handles, text) are counted as value-like, never by name', () => {
  for (const v of ['@alice:example.org', '!room:example.org', '$event', '700000000000000001', 'user_15550100', 'alice@example.com', 'hello there', 'https://example.com/x', 'a'.repeat(65), '+15550100']) {
    expect(schemaName(v)).toBe(VALUE_LIKE);
  }
  for (const v of ['m.room.message', 'org.matrix.msc3381.poll.start', 'updateNewMessage', 'REVOKE', 'realm_user/update', '19', 'example_new_field']) expect(schemaName(v)).toBe(v);
  const { w, logs } = watch();
  // A map keyed by ids that slips into checkKeys leaks none of them.
  w.checkKeys('net.receipts', { '$e1:example.org': { ts: 1 }, '@bob:example.org': { ts: 2 }, '700000000000000002': 1 }, KNOWN);
  expect(w.summary().unknown).toMatchObject([{ name: VALUE_LIKE, count: 3 }]);
  expect(logs).toEqual([`[info] schema drift: unknown key "${VALUE_LIKE}" on "net.receipts"`]);
  // A tag that is not a string counts under its type, or as a small enum number.
  w.checkTag('net.kind', 7, KNOWN);
  w.checkTag('net.kind', 123456789, KNOWN);
  w.checkTag('net.kind', undefined, KNOWN);
  expect(w.summary().unknown.filter((e) => e.surface === 'net.kind').map((e) => e.name).sort()).toEqual(['(number)', '(undefined)', '7']);
});

test('no value from a payload ever appears in a log line, the summary or the details', () => {
  const { w, logs } = watch();
  w.checkKeys('net.message', { id: SECRET, body: SECRET, note: SECRET, nested: { deep: SECRET }, list: [SECRET], flag: true, n: 123456 }, KNOWN);
  w.checkTag('net.event', `${SECRET} with spaces`, KNOWN);
  w.unknownTag('net.event', `https://example.com/${SECRET}`);
  const all = JSON.stringify([logs, w.summary(), w.details()]);
  expect(all).not.toContain(SECRET);
  expect(all).not.toContain('123456');
  expect(all).not.toContain('"deep"');
  for (const e of w.summary().unknown) expect(Object.keys(e).sort()).toEqual(['count', 'firstSeen', 'kind', 'lastSeen', 'name', 'surface']);
});

test('Signal: a received envelope is walked by key names, ready for the extractor to call', () => {
  const { w, logs } = watch();
  watchSignalEnvelope(w, {
    sourceUuid: 'uuid-1',
    sourceNumber: '+15550100',
    timestamp: 1,
    dataMessage: { timestamp: 1, message: SECRET, attachments: [{ contentType: 'image/png', id: 'a1' }], textStyles: [{ style: 'BOLD', start: 0, length: 1 }] },
    syncMessage: { sentMessage: { timestamp: 1, message: SECRET, destinationUuid: 'uuid-2' } },
    typingMessage: { action: 'STARTED', timestamp: 1 },
  });
  expect(w.size).toBe(0);
  watchSignalEnvelope(w, {
    timestamp: 1,
    exampleNewMessage: { text: SECRET },
    dataMessage: { timestamp: 1, message: SECRET, exampleNewField: SECRET, textStyles: [{ style: 'EXAMPLE_STYLE', start: 0, length: 1 }] },
    editMessage: { targetSentTimestamp: 1, dataMessage: { timestamp: 2, exampleNewField: SECRET } },
    typingMessage: { action: 'EXAMPLE_PAUSE', timestamp: 1 },
  });
  expect(w.summary().unknown.map((e) => `${e.surface} ${e.name} ${e.count}`).sort()).toEqual([
    'signal.dataMessage exampleNewField 2',
    'signal.envelope exampleNewMessage 1',
    'signal.textStyle EXAMPLE_STYLE 1',
    'signal.typingAction EXAMPLE_PAUSE 1',
  ]);
  expect(JSON.stringify([logs, w.summary()])).not.toContain(SECRET);
  expect(SIGNAL_KEYS.sentMessage.has('destinationUuid') && SIGNAL_KEYS.sentMessage.has('message')).toBe(true);
});
