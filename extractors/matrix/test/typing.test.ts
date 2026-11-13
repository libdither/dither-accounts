import { expect, test } from 'bun:test';
import { MATRIX_TYPING_TTL, typingEvents } from '../src/adapter.ts';

// The ephemeral part of a joined room in /sync, as the spec gives it (m.typing carries the room's whole list).
const sync = (userIds: string[]) => ({ ephemeral: { events: [{ type: 'm.typing', content: { user_ids: userIds } }] } });
const ROOM = '!r:x.org';
const SELF = '@me:x.org';
const names: Record<string, string> = { '@alice:x.org': 'Alice' };
const name = (u: string) => names[u];

test('each list against the one before: starts for those on it, stops for those who left it, never you', () => {
  const a = typingEvents(ROOM, undefined, sync(['@alice:x.org', SELF, '@bob:x.org']).ephemeral.events[0].content.user_ids, SELF, name);
  expect(a.events).toEqual([
    { t: 'typing', conversation: ROOM, author: '@alice:x.org', ttl: MATRIX_TYPING_TTL, name: 'Alice' },
    { t: 'typing', conversation: ROOM, author: '@bob:x.org', ttl: MATRIX_TYPING_TTL },
  ]);
  const b = typingEvents(ROOM, a.now, sync(['@bob:x.org']).ephemeral.events[0].content.user_ids, SELF, name);
  expect(b.events).toEqual([
    { t: 'typing', conversation: ROOM, author: '@bob:x.org', ttl: MATRIX_TYPING_TTL },
    { t: 'typing', conversation: ROOM, author: '@alice:x.org', stop: true },
  ]);
  const c = typingEvents(ROOM, b.now, [], SELF, name);
  expect(c.events).toEqual([{ t: 'typing', conversation: ROOM, author: '@bob:x.org', stop: true }]);
  expect(c.now.size).toBe(0);
});

test('junk in the list is skipped', () => {
  expect(typingEvents(ROOM, undefined, [5, null, '@a:x.org'], SELF, name).events).toEqual([{ t: 'typing', conversation: ROOM, author: '@a:x.org', ttl: MATRIX_TYPING_TTL }]);
});
