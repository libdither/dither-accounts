/**
 * map.ts and raw.ts: the hook's rows and records as chat facts, for both backends, and what is dropped and counted.
 */
import { describe, expect, test } from 'bun:test';
import { Mapper, mediaUrl, parseMediaUrl, withMentions } from '../src/map.ts';
import { PaceQueue, typingTime } from '../src/pace.ts';

const SELF = '1001';
const A = '1002';
const B = '1003';
let clock = 1_800_000_000_000;
const now = () => clock;

const lsSnap = () => ({
  threads: [
    { threadKey: A, threadType: 1, lastActivityTimestampMs: clock - 60_000, lastReadWatermarkTimestampMs: clock - 70_000, unreadMessageCount: 1 },
    { threadKey: B, threadType: 15, lastActivityTimestampMs: clock - 90_000 },
    { threadKey: '9001', threadType: 2, threadName: 'Pelican Club', threadPictureUrl: 'https://scontent.xx.fbcdn.net/g.jpg', muteExpireTimeMs: -1, lastActivityTimestampMs: clock - 30_000 },
  ],
  contacts: [
    { id: SELF, name: 'Sam Self' },
    { id: A, name: 'Alice Archer', username: 'alice', profilePictureUrl: 'https://scontent.xx.fbcdn.net/a.jpg' },
    { id: B, name: 'Bob Baker' },
  ],
  participants: [
    { threadKey: A, contactId: SELF },
    { threadKey: A, contactId: A, readWatermarkTimestampMs: clock - 65_000 },
    { threadKey: B, contactId: SELF },
    { threadKey: B, contactId: B },
    { threadKey: '9001', contactId: SELF },
    { threadKey: '9001', contactId: A },
    { threadKey: '9001', contactId: B },
  ],
  messages: [
    { threadKey: A, messageId: 'mid.$1', timestampMs: clock - 80_000, senderId: A, text: 'hello' },
    { threadKey: A, messageId: 'mid.$2', timestampMs: clock - 70_000, senderId: SELF, text: 'hi', offlineThreadingId: '77' },
    { threadKey: A, messageId: 'mid.$3', timestampMs: clock - 60_000, senderId: A, text: '' },
    { threadKey: '9001', messageId: 'mid.$4', timestampMs: clock - 30_000, senderId: B, text: 'hey Sam!', mentionOffsets: ['4'], mentionLengths: ['3'], mentionIds: [SELF] },
    { threadKey: A, messageId: 'mid.$gone', timestampMs: clock - 50_000, senderId: A, isUnsent: true },
  ],
  reactions: [{ threadKey: A, messageId: 'mid.$2', actorId: A, reaction: '❤' }],
  attachments: [{ threadKey: A, messageId: 'mid.$3', attachmentFbid: '555', previewUrl: 'https://scontent.xx.fbcdn.net/c.png', previewUrlMimeType: 'image/png', filename: 'cat.png', filesize: 68, previewWidth: 1, previewHeight: 1 }],
});

