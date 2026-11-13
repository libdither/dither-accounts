/** Telegram objects -> facts, with synthetic TL objects (as mtcute gives them). */
import { expect, test } from 'bun:test';
import { Long } from '@mtcute/bun';
import type { tl } from '../src/backend.ts';
import { avatarUrl, convId, mediaUrl, msgId, parseAvatarUrl, parseConv, parseMediaUrl, parseMsg } from '../src/ids.ts';
import { attachmentsOf, conversationOf, identityOfChat, identityOfUser, type MapCtx, messageFact, muteOf, reactionsOf, topicConversation } from '../src/mapping.ts';

const SELF = 100;
const FORUM = 9001;
const ctx: MapCtx = { self: SELF, isForum: (id) => id === FORUM, nameOf: (p) => ({ 200: 'Alice', 300: 'Bob' })[p.id] };

const user = (id: number, o: Partial<tl.RawUser> = {}): tl.RawUser => ({ _: 'user', id, accessHash: Long.fromNumber(id * 7), firstName: `U${id}`, ...o });
const msg = (o: Partial<tl.RawMessage> & { peerId: tl.TypePeer }): tl.RawMessage => ({ _: 'message', id: 1, date: 1_700_000_000, message: '', ...o });
const pu = (userId: number): tl.TypePeer => ({ _: 'peerUser', userId });
const pc = (channelId: number): tl.TypePeer => ({ _: 'peerChannel', channelId });

test('ids: scoped where Telegram numbers per account, global for channels', () => {
  expect(convId(SELF, { kind: 'user', id: 200 })).toBe('dm:100:200');
  expect(convId(SELF, { kind: 'chat', id: 55 })).toBe('group:100:55');
  expect(convId(SELF, { kind: 'channel', id: 77 })).toBe('channel:77');
  expect(convId(SELF, { kind: 'channel', id: 77 }, 3)).toBe('channel:77/3');
  expect(msgId('channel:77/3', 12)).toBe('channel:77#12');
  expect(parseMsg('dm:100:200#5')).toEqual({ conv: 'dm:100:200', ref: { peer: { kind: 'user', id: 200 } }, id: 5 });
  expect(parseConv('channel:77/3')).toEqual({ peer: { kind: 'channel', id: 77 }, topic: 3 });
  expect(parseMediaUrl(mediaUrl('channel:77/3', 9))).toEqual({ conv: 'channel:77', id: 9 });
  expect(parseAvatarUrl(avatarUrl({ kind: 'user', id: 5 }, Long.fromString('-42'), 4))).toEqual({ peer: { kind: 'user', id: 5 }, photoId: '-42', dc: 4 });
});

test('identities: users and channels as authors', () => {
  expect(identityOfUser(user(200, { firstName: 'Alice', lastName: 'L', username: 'alice', contact: true, photo: { _: 'userProfilePhoto', photoId: Long.fromNumber(9), dcId: 2 } }), SELF)).toEqual({ nativeId: '200', displayName: 'Alice L', handle: '@alice', avatarUrl: 'tg://avatar/u200/9?dc=2', contact: true });
  expect(identityOfUser(user(SELF, { self: true, phone: '15551234567', firstName: 'Me' }), SELF)).toMatchObject({ nativeId: '100', handle: '+15551234567', isSelf: true });
  expect(identityOfUser(user(5, { bot: true, usernames: [{ _: 'username', username: 'x_bot', active: true }] }), SELF)).toMatchObject({ isBot: true, handle: '@x_bot' });
  expect(identityOfUser({ _: 'userEmpty', id: 3 }, SELF)).toBeNull();
  expect(identityOfChat({ _: 'channel', id: 77, title: 'News', photo: { _: 'chatPhotoEmpty' }, date: 0, broadcast: true, username: 'news' } as tl.RawChannel)).toEqual({ nativeId: 'channel:77', displayName: 'News', handle: '@news' });
});

