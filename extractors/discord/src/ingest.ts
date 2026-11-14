/**
 * Orchestration layer: turns a raw snapshot or a single forwarded Flux action into
 * the sequence of protocol facts the hub expects. Pure except for the small mutable
 * AdapterState it threads through (guild cache, mute settings, known conversations,
 * friends) so later events resolve rules channels, mutes and contacts correctly.
 *
 * main.ts emits whatever these return; test/pipeline.test.ts feeds the same output
 * straight into a real hub Store, so this is where "raw Discord -> facts" is proven
 * end to end without a browser.
 */

import type * as P from '@dither-chat/protocol';
import type { DispatchName, RawAddRecipients, RawChannel, RawCustomStatus, RawGuild, RawGuildSettings, RawMembersSeen, RawMessage, RawPresence, RawRecipientChange, RawSeenMember, RawSnapshot, RawUser } from './discord-types.ts';
import { manyVoteEvents, pollResultEvents, VOTE_REACTION, voteEvents } from './polls.ts';
import { type Changes, newChanges, pinSystemMessage, pinUpdate, pinsChanged, presenceChanges, roleChanges, sawMessage, statusChanges } from './changes.ts';
import { CHANNEL_TYPE, channelMute, customEmoji, isPrivate, isThread, mapCategory, mapGuild, mapGuildChannel, mapMessage, mapMute, mapPrivateChannel, mapReadState, mapThread, mapUser, reactionKey, userDisplayName, snowflakeToMs } from './map.ts';

export interface AdapterState {
  selfId: string;
  guilds: Map<string, RawGuild>;
  guildSettings: Map<string | null, RawGuildSettings>;
  known: Set<string>;
  friends: Set<string>;
  /** user id -> what we last told the hub about them */
  users: Map<string, string>;
  /** pins, roles and custom statuses: what was there before, to tell only changes (changes.ts) */
  changes: Changes;
  /** "guild:user" -> the member as last told (seenMembers), and guild -> its counts as last told */
  members: Map<string, string>;
  memberCounts: Map<string, string>;
  /** Friend requests waiting on you, by the asker's user id (add.ts), and whether that is the whole list yet. */
  requests: Map<string, P.RequestFact>;
  requestsKnown: boolean;
  /** Friends, blocks and requests you sent, by user id (add.ts); whole once requestsKnown is, as they come together. */
  relationships: Map<string, P.RelationshipFact>;
  /** Your own roles in each server, by id: a ping to one is a mention of you (rich.ts). Absent: not known yet. */
  selfRoles?: Map<string, string[]>;
}

export function newState(): AdapterState {
  return { selfId: '', guilds: new Map(), guildSettings: new Map(), known: new Set(), friends: new Set(), users: new Map(), changes: newChanges(), members: new Map(), memberCounts: new Map(), requests: new Map(), requestsKnown: false, relationships: new Map() };
}

export interface SnapshotResult {
  events: P.AdapterEvent[];
  /** Channels worth a bounded recent-message backfill (DMs + unread-mention channels). */
  backfillTargets: string[];
  /** Each channel's newest message id, as the snapshot has it: a backfill done before is skipped while it holds (backfill.ts). */
  newest: Record<string, string>;
}