describe('LightSpeed rows to chat facts', () => {
  test('the snapshot: people, chats by shape, backfill with mentions, media, reactions, read state and receipts', () => {
    const m = new Mapper('messenger', now);
    const evs = m.lsSnapshot(lsSnap(), { id: SELF });
    const ids = evs.filter((e) => e.t === 'identity').map((e: any) => e.identity);
    expect(ids.find((i) => i.nativeId === SELF)).toEqual({ nativeId: SELF, displayName: 'Sam Self', isSelf: true });
    const alice = ids.find((i) => i.nativeId === A);
    expect(alice.handle).toBe('alice');
    expect(parseMediaUrl(alice.avatarUrl)).toEqual({ k: 'url', u: 'https://scontent.xx.fbcdn.net/a.jpg' });
    const convs = Object.fromEntries(evs.filter((e) => e.t === 'conversation').map((e: any) => [e.conversation.nativeId, e.conversation]));
    expect(convs[A]).toMatchObject({ shape: 'direct', participants: [A, SELF].sort() });
    expect(convs[A].name).toBeUndefined();
    expect(convs[B]).toMatchObject({ shape: 'direct', encrypted: true });
    expect(convs['9001']).toMatchObject({ shape: 'group', name: 'Pelican Club', mute: { level: 'none' } });
    const msgs = evs.filter((e) => e.t === 'message') as any[];
    expect(msgs.every((e) => e.live === false)).toBe(true);
    expect(msgs.map((e) => e.message.nativeId)).toEqual(['mid.$1', 'mid.$2', 'mid.$3', 'mid.$4']);
    expect(msgs[1].message.reactions).toEqual([{ key: '❤️', authors: [A] }]);
    expect(msgs[2].message).toMatchObject({ kind: 'media', body: '', attachments: [{ nativeId: '555', kind: 'image', mime: 'image/png', name: 'cat.png', size: 68, width: 1, height: 1 }] });
    expect(parseMediaUrl(msgs[2].message.attachments[0].url)).toMatchObject({ k: 'ls', t: A, m: 'mid.$3', a: '555', f: 'full' });
    expect(msgs[3].message).toMatchObject({ body: 'hey <@1001>!', mentionsSelf: true });
    expect(evs).toContainEqual({ t: 'read', conversation: A, upToTs: clock - 70_000, unread: 1 });
    expect(evs).toContainEqual({ t: 'receipt', conversation: A, messages: ['mid.$2'], who: A, state: 'read', ts: clock - 65_000 });
    // Not one reaction event for what the snapshot already holds.
    expect(evs.some((e) => e.t === 'reaction')).toBe(false);
  });

  test('changes: live messages, reactions that replace, typing, edits, unsends, repeats that say nothing', () => {
    const m = new Mapper('messenger', now);
    m.lsSnapshot(lsSnap(), { id: SELF });
    clock += 1000;
    const row = { threadKey: A, messageId: 'mid.$5', timestampMs: clock, senderId: A, text: 'new!' };
    const a = m.lsChanges([{ table: 'messages', op: 'add', row }]);
    expect(a).toEqual([{ t: 'message', message: { nativeId: 'mid.$5', conversation: A, author: A, ts: clock, body: 'new!' }, live: true }]);
    expect(m.lsChanges([{ table: 'messages', op: 'put', row }])).toEqual([]);
    expect(m.lsChanges([{ table: 'reactions', op: 'add', row: { threadKey: A, messageId: 'mid.$5', actorId: B, reaction: '👍' } }])).toEqual([{ t: 'reaction', conversation: A, message: 'mid.$5', author: B, key: '👍' }]);
    expect(m.lsChanges([{ table: 'reactions', op: 'put', row: { threadKey: A, messageId: 'mid.$5', actorId: B, reaction: '😮' } }])).toEqual([
      { t: 'reaction', conversation: A, message: 'mid.$5', author: B, key: '👍', remove: true },
      { t: 'reaction', conversation: A, message: 'mid.$5', author: B, key: '😮' },
    ]);
    expect(m.lsChanges([{ table: 'reactions', op: 'delete', row: { threadKey: A, messageId: 'mid.$5', actorId: B, reaction: '😮' } }])).toEqual([{ t: 'reaction', conversation: A, message: 'mid.$5', author: B, key: '😮', remove: true }]);
    expect(m.lsChanges([{ table: 'typing_indicator', op: 'add', row: { threadKey: A, senderId: A } }])).toEqual([{ t: 'typing', conversation: A, author: A }]);
    expect(m.lsChanges([{ table: 'typing_indicator', op: 'delete', row: { threadKey: A, senderId: A } }])).toEqual([{ t: 'typing', conversation: A, author: A, stop: true }]);
    clock += 1000;
    const edited = m.lsChanges([{ table: 'messages', op: 'put', row: { ...row, text: 'new, edited', editCount: 1 } }]) as any[];
    expect(edited[0].message).toMatchObject({ body: 'new, edited', editedTs: clock });
    expect(edited[0].live).toBe(false);
    expect(m.lsChanges([{ table: 'messages', op: 'put', row: { ...row, text: '', isUnsent: true } }])).toEqual([{ t: 'delete', conversation: A, nativeId: 'mid.$5' }]);
    // Attachments arrive after their message: the message again, with them.
    const pic = m.lsChanges([{ table: 'attachments', op: 'add', row: { threadKey: A, messageId: 'mid.$1', attachmentFbid: '9', playableUrl: 'https://video.xx.fbcdn.net/v.mp4', playableUrlMimeType: 'video/mp4' } }]) as any[];
    expect(pic[0].message.attachments[0]).toMatchObject({ nativeId: '9', kind: 'video' });
  });

  test('our own message waits for the server’s copy; the optimistic one is never said', () => {
    const m = new Mapper('messenger', now);
    m.lsSnapshot(lsSnap(), { id: SELF });
    clock += 1000;
    expect(m.lsChanges([{ table: 'messages', op: 'add', row: { threadKey: A, messageId: 'mid.$opt', timestampMs: clock, senderId: SELF, text: 'mine', offlineThreadingId: '4242', sendStatusV2: 1 } }])).toEqual([]);
    expect(m.lsChanges([{ table: 'messages', op: 'delete', row: { threadKey: A, messageId: 'mid.$opt', timestampMs: clock, senderId: SELF, offlineThreadingId: '4242' } }])).toEqual([]);
    expect(m.lsChanges([{ table: 'messages', op: 'add', row: { threadKey: A, messageId: 'mid.$srv', timestampMs: clock + 10, senderId: SELF, text: 'mine', offlineThreadingId: '4242' } }])).toEqual([]);
    expect(m.settle()).toEqual([]);
    clock += 2000;
    const out = m.settle() as any[];
    expect(out.map((e) => [e.t, e.message?.nativeId])).toEqual([['message', 'mid.$srv']]);
    expect(m.ownSaid.at(-1)).toMatchObject({ conversation: A, id: 'mid.$srv', otid: '4242' });
  });

  test('a message deleted for good is said gone after a moment; a replaced copy already said is said gone at once', () => {
    const m = new Mapper('messenger', now);
    m.lsSnapshot(lsSnap(), { id: SELF });
    expect(m.lsChanges([{ table: 'messages', op: 'delete', row: { threadKey: A, messageId: 'mid.$1', timestampMs: clock - 80_000, senderId: A } }])).toEqual([]);
    clock += 2000;
    expect(m.settle()).toEqual([{ t: 'delete', conversation: A, nativeId: 'mid.$1' }]);
    // mid.$2 (otid 77) was said in the snapshot; the server rewrites it under a new id.
    const out = m.lsChanges([{ table: 'messages', op: 'add', row: { threadKey: A, messageId: 'mid.$2b', timestampMs: clock - 70_000, senderId: A, text: 'hi', offlineThreadingId: '77' } }]);
    expect(out[0]).toEqual({ t: 'delete', conversation: A, nativeId: 'mid.$2' });
  });

  test('participants coming and going re-say the chat; a hidden chat is left', () => {
    const m = new Mapper('messenger', now);
    m.lsSnapshot(lsSnap(), { id: SELF });
    const joined = m.lsChanges([{ table: 'participants', op: 'add', row: { threadKey: '9001', contactId: '1004' } }]) as any[];
    expect(joined[0].conversation.participants).toEqual(['1001', '1002', '1003', '1004']);
    expect(m.lsChanges([{ table: 'threads', op: 'put', row: { threadKey: B, threadType: 15, isHidden: true } }])).toEqual([{ t: 'leave', kind: 'conversation', nativeId: B }]);
  });

  test('what does not have the fields a fact needs is dropped and counted, by type', () => {
    const m = new Mapper('messenger', now);
    const snap = lsSnap();
    (snap.messages as any[]).push({ threadKey: A, messageId: 'mid.$x', senderId: A }, { threadKey: A, messageId: 7, timestampMs: 1, senderId: A }, 'junk');
    (snap.threads as any[]).push({ threadKey: '1' });
    m.lsSnapshot(snap, { id: SELF });
    expect(m.drops).toEqual({ 'ls.message': 3, 'ls.thread': 1 });
    m.lsChanges([{ table: 'messages', op: 'add', row: { messageId: 'mid.$y' } }, { table: 'nope', op: 'add', row: {} }, { op: 'eat' }]);
    expect(m.drops).toEqual({ 'ls.message': 4, 'ls.thread': 1, 'ls.change': 1 });
  });
});

