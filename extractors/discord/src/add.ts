/**
 * Adding on Discord (dither-chat's docs/add.md): joining from invites, adding friends, the friend requests waiting on
 * you, and the account's friends, blocks and requests sent (people links: listed, and ended by `remove`). The hook runs
 * the client's own invite and friend actions (hook.js, "adding"); this file checks what the hub asked for and maps what
 * the hook answered into facts and replies. Pure, tested in test/add.test.ts.
 *
 * What it never does: answer a check, or confirm for the owner. A captcha, a verification or the server's rules come
 * back as AddResult.check, with nothing done (or, for rules, the join done and the rules left to the owner in the live
 * view). An accept Discord wants confirmed comes back as AddResult.confirm, with nothing done; the confirm goes along
 * only on the command the owner sends again with `confirm: true`.
 */

import type * as P from '@dither-chat/protocol';
import type { HookCommand, RawFriend, RawInvite, RawJoin, RawPerson, RawRelationship, RawRelationshipChange, RawRequestFlags, RawSnapshot, RawUser } from './discord-types.ts';
import { type AdapterState, guildFacts, userFacts } from './ingest.ts';
import { avatarUrl, CHANNEL_TYPE, groupIconUrl, guildIconUrl, isoToMs, mapPrivateChannel, mapUser, userDisplayName } from './map.ts';
import { RELATIONSHIP } from './profile.ts';

/** RelationshipStore types. */
export const REL = { NONE: 0, FRIEND: 1, BLOCKED: 2, INCOMING: 3, OUTGOING: 4 } as const;
/** Invite types: a server, a group DM, a friend invite. */
export const INVITE = { GUILD: 0, GROUP_DM: 1, FRIEND: 2 } as const;

/** The answers a friend request takes on Discord: accept, ignore (decline), block. */
export const ANSWERS: readonly P.RequestAnswer[] = ['accept', 'decline', 'block'];

/** RequestFact.warning, from Discord's own flags on a request (both, when it set both). */
export const SPAM_WARNING = 'Discord filed this request as possible spam';
export const STRANGER_WARNING = 'Discord says you share no server or friend with them; it asks you to confirm before accepting';

/** The relationships the account lists (RelationshipFact): friends, blocks, requests you sent. Not 3 or 5. */
const LINKS: Partial<Record<number, P.RelationshipFact['relationship']>> = { [REL.FRIEND]: 'friend', [REL.BLOCKED]: 'blocked', [REL.OUTGOING]: 'requested' };
/** What `remove` ends, by what the owner saw: unfriend, cancel the request you sent, unblock. */
const ENDS: Partial<Record<P.PersonRelationship, 1 | 2 | 4>> = { friend: REL.FRIEND, requested: REL.OUTGOING, blocked: REL.BLOCKED };

const CODE = /^[A-Za-z0-9-]{2,32}$/;
const USERNAME = /^(?!.*\.\.)[a-z0-9_.]{2,32}$/;
const SNOWFLAKE = /^\d{15,22}$/;

export const relationshipOf = (type: number | null | undefined): P.PersonRelationship => RELATIONSHIP[type ?? REL.NONE] ?? 'stranger';

/** An object without its undefined fields, so a reply carries only what Discord said. */
function defined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/**
 * The add capabilities this client backs, by which of the hook's modules were found (the `finders` report). resolve:
 * invites need the invite module, people only the user store, so either of the two action modules will do; join: the
 * invite module; connect: the friends module; requests: the friends module and the store that lists them;
 * relationships: that store; disconnect: the friends module's removeRelationship (it is found only with one) and the
 * store, which says whether the relationship is still the one the owner saw. addMembers: that store, which says who is
 * a friend (Discord adds only friends to a group), and the REST module the PUTs go through. createGroup: that store,
 * the client's ensurePrivateChannel (GroupDMCreate) that makes the group, and the REST module that names it.
 */
