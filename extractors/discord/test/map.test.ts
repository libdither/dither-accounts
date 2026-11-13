import { describe, expect, test } from 'bun:test';
import {
  attachmentKind,
  REFRESH_BATCH,
  refreshable,
  avatarUrl,
  channelMute,
  channelShape,
  channelVariant,
  isoToMs,
  mapCategory,
  mapChannel,
  mapGuild,
  mapGuildChannel,
  mapMessage,
  mapMute,
  mapPrivateChannel,
  mapReadState,
  mapThread,
  mapUser,
  normalizeMentions,
  pos,
  reactionKey,
  snowflakeToMs,
  systemMessageText,
  stickerAsset,
  LOTTIE_MIME,
} from '../src/map.ts';
import type { RawChannel, RawGuild, RawMessage, RawUser } from '../src/discord-types.ts';

const SELF = '100000000000000001';
const guild: RawGuild = {
  id: '200000000000000001',
  name: 'Rust Programming Language',
  icon: 'abc123',
  description: 'The unofficial community server for Rust',
  rules_channel_id: '300000000000000009',
};

const alice: RawUser = { id: '400000000000000001', username: 'alice.chen', global_name: 'Alice', avatar: 'deadbeef', discriminator: '0' };
const ferris: RawUser = { id: '400000000000000002', username: 'ferris', global_name: null, bot: true };
const self: RawUser = { id: SELF, username: 'quinn_m', global_name: 'quinn' };

describe('snowflake + time', () => {
  test('snowflakeToMs decodes the Discord epoch', () => {
    // snowflake 0 -> Discord epoch (2015-01-01)
    expect(snowflakeToMs('0')).toBe(1420070400000);
    // (1 << 22) == 4194304 -> epoch + 1ms
    expect(snowflakeToMs('4194304')).toBe(1420070400001);
  });
  test('snowflakeToMs tolerates garbage', () => {
    expect(snowflakeToMs('not-a-number')).toBe(0);
  });
  test('isoToMs parses ISO timestamps', () => {
    expect(isoToMs('2024-01-01T00:00:00.000Z')).toBe(Date.parse('2024-01-01T00:00:00.000Z'));
    expect(isoToMs(null)).toBe(0);
    expect(isoToMs('garbage')).toBe(0);
  });
  test('pos zero-pads for string sorting', () => {
    expect(pos(0)).toBe('000000');
    expect(pos(3)).toBe('000003');
    expect(pos(12)).toBe('000012');
    expect(pos(undefined)).toBeUndefined();
    // padded order matches numeric order
    expect(pos(2)! < pos(10)!).toBe(true);
  });
});

describe('identities', () => {
  test('mapUser prefers global_name, keeps handle, flags bot', () => {
    expect(mapUser(alice)).toEqual({
      nativeId: alice.id,
      handle: 'alice.chen',
      displayName: 'Alice',
      avatarUrl: 'https://cdn.discordapp.com/avatars/400000000000000001/deadbeef.webp?size=128',
      isBot: false,
    });
    expect(mapUser(ferris).isBot).toBe(true);
    expect(mapUser(ferris).displayName).toBe('ferris'); // falls back to username
  });
  test('mapUser self/contact flags', () => {
    expect(mapUser(self, { isSelf: true }).isSelf).toBe(true);
    expect(mapUser(alice, { contact: true }).contact).toBe(true);
  });
  test('animated avatars use gif', () => {
    expect(avatarUrl({ id: '1', avatar: 'a_feed' })).toContain('.gif');
    expect(avatarUrl({ id: '1', avatar: null })).toBeUndefined();
  });
});

describe('spaces', () => {
  test('guild -> community with icon + topic', () => {
    const f = mapGuild(guild);
    expect(f.kind).toBe('community');
    expect(f.name).toBe('Rust Programming Language');
    expect(f.topic).toBe('The unofficial community server for Rust');
    expect(f.iconUrl).toContain('/icons/200000000000000001/abc123');
  });
  test('category -> section with guild parent and position', () => {
    const cat: RawChannel = { id: '300000000000000100', type: 4, name: 'Help', guild_id: guild.id, position: 1 };
    const f = mapCategory(cat);
    expect(f.kind).toBe('section');
    expect(f.name).toBe('Help');
    expect(f.parents).toEqual([{ nativeId: guild.id, position: '000001' }]);
  });
  test('category carries a mute through', () => {
    const cat: RawChannel = { id: '300000000000000100', type: 4, name: 'Help', guild_id: guild.id, position: 1 };
    expect(mapCategory(cat, { level: 'none' }).mute).toEqual({ level: 'none' });
  });
});

