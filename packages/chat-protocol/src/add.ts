/**
 * Adding: joining servers and groups, adding people, and requests waiting on you (docs/add.md).
 *
 * The page reads what was pasted or typed with parseAdd, the owner picks a reading, and the hub asks one of their
 * accounts on that network to resolve it (`resolve`), then to act on it (`add`). Nothing here talks to a network.
 */
import type { PersonRelationship } from './about.ts';
import { NETWORK_META, NETWORKS, type Network } from './ontology.ts';

/** What a pasted or typed thing could be. parseAdd gives every reading; the hub asks a fitting account to resolve one. */
export type AddRef =
  /** A link that joins something. code: Discord invite code, WhatsApp group invite code, Telegram invite hash,
   *  Signal: the whole signal.group URL (signal-cli takes the URI). url: the link as given, normalised. */
  | { kind: 'invite'; network: Network; code: string; url: string }
  /** A place by address: Matrix #alias:server or !id:server (via: servers from a matrix.to link). */
  | { kind: 'place'; network: Network; address: string; via?: string[] }
  /** A public name that may be a person or a place; resolve says which (Telegram @name, t.me/name). */
  | { kind: 'name'; network: Network; name: string }
  /** A person: Discord username or user id, Matrix @user:server, +phone, Signal username (name.12) or signal.me link,
   *  X / Instagram handle, Messenger profile name. */
  | { kind: 'person'; network: Network; handle: string };

export type AddAction = 'join' | 'ask' | 'friend' | 'follow' | 'contact' | 'message';

/** The network wants a check only the owner can do, in the account's live view. rules: Discord's membership screening. */
export type AddCheck = 'captcha' | 'verify' | 'phone' | 'rules';

export type RequestAnswer = 'accept' | 'decline' | 'block';

/** What the network says a reading is, without joining, following or telling anyone. */
export interface AddPreview {
  what: 'space' | 'group' | 'channel' | 'room' | 'person';
  name: string;
  /**
   * The network will not say more without acting (signal-cli has no group-link preview; Discord has no username lookup
   * that does not send the request). `name` is then the pasted text, `actions` are still listed, and a note says why.
   * A missing nativeId or members count is not "not found": not found and expired come back as a command error.
   */
  partial?: true;
  /** Native id of the space, conversation or identity, when the network says. */
  nativeId?: string;
  avatar?: string; // a MediaUrl as other facts carry it
  description?: string;
  members?: number;
  online?: number;
  /** Already in it: native ids. */
  joined?: { space?: string; conversation?: string };
  relationship?: PersonRelationship;
  /** What this account can do with it now, best first. 'ask' = a join request the admins approve. */
  actions: AddAction[];
  /** ms epoch the invite runs out. */
  expires?: number;
  /** Native identity id of who made the invite (identity fact first). */
  inviter?: string;
  /** Plain notes: "Joining asks the admins first", "This server wants a verified phone". */
  notes?: string[];
}

export interface AddResult {
  /** What now exists on this account (native ids): open it. Space/conversation facts arrive before the reply. */
  space?: string;
  conversation?: string;
  identity?: string;
  relationship?: PersonRelationship;
  /** Asked; waiting on the other side (join request, friend request, follow request). */
  pending?: boolean;
  /** The network wants a check only the owner can do, in the account's live view. Nothing was done. */
  check?: AddCheck;
  /** Plain notes, shown after the action: "Joined; the admins must approve before you can post". */
  notes?: string[];
  /**
   * The network wants the owner to confirm first (Discord: "You must confirm the friend request to add this user."):
   * its words. Nothing was done. The page shows them with "Accept anyway" or "Add anyway", which sends the same
   * command again with `confirm: true`. An adapter confirms only when the command carries it, never on its own.
   */
  confirm?: string;
}