export function addCapabilities(found: Record<string, boolean>): P.Capability[] {
  const caps: P.Capability[] = [];
  if (found.InviteActions || found.RelationshipActions) caps.push('resolve');
  if (found.InviteActions) caps.push('join');
  if (found.RelationshipActions) caps.push('connect');
  if (found.RelationshipActions && found.RelationshipStore) caps.push('requests');
  if (found.RelationshipStore) caps.push('relationships');
  if (found.RelationshipActions && found.RelationshipStore) caps.push('disconnect');
  if (found.RelationshipStore && found.Rest) caps.push('addMembers');
  if (found.RelationshipStore && found.Rest && found.GroupDMCreate) caps.push('createGroup');
  return caps;
}

// ------------------------------------------------------------- the commands

function inviteCode(code: string): string {
  if (!CODE.test(code)) throw new Error('That is not a Discord invite code');
  return code;
}

function notDiscord(ref: P.AddRef): void {
  if (ref.network !== 'discord') throw new Error('That is not a Discord invite or user');
}

/** What the hook runs for `resolve`. Discord has no addresses or public names: only invites and people. */
export function resolveCommand(ref: P.AddRef): HookCommand {
  notDiscord(ref);
  if (ref.kind === 'invite') return { kind: 'inviteResolve', code: inviteCode(ref.code) };
  if (ref.kind === 'person') {
    if (!SNOWFLAKE.test(ref.handle) && !USERNAME.test(ref.handle)) throw new Error('That is not a Discord username or user id');
    return { kind: 'person', handle: ref.handle };
  }
  throw new Error('Discord has no addresses or public names: paste an invite link or a username');
}

/**
 * What the hook runs for `add`. Join takes an invite; Add friend a person, or a friend invite. confirm (the owner's "Add
 * anyway"): only Add friend by user id carries it, as only that accepts a request of theirs that Discord wants confirmed.
 */
export function addCommand(ref: P.AddRef, action: Exclude<P.AddAction, 'message'>, confirm = false): HookCommand {
  notDiscord(ref);
  if (action === 'join') {
    if (ref.kind !== 'invite') throw new Error('Only an invite link joins a Discord server or group');
    return { kind: 'inviteAccept', code: inviteCode(ref.code) };
  }
  if (action === 'friend') {
    if (ref.kind === 'invite') return { kind: 'inviteAccept', code: inviteCode(ref.code), friend: true };
    if (ref.kind === 'person' && SNOWFLAKE.test(ref.handle)) return { kind: 'friendAdd', userId: ref.handle, ...(confirm ? { confirm: true as const } : {}) };
    if (ref.kind === 'person' && USERNAME.test(ref.handle)) return { kind: 'friendAdd', username: ref.handle };
    throw new Error('That is not a Discord username or user id');
  }
  if (action === 'ask') throw new Error('Discord servers have no asking to join: Join, and any check the server wants follows');
  throw new Error(`Discord has no ${action === 'follow' ? 'following' : 'contacts'}: Add friend instead`);
}

/** The asker's user id in a request's native id, or null for one that is not a Discord friend request. */
export function requestUser(nativeId: string): string | null {
  const m = /^friend:(\d{1,22})$/.exec(nativeId);
  return m ? m[1] : null;
}
export const requestId = (userId: string) => `friend:${userId}`;

/** What the hook runs for `answer`. The owner's confirm goes along on an accept only: decline and block need none. */
export function answerCommand(request: string, answer: P.RequestAnswer, confirm = false): HookCommand {
  const userId = requestUser(request);
  if (!userId) throw new Error('That request is not waiting any more');
  return { kind: 'friendAnswer', userId, answer, ...(confirm && answer === 'accept' ? { confirm: true as const } : {}) };
}

/**
 * What the hook runs for `remove`: unfriend, cancel a request you sent, unblock, each only while it is still what the
 * owner saw (the hook checks the client's store). A request waiting on you is answered, not removed; Discord has no
 * contacts and no following.
 */
