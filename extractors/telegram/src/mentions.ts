/**
 * @ mentions on Telegram (dither-chat's docs/mentions.md): the people of a chat as the `mentionables` command answers
 * them, best match first. Where they come from is the adapter's (adapter.ts mentionables): a DM's other person, a basic
 * group's members, a supergroup's from Telegram's own member search. Telegram has no @all, so `everyone` is never set.
 */
import type * as P from '@dither-chat/protocol';
import type { tl } from './backend.ts';
import { identityOfUser, usernameOf } from './mapping.ts';

const MAX = 50;

/** What was typed, as Telegram's member search takes it: no leading @, at most 64 characters. */
export const mentionQuery = (q: string | null | undefined) =>
  String(q ?? '')
    .replace(/^@+/, '')
    .trim()
    .slice(0, 64);

/** How well a name matches: 4 whole, 3 its start, 2 a word's start, 1 anywhere, 0 not (as the hub's). */
function tier(names: (string | undefined)[], q: string): number {
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

/** These users as the answer: never you, nor a deleted account; the best match first, at most `limit`. */
export function mentionablesOf(users: readonly tl.TypeUser[], self: number, query: string, limit: number): P.Mentionables {
  const q = mentionQuery(query).toLowerCase();
  const seen = new Set<number>();
  const ranked: { p: P.MentionablePerson; tier: number }[] = [];
  for (const u of users) {
    if (u._ !== 'user' || u.deleted) continue;
    const id = Number(u.id);
    if (id === self || seen.has(id)) continue;
    seen.add(id);
    const f = identityOfUser(u, self);
    if (!f) continue;
    const name = f.displayName ?? f.handle ?? f.nativeId;
    const t = tier([name, usernameOf(u)], q);
    if (!t) continue;
    const uname = usernameOf(u);
    // The @username only: a phone number is not shown here.
    ranked.push({ p: { nativeId: f.nativeId, name, ...(uname ? { handle: `@${uname}` } : {}), ...(f.avatarUrl ? { avatar: f.avatarUrl } : {}), ...(f.isBot ? { isBot: true } : {}) }, tier: t });
  }
  ranked.sort((a, b) => b.tier - a.tier || a.p.name.localeCompare(b.p.name));
  return { people: ranked.slice(0, Math.max(1, Math.min(MAX, limit || 20))).map((x) => x.p), everyone: false };
}
