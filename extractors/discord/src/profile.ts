/**
 * The hook's raw profile (the client's own profile fetch, read back from its stores) -> a protocol PersonAbout. Pure
 * functions, tested in test/profile.test.ts.
 */

import type * as P from '@dither-chat/protocol';
import type { RawConnectedAccount, RawEmoji, RawMutualGuild, RawProfile, RawUser } from './discord-types.ts';
import { avatarUrl, isoToMs, snowflakeToMs, userDisplayName } from './map.ts';

/** RelationshipStore types. Anything else (none, implicit, a suggestion) is no standing at all. */
export const RELATIONSHIP: Record<number, P.PersonRelationship> = { 1: 'friend', 2: 'blocked', 3: 'requesting', 4: 'requested' };

type Account = Pick<RawConnectedAccount, 'id' | 'name'>;
const enc = encodeURIComponent;

/**
 * Connected-account platforms as the client's own table names and links them, for when the hook could not reach that
 * table. A platform the client links nowhere has no link here either.
 */
const PLATFORMS: Record<string, { name: string; url?: (a: Account) => string | undefined }> = {
  'amazon-music': { name: 'Amazon Music' },
  battlenet: { name: 'Battle.net' },
  bluesky: { name: 'Bluesky', url: (a) => a.id && `https://bsky.app/profile/${enc(a.id).replaceAll('%3A', ':')}` },
  bungie: { name: 'Bungie.net' },
  crunchyroll: { name: 'Crunchyroll' },
  domain: { name: 'Domain', url: (a) => a.id && `https://${a.id}/` },
  ebay: { name: 'eBay', url: (a) => `https://www.ebay.com/usr/${enc(a.name)}` },
  epicgames: { name: 'Epic Games' },
  facebook: { name: 'Facebook' },
  github: { name: 'GitHub', url: (a) => `https://github.com/${enc(a.name)}` },
  instagram: { name: 'Instagram', url: (a) => `https://www.instagram.com/${enc(a.name)}` },
  leagueoflegends: { name: 'League of Legends' },
  letterboxd: { name: 'Letterboxd', url: (a) => `https://letterboxd.com/${enc(a.name)}` },
  mastodon: { name: 'Mastodon', url: (a) => a.id },
  meta_quest_or_horizon: { name: 'Meta Quest' },
  paypal: { name: 'PayPal' },
  playstation: { name: 'PlayStation Network' },
  reddit: { name: 'Reddit', url: (a) => `https://www.reddit.com/u/${enc(a.name)}` },
  riotgames: { name: 'Riot Games' },
  roblox: { name: 'Roblox', url: (a) => a.id && `https://roblox.com/users/${enc(a.id)}/profile` },
  samsung: { name: 'Samsung Galaxy' },
  skype: { name: 'Skype' },
  spotify: { name: 'Spotify', url: (a) => a.id && `https://open.spotify.com/user/${enc(a.id)}` },
  steam: { name: 'Steam', url: (a) => a.id && `https://steamcommunity.com/profiles/${enc(a.id)}` },
  tiktok: { name: 'TikTok', url: (a) => `https://www.tiktok.com/@${enc(a.name)}` },
  twitch: { name: 'Twitch', url: (a) => `https://www.twitch.tv/${enc(a.name)}` },
  twitter: { name: 'X', url: (a) => `https://x.com/${enc(a.name)}` },
  twitter_legacy: { name: 'Twitter', url: (a) => `https://twitter.com/${enc(a.name)}` },
  xbox: { name: 'Xbox' },
  youtube: { name: 'YouTube', url: (a) => a.id && `https://www.youtube.com/channel/${enc(a.id)}` },
};

/** The most a Discord bio takes, in characters. */
export const BIO_MAX = 190;