export function removeCommand(identity: string, relationship: P.PersonRelationship): HookCommand {
  if (relationship === 'contact') throw new Error('Discord has no contacts, so there is no contact to remove');
  if (relationship === 'following') throw new Error('Discord has no following, so there is nobody to unfollow');
  if (relationship === 'requesting') throw new Error('That is a friend request waiting on you: accept, decline or block it');
  const type = ENDS[relationship];
  if (!type) throw new Error('There is nothing to remove: no friendship, request or block');
  if (!SNOWFLAKE.test(identity)) throw new Error('That is not a Discord user id');
  return { kind: 'friendRemove', userId: identity, type };
}

// ------------------------------------------------------------------ resolve

const count = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined);

/** An invite the client looked up -> identity facts for its inviter, then the preview. */
export function invitePreview(raw: RawInvite, st: AdapterState): { events: P.AdapterEvent[]; preview: P.AddPreview } {
  const events = userFacts([raw.inviter], st);
  const expires = isoToMs(raw.expires_at) || undefined;
  const inviter = raw.inviter?.id || undefined;
  const counts = { members: count(raw.members), online: count(raw.online), expires, inviter };

  if (raw.type === INVITE.FRIEND) {
    const u = raw.inviter;
    if (!u?.id) throw new Error('Discord did not say whose friend invite this is');
    const relationship = relationshipOf(raw.relationship);
    const can = relationship !== 'friend' && relationship !== 'blocked';
    const notes = relationship === 'friend' ? ['You are friends already'] : relationship === 'blocked' ? ['You blocked them'] : ['A friend invite: accepting it makes you friends at once'];
    return { events, preview: defined({ what: 'person' as const, name: userDisplayName(u), nativeId: u.id, avatar: avatarUrl(u), relationship, expires, inviter, actions: can ? ['friend' as const] : [], notes }) };
  }

  if (raw.guild?.id) {
    const g = raw.guild;
    const joined = raw.joined?.space ? { space: raw.joined.space } : undefined;
    const notes: string[] = [];
    if (joined) notes.push('You are in this server already');
    else {
      if (g.screening) notes.push("New members agree to the server's rules first, in the live view");
      if (g.verification_level === 4) notes.push('This server wants a verified phone before you post');
    }
    const preview = defined({ what: 'space' as const, name: g.name, nativeId: g.id, avatar: guildIconUrl(g), description: g.description || undefined, ...counts, joined, actions: joined ? [] : ['join' as const], notes: notes.length ? notes : undefined });
    return { events, preview };
  }

  if (raw.channel?.id && raw.channel.type === CHANNEL_TYPE.GROUP_DM) {
    const c = raw.channel;
    const joined = raw.joined?.conversation ? { conversation: raw.joined.conversation } : undefined;
    const name = c.name?.trim() || (c.recipients ?? []).join(', ') || 'Group DM';
    const preview = defined({ what: 'group' as const, name, nativeId: c.id, avatar: groupIconUrl({ id: c.id, type: CHANNEL_TYPE.GROUP_DM, icon: c.icon }), ...counts, joined, actions: joined ? [] : ['join' as const], notes: joined ? ['You are in this group already'] : undefined });
    return { events, preview };
  }

  throw new Error('Discord did not say what this invite leads to');
}

/**
 * A person, from what the client's stores know (no request). Nobody it has seen: partial, as Discord says who a
 * username is only once the friend request is sent. A user id is still something Message can open a DM with.
 */