describe('channel shape + variant', () => {
  test('shape by type', () => {
    expect(channelShape(0)).toBe('channel');
    expect(channelShape(1)).toBe('direct');
    expect(channelShape(3)).toBe('group');
    expect(channelShape(11)).toBe('thread');
    expect(channelShape(15)).toBe('channel');
  });
  test('variant by type', () => {
    expect(channelVariant({ id: '1', type: 0 })).toBe('text');
    expect(channelVariant({ id: '1', type: 5 })).toBe('announcement');
    expect(channelVariant({ id: '1', type: 15 })).toBe('forum');
    expect(channelVariant({ id: '1', type: 16 })).toBe('media');
    expect(channelVariant({ id: '1', type: 2 })).toBe('voice');
    expect(channelVariant({ id: '1', type: 13 })).toBe('stage');
  });
  test('rules channel resolves to the rules variant via the guild', () => {
    const rules: RawChannel = { id: guild.rules_channel_id!, type: 0, name: 'rules', guild_id: guild.id, position: 0 };
    expect(channelVariant(rules, guild)).toBe('rules');
    // same channel without guild context is just text
    expect(channelVariant(rules)).toBe('text');
  });
});

describe('guild channels', () => {
  test('text channel under a category: space is the category, carries position', () => {
    const ch: RawChannel = { id: '300000000000000200', type: 0, name: 'beginners', topic: 'No question is too small', guild_id: guild.id, parent_id: '300000000000000100', position: 2 };
    const f = mapGuildChannel(ch, guild);
    expect(f.shape).toBe('channel');
    expect(f.variant).toBe('text');
    expect(f.name).toBe('beginners');
    expect(f.topic).toBe('No question is too small');
    expect(f.spaces).toEqual([{ nativeId: '300000000000000100', position: '000002' }]);
  });
  test('channel with no category falls back to the guild as its space', () => {
    const ch: RawChannel = { id: '300000000000000201', type: 0, name: 'general', guild_id: guild.id, position: 0 };
    expect(mapGuildChannel(ch, guild).spaces).toEqual([{ nativeId: guild.id, position: '000000' }]);
  });
  test('announcement + forum + voice variants', () => {
    expect(mapGuildChannel({ id: '1', type: 5, name: 'news', guild_id: guild.id }, guild).variant).toBe('announcement');
    expect(mapGuildChannel({ id: '2', type: 15, name: 'help-forum', guild_id: guild.id }, guild).variant).toBe('forum');
    expect(mapGuildChannel({ id: '3', type: 2, name: 'General', guild_id: guild.id }, guild).variant).toBe('voice');
  });
});

describe('threads', () => {
  test('public thread -> thread shape with parentConversation', () => {
    const th: RawChannel = { id: '500000000000000001', type: 11, name: 'Lifetime error with async closures', guild_id: guild.id, parent_id: '300000000000000300', thread_metadata: { archived: false } };
    const f = mapThread(th);
    expect(f.shape).toBe('thread');
    expect(f.name).toBe('Lifetime error with async closures');
    expect(f.parentConversation).toBe('300000000000000300');
    // Said both ways, so a thread opened again shows again (threads.ts).
    expect(f.archived).toBe(false);
  });
  test('announcement thread keeps the announcement variant; archived surfaces', () => {
    const th: RawChannel = { id: '5', type: 10, name: 't', parent_id: '9', thread_metadata: { archived: true } };
    const f = mapThread(th);
    expect(f.variant).toBe('announcement');
    expect(f.archived).toBe(true);
  });
});

