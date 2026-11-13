/**
 * Adding on Discord, the adapter's half (src/add.ts): what the hub asks for becomes a hook command, and what the hook
 * answers becomes facts (first) and a reply. The hook's half, against fake client modules, is in hook.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import type * as P from '@dither-chat/protocol';
import {
  addCapabilities,
  addCommand,
  answerCommand,
  answerOutcome,
  friendOutcome,
  invitePreview,
  isRelationshipEvent,
  isRequestEvent,
  joinOutcome,
  personPreview,
  relationshipEvents,
  relationshipsEvent,
  removeCommand,
  removeOutcome,
  requestsEvent,
  requestUser,
  resolveCommand,
  snapshotRelationships,
  snapshotRequests,
  SPAM_WARNING,
  STRANGER_WARNING,
} from '../src/add.ts';
import type { RawInvite } from '../src/discord-types.ts';
import { newState } from '../src/ingest.ts';

const SELF = '100000000000000001';
const ANN = '400000000000000001';
const BO = '400000000000000002';
const GUILD = '200000000000000001';
const CAT = '300000000000000100';
const GENERAL = '300000000000000200';
const RULES = '300000000000000009';
const GROUP = '600000000000000002';

const ann = { id: ANN, username: 'ann', global_name: 'Ann', avatar: 'aa' };
const bo = { id: BO, username: 'bo', global_name: null };

function state() {
  const st = newState();
  st.selfId = SELF;
  return st;
}

const serverInvite: RawInvite = {
  code: 'pixelclub',
  type: 0,
  guild: { id: GUILD, name: 'Pixel Club', icon: 'ic', description: 'Weekly challenges', verification_level: 1, screening: false },
  channel: { id: GENERAL, type: 0, name: 'general' },
  inviter: ann,
  expires_at: '2030-01-02T03:04:05.000Z',
  members: 5321,
  online: 802,
  joined: null,
  relationship: null,
};

describe('capabilities', () => {
  test('only for the modules the hook found', () => {
    expect(addCapabilities({})).toEqual([]);
    // The store alone lists relationships; ending one needs the friends module too.
    expect(addCapabilities({ RelationshipStore: true })).toEqual(['relationships']);
    expect(addCapabilities({ InviteActions: true, RelationshipStore: true })).toEqual(['resolve', 'join', 'relationships']);
    expect(addCapabilities({ RelationshipActions: true })).toEqual(['resolve', 'connect']);
    expect(addCapabilities({ RelationshipActions: true, RelationshipStore: true })).toEqual(['resolve', 'connect', 'requests', 'relationships', 'disconnect']);
    expect(addCapabilities({ InviteActions: true, RelationshipActions: true, RelationshipStore: true })).toEqual(['resolve', 'join', 'connect', 'requests', 'relationships', 'disconnect']);
  });
});

describe('commands', () => {
  const invite = { kind: 'invite', network: 'discord', code: 'pixelclub', url: 'https://discord.gg/pixelclub' } as const;
  test('resolve: invites and people; Discord has no addresses or names', () => {
    expect(resolveCommand(invite)).toEqual({ kind: 'inviteResolve', code: 'pixelclub' });
    expect(resolveCommand({ kind: 'person', network: 'discord', handle: 'ann' })).toEqual({ kind: 'person', handle: 'ann' });
    expect(resolveCommand({ kind: 'person', network: 'discord', handle: ANN })).toEqual({ kind: 'person', handle: ANN });
    expect(() => resolveCommand({ kind: 'place', network: 'matrix', address: '#a:example.org' })).toThrow('not a Discord');
    expect(() => resolveCommand({ kind: 'person', network: 'discord', handle: '../users/@me' })).toThrow();
    expect(() => resolveCommand({ ...invite, code: '../x' })).toThrow('not a Discord invite code');
  });

  test('add: join takes an invite, Add friend a person or a friend invite', () => {
    expect(addCommand(invite, 'join')).toEqual({ kind: 'inviteAccept', code: 'pixelclub' });
    expect(addCommand(invite, 'friend')).toEqual({ kind: 'inviteAccept', code: 'pixelclub', friend: true });
    expect(addCommand({ kind: 'person', network: 'discord', handle: 'ann' }, 'friend')).toEqual({ kind: 'friendAdd', username: 'ann' });
    expect(addCommand({ kind: 'person', network: 'discord', handle: ANN }, 'friend')).toEqual({ kind: 'friendAdd', userId: ANN });
    expect(() => addCommand({ kind: 'person', network: 'discord', handle: 'ann' }, 'join')).toThrow('Only an invite link joins');
    expect(() => addCommand(invite, 'ask')).toThrow('no asking to join');
    expect(() => addCommand({ kind: 'person', network: 'discord', handle: 'ann' }, 'follow')).toThrow('Add friend instead');
  });

  test('a request id is the asker, and nothing else passes', () => {
    expect(requestUser(`friend:${ANN}`)).toBe(ANN);
    expect(requestUser('friend:../x')).toBeNull();
    expect(requestUser(ANN)).toBeNull();
  });
});

describe('resolve', () => {
  test('a server invite: inviter first, then name, picture, counts, expiry', () => {
    const st = state();
    const { events, preview } = invitePreview(serverInvite, st);
    expect(events).toEqual([{ t: 'identity', identity: { nativeId: ANN, handle: 'ann', displayName: 'Ann', avatarUrl: `https://cdn.discordapp.com/avatars/${ANN}/aa.webp?size=128`, isBot: false } }]);
    expect(preview).toEqual({
      what: 'space',
      name: 'Pixel Club',
      nativeId: GUILD,
      avatar: `https://cdn.discordapp.com/icons/${GUILD}/ic.webp?size=128`,
      description: 'Weekly challenges',
      members: 5321,
      online: 802,
      expires: Date.UTC(2030, 0, 2, 3, 4, 5),
      inviter: ANN,
      actions: ['join'],
    });
  });

  test("a server with screening and a phone check says so; one you are in says that, and offers nothing", () => {
    const strict = invitePreview({ ...serverInvite, expires_at: null, guild: { ...serverInvite.guild!, screening: true, verification_level: 4 } }, state()).preview;
    expect(strict.notes).toEqual(["New members agree to the server's rules first, in the live view", 'This server wants a verified phone before you post']);
    expect(strict.expires).toBeUndefined();
    const inIt = invitePreview({ ...serverInvite, joined: { space: GUILD } }, state()).preview;
    expect(inIt).toMatchObject({ joined: { space: GUILD }, actions: [], notes: ['You are in this server already'] });
  });

  test('a group DM invite, and a friend invite', () => {
    const group = invitePreview({ code: 'grp', type: 1, channel: { id: GROUP, type: 3, name: null, icon: null, recipients: ['ann', 'bo'] }, inviter: ann, members: 3 }, state()).preview;
    expect(group).toEqual({ what: 'group', name: 'ann, bo', nativeId: GROUP, members: 3, inviter: ANN, actions: ['join'] });
    const friend = invitePreview({ code: 'frnd', type: 2, inviter: ann, relationship: 0 }, state()).preview;
    expect(friend).toMatchObject({ what: 'person', name: 'Ann', nativeId: ANN, relationship: 'stranger', actions: ['friend'] });
    expect(invitePreview({ code: 'frnd', type: 2, inviter: ann, relationship: 1 }, state()).preview).toMatchObject({ relationship: 'friend', actions: [] });
    expect(() => invitePreview({ code: 'x', type: 0 }, state())).toThrow('did not say what this invite leads to');
  });

  test('a person the client knows: identity first, what you can do with them', () => {
    const st = state();
    const r = personPreview({ selfId: SELF, user: ann, relationship: 0, direct: false }, 'ann', st);
    expect(r.events.map((e) => e.t)).toEqual(['identity']);
    expect(r.preview).toEqual({ what: 'person', name: 'Ann', nativeId: ANN, avatar: `https://cdn.discordapp.com/avatars/${ANN}/aa.webp?size=128`, relationship: 'stranger', actions: ['message', 'friend'] });
    expect(personPreview({ selfId: SELF, user: ann, relationship: 1 }, ANN, state()).preview).toMatchObject({ relationship: 'friend', actions: ['message'] });
    expect(personPreview({ selfId: SELF, user: ann, relationship: 3 }, ANN, state()).preview).toMatchObject({ relationship: 'requesting', actions: ['message', 'friend'], notes: ['They asked to be friends: Add friend accepts'] });
    expect(personPreview({ selfId: SELF, user: ann, relationship: 2 }, ANN, state()).preview).toMatchObject({ relationship: 'blocked', actions: [] });
    expect(personPreview({ selfId: SELF, user: { ...bo, bot: true } }, BO, state()).preview).toMatchObject({ actions: ['message'], notes: ['A bot: bots cannot be friends'] });
    expect(() => personPreview({ selfId: SELF, user: { id: SELF, username: 'me' } }, 'me', state())).toThrow('That is this account');
  });

  test('nobody the client has seen: partial, the input as the name, Add friend still there', () => {
    const byName = personPreview({ selfId: SELF, user: null }, 'mara', state());
    expect(byName).toEqual({ events: [], preview: { what: 'person', name: 'mara', partial: true, actions: ['friend'], notes: ['Discord says who this is only once the friend request is sent'] } });
    const byId = personPreview({ selfId: SELF, user: null }, ANN, state()).preview;
    expect(byId).toMatchObject({ partial: true, name: ANN, nativeId: ANN, actions: ['friend', 'message'] });
  });
});

describe('add', () => {
  const channels = [
    { id: CAT, type: 4, guild_id: GUILD, name: 'Start here', position: 0 },
    { id: GENERAL, type: 0, guild_id: GUILD, parent_id: CAT, name: 'general', position: 1 },
    { id: RULES, type: 0, guild_id: GUILD, name: 'rules', position: 0 },
  ];
  const guild = { id: GUILD, name: 'Pixel Club', icon: 'ic', description: 'Weekly challenges', rules_channel_id: RULES };

  test('joined: the server, its categories and channels first, then the server and the channel to open', () => {
    const st = state();
    const { events, result } = joinOutcome({ invite: serverInvite, guild, channels, channelId: GENERAL }, st);
    expect(events.map((e) => (e.t === 'space' ? `space ${e.space.nativeId} ${e.space.kind}` : e.t === 'conversation' ? `conversation ${e.conversation.nativeId}` : e.t))).toEqual([`space ${GUILD} community`, `space ${CAT} section`, `conversation ${GENERAL}`, `conversation ${RULES}`]);
    const rules = events.find((e) => e.t === 'conversation' && e.conversation.nativeId === RULES) as Extract<P.AdapterEvent, { t: 'conversation' }>;
    expect(rules.conversation.variant).toBe('rules');
    expect(result).toEqual({ space: GUILD, conversation: GENERAL });
    expect(st.guilds.has(GUILD)).toBe(true);
  });

  test("membership screening: the server is joined, its rules are the owner's", () => {
    const { events, result } = joinOutcome({ invite: serverInvite, guild, channels, channelId: GENERAL, rules: true }, state());
    expect(events[0]).toMatchObject({ t: 'space', space: { nativeId: GUILD } });
    expect(result).toEqual({ space: GUILD, check: 'rules', notes: ["Joined. Discord wants you to agree to the server's rules before you post: read them in the live view"] });
  });

  test('a captcha: nothing joined, nothing told', () => {
    expect(joinOutcome({ invite: serverInvite, check: 'captcha' }, state())).toEqual({ events: [], result: { check: 'captcha' } });
  });

  test('in it already, a group DM, a friend invite, a phone the server wants', () => {
    expect(joinOutcome({ invite: { ...serverInvite, joined: { space: GUILD } }, already: true }, state()).result).toEqual({ space: GUILD, notes: ['You are in it already'] });
    const group = joinOutcome({ channel: { id: GROUP, type: 3, name: 'raid', recipients: [ann, { username: 'no id' } as any] } }, state());
    expect(group.events.map((e) => e.t)).toEqual(['identity', 'conversation']);
    expect(group.events[1]).toMatchObject({ conversation: { nativeId: GROUP, shape: 'group', name: 'raid', participants: [SELF, ANN] } });
    expect(group.result).toEqual({ conversation: GROUP });
    const st = state();
    const friend = joinOutcome({ invite: { code: 'f', type: 2, inviter: ann }, friend: ann, relationship: 1 }, st);
    expect(friend.events).toEqual([{ t: 'identity', identity: expect.objectContaining({ nativeId: ANN, contact: true }) }]);
    expect(friend.result).toEqual({ identity: ANN, relationship: 'friend' });
    expect(st.friends.has(ANN)).toBe(true);
    expect(joinOutcome({ invite: serverInvite, guild, channels: [], channelId: null, phone: true }, state()).result).toEqual({ space: GUILD, notes: ['Joined. This server wants a verified phone before you post'] });
  });

  test('a friend request: pending until they accept; who it was when Discord said', () => {
    const sent = friendOutcome({ user: ann, relationship: 4 }, state());
    expect(sent.events.map((e) => e.t)).toEqual(['identity']);
    expect(sent.result).toEqual({ identity: ANN, relationship: 'requested', pending: true });
    expect(friendOutcome({ user: null, relationship: 4 }, state())).toEqual({ events: [], result: { relationship: 'requested', pending: true } });
    expect(friendOutcome({ check: 'captcha' }, state())).toEqual({ events: [], result: { check: 'captcha' } });
    // They had asked first: by user id, that accepts theirs.
    expect(friendOutcome({ user: ann, relationship: 1 }, state()).result).toEqual({ identity: ANN, relationship: 'friend' });
  });
});

describe('requests', () => {
  const snapshot = {
    relationships: [
      { id: ANN, type: 3, since: '2026-11-01T10:00:00.000Z' },
      { id: BO, type: 1 },
      { id: '400000000000000003', type: 4 },
    ],
  };

  test('the whole list from a snapshot, only once the hook says it is the whole list', () => {
    const st = state();
    expect(snapshotRequests(snapshot, st, 5)).toEqual([]);
    expect(st.requestsKnown).toBe(false);
    expect(requestsEvent(st)).toEqual([]);
    expect(snapshotRequests({ ...snapshot, requestsKnown: true }, st, 5)).toEqual([
      { t: 'requests', requests: [{ nativeId: `friend:${ANN}`, kind: 'friend', from: ANN, ts: Date.UTC(2026, 10, 1, 10), answers: ['accept', 'decline', 'block'] }] },
    ]);
    // Known and empty is a list too.
    expect(snapshotRequests({ relationships: [{ id: BO, type: 1 }], requestsKnown: true }, state(), 5)).toEqual([{ t: 'requests', requests: [] }]);
  });

  test("a snapshot's asker nobody else named gets a name: their identity before the list, once", () => {
    const st = state();
    const out = snapshotRequests({ relationships: [{ id: ANN, type: 3, since: '2026-11-01T10:00:00.000Z', user: ann }, { id: BO, type: 1 }], requestsKnown: true }, st, 5);
    expect(out.map((e) => e.t)).toEqual(['identity', 'requests']);
    expect(out[0]).toEqual({ t: 'identity', identity: expect.objectContaining({ nativeId: ANN }) });
    // The same snapshot again names nobody twice.
    expect(snapshotRequests({ relationships: [{ id: ANN, type: 3, user: ann }], requestsKnown: true }, st, 5).map((e) => e.t)).toEqual(['requests']);
  });

  test('a new one (who asked first), changes that are not one, and ones that go', () => {
    const st = state();
    snapshotRequests({ relationships: [], requestsKnown: true }, st);
    const added = relationshipEvents('RELATIONSHIP_ADD', { id: ANN, type: 3, user: ann, since: '2026-11-02T00:00:00.000Z' }, st, 9);
    expect(added.map((e) => e.t)).toEqual(['identity', 'request']);
    expect(added[1]).toEqual({ t: 'request', request: { nativeId: `friend:${ANN}`, kind: 'friend', from: ANN, ts: Date.UTC(2026, 10, 2), answers: ['accept', 'decline', 'block'] } });
    expect(relationshipEvents('RELATIONSHIP_UPDATE', { id: ANN, type: 3, user: ann }, st)).toEqual([]);
    // Withdrawn by them, or declined elsewhere.
    expect(relationshipEvents('RELATIONSHIP_REMOVE', { id: ANN, type: 3 }, st)).toEqual([{ t: 'requestGone', nativeId: `friend:${ANN}` }]);
    expect(relationshipEvents('RELATIONSHIP_REMOVE', { id: ANN, type: 3 }, st)).toEqual([]);
    // Accepted elsewhere: a friend now, the request gone, and a friend in the list (their identity told once).
    relationshipEvents('RELATIONSHIP_ADD', { id: BO, type: 3, user: bo }, st);
    expect(relationshipEvents('RELATIONSHIP_ADD', { id: BO, type: 1, user: bo }, st)).toEqual([
      { t: 'identity', identity: expect.objectContaining({ nativeId: BO, contact: true }) },
      { t: 'requestGone', nativeId: `friend:${BO}` },
      { t: 'relationship', fact: { identity: BO, relationship: 'friend' } },
    ]);
    // A request you sent is not one waiting on you: it is a relationship.
    expect(relationshipEvents('RELATIONSHIP_ADD', { id: '400000000000000003', type: 4, user: null }, st)).toEqual([{ t: 'relationship', fact: { identity: '400000000000000003', relationship: 'requested' } }]);
    expect(requestsEvent(st)).toEqual([{ t: 'requests', requests: [] }]);
  });

  test('the client loading its relationships again is the whole list again', () => {
    const st = state();
    const events = relationshipEvents('LOAD_RELATIONSHIPS_SUCCESS', { relationships: [{ id: ANN, type: 3, user: ann }, { id: BO, type: 1 }] }, st, 7);
    expect(events.map((e) => e.t)).toEqual(['identity', 'requests', 'relationships']);
    expect(events.at(-1)).toEqual({ t: 'relationships', list: [{ identity: BO, relationship: 'friend' }] });
    expect(st.friends.has(BO)).toBe(true);
  });

  test('answered here: who, the request gone, where things stand', () => {
    for (const [answer, type, relationship] of [['accept', 1, 'friend'], ['decline', 0, 'stranger'], ['block', 2, 'blocked']] as const) {
      const st = state();
      snapshotRequests({ relationships: [{ id: ANN, type: 3 }], requestsKnown: true }, st);
      const { events, result } = answerOutcome({ user: ann, relationship: type }, ANN, st);
      expect(events.map((e) => e.t)).toEqual(['identity', 'requestGone']);
      expect(result).toEqual({ identity: ANN, relationship });
      if (answer === 'accept') expect(events[0]).toMatchObject({ identity: { contact: true } });
      expect(st.requests.size).toBe(0);
    }
    expect(answerOutcome({ check: 'captcha' }, ANN, state())).toEqual({ events: [], result: { check: 'captcha' } });
  });

  test('request events are the ones held back while the account does not say it has requests', () => {
    expect(isRequestEvent({ t: 'requests', requests: [] })).toBe(true);
    expect(isRequestEvent({ t: 'requestGone', nativeId: 'x' })).toBe(true);
    expect(isRequestEvent({ t: 'identity', identity: { nativeId: ANN } })).toBe(false);
  });
});

describe('people links: warnings', () => {
  const CY = '400000000000000003';

  test("a request carries Discord's flags as a warning: spam, a stranger, both, neither", () => {
    const st = state();
    const out = snapshotRequests(
      {
        relationships: [
          { id: ANN, type: 3, spam: true, stranger: null },
          { id: BO, type: 3, spam: false, stranger: true },
          { id: CY, type: 3, spam: true, stranger: true },
          { id: '400000000000000004', type: 3, spam: false, stranger: false },
        ],
        requestsKnown: true,
      },
      st,
      5,
    );
    const list = (out.at(-1) as Extract<P.AdapterEvent, { t: 'requests' }>).requests;
    expect(list.map((r) => r.warning)).toEqual([SPAM_WARNING, STRANGER_WARNING, `${SPAM_WARNING}. ${STRANGER_WARNING}`, undefined]);
    // No warning is no key at all, as the hub stores what it is sent.
    expect('warning' in list[3]).toBe(false);
  });

  test('a flag that changes is the request again; the same flags, or a request nobody flags, are nothing', () => {
    const st = state();
    snapshotRequests({ relationships: [{ id: ANN, type: 3, spam: false, stranger: null }], requestsKnown: true }, st, 5);
    expect(relationshipEvents('RELATIONSHIP_UPDATE', { id: ANN, type: 3, spam: false, stranger: null }, st)).toEqual([]);
    expect(relationshipEvents('UPDATE_STRANGER_STATUS', { id: ANN, type: 3, spam: false, stranger: true }, st)).toEqual([
      { t: 'request', request: { nativeId: `friend:${ANN}`, kind: 'friend', from: ANN, ts: 5, answers: ['accept', 'decline', 'block'], warning: STRANGER_WARNING } },
    ]);
    // The client forgetting (null) is not Discord saying otherwise; spam on top is.
    expect(relationshipEvents('RELATIONSHIP_UPDATE', { id: ANN, type: 3, spam: false, stranger: null }, st)).toEqual([]);
    expect(relationshipEvents('RELATIONSHIP_UPDATE', { id: ANN, type: 3, spam: true, stranger: null }, st)).toEqual([{ t: 'request', request: expect.objectContaining({ warning: `${SPAM_WARNING}. ${STRANGER_WARNING}` }) }]);
    // Discord taking a flag back takes its warning off.
    expect(relationshipEvents('RELATIONSHIP_UPDATE', { id: ANN, type: 3, spam: false, stranger: false }, st)).toEqual([{ t: 'request', request: expect.not.objectContaining({ warning: expect.anything() }) }]);
    // The next snapshot keeps the ts and what it was not told again.
    snapshotRequests({ relationships: [{ id: ANN, type: 3, spam: true }], requestsKnown: true }, st, 99);
    expect(st.requests.get(ANN)).toEqual({ nativeId: `friend:${ANN}`, kind: 'friend', from: ANN, ts: 5, answers: ['accept', 'decline', 'block'], warning: SPAM_WARNING });
  });
});

describe('people links: the confirm step', () => {
  test('the confirm goes to the hook only when the command carries it: Add friend by id and accept', () => {
    const byId = { kind: 'person', network: 'discord', handle: ANN } as const;
    expect(addCommand(byId, 'friend')).toEqual({ kind: 'friendAdd', userId: ANN });
    expect(addCommand(byId, 'friend', true)).toEqual({ kind: 'friendAdd', userId: ANN, confirm: true });
    expect(addCommand({ kind: 'person', network: 'discord', handle: 'ann' }, 'friend', true)).toEqual({ kind: 'friendAdd', username: 'ann' });
    expect(addCommand({ kind: 'invite', network: 'discord', code: 'frnd', url: 'https://discord.gg/frnd' }, 'friend', true)).toEqual({ kind: 'inviteAccept', code: 'frnd', friend: true });
    expect(answerCommand(`friend:${ANN}`, 'accept')).toEqual({ kind: 'friendAnswer', userId: ANN, answer: 'accept' });
    expect(answerCommand(`friend:${ANN}`, 'accept', true)).toEqual({ kind: 'friendAnswer', userId: ANN, answer: 'accept', confirm: true });
    // Decline and block need none.
    expect(answerCommand(`friend:${ANN}`, 'decline', true)).toEqual({ kind: 'friendAnswer', userId: ANN, answer: 'decline' });
    expect(answerCommand(`friend:${ANN}`, 'block', true)).toEqual({ kind: 'friendAnswer', userId: ANN, answer: 'block' });
    expect(() => answerCommand('friend:../x', 'accept')).toThrow('not waiting any more');
  });

  test("Discord wanting a confirm: its words (or ours), nothing done, the request stays and says why", () => {
    const st = state();
    snapshotRequests({ relationships: [{ id: ANN, type: 3 }], requestsKnown: true }, st, 5);
    const said = 'You must confirm the friend request to add this user.';
    const out = answerOutcome({ confirm: said }, ANN, st);
    expect(out).toEqual({ events: [{ t: 'request', request: expect.objectContaining({ from: ANN, warning: STRANGER_WARNING }) }], result: { confirm: said } });
    expect(st.requests.has(ANN)).toBe(true);
    expect(st.friends.has(ANN)).toBe(false);
    // Asked again, already warned: the reply alone.
    expect(answerOutcome({ confirm: '' }, ANN, st)).toEqual({ events: [], result: { confirm: STRANGER_WARNING } });
    // Add friend by id the same; without a request listed, the reply alone.
    expect(friendOutcome({ confirm: said }, state(), ANN)).toEqual({ events: [], result: { confirm: said } });
    expect(friendOutcome({ confirm: said }, state())).toEqual({ events: [], result: { confirm: said } });
  });
});

describe('people links: relationships', () => {
  const CY = '400000000000000003';
  const DEE = '400000000000000004';
  const EVE = '400000000000000005';
  const cy = { id: CY, username: 'cy' };
  const dee = { id: DEE, username: 'dee' };
  const snapshot = {
    relationships: [
      { id: ANN, type: 3, since: '2026-11-01T10:00:00.000Z', user: ann },
      { id: BO, type: 1, since: '2020-01-01T00:00:00.000Z', user: bo },
      { id: CY, type: 2, since: null, user: cy },
      { id: DEE, type: 4, since: '2026-11-08T00:00:00.000Z', user: dee },
      { id: EVE, type: 5 },
      { id: SELF, type: 1 },
    ],
  };

  test('nothing until the list is whole; then identities first and friends, blocks, requests sent', () => {
    const st = state();
    expect(snapshotRelationships(snapshot, st)).toEqual([]);
    expect(relationshipsEvent(st)).toEqual([]);
    snapshotRequests({ ...snapshot, requestsKnown: true }, st, 5);
    const out = snapshotRelationships({ ...snapshot, requestsKnown: true }, st);
    expect(out.map((e) => (e.t === 'identity' ? e.identity.nativeId : e.t))).toEqual([BO, CY, DEE, 'relationships']);
    expect(out.at(-1)).toEqual({
      t: 'relationships',
      list: [
        { identity: BO, relationship: 'friend', since: Date.UTC(2020, 0, 1) },
        { identity: CY, relationship: 'blocked' },
        { identity: DEE, relationship: 'requested', since: Date.UTC(2026, 10, 8) },
      ],
    });
    // After a reconnect to the hub, the whole list again; known and empty is a list too.
    expect(relationshipsEvent(st)).toEqual([out.at(-1)!]);
    const empty = state();
    snapshotRequests({ relationships: [], requestsKnown: true }, empty);
    expect(snapshotRelationships({ relationships: [], requestsKnown: true }, empty)).toEqual([{ t: 'relationships', list: [] }]);
  });

  test('one coming, changing and going: the relationship event; the same again is nothing; implicit and incoming are not listed', () => {
    const st = state();
    snapshotRequests({ ...snapshot, requestsKnown: true }, st, 5);
    snapshotRelationships({ ...snapshot, requestsKnown: true }, st);
    // A request you sent becomes a friendship.
    expect(relationshipEvents('RELATIONSHIP_UPDATE', { id: DEE, type: 1, user: dee, since: '2026-11-09T00:00:00.000Z' }, st)).toEqual([
      { t: 'identity', identity: expect.objectContaining({ nativeId: DEE, contact: true }) },
      { t: 'relationship', fact: { identity: DEE, relationship: 'friend', since: Date.UTC(2026, 10, 9) } },
    ]);
    expect(relationshipEvents('RELATIONSHIP_UPDATE', { id: DEE, type: 1, user: dee, since: '2026-11-09T00:00:00.000Z' }, st)).toEqual([]);
    // Unfriended, here or elsewhere: gone.
    expect(relationshipEvents('RELATIONSHIP_REMOVE', { id: BO, type: 1, user: null, since: null }, st)).toEqual([{ t: 'relationship', fact: { identity: BO, relationship: 'stranger' } }]);
    expect(st.friends.has(BO)).toBe(false);
    // An incoming request accepted: the request gone, a friend now.
    expect(relationshipEvents('RELATIONSHIP_UPDATE', { id: ANN, type: 1, user: ann, since: '2026-11-09T01:00:00.000Z' }, st).map((e) => e.t)).toEqual(['identity', 'requestGone', 'relationship']);
    // Declined (an incoming one removed) and implicit ones: nothing listed changed.
    relationshipEvents('RELATIONSHIP_ADD', { id: EVE, type: 3, user: null }, st);
    expect(relationshipEvents('RELATIONSHIP_REMOVE', { id: EVE, type: 3, user: null }, st)).toEqual([{ t: 'requestGone', nativeId: `friend:${EVE}` }]);
    expect(relationshipEvents('RELATIONSHIP_ADD', { id: EVE, type: 5, user: null }, st)).toEqual([]);
    // Unblocked: gone; a remove of a listed one is gone even if it was not heard of.
    expect(relationshipEvents('RELATIONSHIP_REMOVE', { id: CY, type: 2 }, st)).toEqual([{ t: 'relationship', fact: { identity: CY, relationship: 'stranger' } }]);
    expect(relationshipEvents('RELATIONSHIP_REMOVE', { id: '400000000000000009', type: 4 }, st)).toEqual([{ t: 'relationship', fact: { identity: '400000000000000009', relationship: 'stranger' } }]);
    // A type the hook could not read says nothing.
    expect(relationshipEvents('RELATIONSHIP_UPDATE', { id: DEE, type: null }, st)).toEqual([]);
    expect([...st.relationships.values()]).toEqual([
      { identity: DEE, relationship: 'friend', since: Date.UTC(2026, 10, 9) },
      { identity: ANN, relationship: 'friend', since: Date.UTC(2026, 10, 9, 1) },
    ]);
  });

  test('relationship events are the ones held back while the account does not say it lists them', () => {
    expect(isRelationshipEvent({ t: 'relationships', list: [] })).toBe(true);
    expect(isRelationshipEvent({ t: 'relationship', fact: { identity: ANN, relationship: 'stranger' } })).toBe(true);
    expect(isRelationshipEvent({ t: 'requests', requests: [] })).toBe(false);
    expect(isRequestEvent({ t: 'relationships', list: [] })).toBe(false);
  });
});

describe('people links: remove', () => {
  test('friend, requested, blocked: unfriend, cancel, unblock', () => {
    expect(removeCommand(ANN, 'friend')).toEqual({ kind: 'friendRemove', userId: ANN, type: 1 });
    expect(removeCommand(ANN, 'requested')).toEqual({ kind: 'friendRemove', userId: ANN, type: 4 });
    expect(removeCommand(ANN, 'blocked')).toEqual({ kind: 'friendRemove', userId: ANN, type: 2 });
  });

  test('refused in a plain sentence: contacts and following (Discord has neither), a request waiting on you, nothing at all', () => {
    expect(() => removeCommand(ANN, 'contact')).toThrow('Discord has no contacts');
    expect(() => removeCommand(ANN, 'following')).toThrow('Discord has no following');
    expect(() => removeCommand(ANN, 'requesting')).toThrow('accept, decline or block it');
    expect(() => removeCommand(ANN, 'stranger')).toThrow('nothing to remove');
    expect(() => removeCommand('../users/@me', 'friend')).toThrow('not a Discord user id');
  });

  test('the answer: the person, and the relationship now', () => {
    const st = state();
    st.friends.add(ANN);
    expect(removeOutcome({ user: ann, relationship: 0 }, ANN, st)).toEqual({ events: [{ t: 'identity', identity: expect.objectContaining({ nativeId: ANN }) }], result: { identity: ANN, relationship: 'stranger' } });
    expect(st.friends.has(ANN)).toBe(false);
    expect(removeOutcome({ check: 'captcha' }, ANN, state())).toEqual({ events: [], result: { check: 'captcha' } });
  });
});
