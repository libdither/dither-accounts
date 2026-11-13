/**
 * Past reading and writing in a conversation (docs/x.md "Requests, new chats and groups"): message requests as the
 * hub's request facts, a conversation's About from its inbox row, and the facts and results of making a one-to-one or
 * a group and adding people. Pure: main.ts runs the page's commands and emits what these return.
 */
import type * as P from '@dither-chat/protocol';
import type { XState } from './ingest.ts';
import { conversationFact, identityFact, peerOf, shapeOf } from './map.ts';
import type { RawAbout, RawConversation, RawRequests } from './raw.ts';

/** What X lets you answer: a one-to-one request with Accept, Delete or Block; a group's only with Accept. */
export function answersOf(c: RawConversation, selfId: string | null): P.RequestAnswer[] {
  return shapeOf(c, selfId) === 'group' ? ['accept'] : ['accept', 'decline', 'block'];
}

/** A request on the Requests page as the hub's fact. Its id is the conversation's: one request per conversation. */
export function requestFact(c: RawConversation, selfId: string | null, now = Date.now()): P.RequestFact {
  const group = shapeOf(c, selfId) === 'group';
  const from = group ? null : peerOf(c, selfId);
  return {
    nativeId: c.id,
    // A one-to-one from someone who is not a contact is a message request; a group you were put in, an invitation.
    kind: group ? 'invite' : 'message',
    ...(from ? { from } : {}),
    target: { kind: 'conversation', nativeId: c.id, ...(group && c.title ? { name: c.title } : {}), ...(group ? { members: c.users.length + 1 } : {}) },
    ts: c.lastTs ?? now,
    answers: answersOf(c, selfId),
  };
}

/** The requests the hub was told, so only changes go out; the whole list after each connect. */
export class Requests {
  readonly told = new Map<string, string>();
  readonly raw = new Map<string, RawConversation>();
  known = false;

  /** Every request waiting now, as the hub's facts. */
  facts(selfId: string | null): P.RequestFact[] {
    return [...this.raw.values()].map((c) => requestFact(c, selfId));
  }
  has(id: string): boolean {
    return this.raw.has(id);
  }
  /** The whole list again (after the hub reconnects): its people first. */
  all(st: XState): P.AdapterEvent[] {
    if (!this.known) return [];
    const out: P.AdapterEvent[] = [];
    for (const c of this.raw.values()) for (const u of c.users) out.push({ t: 'identity', identity: identityFact(u, st.selfId) });
    out.push({ t: 'requests', requests: this.facts(st.selfId) });
    return out;
  }
  /** One gone (answered here or elsewhere). */
  gone(id: string): P.AdapterEvent[] {
    const was = this.told.has(id) || this.raw.has(id);
    this.raw.delete(id);
    this.told.delete(id);
    return was ? [{ t: 'requestGone', nativeId: id }] : [];
  }
}

export interface RequestsResult {
  events: P.AdapterEvent[];
  /** Request conversations with something newer than what was announced: read them, quietly. */
  newer: string[];
}

/**
 * The Requests page's list: the people and conversations it names (the hub keeps a request's conversation quiet), the
 * whole list the first time, then `request` for new or changed ones and `requestGone` for the rest.
 */
export function ingestRequests(st: XState, rq: Requests, raw: RawRequests, now = Date.now()): RequestsResult {
  const events: P.AdapterEvent[] = [];
  const newer: string[] = [];
  if (raw.loading || raw.failed) return { events, newer };
  const nowIds = new Set<string>();
  for (const c of raw.requests) {
    nowIds.add(c.id);
    rq.raw.set(c.id, c);
    for (const u of c.users) {
      const f = identityFact(u, st.selfId);
      const fp = JSON.stringify(f);
      if (st.users.get(u.id) !== fp) {
        st.users.set(u.id, fp);
        events.push({ t: 'identity', identity: f });
      }
    }
    const prev = st.convs.get(c.id);
    const fact = conversationFact(c, st.selfId, prev?.participants);
    const fp = JSON.stringify(fact);
    if (prev?.fp !== fp) events.push({ t: 'conversation', conversation: fact });
    st.convs.set(c.id, { fp, raw: c, participants: prev?.participants ?? [] });
    const seen = st.seen.get(c.id);
    if (c.lastSeq && (!seen || BigInt(c.lastSeq) > BigInt(seen))) newer.push(c.id);
  }
  for (const id of [...rq.raw.keys()]) if (!nowIds.has(id)) rq.raw.delete(id);
  if (!rq.known) {
    rq.known = true;
    const facts = rq.facts(st.selfId);
    for (const f of facts) rq.told.set(f.nativeId, JSON.stringify(f));
    events.push({ t: 'requests', requests: facts });
    return { events, newer };
  }
  for (const f of rq.facts(st.selfId)) {
    const j = JSON.stringify(f);
    if (rq.told.get(f.nativeId) === j) continue;
    rq.told.set(f.nativeId, j);
    events.push({ t: 'request', request: f });
  }
  for (const id of [...rq.told.keys()]) {
    if (nowIds.has(id)) continue;
    rq.told.delete(id);
    events.push({ t: 'requestGone', nativeId: id });
  }
  void now;
  return { events, newer };
}