describe('private channels', () => {
  test('DM -> direct, no name, self + peer participants', () => {
    const dm: RawChannel = { id: '600000000000000001', type: 1, recipients: [alice] };
    const f = mapPrivateChannel(dm, SELF);
    expect(f.shape).toBe('direct');
    expect(f.name).toBeUndefined();
    expect(f.participants).toEqual([SELF, alice.id]);
  });
  test('group DM with explicit name', () => {
    const g: RawChannel = { id: '600000000000000002', type: 3, name: 'weekend raid', recipients: [alice, ferris], icon: 'xyz' };
    const f = mapPrivateChannel(g, SELF);
    expect(f.shape).toBe('group');
    expect(f.name).toBe('weekend raid');
    expect(f.participants).toEqual([SELF, alice.id, ferris.id]);
    expect(f.avatarUrl).toContain('/channel-icons/600000000000000002/xyz');
  });
  test("group DM without an icon: the client's default picture", () => {
    const g: RawChannel = { id: '600000000000000004', type: 3, recipients: [alice], default_icon: 'https://discord.com/assets/0123abcd.png' };
    expect(mapPrivateChannel(g, SELF).avatarUrl).toBe('https://discord.com/assets/0123abcd.png');
    expect(mapPrivateChannel({ ...g, icon: 'xyz' }, SELF).avatarUrl).toContain('/channel-icons/600000000000000004/xyz');
    expect(mapPrivateChannel({ ...g, default_icon: undefined }, SELF).avatarUrl).toBeUndefined();
  });
  test('nameless group DM falls back to recipient names', () => {
    const g: RawChannel = { id: '600000000000000003', type: 3, recipients: [alice, ferris] };
    expect(mapPrivateChannel(g, SELF).name).toBe('Alice, ferris');
  });
  test('mapChannel dispatches and skips categories', () => {
    expect(mapChannel({ id: '1', type: 4, name: 'cat', guild_id: guild.id }, { selfId: SELF })).toBeNull();
    expect(mapChannel({ id: '2', type: 1, recipients: [alice] }, { selfId: SELF })!.shape).toBe('direct');
    expect(mapChannel({ id: '3', type: 11, parent_id: '9' }, { selfId: SELF })!.shape).toBe('thread');
    expect(mapChannel({ id: '4', type: 0, guild_id: guild.id, position: 0 }, { selfId: SELF, guild })!.shape).toBe('channel');
  });
});

describe('attachments', () => {
  test('kind from content_type then extension', () => {
    expect(attachmentKind({ url: 'x', content_type: 'image/png' })).toBe('image');
    expect(attachmentKind({ url: 'x', content_type: 'video/mp4' })).toBe('video');
    expect(attachmentKind({ url: 'x', content_type: 'audio/ogg' })).toBe('audio');
    expect(attachmentKind({ url: 'x', content_type: 'application/pdf' })).toBe('file');
    expect(attachmentKind({ url: 'https://cdn/clip.webm' })).toBe('video'); // no content_type
    expect(attachmentKind({ filename: 'photo.JPG', url: 'x' })).toBe('image');
  });
});

