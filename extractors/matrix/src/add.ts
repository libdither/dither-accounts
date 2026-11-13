/**
 * Adding on Matrix (dither-chat docs/add.md): what a room address or a user is, joining and knocking, and the
 * requests waiting on you (invites from sync, and knocks on rooms where you can let people in).
 *
 *   resolve place   GET /directory/room/{alias}, then the room summary (MSC3266: v1, then nheko's unstable path),
 *                   then a /publicRooms search on the room's server. Nothing the room can see.
 *   resolve person  GET /profile/{userId}
 *   add join        POST /join/{roomIdOrAlias}?server_name=…, then the room's facts once sync has it
 *   add ask         POST /knock/{roomIdOrAlias}?server_name=…
 *   answer invite   accept: POST /join; decline: POST /rooms/{id}/leave; block: leave, then m.ignored_user_list
 *   answer knock    accept: POST /rooms/{id}/invite; decline: POST /rooms/{id}/kick with a reason
 *
 * Every write here comes from the owner's click and is tried once: a join that times out may have gone through, and
 * a second try would be a second action. A homeserver's terms (M_CONSENT_NOT_GIVEN) come back as the 'rules' check
 * with nothing done; they are never accepted from here.
 */

import type * as P from '@dither-chat/protocol';
import { enc, isAbortError, MatrixError, type MatrixClient } from './http.ts';
import type { Directory, Room } from './rooms.ts';

/** The hub waits 30 s for a lookup: every request of one shares this. */
const RESOLVE_BUDGET_MS = 25_000;
/** The hub waits 90 s for a join: the POST, then sync bringing the room. */
const JOIN_BUDGET_MS = 85_000;
const JOIN_TIMEOUT_MS = 60_000;
const SYNC_WAIT_MS = 25_000;
const KNOCK_RULES = new Set(['knock', 'knock_restricted']);
/** A Matrix user ID: @name:server. */
export const MXID = /^@[^\s:/]+:[^\s/]+$/;
export const DECLINE_REASON = 'Your request to join was declined';

export interface AddHost {
  api: Pick<MatrixClient, 'request'>;
  dir: Directory;
  /** This account can read encrypted rooms. */
  e2ee: boolean;
  requests: Requests;
  identity(f: P.IdentityFact): void;
  /** Wait for sync to bring the room as joined, then send its facts. False when it did not come within waitMs. */
  synced(roomId: string, waitMs: number): Promise<boolean>;
  /** List a room in m.direct as the direct chat with this person. */
  markDirect(peer: string, roomId: string): Promise<void>;
  log(msg: string): void;
}

// ------------------------------------------------------------------ small helpers

const str = (x: unknown): string | undefined => (typeof x === 'string' && x.trim() ? x.trim() : undefined);
const mxc = (x: unknown): string | undefined => (typeof x === 'string' && x.startsWith('mxc://') ? x : undefined);
const count = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.trunc(x) : undefined);
/** The server part of a Matrix id: everything after the first colon. */
export const serverOf = (id: string) => id.slice(id.indexOf(':') + 1);
const uniq = (xs: string[]) => [...new Set(xs.filter((x) => typeof x === 'string' && x.length > 0))];
/** A repeated query parameter (MatrixClient's query sets one value per key). */
const repeated = (key: string, values: string[]) => (values.length ? `?${values.map((v) => `${key}=${enc(v)}`).join('&')}` : '');

function deadline(ms: number) {
  const end = Date.now() + ms;
  return {
    left: () => end - Date.now(),
    /** A request's timeout: at most `cap`, never past the end. */
    timeout: (cap: number) => Math.max(1_000, Math.min(cap, end - Date.now())),
  };
}

/** When a rate limit frees up, in words. */
export function inWords(ms: number): string {
  const s = Math.max(1, Math.ceil(ms / 1000));
  if (s < 90) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.ceil(s / 60);
  if (m < 90) return `${m} minutes`;
  const h = Math.round(m / 60);
  return `${h} hour${h === 1 ? '' : 's'}`;
}

export const sentence = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

