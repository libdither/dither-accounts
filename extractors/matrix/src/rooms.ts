/**
 * Joined-room state and the mapping from Matrix rooms to dither-chat places.
 *
 *   m.room.create type m.space          -> SpaceFact kind 'community'
 *   in m.direct account data            -> shape 'direct' (you + the peer)
 *   only you in the room                -> shape 'self'
 *   child of a joined space             -> shape 'channel' with spaces (several parents allowed)
 *   public join rule or > 20 members    -> shape 'channel' without spaces
 *   anything else                       -> shape 'group'
 *
 * Space containment comes from m.space.child in the parent (valid only with a
 * non-empty `via`) and m.space.parent in the child (accepted when the parent
 * is joined and the sender may send m.space.child there).
 */

import type { ConversationFact, IdentityFact, NativeMute, Shape, SpaceFact, SpaceRef, Variant } from '@dither-chat/protocol';

export interface MxEvent {
  type: string;
  event_id: string;
  sender: string;
  origin_server_ts: number;
  content: Record<string, any>;
  state_key?: string;
  unsigned?: Record<string, any>;
  redacts?: string;
  room_id?: string;
  /** Ours, not the wire's: this content was decrypted. */
  e2ee?: boolean;
}

export interface Summary {
  heroes?: string[];
  joined?: number;
  invited?: number;
}

/** State event types that change how a room is presented. */
export const STRUCTURAL = new Set([
  'm.room.create',
  'm.room.name',
  'm.room.topic',
  'm.room.avatar',
  'm.room.canonical_alias',
  'm.room.encryption',
  'm.room.join_rules',
  'm.room.power_levels',
  'm.room.tombstone',
  'm.space.child',
  'm.space.parent',
  'm.room.member',
]);

const BIG_ROOM = 20;

/** A room version as a number to compare: "11" is 11, the v12 prototype "org.matrix.hydra.11" is 12, anything else NaN. */
export function roomVersionNumber(v: string): number {
  if (/^\d+$/.test(v)) return Number(v);
  return v === 'org.matrix.hydra.11' ? 12 : NaN;
}

const key = (type: string, stateKey: string) => `${type}\u0000${stateKey}`;

export class Room {
  readonly state = new Map<string, MxEvent>();
  summary: Summary = {};
  membership: 'join' | 'leave' = 'join';
  /** /messages token for going further back; null = unknown, '' = start of the room reached. */
  backToken: string | null = null;
  /** Newest timeline event processed (to close gaps after a limited sync). */
  latestEvent: string | null = null;
  /** Full member list fetched once (lazy loading only gives timeline senders). */
  membersLoaded = false;
  /** Last native mute emitted, so an unmute can be sent as level 'all'. */
  lastMute: string | null = null;

  constructor(readonly id: string) {}

  get(type: string, stateKey = ''): MxEvent | undefined {
    return this.state.get(key(type, stateKey));
  }

  ofType(type: string): MxEvent[] {
    const out: MxEvent[] = [];
    for (const ev of this.state.values()) if (ev.type === type) out.push(ev);
    return out;
  }

  /**
   * Returns true if the stored state changed. Synthetic member events (event
   * ids starting with "~", built from /joined_members) never replace real ones.
   */
  setState(ev: MxEvent): boolean {
    if (ev.state_key === undefined) return false;
    const k = key(ev.type, ev.state_key);
    const prev = this.state.get(k);
    if (prev && ev.event_id.startsWith('~') && !prev.event_id.startsWith('~')) return false;
    if (prev && prev.event_id === ev.event_id && JSON.stringify(prev.content) === JSON.stringify(ev.content)) return false;
    // Encryption cannot be turned off. An event that seems to (a redaction, a new state event) must not make us write in plaintext.
    if (ev.type === 'm.room.encryption' && prev?.content?.algorithm && !ev.content?.algorithm) return false;
    this.state.set(k, ev);
    return true;
  }

