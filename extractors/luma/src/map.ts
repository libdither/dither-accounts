/**
 * Luma's answers (api.luma.com, as its web app gets them; docs/luma.md "The shapes it reads") as dither-chat's facts:
 * events as PostFacts with `event` (chat-protocol feed.ts), hosts and guests as identity facts keyed by their `usr-` id,
 * profiles as PersonAbout with their socials as links, notifications as feed messages, blasts and chats as messages.
 * Pure: everything here is tested on invented answers (test/map.test.ts).
 *
 * The hard rule (contract "People"): an event whose host hides the guest list (`show_guest_list: false`) gives no
 * guest at all, whatever the answer carries; only its hosts are people.
 */
import type * as P from '@dither-chat/protocol';

export const SITE = 'https://luma.com';
export const API = 'https://api.luma.com';
/** The author of Luma's own notices. */
export const LUMA_ACTOR = 'luma';
export const FEED_CONV = 'feed';

// ------------------------------------------------------------------ helpers
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, any> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : null);
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const ms = (v: unknown): number | null => {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
};
export const USER_ID = /^usr-[A-Za-z0-9]{1,40}$/;
export const EVENT_ID = /^evt-[A-Za-z0-9]{1,40}$/;
/** A Luma id of any kind (`chconv-…`, `chatmsg-…`, `discplace-…`): letters, digits, one dash after the prefix. */
export const ANY_ID = /^[a-z]{2,16}-[A-Za-z0-9]{1,60}$/;
export const isUserId = (v: unknown): v is string => typeof v === 'string' && USER_ID.test(v);
export const isEventId = (v: unknown): v is string => typeof v === 'string' && EVENT_ID.test(v);
export const isLumaId = (v: unknown): v is string => typeof v === 'string' && ANY_ID.test(v);

/** Pictures Luma serves: its image CDNs (an `<img>` loads them without cookies). */
const MEDIA_HOSTS = /^(images\.lumacdn\.com|cdn\.lu\.ma|social-images\.lu\.ma|images\.lu\.ma)$/;
export function mediaUrl(u: unknown, testOrigin: string | null = null): string | null {
  const s = str(u);
  if (!s) return null;
  if (testOrigin && s.startsWith(`${testOrigin}/`)) return s;
  try {
    const url = new URL(s);
    return url.protocol === 'https:' && MEDIA_HOSTS.test(url.hostname) ? url.href : null;
  } catch {
    return null;
  }
}

/** What an answer skipped, by why, for the status details. */
export class Drops {
  private readonly n = new Map<string, number>();
  add(why: string) {
    this.n.set(why, (this.n.get(why) ?? 0) + 1);
  }
  summary(top = 3): string | null {
    if (!this.n.size) return null;
    return [...this.n.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, top)
      .map(([k, v]) => `${k} ×${v}`)
      .join(', ');
  }
}

// ------------------------------------------------------------------ people
export interface LumaUser {
  id: string;
  name: string | null;
  username: string | null;
  avatar: string | null;
  bio: string | null;
  twitter: string | null;
  instagram: string | null;
  linkedin: string | null;
  tiktok: string | null;
  youtube: string | null;
  website: string | null;
}

/** Everyone an answer named, by usr- id: the newest fields win, missing ones keep what was known. */
export interface Ctx {
  users: Map<string, LumaUser>;
  drops: Drops;
  testOrigin: string | null;
}
export const newCtx = (drops = new Drops(), testOrigin: string | null = null): Ctx => ({ users: new Map(), drops, testOrigin });

/** A Luma user object (a host, a featured guest, a guest list row, a chat author, a profile) into the context. */
export function userOf(v: unknown, ctx: Ctx): LumaUser | null {
  const u = obj(v);
  const id = u && str(u.api_id);
  if (!u || !isUserId(id)) return null;
  const name = str(u.name) ?? ([str(u.first_name), str(u.last_name)].filter(Boolean).join(' ') || null);
  const got: LumaUser = {
    id,
    name,
    username: str(u.username),
    avatar: str(u.avatar_url),
    bio: str(u.bio_short) ?? str(u.bio),
    twitter: str(u.twitter_handle),
    instagram: str(u.instagram_handle),
    linkedin: str(u.linkedin_handle),
    tiktok: str(u.tiktok_handle),
    youtube: str(u.youtube_handle),
    website: str(u.website),
  };
  const was = ctx.users.get(id);
  const merged = was ? (Object.fromEntries(Object.entries(got).map(([k, x]) => [k, x ?? (was as any)[k]])) as unknown as LumaUser) : got;
  ctx.users.set(id, merged);
  return merged;
}

