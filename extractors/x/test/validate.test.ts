import { expect, test } from 'bun:test';
import * as V from '../src/validate.ts';
import { ALICE, conv, msg, T0 } from './fixtures.ts';

test('objects with what the mapping needs pass, as they came', () => {
  const d = new V.Drops();
  expect(V.conversation(conv(), d)).toEqual(conv());
  expect(V.message(msg(), '1001-2002', d)).toEqual(msg());
  expect(V.user(ALICE, d)).toEqual(ALICE);
  expect(d.total).toBe(0);
});

test('what does not match is dropped and counted by kind and reason, never mapped half-right', () => {
  const d = new V.Drops();
  expect(V.conversation({ ...conv(), id: 'has spaces <b>' }, d)).toBeNull();
  expect(V.message({ ...msg(), ts: null }, '1001-2002', d)).toBeNull();
  expect(V.message({ ...msg(), ts: 12 }, '1001-2002', d)).toBeNull();
  expect(V.message({ ...msg(), sender: null, mine: false }, '1001-2002', d)).toBeNull();
  expect(V.message({ ...msg(), conv: 'other' }, '1001-2002', d)).toBeNull();
  expect(V.message({ ...msg(), text: 5 }, '1001-2002', d)).toBeNull();
  expect(V.user({ id: '9', screenName: 'not a handle!' }, d)).toBeNull();
  expect(V.message('nope', '1001-2002', d)).toBeNull();
  expect(Object.fromEntries(d.counts)).toEqual({
    'conversation.bad-id': 1,
    'message.no-time': 2,
    'message.no-sender': 1,
    'message.other-conversation': 1,
    'message.bad-text': 1,
    'user.bad-screen-name': 1,
    'message.not-object': 1,
  });
  expect(d.summary(2)).toBe('message.no-time 2, conversation.bad-id 1');
});

test('inside an object, bad parts are dropped and the rest kept: users, reactions, attachments', () => {
  const d = new V.Drops();
  const c = V.conversation({ ...conv(), users: [ALICE, { id: '' }, { id: '7', screenName: 'ok_7' }] }, d)!;
  expect(c.users.map((u) => u.id)).toEqual([ALICE.id, '7']);
  const m = V.message({ ...msg(), reactions: [{ emoji: '👍', users: ['2002', 'bad id'], mine: true }, { emoji: '' }], attachments: [{ index: 0, url: 'https://ton.twimg.com/dm/1/a.jpg', mime: 'image/jpeg' }, { index: -1 }, { index: 1, url: 'https://evil.example/x.png', mime: 'not a mime' }] }, '1001-2002', d)!;
  expect(m.reactions).toEqual([{ emoji: '👍', users: ['2002'], mine: true, attachmentId: null }]);
  expect(m.attachments.map((a) => [a.index, a.url, a.mime])).toEqual([
    [0, 'https://ton.twimg.com/dm/1/a.jpg', 'image/jpeg'],
    [1, null, null],
  ]);
  expect(Object.fromEntries(d.counts)).toEqual({ 'user.bad-id': 1, 'reaction.no-emoji': 1, 'attachment.bad-index': 1 });
});

test("media URLs: X's own https hosts, the page's blobs and data URLs; nothing else", () => {
  expect(V.mediaUrl('https://pbs.twimg.com/media/x.jpg')).toBe('https://pbs.twimg.com/media/x.jpg');
  expect(V.mediaUrl('https://ton.twimg.com/dm/1/2/x.jpg')).toBe('https://ton.twimg.com/dm/1/2/x.jpg');
  expect(V.mediaUrl('blob:https://x.com/1234')).toBe('blob:https://x.com/1234');
  expect(V.mediaUrl('http://pbs.twimg.com/x.jpg')).toBeNull();
  expect(V.mediaUrl('https://twimg.com.evil.example/x.jpg')).toBeNull();
  expect(V.mediaUrl('javascript:alert(1)')).toBeNull();
  expect(V.mediaUrl('http://127.0.0.1:5/a', 'http://127.0.0.1:5')).toBe('http://127.0.0.1:5/a');
});

test('the inbox and a conversation: duplicates dropped, typing kept by id', () => {
  const d = new V.Drops();
  const ib = V.inbox({ conversations: [conv(), conv(), conv({ id: 'g1', group: true })], typing: [{ conv: 'g1', users: ['2002', 'x y'] }], loading: false, keysChecked: true }, d)!;
  expect(ib.conversations.map((c) => c.id)).toEqual(['1001-2002', 'g1']);
  expect(ib.typing).toEqual([{ conv: 'g1', users: ['2002'] }]);
  expect(Object.fromEntries(d.counts)).toEqual({ 'conversation.duplicate': 1 });
  const ms = V.messages({ conv: 'g1', messages: [msg({ conv: 'g1' }), msg({ conv: 'g1', id: 'm2', ts: T0 + 1 })], participants: ['1001', '2002'], other: { DateSeparatorItem: 2 } }, d)!;
  expect(ms.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
  expect(ms.other).toEqual({ DateSeparatorItem: 2 });
});

test('the self-test: unknown hooks ignored, missing ones missing', () => {
  const t = V.selfTest({ version: 1, hooks: { graph: { ok: true, via: 'shape' }, bogus: { ok: true } }, counts: { renderers: 2, dropped: { message: 3 } } })!;
  expect(t.hooks.graph).toEqual({ ok: true, via: 'shape' });
  expect(t.hooks.send).toEqual({ ok: false, via: null });
  expect('bogus' in t.hooks).toBe(false);
  expect(t.counts).toMatchObject({ renderers: 2, roots: 0, dropped: { message: 3 } });
  expect(V.selfTest(null)).toBeNull();
});