describe('messages', () => {
  const base: RawMessage = {
    id: '700000000000000001',
    channel_id: '300000000000000200',
    guild_id: guild.id,
    author: alice,
    content: 'hello **world**',
    timestamp: '2024-06-01T12:00:00.000Z',
  };

  test('ordinary message: content, author, ts, kind text', () => {
    const f = mapMessage(base, SELF);
    expect(f.nativeId).toBe(base.id);
    expect(f.conversation).toBe(base.channel_id);
    expect(f.author).toBe(alice.id);
    expect(f.ts).toBe(Date.parse('2024-06-01T12:00:00.000Z'));
    expect(f.kind).toBe('text');
    expect(f.body).toBe('hello **world**');
    expect(f.mentionsSelf).toBeUndefined();
  });

  test('edited timestamp surfaces', () => {
    const f = mapMessage({ ...base, edited_timestamp: '2024-06-01T12:05:00.000Z' }, SELF);
    expect(f.editedTs).toBe(Date.parse('2024-06-01T12:05:00.000Z'));
  });

  test('reply via message_reference -> replyTo', () => {
    const f = mapMessage({ ...base, type: 19, message_reference: { message_id: '700000000000000000', channel_id: base.channel_id } }, SELF);
    expect(f.replyTo).toBe('700000000000000000');
  });

  test('a forward says where it came from, and is not a reply', () => {
    const f = mapMessage(
      { ...base, content: '', message_reference: { type: 1, channel_id: '500', message_id: '600', guild_id: '400' }, message_snapshots: [{ content: 'hello', timestamp: '2026-11-03T00:24:36.258000+00:00' }] },
      SELF,
    );
    expect(f.forward).toEqual({ conversation: '500', message: '600', space: '400', ts: Date.parse('2026-11-03T00:24:36.258Z') });
    expect(f.replyTo).toBeUndefined();
    expect(f.body).toBe('hello');
    expect(mapMessage({ ...base, message_reference: { message_id: '600', channel_id: base.channel_id } }, SELF).forward).toBeUndefined();
  });

  test('a forward, a sticker and a poll say something despite empty content', () => {
    const empty = { ...base, content: '' };
    const att = { id: '9', filename: 'a.png', url: 'https://cdn.discordapp.com/a.png' };
    const forward = mapMessage({ ...empty, message_snapshots: [{ content: 'line one\nline two', attachments: [att], embeds: [{ title: 'card' }] }] }, SELF);
    // Shown as a card around the content, so not quoted.
    expect(forward.body).toBe('line one\nline two');
    expect(forward.attachments?.map((a) => a.nativeId)).toEqual(['9']);
    expect((forward.extra as any).embeds[0].title).toBe('card');
    // A sticker from an older hook, with no id, can only be named.
    expect(mapMessage({ ...empty, sticker_items: [{ name: 'wave' }] }, SELF).body).toBe('[sticker: wave]');
    expect(mapMessage({ ...empty, poll: { question: 'Tea?', answers: ['yes', 'no'] } }, SELF).body).toBe('**Tea?**\n- yes\n- no');
    expect(mapMessage({ ...empty, type: 20 }, SELF).kind).toBe('text');
  });

  test('a sticker is an attachment of its own, in its format', () => {
    const empty = { ...base, content: '' };
    const png = mapMessage({ ...empty, sticker_items: [{ id: '700000000000000001', name: 'Wave', format_type: 1 }] }, SELF);
    expect(png.kind).toBe('sticker');
    expect(png.body).toBe('');
    expect(png.attachments).toEqual([
      { nativeId: 'sticker:700000000000000001', kind: 'image', mime: 'image/png', name: 'Wave', width: 160, height: 160, url: 'https://cdn.discordapp.com/stickers/700000000000000001.png' },
    ]);
    const gif = mapMessage({ ...empty, sticker_items: [{ id: '700000000000000002', name: 'Dance', format_type: 4 }] }, SELF);
    expect(gif.attachments?.[0].url).toBe('https://media.discordapp.net/stickers/700000000000000002.gif');
    const lottie = mapMessage({ ...empty, sticker_items: [{ id: '700000000000000003', name: 'Wumpus', format_type: 3 }] }, SELF);
    expect(lottie.attachments?.[0]).toMatchObject({ mime: LOTTIE_MIME, url: 'https://cdn.discordapp.com/stickers/700000000000000003.json' });
    // With words, it is a text message that carries a sticker.
    const both = mapMessage({ ...base, content: 'hi', sticker_items: [{ id: '700000000000000001', name: 'Wave', format_type: 2 }] }, SELF);
    expect(both.kind).toBe('text');
    expect(both.body).toBe('hi');
    expect(both.attachments?.[0].nativeId).toBe('sticker:700000000000000001');
    // An id that is not a snowflake makes no link.
    expect(stickerAsset({ id: '../x', name: 'bad', format_type: 1 })).toBeNull();
  });

  test('mentions self by id, by <@!nick>, and @everyone', () => {
    expect(mapMessage({ ...base, content: `hey <@${SELF}>`, mentions: [self] }, SELF).mentionsSelf).toBe(true);
    expect(mapMessage({ ...base, content: `hey <@!${SELF}>` }, SELF).body).toBe(`hey <@${SELF}>`);
    expect(mapMessage({ ...base, content: `hey <@!${SELF}>` }, SELF).mentionsSelf).toBe(true);
    expect(mapMessage({ ...base, content: 'all hands', mention_everyone: true }, SELF).mentionsSelf).toBe(true);
    // @everyone notifies like a mention, but is marked as not addressed to you by name.
    expect(mapMessage({ ...base, content: 'all hands', mention_everyone: true }, SELF).mentionsAll).toBe(true);
    expect(mapMessage({ ...base, content: `all hands, esp <@${SELF}>`, mention_everyone: true, mentions: [self] }, SELF).mentionsAll).toBeUndefined();
    expect(mapMessage({ ...base, content: `hey <@${SELF}>`, mentions: [self] }, SELF).mentionsAll).toBeUndefined();
    expect(mapMessage({ ...base, content: 'no ping', mentions: [alice] }, SELF).mentionsSelf).toBeUndefined();
  });

  test('attachments -> facts and media kind when no text', () => {
    const f = mapMessage(
      { ...base, content: '', attachments: [{ id: '9', filename: 'ferris.png', content_type: 'image/png', size: 1234, width: 480, height: 360, url: 'https://cdn.discordapp.com/attachments/1/9/ferris.png' }] },
      SELF,
    );
    expect(f.kind).toBe('media');
    expect(f.attachments).toHaveLength(1);
    expect(f.attachments![0]).toMatchObject({ nativeId: '9', kind: 'image', mime: 'image/png', name: 'ferris.png', size: 1234, width: 480, height: 360 });
  });

  test('embeds fold into extra', () => {
    const f = mapMessage(
      { ...base, embeds: [{ type: 'link', title: 'Rust blog', description: 'release notes', url: 'https://blog.rust-lang.org', image: { url: 'https://img/x.png' } }] },
      SELF,
    );
    expect((f.extra as any).embeds[0]).toEqual({ type: 'link', title: 'Rust blog', description: 'release notes', url: 'https://blog.rust-lang.org', provider: undefined, image: 'https://img/x.png' });
  });

  test('reactions snapshot: me -> self author, others unknown without a fetch', () => {
    const f = mapMessage(
      { ...base, reactions: [{ emoji: { id: null, name: '🎉' }, count: 3, me: true }, { emoji: { id: '55', name: 'ferris' }, count: 1, me: false }] },
      SELF,
    );
    expect(f.reactions).toEqual([
      { key: '🎉', count: 3, authors: [SELF] },
      { key: 'ferris:55', count: 1, authors: [], emoji: { key: 'ferris:55', name: 'ferris', url: 'https://cdn.discordapp.com/emojis/55.webp?size=64', animated: false } },
    ]);
  });

  test('reactions snapshot: super reactions count apart, with their colours', () => {
    const f = mapMessage(
      {
        ...base,
        reactions: [{ emoji: { id: '7', name: 'party', animated: true }, count: 5, count_details: { normal: 2, burst: 3 }, burst_count: 3, me: false, me_burst: true, burst_colors: ['#ff0000', '#00ff00'] }],
      },
      SELF,
    );
    expect(f.reactions).toMatchObject([
      { key: 'party:7', style: 'super', count: 3, authors: [SELF], colors: ['#ff0000', '#00ff00'], emoji: { animated: true, url: 'https://cdn.discordapp.com/emojis/7.webp?size=64&animated=true' } },
      { key: 'party:7', count: 2, authors: [] },
    ]);
    expect(f.reactions![1].style).toBeUndefined();
  });

  test('system messages: kind system + readable text', () => {
    expect(mapMessage({ ...base, type: 7, content: '' }, SELF)).toMatchObject({ kind: 'system', body: 'Alice joined the server.' });
    expect(mapMessage({ ...base, type: 6, content: '' }, SELF).body).toBe('Alice pinned a message to this channel.');
    const boost = mapMessage({ ...base, type: 8, content: '' }, SELF);
    expect(boost.kind).toBe('system');
    expect(boost.body).toContain('boosted');
  });

  test('thread starter message: type 21 drops the reference, keeps content', () => {
    const f = mapMessage({ ...base, type: 21, content: 'original text', message_reference: { message_id: 'xyz' } }, SELF);
    expect(f.replyTo).toBeUndefined();
    expect(f.kind).toBe('text');
    expect(f.body).toBe('original text');
  });

  test('message carrying a thread object -> threadRoot', () => {
    const f = mapMessage({ ...base, thread: { id: '500000000000000009', type: 11, name: 'bootstrap refactor' } }, SELF);
    expect(f.threadRoot).toBe('500000000000000009');
  });

  test('ts falls back to the snowflake when timestamp is bad', () => {
    const f = mapMessage({ ...base, timestamp: 'nope' }, SELF);
    expect(f.ts).toBe(snowflakeToMs(base.id));
  });
});

