import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { generate, OUT } from '../scripts/gen-types.ts';

test('the interfaces page types are current (bun scripts/gen-types.ts)', () => {
  expect(JSON.parse(readFileSync(OUT, 'utf8'))).toEqual(generate());
}, 30_000);

test('types read like the client sees them', () => {
  const t = generate();
  expect(t['test.echo'].ops.echo).toEqual({ input: '{ text: string }', output: '{ text: string }', example: { text: '' } });
  expect(t['google.calendar'].ops['calendar.events.list'].output).toBe('{ items: Record<string, any>[]; nextPageToken?: string; nextSyncToken?: string }');
  expect(t.chat.ops.send.input).toContain('conversation: string');
  expect(t.chat.defs.MessageFact).toContain('type MessageFact = {');
}, 30_000);