test('conversations: every kind of chat', () => {
  const dialog = (peer: tl.TypePeer, o: Partial<tl.RawDialog> = {}): tl.RawDialog => ({ _: 'dialog', peer, topMessage: 1, readInboxMaxId: 1, readOutboxMaxId: 1, unreadCount: 0, unreadMentionsCount: 0, unreadReactionsCount: 0, unreadPollVotesCount: 0, notifySettings: { _: 'peerNotifySettings' }, ...o });
  expect(conversationOf(ctx, { kind: 'user', id: 200 }, { user: user(200) }, dialog(pu(200)), 1_700_000_000)).toEqual({ nativeId: 'dm:100:200', shape: 'direct', participants: ['100', '200'], encrypted: false, archived: false, mute: { level: 'all' }, lastMessageAt: 1_700_000_000_000 });
  expect(conversationOf(ctx, { kind: 'user', id: SELF }, {})).toMatchObject({ nativeId: 'dm:100:100', shape: 'self', name: 'Saved Messages' });
  const basic = { _: 'chat', id: 55, title: 'Weekend', photo: { _: 'chatPhotoEmpty' }, participantsCount: 3, date: 0, version: 1 } as tl.RawChat;
  expect(conversationOf(ctx, { kind: 'chat', id: 55 }, { chat: basic }, dialog({ _: 'peerChat', chatId: 55 }, { folderId: 1, notifySettings: { _: 'peerNotifySettings', muteUntil: 2_147_483_647 } }))).toMatchObject({ nativeId: 'group:100:55', shape: 'group', variant: 'text', name: 'Weekend', archived: true, mute: { level: 'none' } });
  const ch = (o: Partial<tl.RawChannel>) => ({ _: 'channel', id: 77, title: 'C', photo: { _: 'chatPhotoEmpty' }, date: 0, ...o }) as tl.RawChannel;
  expect(conversationOf(ctx, { kind: 'channel', id: 77 }, { chat: ch({ broadcast: true }) }).variant).toBe('announcement');
  expect(conversationOf(ctx, { kind: 'channel', id: 77 }, { chat: ch({ megagroup: true }) }).variant).toBe('text');
  expect(conversationOf(ctx, { kind: 'channel', id: 77 }, { chat: ch({ megagroup: true, forum: true }) }).variant).toBe('forum');
  const topic = { _: 'forumTopic', id: 4, date: 0, peer: pc(FORUM), title: 'Bugs', iconColor: 0, topMessage: 5, readInboxMaxId: 0, readOutboxMaxId: 0, unreadCount: 0, unreadMentionsCount: 0, unreadReactionsCount: 0, unreadPollVotesCount: 0, fromId: pu(1), notifySettings: { _: 'peerNotifySettings' } } as tl.RawForumTopic;
  expect(topicConversation(ctx, FORUM, topic)).toMatchObject({ nativeId: `channel:${FORUM}/4`, shape: 'thread', name: 'Bugs', parentConversation: `channel:${FORUM}` });
  expect(muteOf({ _: 'peerNotifySettings', muteUntil: 2_000_000_000 }, 1_700_000_000)).toEqual({ level: 'none', until: 2_000_000_000_000 });
});

test('messages: authors, replies, mentions, edits', () => {
  const out = messageFact(ctx, msg({ id: 2, out: true, peerId: pu(200), message: 'Yes, 10am', entities: [{ _: 'messageEntityBold', offset: 5, length: 4 }] }))!;
  expect(out).toEqual({ nativeId: 'dm:100:200#2', conversation: 'dm:100:200', author: '100', ts: 1_700_000_000_000, body: 'Yes, **10am**' });
  const inbound = messageFact(ctx, msg({ id: 3, peerId: pu(200), message: 'Great', replyTo: { _: 'messageReplyHeader', replyToMsgId: 2 }, editDate: 1_700_000_100, mentioned: true }))!;
  expect(inbound).toMatchObject({ author: '200', replyTo: 'dm:100:200#2', editedTs: 1_700_000_100_000, mentionsSelf: true });
  // A group message naming you
  const named = messageFact(ctx, msg({ id: 8, peerId: { _: 'peerChat', chatId: 55 }, fromId: pu(300), message: 'Me can you?', entities: [{ _: 'messageEntityMentionName', offset: 0, length: 2, userId: SELF }] }))!;
  expect(named).toMatchObject({ conversation: 'group:100:55', author: '300', body: '<@100> can you?', mentionsSelf: true });
  // A channel post without an author is the channel's
  expect(messageFact(ctx, msg({ id: 1, peerId: pc(77), post: true, message: 'News', views: 12 }))).toMatchObject({ nativeId: 'channel:77#1', author: 'channel:77', extra: { views: 12 } });
  // An edit Telegram hides is not an edit
  expect(messageFact(ctx, msg({ peerId: pu(200), editDate: 5, editHide: true }))!.editedTs).toBeUndefined();
  expect(messageFact(ctx, { _: 'messageEmpty', id: 1 })).toBeNull();
});