const slide = () => ({
  threads: [
    { threadFbid: 't1', threadId: '71', title: 'Alice Archer', isGroup: false, lastActivityMs: clock - 60_000, users: [{ igid: '502', fbid: 'f2', username: 'alice', name: 'Alice Archer', pic: 'https://scontent.cdninstagram.com/a.jpg' }], receipts: [{ fbid: 'f2', ts: clock - 65_000 }, { fbid: 'fs', ts: clock - 61_000 }] },
    { threadFbid: 't2', threadId: '72', title: 'Heron Club', isGroup: true, imageUrl: 'https://scontent.cdninstagram.com/g.jpg', users: [{ igid: '502', fbid: 'f2' }, { igid: '503', username: 'bob' }], receipts: [] },
  ],
  users: [{ fbid: 'f3', igid: '503', name: 'Bob Baker' }],
  messages: [
    { messageId: 'm1', threadFbid: 't1', senderFbid: 'f2', timestampMs: clock - 70_000, text: 'hello', reactions: [{ emoji: '😂', senderFbid: 'fs' }] },
    { messageId: 'm2', threadFbid: 't1', senderFbid: 'fs', timestampMs: clock - 62_000, text: 'hi', replyTo: 'm1' },
    { messageId: 'm3', threadFbid: 't1', senderFbid: 'f2', timestampMs: clock - 60_000, contentType: 'SlideMessageImageContent', attachments: [{ id: 'a1', type: 'XFBSlideAttachment', contentType: 'SlideMessageImageContent', preview: 'https://scontent.cdninstagram.com/p.jpg', width: 2, height: 3 }] },
    { messageId: 'm4', threadFbid: 't2', senderFbid: 'f3', timestampMs: clock - 30_000, text: 'edited words', edits: 1, editedTs: clock - 20_000 },
  ],
});