  get isSpace(): boolean {
    return this.get('m.room.create')?.content?.type === 'm.space';
  }
  get roomType(): string | undefined {
    return this.get('m.room.create')?.content?.type;
  }
  get name(): string | undefined {
    const n = this.get('m.room.name')?.content?.name;
    return typeof n === 'string' && n.trim() ? n.trim() : undefined;
  }
  get alias(): string | undefined {
    const a = this.get('m.room.canonical_alias')?.content?.alias;
    return typeof a === 'string' && a ? a : undefined;
  }
  get topic(): string | undefined {
    const c = this.get('m.room.topic')?.content;
    if (!c) return undefined;
    if (typeof c.topic === 'string' && c.topic.trim()) return c.topic.trim();
    const t = c['m.topic']?.['m.text']?.find?.((x: any) => !x.mimetype || x.mimetype === 'text/plain')?.body;
    return typeof t === 'string' && t.trim() ? t.trim() : undefined;
  }
  get avatar(): string | undefined {
    const u = this.get('m.room.avatar')?.content?.url;
    return typeof u === 'string' && u.startsWith('mxc://') ? u : undefined;
  }
  get encrypted(): boolean {
    return !!this.get('m.room.encryption')?.content?.algorithm;
  }
  get joinRule(): string | undefined {
    return this.get('m.room.join_rules')?.content?.join_rule;
  }
  get archived(): boolean {
    return !!this.get('m.room.tombstone')?.content?.replacement_room;
  }

  membershipOf(user: string): string | undefined {
    return this.get('m.room.member', user)?.content?.membership;
  }
  memberName(user: string): string | undefined {
    const n = this.get('m.room.member', user)?.content?.displayname;
    return typeof n === 'string' && n.trim() ? n.trim() : undefined;
  }
  memberAvatar(user: string): string | undefined {
    const u = this.get('m.room.member', user)?.content?.avatar_url;
    return typeof u === 'string' && u.startsWith('mxc://') ? u : undefined;
  }
  members(...memberships: string[]): string[] {
    const want = new Set(memberships.length ? memberships : ['join', 'invite']);
    return this.ofType('m.room.member')
      .filter((e) => want.has(e.content?.membership))
      .map((e) => e.state_key!)
      .sort();
  }
  // Sync's summary counts everyone, where lazy loading leaves members out of the state here; but it comes only when it
  // changes, so state newer than it (an invite this account just sent) can count more. Neither can be too high.
  get joinedCount(): number {
    return Math.max(this.summary.joined ?? 0, this.members('join').length);
  }
  get invitedCount(): number {
    return Math.max(this.summary.invited ?? 0, this.members('invite').length);
  }

  // ---------------------------------------------------------------- power levels

  get roomVersion(): string {
    return String(this.get('m.room.create')?.content?.room_version ?? '1');
  }

  /** Room v12 creators have unlimited power. */
  isPrivilegedCreator(user: string): boolean {
    if (!(roomVersionNumber(this.roomVersion) >= 12)) return false;
    const create = this.get('m.room.create');
    if (!create) return false;
    const extra = Array.isArray(create.content?.additional_creators) ? create.content.additional_creators : [];
    return create.sender === user || extra.includes(user);
  }

  powerLevel(user: string): number {
    if (this.isPrivilegedCreator(user)) return Infinity;
    const pl = this.get('m.room.power_levels')?.content;
    if (!pl) return this.get('m.room.create')?.sender === user ? 100 : 0;
    const n = pl.users?.[user] ?? pl.users_default ?? 0;
    return Number(n) || 0;
  }

  /** Power needed to send an event of this type. */
  requiredLevel(type: string, isState: boolean): number {
    const pl = this.get('m.room.power_levels')?.content;
    if (!pl) return 0;
    const ev = pl.events?.[type];
    if (ev !== undefined) return Number(ev) || 0;
    return Number(isState ? (pl.state_default ?? 50) : (pl.events_default ?? 0)) || 0;
  }

  /** Regular members cannot post: an announcement room. */
  get readOnlyForMembers(): boolean {
    const pl = this.get('m.room.power_levels')?.content;
    if (!pl) return false;
    return (Number(pl.users_default ?? 0) || 0) < this.requiredLevel('m.room.message', false);
  }
}

