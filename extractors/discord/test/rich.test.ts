/**
 * Rich messages (src/rich.ts): Components V2 flattened, a bot's controls kept, flags, role pings, attachments' alt
 * text, spoilers and voice messages, embeds in full, the system types map.ts left generic, and the two dispatches
 * this adds (a purge, reactions in a batch). The last test runs the facts into dither-chat's hub Store when a
 * checkout is beside this repo (or DITHER_CHAT_REPO), as pipeline.test.ts does.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type * as P from '@dither-chat/protocol';
import { mapMessage, systemMessageText } from '../src/map.ts';
import { messageEvents, newState, translateDispatch, translateSnapshot } from '../src/ingest.ts';
import { embedMore, flattenComponents, MESSAGE_FLAG } from '../src/rich.ts';
import type { RawComponent, RawMessage } from '../src/discord-types.ts';

const SELF = '100000000000000001';
const BOT = { id: '100000000000000009', username: 'helper-bot', bot: true };
const base = (over: Partial<RawMessage> = {}): RawMessage => ({ id: '900000000000000001', channel_id: '300000000000000001', guild_id: '200000000000000001', author: BOT, content: '', timestamp: '2026-11-01T00:00:00.000Z', ...over });

describe('Components V2', () => {
  const v2: RawComponent[] = [
    {
      type: 17,
      components: [
        { type: 10, content: '## Weekly report' },
        { type: 9, components: [{ type: 10, content: 'Builds passed: **12**' }], accessory: { type: 11, media: { url: 'https://cdn.discordapp.com/x/thumb.png', content_type: 'image/png', width: 80, height: 80 }, description: 'a green tick' } },
        { type: 14, divider: true },
        { type: 12, items: [{ media: { url: 'https://media.discordapp.net/a.png', proxy_url: 'https://media.discordapp.net/a.png?p=1', content_type: 'image/png' }, description: 'graph of builds' }, { media: { url: 'https://media.discordapp.net/b.mp4', content_type: 'video/mp4' }, spoiler: true }] },
      ],
    },
    { type: 17, spoiler: true, components: [{ type: 10, content: 'the ending' }] },
    { type: 1, components: [{ type: 2, style: 1, custom_id: 'rerun', label: 'Run again' }, { type: 2, style: 5, url: 'https://ci.example.org/run/1', label: 'Open' }, { type: 2, style: 5, url: 'javascript:alert(1)', label: 'Bad' }] },
    { type: 1, components: [{ type: 3, custom_id: 'pick', placeholder: 'Pick a branch', options: [{ label: 'main', value: 'main', default: true }, { label: 'dev', value: 'dev', emoji: { id: '555', name: 'git' } }] }] },
    { type: 13, file: { url: 'attachment://report.txt' }, name: 'report.txt', size: 120 },
  ];
  const m = base({ flags: MESSAGE_FLAG.IS_COMPONENTS_V2, components: v2, attachments: [{ id: '700', filename: 'report.txt', content_type: 'text/plain', size: 120, url: 'https://cdn.discordapp.com/attachments/1/700/report.txt' }] });

  test('a V2 message is no longer blank: its text in order, its pictures and files as attachments', () => {
    const f = mapMessage(m, SELF);
    expect(f.body).toBe('## Weekly report\n\nBuilds passed: **12**\n\n───\n\n||the ending||');
    expect(f.kind).toBe('text');
    const names = f.attachments!.map((a) => [a.kind, a.url, a.alt ?? null, a.spoiler ?? false]);
    expect(names).toEqual([
      ['file', 'https://cdn.discordapp.com/attachments/1/700/report.txt', null, false],
      ['image', 'https://cdn.discordapp.com/x/thumb.png', 'a green tick', false],
      ['image', 'https://media.discordapp.net/a.png?p=1', 'graph of builds', false],
      ['video', 'https://media.discordapp.net/b.mp4', null, true],
    ]);
  });

  test("a bot's controls are kept as rows, with what pressing them sends; a link button only with an http link", () => {
    const x = mapMessage(m, SELF).extra as P.RichExtra;
    expect(x.application).toBe(BOT.id);
    expect(x.components).toEqual([
      [
        { kind: 'button', style: 'primary', id: 'rerun', label: 'Run again' },
        { kind: 'button', style: 'link', label: 'Open', url: 'https://ci.example.org/run/1' },
        { kind: 'button', style: 'link', label: 'Bad' },
      ],
      [{ kind: 'select', select: 'string', id: 'pick', placeholder: 'Pick a branch', options: [{ label: 'main', value: 'main', default: true }, { label: 'dev', value: 'dev', emoji: '<:git:555>' }] }],
    ]);
  });

  test('classic components on an ordinary message keep its content as the body', () => {
    const f = mapMessage(base({ content: 'Vote below', components: [{ type: 1, components: [{ type: 2, style: 3, custom_id: 'yes', label: 'Yes', emoji: { name: '👍' } }] }] }), SELF);
    expect(f.body).toBe('Vote below');
    expect((f.extra as P.RichExtra).components).toEqual([[{ kind: 'button', style: 'success', id: 'yes', label: 'Yes', emoji: '👍' }]]);
  });

  test("the client's record shape reads the same once the hook has whitelisted it", () => {
    // hook.js turns customId, minValues and proxyUrl into the raw names; what reaches here is always raw.
    expect(flattenComponents([{ type: 10, content: 'hi' }]).body).toBe('hi');
    expect(flattenComponents(undefined)).toMatchObject({ body: '', attachments: [], rows: [] });
  });
});

describe('flags', () => {
  test('sent silently: the fact says so; otherwise nothing', () => {
    expect(mapMessage(base({ content: 'shh', flags: MESSAGE_FLAG.SUPPRESS_NOTIFICATIONS }), SELF).silent).toBe(true);
    expect(mapMessage(base({ content: 'loud' }), SELF).silent).toBeUndefined();
  });

  test('ephemeral, hidden previews, official, suspended author and a crosspost are marked', () => {
    const f = mapMessage(base({ content: 'x', flags: MESSAGE_FLAG.EPHEMERAL | MESSAGE_FLAG.SUPPRESS_EMBEDS | MESSAGE_FLAG.IS_GUILD_OFFICIAL | MESSAGE_FLAG.HIDDEN_SUSPENDED_USER }), SELF);
    expect((f.extra as P.RichExtra).marks).toEqual({ ephemeral: true, suppressEmbeds: true, official: true, hiddenSuspended: true });
    const cross = mapMessage(base({ content: 'news', flags: MESSAGE_FLAG.IS_CROSSPOST, author: { id: '100000000000000077', username: 'Big Server #announcements', bot: true } }), SELF);
    expect((cross.extra as P.RichExtra).crosspost).toEqual({ server: 'Big Server', channel: 'announcements' });
    // Its reference is where it was published from, not a message it answers.
    expect(mapMessage(base({ content: 'news', flags: MESSAGE_FLAG.IS_CROSSPOST, message_reference: { message_id: '900000000000000555', channel_id: '1', guild_id: '2' } }), SELF).replyTo).toBeUndefined();
  });

  test('a message with none of it has no extra at all', () => {
    expect(mapMessage(base({ content: 'plain', author: { id: '100000000000000002', username: 'ann' } }), SELF).extra).toBeUndefined();
  });
});

describe('role mentions', () => {
  const ping = base({ content: 'heads up <@&400000000000000001>', author: { id: '100000000000000002', username: 'ann' }, mention_roles: ['400000000000000001'], mention_role_names: [{ id: '400000000000000001', name: 'Helpers', color: '#5c7cfa' }] });

  test('a ping to a role you hold is a mention of you, not a broadcast; one you do not hold is neither', () => {
    const mine = mapMessage(ping, SELF, { selfRoles: ['400000000000000001'] });
    expect(mine.mentionsSelf).toBe(true);
    expect(mine.mentionsAll).toBeUndefined();
    expect(mapMessage(ping, SELF, { selfRoles: ['400000000000000999'] }).mentionsSelf).toBeUndefined();
    expect(mapMessage(ping, SELF).mentionsSelf).toBeUndefined();
  });

  test('the roles it names come with their names', () => {
    expect((mapMessage(ping, SELF).extra as P.RichExtra).roles).toEqual([{ id: '400000000000000001', name: 'Helpers', color: '#5c7cfa' }]);
  });

  test('your roles come from the snapshot and follow GUILD_MEMBER_UPDATE of you, never of anyone else', () => {
    const st = newState();
    translateSnapshot({ self: { id: SELF, username: 'me' }, selfRoles: { '200000000000000001': ['400000000000000001'] } }, st);
    const seen = (ev: P.AdapterEvent[]) => ev.find((e): e is Extract<P.AdapterEvent, { t: 'message' }> => e.t === 'message')!.message.mentionsSelf;
    expect(seen(messageEvents(ping, st, true))).toBe(true);
    translateDispatch('GUILD_MEMBER_UPDATE', { guildId: '200000000000000001', user: { id: '100000000000000002', username: 'ann' }, roles: [], named: [] }, st);
    expect(seen(messageEvents(ping, st, true))).toBe(true);
    translateDispatch('GUILD_MEMBER_UPDATE', { guildId: '200000000000000001', user: { id: SELF, username: 'me' }, roles: [], before: ['400000000000000001'], named: [] }, st);
    expect(seen(messageEvents(ping, st, true))).toBeUndefined();
  });
});

describe('attachments', () => {
  test('alt text, spoilers (by flag or by name), explicit flags and a voice message', () => {
    const f = mapMessage(
      base({
        content: '',
        flags: MESSAGE_FLAG.IS_VOICE_MESSAGE,
        attachments: [
          { id: '1', filename: 'heron.png', content_type: 'image/png', url: 'https://cdn.discordapp.com/attachments/1/1/heron.png', description: 'a heron in reeds' },
          { id: '2', filename: 'SPOILER_end.png', content_type: 'image/png', url: 'https://cdn.discordapp.com/attachments/1/2/SPOILER_end.png' },
          { id: '3', filename: 'x.png', content_type: 'image/png', url: 'https://cdn.discordapp.com/attachments/1/3/x.png', flags: 8 | 16 },
          { id: '4', filename: 'voice-message.ogg', content_type: 'audio/ogg', url: 'https://cdn.discordapp.com/attachments/1/4/voice-message.ogg', duration_secs: 4.236, waveform: 'AAB/' },
        ],
      }),
      SELF,
    );
    expect(f.attachments!.map((a) => ({ alt: a.alt, spoiler: a.spoiler, explicit: a.explicit, voice: a.voice }))).toEqual([
      { alt: 'a heron in reeds', spoiler: undefined, explicit: undefined, voice: undefined },
      { alt: undefined, spoiler: true, explicit: undefined, voice: undefined },
      { alt: undefined, spoiler: true, explicit: true, voice: undefined },
      { alt: undefined, spoiler: undefined, explicit: undefined, voice: { seconds: 4.2, waveform: 'AAB/' } },
    ]);
  });
});

describe('embeds in full', () => {
  test('colour, footer, timestamp, author icon; a YouTube player page; a GIF as a looping video from the proxy', () => {
    expect(embedMore({ color: 0x5865f2, footer: { text: 'CI', icon_url: 'https://images-ext-1.discordapp.net/f.png' }, timestamp: '2026-11-01T10:00:00.000Z', author: { name: 'bot', icon_url: 'https://images-ext-1.discordapp.net/a.png' } })).toEqual({
      color: '#5865f2',
      footer: 'CI',
      footerIcon: 'https://images-ext-1.discordapp.net/f.png',
      timestamp: Date.parse('2026-11-01T10:00:00.000Z'),
      authorIcon: 'https://images-ext-1.discordapp.net/a.png',
    });
    expect(embedMore({ type: 'video', video: { url: 'https://www.youtube.com/embed/abc', width: 1280, height: 720 } }).video).toEqual({ url: 'https://www.youtube.com/embed/abc', width: 1280, height: 720, player: true });
    expect(embedMore({ type: 'gifv', video: { url: 'https://media.tenor.com/x.mp4', proxy_url: 'https://images-ext-1.discordapp.net/x.mp4' } }).video).toEqual({ url: 'https://images-ext-1.discordapp.net/x.mp4', gifv: true });
    // A video from some other host without Discord's proxy is not played.
    expect(embedMore({ type: 'video', video: { url: 'https://example.org/v.mp4' } }).video).toBeUndefined();
  });

  test('they reach the fact, and a message that hid its previews says so', () => {
    const f = mapMessage(base({ content: 'see', flags: MESSAGE_FLAG.SUPPRESS_EMBEDS, embeds: [{ title: 't', color: 0xff0000 }] }), SELF);
    const x = f.extra as unknown as { embeds: P.EmbedView[] } & P.RichExtra;
    expect(x.embeds[0].color).toBe('#ff0000');
    expect(x.marks?.suppressEmbeds).toBe(true);
  });
});

describe('commands, activities and system types', () => {
  test('"X used /cmd" and a context command', () => {
    const f = mapMessage(base({ type: 20, content: 'rolled 4', interaction_metadata: { type: 2, name: 'roll', user: { id: '100000000000000002', username: 'ann', global_name: 'Ann' } } }), SELF);
    expect((f.extra as P.RichExtra).interaction).toEqual({ kind: 'command', name: 'roll', user: '100000000000000002', userName: 'Ann' });
    const c = mapMessage(base({ type: 23, content: 'translated', interaction: { type: 2, name: 'Translate', user: { id: '100000000000000002', username: 'ann' } } }), SELF);
    expect((c.extra as P.RichExtra).interaction?.kind).toBe('context');
  });

  test('an activity invite', () => {
    const f = mapMessage(base({ content: '', author: { id: '100000000000000002', username: 'ann' }, activity: { type: 1 }, application: { name: 'Chess' } }), SELF);
    expect((f.extra as P.RichExtra).activity).toEqual({ kind: 'join', name: 'Chess' });
  });

  test('stage, stream, discovery and hangout lines read as words, not "updated the channel"', () => {
    const who = { id: '100000000000000002', username: 'ann', global_name: 'Ann' };
    expect(systemMessageText(base({ type: 27, author: who, content: 'Town hall' }))).toBe('Ann started the stage: Town hall');
    expect(systemMessageText(base({ type: 13, author: who }))).toBe('Ann started a stream.');
    expect(systemMessageText(base({ type: 15, author: who }))).toBe('This server is back in Server Discovery.');
    expect(systemMessageText(base({ type: 45, author: who }))).toBe('Ann invited everyone to a voice hangout.');
    expect(systemMessageText(base({ type: 48, author: who, content: 'Your Nitro is ending' }))).toBeNull();
  });
});

describe('a purge and reactions in a batch', () => {
  test('MESSAGE_DELETE_BULK deletes each message', () => {
    expect(translateDispatch('MESSAGE_DELETE_BULK', { channelId: 'c', ids: ['1', '2', 3] }, newState())).toEqual([
      { t: 'delete', conversation: 'c', nativeId: '1' },
      { t: 'delete', conversation: 'c', nativeId: '2' },
    ]);
  });

  test('MESSAGE_REACTION_ADD_MANY adds each one, a super reaction as super; poll votes are left out', () => {
    const st = newState();
    st.selfId = SELF;
    const ev = translateDispatch(
      'MESSAGE_REACTION_ADD_MANY',
      {
        channelId: 'c',
        messageId: 'm',
        reactions: [
          { emoji: { id: null, name: '🔥' }, users: [{ id: '100000000000000002', username: 'ann' }, '100000000000000003'] },
          { emoji: { id: '77', name: 'party' }, reactionType: 1, users: ['100000000000000002'] },
          { emoji: { id: '9', name: '' }, reactionType: 2, users: ['100000000000000002'] },
        ],
      },
      st,
    );
    const reactions = ev.filter((e) => e.t === 'reaction').map((e: any) => [e.author, e.key, e.style ?? 'normal']);
    expect(reactions).toEqual([
      ['100000000000000002', '🔥', 'normal'],
      ['100000000000000003', '🔥', 'normal'],
      ['100000000000000002', 'party:77', 'super'],
    ]);
    expect(ev.some((e) => e.t === 'identity')).toBe(true);
  });
});

// ------------------------------------------------------------- into the hub

const HUB_STORE = join(process.env.DITHER_CHAT_REPO ?? resolve(import.meta.dir, '../../../../dither-chat'), 'packages/hub/src/store.ts');
const hub = existsSync(HUB_STORE) ? await import(HUB_STORE) : null;
(hub ? describe : describe.skip)("into dither-chat's hub", () => {
  test('a silent V2 message from a bot is stored with its text, controls and alt text, and shows them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'discord-rich-'));
    try {
      const store = new hub.Store(join(dir, 'hub.sqlite'), (raw: string | null) => raw ?? null);
      const acc = store.createAccount({ network: 'discord', label: 'd', color: '#000', adapter: 'discord' });
      const st = newState();
      for (const ev of translateSnapshot({ self: { id: SELF, username: 'me' }, guilds: [{ id: '200000000000000001', name: 'Server' }], channels: [{ id: '300000000000000001', type: 0, guild_id: '200000000000000001', name: 'ci' }] }, st).events) store.ingest(acc, ev);
      const m = base({
        flags: MESSAGE_FLAG.IS_COMPONENTS_V2 | MESSAGE_FLAG.SUPPRESS_NOTIFICATIONS,
        components: [
          { type: 10, content: 'Deployed' },
          { type: 12, items: [{ media: { url: 'https://media.discordapp.net/a.png', content_type: 'image/png' }, description: 'the dashboard' }] },
          { type: 1, components: [{ type: 2, style: 1, custom_id: 'undo', label: 'Undo' }] },
        ],
      });
      for (const ev of messageEvents(m, st, true)) store.ingest(acc, ev);
      const row = store.db.query('SELECT * FROM message WHERE native_id = ?').get(m.id);
      const [v] = store.messageViews([row]) as P.MessageView[];
      expect(v.body).toBe('Deployed');
      expect(v.attachments[0].alt).toBe('the dashboard');
      expect(v.rich?.silent).toBe(true);
      expect(v.rich?.components).toEqual([[{ kind: 'button', style: 'primary', id: 'undo', label: 'Undo' }]]);
      store.db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