describe('Slide records to chat facts', () => {
  test('the snapshot: people by their messaging id (Instagram id when that is all there is), chats, messages', () => {
    const m = new Mapper('instagram', now);
    const evs = m.slideSnapshot(slide(), { id: 'fs', eimu: 'fs' });
    const people = evs.filter((e) => e.t === 'identity').map((e: any) => e.identity);
    expect([...new Set(people.map((i) => i.nativeId))].sort()).toEqual(['f2', 'f3']);
    // Bob's records each said a little; the last one said holds all of it.
    expect(people.filter((i) => i.nativeId === 'f3').at(-1)).toEqual({ nativeId: 'f3', displayName: 'Bob Baker', handle: 'bob' });
    const convs = Object.fromEntries(evs.filter((e) => e.t === 'conversation').map((e: any) => [e.conversation.nativeId, e.conversation]));
    expect(convs.t1).toMatchObject({ shape: 'direct', participants: ['f2', 'fs'] });
    expect(convs.t1.name).toBeUndefined();
    expect(convs.t2).toMatchObject({ shape: 'group', name: 'Heron Club', participants: ['f2', 'f3', 'fs'] });
    expect(parseMediaUrl(convs.t2.avatarUrl)?.u).toBe('https://scontent.cdninstagram.com/g.jpg');
    const msgs = evs.filter((e) => e.t === 'message').map((e: any) => e.message);
    expect(msgs.find((x) => x.nativeId === 'm1').reactions).toEqual([{ key: '😂', authors: ['fs'] }]);
    expect(msgs.find((x) => x.nativeId === 'm2').replyTo).toBe('m1');
    expect(msgs.find((x) => x.nativeId === 'm3')).toMatchObject({ kind: 'media', attachments: [{ nativeId: 'a1', kind: 'image', width: 2, height: 3 }] });
    expect(msgs.find((x) => x.nativeId === 'm4').editedTs).toBe(clock - 20_000);
    expect(evs).toContainEqual({ t: 'read', conversation: 't1', upToTs: clock - 61_000 });
    expect(evs).toContainEqual({ t: 'receipt', conversation: 't1', messages: ['m1'], who: 'f2', state: 'read', ts: clock - 65_000 });
  });

  test('records: a new message is live, a reaction changing on a message is a reaction event, deletes, typing', () => {
    const m = new Mapper('instagram', now);
    m.slideSnapshot(slide(), { id: 'fs', eimu: 'fs' });
    clock += 1000;
    const msg = { messageId: 'm5', threadFbid: 't1', senderFbid: 'f2', timestampMs: clock, text: 'new' };
    expect(m.slideRecords({ messages: [msg] })).toEqual([{ t: 'message', message: { nativeId: 'm5', conversation: 't1', author: 'f2', ts: clock, body: 'new' }, live: true }]);
    expect(m.slideRecords({ messages: [{ ...msg, reactions: [{ emoji: '🔥', senderFbid: 'fs' }] }] })).toEqual([{ t: 'reaction', conversation: 't1', message: 'm5', author: 'fs', key: '🔥' }]);
    expect(m.slideRecords({ deleted: [{ thread: 't1', message: 'm5' }, { thread: 't1', message: 'never-said' }] })).toEqual([{ t: 'delete', conversation: 't1', nativeId: 'm5' }]);
    expect(m.slideTyping({ thread: 't1', sender: null, senderIg: '502', on: true, ttl: 12000 })).toEqual([{ t: 'typing', conversation: 't1', author: 'f2', ttl: 12000 }]);
    expect(m.slideTyping({ thread: 't1', sender: 'f2', on: false })).toEqual([{ t: 'typing', conversation: 't1', author: 'f2', stop: true }]);
    expect(m.slideTyping({ thread: null })).toEqual([]);
    expect(m.drops['slide.typing']).toBe(1);
  });

  test('checks: a message or a thread without what it needs, or with fields of the wrong type, is dropped', () => {
    const m = new Mapper('instagram', now);
    const s = slide();
    (s.messages as any[]).push({ messageId: 'mx', threadFbid: 't1', timestampMs: 1 }, { messageId: 'my', threadFbid: 't1', senderFbid: 'f2', timestampMs: '1' }, { messageId: 'mz', threadFbid: 't1', senderFbid: 'f2', timestampMs: 2, text: 5 });
    (s.threads as any[]).push({ threadFbid: 't9' }, { threadFbid: 't8', users: [{}], receipts: [{ fbid: 'x' }] });
    m.slideSnapshot(s, { id: 'fs' });
    expect(m.drops).toEqual({ 'slide.message': 3, 'slide.thread': 1, 'slide.user': 1, 'slide.receipt': 1 });
  });
});

