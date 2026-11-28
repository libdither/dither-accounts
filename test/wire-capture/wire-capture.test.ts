/**
 * Golden wire traces (packages/manager/src/wire-capture.ts): the anonymizer keeps a trace's ids pointing at each
 * other while none of them stays, the leak guard refuses what slips through, the recorder writes only what passes, and
 * the scrub command writes nothing it refused. Every "real" value here is invented.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AdapterStreamRecorder, anonymizeTrace, assertNoConcreteLeaks, LeakError, parseTrace, SYNTHETIC_MS_BASE, SYNTHETIC_S_BASE, WIRE_CAPTURE_ENV } from '../../packages/manager/src/wire-capture.ts';

const REPO = resolve(import.meta.dir, '../..');

// Invented stand-ins for what a real capture carries, built so the file itself holds none of the shapes the sweep looks
// for (a 9-digit run, a phone, a home path...).
const j = (...parts: string[]) => parts.join('');
const MS = Number(j('17630', '00000123')); // a 13-digit epoch ms time in late 2025
const UUID_A = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const UUID_B = 'c0ffee00-1234-4abc-8def-00000000beef';
const PHONE = j('+1510', '555', '0199');
const PHONE_2 = j('+4420', '7946', '0958');
const EMAIL = j('ann.lee', '@', 'mailbox', '.org');
const SNOWFLAKE = j('112233445', '566778899');
const HOME = j('/ho', 'me/someone/notes.txt');
const TAILNET = j('box.tail1234', '.ts', '.net');
const CGNAT = j('100.101', '.102.103');
const LAN = j('192.168', '.1.20');
const ACC = j('acc_', 'Zq9xY7wV', 'u5');

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'wire-capture-test-'));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
};

describe('anonymizeTrace', () => {
  test('UUIDs: one synthetic id per real one, the same in every record, in keys and either case', () => {
    const out = anonymizeTrace([{ source: UUID_A, to: UUID_B }, { source: UUID_A.toUpperCase(), [UUID_B]: { ack: UUID_A } }], { scrubText: false });
    expect(out).toEqual([
      { source: '00000000-0000-4000-8000-000000000001', to: '00000000-0000-4000-8000-000000000002' },
      { source: '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002': { ack: '00000000-0000-4000-8000-000000000001' } },
    ]);
  });

  test('timestamps: the earliest becomes the base, every delta and the order are kept, in numbers and strings', () => {
    const out = anonymizeTrace([{ ts: MS + 500 }, { ts: MS, note: `sent at ${MS + 250}` }, { ts: MS + 86_400_000, seconds: Math.floor(MS / 1000) + 60 }, { seconds: Math.floor(MS / 1000) }]) as any[];
    expect(out[0].ts).toBe(SYNTHETIC_MS_BASE + 500);
    expect(out[1].ts).toBe(SYNTHETIC_MS_BASE);
    expect(out[2]).toEqual({ ts: SYNTHETIC_MS_BASE + 86_400_000, seconds: SYNTHETIC_S_BASE + 60 });
    expect(out[3].seconds).toBe(SYNTHETIC_S_BASE);
    // Without scrubbing, a time inside text is rebased the same way.
    expect((anonymizeTrace([{ ts: MS }, { note: `sent at ${MS + 250}` }], { scrubText: false }) as any[])[1].note).toBe(`sent at ${SYNTHETIC_MS_BASE + 250}`);
  });

  test('Matrix ids: users, rooms, events and aliases keep pointing at each other, their server becomes example.test', () => {
    const room = '!AbCdEf123:chat.invented.org';
    const ev = '$Q1w2E3r4T5y6U7i8O9p0aSdFgHjKl';
    const out = anonymizeTrace(
      [
        { room_id: room, event_id: ev, sender: '@ann:chat.invented.org', content: { 'm.relates_to': { event_id: ev } } },
        { content: { [ev]: { 'm.read': { '@ben:chat.invented.org': {} } } }, via: ['chat.invented.org'], link: `https://matrix.to/#/${room}/${ev}?via=chat.invented.org`, alias: '#lobby:chat.invented.org', avatar: 'mxc://chat.invented.org/abc' },
      ],
      { scrubText: false },
    );
    expect(out).toEqual([
      { room_id: '!room1:example.test', event_id: '$ev1', sender: '@alice:example.test', content: { 'm.relates_to': { event_id: '$ev1' } } },
      {
        content: { $ev1: { 'm.read': { '@bob:example.test': {} } } },
        via: ['example.test'],
        link: 'https://matrix.to/#/!room1:example.test/$ev1?via=example.test',
        alias: '#alias1:example.test',
        avatar: 'mxc://example.test/abc',
      },
    ]);
    // A preset names a testbed's invented user as it was.
    expect(anonymizeTrace({ a: '@quinn:chat.invented.org', b: '@ann:chat.invented.org' }, { preset: { '@quinn:chat.invented.org': '@quinn:example.test' } })).toEqual({ a: '@quinn:example.test', b: '@alice:example.test' });
  });

  test('phones, emails, snowflakes and long numbers: each real one gets its own synthetic one', () => {
    const out = anonymizeTrace(
      [
        { number: PHONE, other: PHONE_2, email: EMAIL, invented: 'bob@example.com', id: SNOWFLAKE, n: Number(SNOWFLAKE.slice(0, 15)) },
        { number: `${PHONE.slice(0, 2)} ${PHONE.slice(2, 5)}-${PHONE.slice(5, 8)}-${PHONE.slice(8)}`, email: EMAIL.toUpperCase(), parent: SNOWFLAKE, n: Number(SNOWFLAKE.slice(0, 15)) },
      ],
      { scrubText: false },
    );
    expect(out).toEqual([
      { number: '+15550100', other: '+15550101', email: 'user1@example.com', invented: 'bob@example.com', id: '700000000000000001', n: 7000000000000002 },
      // A formatted number is the same number.
      { number: '+15550100', email: 'user1@example.com', parent: '700000000000000001', n: 7000000000000002 },
    ]);
  });

  test('machines: tailnet names, home paths, private and public addresses and account ids; loopback stays', () => {
    const out = anonymizeTrace({ url: `https://${TAILNET}/x`, path: HOME, tail: CGNAT, lan: LAN, public: '8.8.4.4', lo: '127.0.0.1:8486', acc: ACC, again: `${ACC} ${CGNAT}` }, { scrubText: false });
    expect(out).toEqual({ url: 'https://host1.example.test/x', path: '/data/fixture/notes.txt', tail: '192.0.2.1', lan: '192.0.2.2', public: '192.0.2.3', lo: '127.0.0.1:8486', acc: 'acc_fixture1', again: 'acc_fixture1 192.0.2.1' });
    expect(anonymizeTrace({ u: 'https://api.invented.org/v1' }, { hosts: ['api.invented.org'] })).toEqual({ u: 'https://example.test/v1' });
  });

  test('scrubText: bodies and names become synthetic, the same text the same way, an edit keeps its "* ", HTML its tags', () => {
    const out = anonymizeTrace([
      { body: 'see you at noon', displayname: 'Ann Lee' },
      { body: '* see you at noon', formatted_body: '<b>see</b> you <a href="https://matrix.to/#/@ann:chat.invented.org">Ann</a>', name: 'Ann Lee', msgtype: 'm.text' },
    ]);
    expect(out).toEqual([
      { body: 'message 1', displayname: 'Alice' },
      { body: '* message 1', formatted_body: '<b>message 2</b>message 3<a href="https://matrix.to/#/@alice:example.test">message 4</a>', name: 'Alice', msgtype: 'm.text' },
    ]);
    expect(anonymizeTrace({ body: 'see you at noon' }, { scrubText: false })).toEqual({ body: 'see you at noon' });
  });

  test('credentials under their keys are blanked, whatever they look like; a reaction key is not one', () => {
    const out = anonymizeTrace({ access_token: 'syt_abc', nested: { password: 'hunter2', apiKey: 42, Cookie: 'sid=1', refresh_token: { kept: 'as structure' } }, key: '👍' }, { scrubText: false });
    expect(out).toEqual({ access_token: '<redacted>', nested: { password: '<redacted>', apiKey: '<redacted>', Cookie: '<redacted>', refresh_token: { kept: 'as structure' } }, key: '👍' });
  });

  test('anonymizing twice changes nothing more, and the result passes the guard', () => {
    const trace = [{ ts: MS, id: UUID_A, from: PHONE, mail: EMAIL, sf: SNOWFLAKE, sender: '@ann:chat.invented.org', at: HOME, ip: CGNAT, acc: ACC, body: 'hi' }];
    const once = anonymizeTrace(trace);
    expect(anonymizeTrace(once)).toEqual(once);
    expect(() => assertNoConcreteLeaks(JSON.stringify(once))).not.toThrow();
  });
});

describe('assertNoConcreteLeaks', () => {
  const leaks: [string, string][] = [
    ['home path', `{"p":"${HOME}"}`],
    ['tailnet name', `{"h":"${TAILNET}"}`],
    ['phone number', `{"n":"${PHONE}"}`],
    ['email', `{"e":"${EMAIL}"}`],
    ['tailnet address', `{"ip":"${CGNAT}"}`],
    ['LAN address', `{"ip":"${LAN}"}`],
    ['IP address', '{"ip":"8.8.4.4"}'],
    ['long number', `{"id":"${SNOWFLAKE}"}`],
    ['long number', `{"ts":${MS}}`],
    ['account id', `{"a":"${ACC}"}`],
  ];
  for (const [kind, text] of leaks)
    test(`refuses a ${kind}`, () => {
      let err: unknown;
      try {
        assertNoConcreteLeaks(text);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(LeakError);
      expect((err as LeakError).hits.map((h) => h.kind)).toContain(kind);
      // It says where, never the value itself.
      expect((err as LeakError).message).not.toContain(text.slice(8, -2));
    });

  test('passes what the anonymizer and the repo’s invented data look like', () => {
    const synthetic = {
      id: '00000000-0000-4000-8000-000000000042',
      sf: '700000000000000017',
      n: 7000000000000003,
      ts: SYNTHETIC_MS_BASE + 12_345,
      s: SYNTHETIC_S_BASE + 60,
      mail: ['user3@example.com', 'alice@example.org', 'bob@chat.example.net', 'carol@dither.test'],
      phone: '+15550123',
      mx: ['@alice:example.test', '!room1:example.test', '$ev9'],
      acc: 'acc_fixture2',
      ip: ['127.0.0.1', '192.0.2.7', '0.0.0.0'],
      path: '/data/fixture/x',
    };
    expect(() => assertNoConcreteLeaks(JSON.stringify(synthetic))).not.toThrow();
  });
});

describe('AdapterStreamRecorder', () => {
  test('off unless DITHER_WIRE_CAPTURE_DIR names a directory', () => {
    expect(AdapterStreamRecorder.fromEnv({})).toBeUndefined();
    const dir = tmp();
    expect(AdapterStreamRecorder.fromEnv({ [WIRE_CAPTURE_ENV]: dir })?.dir).toBe(dir);
  });

  test('each stream gets a file of anonymized lines, one mapping per stream across commands and events', () => {
    const dir = tmp();
    const rec = new AdapterStreamRecorder(dir, { scrubText: false });
    rec.record('acc-one', 'command', { t: 'send', id: UUID_A, conversation: '!AbCdEf123:chat.invented.org', body: 'hi' }, MS);
    rec.record('acc-one', 'event', JSON.stringify({ t: 'reply', id: UUID_A, ok: true, result: { nativeId: '$Q1w2E3r4T5y6U7i8O9p0', ts: MS + 40 } }), MS + 50);
    rec.record('acc-two', 'event', Buffer.from(JSON.stringify({ t: 'message', message: { author: PHONE, ts: MS + 1000 } })), MS + 2000);
    rec.record('acc-two', 'event', 'not json', MS + 2001);
    const one = readFileSync(join(dir, 'stream-1.ndjson'), 'utf8');
    const two = readFileSync(join(dir, 'stream-2.ndjson'), 'utf8');
    expect(parseTrace(one, { lines: true })).toEqual([
      { seq: 1, dir: 'command', at: SYNTHETIC_MS_BASE, msg: { t: 'send', id: '00000000-0000-4000-8000-000000000001', conversation: '!room1:example.test', body: 'hi' } },
      { seq: 2, dir: 'event', at: SYNTHETIC_MS_BASE + 50, msg: { t: 'reply', id: '00000000-0000-4000-8000-000000000001', ok: true, result: { nativeId: '$ev1', ts: SYNTHETIC_MS_BASE + 40 } } },
    ]);
    // Its own mapping and its own start.
    expect(parseTrace(two, { lines: true })).toEqual([{ seq: 1, dir: 'event', at: SYNTHETIC_MS_BASE, msg: { t: 'message', message: { author: '+15550100', ts: SYNTHETIC_MS_BASE - 1000 } } }]);
    expect(() => assertNoConcreteLeaks(one + two)).not.toThrow();
  });

  test('a line the guard refuses is left out and counted', () => {
    const dir = tmp();
    const rec = new AdapterStreamRecorder(dir, { scrubText: false });
    // An address with no name before the @ is no email to the anonymizer, but the sweep still sees the domain.
    expect(rec.record('acc', 'event', { t: 'log', msg: `mail me at ann ${j('@', 'mailbox', '.org')}` }, MS)).toBeNull();
    expect(rec.record('acc', 'event', { t: 'log', msg: 'fine' }, MS + 7)).not.toBeNull();
    const lines = readFileSync(join(dir, 'stream-1.ndjson'), 'utf8');
    expect(rec.dropped).toBe(1);
    // A directory gone from under it loses records, never throws into the socket handler.
    rmSync(dir, { recursive: true, force: true });
    expect(rec.record('acc', 'event', { t: 'log', msg: 'lost' }, MS + 8)).toBeNull();
    expect(rec.dropped).toBe(2);
    expect(parseTrace(lines, { lines: true })).toEqual([
      { seq: 1, dir: 'event', dropped: true },
      { seq: 2, dir: 'event', at: SYNTHETIC_MS_BASE + 7, msg: { t: 'log', msg: 'fine' } },
    ]);
  });
});

describe('scripts/capture-fixtures.ts scrub', () => {
  const scrub = (...args: string[]) => Bun.spawnSync(['bun', join(REPO, 'scripts/capture-fixtures.ts'), 'scrub', ...args], { stdout: 'pipe', stderr: 'pipe' });

  test('writes an anonymized copy of an NDJSON trace', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'in.ndjson'), [{ ts: MS, from: PHONE, body: 'hello there' }, { ts: MS + 5, to: PHONE, body: 'hello there' }].map((r) => JSON.stringify(r)).join('\n'));
    const r = scrub(join(dir, 'in.ndjson'), join(dir, 'out.json'));
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8'))).toEqual([
      { ts: SYNTHETIC_MS_BASE, from: '+15550100', body: 'message 1' },
      { ts: SYNTHETIC_MS_BASE + 5, to: '+15550100', body: 'message 1' },
    ]);
  });

  test('refuses, and writes nothing, when something concrete is left', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'in.json'), JSON.stringify({ log: `reach me ${j('@', 'mailbox', '.org')}` }));
    const r = scrub(join(dir, 'in.json'), join(dir, 'out.json'), '--keep-text');
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain('refusing to write');
    expect(existsSync(join(dir, 'out.json'))).toBe(false);
  });
});