// ------------------------------------------------------------------ the directory of joined rooms

const validOrder = (o: unknown): o is string => typeof o === 'string' && o.length > 0 && o.length <= 50 && /^[\x20-\x7e]+$/.test(o);
const hasVia = (c: any) => Array.isArray(c?.via) && c.via.length > 0;

export type Place = { kind: 'space' } | { kind: 'conversation'; shape: Shape };

export class Directory {
  readonly rooms = new Map<string, Room>();
  /** m.direct inverted: room id -> peers. */
  private direct = new Map<string, string[]>();
  private directPeers = new Set<string>();
  pushRules: any = null;

  constructor(public selfId: string) {}

  room(id: string): Room {
    let r = this.rooms.get(id);
    if (!r) this.rooms.set(id, (r = new Room(id)));
    return r;
  }

  joined(): Room[] {
    return [...this.rooms.values()].filter((r) => r.membership === 'join');
  }

  setDirect(content: Record<string, unknown>) {
    this.direct.clear();
    this.directPeers.clear();
    for (const [peer, rooms] of Object.entries(content ?? {})) {
      if (!Array.isArray(rooms) || peer === this.selfId) continue;
      for (const r of rooms) {
        if (typeof r !== 'string') continue;
        const list = this.direct.get(r) ?? [];
        if (!list.includes(peer)) list.push(peer);
        this.direct.set(r, list);
        this.directPeers.add(peer);
      }
    }
  }

  isContact(user: string): boolean {
    return this.directPeers.has(user);
  }

  /** Everyone m.direct names, sorted. */
  contacts(): string[] {
    return [...this.directPeers].sort();
  }

  /** The DM peer, if m.direct names exactly one for this room. */
  peerOf(room: Room): string | undefined {
    const peers = this.direct.get(room.id);
    return peers && peers.length === 1 ? peers[0] : undefined;
  }

  /** Add a room to the inverted m.direct at once, before the server echoes the account data. */
  addDirect(peer: string, roomId: string) {
    this.direct.set(roomId, [peer]);
    this.directPeers.add(peer);
  }

  /** The DM to reuse with this person: one you are in and they have not left, one they joined first. */
  directRoomWith(peer: string): Room | undefined {
    const rooms = this.joined().filter((r) => this.peerOf(r) === peer && !['leave', 'ban'].includes(r.membershipOf(peer) ?? ''));
    return rooms.find((r) => r.membershipOf(peer) === 'join') ?? rooms[0];
  }

  // ---------------------------------------------------------------- containment

  parentsOf(room: Room): SpaceRef[] {
    const refs = new Map<string, string | undefined>();
    for (const space of this.joined()) {
      if (!space.isSpace || space.id === room.id) continue;
      const ev = space.get('m.space.child', room.id);
      if (ev && hasVia(ev.content)) refs.set(space.id, validOrder(ev.content.order) ? ev.content.order : undefined);
    }
    for (const ev of room.ofType('m.space.parent')) {
      const parentId = ev.state_key!;
      if (refs.has(parentId) || parentId === room.id || !hasVia(ev.content)) continue;
      const parent = this.rooms.get(parentId);
      if (!parent || parent.membership !== 'join' || !parent.isSpace) continue;
      if (parent.powerLevel(ev.sender) >= parent.requiredLevel('m.space.child', true)) refs.set(parentId, undefined);
    }
    return [...refs].map(([nativeId, position]) => (position !== undefined ? { nativeId, position } : { nativeId }));
  }

  place(room: Room): Place {
    if (room.isSpace) return { kind: 'space' };
    if (this.peerOf(room)) return { kind: 'conversation', shape: 'direct' };
    const joined = room.joinedCount;
    if (joined <= 1 && room.invitedCount === 0 && (room.membershipOf(this.selfId) ?? 'join') === 'join') return { kind: 'conversation', shape: 'self' };
    if (this.parentsOf(room).length) return { kind: 'conversation', shape: 'channel' };
    if (room.joinRule === 'public' || joined > BIG_ROOM) return { kind: 'conversation', shape: 'channel' };
    return { kind: 'conversation', shape: 'group' };
  }