export function translateSnapshot(data: RawSnapshot, st: AdapterState): SnapshotResult {
  const events: P.AdapterEvent[] = [];
  if (data.self) st.selfId = data.self.id;
  const selfId = st.selfId;

  for (const r of data.relationships ?? []) if (r.type === 1) st.friends.add(r.id);
  for (const gs of data.guildSettings ?? []) st.guildSettings.set(gs.guild_id, gs);
  if (data.selfRoles) st.selfRoles = new Map(Object.entries(data.selfRoles).filter(([, r]) => Array.isArray(r)));

  for (const g of data.guilds ?? []) {
    st.guilds.set(g.id, g);
    const gs = st.guildSettings.get(g.id);
    events.push({ t: 'space', space: mapGuild(g, gs ? mapMute(gs) : undefined) });
  }

  for (const c of data.channels ?? []) {
    if (c.type === CHANNEL_TYPE.CATEGORY) {
      events.push({ t: 'space', space: mapCategory(c, channelMute(st.guildSettings.get(c.guild_id ?? ''), c.id)) });
    } else {
      events.push(...guildChannelEvents(c, st));
    }
  }

  for (const t of data.threads ?? []) {
    st.known.add(t.id);
    events.push({ t: 'conversation', conversation: mapThread(t) });
  }

  const dmSettings = st.guildSettings.get(null);
  for (const c of data.privateChannels ?? []) {
    st.known.add(c.id);
    events.push({ t: 'conversation', conversation: mapPrivateChannel(c, selfId, channelMute(dmSettings, c.id)) });
    for (const r of c.recipients ?? []) events.push({ t: 'identity', identity: mapUser(r, { contact: st.friends.has(r.id) }) });
  }

  for (const u of data.users ?? []) if (u.id !== selfId) events.push({ t: 'identity', identity: mapUser(u, { contact: st.friends.has(u.id) }) });
  // Friends' custom statuses as they are now, so later changes have something to change from. Their identities are above.
  events.push(...statusChanges(data.customStatuses ?? [], st.changes, selfId));
  // And their presence, offline ones too.
  events.push(...presenceChanges(data.presences ?? [], st.changes, selfId));

  for (const rs of data.readStates ?? []) {
    if (!st.known.has(rs.id)) continue;
    const { upToTs, mentions } = mapReadState(rs);
    if (upToTs > 0) events.push({ t: 'read', conversation: rs.id, upToTs, mentions });
  }

  // Not every read state is a channel (guild-level ones share the table).
  const mentionChannels = (data.readStates ?? []).filter((r) => (r.mention_count ?? 0) > 0 && st.known.has(r.id)).map((r) => r.id);
  const backfillTargets: string[] = [];
  for (const c of data.privateChannels ?? []) backfillTargets.push(c.id);
  for (const id of mentionChannels) if (!backfillTargets.includes(id)) backfillTargets.push(id);

  const newest: Record<string, string> = {};
  for (const c of [...(data.channels ?? []), ...(data.threads ?? []), ...(data.privateChannels ?? [])]) if (c.last_message_id) newest[c.id] = c.last_message_id;

  return { events, backfillTargets, newest };
}

/** What the hook answered to openDirect. The gateway's CHANNEL_CREATE says the same again later, harmlessly. */
export function openedDirect(peer: string, r: { channelId: string; channel?: RawChannel | null }, st: AdapterState): P.AdapterEvent[] {
  const recipients = r.channel?.recipients?.length ? r.channel.recipients : [{ id: peer } as RawUser];
  st.known.add(r.channelId);
  return [...userFacts(recipients, st), { t: 'conversation', conversation: mapPrivateChannel({ id: r.channelId, type: CHANNEL_TYPE.DM, recipients }, st.selfId) }];
}

/**
 * Someone added to a group DM, or gone from it: who they are, then the group again with its people as the client's
 * store has them (with them, or without them, whether or not the store had caught up). Without the store's record of
 * the group only who they are: its other people are not known here, and a conversation fact names them all.
 */
export function recipientChange(add: boolean, a: RawRecipientChange, st: AdapterState): P.AdapterEvent[] {
  const user = a.user;
  if (!a.channelId || !user?.id) return [];
  // This account gone from the group: CHANNEL_DELETE says so.
  if (!add && user.id === st.selfId) return [];
  const facts = add ? userFacts([user], st) : [];
  const c = a.channel;
  if (!c || c.id !== a.channelId || c.type !== CHANNEL_TYPE.GROUP_DM) return facts;
  const list = (c.recipients ?? []).filter((r) => r.id !== st.selfId);
  const has = list.some((r) => r.id === user.id);
  const recipients = add ? (has ? list : [...list, user]) : list.filter((r) => r.id !== user.id);
  return [...facts, ...routeChannel({ ...c, recipients }, st)];
}

/**
 * What the hook answered to addRecipients: the people added, then the group with them in it, whether or not the
 * client's store had caught up. The gateway's CHANNEL_RECIPIENT_ADD says the same again later, harmlessly.
 */