export function personPreview(raw: RawPerson, handle: string, st: AdapterState): { events: P.AdapterEvent[]; preview: P.AddPreview } {
  const u = raw.user;
  const byId = SNOWFLAKE.test(handle);
  if (u?.id && u.id === (raw.selfId || st.selfId)) throw new Error('That is this account');
  if (!u?.id || !u.username) {
    const preview: P.AddPreview = byId
      ? { what: 'person', name: handle, partial: true, nativeId: handle, actions: ['friend', 'message'], notes: ["Discord's client has not seen this user, so who it is shows once you add or message them"] }
      : { what: 'person', name: handle, partial: true, actions: ['friend'], notes: ['Discord says who this is only once the friend request is sent'] };
    return { events: [], preview };
  }
  const relationship = relationshipOf(raw.relationship);
  const actions: P.AddAction[] = relationship === 'blocked' ? [] : u.bot || relationship === 'friend' || relationship === 'requested' ? ['message'] : ['message', 'friend'];
  const note =
    relationship === 'requesting' ? 'They asked to be friends: Add friend accepts'
    : relationship === 'requested' ? 'Your friend request is waiting on them'
    : relationship === 'blocked' ? 'You blocked them'
    : u.bot && relationship !== 'friend' ? 'A bot: bots cannot be friends'
    : undefined;
  return { events: userFacts([u], st), preview: defined({ what: 'person' as const, name: userDisplayName(u), nativeId: u.id, avatar: avatarUrl(u), relationship, actions, notes: note ? [note] : undefined }) };
}

// ---------------------------------------------------------------------- add

/** Someone who is a friend now: told as a contact. */
function becameFriend(u: RawUser, st: AdapterState): P.AdapterEvent[] {
  st.friends.add(u.id);
  return u.username ? [{ t: 'identity', identity: mapUser(u, { contact: true }) }] : [];
}

/** The hook's answer to a join -> the facts for what now exists (server, categories, channels; or the group), then the result. */
export function joinOutcome(raw: RawJoin, st: AdapterState): { events: P.AdapterEvent[]; result: P.AddResult } {
  if (raw.check) return { events: [], result: { check: raw.check } };
  const inv = raw.invite;
  if (raw.already) {
    if (inv?.type === INVITE.FRIEND && inv.inviter?.id) return { events: userFacts([inv.inviter], st), result: { identity: inv.inviter.id, relationship: 'friend', notes: ['You are friends already'] } };
    const j = inv?.joined ?? {};
    return { events: [], result: defined({ space: j.space, conversation: j.conversation, notes: ['You are in it already'] }) };
  }
  if (raw.friend?.id) {
    const relationship = relationshipOf(raw.relationship);
    const events = relationship === 'friend' ? becameFriend(raw.friend, st) : userFacts([raw.friend], st);
    return { events, result: defined({ identity: raw.friend.id, relationship, pending: relationship === 'requested' ? true : undefined }) };
  }
  if (raw.guild?.id) {
    const events = guildFacts(raw.guild, raw.channels ?? [], st);
    const told = new Set(events.flatMap((e) => (e.t === 'conversation' ? [e.conversation.nativeId] : [])));
    const conversation = raw.channelId && told.has(raw.channelId) ? raw.channelId : undefined;
    if (raw.rules) {
      // Joined, but Discord holds the member until they agree to the rules: that is the owner's, in the live view.
      return { events, result: { space: raw.guild.id, check: 'rules', notes: ["Joined. Discord wants you to agree to the server's rules before you post: read them in the live view"] } };
    }
    return { events, result: defined({ space: raw.guild.id, conversation, notes: raw.phone ? ['Joined. This server wants a verified phone before you post'] : undefined }) };
  }
  if (raw.channel?.id) {
    // Recipients without an id (an invite names them by username only) are left for the gateway to fill in.
    const c = { ...raw.channel, recipients: (raw.channel.recipients ?? []).filter((r) => r?.id) };
    st.known.add(c.id);
    return { events: [...userFacts(c.recipients, st), { t: 'conversation', conversation: mapPrivateChannel(c, st.selfId) }], result: { conversation: c.id } };
  }
  throw new Error('Discord took the invite but did not say what it joined');
}