const PICTURE_REASON = 'Changing the group picture from here is not built yet: change it on X.';

/**
 * A conversation's About, from its inbox row: a group's name, description and picture with whether this account may
 * change them (X's admin-only group info), its members with their admins, and who may add people; a one-to-one, its
 * two people.
 */
export function aboutOf(r: RawAbout, selfId: string | null): P.About {
  const members: P.AboutMember[] = r.participants
    .filter((p) => p.current)
    .map((p) => ({ id: p.id, role: p.admin ? 'Admin' : 'Member', rank: p.admin ? 100 : 0 }));
  if (selfId && r.member !== false && !members.some((m) => m.id === selfId)) members.unshift({ id: selfId, ...(r.group ? { role: r.selfAdmin ? 'Admin' : 'Member', rank: r.selfAdmin ? 100 : 0 } : {}) });
  if (!r.group) {
    for (const u of r.users) if (!members.some((m) => m.id === u.id)) members.push({ id: u.id });
    return {
      noun: 'Chat',
      fields: {},
      members: { list: members.map(({ id }) => ({ id })), complete: true },
      facts: [{ label: 'Kind', value: r.legacy ? 'Direct message (not encrypted)' : 'XChat (encrypted)' }],
    };
  }
  const out = r.member === false ? 'You are no longer in this group.' : null;
  const legacy = r.legacy ? 'X edits only XChat groups; this is an older group DM.' : null;
  const request = r.request ? 'Accept the request first.' : null;
  const mayInfo = !out && !legacy && !request && (!r.adminOnlyEditGroupInfo || r.selfAdmin);
  const infoWhy = out ?? legacy ?? request ?? 'Only admins can edit this group’s name and description.';
  const mayAdd = !out && !request && (!r.adminOnlyAddMembers || r.selfAdmin);
  const set = <K extends P.AboutKey>(value: P.AboutValues[K] | null, canEdit: boolean, reason: string): P.AboutSetting<K> => ({ value, canEdit, ...(canEdit ? {} : { reason }) });
  const who = (adminOnly: boolean | null) => (adminOnly ? 'Only admins' : adminOnly === false ? 'Everyone' : 'Not known');
  return {
    noun: 'Group',
    fields: {
      name: set<'name'>(r.title ?? '', mayInfo, infoWhy),
      avatar: { value: r.avatarUrl, canEdit: false, reason: mayInfo ? PICTURE_REASON : infoWhy },
      topic: set<'topic'>(r.description ?? '', mayInfo, infoWhy),
    },
    members: { list: members, complete: true },
    adding: { can: mayAdd, ...(mayAdd ? {} : { reason: out ?? request ?? 'Only admins can add people to this group.' }), who: 'known', mode: 'add' },
    rules: [
      { what: 'Edit the name, description and picture', who: who(r.adminOnlyEditGroupInfo), you: mayInfo },
      { what: 'Add people', who: who(r.adminOnlyAddMembers), you: mayAdd },
      { what: 'Send messages', who: who(r.adminOnlySendMessages), you: !out && (!r.adminOnlySendMessages || r.selfAdmin) },
    ],
    you: r.member === false ? {} : { role: r.selfAdmin ? 'Admin' : 'Member', rank: r.selfAdmin ? 100 : 0 },
    ...(r.muted ? { facts: [{ label: 'Notifications', value: 'Muted on X' }] } : {}),
  };
}

/** A one-to-one opened from here (or found): its fact, for the hub to open it before anyone has written. */
export function directFact(conv: string, selfId: string | null, peer: string): P.ConversationFact {
  return { nativeId: conv, shape: selfId === peer ? 'self' : 'direct', encrypted: !/^\d+-\d+$/.test(conv), participants: selfId ? [...new Set([selfId, peer])] : [peer] };
}

/** A group made from here: its fact, with whom X put in it. */
export function groupFact(conv: string, selfId: string | null, people: string[], name?: string): P.ConversationFact {
  return { nativeId: conv, shape: 'group', ...(name ? { name } : {}), encrypted: true, participants: [...new Set([...(selfId ? [selfId] : []), ...people])] };
}