/** A bio Discord would take, or a plain error saying why not. */
export function checkBio(bio: unknown): string {
  if (typeof bio !== 'string') throw new Error('nothing to change: only the bio can be set');
  const n = [...bio].length;
  if (n > BIO_MAX) throw new Error(`a Discord bio takes ${BIO_MAX} characters, this one has ${n}`);
  return bio;
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The banner picture on Discord's CDN, at the size the client's profile asks for. */
export function bannerUrl(userId: string, hash: string | null | undefined): string | undefined {
  if (!hash) return undefined;
  const ext = hash.startsWith('a_') ? 'gif' : 'webp';
  return `https://cdn.discordapp.com/banners/${userId}/${hash}.${ext}?size=600`;
}

/** The emoji of a custom status: a Unicode one as itself, a server's own by its name. */
export function statusEmoji(e: RawEmoji | null | undefined): string | undefined {
  if (!e?.name) return undefined;
  return e.id ? `:${e.name}:` : e.name;
}

/**
 * A connected account as a link: the client's own name and link for it, else the same from PLATFORMS. null: one the
 * client would not show (the hook leaves those out when it can ask; PLATFORMS is the client's list when it cannot).
 */
function accountLink(a: RawConnectedAccount): NonNullable<P.PersonAbout['links']>[number] | null {
  // A label means the hook asked the client's table, whose answer stands, link or none.
  const known = a.label === undefined ? PLATFORMS[a.type] : undefined;
  if (a.label === undefined && !known) return null;
  const url = a.label !== undefined ? a.url : known?.url?.(a);
  return {
    label: a.label ?? known!.name,
    value: a.name,
    ...(url?.startsWith('https://') ? { url } : {}),
    ...(a.verified ? { verified: true } : {}),
  };
}

function mutualSpace(g: RawMutualGuild): NonNullable<P.PersonAbout['mutualSpaces']>[number] {
  // @everyone has the server's id, and is not a role anyone is shown with.
  const roles = g.roles
    ?.filter((r) => r.id !== g.id)
    .sort((a, b) => b.position - a.position)
    .map((r) => ({ name: r.name, ...(r.color ? { color: r.color } : {}) }));
  const joinedAt = isoToMs(g.joined_at);
  return { id: g.id, ...(g.nick ? { nick: g.nick } : {}), ...(roles ? { roles } : {}), ...(joinedAt ? { joinedAt } : {}) };
}

/** The users a raw profile names, for identity facts ahead of the answer. */
export function profileUsers(raw: RawProfile): RawUser[] {
  return [...(raw.user ? [raw.user] : []), ...(raw.mutual_friends ?? []), ...(raw.friends ?? [])];
}

export function mapProfile(raw: RawProfile, who: string): P.PersonAbout {
  const out: P.PersonAbout = {};
  const u = raw.user;
  const self = !!raw.selfId && raw.selfId === who;

  if (u?.username || u?.global_name) out.displayName = userDisplayName(u);
  if (u?.username) out.handle = u.username;
  const avatar = u ? avatarUrl(u) : undefined;
  if (avatar) out.avatar = avatar;
  const banner = bannerUrl(who, raw.banner);
  if (banner) out.banner = banner;
  else if (typeof raw.accent_color === 'number') out.accent = `#${raw.accent_color.toString(16).padStart(6, '0')}`;
  if (raw.bio?.trim()) out.bio = raw.bio;
  if (raw.pronouns?.trim()) out.pronouns = raw.pronouns.trim();
  const text = raw.custom_status?.text?.trim();
  const emoji = statusEmoji(raw.custom_status?.emoji);
  if (text || emoji) out.status = { ...(text ? { text } : {}), ...(emoji ? { emoji } : {}) };
  const created = snowflakeToMs(who);
  if (created) out.createdAt = created;

  if (!self && raw.relationship != null) out.relationship = RELATIONSHIP[raw.relationship] ?? 'stranger';
  if (raw.mutual_guilds) out.mutualSpaces = raw.mutual_guilds.map(mutualSpace);
  if (raw.mutual_friends) out.mutualFriends = raw.mutual_friends.map((f) => f.id);
  if (self && raw.friends) out.friends = raw.friends.map((f) => f.id);
  const links = (raw.connected_accounts ?? []).map(accountLink).filter((l) => !!l);
  if (links.length) out.links = links;

  const facts: { label: string; value: string }[] = [];
  const since = isoToMs(raw.friend_since);
  if (out.relationship === 'friend' && since) facts.push({ label: 'Friends since', value: day(since) });
  if (!raw.mutual_friends && raw.mutual_friends_count) facts.push({ label: 'Mutual friends', value: String(raw.mutual_friends_count) });
  if (raw.legacy_username) facts.push({ label: 'Originally known as', value: raw.legacy_username });
  if (facts.length) out.facts = facts;
  return out;
}