/** A request waiting on the owner. */
export interface RequestFact {
  nativeId: string;
  /** friend: wants to be friends. follow: wants to follow you (private account). invite: you were invited to a
   *  group, space or room. message: a DM from someone not in your contacts waits for you to accept (Signal,
   *  Instagram, Messenger, X). join: someone asks to join a group you admin. */
  kind: 'friend' | 'follow' | 'invite' | 'message' | 'join';
  /** Native identity id (identity fact first). */
  from?: string;
  target?: { kind: 'space' | 'conversation'; nativeId: string; name?: string; members?: number };
  ts: number;
  answers: RequestAnswer[];
  /**
   * The network's own words when it flagged the request, plain text for the card: "Discord filed this request as
   * possible spam", "Discord says you share no server or friend with them".
   */
  warning?: string;
}

/** How you stand with someone that an account's list holds (capability 'relationships'). Incoming requests are RequestFacts. */
export type LinkRelationship = Exclude<PersonRelationship, 'requesting' | 'stranger'>;

/** One entry of an account's list: a friend, a request you sent, someone blocked, a contact, someone you follow. */
export interface RelationshipFact {
  /** Native identity id (identity fact first). */
  identity: string;
  /** 'stranger': gone from the list. */
  relationship: LinkRelationship | 'stranger';
  /** ms epoch, when the network says. */
  since?: number;
}

export const LINK_RELATIONSHIPS: readonly LinkRelationship[] = ['friend', 'requested', 'blocked', 'contact', 'following'];

/** The button that ends each (the `remove` command): unfriend, cancel the request you sent, unblock, delete the contact, unfollow. */
export const REMOVE_LABEL: Record<LinkRelationship, string> = {
  friend: 'Remove friend',
  requested: 'Cancel request',
  blocked: 'Unblock',
  contact: 'Remove contact',
  following: 'Unfollow',
};

export const ADD_ACTIONS: readonly AddAction[] = ['join', 'ask', 'friend', 'follow', 'contact', 'message'];
export const REQUEST_ANSWERS: readonly RequestAnswer[] = ['accept', 'decline', 'block'];

/** The capability an account needs for an action: join covers join and ask, connect covers friend, follow, contact. */
export function addCapability(action: AddAction): 'openDirect' | 'join' | 'connect' {
  return action === 'message' ? 'openDirect' : action === 'join' || action === 'ask' ? 'join' : 'connect';
}

// ------------------------------------------------------------------ parseAdd

const MXID = /^@[^\s:/]+:[^\s:/]+(:\d+)?$/;
const MX_ALIAS = /^#[^\s:/]+:[^\s:/]+(:\d+)?$/;
const MX_ROOM = /^![^\s:/]+:[^\s:/]+(:\d+)?$/;
const PHONE = /^\+[1-9]\d{6,14}$/;
const SNOWFLAKE = /^\d{15,22}$/;
/** Discord usernames: 2 to 32 lowercase letters, digits, _ and ., never two periods in a row. */
const DISCORD_USER = /^(?!.*\.\.)[a-z0-9_.]{2,32}$/;
const DISCORD_CODE = /^[A-Za-z0-9-]{2,32}$/;
const WA_CODE = /^[A-Za-z0-9]{10,40}$/;
/** A Telegram username: 5 to 32 letters, digits and underscores, starting with a letter. */
const TG_NAME = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
const TG_HASH = /^[A-Za-z0-9_-]{8,64}$/;
/** A Signal username with its number: name.12 */
const SIGNAL_USER = /^[A-Za-z_][A-Za-z0-9_]{2,31}\.\d{2,9}$/;
const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const IG_HANDLE = /^(?!.*\.\.)(?!\.)[A-Za-z0-9._]{1,30}(?<!\.)$/;
const FB_NAME = /^[A-Za-z0-9.]{5,50}$/;
const HOST = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+(:\d+)?$/;