describe('helpers', () => {
  test('reactionKey', () => {
    expect(reactionKey({ id: null, name: '👍' })).toBe('👍');
    expect(reactionKey({ id: '123', name: 'blobcat' })).toBe('blobcat:123');
  });
  test('normalizeMentions only touches nickname mentions', () => {
    expect(normalizeMentions('<@!1> and <@2> and <@&3>')).toBe('<@1> and <@2> and <@&3>');
  });
  test('systemMessageText names whom a group gained or lost', () => {
    const ann = { id: '400000000000000001', username: 'ann', global_name: 'Ann' } as RawUser;
    const bo = { id: '400000000000000002', username: 'bo' } as RawUser;
    expect(systemMessageText({ type: 1, author: ann, mentions: [bo] } as RawMessage)).toBe('Ann added bo to the group.');
    expect(systemMessageText({ type: 1, author: ann } as RawMessage)).toBe('Ann added someone to the group.');
    expect(systemMessageText({ type: 2, author: ann, mentions: [bo] } as RawMessage)).toBe('Ann removed bo from the group.');
    expect(systemMessageText({ type: 2, author: bo, mentions: [bo] } as RawMessage)).toBe('bo left the group.');
  });

  test('systemMessageText words a friend request accepted (67) from the side of whoever asked', () => {
    const ann = { id: '400000000000000001', username: 'ann', global_name: 'Ann' } as RawUser;
    expect(systemMessageText({ type: 67, author: ann } as RawMessage, SELF)).toBe('Ann accepted your friend request.');
    expect(systemMessageText({ type: 67, author: { ...ann, id: SELF } } as RawMessage, SELF)).toBe('You accepted a friend request.');
    const f = mapMessage({ id: '500', channel_id: '600', author: ann, content: '', timestamp: '2026-11-12T16:07:00Z', type: 67 }, SELF);
    expect(f.kind).toBe('system');
    expect(f.body).toBe('Ann accepted your friend request.');
  });

  test('systemMessageText words the newer types and still says something for an unknown one', () => {
    const ann = { id: '400000000000000001', username: 'ann', global_name: 'Ann' } as RawUser;
    const bo = { id: '400000000000000002', username: 'bo' } as RawUser;
    expect(systemMessageText({ type: 65, author: ann } as RawMessage)).toBe('Ann started a voice hangout.');
    expect(systemMessageText({ type: 61, author: ann, mentions: [bo] } as RawMessage)).toBe('Ann banned bo.');
    expect(systemMessageText({ type: 52, author: ann, content: 'Tea Club' } as RawMessage)).toBe("Ann's application to Tea Club was approved.");
    expect(systemMessageText({ type: 47, author: ann, content: 'What is new' } as RawMessage)).toBeNull();
    expect(systemMessageText({ type: 999, author: ann, content: '' } as RawMessage)).toBe('(unsupported message type 999)');
  });

  test('systemMessageText returns null for ordinary + reply', () => {
    expect(systemMessageText({ type: 0 } as RawMessage)).toBeNull();
    expect(systemMessageText({ type: 19 } as RawMessage)).toBeNull();
    expect(systemMessageText({ type: undefined } as RawMessage)).toBeNull();
  });
});

