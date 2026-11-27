/**
 * An invented Luma: people, a city, events and chats shaped by hand after api.luma.com's answers (docs/luma.md "The
 * shapes it reads"). Every name, id, handle, picture and place here is made up; nothing was copied from a live answer.
 * Shared by test/map.test.ts and the fake site (test/fake-luma.ts at the repo's root).
 */

const PIC = (who: string) => `https://images.lumacdn.com/avatars/zz/${who}.png`;
export interface User {
  api_id: string;
  name: string;
  first_name: string;
  last_name: string;
  username: string | null;
  avatar_url: string;
  bio_short: string;
  twitter_handle: string | null;
  instagram_handle: string | null;
  linkedin_handle: string | null;
  tiktok_handle: string | null;
  youtube_handle: string | null;
  website: string | null;
  timezone: string;
  is_verified: boolean;
}
const user = (id: string, first: string, last: string, o: Partial<User> = {}): User => ({
  api_id: id,
  name: `${first} ${last}`,
  first_name: first,
  last_name: last,
  username: null,
  avatar_url: PIC(id),
  bio_short: '',
  twitter_handle: null,
  instagram_handle: null,
  linkedin_handle: null,
  tiktok_handle: null,
  youtube_handle: null,
  website: null,
  timezone: 'Etc/UTC',
  is_verified: false,
  ...o,
});

export const ME = user('usr-Quinn0000000001', 'Quinn', 'Park', { username: 'quinnpark' });
export const ANN = user('usr-AnnLee00000001', 'Ann', 'Lee', { username: 'annlee', bio_short: 'Runs ACME Supper Club', twitter_handle: 'annlee_example', instagram_handle: 'ann.lee.example', linkedin_handle: '/in/ann-lee-example', website: 'https://ann.example.com' });
export const BEN = user('usr-BenOrtiz000001', 'Ben', 'Ortiz', { tiktok_handle: 'benortiz_example', youtube_handle: '@benortiz-example' });
export const CAL = user('usr-CalMoss0000001', 'Cal', 'Moss');
export const DEE = user('usr-DeeNash0000001', 'Dee', 'Nash');
/** Someone a hidden list would have named, were it not hidden. Never to be seen in a fact. */
export const SECRET = user('usr-Secret00000001', 'Sol', 'Secret');

export const PLACE = {
  api_id: 'discplace-Exampletown0001',
  slug: 'exampletown',
  name: 'Exampletown',
  timezone: 'Etc/UTC',
  event_count: 3,
  featured_event_api_ids: ['evt-Open000000000001'],
  coordinate: { latitude: 10.5, longitude: 20.25 },
};
export const OTHER_PLACE = { ...PLACE, api_id: 'discplace-Othertown00002', slug: 'othertown', name: 'Othertown', featured_event_api_ids: [] };

const CAL_ACME = { api_id: 'cal-AcmeSupper0001', name: 'ACME Supper Club', slug: 'acme-supper', is_personal: false, avatar_url: 'https://images.lumacdn.com/calendars/zz/acme.png' };

const iso = (ms: number) => new Date(ms).toISOString();
const DAY = 86_400_000;