export function addedFacts(channelId: string, r: RawAddRecipients, st: AdapterState): P.AdapterEvent[] {
  const users = (r.users ?? []).filter((u) => u?.id && (r.added ?? []).includes(u.id));
  const c = r.channel;
  if (!c || c.id !== channelId || c.type !== CHANNEL_TYPE.GROUP_DM) return userFacts(users, st);
  const list = (c.recipients ?? []).filter((x) => x.id !== st.selfId);
  const have = new Set(list.map((x) => x.id));
  return [...userFacts(users, st), ...routeChannel({ ...c, recipients: [...list, ...users.filter((u) => !have.has(u.id) && u.id !== st.selfId)] }, st)];
}

/** A message and the people it names. Guild members are not in the snapshot, so this is the only place the hub learns their names. */
export function messageEvents(m: RawMessage, st: AdapterState, live: boolean): P.AdapterEvent[] {
  const message = mapMessage(m, st.selfId, { selfRoles: m.guild_id ? st.selfRoles?.get(m.guild_id) : undefined });
  // Pinned already is where a change starts from, not a change.
  if (!live) sawMessage(m, st.changes, false);
  // A message fetched over REST is the whole truth, so no reactions means none are left. A gateway update may just not say.
  if (!live) message.reactions ??= [];
  const guildId = m.guild_id;
  const member = m.member && guildId && m.author?.id ? seenMembers(guildId, [{ user: m.author, ...m.member }], st) : [];
  return [...userFacts([m.author, ...(m.mentions ?? [])], st), ...member, { t: 'message', live, message }];
}

/** How many members the adapter remembers having told, before it forgets them all and tells again. */
const MEMBER_MEMORY = 50_000;
const MEMBERS_PER_EVENT = 500;

/**
 * Members the client already had (a message author's member object, the loaded member list, a chunk it received),
 * as a passive `members` event after their identities: no request is made for them. Each member is told once, and
 * again only when something about them changed; counts only when they changed. The hub keeps them only with its
 * adversarial members setting on.
 */
export function seenMembers(guildId: string, list: RawSeenMember[], st: AdapterState, counts: { total?: number | null; online?: number | null } = {}): P.AdapterEvent[] {
  const fresh: P.MemberFact[] = [];
  const users: RawUser[] = [];
  for (const m of list) {
    if (!m?.user?.id) continue;
    const key = `${guildId}:${m.user.id}`;
    const was = st.members.get(key);
    const prev = was ? (JSON.parse(was) as [string | null, string[] | null, string | null]) : [null, null, null];
    // What a source leaves out stays as it was, as the hub keeps it.
    const now: [string | null, string[] | null, string | null] = [m.nick !== undefined ? m.nick : prev[0], m.roles ?? prev[1], m.joined_at ?? prev[2]];
    const sig = JSON.stringify(now);
    if (was === sig) continue;
    if (st.members.size >= MEMBER_MEMORY) st.members.clear();
    st.members.set(key, sig);
    users.push(m.user);
    const joined = m.joined_at ? Date.parse(m.joined_at) : NaN;
    fresh.push({ who: m.user.id, ...(m.nick ? { nick: m.nick } : {}), ...(m.roles ? { roles: m.roles } : {}), ...(Number.isFinite(joined) ? { joinedAt: joined } : {}) });
  }
  const count = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined);
  const total = count(counts.total);
  const online = count(counts.online);
  const countKey = JSON.stringify([total ?? null, online ?? null]);
  const recount = (total !== undefined || online !== undefined) && st.memberCounts.get(guildId) !== countKey;
  if (recount) st.memberCounts.set(guildId, countKey);
  if (!fresh.length && !recount) return [];
  const events: P.AdapterEvent[] = userFacts(users, st);
  for (let i = 0; i < Math.max(1, fresh.length); i += MEMBERS_PER_EVENT)
    events.push({
      t: 'members',
      space: guildId,
      source: 'seen',
      members: fresh.slice(i, i + MEMBERS_PER_EVENT),
      ...(i === 0 && recount && total !== undefined ? { total } : {}),
      ...(i === 0 && recount && online !== undefined ? { online } : {}),
    });
  return events;
}

/** Identity facts for users the hub has not heard about yet, or not in this form. */
export function userFacts(users: (RawUser | null | undefined)[], st: AdapterState): P.AdapterEvent[] {
  const events: P.AdapterEvent[] = [];
  for (const u of users) {
    if (!u?.username || u.id === st.selfId) continue;
    const known = JSON.stringify([u.username, u.global_name, u.avatar]);
    if (st.users.get(u.id) === known) continue;
    st.users.set(u.id, known);
    events.push({ t: 'identity', identity: mapUser(u, { contact: st.friends.has(u.id) }) });
  }
  return events;
}

