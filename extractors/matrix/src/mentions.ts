/**
 * @ mentions on Matrix (dither-chat's docs/mentions.md).
 *
 * Who a room can ping, for the composer's @ list (the `mentionables` command): its joined members as the room state
 * holds them. Lazy loading brings the senders of recent events, so with nothing typed they are about who spoke lately.
 * For letters typed in a room whose members are not all loaded, /joined_members, kept five minutes in memory. Nothing
 * is emitted: no identity facts, no members.
 *
 * @room, both ways, as Element does it. A body that says @room outside code sets `m.mentions.room` when your power
 * level reaches the room's `notifications.room` level (50 unless the room says). One that arrives with
 * `m.mentions.room`, or (an older client, no `m.mentions`) with "@room" in its body, from a sender at that level,
 * mentions everyone, you included.
 */
import type * as P from '@dither-chat/protocol';
import type { Room } from './rooms.ts';

/** The power level @room needs when the room does not say (the spec's default). */
export const ROOM_MENTION_DEFAULT = 50;
/** How long a room's full member list is kept for the @ list. */
export const MEMBERS_KEEP = 5 * 60_000;
const MAX = 50;

/** "@room" as a word: not part of a user id like @room:server, nor of a longer name. */
const ROOM_WORD = /(^|[^\w@])@room(?![\w-]|:\w)/;

/** The power level @room needs here. */
export function roomMentionLevel(room: Room): number {
  const n = room.get('m.room.power_levels')?.content?.notifications?.room;
  const v = Number(n);
  return n === undefined || n === null || !Number.isFinite(v) ? ROOM_MENTION_DEFAULT : Math.trunc(v);
}

/** Whether this user may notify the whole room. */
export const mayMentionRoom = (room: Room, user: string) => room.powerLevel(user) >= roomMentionLevel(room);

/** A canonical body that says @room outside code. */
export function bodyMentionsRoom(md: string): boolean {
  const plain = md.replace(/```[\s\S]*?(?:```|$)/g, '').replace(/`[^`\n]*`/g, '');
  return ROOM_WORD.test(plain);
}

/** An event's content mentions the whole room: `m.mentions.room`, or, with no `m.mentions` (an older client), "@room" in its body. */
export function contentMentionsRoom(content: any): boolean {
  const m = content?.['m.mentions'];
  if (m && typeof m === 'object') return m.room === true;
  return typeof content?.body === 'string' && ROOM_WORD.test(content.body);
}

export interface MentionHost {
  selfId(): string;
  /** The joined room, or an error. */
  room(roomId: string): Room;
  /** GET /rooms/{roomId}/joined_members: `joined`. */
  joinedMembers(roomId: string): Promise<Record<string, { display_name?: string | null; avatar_url?: string | null }>>;
}

interface Member {
  name?: string;
  avatar?: string;
}

/** How well a name matches: 4 whole, 3 its start, 2 a word's start, 1 anywhere, 0 not (as the hub's). */
function tier(names: (string | undefined)[], q: string): number {
  if (!q) return 1;
  let best = 0;
  for (const raw of names) {
    if (!raw) continue;
    const n = raw.toLowerCase().replace(/^@/, '');
    const t = n === q ? 4 : n.startsWith(q) ? 3 : n.split(/[\s._:-]+/).some((w) => w.startsWith(q)) ? 2 : n.includes(q) ? 1 : 0;
    if (t > best) best = t;
  }
  return best;
}

const localpart = (user: string) => user.replace(/^@/, '').split(':')[0];

export class RoomMentions {
  private full = new Map<string, { at: number; members: Map<string, Member> }>();

  constructor(
    private host: MentionHost,
    private now: () => number = Date.now,
  ) {}

  /** The full member lists kept (the `resync` action forgets them). */
  forget() {
    this.full.clear();
  }

  private async everyone(roomId: string): Promise<Map<string, Member>> {
    const hit = this.full.get(roomId);
    if (hit && this.now() - hit.at < MEMBERS_KEEP) return hit.members;
    const joined = await this.host.joinedMembers(roomId);
    const members = new Map<string, Member>();
    for (const [user, x] of Object.entries(joined ?? {})) {
      if (!user.startsWith('@')) continue;
      members.set(user, {
        ...(typeof x?.display_name === 'string' && x.display_name.trim() ? { name: x.display_name.trim() } : {}),
        ...(typeof x?.avatar_url === 'string' && x.avatar_url.startsWith('mxc://') ? { avatar: x.avatar_url } : {}),
      });
    }
    this.full.set(roomId, { at: this.now(), members });
    if (this.full.size > 50) this.full.delete(this.full.keys().next().value!);
    return members;
  }

  /** The `mentionables` command for a room: its members whose name or id holds the letters typed, best first. */
  async answer(roomId: string, query: string, limit: number): Promise<P.Mentionables> {
    const room = this.host.room(roomId);
    const self = this.host.selfId();
    const q = String(query ?? '')
      .replace(/^@+/, '')
      .trim()
      .toLowerCase();
    const members = new Map<string, Member>();
    const loaded = room.members('join');
    for (const user of loaded) members.set(user, { name: room.memberName(user), avatar: room.memberAvatar(user) });
    // Lazy loading left members out: the whole list, once in a while, only when letters are typed.
    if (q && room.joinedCount > loaded.length) {
      const all = await this.everyone(roomId).catch(() => new Map<string, Member>());
      for (const [user, m] of all) if (!members.has(user)) members.set(user, m);
    }
    const ranked: { p: P.MentionablePerson; tier: number }[] = [];
    for (const [user, m] of members) {
      if (user === self) continue;
      const t = tier([m.name, localpart(user), user], q);
      if (!t) continue;
      ranked.push({ p: { nativeId: user, name: m.name ?? localpart(user), handle: user, ...(m.avatar ? { avatar: m.avatar } : {}) }, tier: t });
    }
    ranked.sort((a, b) => b.tier - a.tier || a.p.name.localeCompare(b.p.name));
    return { people: ranked.slice(0, Math.max(1, Math.min(MAX, limit || 20))).map((x) => x.p), everyone: mayMentionRoom(room, self) };
  }
}
