/**
 * End-to-end mapping proof WITHOUT a browser: build a realistic raw Discord
 * snapshot, run it through the adapter's own translate layer, and feed the
 * resulting facts into a REAL hub Store. Then assert the hub's bootstrap view --
 * the exact shapes the PWA would render. This exercises map.ts + ingest.ts +
 * the hub's ingest + deterministic ids all at once.
 *
 * The hub is dither-chat's: this test needs a dither-chat checkout beside this repo (or DITHER_CHAT_REPO) and is
 * skipped without one.
 */
import { afterAll, beforeAll, describe as describeAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hubId } from '@dither-chat/protocol/ids';
import type * as P from '@dither-chat/protocol';
import { answerOutcome, joinOutcome, relationshipEvents, snapshotRequests } from '../src/add.ts';
import { addedFacts, messageEvents, newState, openedDirect, translateDispatch, translateSnapshot } from '../src/ingest.ts';
import type { RawSnapshot } from '../src/discord-types.ts';

const HUB_STORE = join(process.env.DITHER_CHAT_REPO ?? resolve(import.meta.dir, '../../../../dither-chat'), 'packages/hub/src/store.ts');
const hub = existsSync(HUB_STORE) ? await import(HUB_STORE) : null;
/** The hub's request list (its add.ts), as GET /api/requests and the bootstrap give it. */
const hubAdd = hub ? await import(join(HUB_STORE, '../add.ts')) : null;
/** What this test uses of dither-chat's hub Store. */
interface Store {
  bootstrap(): P.Bootstrap;
  messages(conversationId: string, before: number | null, limit: number): P.MessagePage;
  ingest(acc: AccountRow, ev: P.AdapterEvent): string[];
  createAccount(o: { network: P.Network; label: string; color: string; adapter: string }): AccountRow;
  flush(): void;
  db: { close(): void };
}
type AccountRow = { id: string; [k: string]: unknown };
const describe = hub ? describeAll : describeAll.skip;

const GUILD = '200000000000000001';
const CAT_HELP = '300000000000000100';
const CH_BEGINNERS = '300000000000000200';
const CH_RULES = '300000000000000009';
const CH_ANN = '300000000000000005';
const THREAD = '500000000000000001';
const DM = '600000000000000001';
const GDM = '600000000000000002';
const SELF = '100000000000000001';
const ALICE = '400000000000000001';
const FERRIS = '400000000000000002';

const snapshot: RawSnapshot = {
  self: { id: SELF, username: 'quinn_m', global_name: 'quinn' },
  guilds: [{ id: GUILD, name: 'Rust Programming Language', icon: 'abc', description: 'unofficial', rules_channel_id: CH_RULES }],
  channels: [
    { id: CAT_HELP, type: 4, name: 'Help', guild_id: GUILD, position: 1 },
    { id: CH_BEGINNERS, type: 0, name: 'beginners', topic: 'No question is too small', guild_id: GUILD, parent_id: CAT_HELP, position: 2 },
    { id: CH_RULES, type: 0, name: 'rules', guild_id: GUILD, position: 0 },
    { id: CH_ANN, type: 5, name: 'announcements', guild_id: GUILD, parent_id: CAT_HELP, position: 1 },
  ],
  threads: [{ id: THREAD, type: 11, name: 'async closures', guild_id: GUILD, parent_id: CH_BEGINNERS, thread_metadata: { archived: false } }],
  privateChannels: [
    { id: DM, type: 1, recipients: [{ id: ALICE, username: 'alice.chen', global_name: 'Alice' }] },
    { id: GDM, type: 3, name: 'weekend raid', recipients: [{ id: ALICE, username: 'alice.chen', global_name: 'Alice' }, { id: FERRIS, username: 'ferris', bot: true }] },
  ],
  relationships: [{ id: ALICE, type: 1 }],
  users: [{ id: ALICE, username: 'alice.chen', global_name: 'Alice', avatar: 'deadbeef' }, { id: FERRIS, username: 'ferris', bot: true }],
  readStates: [{ id: CH_BEGINNERS, last_message_id: '4194304', mention_count: 1 }],
  guildSettings: [
    { guild_id: GUILD, muted: false, message_notifications: 1, channel_overrides: [{ channel_id: CH_ANN, muted: true }] },
    { guild_id: null, channel_overrides: [] },
  ],
};

let dir: string;
let store: Store;
let acc: AccountRow;