export const profileUrl = (u: { id: string; username: string | null }) => (u.username ? `${SITE}/user/${encodeURIComponent(u.username)}` : `${SITE}/user/${u.id}`);

export function identityFact(u: LumaUser, selfId: string | null): P.IdentityFact {
  return {
    nativeId: u.id,
    ...(u.username ? { handle: u.username } : {}),
    ...(u.name ? { displayName: u.name } : {}),
    ...(u.avatar ? { avatarUrl: u.avatar } : {}),
    ...(u.id === selfId ? { isSelf: true } : {}),
  };
}
export const lumaIdentity = (): P.IdentityFact => ({ nativeId: LUMA_ACTOR, displayName: 'Luma', isBot: true });

const clean = (h: string) => h.replace(/^@/, '').trim();
/** A person's socials as links, each with the address the same-person engine reads (dither-chat docs/same-person.md). */
export function socialLinks(u: LumaUser): NonNullable<P.PersonAbout['links']> {
  const out: NonNullable<P.PersonAbout['links']> = [{ label: 'Luma', value: u.username ? `@${u.username}` : (u.name ?? u.id), url: profileUrl(u) }];
  const handle = (label: string, h: string | null, url: (x: string) => string) => {
    if (!h) return;
    const x = clean(h);
    if (!x || !/^[\w.\-/]{1,100}$/.test(x)) return;
    out.push({ label, value: label === 'LinkedIn' ? x.replace(/^\/?in\//, '') : `@${x.replace(/^\//, '')}`, url: url(x) });
  };
  handle('X', u.twitter, (x) => `https://x.com/${x}`);
  handle('Instagram', u.instagram, (x) => `https://www.instagram.com/${x}`);
  // Luma keeps LinkedIn as a path ("/in/ann-lee"), sometimes a bare name.
  handle('LinkedIn', u.linkedin, (x) => `https://www.linkedin.com${x.startsWith('/') ? x : x.startsWith('in/') ? `/${x}` : `/in/${x}`}`);
  handle('TikTok', u.tiktok, (x) => `https://www.tiktok.com/@${x}`);
  handle('YouTube', u.youtube, (x) => `https://www.youtube.com/${x.startsWith('@') || x.startsWith('channel/') ? x : `@${x}`}`);
  if (u.website) {
    try {
      const w = new URL(/^https?:\/\//.test(u.website) ? u.website : `https://${u.website}`);
      if (w.protocol === 'https:' || w.protocol === 'http:') out.push({ label: 'Website', value: w.host + (w.pathname === '/' ? '' : w.pathname), url: w.href });
    } catch {}
  }
  return out;
}

export function personAbout(u: LumaUser, posts: P.PostFact[] = []): P.PersonAbout {
  return {
    ...(u.name ? { displayName: u.name } : {}),
    ...(u.username ? { handle: u.username, username: { name: u.username, link: profileUrl(u) } } : {}),
    ...(u.avatar ? { avatar: u.avatar } : {}),
    ...(u.bio ? { bio: u.bio } : {}),
    links: socialLinks(u),
    ...(posts.length ? { posts } : {}),
  };
}

// ------------------------------------------------------------------ events
/** Luma's rich text (a ProseMirror document: `description_mirror`) as plain text, a paragraph per line. */
export function mirrorText(doc: unknown): string {
  const out: string[] = [];
  const walk = (n: any, line: string[]): void => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'text' && typeof n.text === 'string') {
      line.push(n.text);
      return;
    }
    if (n.type === 'hard_break') {
      line.push('\n');
      return;
    }
    if (n.type === 'mention' && n.attrs) {
      line.push(String(n.attrs.label ?? n.attrs.name ?? ''));
      return;
    }
    for (const c of arr(n.content)) walk(c, line);
  };
  const blocks = (n: any): void => {
    for (const c of arr(n?.content)) {
      if (c?.type === 'bullet_list' || c?.type === 'ordered_list' || c?.type === 'list_item' || c?.type === 'blockquote') {
        blocks(c);
        continue;
      }
      const line: string[] = [];
      walk(c, line);
      const s = line.join('').trim();
      if (s) out.push(c?.type === 'heading' || c?.type === 'paragraph' ? s : s);
    }
  };
  blocks(doc);
  return out.join('\n');
}

const RSVP_OF: Record<string, P.EventRsvp> = {
  approved: 'going',
  going: 'going',
  pending_approval: 'pending',
  pending: 'pending',
  waitlist: 'waitlist',
  declined: 'declined',
  invited: 'invited',
  session: 'going',
};
/** The account's own answer, from `guest_info` (a listing) or `guest_data` (an event page); null when none. */
export function rsvpOf(entry: Record<string, any>): P.EventRsvp | null {
  const s = str(obj(entry.guest_info)?.approval_status) ?? str(obj(entry.guest_data)?.approval_status);
  if (s) return RSVP_OF[s] ?? null;
  if (obj(entry.event_invite) || obj(entry.invite_info)) return 'invited';
  return null;
}

const CURRENCY: Record<string, string> = { usd: '$', eur: '€', gbp: '£', cad: 'CA$', aud: 'A$', jpy: '¥', inr: '₹' };
const money = (cents: number, currency: string | null) => {
  const c = (currency ?? 'usd').toLowerCase();
  const whole = c === 'jpy' ? String(cents) : cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
  return CURRENCY[c] ? `${CURRENCY[c]}${whole}` : `${whole} ${c.toUpperCase()}`;
};
/** The price line as Luma's card words it: Free, $20, $10–$40, From $5, Sold out. */
export function priceOf(info: unknown): string | undefined {
  const t = obj(info);
  if (!t) return undefined;
  if (t.is_sold_out === true) return 'Sold out';
  if (t.is_free === true) return 'Free';
  const p = obj(t.price);
  const cents = num(p?.cents);
  if (cents === null) return undefined;
  const cur = str(p?.currency);
  if (p?.is_flexible === true && num(p?.min_cents) !== null) return `From ${money(num(p?.min_cents)!, cur)}`;
  const max = num(obj(t.max_price)?.cents);
  return max !== null && max > cents ? `${money(cents, cur)}–${money(max, cur)}` : money(cents, cur);
}

/** Where it is, as far as Luma shows this viewer: the address when shown, the city alone when hidden until you RSVP. */
export function placeOf(ev: Record<string, any>): { place?: P.EventPlace; online?: boolean } {
  const online = ev.location_type === 'online' || ev.location_type === 'zoom';
  const g = obj(ev.geo_address_info);
  if (!g) return online ? { online } : {};
  const city = str(g.city_state) ?? str(g.city) ?? undefined;
  if (g.mode !== 'shown') return { ...(city ? { place: { city } } : {}), ...(online ? { online } : {}) };
  const c = obj(ev.coordinate);
  const lat = num(c?.latitude);
  const lng = num(c?.longitude);
  const place: P.EventPlace = {
    ...(str(g.address) ? { name: str(g.address)! } : {}),
    ...(str(g.full_address) ? { address: str(g.full_address)! } : str(g.short_address) ? { address: str(g.short_address)! } : {}),
    ...(city ? { city } : {}),
    ...(lat !== null && lng !== null ? { lat, lng, url: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}` } : {}),
  };
  return { place, ...(online ? { online } : {}) };
}

export interface EventKnown {
  /** Its own conversation (the account is in it: going, waiting, invited or hosting). */
  inIt: boolean;
  rsvp: P.EventRsvp | null;
  hosting: boolean;
  showGuests: boolean;
  /** For the RSVP: whether one click registers, and why not. */
  oneClick: string | null;
  ticketType: { id: string; cents: number } | null;
  name: string;
  cover: string | null;
  start: number;
}

/**
 * One event entry (a discover or home listing's entry, or `/event/get`'s whole answer: the same top-level keys) as a
 * PostFact. Its hosts, and the guests Luma showed when the list is not hidden, go into `ctx` (identity facts first,
 * from the caller). `guestList`: the guest list's rows the site showed this signed-in viewer (`/event/get-guest-list`),
 * used only when the host shows the list.
 */
export function eventPost(entry: unknown, ctx: Ctx, o: { guestList?: { ids: string[]; complete: boolean }; ics?: string } = {}): { post: P.PostFact; known: EventKnown } | null {
  const e = obj(entry);
  const ev = obj(e?.event);
  const id = str(ev?.api_id);
  if (!e || !ev || !isEventId(id)) {
    ctx.drops.add('event without an id');
    return null;
  }
  const start = ms(ev.start_at) ?? ms(e.start_at);
  if (start === null) {
    ctx.drops.add('event without a start');
    return null;
  }
  const hosts = arr(e.hosts)
    .map((h) => userOf(h, ctx))
    .filter((u): u is LumaUser => !!u)
    .map((u) => u.id);
  const showGuests = ev.show_guest_list === true;
  let guests: string[] | undefined;
  let guestsShown: P.EventGuestsShown = 'hidden';
  const count = num(e.guest_count);
  if (showGuests) {
    // Only what the site showed this viewer: its featured guests, or the list it gave a signed-in guest.
    if (o.guestList) {
      guests = o.guestList.ids;
      guestsShown = o.guestList.complete ? 'all' : 'sample';
    } else {
      guests = arr(e.featured_guests)
        .map((g) => userOf(g, ctx))
        .filter((u): u is LumaUser => !!u)
        .map((u) => u.id);
      guestsShown = guests.length && count !== null && guests.length >= count ? 'all' : guests.length ? 'sample' : 'count';
      // Nobody named: a count at most, and no guests key (as protocol's withoutHiddenGuests would leave it).
      if (!guests.length) guests = undefined;
    }
  } else if (arr(e.featured_guests).length) {
    // Luma leaves them out itself for a hidden list; were one ever there, it is not read.
    ctx.drops.add('guests of a hidden list');
  }
  const rsvp = rsvpOf(e);
  const hosting = !!obj(e.host_info) || !!obj(e.manager_info)?.is_manager;
  const inIt = rsvp !== null || hosting;
  const { place, online } = placeOf(ev);
  const cal = obj(e.calendar);
  const calId = str(cal?.api_id);
  const tags = arr(e.categories)
    .map((c) => str(obj(c)?.name) ?? str(obj(obj(c)?.category)?.name))
    .filter((x): x is string => !!x);
  const cover = str(ev.cover_url);
  const text = e.description_mirror ? mirrorText(e.description_mirror) : (str(e.description) ?? '');
  const fact: P.EventFact = {
    start,
    ...(ms(ev.end_at) !== null ? { end: ms(ev.end_at)! } : {}),
    ...(str(ev.timezone) ? { timeZone: str(ev.timezone)! } : {}),
    ...(place ? { place } : {}),
    ...(online ? { online } : {}),
    hosts,
    ...(showGuests && count !== null ? { going: count } : {}),
    ...(guests ? { guests } : {}),
    guestsShown,
    ...(priceOf(e.ticket_info) ? { price: priceOf(e.ticket_info)! } : {}),
    rsvp,
    ...(hosting ? { hosting: true } : {}),
    ...(inIt ? { conversation: `event:${id}` } : {}),
    ...(o.ics ? { ics: o.ics } : {}),
    ...(tags.length ? { tags } : {}),
  };
  const post: P.PostFact = {
    id,
    url: `${SITE}/${encodeURIComponent(str(ev.url) ?? id)}`,
    ts: start,
    ...(hosts[0] ? { author: hosts[0] } : {}),
    text,
    title: str(ev.name) ?? 'Untitled event',
    ...(cover ? { media: [{ kind: 'image' as const, url: cover }] } : {}),
    ...(cal && calId && !cal.is_personal && str(cal.name) ? { place: { id: calId, name: str(cal.name)!, ...(str(cal.slug) ? { url: `${SITE}/${encodeURIComponent(str(cal.slug)!)}` } : {}) } } : {}),
    event: fact,
  };
  // One click registers a free event with one ticket type and no questions, as the event page's own button does.
  const types = arr(e.ticket_types).filter((t) => obj(t) && !obj(t)?.is_hidden);
  const t0 = obj(types[0]);
  const paid = obj(e.ticket_info) && obj(e.ticket_info)!.is_free === false;
  const why = !Array.isArray(e.ticket_types)
    ? 'Luma did not give its tickets'
    : paid || (num(t0?.cents) ?? 0) > 0
      ? 'it has paid tickets'
      : types.length > 1
        ? 'it has several kinds of ticket'
        : arr(e.registration_questions).length
          ? 'it asks questions when you register'
          : obj(e.phone_number_requirement) || str(e.phone_number_requirement) === 'required'
            ? 'it wants your phone number'
            : e.eth_address_requirement || e.solana_address_requirement
              ? 'it wants a wallet'
              : null;
  return {
    post,
    known: {
      inIt,
      rsvp,
      hosting,
      showGuests,
      oneClick: why,
      ticketType: t0 && str(t0.api_id) ? { id: str(t0.api_id)!, cents: num(t0.cents) ?? 0 } : null,
      name: post.title!,
      cover,
      start,
    },
  };
}

/** A listing page: `{ entries, has_more, next_cursor }` (discover, home, a profile's events). */
export function eventsPage(v: unknown, ctx: Ctx): { posts: { post: P.PostFact; known: EventKnown }[]; more: string | null } {
  const o = obj(v);
  const posts = arr(o?.entries)
    .map((x) => eventPost(x, ctx))
    .filter((x): x is { post: P.PostFact; known: EventKnown } => !!x);
  const next = str(o?.next_cursor);
  return { posts, more: o?.has_more === true && next ? next : null };
}

/** The guest list a signed-in guest is shown (`/event/get-guest-list`): its people, in order. */
export function guestListPage(v: unknown, ctx: Ctx): { ids: string[]; more: string | null } {
  const o = obj(v);
  const ids: string[] = [];
  for (const row of arr(o?.entries)) {
    const u = userOf(obj(row)?.user ?? row, ctx);
    if (u) ids.push(u.id);
  }
  const next = str(o?.next_cursor);
  return { ids, more: o?.has_more === true && next ? next : null };
}

// ------------------------------------------------------------------ feed (notifications)
export interface FeedEntry {
  nativeId: string;
  ts: number;
  actor: string;
  title: string;
  preview: string | null;
  event: string | null;
  seen: boolean;
}

/** Luma's notification title marks bold with **…**: the words without the marks. */
const unbold = (s: string) => s.replace(/\*\*(.+?)\*\*/g, '$1');

/** `/notifications/list`: `{ entries: [{ api_id, notification: { title, preview, original_action_at, seen_at, … }, related_users, event, calendar }] }`. */
export function parseNotifications(v: unknown, ctx: Ctx): { entries: FeedEntry[]; more: string | null } {
  const o = obj(v);
  const entries: FeedEntry[] = [];
  for (const raw of arr(o?.entries)) {
    const r = obj(raw);
    const n = obj(r?.notification);
    const id = str(r?.api_id) ?? str(n?.api_id);
    const ts = ms(n?.original_action_at) ?? ms(n?.created_at);
    const title = str(n?.title);
    if (!r || !n || !id || !isLumaId(id) || ts === null || !title) {
      ctx.drops.add('notification without an id, time or words');
      continue;
    }
    const users = arr(r.related_users)
      .map((u) => userOf(u, ctx))
      .filter((u): u is LumaUser => !!u);
    const evId = str(obj(r.event)?.api_id);
    const actor = users[0]?.id ?? LUMA_ACTOR;
    entries.push({ nativeId: `other:${id}:${actor === LUMA_ACTOR ? '-' : actor}`, ts, actor, title: unbold(title).slice(0, 500), preview: str(n.preview)?.slice(0, 1000) ?? null, event: isEventId(evId) ? evId : null, seen: !!str(n.seen_at) });
  }
  const next = str(o?.next_cursor);
  return { entries, more: o?.has_more === true && next ? next : null };
}

export const feedConversation = (): P.ConversationFact => ({ nativeId: FEED_CONV, shape: 'channel', variant: 'feed', name: 'Luma notifications' });

export function feedMessage(e: FeedEntry): P.MessageFact {
  const item: P.FeedItem = { type: 'other', text: e.title, ...(e.event ? { url: `${SITE}/event/${e.event}` } : {}) };
  return {
    nativeId: e.nativeId,
    conversation: FEED_CONV,
    author: e.actor,
    ts: e.ts,
    kind: 'system',
    body: e.preview ? `${e.title}\n${e.preview}` : e.title,
    extra: { feed: item, ...(e.event ? { event: e.event } : {}) },
  };
}

// ------------------------------------------------------------------ event conversations (blasts)
export function eventConversation(id: string, k: Pick<EventKnown, 'name' | 'cover'>, hosts: string[]): P.ConversationFact {
  return { nativeId: `event:${id}`, shape: 'group', name: k.name, ...(k.cover ? { avatarUrl: k.cover } : {}), ...(hosts.length ? { participants: hosts } : {}) };
}

/** `/event/get-blasts`: `{ blasts: [{ api_id, sent_at, subject, content_text, user? }] }` as messages, oldest first. */
export function blastMessages(v: unknown, eventId: string, fallbackAuthor: string | null, ctx: Ctx): P.MessageFact[] {
  const out: P.MessageFact[] = [];
  for (const raw of arr(obj(v)?.blasts)) {
    const b = obj(raw);
    const id = str(b?.api_id);
    const ts = ms(b?.sent_at) ?? ms(b?.created_at);
    if (!b || !id || !isLumaId(id) || ts === null) {
      ctx.drops.add('blast without an id or time');
      continue;
    }
    const by = userOf(b.user ?? b.sender ?? b.author, ctx);
    const subject = str(b.subject);
    const words = str(b.content_text) ?? (b.content_mirror ? mirrorText(b.content_mirror) : str(b.message)) ?? '';
    out.push({
      nativeId: `blast:${id}`,
      conversation: `event:${eventId}`,
      author: by?.id ?? fallbackAuthor ?? LUMA_ACTOR,
      ts,
      kind: 'text',
      body: subject && words && !words.startsWith(subject) ? `${subject}\n\n${words}` : words || subject || '',
      extra: { blast: true, event: eventId },
    });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

// ------------------------------------------------------------------ chats
export interface ChatConv {
  id: string;
  type: string;
  event: string | null;
  lastReadAt: number | null;
}

/** A chat conversation (`/chat/conversations/sync` entries, `/chat/conversation/get`): direct, group or an event's chat. */
export function chatConversation(v: unknown, selfId: string | null, ctx: Ctx): { fact: P.ConversationFact; conv: ChatConv } | null {
  const c = obj(v);
  const id = str(c?.api_id);
  if (!c || !isLumaId(id)) return null;
  const type = str(c.type) ?? 'group';
  if (type === 'support') return null;
  const other = type === 'direct' ? userOf(obj(c.other_participant)?.user, ctx) : null;
  const eventId = str(c.event_api_id);
  const lastAt = ms(obj(c.last_message)?.sent_at);
  const muted = ms(obj(c.my_participant)?.mute_until);
  const fact: P.ConversationFact = {
    nativeId: id,
    shape: type === 'direct' ? 'direct' : 'group',
    ...(type === 'direct' ? (other?.name ? { name: other.name } : {}) : str(c.name) ? { name: str(c.name)! } : {}),
    ...(type === 'direct' ? (other?.avatar ? { avatarUrl: other.avatar } : {}) : str(c.avatar_url) ? { avatarUrl: str(c.avatar_url)! } : {}),
    ...(other ? { participants: [other.id, ...(selfId ? [selfId] : [])] } : {}),
    ...(lastAt !== null ? { lastMessageAt: lastAt } : {}),
    ...(muted !== null && muted > Date.now() ? { mute: { until: muted } } : {}),
  };
  return { fact, conv: { id, type, event: isEventId(eventId) ? eventId : null, lastReadAt: ms(obj(c.my_participant)?.last_read_at) } };
}

/** A chat message (`/chat/messages/sync`, `/chat/conversation/get-messages`). Deleted ones come back as `{ deleted }`. */
export function chatMessage(v: unknown, selfId: string | null, ctx: Ctx, eventOf: (conv: string) => string | null = () => null): P.MessageFact | { deleted: { conversation: string; nativeId: string } } | null {
  const m = obj(v);
  const id = str(m?.api_id);
  const conv = str(m?.chat_conversation_api_id);
  const ts = ms(m?.sent_at);
  if (!m || !isLumaId(id) || !isLumaId(conv) || ts === null) {
    ctx.drops.add('chat message without an id, place or time');
    return null;
  }
  if (str(m.deleted_at)) return { deleted: { conversation: conv, nativeId: id } };
  const author = userOf(m.author, ctx)?.id ?? str(m.user_api_id) ?? LUMA_ACTOR;
  const system = !!str(m.message_type) && m.message_type !== 'text' && m.message_type !== 'message' && m.message_type !== 'user';
  const reactions = new Map<string, { authors: string[]; at: Record<string, number> }>();
  for (const r of arr(m.reactions)) {
    const x = obj(r);
    const key = str(x?.reaction_type);
    const who = str(x?.user_api_id);
    if (!x || !key || !who || str(x.removed_at)) continue;
    const g = reactions.get(key) ?? { authors: [], at: {} };
    if (!g.authors.includes(who)) g.authors.push(who);
    const at = ms(x.created_at);
    if (at !== null) g.at[who] = at;
    reactions.set(key, g);
  }
  const attachments: P.AttachmentFact[] = [];
  for (const raw of arr(m.media)) {
    const a = obj(raw);
    const url = str(a?.url) ?? str(a?.display_url);
    if (!a || !url) continue;
    const kind = a.type === 'video' ? 'video' : 'image';
    attachments.push({ kind, url, ...(str(a.mime_type) ? { mime: str(a.mime_type)! } : {}), ...(num(a.width) ? { width: num(a.width)! } : {}), ...(num(a.height) ? { height: num(a.height)! } : {}) } as P.AttachmentFact);
  }
  const reply = str(m.replying_to_message_api_id);
  const mentions = arr(m.mentions).some((x) => str(obj(x)?.user_api_id) === selfId || str(x) === selfId);
  const ev = eventOf(conv);
  return {
    nativeId: id,
    conversation: conv,
    author,
    ts,
    kind: system ? 'system' : 'text',
    body: str(m.message) ?? '',
    ...(reply && isLumaId(reply) ? { replyTo: reply } : {}),
    ...(selfId && mentions && author !== selfId ? { mentionsSelf: true } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(reactions.size ? { reactions: [...reactions.entries()].map(([key, g]) => ({ key, authors: g.authors, ...(Object.keys(g.at).length ? { at: g.at } : {}) })) } : {}),
    ...(ev ? { extra: { event: ev } } : {}),
  };
}

/** A sync page: `{ entries, has_more, next_cursor }`. */
export function syncPage(v: unknown): { entries: unknown[]; more: boolean; next: string | null } {
  const o = obj(v);
  return { entries: arr(o?.entries), more: o?.has_more === true, next: str(o?.next_cursor) };
}

// ------------------------------------------------------------------ discover places
export interface Place {
  id: string;
  slug: string | null;
  name: string | null;
  featured: string[];
}
export function placeOfAnswer(v: unknown): Place | null {
  const p = obj(obj(v)?.place) ?? obj(v);
  const id = str(p?.api_id);
  if (!p || !id || !/^discplace-[A-Za-z0-9]{1,40}$/.test(id)) return null;
  return { id, slug: str(p.slug), name: str(p.name), featured: arr(p.featured_event_api_ids).filter(isEventId) };
}
/** `/url?url=<slug>` → `{ kind: 'discover-place', data: { place, events } }`; anything else is not a city. */
export function placeOfUrl(v: unknown): Place | null {
  const o = obj(v);
  return o?.kind === 'discover-place' ? placeOfAnswer(obj(o.data)?.place) : null;
}
/** `/discover/bootstrap-page`: Luma's own pick for this viewer (`featured_place`). */
export const placeOfBootstrap = (v: unknown): Place | null => placeOfAnswer(obj(v)?.featured_place);

/** A city as the owner wrote it, as Luma's place slug: "New Exampletown" → "new-exampletown", "nyc" → "nyc". */
export function citySlug(city: unknown): string | null {
  const s = str(typeof city === 'string' ? city.trim() : null);
  if (!s) return null;
  const slug = s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug && slug.length <= 60 ? slug : null;
}
