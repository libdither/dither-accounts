/**
 * Partiful's answers as the chat protocol's facts (docs/partiful.md "How it maps"). Pure: every function takes what
 * the page's hook sent and gives facts, so the tests can feed it invented answers (test/fixtures.ts).
 *
 * People are keyed by their Partiful user id (a Firebase uid), never by a picture's address. A host's or guest's
 * name, picture, bio and socials come from what the site gave the viewer; nothing here asks for more than the site's
 * own page would show.
 *
 * The hidden-list rule (docs/partiful.md "Who is going"): when an event's `showGuestList` is not true, nothing here
 * reads getGuests' rows at all, so their RSVP times and notes (which Partiful sends with names blanked) are never
 * looked at, kept or passed on. The hook drops those fields from every getGuests answer before it leaves the page, too.
 */
import type * as P from '@dither-chat/protocol';

export const SITE = 'https://partiful.com';
/** The notifications conversation (read-only). */
export const FEED_CONV = 'feed';
/** Partiful itself, as the author of a notification that names nobody. */
export const PARTIFUL_ACTOR = 'partiful';
/** How many explore events go in one page of the `explore` home feed. */
export const EXPLORE_PAGE = 20;

/** What was dropped and why, counted (shown in the status). */
export class Drops {
  readonly counts = new Map<string, number>();
  add(kind: string) {
    this.counts.set(kind, (this.counts.get(kind) ?? 0) + 1);
  }
  summary(max = 5): string | null {
    if (!this.counts.size) return null;
    return [...this.counts]
      .sort((a, b) => b[1] - a[1])
      .slice(0, max)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
  }
}

export interface PfUser {
  id: string;
  name: string | null;
  photo: string | null;
  bio: string | null;
  /** Social handles or links by Partiful's own key (instagram, twitter, tiktok, linkedin, youtube, website…). */
  socials: Record<string, string>;
  hosted?: number;
  attended?: number;
}

/** What is kept about an event between calls: enough to answer a write (its hosts, whether its list shows). */
export interface PfEventKept {
  id: string;
  title: string;
  owners: string[];
  showGuestList: boolean | null;
  image: string | null;
  /** The account's own RSVP, as Partiful's status. */
  status: string | null;
}

export interface Ctx {
  drops: Drops;
  testOrigin: string | null;
  users: Map<string, PfUser>;
  events: Map<string, PfEventKept>;
  /** Comment id → its event, for reactions and replies. */
  comments: Map<string, string>;
  /** Album photo id → its picture, for comments that show photos. */
  photos: Map<string, P.AttachmentFact>;
  selfId: string | null;
}
export const newCtx = (drops = new Drops(), testOrigin: string | null = null): Ctx => ({ drops, testOrigin, users: new Map(), events: new Map(), comments: new Map(), photos: new Map(), selfId: null });

const rec = (v: unknown): Record<string, any> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Partiful's ids: Firestore document ids and Firebase uids. */
const ID = /^[A-Za-z0-9_-]{6,64}$/;
export const isId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);
/** A comment's id (a UUID on the site, anything id-like in general). */
const COMMENT_ID = /^[A-Za-z0-9_-]{4,64}$/;
export const isCommentId = (v: unknown): v is string => typeof v === 'string' && COMMENT_ID.test(v);
/** An explore place as Partiful names it in /explore/<region> (sf, nyc, la…), lowercase. */
const CITY = /^[a-z0-9][a-z0-9-]{0,39}$/;
export function citySlug(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (!s) return null;
  return CITY.test(s) ? s : null;
}

/** ms epoch from an ISO string, a Firestore timestamp ({_seconds} or {seconds}) or a number. */
export function pfTime(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  const r = rec(v);
  if (r) {
    const s = num(r._seconds) ?? num(r.seconds);
    if (s !== null) return s * 1000 + Math.floor((num(r._nanoseconds) ?? num(r.nanoseconds) ?? 0) / 1e6);
  }
  return null;
}