/**
 * Discord wants an accept confirmed (code 80013): nothing was done. The request, when it is listed, now says why; the
 * reply carries Discord's words for the owner, who may send the command again with confirm.
 */
function confirmWanted(said: string, userId: string | undefined, st: AdapterState): { events: P.AdapterEvent[]; result: P.AddResult } {
  const events: P.AdapterEvent[] = [];
  const had = userId ? st.requests.get(userId) : undefined;
  if (userId && had) {
    const fact = withFlags(had, { stranger: true }, had);
    if (fact.warning !== had.warning) {
      st.requests.set(userId, fact);
      events.push({ t: 'request', request: fact });
    }
  }
  return { events, result: { confirm: said.trim() || STRANGER_WARNING } };
}

/**
 * The hook's answer to a friend request -> the person (identity fact first) and where things stand. userId: whose,
 * for one by user id (an accept Discord wants confirmed marks their request).
 */
export function friendOutcome(raw: RawFriend, st: AdapterState, userId?: string): { events: P.AdapterEvent[]; result: P.AddResult } {
  if (raw.check) return { events: [], result: { check: raw.check } };
  if (typeof raw.confirm === 'string') return confirmWanted(raw.confirm, userId, st);
  const relationship = relationshipOf(raw.relationship);
  const u = raw.user;
  const events = u?.id ? (relationship === 'friend' ? becameFriend(u, st) : userFacts([u], st)) : [];
  return { events, result: defined({ identity: u?.id || undefined, relationship, pending: relationship === 'requested' ? true : undefined }) };
}

/** The hook's answer to an answered request -> the person, the request gone, then the result. */
export function answerOutcome(raw: RawFriend, userId: string, st: AdapterState): { events: P.AdapterEvent[]; result: P.AddResult } {
  if (raw.check) return { events: [], result: { check: raw.check } };
  if (typeof raw.confirm === 'string') return confirmWanted(raw.confirm, userId, st);
  const { events, result } = friendOutcome({ ...raw, user: raw.user?.id === userId ? raw.user : null }, st);
  const had = st.requests.get(userId);
  if (had) {
    st.requests.delete(userId);
    events.push({ t: 'requestGone', nativeId: had.nativeId });
  }
  return { events, result: { identity: userId, relationship: result.relationship } };
}

/**
 * The hook's answer to `remove` -> the person and the relationship now ('stranger'). The relationship event comes from
 * the client's RELATIONSHIP_REMOVE, which may land before or after this.
 */
export function removeOutcome(raw: RawFriend, userId: string, st: AdapterState): { events: P.AdapterEvent[]; result: P.AddResult } {
  if (raw.check) return { events: [], result: { check: raw.check } };
  const relationship = relationshipOf(raw.relationship);
  if (relationship !== 'friend') st.friends.delete(userId);
  return { events: userFacts([raw.user?.id === userId ? raw.user : null], st), result: { identity: userId, relationship } };
}

// ----------------------------------------------------------------- requests

/** Discord's flags as last heard, by request fact: a fact is replaced, never changed, so its flags go with it. */
const FLAGS = new WeakMap<P.RequestFact, { spam: boolean; stranger: boolean }>();

/**
 * A request with Discord's flags and the warning they make: what the hook says now, else what was heard before (a
 * stranger stays one until Discord says otherwise; the client forgets its answer after a while).
 */
function withFlags(fact: P.RequestFact, said: RawRequestFlags, before?: P.RequestFact): P.RequestFact {
  const was = before ? FLAGS.get(before) : undefined;
  const flags = {
    spam: typeof said.spam === 'boolean' ? said.spam : (was?.spam ?? false),
    stranger: typeof said.stranger === 'boolean' ? said.stranger : (was?.stranger ?? false),
  };
  const { warning: _old, ...plain } = fact;
  const warning = [flags.spam ? SPAM_WARNING : '', flags.stranger ? STRANGER_WARNING : ''].filter(Boolean).join('. ');
  const out: P.RequestFact = warning ? { ...plain, warning } : plain;
  FLAGS.set(out, flags);
  return out;
}