beforeAll(() => {
  if (!hub) return;
  dir = mkdtempSync(join(tmpdir(), 'dither-pipe-'));
  store = new hub.Store(join(dir, 'hub.sqlite'), (raw: string | null) => raw ?? null);
  acc = store.createAccount({ network: 'discord', label: 'throwaway', color: '#5865F2', adapter: 'discord' });

  const st = newState();
  const { events, backfillTargets } = translateSnapshot(snapshot, st);
  // a couple of live events on top of the snapshot
  const live = [
    ...translateDispatch('MESSAGE_CREATE', { message: { id: '700000000000000010', channel_id: CH_BEGINNERS, author: { id: ALICE, username: 'alice.chen', global_name: 'Alice' }, content: `hey <@${SELF}> look at this`, timestamp: '2024-06-01T12:00:00.000Z', mentions: [{ id: SELF }] } }, st),
    ...translateDispatch('TYPING_START', { channelId: DM, userId: ALICE }, st),
  ];
  // feed hello + status so the account looks online, then every fact
  store.ingest(acc, { t: 'hello', network: 'discord', version: 'test', capabilities: ['send', 'history', 'liveView'] });
  store.ingest(acc, { t: 'status', status: 'online', self: { nativeId: SELF, handle: 'quinn_m', displayName: 'quinn', isSelf: true } });
  for (const ev of [...events, ...live]) store.ingest(acc, ev);

  // expose for a backfill assertion
  (globalThis as any).__backfill = backfillTargets;
});

