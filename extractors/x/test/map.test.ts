import { expect, test } from 'bun:test';
import { conversationFact, identityFact, mediaRef, messageFact, parseMediaRef, peerOf, toPlain } from '../src/map.ts';
import { ALICE, BOB, conv, msg, SELF, T0 } from './fixtures.ts';

test('people: handle, name, picture; the account itself marked', () => {
  expect(identityFact(ALICE, SELF)).toEqual({ nativeId: ALICE.id, handle: 'alice_a', displayName: 'Alice A', avatarUrl: ALICE.avatarUrl! });
  expect(identityFact({ id: SELF, screenName: 'pat_x', displayName: null, avatarUrl: 'blob:x' }, SELF)).toEqual({ nativeId: SELF, handle: 'pat_x', isSelf: true });
});

test('a legacy DM: direct, not encrypted, the peer from its users or from its id', () => {
  expect(conversationFact(conv(), SELF)).toEqual({ nativeId: '1001-2002', shape: 'direct', encrypted: false, participants: [SELF, ALICE.id], lastMessageAt: T0 });
  expect(peerOf(conv({ users: [] }), SELF)).toBe(ALICE.id);
  expect(conversationFact(conv({ id: '1001-1001', users: [] }), SELF).shape).toBe('self');
});

test('an XChat group: named, with its picture, encrypted, everyone in it', () => {
  const f = conversationFact(conv({ id: 'g9001', legacy: false, group: true, title: 'Weekend plans', avatarUrl: 'https://pbs.twimg.com/dm_group_img/1/x.jpg', users: [ALICE, BOB] }), SELF);
  expect(f).toEqual({ nativeId: 'g9001', shape: 'group', name: 'Weekend plans', avatarUrl: 'https://pbs.twimg.com/dm_group_img/1/x.jpg', encrypted: true, participants: [SELF, ALICE.id, BOB.id], lastMessageAt: T0 });
  // Not said whether it is a group: more than one other person makes it one.
  expect(conversationFact(conv({ id: 'c1', group: null, legacy: null, users: [ALICE, BOB] }), SELF).shape).toBe('group');
  expect(conversationFact(conv({ id: 'c1', group: null, legacy: null }), SELF)).not.toHaveProperty('encrypted');
});

test('a message: body as it is, the sender, replies by id or sequence number, reactions per key', () => {
  const f = messageFact(msg({ text: 'see *this* @pat_x', replyTo: { seq: '7', id: null }, reactions: [{ emoji: '❤', users: [ALICE.id], mine: true, attachmentId: null }, { emoji: '❤️', users: [BOB.id], mine: false, attachmentId: null }, { emoji: '😂', users: [BOB.id], mine: false, attachmentId: 'a1' }] }), { selfId: SELF, selfHandle: 'pat_x', idForSeq: (s) => (s === '7' ? 'm7' : undefined) });
  expect(f).toEqual({
    nativeId: 'm1',
    conversation: '1001-2002',
    author: ALICE.id,
    ts: T0,
    body: 'see *this* @pat_x',
    replyTo: 'm7',
    mentionsSelf: true,
    reactions: [{ key: '❤️', authors: [ALICE.id, SELF, BOB.id] }],
    extra: { seq: '1', encrypted: false, attachmentReactions: 1 },
  });
});

test('your own message without a sender id is yours; one XChat cannot decrypt is an encrypted placeholder', () => {
  expect(messageFact(msg({ sender: null, mine: true }), { selfId: SELF }).author).toBe(SELF);
  expect(messageFact(msg({ text: 'secret', undecryptable: true, encrypted: true, attachments: [{ index: 0, id: 'a', kind: null, type: 'Image', mime: null, name: null, size: null, width: null, height: null, url: null }] }), { selfId: SELF })).toMatchObject({ kind: 'encrypted', body: '' });
});

test('attachments are fetched through the page: x-media references, the kind from the type or the mime', () => {
  const f = messageFact(msg({ text: '', attachments: [{ index: 0, id: 'att1', kind: 'MediaAttachment', type: 'Image', mime: null, name: 'p.png', size: 10, width: 2, height: 3, url: 'blob:x' }, { index: 1, id: null, kind: null, type: null, mime: 'video/mp4', name: null, size: null, width: null, height: null, url: null }] }), { selfId: SELF });
  expect(f.kind).toBe('media');
  expect(f.attachments).toEqual([
    { nativeId: 'att1', kind: 'image', name: 'p.png', size: 10, width: 2, height: 3, url: 'x-media://1001-2002/m1/0' },
    { kind: 'video', mime: 'video/mp4', url: 'x-media://1001-2002/m1/1' },
  ]);
  expect(parseMediaRef(mediaRef('3003:1001', 'id/with/slash', 2))).toEqual({ conv: '3003:1001', message: 'id/with/slash', index: 2 });
  expect(parseMediaRef('https://x.com/a')).toBeNull();
  expect(parseMediaRef('x-media://a/b/c')).toBeNull();
});

test("outgoing: dither-chat's Markdown flattened to what an X message says", () => {
  const handle = (id: string) => (id === ALICE.id ? 'alice_a' : undefined);
  expect(toPlain('**bold** and *it* and ~~gone~~ ||spoiler|| <@2002> <@9>', handle)).toBe('bold and it and gone spoiler @alice_a @9');
  expect(toPlain('[site](https://e.example) https://x.com `**code**`', handle)).toBe('site (https://e.example) https://x.com **code**');
  expect(toPlain('2*3*4 stays', handle)).toBe('2*3*4 stays');
});