test('forum messages land in their topic; a reply inside a topic still replies', () => {
  const general = messageFact(ctx, msg({ id: 1, peerId: pc(FORUM), fromId: pu(200), message: 'hello' }))!;
  expect(general).toMatchObject({ nativeId: `channel:${FORUM}#1`, conversation: `channel:${FORUM}/1` });
  expect(general.replyTo).toBeUndefined();
  const top = messageFact(ctx, msg({ id: 3, peerId: pc(FORUM), fromId: pu(SELF), out: true, message: 'v0.1', replyTo: { _: 'messageReplyHeader', forumTopic: true, replyToMsgId: 2 } }))!;
  expect(top).toMatchObject({ conversation: `channel:${FORUM}/2` });
  expect(top.replyTo).toBeUndefined();
  const reply = messageFact(ctx, msg({ id: 6, peerId: pc(FORUM), fromId: pu(300), message: 'ok', replyTo: { _: 'messageReplyHeader', forumTopic: true, replyToMsgId: 3, replyToTopId: 2 } }))!;
  expect(reply).toMatchObject({ conversation: `channel:${FORUM}/2`, replyTo: `channel:${FORUM}#3` });
  const created = messageFact(ctx, { _: 'messageService', id: 4, peerId: pc(FORUM), fromId: pu(200), date: 1, action: { _: 'messageActionTopicCreate', title: 'Bugs', iconColor: 0 } })!;
  expect(created).toMatchObject({ conversation: `channel:${FORUM}/4`, kind: 'system', body: 'created the topic “Bugs”' });
  // Outside a forum the same header is an ordinary reply
  expect(messageFact(ctx, msg({ id: 9, peerId: pc(77), fromId: pu(300), replyTo: { _: 'messageReplyHeader', replyToMsgId: 8 } }))!.replyTo).toBe('channel:77#8');
});

test('service messages in words', () => {
  const s = (action: tl.TypeMessageAction) => messageFact(ctx, { _: 'messageService', id: 1, peerId: { _: 'peerChat', chatId: 55 }, fromId: pu(200), date: 1, action })!;
  expect(s({ _: 'messageActionChatAddUser', users: [300] }).body).toBe('added Bob');
  expect(s({ _: 'messageActionChatEditTitle', title: 'New' }).body).toBe('changed the name to “New”');
  expect(s({ _: 'messageActionPhoneCall', callId: Long.ZERO, duration: 125 })).toMatchObject({ kind: 'call', body: '📞 Call (2 minutes)' });
  expect(s({ _: 'messageActionPhoneCall', callId: Long.ZERO, video: true, reason: { _: 'phoneCallDiscardReasonMissed' } }).body).toBe('📞 Missed video call');
  expect(s({ _: 'messageActionSetMessagesTTL', period: 86400 }).body).toBe('set messages to disappear after 1 day');
});

