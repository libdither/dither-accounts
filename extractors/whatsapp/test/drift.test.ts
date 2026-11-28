/**
 * Schema drift on WhatsApp (src/drift.ts): every fixture's message passes without a sighting; a message part, a
 * protocolMessage type and a bridge event the adapter does not know are logged once by name, the message is still
 * mapped as before, and no value (text, ids) reaches the log or the summary.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { SchemaWatch } from '@dither-accounts/manager/schema-drift';
import { WhatsAppAdapter } from '../src/adapter.ts';
import { watchMessage } from '../src/drift.ts';

const SECRET = 'secret-words-5a0e';
const ALICE = '15550000002@s.whatsapp.net';
const fixtures = readFileSync(join(import.meta.dir, 'fixtures/events.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test('every fixture message is known: no drift', () => {
  const w = new SchemaWatch();
  for (const ev of fixtures) if (ev.t === 'message') watchMessage(w, ev);
  expect(w.summary().unknown).toEqual([]);
});

test('the adapter logs unknown parts, protocol types and bridge events once by name, and still maps the message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-drift-'));
  dirs.push(dir);
  const events: P.AdapterEvent[] = [];
  const logs: string[] = [];
  const adapter = new WhatsAppAdapter({ emit: (e) => events.push(e), log: (l, m) => logs.push(`[${l}] ${m}`), accountDir: dir, config: {} }, { bridge: async () => [], statePath: ':memory:' });
  const onBridge = (ev: unknown) => (adapter as any).onBridge(ev);
  const info = (id: string) => ({ id, chat: ALICE, sender: ALICE, fromMe: false, isGroup: false, ts: 1_760_000_060_000 });
  onBridge({ t: 'message', info: info('D1'), message: { conversation: SECRET, exampleNewMessage: { text: SECRET } } });
  onBridge({ t: 'message', info: info('D2'), message: { conversation: 'again', exampleNewMessage: { text: SECRET } } });
  onBridge({ t: 'message', info: info('D3'), message: { protocolMessage: { type: 'EXAMPLE_NEW_TYPE', key: { ID: 'D1' } } } });
  onBridge({ t: 'example_bridge_event', note: SECRET });
  const sent = events.filter((e): e is Extract<P.AdapterEvent, { t: 'message' }> => e.t === 'message').map((e) => e.message.body);
  expect(sent).toEqual([SECRET, 'again']);
  expect(logs.filter((l) => l.includes('schema drift:'))).toEqual([
    '[info] schema drift: unknown key "exampleNewMessage" on "whatsapp.message"',
    '[info] schema drift: unknown tag "EXAMPLE_NEW_TYPE" on "whatsapp.protocolMessage.type"',
    '[info] schema drift: unknown tag "example_bridge_event" on "whatsapp.bridge"',
  ]);
  expect(adapter.drift.summary().unknown[0]).toMatchObject({ name: 'exampleNewMessage', count: 2 });
  expect(JSON.stringify([logs, adapter.drift.summary(), adapter.drift.details()])).not.toContain(SECRET);
});