export interface EntryOpts {
  id: string;
  name: string;
  start: number;
  hosts: User[];
  guests?: User[];
  count?: number;
  showGuests: boolean;
  address?: 'shown' | 'obfuscated' | 'online';
  free?: boolean;
  mine?: 'approved' | 'pending_approval' | 'declined' | 'invited' | null;
  hosting?: boolean;
  url?: string;
}
/** A listing entry (discover, home): the event and what the listing says around it. */
export function entry(o: EntryOpts) {
  const shown = o.address === 'shown';
  return {
    api_id: o.id,
    event: {
      api_id: o.id,
      calendar_api_id: CAL_ACME.api_id,
      cover_url: `https://images.lumacdn.com/event-covers/zz/${o.id}.png`,
      end_at: iso(o.start + 3 * 3600_000),
      event_type: 'independent',
      hide_rsvp: false,
      location_type: o.address === 'online' ? 'online' : 'offline',
      name: o.name,
      show_guest_list: o.showGuests,
      start_at: iso(o.start),
      timezone: 'Etc/UTC',
      url: o.url ?? o.id.slice(4, 12).toLowerCase(),
      user_api_id: o.hosts[0]!.api_id,
      visibility: 'public',
      virtual_info: { has_access: false },
      geo_address_info:
        o.address === 'online'
          ? null
          : shown
            ? { mode: 'shown', address: 'ACME Hall', full_address: 'ACME Hall, 1 Example Street, Exampletown', short_address: '1 Example Street', city: 'Exampletown', city_state: 'Exampletown, EX', country: 'Exampleland' }
            : { mode: 'obfuscated', city: 'Exampletown', city_state: 'Exampletown, EX', country: 'Exampleland' },
      geo_address_visibility: shown ? 'public' : 'guests-only',
      coordinate: o.address === 'online' ? null : { latitude: 10.5, longitude: 20.25 },
    },
    calendar: CAL_ACME,
    start_at: iso(o.start),
    hosts: o.hosts,
    guest_count: o.showGuests ? (o.count ?? o.guests?.length ?? 0) : 0,
    ticket_count: o.showGuests ? (o.count ?? 0) : 0,
    ticket_info: o.free === false ? { price: { cents: 2000, currency: 'usd', is_flexible: false }, is_free: false, max_price: null, is_sold_out: false, spots_remaining: 10, require_approval: false } : { price: null, is_free: true, max_price: null, is_sold_out: false, spots_remaining: 40, require_approval: false },
    registration_availability: 'open',
    featured_guests: o.showGuests ? (o.guests ?? []) : [],
    manager_info: null,
    guest_info: o.mine ? { approval_status: o.mine } : null,
    host_info: o.hosting ? { access_level: 'manager' } : null,
    waitlist_active: false,
    featured_city: { api_id: PLACE.api_id, slug: PLACE.slug, name: PLACE.name },
  };
}

/** `/event/get`'s whole answer for an entry: the page's own keys around it. */
export function eventPage(e: ReturnType<typeof entry>, o: { description?: string; free?: boolean; questions?: boolean } = {}) {
  const mine = e.guest_info?.approval_status ?? null;
  return {
    ...e,
    description_mirror: {
      type: 'doc',
      content: (o.description ?? 'Come along.\nBring a friend.').split('\n').map((t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })),
    },
    guest_data: { email: null, name: null, ticket_key: mine === 'approved' ? 'tk-example' : null, approval_status: mine, proxy_key: mine === 'approved' ? 'px-example' : null, event_tickets: [] },
    ticket_types: [{ api_id: `ttype-${e.api_id.slice(4)}`, cents: o.free === false ? 2000 : null, currency: o.free === false ? 'usd' : null, is_hidden: false, require_approval: false }],
    registration_questions: o.questions ? [{ id: 'q1', label: 'Why are you coming?', question_type: 'text', required: true }] : [],
    phone_number_requirement: null,
    eth_address_requirement: null,
    solana_address_requirement: null,
    categories: [{ api_id: 'cat-food', name: 'Food & Drink' }],
    event_invite: null,
    sold_out: false,
  };
}

export function world(now: number) {
  const open = entry({ id: 'evt-Open000000000001', name: 'Supper on the Roof', start: now + 2 * DAY, hosts: [ANN], guests: [BEN, CAL], count: 2, showGuests: true, address: 'shown', url: 'supper-roof' });
  const hidden = entry({ id: 'evt-Hidden0000000001', name: 'Quiet Reading Night', start: now + 3 * DAY, hosts: [BEN], showGuests: false, address: 'obfuscated' });
  const paid = entry({ id: 'evt-Paid00000000001', name: 'Tasting Menu', start: now + 4 * DAY, hosts: [ANN, CAL], guests: [DEE], count: 30, showGuests: true, address: 'obfuscated', free: false });
  const online = entry({ id: 'evt-Online000000001', name: 'Online Book Club', start: now + 5 * DAY, hosts: [CAL], showGuests: true, guests: [], count: 0, address: 'online' });
  /** One you are going to: its full guest list (Ben, Cal, Dee) is what the site shows you. */
  const mine = entry({ id: 'evt-Mine00000000001', name: 'Garden Picnic', start: now + 1 * DAY, hosts: [ANN], guests: [BEN], count: 3, showGuests: true, address: 'shown', mine: 'approved' });
  /** One you are going to whose host hides the guest list. */
  const mineHidden = entry({ id: 'evt-MineHidden00001', name: 'Board Games', start: now + 6 * DAY, hosts: [BEN], showGuests: false, address: 'shown', mine: 'approved' });
  /** One you went to. */
  const past = entry({ id: 'evt-Past00000000001', name: 'Spring Walk', start: now - 30 * DAY, hosts: [CAL], guests: [ANN], count: 1, showGuests: true, address: 'shown', mine: 'approved' });
  return { open, hidden, paid, online, mine, mineHidden, past };
}
export type World = ReturnType<typeof world>;