/**
 * A server and its channels as the client has them: the server, its categories, then its channels, as the snapshot
 * gives them. For a server joined while connected (GUILD_CREATE of one not seen before, or a join from add.ts).
 */
export function guildFacts(guild: RawGuild, channels: RawChannel[], st: AdapterState): P.AdapterEvent[] {
  st.guilds.set(guild.id, guild);
  const gs = st.guildSettings.get(guild.id);
  const events: P.AdapterEvent[] = [{ t: 'space', space: mapGuild(guild, gs ? mapMute(gs) : undefined) }];
  const list = channels.filter((c) => c?.id && (c.guild_id ?? guild.id) === guild.id).map((c) => ({ ...c, guild_id: guild.id }));
  for (const c of list) if (c.type === CHANNEL_TYPE.CATEGORY) events.push({ t: 'space', space: mapCategory(c, channelMute(gs, c.id)) });
  for (const c of list) if (c.type !== CHANNEL_TYPE.CATEGORY) events.push(...routeChannel(c, st));
  return events;
}

/** A channel or server as a PATCH answered it: the facts a gateway update would give, mutes kept. */
export function changedFacts(r: { channel?: RawChannel | null; guild?: RawGuild | null }, st: AdapterState): P.AdapterEvent[] {
  if (r.channel?.type === CHANNEL_TYPE.CATEGORY) return [{ t: 'space', space: mapCategory(r.channel, channelMute(st.guildSettings.get(r.channel.guild_id ?? ''), r.channel.id)) }];
  if (r.channel) return routeChannel(r.channel, st);
  if (!r.guild) return [];
  const guild = { ...st.guilds.get(r.guild.id), ...r.guild };
  st.guilds.set(guild.id, guild);
  const gs = st.guildSettings.get(guild.id);
  return [{ t: 'space', space: mapGuild(guild, gs ? mapMute(gs) : undefined) }];
}

function guildChannelEvents(c: RawChannel, st: AdapterState): P.AdapterEvent[] {
  st.known.add(c.id);
  const guild = c.guild_id ? st.guilds.get(c.guild_id) : undefined;
  const mute = channelMute(st.guildSettings.get(c.guild_id ?? ''), c.id);
  return [{ t: 'conversation', conversation: mapGuildChannel(c, guild, mute) }];
}

/** Custom statuses that changed, each after its person's identity. */
function statusEvents(list: RawCustomStatus[], st: AdapterState): P.AdapterEvent[] {
  const changed = statusChanges(list, st.changes, st.selfId);
  if (!changed.length) return [];
  const who = new Set(changed.map((e) => (e.t === 'customStatus' ? e.who : '')));
  return [...userFacts(list.map((s) => s.user).filter((u) => u && who.has(u.id)), st), ...changed];
}

/** Presences that changed, each after its person's identity. */
function presenceEvents(list: RawPresence[], st: AdapterState): P.AdapterEvent[] {
  const changed = presenceChanges(list, st.changes, st.selfId);
  if (!changed.length) return [];
  const who = new Set(changed.map((e) => (e.t === 'presence' ? e.who : '')));
  return [...userFacts(list.map((p) => p.user).filter((u) => u && who.has(u.id)), st), ...changed];
}