function friendRequest(userId: string, since: string | null | undefined, now: number, said: RawRequestFlags = {}, before?: P.RequestFact): P.RequestFact {
  return withFlags({ nativeId: requestId(userId), kind: 'friend', from: userId, ts: isoToMs(since) || now, answers: [...ANSWERS] }, said, before);
}

/** The whole list as it stands, or nothing while it is not known yet (an empty list would wipe the hub's). */
export function requestsEvent(st: AdapterState): P.AdapterEvent[] {
  return st.requestsKnown ? [{ t: 'requests', requests: [...st.requests.values()] }] : [];
}

/**
 * The friend requests among a snapshot's relationships: the whole list, when the hook says the relationships are all
 * in, after the askers' identities (the hook sends each asker's user record with the request; someone the snapshot's
 * other users already named is not told twice). Without them a request from a stranger had no name. Each carries
 * Discord's flags on it as a warning.
 */
export function snapshotRequests(data: Pick<RawSnapshot, 'relationships' | 'requestsKnown'>, st: AdapterState, now = Date.now()): P.AdapterEvent[] {
  if (!data.requestsKnown || !Array.isArray(data.relationships)) return [];
  const incoming = data.relationships.filter((r) => r?.id && r.type === REL.INCOMING && r.id !== st.selfId);
  const askers = userFacts(
    incoming.map((r) => r.user),
    st,
  );
  const before = st.requests;
  st.requests = new Map();
  for (const r of incoming) {
    const had = before.get(r.id);
    st.requests.set(r.id, friendRequest(r.id, r.since, had?.ts ?? now, r, had));
  }
  st.requestsKnown = true;
  return [...askers, ...requestsEvent(st)];
}

// ------------------------------------------------------------ relationships

/** A relationship the account lists, or null for one it does not (none, a request waiting on you, an implicit one). */
function linkOf(r: { id: string; type?: number | null; since?: string | null }, before?: P.RelationshipFact): P.RelationshipFact | null {
  const relationship = r.type == null ? undefined : LINKS[r.type];
  if (!relationship) return null;
  // Discord's own date, else the one heard before for the same relationship (a new one begins without one).
  const since = isoToMs(r.since) || (before?.relationship === relationship ? before.since : undefined);
  return since ? { identity: r.id, relationship, since } : { identity: r.id, relationship };
}

/** The whole list as it stands, or nothing while it is not known yet (an empty list would wipe the hub's). */
export function relationshipsEvent(st: AdapterState): P.AdapterEvent[] {
  return st.requestsKnown ? [{ t: 'relationships', list: [...st.relationships.values()] }] : [];
}

/**
 * The account's friends, blocks and requests sent, from a snapshot's relationships once the hook says they are all in
 * (the moment the requests list is whole too): everyone's identity first, then the whole list. Requests waiting on you
 * are RequestFacts, not in it; implicit relationships are nobody's business.
 */
export function snapshotRelationships(data: Pick<RawSnapshot, 'relationships' | 'requestsKnown'>, st: AdapterState): P.AdapterEvent[] {
  if (!data.requestsKnown || !Array.isArray(data.relationships)) return [];
  const listed = data.relationships.filter((r) => r?.id && r.id !== st.selfId && linkOf(r));
  const people = userFacts(
    listed.map((r) => r.user),
    st,
  );
  const before = st.relationships;
  st.relationships = new Map(listed.map((r) => [r.id, linkOf(r, before.get(r.id))!]));
  return [...people, { t: 'relationships', list: [...st.relationships.values()] }];
}

const gone = (identity: string): P.AdapterEvent => ({ t: 'relationship', fact: { identity, relationship: 'stranger' } });

