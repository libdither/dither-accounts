/** The startup backfill's memory across restarts (src/backfill.ts). */
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKFILL_FILE, BACKFILL_TTL_MS, BackfillMemory } from '../src/backfill.ts';
import { newState, translateSnapshot } from '../src/ingest.ts';

const dir = mkdtempSync(join(tmpdir(), 'discord-backfill-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const file = join(dir, BACKFILL_FILE);

const DM = '700000000000000101';
const CH = '700000000000000202';

test('a channel fetched before is skipped by the next start while its newest message is the one fetched', () => {
  let now = 1_000_000;
  const a = new BackfillMemory(file, () => now);
  expect(a.fresh(DM, '700000000000000900')).toBe(false);
  a.record(DM, ['700000000000000899', '700000000000000900', '700000000000000898'], '700000000000000900');
  a.record(CH, [], null);
  expect(statSync(file).mode & 0o777).toBe(0o600);

  // The next start reads it back.
  now += 3_600_000;
  const b = new BackfillMemory(file, () => now);
  expect(b.fresh(DM, '700000000000000900')).toBe(true);
  // A new message since: fetched again.
  expect(b.fresh(DM, '700000000000000901')).toBe(false);
  // A channel that had no messages and still has none.
  expect(b.fresh(CH, undefined)).toBe(true);
  expect(b.fresh('700000000000000303', '700000000000000900')).toBe(false);
});

test('entries expire after a few days; a broken file is an empty memory', () => {
  let now = 5_000_000;
  const a = new BackfillMemory(file, () => now);
  a.record(DM, ['700000000000000900'], '700000000000000900');
  now += BACKFILL_TTL_MS + 1;
  const b = new BackfillMemory(file, () => now);
  expect(b.fresh(DM, '700000000000000900')).toBe(false);
  expect(b.entries()[DM]).toBeUndefined();

  writeFileSync(file, '{not json');
  expect(new BackfillMemory(file).entries()).toEqual({});
  writeFileSync(file, JSON.stringify({ 'not-a-snowflake': { last: null, at: 1 }, [DM]: { last: 'x', at: 1 } }));
  expect(new BackfillMemory(file, () => 2).entries()).toEqual({});
  expect(JSON.parse(readFileSync(file, 'utf8'))).toBeTruthy();
});

test("the snapshot gives each channel's newest message id", () => {
  const { newest } = translateSnapshot(
    {
      privateChannels: [{ id: DM, type: 1, last_message_id: '700000000000000900', recipients: [] }],
      channels: [{ id: CH, type: 0, guild_id: '700000000000000001', last_message_id: '700000000000000950' }],
    } as any,
    newState(),
  );
  expect(newest).toEqual({ [DM]: '700000000000000900', [CH]: '700000000000000950' });
});