  // ---------------------------------------------------------------- names

  /** The spec's room display name algorithm (name, alias, heroes). */
  displayName(room: Room): string | undefined {
    if (room.name) return room.name;
    if (room.alias) return room.alias;
    const heroes = (room.summary.heroes?.length ? room.summary.heroes : room.members('join', 'invite'))
      .filter((u) => u !== this.selfId)
      .slice(0, 5);
    if (!heroes.length) return undefined;
    const names = heroes.map((u) => room.memberName(u) ?? u);
    const others = room.joinedCount + room.invitedCount - 1;
    if (others > names.length) return `${names.join(', ')} and ${others - names.length} other${others - names.length === 1 ? '' : 's'}`;
    return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }

  // ---------------------------------------------------------------- push rules -> native mute

  /**
   * Element semantics: an override rule for the room with no notify action is
   * "mute" (level none); a room rule with no notify action is "mentions and
   * keywords" (level mentions); a room rule that notifies is "all messages".
   */
  muteOf(room: Room): NativeMute | undefined {
    const g = this.pushRules?.global;
    if (!g) return undefined;
    const silent = (actions: unknown) => Array.isArray(actions) && !actions.some((a) => a === 'notify' || (typeof a === 'object' && a?.set_tweak === 'sound'));
    const override = (g.override ?? []).find(
      (r: any) =>
        r?.enabled !== false &&
        (r.rule_id === room.id ||
          (Array.isArray(r.conditions) &&
            r.conditions.length === 1 &&
            r.conditions[0]?.kind === 'event_match' &&
            r.conditions[0]?.key === 'room_id' &&
            r.conditions[0]?.pattern === room.id)),
    );
    if (override && silent(override.actions)) return { level: 'none' };
    const roomRule = (g.room ?? []).find((r: any) => r?.enabled !== false && r.rule_id === room.id);
    if (roomRule) return silent(roomRule.actions) ? { level: 'mentions' } : { level: 'all' };
    return undefined;
  }

  // ---------------------------------------------------------------- facts

  identity(room: Room | null, user: string): IdentityFact {
    const f: IdentityFact = { nativeId: user, handle: user };
    const name = room?.memberName(user);
    const avatar = room?.memberAvatar(user);
    if (name) f.displayName = name;
    if (avatar) f.avatarUrl = avatar;
    if (this.isContact(user)) f.contact = true;
    return f;
  }

  spaceFact(room: Room): SpaceFact {
    const f: SpaceFact = {
      nativeId: room.id,
      kind: 'community',
      name: this.displayName(room) ?? 'Unnamed space',
      parents: this.parentsOf(room),
    };
    if (room.topic) f.topic = room.topic;
    if (room.avatar) f.iconUrl = room.avatar;
    return f;
  }

  variantOf(room: Room, shape: Shape): Variant {
    const t = room.roomType ?? '';
    if (/call|voice/i.test(t)) return 'voice';
    if (shape === 'channel' && room.readOnlyForMembers) return 'announcement';
    return 'text';
  }

  conversationFact(room: Room, shape: Shape): ConversationFact {
    const f: ConversationFact = { nativeId: room.id, shape, variant: this.variantOf(room, shape), spaces: this.parentsOf(room) };
    if (shape !== 'direct') {
      const name = this.displayName(room);
      if (name) f.name = name;
    }
    if (room.topic) f.topic = room.topic;
    if (room.avatar) f.avatarUrl = room.avatar;
    if (room.encrypted) f.encrypted = true;
    if (room.archived) f.archived = true;
    if (shape === 'direct') f.participants = [this.selfId, this.peerOf(room)!];
    else if (shape === 'self') f.participants = [this.selfId];
    else if (shape === 'group') f.participants = [...new Set([this.selfId, ...room.members('join', 'invite')])];
    // The hub keeps the last mute it was told about, so an unmute is sent as level 'all'.
    const mute = this.muteOf(room);
    if (mute) f.mute = mute;
    else if (room.lastMute && JSON.parse(room.lastMute)?.level !== 'all') f.mute = { level: 'all' };
    return f;
  }
}