describe('read state', () => {
  test('last_message_id -> upToTs, mention_count -> mentions', () => {
    const rs = mapReadState({ id: 'c', last_message_id: '4194304', mention_count: 2 });
    expect(rs.upToTs).toBe(1420070400001);
    expect(rs.mentions).toBe(2);
  });
  test('no read marker', () => {
    expect(mapReadState({ id: 'c' })).toEqual({ upToTs: 0, mentions: 0 });
  });
});

describe('mutes', () => {
  test('explicit guild mute -> level none, with until', () => {
    expect(mapMute({ muted: true, mute_config: { end_time: '2030-01-01T00:00:00.000Z' } })).toEqual({ level: 'none', until: Date.parse('2030-01-01T00:00:00.000Z'), muted: true });
  });
  test('message_notifications maps to levels', () => {
    expect(mapMute({ message_notifications: 0 })).toEqual({ level: 'all' });
    expect(mapMute({ message_notifications: 1 })).toEqual({ level: 'mentions' });
    expect(mapMute({ message_notifications: 2 })).toEqual({ level: 'none' });
  });
  test('inherit / unset -> undefined', () => {
    expect(mapMute({ message_notifications: 3 })).toBeUndefined();
    expect(mapMute({})).toBeUndefined();
  });
  test('channelMute reads a per-channel override out of guild settings', () => {
    const gs = { guild_id: guild.id, channel_overrides: [{ channel_id: '300000000000000200', muted: true }] };
    expect(channelMute(gs, '300000000000000200')).toEqual({ level: 'none', muted: true });
    expect(channelMute(gs, 'nope')).toBeUndefined();
    expect(channelMute(undefined, 'x')).toBeUndefined();
  });
});

describe('refreshable', () => {
  test('only Discord attachment links, no repeats, at most a batch', () => {
    const a = 'https://cdn.discordapp.com/attachments/1/2/a.png?ex=1&is=2&hm=3';
    const b = 'https://media.discordapp.net/attachments/1/2/b.png';
    expect(refreshable([a, a, b, 'https://cdn.discordapp.com/avatars/1/x.png', 'https://evil.example/attachments/1', 'http://cdn.discordapp.com/attachments/1', 7, null])).toEqual([a, b]);
    expect(refreshable('nope')).toEqual([]);
    expect(refreshable(Array.from({ length: 80 }, (_, i) => `https://cdn.discordapp.com/attachments/1/${i}/x.png`))).toHaveLength(REFRESH_BATCH);
  });
});
