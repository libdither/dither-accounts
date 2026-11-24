/**
 * Invented Partiful answers, shaped by hand after the site's JSON (docs/partiful.md "The shapes it reads"): people,
 * events, the explore page's data, guest rows, comments, host messages, the photo album, notifications and Stream
 * chats. Nothing here came from a real account or a real event; the place slug `testville` is made up too.
 *
 * `pic(origin, name)` puts every picture under the fake's origin in the browser tests, or on a Firebase Storage
 * address with an invented bucket in the mapping tests.
 */
const H = 3600_000;
export const iso = (ms: number) => new Date(ms).toISOString();

export interface Person {
  id: string;
  name: string;
  bio: string | null;
  socials: Record<string, string>;
}
export const ME: Person = { id: 'meQuinn0001', name: 'Quinn Doe', bio: null, socials: {} };
export const ANN: Person = { id: 'annLee000001', name: 'Ann Lee', bio: 'Potlucks and rooftops.', socials: { instagram: 'ann.lee.example', twitter: 'annlee_example', website: 'ann.example.com' } };
export const BEN: Person = { id: 'benOrtiz0001', name: 'Ben Ortiz', bio: null, socials: { tiktok: 'benortiz.example' } };
export const CAL: Person = { id: 'calPark00001', name: 'Cal Park', bio: null, socials: {} };
/** A Stream user id for the account itself, inside the fake chat token. */
export const ME_STREAM = 'strmQuinn01';

export const pic = (origin: string | null, name: string) => (origin ? `${origin}/__fake/media/${name}.png` : `https://firebasestorage.googleapis.com/v0/b/example-bucket.appspot.com/o/profileImages%2F${name}?alt=media`);

/** A person as getUsers, event hosts and guest rows carry them (`{ visibility, value }` for the bio and socials). */
export function user(p: Person, origin: string | null, o: { stats?: boolean } = {}) {
  return {
    id: p.id,
    name: p.name,
    photo: { source: 'upload', type: 'image', upload: { path: `profileImages/${p.id}`, url: pic(origin, p.id), width: 400, height: 400, contentType: 'image/png' }, url: pic(origin, p.id), width: 400, height: 400, blurHash: 'LKO2?U%2Tw=w' },
    ...(p.bio ? { bio: { visibility: 'MUTUALS', value: p.bio } } : {}),
    socials: Object.fromEntries(Object.entries(p.socials).map(([k, v]) => [k, { visibility: 'MUTUALS', value: v }])),
    isManaged: false,
    onPartiful: true,
    ...(o.stats ? { hostedCount: 4, attendedCount: 9 } : {}),
  };
}

export interface EventSpec {
  id: string;
  title: string;
  owners: Person[];
  start: number;
  showGuestList: boolean;
  showGuestCount?: boolean;
  going?: number;
  description?: string;
}

/** An event as getEventInfo and the event page carry it. */
export function event(e: EventSpec, origin: string | null) {
  return {
    id: e.id,
    title: e.title,
    description: e.description ?? `${e.title}: bring a friend.`,
    timezone: 'America/Chicago',
    startDate: iso(e.start),
    endDate: iso(e.start + 3 * H),
    publishedAt: iso(e.start - 72 * H),
    createdAt: iso(e.start - 80 * H),
    showHostList: true,
    showGuestCount: e.showGuestCount ?? true,
    showGuestList: e.showGuestList,
    showActivityTimestamps: true,
    visibility: 'public',
    isPublic: true,
    status: 'PUBLISHED',
    ownerIds: e.owners.map((p) => p.id),
    image: { source: 'upload', type: 'image', url: pic(origin, `cover-${e.id}`), width: 1080, height: 1080, contentType: 'image/png', blurHash: 'eEQvdo', displaySettings: { theme: 'oxblood' } },
    locationInfo: {
      type: 'structured',
      mapsInfo: { name: 'ACME Hall', addressLines: ['1 Example St', 'Testville'], approximateLocation: 'Testville', googleMapsUrl: 'https://www.google.com/maps/search/?api=1&query=ACME%20Hall' },
      displayAddressLines: ['1 Example St', 'Testville'],
      neighborhood: 'Old Town',
    },
    goingGuestCount: e.going ?? 3,
    maybeGuestCount: 1,
    interestedGuestCount: 2,
    guestStatusCounts: { GOING: e.going ?? 3, MAYBE: 1, INTERESTED: 2, DECLINED: 0 },
    calendarFile: `https://storage.googleapis.com/download/storage/v1/b/example-bucket.appspot.com/o/public%2Fevents%2F${e.id}%2Fevent.ics?alt=media`,
    displaySettings: { theme: 'oxblood', effect: 'none' },
  };
}