const MEDIA_HOSTS = /^(firebasestorage\.googleapis\.com|storage\.googleapis\.com|assets\.partiful\.com|[a-z0-9-]+\.stream-io-cdn\.com|us-east\.stream-io-cdn\.com)$/;
/** A picture's address, if it is one the site's own pages load (Firebase Storage, Partiful's assets, Stream's CDN). */
export function mediaUrl(v: unknown, testOrigin: string | null): string | null {
  if (typeof v !== 'string') return null;
  if (testOrigin && v.startsWith(`${testOrigin}/`)) return v;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && MEDIA_HOSTS.test(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}
/** A photo object ({ url, upload: { url, width, height } }) as a picture. */
export function photoOf(v: unknown, ctx: Ctx): { url: string; width?: number; height?: number; mime?: string } | null {
  const r = rec(v);
  if (!r) return typeof v === 'string' ? (mediaUrl(v, ctx.testOrigin) ? { url: mediaUrl(v, ctx.testOrigin)! } : null) : null;
  const up = rec(r.upload);
  const url = mediaUrl(r.url, ctx.testOrigin) ?? mediaUrl(up?.url, ctx.testOrigin);
  if (!url) return null;
  const width = num(r.width) ?? num(up?.width);
  const height = num(r.height) ?? num(up?.height);
  const mime = str(r.contentType) ?? str(up?.contentType);
  return { url, ...(width ? { width } : {}), ...(height ? { height } : {}), ...(mime ? { mime } : {}) };
}

/** A field Partiful keeps as `{ visibility, value }` or plainly. */
const valueOf = (v: unknown): string | null => str(rec(v)?.value) ?? str(v);

/** A person from any answer that carries one ({ id, name, photo, bio, socials }), kept in ctx (richer wins). */
export function userOf(v: unknown, ctx: Ctx): PfUser | null {
  const r = rec(v);
  if (!r || !isId(r.id)) return null;
  const socials: Record<string, string> = {};
  for (const [k, x] of Object.entries(rec(r.socials) ?? {})) {
    const s = valueOf(x);
    if (s && /^[a-z]{2,20}$/.test(k)) socials[k] = s.trim().slice(0, 300);
  }
  const was = ctx.users.get(r.id);
  const u: PfUser = {
    id: r.id,
    name: str(r.name)?.trim().slice(0, 200) ?? was?.name ?? null,
    photo: photoOf(r.photo, ctx)?.url ?? was?.photo ?? null,
    bio: valueOf(r.bio)?.slice(0, 2000) ?? was?.bio ?? null,
    socials: Object.keys(socials).length ? socials : (was?.socials ?? {}),
  };
  const hosted = num(r.hostedCount) ?? num(rec(r.partyStats)?.hostedCount) ?? was?.hosted;
  const attended = num(r.attendedCount) ?? num(rec(r.partyStats)?.attendedCount) ?? was?.attended;
  if (hosted !== undefined && hosted !== null) u.hosted = hosted;
  if (attended !== undefined && attended !== null) u.attended = attended;
  ctx.users.set(u.id, u);
  return u;
}

export function identityFact(u: PfUser, selfId: string | null): P.IdentityFact {
  return {
    nativeId: u.id,
    ...(u.name ? { displayName: u.name } : {}),
    ...(u.photo ? { avatarUrl: u.photo } : {}),
    ...(u.id === selfId ? { isSelf: true } : {}),
  };
}
export const partifulIdentity = (): P.IdentityFact => ({ nativeId: PARTIFUL_ACTOR, displayName: 'Partiful' });
export const profileUrl = (id: string) => `${SITE}/u/${id}`;
export const eventUrl = (id: string) => `${SITE}/e/${id}`;
export const eventConv = (id: string) => `event:${id}`;
export const chatConv = (id: string) => `chat:${id}`;

const SOCIAL: Record<string, { label: string; url: (h: string) => string }> = {
  instagram: { label: 'Instagram', url: (h) => `https://instagram.com/${h}` },
  twitter: { label: 'X', url: (h) => `https://x.com/${h}` },
  x: { label: 'X', url: (h) => `https://x.com/${h}` },
  tiktok: { label: 'TikTok', url: (h) => `https://www.tiktok.com/@${h}` },
  linkedin: { label: 'LinkedIn', url: (h) => `https://www.linkedin.com/in/${h}` },
  youtube: { label: 'YouTube', url: (h) => `https://www.youtube.com/@${h}` },
  snapchat: { label: 'Snapchat', url: (h) => `https://www.snapchat.com/add/${h}` },
  venmo: { label: 'Venmo', url: (h) => `https://venmo.com/${h}` },
  substack: { label: 'Substack', url: (h) => `https://${h}.substack.com` },
  soundcloud: { label: 'SoundCloud', url: (h) => `https://soundcloud.com/${h}` },
  spotify: { label: 'Spotify', url: (h) => `https://open.spotify.com/user/${h}` },
  website: { label: 'Website', url: (h) => h },
};
/** One social as a link the same-person engine reads: a site's handle with its profile address, or a website. */
export function socialLink(key: string, value: string): { label: string; value: string; url?: string } | null {
  const v = value.trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return { label: SOCIAL[key]?.label ?? key, value: v, url: v };
  const s = SOCIAL[key];
  if (key === 'website') return { label: 'Website', value: v, url: `https://${v.replace(/^\/+/, '')}` };
  const handle = v.replace(/^@/, '');
  if (!s) return { label: key, value: handle };
  if (!/^[\w.-]{1,100}$/.test(handle)) return { label: s.label, value: handle };
  return { label: s.label, value: `@${handle}`, url: s.url(handle) };
}

/** What the site shows of someone's profile, for the `profile` command and `personAbout`. */
export function personAbout(u: PfUser): P.PersonAbout {
  const links = [{ label: 'Partiful', value: u.name ?? u.id, url: profileUrl(u.id) }];
  for (const [k, v] of Object.entries(u.socials)) {
    const l = socialLink(k, v);
    if (l) links.push(l as { label: string; value: string; url: string });
  }
  const facts: { label: string; value: string }[] = [];
  if (u.hosted !== undefined) facts.push({ label: 'Hosted', value: String(u.hosted) });
  if (u.attended !== undefined) facts.push({ label: 'Attended', value: String(u.attended) });
  return {
    ...(u.name ? { displayName: u.name } : {}),
    ...(u.photo ? { avatar: u.photo } : {}),
    ...(u.bio ? { bio: u.bio } : {}),
    links,
    ...(facts.length ? { facts } : {}),
  };
}

// ---------------------------------------------------------------------- events
/** Partiful's guest statuses, as the protocol's RSVP. */
export function rsvpOf(status: unknown): P.EventRsvp | null {
  switch (status) {
    case 'GOING':
    case 'APPROVED':
      return 'going';
    case 'MAYBE':
      return 'maybe';
    case 'INTERESTED':
      return 'interested';
    case 'WAITLIST':
    case 'WAITLISTED_FOR_APPROVAL':
      return 'waitlist';
    case 'PENDING_APPROVAL':
      return 'pending';
    case 'DECLINED':
    case 'REJECTED':
    case 'WITHDRAWN':
      return 'declined';
    case 'READY_TO_SEND':
    case 'SENDING':
    case 'SENT':
    case 'SEND_ERROR':
    case 'DELIVERY_ERROR':
    case 'RESPONDED_TO_FIND_A_TIME':
      return 'invited';
    default:
      return null;
  }
}
/** The protocol's RSVP choices, as the status addGuest takes. */
export const RSVP_STATUS: Record<P.EventRsvpChoice, string> = { going: 'GOING', maybe: 'MAYBE', declined: 'DECLINED', interested: 'INTERESTED' };

/** Whether the site shows guests by name to a viewer who has not RSVP'd. Only an explicit true counts. */
export const listShown = (ev: Record<string, any>): boolean => ev.showGuestList === true;

function placeOf(ev: Record<string, any>): P.EventPlace | undefined {
  const li = rec(ev.locationInfo);
  const maps = rec(li?.mapsInfo);
  const lines = Array.isArray(li?.displayAddressLines) ? li!.displayAddressLines.filter((x: unknown) => typeof x === 'string') : Array.isArray(maps?.addressLines) ? maps!.addressLines.filter((x: unknown) => typeof x === 'string') : [];
  const name = str(maps?.name) ?? (lines.length ? null : str(ev.location));
  const address = lines.length ? lines.join(', ') : null;
  const city = str(maps?.approximateLocation) ?? str(li?.neighborhood);
  const url = str(maps?.googleMapsUrl) ?? str(maps?.appleMapsUrl);
  const lat = num(rec(li?.coordinates)?.lat) ?? num(rec(li?.coordinates)?.latitude);
  const lng = num(rec(li?.coordinates)?.lng) ?? num(rec(li?.coordinates)?.longitude);
  const p: P.EventPlace = {
    ...(name ? { name } : {}),
    ...(address ? { address } : {}),
    ...(city ? { city } : {}),
    ...(lat !== null && lng !== null ? { lat, lng } : {}),
    ...(url && /^https:\/\//.test(url) ? { url } : {}),
  };
  return Object.keys(p).length ? p : undefined;
}

function tagsOf(...lists: unknown[]): string[] {
  const out: string[] = [];
  for (const l of lists) {
    if (!Array.isArray(l)) continue;
    for (const t of l) {
      const s = str(t) ?? str(rec(t)?.name) ?? str(rec(t)?.title) ?? str(rec(t)?.label);
      if (s && !out.includes(s)) out.push(s.slice(0, 60));
    }
  }
  return out.slice(0, 10);
}

export interface EventOpts {
  /** Guest ids the site showed (only ever with a shown list). */
  guests?: string[];
  /** Whether those are all of them or a first page. */
  allGuests?: boolean;
  /** The account's own guest status (Partiful's), when known. */
  status?: string | null;
  /** Tags or the explore section's descriptionTags. */
  tags?: unknown[];
  /** Comments counted. */
  comments?: number;
}

/** Remember the event (hosts, list setting, the account's status), and hand back its kept form. */
export function keepEvent(ev: Record<string, any>, ctx: Ctx, status?: string | null): PfEventKept | null {
  if (!isId(ev.id)) return null;
  const was = ctx.events.get(ev.id);
  const owners = (Array.isArray(ev.ownerIds) ? ev.ownerIds : Array.isArray(ev.owners) ? ev.owners.map((o: any) => (typeof o === 'string' ? o : o?.id)) : []).filter(isId);
  const k: PfEventKept = {
    id: ev.id,
    title: str(ev.title)?.slice(0, 300) ?? was?.title ?? 'Event',
    owners: owners.length ? owners : (was?.owners ?? []),
    showGuestList: typeof ev.showGuestList === 'boolean' ? ev.showGuestList : (was?.showGuestList ?? null),
    image: photoOf(ev.image, ctx)?.url ?? was?.image ?? null,
    status: status !== undefined ? status : (was?.status ?? null),
  };
  ctx.events.set(k.id, k);
  return k;
}

/**
 * One event as a PostFact with `event` (the contract's EventFact). Hosts become identities (`users`) and lead the
 * event's `hosts`, unless the host hid the host list. Guests only ever come in `opts.guests`, read from a shown list.
 */
export function eventPost(v: unknown, ctx: Ctx, opts: EventOpts = {}): P.PostFact | null {
  const ev = rec(v);
  if (!ev || !isId(ev.id)) {
    ctx.drops.add('event without an id');
    return null;
  }
  const start = pfTime(ev.startDate);
  if (start === null) {
    ctx.drops.add('event without a start');
    return null;
  }
  const kept = keepEvent(ev, ctx, opts.status);
  for (const h of Array.isArray(ev.hosts) ? ev.hosts : []) userOf(h, ctx);
  const hostsShown = ev.showHostList !== false;
  const hosts = hostsShown ? (kept?.owners ?? []) : [];
  const shown = listShown(ev);
  const guestsShown: P.EventGuestsShown = shown ? (opts.guests ? (opts.allGuests ? 'all' : 'sample') : 'all') : ev.showGuestCount === false ? 'hidden' : 'count';
  const going = ev.showGuestCount === false ? null : (num(ev.goingGuestCount) ?? num(rec(ev.guestStatusCounts)?.GOING));
  const status = kept?.status ?? null;
  const rsvp = status ? rsvpOf(status) : null;
  const hosting = !!ctx.selfId && (kept?.owners ?? []).includes(ctx.selfId);
  const inIt = hosting || (rsvp !== null && rsvp !== 'declined');
  const place = placeOf(ev);
  const online = rec(ev.locationInfo)?.type === 'virtual' || rec(ev.locationInfo)?.type === 'online' ? true : undefined;
  const ics = str(ev.calendarFile);
  const tags = tagsOf(opts.tags, ev.tags);
  const image = photoOf(ev.image, ctx);
  const event: P.EventFact = {
    start,
    ...(pfTime(ev.endDate) ? { end: pfTime(ev.endDate)! } : {}),
    ...(str(ev.timezone) ? { timeZone: ev.timezone } : {}),
    ...(place ? { place } : {}),
    ...(online ? { online } : {}),
    hosts,
    ...(going !== null ? { going } : {}),
    // The hard rule: guests only from a list the site shows.
    ...(shown && opts.guests ? { guests: opts.guests } : {}),
    guestsShown,
    ...(ctx.selfId ? { rsvp } : {}),
    ...(hosting ? { hosting: true } : {}),
    ...(inIt ? { conversation: eventConv(ev.id) } : {}),
    ...(ics && /^https:\/\//.test(ics) ? { ics } : {}),
    ...(tags.length ? { tags } : {}),
  };
  const text = str(ev.description) ?? '';
  return {
    id: ev.id,
    url: eventUrl(ev.id),
    ts: pfTime(ev.publishedAt) ?? pfTime(ev.createdAt) ?? start,
    ...(hosts[0] ? { author: hosts[0] } : {}),
    text: text.slice(0, 20_000),
    title: kept?.title ?? 'Event',
    ...(image ? { media: [{ kind: 'image' as const, url: image.url, ...(image.width ? { width: image.width } : {}), ...(image.height ? { height: image.height } : {}) }] } : {}),
    ...(opts.comments !== undefined ? { counts: { replies: opts.comments } } : {}),
    event,
  };
}

/**
 * Guests the site showed this viewer, in its order, from getGuests pages: only for a list the site shows. For any
 * other event it returns [] without looking at a single row: their RSVP history, times and notes are never read.
 */
export function guestsOf(ev: Record<string, any>, pages: unknown[], ctx: Ctx): string[] {
  if (!listShown(ev)) return [];
  const out: string[] = [];
  for (const page of pages) {
    const rows = Array.isArray(page) ? page : Array.isArray(rec(page)?.data) ? rec(page)!.data : [];
    for (const row of rows) {
      const r = rec(row);
      if (!r) continue;
      // A row Partiful sends without its person (a name left blank, no user) is nobody the site showed.
      const u = userOf(r.user, ctx);
      if (!u || !u.name) continue;
      if (!['GOING', 'MAYBE', 'INTERESTED', 'WAITLIST', 'APPROVED'].includes(r.status)) continue;
      if (!out.includes(u.id)) out.push(u.id);
    }
  }
  return out;
}

/** The mutual guests the site shows you on an event (getMutualGuests' `guests`), as people; [] for a hidden list. */
export function mutualsOf(ev: Record<string, any>, v: unknown, ctx: Ctx): string[] {
  if (!listShown(ev)) return [];
  const list = Array.isArray(rec(v)?.guests) ? rec(v)!.guests : [];
  const out: string[] = [];
  for (const g of list) {
    const u = userOf(rec(g)?.user ?? g, ctx);
    if (u?.name && !out.includes(u.id)) out.push(u.id);
  }
  return out;
}

// --------------------------------------------------------------------- explore
export interface ExploreItem {
  post: P.PostFact;
  reason?: P.HomeReason;
}

/**
 * The explore page's server-rendered data (`/explore/<city>` pageProps, or `/explore`'s trendingSections by region):
 * the trending carousel, then each section in order, then the feed, each event once (its first place), with its
 * section's title as the reason.
 */
export function parseExplore(v: unknown, ctx: Ctx): ExploreItem[] {
  const pp = rec(v);
  if (!pp) throw new Error('Partiful did not give the explore page');
  const sections: Record<string, any>[] = [];
  const trending = rec(pp.trendingSection);
  if (trending) sections.push(trending);
  // /explore (no city): one trending carousel per region; the site's own order.
  for (const s of Object.values(rec(pp.trendingSections) ?? {})) if (rec(s)) sections.push(s as Record<string, any>);
  for (const s of Array.isArray(pp.sections) ? pp.sections : []) if (rec(s)) sections.push(s);
  const feed = Array.isArray(pp.feedItems) ? pp.feedItems : [];
  const seen = new Set<string>();
  const out: ExploreItem[] = [];
  const take = (item: unknown, reason?: string) => {
    const it = rec(item);
    if (!it || it.type !== 'event' || !rec(it.event)) {
      ctx.drops.add(`explore item ${String(it?.type ?? '?').slice(0, 20)}`);
      return;
    }
    const id = it.event.id;
    if (!isId(id) || seen.has(id)) return;
    const post = eventPost(it.event, ctx, { tags: [...(Array.isArray(it.tags) ? it.tags : []), ...(Array.isArray(it.descriptionTags) ? it.descriptionTags : [])] });
    if (!post) return;
    seen.add(id);
    out.push({ post, ...(reason ? { reason: { text: reason, kind: 'topic' as const } } : {}) });
  };
  for (const s of sections) {
    const title = str(s.title)?.slice(0, 120);
    for (const it of Array.isArray(s.items) ? s.items : []) take(it, title ?? undefined);
  }
  for (const it of feed) take(it);
  return out;
}

/** One page of a list read whole: cursor `o<offset>`; `more` is the next one, or null at the end. */
export function pageOf<T>(items: T[], cursor: string | undefined, size = EXPLORE_PAGE): { items: T[]; more: string | null } {
  const at = cursor === undefined ? 0 : /^o(\d{1,5})$/.test(cursor) ? Number(cursor.slice(1)) : -1;
  if (at < 0) throw new Error('not a Partiful explore cursor');
  const slice = items.slice(at, at + size);
  return { items: slice, more: at + size < items.length ? `o${at + size}` : null };
}

// ------------------------------------------------------------------ your events
/**
 * Your events (getMyUpcomingEventsForHomePage): upcoming, soonest first, then past, latest first. Each event carries
 * `guest`, your own guest row (only its status is read).
 */
export function parseMyEvents(v: unknown, ctx: Ctx): P.PostFact[] {
  const r = rec(v);
  if (!r) throw new Error('Partiful did not give your events');
  const one = (e: unknown) => {
    const ev = rec(e);
    if (!ev) return null;
    const status = str(rec(ev.guest)?.status);
    return eventPost(ev, ctx, { status });
  };
  const up = (Array.isArray(r.upcomingEvents) ? r.upcomingEvents : []).map(one).filter((x: P.PostFact | null): x is P.PostFact => !!x);
  const past = [...(Array.isArray(r.initialPastEvents) ? r.initialPastEvents : []), ...(Array.isArray(r.pastEvents) ? r.pastEvents : [])].map(one).filter((x: P.PostFact | null): x is P.PostFact => !!x);
  up.sort((a: P.PostFact, b: P.PostFact) => a.event!.start - b.event!.start);
  past.sort((a: P.PostFact, b: P.PostFact) => b.event!.start - a.event!.start);
  const seen = new Set<string>();
  return [...up, ...past].filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
}

/** An event you are in as its conversation: a group named after it, with its cover. */
export function eventConversation(k: PfEventKept): P.ConversationFact {
  return { nativeId: eventConv(k.id), shape: 'group', name: k.title, ...(k.image ? { avatarUrl: k.image } : {}) };
}

// ---------------------------------------------------------------- activity feed
function reactionsOf(map: unknown): P.ReactionFact[] {
  const out: P.ReactionFact[] = [];
  for (const [emoji, byUser] of Object.entries(rec(map) ?? {})) {
    const authors: string[] = [];
    const at: Record<string, number> = {};
    for (const [uid, x] of Object.entries(rec(byUser) ?? {})) {
      const r = rec(x);
      if (!r || r.active === false || !isId(uid)) continue;
      authors.push(uid);
      const t = pfTime(r.addedAt);
      if (t) at[uid] = t;
    }
    if (authors.length) out.push({ key: emoji, authors, ...(Object.keys(at).length ? { at } : {}) });
  }
  return out;
}

/** An event's album photo or video (getEventMedia), kept by id for the comments that show it. */
export function mediaItemOf(v: unknown, ctx: Ctx): { id: string; att: P.AttachmentFact; author: string | null; ts: number | null } | null {
  const m = rec(v);
  if (!m || !isId(m.id)) return null;
  const pic = photoOf(m.media ?? m.photo ?? m.image ?? m, ctx);
  if (!pic) return null;
  const video = /^video\//.test(pic.mime ?? '') || m.type === 'video';
  const att: P.AttachmentFact = { nativeId: m.id, kind: video ? 'video' : 'image', url: pic.url, ...(pic.mime ? { mime: pic.mime } : {}), ...(pic.width ? { width: pic.width } : {}), ...(pic.height ? { height: pic.height } : {}) };
  ctx.photos.set(m.id, att);
  const author = [m.userId, m.uploadedBy, rec(m.uploader)?.id, rec(m.user)?.id, rec(m.createdBy)?.id].find(isId) ?? null;
  if (rec(m.user)) userOf(m.user, ctx);
  return { id: m.id, att, author, ts: pfTime(m.createdAt) ?? pfTime(m.uploadedAt) };
}

/** A comment in an event's Activity feed as a message of the event's conversation (`c:<id>`). */
export function commentMessage(v: unknown, eventId: string, ctx: Ctx): P.MessageFact | null {
  const c = rec(v);
  if (!c || !isCommentId(c.id)) return null;
  const author = [c.userId, rec(c.user)?.id, rec(c.author)?.id].find(isId);
  const ts = pfTime(c.createdAt);
  if (!author || ts === null) {
    ctx.drops.add('comment without author or time');
    return null;
  }
  if (rec(c.user)) userOf(c.user, ctx);
  ctx.comments.set(c.id, eventId);
  const replyTo = [rec(c.replyTo)?.id, c.replyTo, c.replyToCommentId, c.parentCommentId].find(isCommentId);
  const atts = (Array.isArray(c.photoIds) ? c.photoIds : []).map((id: unknown) => (typeof id === 'string' ? ctx.photos.get(id) : undefined)).filter((x: P.AttachmentFact | undefined): x is P.AttachmentFact => !!x);
  const reactions = reactionsOf(c.reactionMap);
  const body = str(c.message) ?? '';
  return {
    nativeId: `c:${c.id}`,
    conversation: eventConv(eventId),
    author,
    ts,
    ...(pfTime(c.updatedAt) && pfTime(c.updatedAt)! > ts + 1000 ? { editedTs: pfTime(c.updatedAt)! } : {}),
    kind: !body && atts.length ? 'media' : 'text',
    body: body.slice(0, 10_000),
    ...(replyTo ? { replyTo: `c:${replyTo}` } : {}),
    ...(ctx.selfId && Array.isArray(c.mentions) && c.mentions.some((m: any) => (rec(m)?.id ?? rec(m)?.userId ?? m) === ctx.selfId) ? { mentionsSelf: true } : {}),
    ...(atts.length ? { attachments: atts } : {}),
    ...(reactions.length ? { reactions } : {}),
    extra: { event: eventId },
  };
}

/** A host's text blast or message shown on the event page (`h:<id>`), marked as a blast. */
export function hostMessage(v: unknown, eventId: string, ctx: Ctx): P.MessageFact | null {
  const m = rec(v);
  if (!m || !isCommentId(m.id)) return null;
  const ts = pfTime(m.createdAt) ?? pfTime(m.sentAt);
  const author = [m.userId, m.senderId, rec(m.sender)?.id, rec(m.createdBy)?.id, rec(m.user)?.id].find(isId) ?? ctx.events.get(eventId)?.owners[0];
  if (ts === null || !author) {
    ctx.drops.add('host message without author or time');
    return null;
  }
  if (rec(m.user)) userOf(m.user, ctx);
  const body = str(m.message) ?? str(m.text) ?? str(m.body) ?? '';
  const reactions = reactionsOf(m.reactionMap);
  return {
    nativeId: `h:${m.id}`,
    conversation: eventConv(eventId),
    author,
    ts,
    kind: 'text',
    body: body.slice(0, 10_000),
    ...(reactions.length ? { reactions } : {}),
    extra: { event: eventId, blast: true },
  };
}

/** An album post (a photo or video someone added) as a media message (`m:<id>`). */
export function albumMessage(item: NonNullable<ReturnType<typeof mediaItemOf>>, eventId: string): P.MessageFact | null {
  if (!item.author || item.ts === null) return null;
  return { nativeId: `m:${item.id}`, conversation: eventConv(eventId), author: item.author, ts: item.ts, kind: 'media', body: '', attachments: [item.att], extra: { event: eventId } };
}

/** A comment as a reply under its event, for the event's thread. */
export function commentPost(m: P.MessageFact, eventId: string): P.PostFact {
  return {
    id: `comment:${m.nativeId.slice(2)}`,
    url: eventUrl(eventId),
    ts: m.ts,
    author: m.author,
    text: m.body,
    replyTo: m.replyTo ? { id: `comment:${m.replyTo.slice(2)}` } : { id: eventId },
    root: eventId,
    ...(m.attachments?.length ? { media: m.attachments.filter((a) => a.kind === 'image' || a.kind === 'video').map((a) => ({ kind: a.kind as 'image' | 'video', url: a.url, ...(a.width ? { width: a.width } : {}), ...(a.height ? { height: a.height } : {}) })) } : {}),
    ...(m.reactions?.length ? { counts: { likes: m.reactions.reduce((n, r) => n + r.authors.length, 0) } } : {}),
  };
}

// ---------------------------------------------------------------- notifications
export interface FeedEntry {
  nativeId: string;
  actor: string;
  ts: number;
  body: string;
  url?: string;
}

/** getNotifications' page: one feed entry per notification, in Partiful's own words. */
export function parseNotifications(v: unknown, ctx: Ctx): { entries: FeedEntry[]; more: { startAfterMs: number; startId: string } | null } {
  const r = rec(v);
  const list = Array.isArray(r?.notifications) ? r!.notifications : [];
  const entries: FeedEntry[] = [];
  for (const n of list) {
    const x = rec(n);
    const ts = pfTime(x?.createdAt);
    if (!x || !isCommentId(x.id) || ts === null) {
      ctx.drops.add('notification without id or time');
      continue;
    }
    const actorUser = rec(x.actor) ?? rec(x.fromUser) ?? rec(x.user);
    const u = actorUser ? userOf(actorUser, ctx) : null;
    const actor = u?.id ?? [x.actorId, x.fromUserId, x.actorUserId].find(isId) ?? PARTIFUL_ACTOR;
    const words = [str(x.title), str(x.body) ?? str(x.message) ?? str(x.text) ?? str(x.subtitle)].filter(Boolean).join(': ');
    if (!words) {
      ctx.drops.add(`notification ${String(x.type ?? '?').slice(0, 30)} without words`);
      continue;
    }
    const eventId = [x.eventId, rec(x.event)?.id].find(isId);
    entries.push({ nativeId: `other:${x.id}:${actor === PARTIFUL_ACTOR ? '-' : actor}`, actor, ts, body: words.slice(0, 2000), ...(eventId ? { url: eventUrl(eventId) } : {}) });
  }
  const last = list.length ? rec(list[list.length - 1]) : null;
  const more = r?.reachedEndOfData === false && last && isCommentId(last.id) && pfTime(last.createdAt) ? { startAfterMs: pfTime(last.createdAt)!, startId: last.id } : null;
  return { entries, more };
}

export function feedMessage(e: FeedEntry): P.MessageFact {
  return { nativeId: e.nativeId, conversation: FEED_CONV, author: e.actor, ts: e.ts, kind: 'system', body: e.body, extra: { feed: { type: 'other', text: e.body, ...(e.url ? { url: e.url } : {}) } } };
}
export const feedConversation = (): P.ConversationFact => ({ nativeId: FEED_CONV, shape: 'channel', variant: 'feed', name: 'Notifications' });

// ------------------------------------------------------------------ Stream chat
/** A Stream user as a person: their Partiful id when Stream carries it, else `stream:<id>`. */
export function streamPerson(v: unknown, ctx: Ctx): string | null {
  const u = rec(v);
  if (!u || typeof u.id !== 'string' || !/^[\w@.-]{1,128}$/.test(u.id)) return null;
  // Stream's own user ids are not Partiful's (the app asks getOrCreateStreamUserId for one): only a Partiful id the
  // Stream user carries joins the two; otherwise the person is Stream's.
  const pid = [u.partifulUserId, u.partifulId, u.userId].find(isId) ?? null;
  const nativeId = pid ?? `stream:${u.id}`;
  const was = ctx.users.get(nativeId);
  const photo = mediaUrl(u.image, ctx.testOrigin);
  ctx.users.set(nativeId, { id: nativeId, name: str(u.name)?.slice(0, 200) ?? was?.name ?? null, photo: photo ?? was?.photo ?? null, bio: was?.bio ?? null, socials: was?.socials ?? {}, ...(was?.hosted !== undefined ? { hosted: was.hosted } : {}), ...(was?.attended !== undefined ? { attended: was.attended } : {}) });
  return nativeId;
}

const STREAM_EMOJI: Record<string, string> = { like: '👍', love: '❤️', haha: '😂', wow: '😮', sad: '😢', angry: '😠' };
/** A Stream reaction type as the emoji it shows. */
export const streamEmoji = (type: string) => STREAM_EMOJI[type] ?? type;
/** An emoji as the reaction type the app sends. */
export const streamType = (key: string) => Object.entries(STREAM_EMOJI).find(([, e]) => e === key)?.[0] ?? key;

/** One Stream message (`s:<id>`), in the chat's conversation. */
export function streamMessage(v: unknown, convId: string, ctx: Ctx): P.MessageFact | null {
  const m = rec(v);
  if (!m || typeof m.id !== 'string' || !/^[\w-]{1,128}$/.test(m.id)) return null;
  if (m.type === 'deleted' || m.deleted_at) return null;
  const author = streamPerson(m.user, ctx);
  const ts = pfTime(m.created_at);
  if (!author || ts === null) {
    ctx.drops.add('chat message without author or time');
    return null;
  }
  const atts: P.AttachmentFact[] = [];
  for (const a of Array.isArray(m.attachments) ? m.attachments : []) {
    const x = rec(a);
    const url = mediaUrl(x?.image_url, ctx.testOrigin) ?? mediaUrl(x?.asset_url, ctx.testOrigin) ?? mediaUrl(x?.thumb_url, ctx.testOrigin);
    if (!x || !url) continue;
    const kind: P.AttachmentKind = x.type === 'video' ? 'video' : x.type === 'audio' ? 'audio' : x.type === 'image' || x.image_url ? 'image' : 'file';
    atts.push({ kind, url, ...(str(x.mime_type) ? { mime: x.mime_type } : {}), ...(str(x.title) ? { name: x.title.slice(0, 200) } : {}), ...(num(x.original_width) ? { width: x.original_width } : {}), ...(num(x.original_height) ? { height: x.original_height } : {}) });
  }
  const byType = new Map<string, { authors: string[]; at: Record<string, number> }>();
  for (const r of Array.isArray(m.latest_reactions) ? m.latest_reactions : []) {
    const x = rec(r);
    if (!x || typeof x.type !== 'string') continue;
    const who = streamPerson(x.user ?? { id: x.user_id }, ctx);
    if (!who) continue;
    const key = streamEmoji(x.type);
    const e = byType.get(key) ?? { authors: [], at: {} };
    if (!e.authors.includes(who)) e.authors.push(who);
    const t = pfTime(x.created_at);
    if (t) e.at[who] = t;
    byType.set(key, e);
  }
  const reactions: P.ReactionFact[] = [...byType].map(([key, e]) => ({ key, authors: e.authors, ...(Object.keys(e.at).length ? { at: e.at } : {}) }));
  const body = str(m.text) ?? '';
  const edited = pfTime(m.message_text_updated_at);
  const reply = typeof m.quoted_message_id === 'string' ? m.quoted_message_id : typeof m.parent_id === 'string' ? m.parent_id : null;
  return {
    nativeId: `s:${m.id}`,
    conversation: convId,
    author,
    ts,
    ...(edited && edited > ts ? { editedTs: edited } : {}),
    kind: m.type === 'system' ? 'system' : !body && atts.length ? 'media' : 'text',
    body: body.slice(0, 10_000),
    ...(reply ? { replyTo: `s:${reply}` } : {}),
    ...(atts.length ? { attachments: atts } : {}),
    ...(reactions.length ? { reactions } : {}),
  };
}

/** A Stream channel (a Partiful chat) as a conversation: a direct chat with one other person, else a group. */
export function streamConversation(v: unknown, selfStream: string | null, ctx: Ctx): { conv: P.ConversationFact; messages: P.MessageFact[]; lastRead: number | null } | null {
  const r = rec(v);
  const ch = rec(r?.channel);
  if (!r || !ch || typeof ch.id !== 'string' || !/^[\w!-]{1,128}$/.test(ch.id)) return null;
  const nativeId = chatConv(ch.id);
  const members = (Array.isArray(r.members) ? r.members : []).map((m: any) => ({ sid: typeof m?.user?.id === 'string' ? m.user.id : m?.user_id, who: streamPerson(m?.user ?? { id: m?.user_id }, ctx) })).filter((m: any) => m.who);
  const others = members.filter((m: any) => m.sid !== selfStream);
  const direct = members.length === 2 && others.length === 1;
  const name = str(ch.name)?.slice(0, 200);
  const pic = mediaUrl(ch.image, ctx.testOrigin);
  const conv: P.ConversationFact = {
    nativeId,
    shape: direct ? 'direct' : 'group',
    ...(name && !direct ? { name } : {}),
    ...(pic ? { avatarUrl: pic } : {}),
    participants: members.map((m: any) => m.who),
    ...(pfTime(ch.last_message_at) ? { lastMessageAt: pfTime(ch.last_message_at)! } : {}),
  };
  const messages = (Array.isArray(r.messages) ? r.messages : []).map((m: unknown) => streamMessage(m, nativeId, ctx)).filter((m: P.MessageFact | null): m is P.MessageFact => !!m);
  const mine = (Array.isArray(r.read) ? r.read : []).find((x: any) => x?.user?.id === selfStream);
  return { conv, messages, lastRead: pfTime(mine?.last_read) };
}