/** One forwarded Flux action -> zero or more facts. `now` is when it was heard (pins pair signals by it). */
export function translateDispatch(event: DispatchName, a: any, st: AdapterState, now = Date.now()): P.AdapterEvent[] {
  const selfId = st.selfId;
  switch (event) {
    case 'MESSAGE_CREATE':
      // An optimistic one is the client echoing a send in flight under a temporary id; the real one follows from the gateway.
      if (!a.message || a.optimistic) return [];
      // The client's own local notices (Clyde, author "1": a failed send or interaction, said only on this screen) are not messages.
      if (a.message.author?.id === '1') return [];
      sawMessage(a.message, st.changes, true);
      return [...messageEvents(a.message, st, true), ...pinSystemMessage(a.message, st.changes, now), ...pollResultEvents(a.message)];
    case 'MESSAGE_UPDATE': {
      if (!a.message) return [];
      // A partial update without its author can still say it was pinned.
      const pin = pinUpdate(a.message, a.wasPinned, st.changes, now);
      return [...(a.message.author ? messageEvents(a.message, st, true) : []), ...pin];
    }
    case 'CHANNEL_PINS_UPDATE':
      return a.channelId ? pinsChanged(a.channelId, a.lastPinTimestamp, st.changes, now) : [];
    case 'GUILD_MEMBER_UPDATE': {
      noteSelfRoles(a, st);
      const roles = roleChanges(a, st.changes);
      return roles.length ? [...userFacts([a.user], st), ...roles] : [];
    }
    case 'PRESENCE_UPDATE':
    case 'PRESENCE_UPDATES':
    case 'CONNECTION_OPEN_SUPPLEMENTAL':
      return [...statusEvents(a.statuses ?? [], st), ...presenceEvents(a.presences ?? [], st)];
    case 'GUILD_MEMBERS_CHUNK':
    case 'GUILD_MEMBER_LIST_UPDATE': {
      const seen = a as RawMembersSeen;
      return seen.guildId ? seenMembers(seen.guildId, seen.members ?? [], st, { total: seen.memberCount, online: seen.onlineCount }) : [];
    }
    case 'MESSAGE_DELETE':
      return a.id && a.channelId ? [{ t: 'delete', conversation: a.channelId, nativeId: a.id }] : [];
    case 'MESSAGE_REACTION_ADD':
    case 'MESSAGE_REACTION_REMOVE':
      // An optimistic one is the client's own guess; the gateway confirms it.
      if (!a.messageId || !a.emoji || a.optimistic) return [];
      // A poll vote rides on a reaction of its own kind (polls.ts): never a reaction.
      if (a.reactionType === VOTE_REACTION) return voteEvents(a, event === 'MESSAGE_REACTION_REMOVE', selfId);
      return [
        ...userFacts([a.user], st),
        {
          t: 'reaction',
          conversation: a.channelId,
          message: a.messageId,
          author: a.userId,
          key: reactionKey(a.emoji),
          ...(event === 'MESSAGE_REACTION_REMOVE' ? { remove: true } : {}),
          ...(a.reactionType === 1 ? { style: 'super' as const } : {}),
          ...(a.colors?.length ? { colors: a.colors } : {}),
          ...(a.emoji.id ? { emoji: customEmoji(a.emoji) } : {}),
        },
      ];
    case 'MESSAGE_REACTION_REMOVE_ALL':
      return a.messageId ? [{ t: 'reactionsCleared', conversation: a.channelId, message: a.messageId }] : [];
    case 'MESSAGE_REACTION_REMOVE_EMOJI':
      return a.messageId && a.emoji ? [{ t: 'reactionsCleared', conversation: a.channelId, message: a.messageId, key: reactionKey(a.emoji) }] : [];
    case 'CHANNEL_CREATE':
      return a.channel ? routeChannel(a.channel, st) : [];
    case 'CHANNEL_UPDATES':
      return (a.channels ?? []).flatMap((c: RawChannel) => routeChannel(c, st));
    case 'CHANNEL_DELETE':
      return a.channel?.id ? [{ t: 'leave', kind: 'conversation', nativeId: a.channel.id }] : [];
    case 'GUILD_CREATE':
    case 'GUILD_UPDATE':
      if (!a.guild) return [];
      noteSelfRoles(a, st);
      // A server not seen before (joined just now, here or elsewhere): its channels too, as the snapshot would give.
      if (event === 'GUILD_CREATE' && !st.guilds.has(a.guild.id) && Array.isArray(a.channels) && a.channels.length) return guildFacts(a.guild, a.channels, st);
      st.guilds.set(a.guild.id, a.guild);
      return [{ t: 'space', space: mapGuild(a.guild) }];
    case 'GUILD_DELETE':
      return a.id ? [{ t: 'leave', kind: 'space', nativeId: a.id }] : [];
    case 'THREAD_CREATE':
    case 'THREAD_UPDATE':
      if (!a.channel) return [];
      st.known.add(a.channel.id);
      return [{ t: 'conversation', conversation: mapThread(a.channel) }];
    case 'THREAD_DELETE':
      return a.channel?.id ? [{ t: 'leave', kind: 'conversation', nativeId: a.channel.id }] : [];
    case 'THREAD_LIST_SYNC':
      return (a.threads ?? []).map((t: RawChannel) => {
        st.known.add(t.id);
        return { t: 'conversation', conversation: mapThread(t) } as P.AdapterEvent;
      });
    case 'MESSAGE_ACK':
      if (!a.channelId || !a.messageId) return [];
      // Marked unread by hand: the read point moves back, and the hub counts what is unread after it.
      if (a.manual) return [{ t: 'read', conversation: a.channelId, upToTs: snowflakeToMs(a.messageId), manual: true }];
      return [{ t: 'read', conversation: a.channelId, upToTs: snowflakeToMs(a.messageId), mentions: a.mentionCount ?? 0, unread: a.mentionCount ?? 0 }];
    case 'CHANNEL_RECIPIENT_ADD':
    case 'CHANNEL_RECIPIENT_REMOVE':
      return recipientChange(event === 'CHANNEL_RECIPIENT_ADD', a, st);
    case 'TYPING_START': {
      if (!a.channelId || !a.userId || a.userId === selfId) return [];
      // A name for the hub to show if it has never heard of them; no identity is stored for typing alone.
      const name = a.nick || (a.user?.username ? userDisplayName(a.user) : undefined);
      return [{ t: 'typing', conversation: a.channelId, author: a.userId, ...(name ? { name } : {}) }];
    }
    default:
      return richDispatch(event, a, st);
  }
}