/** One explore card: the slimmer event the explore page carries, without the list settings. */
export function exploreItem(e: EventSpec, origin: string | null, tags: string[] = []) {
  const full = event(e, origin);
  const { showGuestList: _a, showHostList: _b, description, ...rest } = full;
  return { id: `event-${e.id}`, type: 'event', descriptionTags: null, event: { ...rest, description }, tags: tags.map((t) => ({ name: t })) };
}

export function world(now: number, origin: string | null = null) {
  const open: EventSpec = { id: 'evOpenParty01', title: 'Rooftop Potluck', owners: [ANN], start: now + 48 * H, showGuestList: true, going: 3 };
  const hidden: EventSpec = { id: 'evHiddenPty1', title: 'Quiet Supper', owners: [BEN], start: now + 72 * H, showGuestList: false, going: 12 };
  const mine: EventSpec = { id: 'evMyParty001', title: 'Board Games Night', owners: [ME], start: now + 24 * H, showGuestList: true, going: 5 };
  const past: EventSpec = { id: 'evPastParty1', title: 'Summer Picnic', owners: [CAL], start: now - 30 * 24 * H, showGuestList: true, going: 20 };
  const extra = (i: number): EventSpec => ({ id: `evFeed${String(i).padStart(6, '0')}`, title: `Open Mic ${i}`, owners: [CAL], start: now + (100 + i) * H, showGuestList: true });

  const explore = {
    hostname: 'partiful.com',
    region: 'TESTVILLE',
    trendingSection: { id: 'testville-trending', title: 'Trending in Testville', subtitle: 'Open to all', presentationStyle: 'carousel-small', items: [exploreItem(open, origin, ['Food']), exploreItem(hidden, origin)], curatorInfo: null },
    sections: [
      { id: 'testville-meet', title: 'Make some friends', presentationStyle: 'carousel-medium', items: [exploreItem(open, origin), exploreItem(extra(1), origin)], curatorInfo: null },
      { id: 'testville-curated', title: 'Curated by Dee', presentationStyle: 'carousel-medium', items: [exploreItem(extra(2), origin), { id: 'collection-x', type: 'collection', title: 'A collection' }], curatorInfo: { name: 'Dee', socials: { instagram: 'dee.example' } } },
    ],
    feedItems: Array.from({ length: 22 }, (_, i) => exploreItem(extra(i + 3), origin)),
    activeCategoryFacets: ['FALL'],
  };

  // Guest rows as getGuests sends them. The open list's rows carry RSVP notes too; the hidden list's rows come with
  // the names blanked but the notes and times still there (what the hard rule is about).
  const guestRow = (p: Person | null, status: string, note: string) => ({
    id: p?.id ?? 'blankRow0001',
    status,
    count: 1,
    plusOnes: [],
    rsvpDate: iso(now - 5 * H),
    plusOneCount: 0,
    user: p ? user(p, origin) : null,
    name: p?.name ?? '',
    rsvpHistory: [{ status, count: 1, date: iso(now - 5 * H), id: '1700000001', message: note, reactions: [] }],
  });
  const guests: Record<string, any[]> = {
    [open.id]: [guestRow(BEN, 'GOING', 'SECRET-NOTE-OPEN'), guestRow(CAL, 'MAYBE', 'see you'), guestRow(null, 'GOING', 'nameless'), guestRow(ME, 'DECLINED', 'cannot')],
    [hidden.id]: [guestRow(null, 'GOING', 'SECRET-NOTE-HIDDEN'), { ...guestRow(null, 'GOING', 'SECRET-NOTE-HIDDEN-2'), id: 'blankRow0002' }],
    [mine.id]: [guestRow(ANN, 'GOING', 'yay')],
  };

  const comments: Record<string, any[]> = {
    [open.id]: [
      { id: 'cmt-0001', eventId: open.id, userId: BEN.id, message: 'See you there!', timezone: 'America/Chicago', createdAt: iso(now - 4 * H), reactionMap: { '✨': { [ANN.id]: { active: true, addedAt: iso(now - 3 * H), emoji: '✨', user: { id: ANN.id, path: `users/${ANN.id}` } }, [CAL.id]: { active: false, emoji: '✨' } } }, photoIds: [] },
      { id: 'cmt-0002', eventId: open.id, userId: ANN.id, message: 'Bring snacks', createdAt: iso(now - 2 * H), replyTo: { id: 'cmt-0001' }, photoIds: [] },
      { id: 'cmt-0003', eventId: open.id, userId: CAL.id, message: '', createdAt: iso(now - 1 * H), photoIds: ['phAlbum0001'] },
    ],
  };
  const hostMessages: Record<string, any[]> = {
    [open.id]: [{ id: 'hm-0001', userId: ANN.id, message: 'Doors at 7, roof access by the stairs.', createdAt: iso(now - 6 * H), reactionMap: {} }],
  };
  const album: Record<string, any[]> = {
    [open.id]: [
      { id: 'phAlbum0001', userId: CAL.id, createdAt: iso(now - 1 * H), type: 'image', url: pic(origin, 'album-1'), width: 800, height: 600, contentType: 'image/png' },
      { id: 'phAlbum0002', userId: BEN.id, createdAt: iso(now - 30 * 60_000), type: 'image', url: pic(origin, 'album-2'), width: 800, height: 600, contentType: 'image/png' },
    ],
  };

  /** getMyUpcomingEventsForHomePage: events with the account's own guest row. */
  const myEvents = {
    upcomingEvents: [
      { ...event(open, origin), guest: { status: 'GOING', id: ME.id } },
      { ...event(mine, origin), guest: null },
      { ...event(hidden, origin), guest: { status: 'SENT', id: ME.id } },
    ],
    initialPastEvents: [{ ...event(past, origin), guest: { status: 'GOING', id: ME.id } }],
    eventCategoryCounts: { upcoming: 3, invites: 1, hosting: 1, attended: 1, all_past_events: 1 },
  };

  const notifications = [
    { id: 'ntf-0002', createdAt: iso(now - 2 * 60_000), type: 'COMMENT', title: 'Rooftop Potluck', body: 'Ann Lee replied: Bring snacks', eventId: open.id, actor: { id: ANN.id, name: ANN.name } },
    { id: 'ntf-0001', createdAt: iso(now - 26 * H), type: 'REMINDER', title: 'Board Games Night is tomorrow', eventId: mine.id },
  ];

  const streamUser = (p: Person, o: { partiful?: boolean } = {}) => ({ id: `strm-${p.id}`, name: p.name, image: pic(origin, `strm-${p.id}`), ...(o.partiful ? { partifulUserId: p.id } : {}) });
  const meStream = { id: ME_STREAM, name: ME.name };
  const chats = [
    {
      channel: { id: 'dmAnnQuinn01', cid: 'messaging:dmAnnQuinn01', type: 'messaging', last_message_at: iso(now - 10 * 60_000), member_count: 2 },
      members: [{ user_id: `strm-${ANN.id}`, user: streamUser(ANN, { partiful: true }) }, { user_id: ME_STREAM, user: meStream }],
      messages: [
        { id: 'smsg-0001', text: 'Hi! Coming Saturday?', type: 'regular', user: streamUser(ANN, { partiful: true }), created_at: iso(now - 20 * 60_000), latest_reactions: [{ type: 'love', user_id: ME_STREAM, user: meStream, created_at: iso(now - 15 * 60_000) }] },
        { id: 'smsg-0002', text: 'Yes!', type: 'regular', user: meStream, created_at: iso(now - 10 * 60_000), latest_reactions: [] },
      ],
      read: [{ user: meStream, last_read: iso(now - 10 * 60_000), unread_messages: 0 }],
    },
    {
      channel: { id: 'grpPotluck01', cid: 'messaging:grpPotluck01', type: 'messaging', name: 'Potluck crew', last_message_at: iso(now - 3 * H), member_count: 3 },
      members: [{ user: streamUser(BEN) }, { user: streamUser(CAL) }, { user: meStream }],
      messages: [{ id: 'smsg-0101', text: 'Who brings plates?', type: 'regular', user: streamUser(BEN), created_at: iso(now - 3 * H), attachments: [{ type: 'image', image_url: pic(origin, 'plates'), original_width: 300, original_height: 200 }] }],
      read: [],
    },
  ];

  return { now, open, hidden, mine, past, extra, explore, guests, comments, hostMessages, album, myEvents, notifications, chats };
}
export type World = ReturnType<typeof world>;

/** A chat token as getStreamUserToken gives one: a JWT whose payload names the Stream user. Not signed by anyone. */
export const streamToken = (user = ME_STREAM) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ user_id: user })).toString('base64url')}.fake-signature`;