export const notifications = (now: number) => ({
  entries: [
    { api_id: 'notif-Example00001', notification: { title: '**Ann Lee** invited you to **Garden Picnic**', preview: 'See you there!', original_action_at: iso(now - 5 * 60_000), seen_at: null, primary_image: 'user', secondary_image: 'event' }, related_users: [ANN], event: { api_id: 'evt-Mine00000000001', name: 'Garden Picnic', cover_url: null }, calendar: null },
    { api_id: 'notif-Example00002', notification: { title: 'Your registration for **Spring Walk** was approved', preview: null, original_action_at: iso(now - 2 * DAY), seen_at: iso(now - DAY), primary_image: 'event', secondary_image: null }, related_users: [], event: { api_id: 'evt-Past00000000001' }, calendar: null },
  ],
  has_more: false,
  next_cursor: null,
});

export const blasts = (now: number) => ({
  blasts: [{ api_id: 'blast-Example0001', sent_at: iso(now - 3 * 3600_000), subject: 'Bring a blanket', content_text: 'Bring a blanket: the grass is damp.', user: ANN }],
});

export const CHAT_DM = 'chconv-DmWithBen001';
export const CHAT_EVENT = 'chconv-EventChat001';
export const conversations = (now: number) => ({
  entries: [
    { api_id: CHAT_DM, type: 'direct', name: null, avatar_url: null, event_api_id: null, other_participant: { user_api_id: BEN.api_id, user: BEN, last_read_at: null }, my_participant: { last_read_at: iso(now - DAY), mute_until: null }, last_message: { sent_at: iso(now - 10 * 60_000) } },
    { api_id: CHAT_EVENT, type: 'group', name: 'Garden Picnic', avatar_url: 'https://images.lumacdn.com/event-covers/zz/evt-Mine00000000001.png', event_api_id: 'evt-Mine00000000001', my_participant: { last_read_at: null, mute_until: null }, last_message: { sent_at: iso(now - 20 * 60_000) } },
    { api_id: 'chsupp-Example0001', type: 'support', name: 'Help' },
  ],
  has_more: false,
  next_cursor: 'convsync-1',
});
export const chatMessages = (now: number) => ({
  entries: [
    { api_id: 'chatmsg-BenHello0001', chat_conversation_api_id: CHAT_DM, user_api_id: BEN.api_id, author: BEN, sent_at: iso(now - 10 * 60_000), message_type: 'text', message: 'Are you coming Saturday?', replying_to_message_api_id: null, reactions: [{ reaction_type: '👍', user_api_id: ME.api_id, created_at: iso(now - 9 * 60_000), removed_at: null }], media: null, mentions: [] },
    { api_id: 'chatmsg-AnnPicnic001', chat_conversation_api_id: CHAT_EVENT, user_api_id: ANN.api_id, author: ANN, sent_at: iso(now - 20 * 60_000), message_type: 'text', message: 'Welcome to the picnic chat', replying_to_message_api_id: null, reactions: [], media: null, mentions: [] },
    { api_id: 'chatmsg-Gone00000001', chat_conversation_api_id: CHAT_DM, user_api_id: BEN.api_id, sent_at: iso(now - 30 * 60_000), deleted_at: iso(now - 25 * 60_000), message_type: 'text', message: null, reactions: [] },
  ],
  has_more: false,
  next_cursor: 'msgsync-1',
});
