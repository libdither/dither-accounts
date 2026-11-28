/**
 * Schema drift on Signal (manager's schema-drift-signal.ts, wired in adapter.ts `received`): every fixture's envelope
 * passes without a sighting; an envelope key and a data message key the adapter does not know are logged once by
 * name, the message is still mapped as before, the account's status details sum them up, and no value (text, numbers,
 * ids) reaches the log, the summary or the details.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { SchemaWatch } from '@dither-accounts/manager/schema-drift';
import { watchSignalEnvelope } from '@dither-accounts/manager/schema-drift-signal';
import { SignalAdapter } from '../src/adapter.ts';

const SECRET = 'secret-words-5a0e';
const SELF = '5f2c7a8e-1111-4aaa-8bbb-000000000001';
const ALICE = 'a11ce000-2222-4ccc-9ddd-000000000002';
const FIXTURES = join(import.meta.dir, 'fixtures');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test('every fixture envelope is known: no drift', () => {
  const w = new SchemaWatch();
  let n = 0;
  for (const f of readdirSync(FIXTURES).filter((f) => f.endsWith('.json'))) {
    for (const r of ([] as any[]).concat(JSON.parse(readFileSync(join(FIXTURES, f), 'utf8')))) {
      if (!r?.envelope) continue;
      watchSignalEnvelope(w, r.envelope);
      n++;
    }
  }
  expect(n).toBeGreaterThan(20);
  expect(w.summary().unknown).toEqual([]);
});

test('the adapter logs an unknown envelope key and data message key once by name, still maps the message, and shows them in its status', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sig-drift-'));
  dirs.push(dir);
  const events: P.AdapterEvent[] = [];
  const logs: string[] = [];
  const adapter = new SignalAdapter({ emit: (e) => events.push(e), log: (l, m) => logs.push(`[${l}] ${m}`), accountDir: dir, config: {}, secret: () => ({}), saveSecret: () => {} }, { signalCli: async () => [] });
  // Linked, without a daemon: received() maps what it is given.
  (adapter as any).account = { number: '+15550100', aci: SELF };
  const envelope = (ts: number, message: string) => ({
    source: '+15550137',
    sourceNumber: '+15550137',
    sourceUuid: ALICE,
    sourceName: 'Alice Chen',
    sourceDevice: 1,
    timestamp: ts,
    exampleNewEnvelopeField: { text: SECRET, number: '+15550199' },
    dataMessage: { timestamp: ts, message, expiresInSeconds: 0, isExpirationUpdate: false, viewOnce: false, isEndSession: false, isProfileKeyUpdate: false, hasProfileKey: true, exampleNewPart: { text: SECRET }, [`${ALICE}`]: SECRET },
  });
  adapter.received({ account: '+15550100', envelope: envelope(1_793_330_000_000, SECRET) } as any);
  adapter.received({ account: '+15550100', envelope: envelope(1_793_330_001_000, 'again') } as any);

  const sent = events.filter((e): e is Extract<P.AdapterEvent, { t: 'message' }> => e.t === 'message').map((e) => e.message.body);
  expect(sent).toEqual([SECRET, 'again']);
  expect(logs.filter((l) => l.includes('schema drift:'))).toEqual([
    '[info] schema drift: unknown key "exampleNewEnvelopeField" on "signal.envelope"',
    '[info] schema drift: unknown key "exampleNewPart" on "signal.dataMessage"',
    '[info] schema drift: unknown key "(value-like)" on "signal.dataMessage"',
  ]);
  expect(adapter.drift.summary().unknown.map((e) => [e.surface, e.name, e.count])).toEqual([
    ['signal.envelope', 'exampleNewEnvelopeField', 2],
    ['signal.dataMessage', 'exampleNewPart', 2],
    ['signal.dataMessage', '(value-like)', 2],
  ]);
  // The account's status details carry the summary, as the other chat extractors' do.
  const details = (adapter as any).details() as Record<string, unknown>;
  expect(details).toMatchObject({ schemaDrift: 3, schemaDriftTop: expect.stringContaining('signal.envelope key:exampleNewEnvelopeField ×2') });
  const out = JSON.stringify([logs.filter((l) => l.includes('schema drift')), adapter.drift.summary(), details]);
  for (const value of [SECRET, '+15550199', ALICE]) expect(out).not.toContain(value);
  await adapter.shutdown();
});