/** The plain sentence for a failed request. `acted`: the request may have done something even though it failed. */
export function errorSentence(e: unknown, doing: string, acted = false): Error {
  if (e instanceof MatrixError) {
    if (e.isRateLimit) {
      const ms = e.retryAfterMs;
      return new Error(`The homeserver is limiting how often this account can ${doing}. ${ms ? `Try again in ${inWords(ms)}.` : 'Try again in a little while.'}`);
    }
    if (e.isAuth) return new Error('The homeserver ended this account’s session: sign in again on the account page.');
    return new Error(`Couldn't ${doing}: ${sentence(e.error || e.errcode)}`);
  }
  if (isAbortError(e)) return new Error(acted ? `The homeserver did not answer in time. It may still ${doing}: look again in a minute.` : `The homeserver did not answer in time, so this account couldn't ${doing}.`);
  const msg = String((e as Error)?.message ?? e);
  return new Error(acted ? `Lost the connection to the homeserver (${msg}). It may still ${doing}: look again in a minute.` : `Couldn't reach the homeserver to ${doing}: ${msg}`);
}

/** The homeserver wants its terms accepted first: a check for the owner, never accepted here. */
function consentCheck(e: unknown): P.AddResult | null {
  if (!(e instanceof MatrixError) || e.errcode !== 'M_CONSENT_NOT_GIVEN') return null;
  const uri = typeof e.data.consent_uri === 'string' && /^https?:\/\//.test(e.data.consent_uri) ? e.data.consent_uri : null;
  return { check: 'rules', notes: [uri ? `Your homeserver wants you to agree to its terms first, at ${uri}. Nothing was done.` : 'Your homeserver wants you to agree to its terms first. Nothing was done.'] };
}

/** The endpoint is not there (an older server): try the next way. */
const unsupported = (e: unknown) => e instanceof MatrixError && (e.errcode === 'M_UNRECOGNIZED' || ((e.status === 404 || e.status === 405) && e.errcode.startsWith('HTTP_')));

const aliasesOf = (room: Room): string[] => {
  const c = room.get('m.room.canonical_alias')?.content;
  return uniq([c?.alias, ...(Array.isArray(c?.alt_aliases) ? c.alt_aliases : [])]);
};

/** A room this account is in, by id or by one of its addresses. */
function joinedRoom(dir: Directory, address: string): Room | undefined {
  if (address.startsWith('!')) {
    const r = dir.rooms.get(address);
    return r?.membership === 'join' ? r : undefined;
  }
  return dir.joined().find((r) => aliasesOf(r).includes(address));
}

const joinedIds = (room: Room) => (room.isSpace ? { space: room.id } : { conversation: room.id });
const inAlready = (room: Room) => (room.isSpace ? 'You are in this space already' : 'You are in this room already');

function joinedPreview(dir: Directory, room: Room): P.AddPreview {
  return {
    what: room.isSpace ? 'space' : 'room',
    name: dir.displayName(room) ?? room.id,
    nativeId: room.id,
    ...(room.avatar ? { avatar: room.avatar } : {}),
    ...(room.topic ? { description: room.topic } : {}),
    members: room.joinedCount,
    joined: joinedIds(room),
    actions: [],
    notes: [inAlready(room)],
  };
}