afterAll(() => {
  if (!hub) return;
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('hub ingest of adapter facts', () => {
  test('guild -> community space; category -> section with guild parent + position', () => {
    const boot = store.bootstrap();
    const guild = boot.spaces.find((s) => s.nativeId === GUILD)!;
    expect(guild.kind).toBe('community');
    expect(guild.name).toBe('Rust Programming Language');
    const cat = boot.spaces.find((s) => s.nativeId === CAT_HELP)!;
    expect(cat.kind).toBe('section');
    const edge = boot.edges.find((e) => e.parentId === hubId('spc', 'discord', GUILD) && e.childId === hubId('spc', 'discord', CAT_HELP));
    expect(edge).toBeTruthy();
    expect(edge!.position).toBe('000001');
  });

  test('channels: variants, rules channel, category parent edge, positions', () => {
    const boot = store.bootstrap();
    const beginners = boot.conversations.find((c) => c.nativeId === CH_BEGINNERS)!;
    expect(beginners.shape).toBe('channel');
    expect(beginners.variant).toBe('text');
    expect(beginners.topic).toBe('No question is too small');
    const rules = boot.conversations.find((c) => c.nativeId === CH_RULES)!;
    expect(rules.variant).toBe('rules');
    const ann = boot.conversations.find((c) => c.nativeId === CH_ANN)!;
    expect(ann.variant).toBe('announcement');
    // beginners sits under the Help category at position 2
    const edge = boot.edges.find((e) => e.parentId === hubId('spc', 'discord', CAT_HELP) && e.childId === hubId('cnv', 'discord', CH_BEGINNERS));
    expect(edge!.position).toBe('000002');
  });

  test('announcement channel carries the per-channel mute', () => {
    const boot = store.bootstrap();
    const ann = boot.conversations.find((c) => c.nativeId === CH_ANN)!;
    expect(ann.nativeMute).toEqual({ level: 'none' });
  });

  test('thread -> thread shape with parent conversation', () => {
    const boot = store.bootstrap();
    const th = boot.conversations.find((c) => c.nativeId === THREAD)!;
    expect(th.shape).toBe('thread');
    expect(th.parentId).toBe(hubId('cnv', 'discord', CH_BEGINNERS));
  });

  test('DM -> direct, group DM -> group with participants', () => {
    const boot = store.bootstrap();
    const dm = boot.conversations.find((c) => c.nativeId === DM)!;
    expect(dm.shape).toBe('direct');
    const gdm = boot.conversations.find((c) => c.nativeId === GDM)!;
    expect(gdm.shape).toBe('group');
    expect(gdm.name).toBe('weekend raid');
    expect(gdm.participantIds).toContain(hubId('idn', 'discord', FERRIS));
    expect(gdm.participantIds).toContain(hubId('idn', 'discord', ALICE));
  });

  test('self identity recorded on the account; friend becomes a contact person', () => {
    const boot = store.bootstrap();
    expect(boot.accounts[0].selfIdentityId).toBe(hubId('idn', 'discord', SELF));
    const aliceIdn = boot.identities.find((i) => i.nativeId === ALICE)!;
    expect(aliceIdn.displayName).toBe('Alice');
    expect(aliceIdn.personId).toBeTruthy(); // friend -> promoted to a Person
    const ferrisIdn = boot.identities.find((i) => i.nativeId === FERRIS)!;
    expect(ferrisIdn.isBot).toBe(true);
  });

  test('live mention sets the mention flag and bumps the unread vantage', () => {
    const page = store.messages(hubId('cnv', 'discord', CH_BEGINNERS), null, 50);
    const msg = page.messages.find((m) => m.nativeId === '700000000000000010')!;
    expect(msg.mentionsSelf).toBe(true);
    expect(msg.body).toBe(`hey <@${SELF}> look at this`);
    const boot = store.bootstrap();
    const beginners = boot.conversations.find((c) => c.nativeId === CH_BEGINNERS)!;
    const v = beginners.vantages.find((x) => x.accountId === acc.id)!;
    expect(v.mentions).toBeGreaterThanOrEqual(1);
  });

  test('a message names its author and mentions, once each', () => {
    const st = newState();
    st.selfId = SELF;
    const bot = { id: '400000000000000009', username: 'Midjourney Bot', bot: true };
    const stranger = { id: '400000000000000010', username: 'someone', global_name: 'Some One' };
    const raw = { id: '700000000000000020', channel_id: CH_BEGINNERS, author: bot, content: `done <@${stranger.id}>`, timestamp: '2024-06-01T12:01:00.000Z', mentions: [stranger, { id: SELF, username: 'quinn_m' }], type: 20, embeds: [{ title: 'Job', description: 'finished', image: { url: 'https://cdn.discordapp.com/x.png' } }] };
    const events = messageEvents(raw, st, false);
    expect(events.map((e) => e.t)).toEqual(['identity', 'identity', 'message']);
    expect(messageEvents({ ...raw, id: '700000000000000021' }, st, false).map((e) => e.t)).toEqual(['message']);
    for (const ev of events) store.ingest(acc, ev);

    const page = store.messages(hubId('cnv', 'discord', CH_BEGINNERS), null, 50);
    expect(page.identities.find((i) => i.nativeId === bot.id)).toMatchObject({ displayName: 'Midjourney Bot', isBot: true });
    expect(page.identities.find((i) => i.nativeId === stranger.id)?.displayName).toBe('Some One');
    const msg = page.messages.find((m) => m.nativeId === raw.id)!;
    expect(msg.kind).toBe('text'); // a slash command reply is an ordinary message
    expect(msg.embeds).toMatchObject([{ title: 'Job', description: 'finished' }]);
    expect(msg.embeds[0].image).toBe('https://cdn.discordapp.com/x.png'); // this test Store's signer passes URLs through
  });

  test('the echo of a send in flight is dropped; the real message is not', () => {
    const st = newState();
    st.selfId = SELF;
    const message = { id: '700000000000000030', channel_id: DM, author: { id: SELF, username: 'quinn_m' }, content: 'hi', timestamp: '2024-06-01T12:02:00.000Z' };
    expect(translateDispatch('MESSAGE_CREATE', { message, optimistic: true }, st)).toEqual([]);
    expect(translateDispatch('MESSAGE_CREATE', { message }, st).map((e) => e.t)).toEqual(['message']);
  });

  test('a live reaction names who did it, and the client echo of your own is ignored', () => {
    const st = newState();
    st.selfId = SELF;
    const base = { channelId: CH_BEGINNERS, messageId: '700000000000000010', userId: '400000000000000050', emoji: { id: '7', name: 'party', animated: true } };
    expect(translateDispatch('MESSAGE_REACTION_ADD', { ...base, optimistic: true }, st)).toEqual([]);
    const events = translateDispatch('MESSAGE_REACTION_ADD', { ...base, reactionType: 1, colors: ['#f00'], user: { id: base.userId, username: 'zed', global_name: 'Zed' } }, st);
    expect(events.map((e) => e.t)).toEqual(['identity', 'reaction']);
    expect(events[1]).toMatchObject({ key: 'party:7', style: 'super', colors: ['#f00'], emoji: { name: 'party', animated: true } });
    for (const ev of events) store.ingest(acc, ev);
    const msg = store.messages(hubId('cnv', 'discord', CH_BEGINNERS), null, 50);
    const m = msg.messages.find((x) => x.nativeId === base.messageId)!;
    expect(m.reactions.find((r) => r.key === 'party:7')).toMatchObject({ style: 'super', count: 1, colors: ['#f00'], emoji: { name: 'party', animated: true } });
    expect(msg.identities.find((i) => i.nativeId === base.userId)?.displayName).toBe('Zed');
  });

  test('someone typing: a nickname or display name to show, never you', () => {
    const st = newState();
    st.selfId = SELF;
    expect(translateDispatch('TYPING_START', { channelId: CH_BEGINNERS, userId: '400000000000000060', user: { id: '400000000000000060', username: 'zed', global_name: 'Zed' }, nick: 'Zeddy' }, st)).toEqual([
      { t: 'typing', conversation: CH_BEGINNERS, author: '400000000000000060', name: 'Zeddy' },
    ]);
    expect(translateDispatch('TYPING_START', { channelId: DM, userId: ALICE, user: { id: ALICE, username: 'alice.chen', global_name: 'Alice' }, nick: null }, st)).toEqual([{ t: 'typing', conversation: DM, author: ALICE, name: 'Alice' }]);
    expect(translateDispatch('TYPING_START', { channelId: DM, userId: ALICE }, st)).toEqual([{ t: 'typing', conversation: DM, author: ALICE }]);
    expect(translateDispatch('TYPING_START', { channelId: DM, userId: SELF }, st)).toEqual([]);
  });

  test('a fetched message with no reactions has none left', () => {
    const st = newState();
    st.selfId = SELF;
    const raw = { id: '700000000000000040', channel_id: CH_BEGINNERS, author: { id: ALICE, username: 'alice.chen' }, content: 'x', timestamp: '2024-06-01T12:03:00.000Z' };
    const backfill = messageEvents(raw, st, false).find((e) => e.t === 'message') as Extract<P.AdapterEvent, { t: 'message' }>;
    expect(backfill.message.reactions).toEqual([]);
    const live = messageEvents(raw, st, true).find((e) => e.t === 'message') as Extract<P.AdapterEvent, { t: 'message' }>;
    expect(live.message.reactions).toBeUndefined();
  });

  test('a rename arrives through CHANNEL_UPDATES', () => {
    const st = newState();
    st.selfId = SELF;
    translateDispatch('CHANNEL_UPDATES', { channels: [{ id: GDM, type: 3, name: 'renamed', recipients: [{ id: ALICE, username: 'alice.chen' }] }] }, st).forEach((ev) => store.ingest(acc, ev));
    expect(store.bootstrap().conversations.find((c) => c.nativeId === GDM)?.name).toBe('renamed');
  });

  test('people added to a group are its participants, from the reply and from the gateway after', () => {
    const st = newState();
    st.selfId = SELF;
    const BO = '400000000000000003';
    const bo = { id: BO, username: 'bo', global_name: 'Bo' };
    const group = { id: GDM, type: 3, name: 'weekend raid', recipients: [{ id: ALICE, username: 'alice.chen', global_name: 'Alice' }, { id: FERRIS, username: 'ferris', bot: true }] };
    const people = () => store.bootstrap().conversations.find((c) => c.nativeId === GDM)!.participantIds;
    addedFacts(GDM, { added: [BO], failed: [], users: [bo], channel: group }, st).forEach((ev) => store.ingest(acc, ev));
    expect(people()).toContain(hubId('idn', 'discord', BO));
    expect(people()).toHaveLength(4);
    translateDispatch('CHANNEL_RECIPIENT_ADD', { channelId: GDM, user: bo, channel: { ...group, recipients: [...group.recipients, bo] } }, st).forEach((ev) => store.ingest(acc, ev));
    expect(people()).toHaveLength(4);
    translateDispatch('CHANNEL_RECIPIENT_REMOVE', { channelId: GDM, user: bo, channel: group }, st).forEach((ev) => store.ingest(acc, ev));
    expect(people()).not.toContain(hubId('idn', 'discord', BO));
    expect(people()).toHaveLength(3);
  });

  test('a DM opened from here is one conversation with its peer, whatever the gateway then echoes', () => {
    const st = newState();
    st.selfId = SELF;
    const NEW_DM = '600000000000000009';
    const before = store.bootstrap().conversations.length;
    openedDirect(FERRIS, { channelId: NEW_DM }, st).forEach((ev) => store.ingest(acc, ev));
    const opened = () => store.bootstrap().conversations.find((c) => c.nativeId === NEW_DM)!;
    expect(opened().shape).toBe('direct');
    expect(opened().participantIds).toContain(hubId('idn', 'discord', FERRIS));
    translateDispatch('CHANNEL_CREATE', { channel: { id: NEW_DM, type: 1, recipients: [{ id: FERRIS, username: 'ferris', bot: true }] } }, st).forEach((ev) => store.ingest(acc, ev));
    messageEvents({ id: '700000000000000009', channel_id: NEW_DM, author: { id: SELF, username: 'quinn_m' }, content: 'hi', timestamp: new Date(1_700_000_000_000).toISOString() } as any, st, true).forEach((ev) => store.ingest(acc, ev));
    expect(store.bootstrap().conversations.length).toBe(before + 1);
    expect(opened().shape).toBe('direct');
    expect(opened().lastMessage?.text).toBe('hi');
    store.flush();
  });

  test('a server joined from an invite lands with its categories and channels, and the reply names them', () => {
    const st = newState();
    st.selfId = SELF;
    const NEW_GUILD = '200000000000000002';
    const NEW_CAT = '300000000000000300';
    const NEW_CH = '300000000000000301';
    const { events, result } = joinOutcome(
      {
        guild: { id: NEW_GUILD, name: 'Pixel Club', icon: null, description: 'Weekly challenges', rules_channel_id: null },
        channels: [
          { id: NEW_CAT, type: 4, guild_id: NEW_GUILD, name: 'Start here', position: 0 },
          { id: NEW_CH, type: 0, guild_id: NEW_GUILD, parent_id: NEW_CAT, name: 'welcome', position: 0 },
        ],
        channelId: NEW_CH,
      },
      st,
    );
    for (const ev of events) store.ingest(acc, ev);
    expect(result).toEqual({ space: NEW_GUILD, conversation: NEW_CH });
    const boot = store.bootstrap();
    expect(boot.spaces.find((x) => x.nativeId === NEW_GUILD)?.kind).toBe('community');
    expect(boot.conversations.find((c) => c.nativeId === NEW_CH)?.name).toBe('welcome');
    expect(boot.edges.find((e) => e.parentId === hubId('spc', 'discord', NEW_CAT) && e.childId === hubId('cnv', 'discord', NEW_CH))).toBeTruthy();
    // The gateway's GUILD_CREATE for it afterwards changes nothing.
    const again = translateDispatch('GUILD_CREATE', { guild: { id: NEW_GUILD, name: 'Pixel Club' }, channels: [] }, st);
    expect(again.map((e) => e.t)).toEqual(['space']);
  });

  test('a server joined elsewhere (the live view) comes with its channels from GUILD_CREATE', () => {
    const st = newState();
    st.selfId = SELF;
    const OTHER = '200000000000000003';
    const CH = '300000000000000401';
    translateDispatch('GUILD_CREATE', { guild: { id: OTHER, name: 'Speedrun Archive' }, channels: [{ id: CH, type: 0, guild_id: OTHER, name: 'runs', position: 0 }] }, st).forEach((ev) => store.ingest(acc, ev));
    expect(store.bootstrap().conversations.find((c) => c.nativeId === CH)?.name).toBe('runs');
  });

  test('friend requests: the whole list, a new one, and one answered here', () => {
    const st = newState();
    st.selfId = SELF;
    const ASKER = '400000000000000005';
    const LATER = '400000000000000006';
    store.ingest(acc, { t: 'identity', identity: { nativeId: ASKER, handle: 'mara' } });
    snapshotRequests({ relationships: [{ id: ASKER, type: 3, since: '2026-11-01T10:00:00.000Z' }, { id: ALICE, type: 1 }], requestsKnown: true }, st).forEach((ev) => store.ingest(acc, ev));
    const mine = () => (hubAdd.requestViews(store) as P.RequestView[]).filter((r) => r.accountId === acc.id);
    expect(mine()).toMatchObject([{ kind: 'friend', nativeId: `friend:${ASKER}`, from: hubId('idn', 'discord', ASKER), answers: ['accept', 'decline', 'block'] }]);
    relationshipEvents('RELATIONSHIP_ADD', { id: LATER, type: 3, user: { id: LATER, username: 'nico' } }, st).forEach((ev) => store.ingest(acc, ev));
    expect(mine().map((r) => r.nativeId).sort()).toEqual([`friend:${ASKER}`, `friend:${LATER}`]);
    answerOutcome({ user: { id: ASKER, username: 'mara' }, relationship: 1 }, ASKER, st).events.forEach((ev) => store.ingest(acc, ev));
    expect(mine().map((r) => r.nativeId)).toEqual([`friend:${LATER}`]);
    relationshipEvents('RELATIONSHIP_REMOVE', { id: LATER, type: 3 }, st).forEach((ev) => store.ingest(acc, ev));
    expect(mine()).toEqual([]);
    store.flush();
  });

  test('backfill targets are DMs plus unread-mention channels only', () => {
    const targets: string[] = (globalThis as any).__backfill;
    expect(targets).toContain(DM);
    expect(targets).toContain(GDM);
    expect(targets).toContain(CH_BEGINNERS); // mention_count > 0
    expect(targets).not.toContain(CH_RULES); // no unread mentions, loads lazily
  });
});