/** First path segments that are pages of the site, not someone's name. */
const X_PAGES = new Set(['home', 'i', 'search', 'explore', 'settings', 'messages', 'notifications', 'intent', 'share', 'hashtag', 'login', 'signup', 'tos', 'privacy']);
const IG_PAGES = new Set(['p', 'reel', 'reels', 'explore', 'stories', 'accounts', 'direct', 'tv', 'about', 'legal']);
const FB_PAGES = new Set(['groups', 'pages', 'events', 'watch', 'marketplace', 'gaming', 'login', 'help', 'messages', 'settings', 'share', 'sharer', 'photo', 'photos', 'story.php', 'permalink.php']);

const phoneOf = (s: string) => s.replace(/[\s().-]/g, '');
const person = (network: Network, handle: string): AddRef => ({ kind: 'person', network, handle });
const phonePeople = (p: string): AddRef[] => (['signal', 'whatsapp', 'telegram', 'gmessages'] as const).map((n) => person(n, p));

/** "@name" or "name" by the rules of the networks that take a bare handle, Telegram first (it may be a place too). */
function atName(name: string): AddRef[] {
  const out: AddRef[] = [];
  if (TG_NAME.test(name)) out.push({ kind: 'name', network: 'telegram', name });
  if (X_HANDLE.test(name)) out.push(person('x', name));
  if (IG_HANDLE.test(name)) out.push(person('instagram', name));
  return out;
}

/** A Matrix address: a room alias or id is a place (via: servers to join it through), a user id a person. */
function matrixAddress(a: string, via?: string[]): AddRef[] {
  if (MXID.test(a)) return [person('matrix', a)];
  if (MX_ALIAS.test(a) || MX_ROOM.test(a)) return [{ kind: 'place', network: 'matrix', address: a, ...(via?.length ? { via } : {}) }];
  return [];
}