/** Power levels: who may invite and who may kick, with the spec's defaults. */
function level(v: unknown, d: number): number {
  if (v === undefined || v === null) return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
export function admits(room: Room, user: string): { invite: boolean; kick: boolean } {
  const pl = room.get('m.room.power_levels')?.content;
  const mine = room.powerLevel(user);
  return { invite: mine >= level(pl?.invite, 0), kick: mine >= level(pl?.kick, 50) };
}

/** Rooms whose knocks this account answers: knocking is on and it may invite. */
export const answersKnocks = (room: Room, self: string) => KNOCK_RULES.has(room.joinRule ?? '') && admits(room, self).invite;

// ------------------------------------------------------------------ resolve

export async function resolve(h: AddHost, ref: P.AddRef): Promise<P.AddPreview> {
  if (ref.network !== 'matrix') throw new Error('That is not a Matrix address');
  if (ref.kind === 'place') return resolvePlace(h, ref.address, ref.via ?? []);
  if (ref.kind === 'person') return resolvePerson(h, ref.handle);
  throw new Error('Matrix has rooms by address (#name:server or !id:server) and people by ID (@name:server), not invite links');
}

interface Summary {
  room_id?: unknown;
  name?: unknown;
  topic?: unknown;
  avatar_url?: unknown;
  canonical_alias?: unknown;
  num_joined_members?: unknown;
  room_type?: unknown;
  join_rule?: unknown;
  membership?: unknown;
  allowed_room_ids?: unknown;
  encryption?: unknown;
  'im.nheko.summary.encryption'?: unknown;
}

async function resolvePlace(h: AddHost, address: string, via: string[]): Promise<P.AddPreview> {
  const local = joinedRoom(h.dir, address);
  if (local) return joinedPreview(h.dir, local);
  const time = deadline(RESOLVE_BUDGET_MS);
  let roomId = address.startsWith('!') ? address : undefined;
  let servers = uniq(via);

  if (!roomId) {
    try {
      const res = await h.api.request('GET', `/_matrix/client/v3/directory/room/${enc(address)}`, { retries: 0, timeoutMs: time.timeout(12_000) });
      if (typeof res?.room_id !== 'string' || !res.room_id.startsWith('!')) throw new Error(`the directory gave no room for ${address}`);
      roomId = res.room_id as string;
      servers = uniq([...servers, ...(Array.isArray(res.servers) ? res.servers : [])]).slice(0, 10);
    } catch (e) {
      if (e instanceof MatrixError && e.errcode === 'M_NOT_FOUND') throw new Error(`This room alias doesn't exist on ${serverOf(address)}`);
      throw errorSentence(e, `look up ${address}`);
    }
    const known = h.dir.rooms.get(roomId);
    if (known?.membership === 'join') return joinedPreview(h.dir, known);
  }
  const id = roomId as string;

  // The summary: what the room shows to someone outside it. A room it does not show is private, or not there.
  let summary: Summary | null = null;
  let hidden = false;
  for (const path of [`/_matrix/client/v1/room_summary/${enc(id)}`, `/_matrix/client/unstable/im.nheko.summary/rooms/${enc(id)}/summary`]) {
    if (time.left() < 1_000) break;
    try {
      summary = await h.api.request<Summary>('GET', path + repeated('via', servers), { retries: 0, timeoutMs: time.timeout(10_000) });
      break;
    } catch (e) {
      if (e instanceof MatrixError && e.isRateLimit) throw errorSentence(e, `look up ${address}`);
      if (unsupported(e)) continue;
      if (e instanceof MatrixError && (e.errcode === 'M_NOT_FOUND' || e.errcode === 'M_FORBIDDEN')) hidden = true;
      break;
    }
  }
  // Older servers: the public room list of the room's own server.
  if (!summary && time.left() >= 1_000) {
    const server = address.startsWith('#') ? serverOf(address) : servers[0];
    try {
      const res = await h.api.request('POST', '/_matrix/client/v3/publicRooms', {
        query: server ? { server } : undefined,
        body: { limit: 20, filter: { generic_search_term: address } },
        retries: 0,
        timeoutMs: time.timeout(10_000),
      });
      const hit = (Array.isArray(res?.chunk) ? res.chunk : []).find((c: any) => c?.room_id === id);
      if (hit) summary = { ...hit, join_rule: hit.join_rule ?? 'public' };
    } catch (e) {
      if (e instanceof MatrixError && e.isRateLimit) throw errorSentence(e, `look up ${address}`);
    }
  }

  if (!summary) {
    return {
      what: 'room',
      name: address,
      partial: true,
      nativeId: id,
      actions: hidden ? ['join'] : ['join', 'ask'],
      notes: [hidden ? 'Matrix shows this room only to its members: it may be invite-only, or gone. Join tries anyway.' : 'This homeserver cannot show a room before you join it.'],
    };
  }
  return previewOf(h, address, id, summary);
}

function previewOf(h: AddHost, address: string, id: string, s: Summary): P.AddPreview {
  const space = s.room_type === 'm.space';
  const what = space ? 'space' : 'room';
  const nativeId = typeof s.room_id === 'string' && s.room_id.startsWith('!') ? s.room_id : id;
  const base = {
    what,
    nativeId,
    ...(mxc(s.avatar_url) ? { avatar: mxc(s.avatar_url) } : {}),
    ...(str(s.topic) ? { description: str(s.topic) } : {}),
    ...(count(s.num_joined_members) !== undefined ? { members: count(s.num_joined_members) } : {}),
  } as const;
  const name = str(s.name) ?? str(s.canonical_alias) ?? address;
  const notes: string[] = [];
  const encrypted = !!(s.encryption ?? s['im.nheko.summary.encryption']);
  if (encrypted && !h.e2ee) notes.push(`This ${what} is end-to-end encrypted: set up encryption on the account page to read it here.`);
  const asks = `Joining asks the ${what}'s admins first (a knock).`;

  switch (s.membership) {
    case 'join':
      return { ...base, name, joined: space ? { space: nativeId } : { conversation: nativeId }, actions: [], notes: [space ? 'You are in this space already' : 'You are in this room already'] };
    case 'invite':
      return { ...base, name, actions: ['join'], notes: [`You have an invite to this ${what}: joining accepts it.`, ...notes] };
    case 'knock':
      return { ...base, name, actions: [], notes: [`You asked to join this ${what} already; its admins decide.`] };
    case 'ban':
      return { ...base, name, actions: [], notes: [`This account is banned from this ${what}.`] };
  }
  const rule = s.join_rule ?? 'public';
  switch (rule) {
    case 'public':
      return { ...base, name, actions: ['join'], ...(notes.length ? { notes } : {}) };
    case 'knock':
      return { ...base, name, actions: ['ask'], notes: [asks, ...notes] };
    case 'restricted':
    case 'knock_restricted': {
      const allowed = (Array.isArray(s.allowed_room_ids) ? s.allowed_room_ids : []).map((r) => h.dir.rooms.get(String(r))).filter((r): r is Room => r?.membership === 'join');
      if (allowed.length) {
        const names = allowed.map((r) => h.dir.displayName(r) ?? r.id).slice(0, 3);
        return { ...base, name, actions: ['join'], notes: [`Open to members of ${names.join(', ')}.`, ...notes] };
      }
      if (rule === 'knock_restricted') return { ...base, name, actions: ['ask'], notes: [asks, ...notes] };
      return { ...base, name, actions: [], notes: [`Only members of certain spaces can join this ${what}; anyone else needs an invite.`] };
    }
    case 'invite':
    case 'private':
      return { ...base, name, actions: [], notes: [`This ${what} is invite-only: someone in it has to invite you.`] };
    default:
      return { ...base, name: address, partial: true, actions: ['join', 'ask'], notes: [`Matrix did not say how to get into "${name}" (its join rule is "${String(rule).slice(0, 40)}"). Join tries to join; Ask knocks.`, ...notes] };
  }
}

async function resolvePerson(h: AddHost, handle: string): Promise<P.AddPreview> {
  if (!MXID.test(handle)) throw new Error(`${handle} is not a Matrix user ID`);
  const self = handle === h.dir.selfId;
  const contact = h.dir.isContact(handle);
  const relationship = { relationship: contact ? 'contact' : 'stranger' } as const;
  const actions: P.AddAction[] = self ? [] : ['message'];
  let profile: any;
  try {
    profile = await h.api.request('GET', `/_matrix/client/v3/profile/${enc(handle)}`, { retries: 0, timeoutMs: 15_000 });
  } catch (e) {
    if (e instanceof MatrixError && e.errcode === 'M_NOT_FOUND') throw new Error(`There is no Matrix user ${handle}`);
    if (e instanceof MatrixError && (e.isRateLimit || e.isAuth)) throw errorSentence(e, `look up ${handle}`);
    // A server that shows profiles only to people who share a room, or one that cannot be reached: Message still works.
    h.identity({ nativeId: handle, handle, ...(contact ? { contact: true } : {}) });
    const forbidden = e instanceof MatrixError && e.errcode === 'M_FORBIDDEN';
    return {
      what: 'person',
      name: handle,
      partial: true,
      nativeId: handle,
      ...(self ? {} : relationship),
      actions,
      notes: [forbidden ? 'Their server shows profiles only to people who share a room with them.' : `Couldn't reach ${serverOf(handle)} to look them up.`],
    };
  }
  const displayName = str(profile?.displayname);
  const avatar = mxc(profile?.avatar_url);
  h.identity({ nativeId: handle, handle, ...(displayName ? { displayName } : {}), ...(avatar ? { avatarUrl: avatar } : {}), ...(contact ? { contact: true } : {}) });
  return {
    what: 'person',
    name: displayName ?? handle,
    nativeId: handle,
    ...(avatar ? { avatar } : {}),
    ...(self ? { notes: ['This is you'] } : relationship),
    actions,
  };
}

// ------------------------------------------------------------------ add

export async function add(h: AddHost, ref: P.AddRef, action: Exclude<P.AddAction, 'message'>): Promise<P.AddResult> {
  if (ref.network !== 'matrix') throw new Error('That is not a Matrix address');
  if (action !== 'join' && action !== 'ask') throw new Error('Matrix has no friend requests, follows or contacts: Message starts a direct chat');
  if (ref.kind !== 'place') throw new Error(ref.kind === 'person' ? 'A person cannot be joined: Message starts a direct chat' : 'Matrix joins rooms by address (#name:server) or ID (!id:server)');
  const local = joinedRoom(h.dir, ref.address);
  if (local) return { ...joinedIds(local), notes: [inAlready(local)] };
  const via = uniq(ref.via ?? []).slice(0, 10);
  return action === 'join' ? join(h, ref.address, via, ref.address) : knock(h, ref.address, via);
}

/** POST /join, then wait for sync to bring the room so its facts go before the reply. */
async function join(h: AddHost, target: string, servers: string[], label: string, then?: (roomId: string) => Promise<void>): Promise<P.AddResult> {
  const t0 = Date.now();
  let roomId: string;
  try {
    const res = await h.api.request('POST', `/_matrix/client/v3/join/${enc(target)}${repeated('server_name', servers)}`, { body: {}, retries: 0, timeoutMs: JOIN_TIMEOUT_MS });
    roomId = typeof res?.room_id === 'string' ? res.room_id : target;
  } catch (e) {
    const check = consentCheck(e);
    if (check) return check;
    throw errorSentence(e, `join ${label}`, true);
  }
  h.log(`joined ${roomId}`);
  // An invite to it is answered now.
  h.requests.forget(roomId);
  if (then) await then(roomId);
  const wait = Math.min(SYNC_WAIT_MS, Math.max(2_000, JOIN_BUDGET_MS - (Date.now() - t0)));
  if (!(await h.synced(roomId, wait))) return { notes: ['Joined. It shows up here once the account has synced it.'] };
  const room = h.dir.rooms.get(roomId)!;
  return room.isSpace ? { space: roomId, notes: ['Joined the space; its rooms are joined separately.'] } : { conversation: roomId };
}

async function knock(h: AddHost, target: string, servers: string[]): Promise<P.AddResult> {
  try {
    await h.api.request('POST', `/_matrix/client/v3/knock/${enc(target)}${repeated('server_name', servers)}`, { body: {}, retries: 0, timeoutMs: JOIN_TIMEOUT_MS });
  } catch (e) {
    const check = consentCheck(e);
    if (check) return check;
    throw errorSentence(e, `ask to join ${target}`, true);
  }
  h.log(`knocked on ${target}`);
  return { pending: true, notes: ["Asked to join; the room's admins decide. Their invite shows up in your requests."] };
}

// ------------------------------------------------------------------ answer

export async function answer(h: AddHost, request: string, ans: P.RequestAnswer): Promise<P.AddResult> {
  const r = h.requests.get(request);
  if (!r) throw new Error('That request is not waiting any more');
  if (!r.fact.answers.includes(ans)) throw new Error(`This request can be answered with ${r.fact.answers.join(', ')}`);
  if (r.invite) return answerInvite(h, r.invite, ans);
  return answerKnock(h, r.knock!, ans);
}

async function answerInvite(h: AddHost, inv: Invite, ans: P.RequestAnswer): Promise<P.AddResult> {
  const what = inv.space ? 'space' : 'room';
  if (ans === 'accept') {
    const peer = inv.direct ? inv.inviter?.nativeId : undefined;
    // Through the inviter's server, which is in the room.
    return join(h, inv.room, inv.inviter ? [serverOf(inv.inviter.nativeId)] : [], inv.name ?? `the ${what}`, async (roomId) => {
      if (peer) await h.markDirect(peer, roomId).catch((e) => h.log(`could not list ${roomId} as a direct chat: ${String((e as Error)?.message ?? e)}`));
    });
  }
  // Declining an invite is leaving the room it is for.
  try {
    await h.api.request('POST', `/_matrix/client/v3/rooms/${enc(inv.room)}/leave`, { body: {}, retries: 0 });
  } catch (e) {
    const check = consentCheck(e);
    if (check) return check;
    throw errorSentence(e, 'decline the invite', true);
  }
  h.log(`declined the invite to ${inv.room}`);
  h.requests.forget(inv.room);
  if (ans === 'decline' || !inv.inviter) return {};
  const who = inv.inviter.nativeId;
  try {
    await ignore(h, who);
  } catch (e) {
    throw new Error(`Declined the invite, but ${errorSentence(e, `block ${who}`).message.replace(/^./, (c) => c.toLowerCase())}`);
  }
  h.log(`ignoring ${who}`);
  return { identity: who, relationship: 'blocked' };
}

/** Add someone to m.ignored_user_list, keeping everyone already on it. */
async function ignore(h: AddHost, user: string) {
  const path = `/_matrix/client/v3/user/${enc(h.dir.selfId)}/account_data/m.ignored_user_list`;
  const current = await h.api.request<Record<string, unknown>>('GET', path, { retries: 1 }).catch((e) => {
    if (e instanceof MatrixError && e.status === 404) return {} as Record<string, unknown>;
    throw e;
  });
  const content = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  const list = content.ignored_users && typeof content.ignored_users === 'object' && !Array.isArray(content.ignored_users) ? (content.ignored_users as Record<string, unknown>) : {};
  if (user in list) return;
  await h.api.request('PUT', path, { body: { ...content, ignored_users: { ...list, [user]: {} } }, retries: 1 });
}

async function answerKnock(h: AddHost, k: Knock, ans: P.RequestAnswer): Promise<P.AddResult> {
  const accept = ans === 'accept';
  try {
    await h.api.request('POST', `/_matrix/client/v3/rooms/${enc(k.room)}/${accept ? 'invite' : 'kick'}`, { body: accept ? { user_id: k.user } : { user_id: k.user, reason: DECLINE_REASON }, retries: 0 });
  } catch (e) {
    const check = consentCheck(e);
    if (check) return check;
    throw errorSentence(e, accept ? `let ${k.user} in` : `decline ${k.user}'s request`, true);
  }
  h.log(`${accept ? 'invited' : 'turned away'} ${k.user} who knocked on ${k.room}`);
  h.requests.answered(k.id);
  return accept ? { identity: k.user, notes: ['Invited; they are in once they accept.'] } : { identity: k.user };
}

// ------------------------------------------------------------------ requests

/** A pending invite, from sync's rooms.invite (stripped state). Kept in matrix.sqlite: sync sends each one once. */
export interface Invite {
  room: string;
  inviter?: P.IdentityFact;
  name?: string;
  space: boolean;
  /** The invite says it is a direct chat (is_direct). */
  direct: boolean;
  ts: number;
}

export interface Knock {
  id: string;
  room: string;
  user: string;
}

/** Read an invited room's stripped state. `ts`: when it was first seen, for servers that send no timestamp. */
export function inviteOf(roomId: string, entry: any, selfId: string, ts: number): Invite {
  const events: any[] = Array.isArray(entry?.invite_state?.events) ? entry.invite_state.events : [];
  const state = (type: string, key = '') => events.findLast((e) => e?.type === type && e.state_key === key);
  const me = state('m.room.member', selfId);
  const inviterId = typeof me?.sender === 'string' && me.sender !== selfId && MXID.test(me.sender) ? (me.sender as string) : undefined;
  const im = inviterId ? state('m.room.member', inviterId) : undefined;
  const name = str(state('m.room.name')?.content?.name) ?? str(state('m.room.canonical_alias')?.content?.alias);
  const displayName = str(im?.content?.displayname);
  const avatarUrl = mxc(im?.content?.avatar_url);
  return {
    room: roomId,
    ...(inviterId ? { inviter: { nativeId: inviterId, handle: inviterId, ...(displayName ? { displayName } : {}), ...(avatarUrl ? { avatarUrl } : {}) } } : {}),
    ...(name ? { name: name.slice(0, 200) } : {}),
    space: state('m.room.create')?.content?.type === 'm.space',
    direct: me?.content?.is_direct === true,
    ts: typeof me?.origin_server_ts === 'number' && me.origin_server_ts > 0 ? me.origin_server_ts : ts,
  };
}

export function inviteFact(inv: Invite): P.RequestFact {
  return {
    nativeId: inv.room,
    kind: 'invite',
    ...(inv.inviter ? { from: inv.inviter.nativeId } : {}),
    target: { kind: inv.space ? 'space' : 'conversation', nativeId: inv.room, ...(inv.name ? { name: inv.name } : {}) },
    ts: inv.ts,
    answers: inv.inviter ? ['accept', 'decline', 'block'] : ['accept', 'decline'],
  };
}

const knockId = (room: string, user: string) => `knock|${room}|${user}`;

/** Knocks on joined rooms that take them and where this account may invite: from the stored room state. */
export function knocksOf(dir: Directory): { fact: P.RequestFact; knock: Knock; person: P.IdentityFact }[] {
  const out: { fact: P.RequestFact; knock: Knock; person: P.IdentityFact }[] = [];
  for (const room of dir.joined()) {
    if (!answersKnocks(room, dir.selfId)) continue;
    const can = admits(room, dir.selfId);
    for (const ev of room.ofType('m.room.member')) {
      const user = ev.state_key!;
      if (ev.content?.membership !== 'knock' || user === dir.selfId || ev.event_id.startsWith('~')) continue;
      const id = knockId(room.id, user);
      const name = dir.displayName(room);
      out.push({
        fact: {
          nativeId: id,
          kind: 'join',
          from: user,
          target: { kind: room.isSpace ? 'space' : 'conversation', nativeId: room.id, ...(name ? { name } : {}), members: room.joinedCount },
          ts: ev.origin_server_ts || Date.now(),
          answers: can.kick ? ['accept', 'decline'] : ['accept'],
        },
        knock: { id, room: room.id, user },
        person: dir.identity(room, user),
      });
    }
  }
  return out;
}

interface Entry {
  fact: P.RequestFact;
  invite?: Invite;
  knock?: Knock;
  person?: P.IdentityFact;
}

const KV = 'invites';
/** Set once the store has had a whole list of invites: an initial sync, or the snapshot. */
const KV_TRACKED = 'invites.tracked';

/**
 * The requests waiting on this account, and what the hub has been told of them. The whole list goes once it is known
 * (after the first sync of this process), and again on every reconnect; after that only what changed.
 */
export class Requests {
  private invites = new Map<string, Invite>();
  /** Knocks answered here, until sync shows the member's new state. */
  private done = new Set<string>();
  private sent = new Map<string, string>();
  private wholeSent = false;
  private known = false;

  constructor(
    private o: {
      dir: Directory;
      kv: { get(k: string): string | null; set(k: string, v: string | null): void };
      emit(ev: P.AdapterEvent): void;
      identity(f: P.IdentityFact): void;
    },
  ) {}

  /** This store has followed invites since a full list: an initial sync, or the snapshot after an upgrade. */
  get tracked(): boolean {
    return this.o.kv.get(KV_TRACKED) !== null;
  }

  load() {
    this.invites.clear();
    try {
      for (const inv of JSON.parse(this.o.kv.get(KV) ?? '[]') as Invite[]) if (typeof inv?.room === 'string') this.invites.set(inv.room, inv);
    } catch {}
  }

  /** The account changed: nothing of the old one's. */
  reset() {
    this.invites.clear();
    this.done.clear();
    this.known = false;
    this.o.kv.set(KV, null);
    this.o.kv.set(KV_TRACKED, null);
  }

  private save() {
    this.o.kv.set(KV, JSON.stringify([...this.invites.values()]));
  }

  /** One sync's rooms. An initial sync's rooms.invite is the whole list; later ones bring changes. */
  sync(rooms: any, initial: boolean, now = Date.now()) {
    const invited = Object.entries<any>(rooms?.invite ?? {});
    const gone = initial ? [] : [...Object.keys(rooms?.join ?? {}), ...Object.keys(rooms?.leave ?? {})].filter((id) => this.invites.has(id));
    if (!initial && !invited.length && !gone.length) return;
    const before = new Map(this.invites);
    if (initial) this.invites.clear();
    for (const [id, entry] of invited) this.invites.set(id, inviteOf(id, entry, this.o.dir.selfId, before.get(id)?.ts ?? now));
    for (const id of gone) this.invites.delete(id);
    this.save();
    if (initial) this.o.kv.set(KV_TRACKED, '1');
  }

  /** The full list from a sync without a since token (see the adapter's snapshot). */
  snapshot(invite: Record<string, unknown>, now = Date.now()) {
    this.sync({ invite }, true, now);
  }

  /** Sync has run in this process: from now on the list is known, if this store follows invites. */
  ready() {
    if (this.tracked) this.known = true;
  }

  /** An invite answered here (or a room joined that had one). */
  forget(roomId: string) {
    if (!this.invites.delete(roomId)) return;
    this.save();
    this.flush();
  }

  /** A knock answered here. */
  answered(id: string) {
    this.done.add(id);
    this.flush();
  }

  get(id: string): Entry | undefined {
    return this.current().find((e) => e.fact.nativeId === id);
  }

  private current(): Entry[] {
    const out: Entry[] = [];
    const dir = this.o.dir;
    for (const inv of this.invites.values()) {
      if (dir.rooms.get(inv.room)?.membership === 'join') continue;
      const person = inv.inviter ? { ...inv.inviter, ...(dir.isContact(inv.inviter.nativeId) ? { contact: true } : {}) } : undefined;
      out.push({ fact: inviteFact(inv), invite: inv, ...(person ? { person } : {}) });
    }
    const knocks = knocksOf(dir);
    const ids = new Set(knocks.map((k) => k.knock.id));
    for (const id of this.done) if (!ids.has(id)) this.done.delete(id);
    for (const k of knocks) if (!this.done.has(k.knock.id)) out.push(k);
    return out;
  }

  /** Tell the hub: the whole list if it has not had it on this connection, else what changed. Identities first. */
  flush() {
    const list = this.current();
    for (const e of list) if (e.person) this.o.identity(e.person);
    const now = new Map(list.map((e) => [e.fact.nativeId, JSON.stringify(e.fact)]));
    if (this.known && !this.wholeSent) {
      this.o.emit({ t: 'requests', requests: list.map((e) => e.fact) });
      this.wholeSent = true;
    } else {
      for (const [id, json] of now) if (this.sent.get(id) !== json) this.o.emit({ t: 'request', request: JSON.parse(json) });
      for (const id of this.sent.keys()) if (!now.has(id)) this.o.emit({ t: 'requestGone', nativeId: id });
    }
    this.sent = now;
  }

  /** A (re)connect to the hub: the whole list again, once it is known. */
  reconnected() {
    this.wholeSent = false;
    if (this.known) this.flush();
  }
}