test('media: photos, files, stickers, places and polls', () => {
  const photo = msg({ id: 4, peerId: pu(300), media: { _: 'messageMediaPhoto', photo: { _: 'photo', id: Long.fromNumber(8001), accessHash: Long.ZERO, fileReference: new Uint8Array(), date: 0, dcId: 2, sizes: [{ _: 'photoStrippedSize', type: 'i', bytes: new Uint8Array() }, { _: 'photoSize', type: 'm', w: 320, h: 240, size: 9000 }, { _: 'photoSizeProgressive', type: 'y', w: 1280, h: 960, sizes: [100, 50000] }] } } });
  expect(attachmentsOf('dm:100:300', photo)).toEqual({ attachments: [{ nativeId: '8001', kind: 'image', mime: 'image/jpeg', name: 'photo_4.jpg', url: 'tg://media/dm:100:300/4', width: 1280, height: 960, size: 50000 }], kind: 'media' });
  const doc = (mimeType: string, attributes: tl.TypeDocumentAttribute[]) => msg({ id: 5, peerId: pu(300), media: { _: 'messageMediaDocument', document: { _: 'document', id: Long.fromNumber(1), accessHash: Long.ZERO, fileReference: new Uint8Array(), date: 0, mimeType, size: 1234, dcId: 2, attributes } } });
  expect(attachmentsOf('x', doc('application/pdf', [{ _: 'documentAttributeFilename', fileName: 'a.pdf' }])).attachments[0]).toMatchObject({ kind: 'file', name: 'a.pdf', size: 1234, mime: 'application/pdf' });
  expect(attachmentsOf('x', doc('video/mp4', [{ _: 'documentAttributeVideo', duration: 3, w: 640, h: 480 }])).attachments[0]).toMatchObject({ kind: 'video', width: 640, height: 480 });
  expect(attachmentsOf('x', doc('audio/ogg', [{ _: 'documentAttributeAudio', duration: 3, voice: true }])).attachments[0].kind).toBe('audio');
  expect(attachmentsOf('x', doc('image/webp', [{ _: 'documentAttributeSticker', alt: '😀', stickerset: { _: 'inputStickerSetEmpty' } }]))).toMatchObject({ kind: 'sticker', text: '😀' });
  const geo = msg({ peerId: pu(300), media: { _: 'messageMediaGeo', geo: { _: 'geoPoint', lat: 1.5, long: 2.5, accessHash: Long.ZERO } } });
  expect(messageFact(ctx, geo)!.body).toBe('📍 Location\nhttps://maps.google.com/?q=1.5,2.5');
  const poll = msg({ peerId: pu(300), media: { _: 'messageMediaPoll', poll: { _: 'poll', id: Long.ZERO, question: { _: 'textWithEntities', text: 'Lunch?', entities: [] }, answers: [{ _: 'pollAnswer', text: { _: 'textWithEntities', text: 'Yes', entities: [] }, option: new Uint8Array([0]) }] } as unknown as tl.RawPoll, results: { _: 'pollResults' } } as tl.RawMessageMediaPoll });
  expect(messageFact(ctx, poll)!.body).toBe('📊 Lunch?\n- Yes');
});

test('reactions: named reactors, totals, your own, custom emoji', () => {
  const r: tl.TypeMessageReactions = {
    _: 'messageReactions',
    results: [
      { _: 'reactionCount', reaction: { _: 'reactionEmoji', emoticon: '❤' }, count: 2, chosenOrder: 0 },
      { _: 'reactionCount', reaction: { _: 'reactionEmoji', emoticon: '🔥' }, count: 5 },
      { _: 'reactionCount', reaction: { _: 'reactionCustomEmoji', documentId: Long.fromNumber(42) }, count: 1 },
    ],
    recentReactions: [
      { _: 'messagePeerReaction', peerId: pu(200), date: 0, reaction: { _: 'reactionEmoji', emoticon: '❤' } },
      { _: 'messagePeerReaction', peerId: pu(300), date: 0, reaction: { _: 'reactionCustomEmoji', documentId: Long.fromNumber(42) } },
    ],
  };
  expect(reactionsOf(ctx, r)).toEqual([
    { key: '❤️', authors: ['200', '100'] },
    { key: '🔥', authors: [], count: 5 },
    { key: 'custom:42', authors: ['300'], emoji: { key: 'custom:42', name: 'custom', url: 'tg://emoji/42' } },
  ]);
});

test('forwards say where from', () => {
  const f = messageFact(ctx, msg({ peerId: pu(200), message: 'x', fwdFrom: { _: 'messageFwdHeader', date: 1_600_000_000, fromId: pc(77), channelPost: 9 } }))!;
  expect(f.forward).toEqual({ ts: 1_600_000_000_000, conversation: 'channel:77', message: 'channel:77#9', author: 'channel:77' });
  const hidden = messageFact(ctx, msg({ peerId: pu(200), message: 'x', fwdFrom: { _: 'messageFwdHeader', date: 1, fromName: 'Private Person' } }))!;
  expect(hidden.forward).toEqual({ ts: 1000, authorName: 'Private Person' });
});