// ------------------------------------------------------------ rich messages (rich.ts)

/** Your own roles changed (GUILD_MEMBER_UPDATE of you), or came with a server joined (GUILD_CREATE's self_roles). */
function noteSelfRoles(a: any, st: AdapterState) {
  const guildId = a?.guildId ?? a?.guild_id ?? a?.guild?.id;
  const roles = a?.user?.id === st.selfId ? a.roles : a?.self_roles;
  if (!guildId || !Array.isArray(roles)) return;
  (st.selfRoles ??= new Map()).set(String(guildId), roles.filter((r: unknown) => typeof r === 'string'));
}

/** A moderator's purge, and reactions added in a batch: what the hook forwards for them. */
function richDispatch(event: DispatchName, a: any, st: AdapterState): P.AdapterEvent[] {
  switch (event) {
    case 'MESSAGE_DELETE_BULK':
      if (!a?.channelId || !Array.isArray(a.ids)) return [];
      return a.ids.filter((id: unknown) => typeof id === 'string' && id).map((id: string) => ({ t: 'delete', conversation: a.channelId, nativeId: id }) as P.AdapterEvent);
    case 'MESSAGE_REACTION_ADD_MANY': {
      if (!a?.channelId || !a.messageId || !Array.isArray(a.reactions)) return [];
      // Poll votes come this way too (reactionType 2): told as votes (polls.ts), not as reactions.
      const out: P.AdapterEvent[] = manyVoteEvents(a, st.selfId);
      for (const r of a.reactions) {
        if (!r?.emoji || r.reactionType === 2) continue;
        for (const user of Array.isArray(r.users) ? r.users : []) {
          const id = typeof user === 'string' ? user : user?.id;
          if (!id) continue;
          if (typeof user === 'object') out.push(...userFacts([user], st));
          out.push({
            t: 'reaction',
            conversation: a.channelId,
            message: a.messageId,
            author: id,
            key: reactionKey(r.emoji),
            ...(r.reactionType === 1 ? { style: 'super' as const } : {}),
            ...(r.emoji.id ? { emoji: customEmoji(r.emoji) } : {}),
          });
        }
      }
      return out;
    }
    default:
      return [];
  }
}

/** A channel, thread or DM to its fact, by its type; known from now on. */
export function routeChannel(c: RawChannel, st: AdapterState): P.AdapterEvent[] {
  if (c.type === CHANNEL_TYPE.CATEGORY) return [{ t: 'space', space: mapCategory(c) }];
  if (isPrivate(c.type)) {
    st.known.add(c.id);
    return [{ t: 'conversation', conversation: mapPrivateChannel(c, st.selfId) }];
  }
  if (isThread(c.type)) {
    st.known.add(c.id);
    return [{ t: 'conversation', conversation: mapThread(c) }];
  }
  return guildChannelEvents(c, st);
}