describe('helpers', () => {
  test('media links are opaque and only this account’s parse', () => {
    const u = mediaUrl({ k: 'ls', t: '1', m: 'mid.$1', a: '2', f: 'preview', u: 'https://x.fbcdn.net/y' });
    expect(u.startsWith('meta-media:')).toBe(true);
    expect(parseMediaUrl(u)).toEqual({ k: 'ls', t: '1', m: 'mid.$1', a: '2', f: 'preview', u: 'https://x.fbcdn.net/y' });
    for (const bad of ['https://x.fbcdn.net/y', 'meta-media:%%%', `meta-media:${Buffer.from('{"k":"evil"}').toString('base64url')}`, `meta-media:${Buffer.from('{"k":"ls","t":1}').toString('base64url')}`]) expect(parseMediaUrl(bad)).toBeNull();
  });

  test('mentions: replaced from the end, overlaps and spans past the text ignored', () => {
    expect(withMentions('hi Al and Bo', ['3', '10'], ['2', '2'], ['1', '2'])).toBe('hi <@1> and <@2>');
    expect(withMentions('hi Al', ['3', '2'], ['2', '3'], ['1', '2'])).toBe('hi <@1>');
    expect(withMentions('hi', ['5'], ['2'], ['1'])).toBe('hi');
    expect(withMentions('hi', undefined, undefined, undefined)).toBe('hi');
  });

  test('pacing: one at a time, with gaps, and a wait when asked to', async () => {
    let t = 1_000_000;
    const slept: number[] = [];
    const q = new PaceQueue({ minGapMs: 1000, jitterMs: 0, now: () => t, random: () => 0, sleep: async (ms) => void (slept.push(ms), (t += ms)) });
    const order: string[] = [];
    await Promise.all([q.run('a', async () => void order.push('a')), q.run('b', async () => void order.push('b'))]);
    expect(order).toEqual(['a', 'b']);
    expect(slept).toEqual([1000]);
    await q.run('c', async () => Promise.reject(Object.assign(new Error('slow down'), { retryAfter: 5 }))).catch(() => {});
    await q.run('d', async () => void order.push('d'));
    expect(slept.at(-1)).toBe(5500);
    expect(typingTime('x'.repeat(10))).toBe(300);
    expect(typingTime('x'.repeat(1000))).toBe(4000);
  });
});
