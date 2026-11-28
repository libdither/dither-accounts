/**
 * Schema drift on Discord (src/drift.ts): the message types map.ts has words for are known, and a message type, an
 * embed type and a component type it does not know are each logged once by name, while the message is still mapped
 * and sent; no value of the message (its words, ids) reaches the log or the summary.
 */
import { expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import { SchemaWatch } from '@dither-accounts/manager/schema-drift';
import type { RawMessage } from '../src/discord-types.ts';
import { MESSAGE_TYPES } from '../src/drift.ts';
import { newState, translateDispatch } from '../src/ingest.ts';
import { systemMessageText } from '../src/map.ts';

const SECRET = 'secret-words-2d7f';
const msg = (o: Partial<RawMessage>): RawMessage => ({ id: '700000000000000001', channel_id: '700000000000000002', author: { id: '700000000000000003', username: 'ann' }, content: SECRET, timestamp: '2026-01-01T00:00:00.000Z', ...o }) as RawMessage;

test('the known message types are the ones systemMessageText has words for', () => {
  for (const t of [0, 1, 7, 19, 20, 23, 46, 67]) expect(MESSAGE_TYPES.has(String(t))).toBe(true);
  expect(MESSAGE_TYPES.has('99')).toBe(false);
  expect(systemMessageText(msg({ type: 99, content: '' }))).toBe('(unsupported message type 99)');
});

test('unknown message, embed and component types are logged once by name; the message is still sent', () => {
  const logs: string[] = [];
  const st = newState();
  st.selfId = '700000000000000009';
  st.drift = new SchemaWatch({ log: (l, m) => logs.push(`[${l}] ${m}`) });
  const plain = translateDispatch('MESSAGE_CREATE', { message: msg({ id: '700000000000000010', type: 0, embeds: [{ type: 'rich', title: SECRET }], components: [{ type: 1, components: [{ type: 2, label: SECRET }] }] }) }, st);
  expect(plain.some((e) => e.t === 'message')).toBe(true);
  expect(st.drift.size).toBe(0);
  const first = translateDispatch('MESSAGE_CREATE', { message: msg({ id: '700000000000000011', type: 99, embeds: [{ type: 'example_embed', title: SECRET }], components: [{ type: 17, components: [{ type: 42, content: SECRET } as never] }] }) }, st);
  translateDispatch('MESSAGE_CREATE', { message: msg({ id: '700000000000000012', type: 99 }) }, st);
  const sent = first.find((e): e is Extract<P.AdapterEvent, { t: 'message' }> => e.t === 'message');
  expect(sent?.message).toMatchObject({ nativeId: '700000000000000011', body: SECRET });
  expect(logs).toEqual([
    '[info] schema drift: unknown tag "99" on "discord.message.type"',
    '[info] schema drift: unknown tag "example_embed" on "discord.embed.type"',
    '[info] schema drift: unknown tag "42" on "discord.component.type"',
  ]);
  expect(st.drift.summary().unknown[0]).toMatchObject({ surface: 'discord.message.type', name: '99', count: 2 });
  const all = JSON.stringify([logs, st.drift.summary(), st.drift.details()]);
  expect(all).not.toContain(SECRET);
  expect(all).not.toContain('700000000000000011');
});