function fromUrl(u: URL): AddRef[] {
  const proto = u.protocol;
  if (proto === 'tg:') {
    const q = u.searchParams;
    const host = u.hostname.toLowerCase();
    if (host === 'join') {
      const code = q.get('invite') ?? '';
      return TG_HASH.test(code) ? [{ kind: 'invite', network: 'telegram', code, url: `https://t.me/+${code}` }] : [];
    }
    if (host === 'resolve') {
      const name = q.get('domain') ?? '';
      if (TG_NAME.test(name)) return [{ kind: 'name', network: 'telegram', name }];
      const p = phoneOf(`+${q.get('phone') ?? ''}`);
      return PHONE.test(p) ? [person('telegram', p)] : [];
    }
    return [];
  }
  if (proto !== 'https:' && proto !== 'http:') return [];
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const seg = u.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  const [a = '', b = ''] = seg;
  switch (host) {
    case 'discord.gg':
      return DISCORD_CODE.test(a) && seg.length === 1 ? [{ kind: 'invite', network: 'discord', code: a, url: `https://discord.gg/${a}` }] : [];
    case 'discord.com':
    case 'discordapp.com':
    case 'ptb.discord.com':
    case 'canary.discord.com':
      if (a === 'invite' && DISCORD_CODE.test(b) && seg.length === 2) return [{ kind: 'invite', network: 'discord', code: b, url: `https://discord.gg/${b}` }];
      if (a === 'users' && SNOWFLAKE.test(b)) return [person('discord', b)];
      return [];
    case 'chat.whatsapp.com':
      return WA_CODE.test(a) && seg.length === 1 ? [{ kind: 'invite', network: 'whatsapp', code: a, url: `https://chat.whatsapp.com/${a}` }] : [];
    case 'wa.me': {
      const p = phoneOf(`+${a}`);
      return /^\d+$/.test(a) && PHONE.test(p) ? [person('whatsapp', p)] : [];
    }
    case 't.me':
    case 'telegram.me':
    case 'telegram.dog': {
      // t.me/+15551234567 is a phone number; t.me/+AbCd... an invite.
      if (a.startsWith('+')) {
        if (PHONE.test(a)) return [person('telegram', a)];
        const code = a.slice(1);
        return TG_HASH.test(code) ? [{ kind: 'invite', network: 'telegram', code, url: `https://t.me/+${code}` }] : [];
      }
      if (a === 'joinchat') return TG_HASH.test(b) ? [{ kind: 'invite', network: 'telegram', code: b, url: `https://t.me/+${b}` }] : [];
      const name = a === 's' ? b : a;
      return TG_NAME.test(name) ? [{ kind: 'name', network: 'telegram', name }] : [];
    }
    case 'signal.group':
      return u.hash.length > 2 ? [{ kind: 'invite', network: 'signal', code: `https://signal.group/${u.hash}`, url: `https://signal.group/${u.hash}` }] : [];
    case 'signal.me': {
      const h = u.hash;
      if (h.startsWith('#p/')) {
        const p = phoneOf(decodeURIComponent(h.slice(3)));
        return PHONE.test(p) ? [person('signal', p)] : [];
      }
      return /^#eu\/[A-Za-z0-9_-]{8,}$/.test(h) ? [person('signal', `https://signal.me/${h}`)] : [];
    }
    case 'matrix.to': {
      if (!u.hash.startsWith('#/')) return [];
      const rest = u.hash.slice(2);
      const q = rest.indexOf('?');
      const id = decodeURIComponent((q < 0 ? rest : rest.slice(0, q)).split('/')[0]);
      const via = new URLSearchParams(q < 0 ? '' : rest.slice(q + 1)).getAll('via').filter((v) => HOST.test(v)).slice(0, 10);
      return matrixAddress(id, via);
    }
    case 'x.com':
    case 'twitter.com':
    case 'mobile.twitter.com':
    case 'mobile.x.com':
      return X_HANDLE.test(a) && !X_PAGES.has(a.toLowerCase()) ? [person('x', a)] : [];
    case 'instagram.com':
      return IG_HANDLE.test(a) && !IG_PAGES.has(a.toLowerCase()) ? [person('instagram', a)] : [];
    case 'facebook.com':
    case 'm.facebook.com':
    case 'fb.com':
      if (a === 'profile.php') {
        const id = u.searchParams.get('id') ?? '';
        return /^\d{5,20}$/.test(id) ? [person('messenger', id)] : [];
      }
      return FB_NAME.test(a) && !FB_PAGES.has(a.toLowerCase()) ? [person('messenger', a)] : [];
    case 'm.me':
      return FB_NAME.test(a) && seg.length === 1 ? [person('messenger', a)] : [];
  }
  return [];
}

