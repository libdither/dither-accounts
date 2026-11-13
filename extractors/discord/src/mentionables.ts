/**
 * The composer's @ list (dither-chat's docs/mentions.md, the `mentionables` command) in Discord's terms: who a channel
 * can ping. The hook reads it from the client's stores, with at most one member search by name as the client's own @
 * list makes (hook.js mentionables); this ranks the people and maps them. Nothing in it is emitted: no identity, no
 * members event. It goes back to the hub as the reply only, and the hub stores none of it.
 */
import type * as P from '@dither-chat/protocol';
import type { HookCommand, RawUser } from './discord-types.ts';
import { avatarUrl, userDisplayName } from './map.ts';

/** At most this many people in an answer. */
export const MENTIONABLES_MAX = 50;

export type MentionablesCommand = Extract<P.AdapterCommand, { t: 'mentionables' }>;

/** The hook's answer: people with their nickname in the server and when they last wrote in the channel. */
export interface RawMentionables {
  people?: { user: RawUser; nick?: string | null; lastSpoke?: number | null }[];
  roles?: { id: string; name: string; color?: string | null }[];
  everyone?: boolean;
}

/** What the hook needs: the channel, its people, and in a server whom it lets in and what you may write. */
export function mentionCapabilities(found: Record<string, boolean>): P.Capability[] {
  return found.ChannelStore && found.UserStore && found.GuildMemberStore && found.PermissionStore ? ['mentionables'] : [];
}

export function mentionablesCommand(cmd: MentionablesCommand): HookCommand {
  const query = String(cmd.query ?? '')
    .replace(/^@+/, '')
    .trim()
    .slice(0, 64);
  return { kind: 'mentionables', channelId: cmd.conversation, query, limit: Math.max(1, Math.min(MENTIONABLES_MAX, Number(cmd.limit) || 20)) };
}

/** How well a name matches: 4 whole, 3 its start, 2 the start of one of its words, 1 anywhere, 0 not (as the hub's). */
function tier(names: (string | null | undefined)[], q: string): number {
  if (!q) return 1;
  let best = 0;
  for (const raw of names) {
    if (!raw) continue;
    const n = raw.toLowerCase();
    const t = n === q ? 4 : n.startsWith(q) ? 3 : n.split(/[\s._-]+/).some((w) => w.startsWith(q)) ? 2 : n.includes(q) ? 1 : 0;
    if (t > best) best = t;
  }
  return best;
}

const HEX = /^#[0-9a-f]{6}$/i;
const SNOWFLAKE = /^\d{1,20}$/;

/**
 * The hook's answer as the protocol's Mentionables: the people that match best first, then who wrote here last, at most
 * `limit`; each by their nickname in the server, else their display name. Roles keep the hook's order (highest first).
 */
export function mapMentionables(raw: RawMentionables | null | undefined, query: string, limit: number): P.Mentionables {
  const q = String(query ?? '')
    .replace(/^@+/, '')
    .trim()
    .toLowerCase();
  const seen = new Set<string>();
  const ranked: { p: P.MentionablePerson; tier: number; at: number }[] = [];
  for (const x of Array.isArray(raw?.people) ? raw.people : []) {
    const u = x?.user;
    if (!u || typeof u.id !== 'string' || !SNOWFLAKE.test(u.id) || seen.has(u.id)) continue;
    seen.add(u.id);
    const nick = typeof x.nick === 'string' && x.nick ? x.nick : null;
    const t = tier([nick, u.global_name, u.username], q);
    if (!t) continue;
    const at = typeof x.lastSpoke === 'number' && x.lastSpoke > 0 ? x.lastSpoke : 0;
    const avatar = avatarUrl(u);
    ranked.push({
      p: {
        nativeId: u.id,
        name: nick ?? userDisplayName(u),
        ...(u.username ? { handle: u.username } : {}),
        ...(avatar ? { avatar } : {}),
        ...(u.bot ? { isBot: true } : {}),
        ...(at ? { lastSpoke: at } : {}),
      },
      tier: t,
      at,
    });
  }
  ranked.sort((a, b) => b.tier - a.tier || b.at - a.at || a.p.name.localeCompare(b.p.name));
  const roles = (Array.isArray(raw?.roles) ? raw.roles : [])
    .filter((r) => r && typeof r.id === 'string' && SNOWFLAKE.test(r.id) && typeof r.name === 'string' && r.name)
    .map((r): P.MentionableRole => ({ id: r.id, name: r.name, ...(typeof r.color === 'string' && HEX.test(r.color) ? { color: r.color.toLowerCase() } : {}) }));
  return {
    people: ranked.slice(0, Math.max(1, Math.min(MENTIONABLES_MAX, limit || 20))).map((x) => x.p),
    ...(roles.length ? { roles } : {}),
    everyone: raw?.everyone === true,
  };
}