/**
 * One relationship coming, changing or going -> its `relationship` event, when the listed one changed: someone new
 * (their identity first, unless told just now), one that changed, or one that ended ('stranger'). A remove is gone
 * whether or not it was heard of before, when the type it had is a listed one.
 */
function linkEvents(r: RawRelationshipChange, removed: boolean, st: AdapterState, told: boolean): P.AdapterEvent[] {
  const had = st.relationships.get(r.id);
  if (removed) {
    if (!had && !(r.type != null && LINKS[r.type])) return [];
    st.relationships.delete(r.id);
    return [gone(r.id)];
  }
  // The hook could not read its type: nothing knowable changed.
  if (r.type == null) return [];
  const fact = linkOf(r, had);
  if (!fact) {
    if (!had) return [];
    st.relationships.delete(r.id);
    return [gone(r.id)];
  }
  if (had && had.relationship === fact.relationship && had.since === fact.since) return [];
  st.relationships.set(r.id, fact);
  return [...(told ? [] : userFacts([r.user], st)), { t: 'relationship', fact }];
}

export const RELATIONSHIP_EVENTS = new Set(['RELATIONSHIP_ADD', 'RELATIONSHIP_UPDATE', 'RELATIONSHIP_REMOVE', 'LOAD_RELATIONSHIPS_SUCCESS', 'UPDATE_STRANGER_STATUS']);

/**
 * A relationship dispatch -> a new request (its asker first), a request whose flags changed (RELATIONSHIP_UPDATE, or
 * the client's UPDATE_STRANGER_STATUS), a request gone (answered here or elsewhere, withdrawn), someone who is a friend
 * now, and the listed relationship that changed. A reload of the client's relationships is both whole lists again.
 */
export function relationshipEvents(event: string, data: unknown, st: AdapterState, now = Date.now()): P.AdapterEvent[] {
  if (event === 'LOAD_RELATIONSHIPS_SUCCESS') {
    const list: RawRelationship[] = Array.isArray((data as { relationships?: unknown })?.relationships) ? (data as { relationships: RawRelationship[] }).relationships : [];
    for (const r of list) if (r?.type === REL.FRIEND) st.friends.add(r.id);
    const whole = { relationships: list, requestsKnown: true };
    return [...snapshotRequests(whole, st, now), ...snapshotRelationships(whole, st)];
  }
  const r = data as RawRelationshipChange | null;
  if (!r?.id || r.id === st.selfId) return [];
  const removed = event === 'RELATIONSHIP_REMOVE';
  const had = st.requests.get(r.id);
  const events: P.AdapterEvent[] = [];
  if (!removed && r.type === REL.INCOMING) {
    if (!had) {
      const fact = friendRequest(r.id, r.since, now, r);
      st.requests.set(r.id, fact);
      events.push(...userFacts([r.user], st), { t: 'request', request: fact });
    } else {
      // Discord's flags on it changed (spam, or a stranger after all): the request again, with its warning now.
      const fact = withFlags(had, r, had);
      if (fact.warning !== had.warning) {
        st.requests.set(r.id, fact);
        events.push({ t: 'request', request: fact });
      }
    }
  } else {
    if (removed) st.friends.delete(r.id);
    else if (r.type === REL.FRIEND && !st.friends.has(r.id) && r.user?.id === r.id) events.push(...becameFriend(r.user, st));
    if (had) {
      st.requests.delete(r.id);
      events.push({ t: 'requestGone', nativeId: had.nativeId });
    }
  }
  return [...events, ...linkEvents(r, removed, st, events.some((e) => e.t === 'identity'))];
}

/** The events that are about requests, which go out only while the account says it has requests. */
export const isRequestEvent = (ev: P.AdapterEvent) => ev.t === 'requests' || ev.t === 'request' || ev.t === 'requestGone';

/** The events that are about relationships, which go out only while the account says it lists them. */
export const isRelationshipEvent = (ev: P.AdapterEvent) => ev.t === 'relationships' || ev.t === 'relationship';