/** Every reading of the input, most specific first. Links give one; "@name" or a bare word give several. */
export function parseAdd(input: string): AddRef[] {
  const s = input.trim();
  if (!s || s.length > 2048 || /\s/.test(s.replace(/^\+[\d\s().-]+$/, ''))) return [];
  if (s.startsWith('@')) return MXID.test(s) ? [person('matrix', s)] : atName(s.slice(1));
  if (s.startsWith('#') || s.startsWith('!')) return matrixAddress(s);
  if (s.startsWith('+')) {
    const p = phoneOf(s);
    return PHONE.test(p) ? phonePeople(p) : [];
  }
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(s);
  let url: URL | null = null;
  try {
    if (scheme) url = new URL(s);
    // A link typed without its https://: a host, then a path.
    else if (/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+\//.test(s)) url = new URL(`https://${s}`);
  } catch {
    return [];
  }
  if (scheme || url) return url ? fromUrl(url) : [];
  const out: AddRef[] = [];
  if (SIGNAL_USER.test(s)) out.push(person('signal', s));
  if (DISCORD_USER.test(s)) out.push(person('discord', s));
  return out;
}

/** The text parseAdd reads this reading from: how the hub checks a reading the page sent. */
function sourceOf(r: AddRef): string {
  switch (r.kind) {
    case 'invite':
      return r.url;
    case 'place':
      return r.address;
    case 'name':
      return `@${r.name}`;
    case 'person':
      if (r.network === 'x' || r.network === 'instagram') return `@${r.handle}`;
      if (r.network === 'messenger') return `https://m.me/${r.handle}`;
      return r.handle;
  }
}

const str = (x: unknown, max = 2048): x is string => typeof x === 'string' && x.length > 0 && x.length <= max;

/** Two readings name the same thing (Matrix via servers aside). */
export function sameAddRef(a: AddRef, b: AddRef): boolean {
  if (a.kind !== b.kind || a.network !== b.network) return false;
  switch (a.kind) {
    case 'invite':
      return a.code === (b as typeof a).code && a.url === (b as typeof a).url;
    case 'place':
      return a.address === (b as typeof a).address;
    case 'name':
      return a.name === (b as typeof a).name;
    case 'person':
      return a.handle === (b as typeof a).handle;
  }
}

/** One key per thing a reading names (Matrix via servers aside), as sameAddRef compares them: a cache key. */
export function addRefKey(r: AddRef): string {
  const what = r.kind === 'invite' ? r.code : r.kind === 'place' ? r.address : r.kind === 'name' ? r.name : r.handle;
  return `${r.network}\u0000${r.kind}\u0000${what}`;
}

/** A reading that parseAdd itself would give, with nothing else in it. Anything a page sends goes through this. */
export function validAddRef(x: unknown): x is AddRef {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  if (!NETWORKS.includes(r.network as Network)) return false;
  const keys = Object.keys(r).sort().join();
  const ok =
    r.kind === 'invite' ? keys === 'code,kind,network,url' && str(r.code) && str(r.url)
    : r.kind === 'place' ? (keys === 'address,kind,network' || (keys === 'address,kind,network,via' && Array.isArray(r.via) && r.via.length <= 10 && r.via.every((v) => typeof v === 'string' && HOST.test(v)))) && str(r.address, 512)
    : r.kind === 'name' ? keys === 'kind,name,network' && str(r.name, 64)
    : r.kind === 'person' ? keys === 'handle,kind,network' && str(r.handle, 512)
    : false;
  if (!ok) return false;
  const ref = x as AddRef;
  return parseAdd(sourceOf(ref)).some((p) => sameAddRef(p, ref));
}

/** What a reading is, in a few words: "Discord invite discord.gg/abc", "Telegram @name". */
export function describeAddRef(r: AddRef): string {
  const net = NETWORK_META[r.network].name;
  switch (r.kind) {
    case 'invite':
      return r.network === 'signal' ? 'Signal group link' : `${net} invite ${r.url.replace(/^https:\/\//, '')}`;
    case 'place':
      return `Matrix ${r.address.startsWith('#') ? 'address' : 'room'} ${r.address}`;
    case 'name':
      return `${net} @${r.name}`;
    case 'person':
      if (r.network === 'x' || r.network === 'instagram') return `${net} @${r.handle}`;
      if (r.network === 'signal' && r.handle.startsWith('https://')) return 'Signal username link';
      if (r.network === 'signal' && !r.handle.startsWith('+')) return `Signal username ${r.handle}`;
      if (r.network === 'discord') return SNOWFLAKE.test(r.handle) ? `Discord user ${r.handle}` : `Discord username ${r.handle}`;
      return `${net} ${r.handle}`;
  }
}

/** A reading that joins something, rather than adding someone: what the switcher offers Join for. */
export const joinsSomething = (r: AddRef) => r.kind === 'invite' || r.kind === 'place';

/** The plain line for a reading no account of its network can resolve yet: no button, just this. */
export function notBuiltLine(r: AddRef): string {
  const net = NETWORK_META[r.network].name;
  if (r.kind === 'invite') return `Joining from ${net} invites isn't built for this account yet`;
  if (r.kind === 'place') return `Joining ${net} rooms by address isn't built for this account yet`;
  if (r.kind === 'name') return `Looking up ${net} names isn't built for this account yet`;
  return `Adding people on ${net} isn't built for this account yet`;
}
