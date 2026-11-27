/**
 * Luma's answers into dither-chat's facts (src/map.ts), on invented answers (fixtures.ts): events as PostFacts with
 * `event`, the hard rule on hidden guest lists, people and their socials, notifications, blasts and chats.
 */
import { describe, expect, test } from 'bun:test';
import { guestsNamed, withoutHiddenGuests } from '@dither-chat/protocol';
import * as M from '../src/map.ts';
import { Backoff, failureKind, RATE_FIRST_MS } from '../src/pace.ts';
import { compute, type Facts } from '../src/status.ts';
import { Tracker } from '../src/tracker.ts';
import { ANN, BEN, blasts, CAL, CHAT_DM, CHAT_EVENT, chatMessages, conversations, DEE, entry, eventPage, ME, notifications, PLACE, SECRET, world } from './fixtures.ts';

const NOW = Date.parse('2030-05-01T12:00:00Z');
const w = world(NOW);

describe('an event as a PostFact', () => {
  test('a public listing entry: when, where, hosts first, who is going as shown, price, the page', () => {
    const ctx = M.newCtx();
    const got = M.eventPost(w.open, ctx)!;
    expect(got.post).toEqual({
      id: 'evt-Open000000000001',
      url: 'https://luma.com/supper-roof',
      ts: NOW + 2 * 86_400_000,
      author: ANN.api_id,
      text: '',
      title: 'Supper on the Roof',
      media: [{ kind: 'image', url: 'https://images.lumacdn.com/event-covers/zz/evt-Open000000000001.png' }],
      place: { id: 'cal-AcmeSupper0001', name: 'ACME Supper Club', url: 'https://luma.com/acme-supper' },
      event: {
        start: NOW + 2 * 86_400_000,
        end: NOW + 2 * 86_400_000 + 3 * 3600_000,
        timeZone: 'Etc/UTC',
        place: { name: 'ACME Hall', address: 'ACME Hall, 1 Example Street, Exampletown', city: 'Exampletown, EX', lat: 10.5, lng: 20.25, url: 'https://www.google.com/maps/search/?api=1&query=10.5,20.25' },
        hosts: [ANN.api_id],
        going: 2,
        guests: [BEN.api_id, CAL.api_id],
        guestsShown: 'all',
        price: 'Free',
        rsvp: null,
      },
    });
    expect([...ctx.users.keys()]).toEqual([ANN.api_id, BEN.api_id, CAL.api_id]);
    expect(got.known).toMatchObject({ inIt: false, showGuests: true });
  });

  test('a sample of a long list, a paid event, an address hidden until you RSVP: the city alone', () => {
    const got = M.eventPost(w.paid, M.newCtx())!.post.event!;
    expect(got).toMatchObject({ hosts: [ANN.api_id, CAL.api_id], going: 30, guests: [DEE.api_id], guestsShown: 'sample', price: '$20', place: { city: 'Exampletown, EX' } });
    expect(got.place).toEqual({ city: 'Exampletown, EX' });
  });

  test('online: no place', () => {
    const e = M.eventPost(w.online, M.newCtx())!.post.event!;
    expect(e.online).toBe(true);
    expect(e.place).toBeUndefined();
  });

  test("the event's page: its description as text, its categories, and the account's own RSVP with its conversation", () => {
    const got = M.eventPost(eventPage(w.mine, { description: 'Line one.\nLine two.' }), M.newCtx())!;
    expect(got.post.text).toBe('Line one.\nLine two.');
    expect(got.post.event).toMatchObject({ rsvp: 'going', conversation: 'event:evt-Mine00000000001', tags: ['Food & Drink'] });
    expect(got.known).toMatchObject({ inIt: true, rsvp: 'going', oneClick: null, ticketType: { id: 'ttype-Mine00000000001', cents: 0 } });
  });

  test('a signed-in guest is shown the whole list: the guests are those, and all of them', () => {
    const ctx = M.newCtx();
    const list = M.guestListPage({ entries: [BEN, CAL, DEE].map((u) => ({ api_id: `gst-${u.api_id.slice(4)}`, user: u })), has_more: false, next_cursor: null }, ctx);
    expect(list).toEqual({ ids: [BEN.api_id, CAL.api_id, DEE.api_id], more: null });
    const e = M.eventPost(eventPage(w.mine), ctx, { guestList: { ids: list.ids, complete: true } })!.post.event!;
    expect(e).toMatchObject({ guests: [BEN.api_id, CAL.api_id, DEE.api_id], guestsShown: 'all', going: 3 });
  });

  test('why one click will not do: paid tickets, questions', () => {
    expect(M.eventPost(eventPage(w.paid, { free: false }), M.newCtx())!.known.oneClick).toBe('it has paid tickets');
    expect(M.eventPost(eventPage(w.open, { questions: true }), M.newCtx())!.known.oneClick).toBe('it asks questions when you register');
    expect(M.eventPost(w.open, M.newCtx())!.known.oneClick).toBe('Luma did not give its tickets');
  });

  test('prices as the card words them', () => {
    expect(M.priceOf({ is_free: true })).toBe('Free');
    expect(M.priceOf({ is_sold_out: true, is_free: true })).toBe('Sold out');
    expect(M.priceOf({ is_free: false, price: { cents: 1050, currency: 'eur' } })).toBe('€10.50');
    expect(M.priceOf({ is_free: false, price: { cents: 1000, currency: 'usd' }, max_price: { cents: 4000 } })).toBe('$10–$40');
    expect(M.priceOf({ is_free: false, price: { cents: 1000, currency: 'usd', is_flexible: true, min_cents: 500 } })).toBe('From $5');
  });

  test('an entry without an id or a start is dropped and counted', () => {
    const ctx = M.newCtx();
    expect(M.eventPost({ event: { name: 'x' } }, ctx)).toBeNull();
    expect(M.eventPost({ event: { api_id: 'evt-NoStart0000001' } }, ctx)).toBeNull();
    expect(ctx.drops.summary()).toContain('event without');
  });
});

describe('a hidden guest list (the hard rule)', () => {
  test('no guest rows at all, no count: guestsShown hidden; only the hosts are people', () => {
    const ctx = M.newCtx();
    const e = M.eventPost(w.hidden, ctx)!.post.event!;
    expect(e.guestsShown).toBe('hidden');
    expect(e.guests).toBeUndefined();
    expect(e.going).toBeUndefined();
    expect([...ctx.users.keys()]).toEqual([BEN.api_id]);
  });

  test('even were Luma to send guests for a hidden list, none is read, kept or named', () => {
    const leaky = { ...w.hidden, guest_count: 5, featured_guests: [SECRET, DEE] };
    const ctx = M.newCtx();
    const got = M.eventPost(leaky, ctx)!;
    expect(got.post.event!.guests).toBeUndefined();
    expect(got.post.event!.going).toBeUndefined();
    expect(got.post.event!.guestsShown).toBe('hidden');
    expect(ctx.users.has(SECRET.api_id)).toBe(false);
    expect(JSON.stringify(got.post)).not.toContain('Secret');
    // A guest list handed in for a hidden list (never asked for one) is not used either.
    const e = M.eventPost(eventPage(w.mineHidden), ctx, { guestList: { ids: [SECRET.api_id], complete: true } })!.post.event!;
    expect(e.guests).toBeUndefined();
    expect(e.guestsShown).toBe('hidden');
  });
  test("every event post already passes the hub's second line of defence unchanged (withoutHiddenGuests)", () => {
    const ctx = M.newCtx();
    for (const raw of Object.values(w)) {
      const post = M.eventPost(eventPage(raw), ctx)!.post;
      expect(withoutHiddenGuests(post)).toBe(post);
      if (guestsNamed(post.event!)) expect(raw.event.show_guest_list).toBe(true);
    }
  });
});

describe('people', () => {
  test('identity facts keyed by usr- id, never a picture address', () => {
    const ctx = M.newCtx();
    const u = M.userOf(ANN, ctx)!;
    expect(M.identityFact(u, null)).toEqual({ nativeId: ANN.api_id, handle: 'annlee', displayName: 'Ann Lee', avatarUrl: ANN.avatar_url });
    expect(M.identityFact(M.userOf(ME, ctx)!, ME.api_id).isSelf).toBe(true);
    expect(M.userOf({ api_id: 'https://images.lumacdn.com/x.png', name: 'x' }, ctx)).toBeNull();
  });

  test('a profile: bio, and socials as links the same-person engine reads', () => {
    const about = M.personAbout(M.userOf(ANN, M.newCtx())!);
    expect(about).toMatchObject({ displayName: 'Ann Lee', handle: 'annlee', bio: 'Runs ACME Supper Club' });
    expect(about.links).toEqual([
      { label: 'Luma', value: '@annlee', url: 'https://luma.com/user/annlee' },
      { label: 'X', value: '@annlee_example', url: 'https://x.com/annlee_example' },
      { label: 'Instagram', value: '@ann.lee.example', url: 'https://www.instagram.com/ann.lee.example' },
      { label: 'LinkedIn', value: 'ann-lee-example', url: 'https://www.linkedin.com/in/ann-lee-example' },
      { label: 'Website', value: 'ann.example.com', url: 'https://ann.example.com/' },
    ]);
    const ben = M.socialLinks(M.userOf(BEN, M.newCtx())!);
    expect(ben).toContainEqual({ label: 'TikTok', value: '@benortiz_example', url: 'https://www.tiktok.com/@benortiz_example' });
    expect(ben).toContainEqual({ label: 'YouTube', value: '@benortiz-example', url: 'https://www.youtube.com/@benortiz-example' });
    expect(ben[0]).toEqual({ label: 'Luma', value: 'Ben Ortiz', url: `https://luma.com/user/${BEN.api_id}` });
  });
});

describe('explore', () => {
  test('a page of the listing, with its cursor only while there is more', () => {
    const ctx = M.newCtx();
    const pg = M.eventsPage({ entries: [w.open, w.hidden], has_more: true, next_cursor: 'eyJ4IjoxfQ==' }, ctx);
    expect(pg.posts.map((p) => p.post.id)).toEqual(['evt-Open000000000001', 'evt-Hidden0000000001']);
    expect(pg.more).toBe('eyJ4IjoxfQ==');
    expect(M.eventsPage({ entries: [], has_more: false, next_cursor: 'x' }, ctx).more).toBeNull();
  });

  test("a city's place by its page, Luma's own pick, and a city as the owner writes it", () => {
    expect(M.placeOfUrl({ kind: 'discover-place', data: { place: PLACE, events: [] } })).toEqual({ id: PLACE.api_id, slug: 'exampletown', name: 'Exampletown', featured: ['evt-Open000000000001'] });
    expect(M.placeOfUrl({ kind: 'calendar', data: {} })).toBeNull();
    expect(M.placeOfBootstrap({ featured_place: { place: PLACE }, places: [] })?.id).toBe(PLACE.api_id);
    expect(M.citySlug('Exampletown')).toBe('exampletown');
    expect(M.citySlug(' New Example City ')).toBe('new-example-city');
    expect(M.citySlug('São Exemplo')).toBe('sao-exemplo');
    expect(M.citySlug('')).toBeNull();
  });
});

describe('conversations', () => {
  test('notifications: one read-only message each, by who it names, in plain words', () => {
    const ctx = M.newCtx();
    const pg = M.parseNotifications(notifications(NOW), ctx);
    expect(pg.entries.map((e) => [e.nativeId, e.actor, e.title, e.event])).toEqual([
      [`other:notif-Example00001:${ANN.api_id}`, ANN.api_id, 'Ann Lee invited you to Garden Picnic', 'evt-Mine00000000001'],
      ['other:notif-Example00002:-', 'luma', 'Your registration for Spring Walk was approved', 'evt-Past00000000001'],
    ]);
    expect(M.feedMessage(pg.entries[0]!)).toEqual({
      nativeId: `other:notif-Example00001:${ANN.api_id}`,
      conversation: 'feed',
      author: ANN.api_id,
      ts: NOW - 5 * 60_000,
      kind: 'system',
      body: 'Ann Lee invited you to Garden Picnic\nSee you there!',
      extra: { feed: { type: 'other', text: 'Ann Lee invited you to Garden Picnic', url: 'https://luma.com/event/evt-Mine00000000001' }, event: 'evt-Mine00000000001' },
    });
    expect(M.feedConversation()).toMatchObject({ nativeId: 'feed', variant: 'feed' });
  });

  test("an event's conversation: a group named for it; its host's blasts as messages marked blast", () => {
    const got = M.eventPost(w.mine, M.newCtx())!;
    expect(M.eventConversation(got.post.id, got.known, got.post.event!.hosts)).toEqual({ nativeId: 'event:evt-Mine00000000001', shape: 'group', name: 'Garden Picnic', avatarUrl: 'https://images.lumacdn.com/event-covers/zz/evt-Mine00000000001.png', participants: [ANN.api_id] });
    expect(M.blastMessages(blasts(NOW), 'evt-Mine00000000001', null, M.newCtx())).toEqual([
      { nativeId: 'blast:blast-Example0001', conversation: 'event:evt-Mine00000000001', author: ANN.api_id, ts: NOW - 3 * 3600_000, kind: 'text', body: 'Bring a blanket: the grass is damp.', extra: { blast: true, event: 'evt-Mine00000000001' } },
    ]);
  });

  test("chats: a direct chat named for the other person, an event's chat joined to its event, support chats left out", () => {
    const ctx = M.newCtx();
    const got = conversations(NOW)
      .entries.map((c) => M.chatConversation(c, ME.api_id, ctx))
      .filter((x) => !!x);
    expect(got.map((c) => c!.fact)).toEqual([
      { nativeId: CHAT_DM, shape: 'direct', name: 'Ben Ortiz', avatarUrl: BEN.avatar_url, participants: [BEN.api_id, ME.api_id], lastMessageAt: NOW - 10 * 60_000 },
      { nativeId: CHAT_EVENT, shape: 'group', name: 'Garden Picnic', avatarUrl: 'https://images.lumacdn.com/event-covers/zz/evt-Mine00000000001.png', lastMessageAt: NOW - 20 * 60_000 },
    ]);
    expect(got[1]!.conv.event).toBe('evt-Mine00000000001');
  });

  test('chat messages: words, reactions with when, the event of an event chat; a deleted one is a delete', () => {
    const ctx = M.newCtx();
    const of = (c: string) => (c === CHAT_EVENT ? 'evt-Mine00000000001' : null);
    const [a, b, gone] = chatMessages(NOW).entries.map((m) => M.chatMessage(m, ME.api_id, ctx, of));
    expect(a).toEqual({ nativeId: 'chatmsg-BenHello0001', conversation: CHAT_DM, author: BEN.api_id, ts: NOW - 10 * 60_000, kind: 'text', body: 'Are you coming Saturday?', reactions: [{ key: '👍', authors: [ME.api_id], at: { [ME.api_id]: NOW - 9 * 60_000 } }] });
    expect(b).toMatchObject({ conversation: CHAT_EVENT, author: ANN.api_id, extra: { event: 'evt-Mine00000000001' } });
    expect(gone).toEqual({ deleted: { conversation: CHAT_DM, nativeId: 'chatmsg-Gone00000001' } });
  });
});

describe('the tracker', () => {
  test('people and conversations once until they change; only new recent messages are live', () => {
    const t = new Tracker();
    const ctx = M.newCtx();
    M.userOf(ANN, ctx);
    expect(t.identities(ctx.users.values(), null)).toHaveLength(1);
    expect(t.identities(ctx.users.values(), null)).toHaveLength(0);
    const conv = M.feedConversation();
    expect(t.conversation(conv)).toHaveLength(1);
    expect(t.conversation(conv)).toHaveLength(0);
    const entries = M.parseNotifications(notifications(NOW), ctx).entries;
    const first = t.feed(entries, { now: NOW, backfill: true });
    expect(first.filter((e) => e.t === 'message').every((e) => (e as any).live === false)).toBe(true);
    const fresh = { ...entries[0]!, nativeId: 'other:notif-Example00009:-', ts: NOW + 1000 };
    const next = t.feed([fresh, entries[0]!], { now: NOW + 2000, backfill: false });
    expect(next.map((e) => [(e as any).message.nativeId, (e as any).live])).toEqual([
      [entries[0]!.nativeId, false],
      ['other:notif-Example00009:-', true],
    ]);
    expect(JSON.stringify(t.kept())).not.toContain('Ann Lee');
  });
});

describe('pace and status', () => {
  test('a 429 holds reads back, doubling; a check holds them and asks for the live view; a success clears it', () => {
    const b = new Backoff();
    expect(failureKind('Luma answered 429: slow down')).toBe('429');
    expect(failureKind('Luma answered 403: a Cloudflare check (challenge)')).toBe('challenge');
    expect(failureKind('Luma answered 404')).toBeNull();
    expect(b.failed('Luma answered 429', 0)).toBe('429');
    expect(b.until).toBe(RATE_FIRST_MS);
    b.failed('Luma answered 429', 0);
    expect(b.until).toBe(2 * RATE_FIRST_MS);
    b.ok();
    expect(b.holding(0)).toBe(false);
    b.failed('a Cloudflare check (challenge)', 0);
    expect(b.state()?.why).toBe('challenge');
  });

  const base = (o: Partial<Facts> = {}): Facts => ({
    now: 100_000,
    sandbox: { started: true, error: null, browserAlive: true, display: 99, liveView: true, startedAt: 1 },
    extensionAttached: true,
    tab: 'https://luma.com/home',
    page: { state: 'ready', path: '/home', since: 1 },
    self: { id: ME.api_id, username: 'quinnpark' },
    hookVersion: 1,
    backoff: null,
    feed: { items: 0, lastFetch: null, lastError: null, nextAt: null, dropped: null },
    chats: { conversations: 0, messages: 0, lastFetch: null, lastError: null },
    city: null,
    lastCommand: null,
    ...o,
  });
  test('signed in: online as @username; signed out: a sign-in attention that says Explore still works', () => {
    const on = compute(base());
    expect(on.status).toBe('online');
    expect(on.layers.find((l) => l.name === 'signed in')?.note).toBe('as @quinnpark');
    const out = compute(base({ page: { state: 'login', path: '/signin', since: 1 }, self: null }));
    expect(out.status).toBe('attention');
    expect(out.attention).toEqual({ kind: 'login', message: 'Sign in to Luma in the live view (Explore works meanwhile)', liveView: true });
  });
  test('a Cloudflare check is the owner’s to clear in the live view, never solved here', () => {
    for (const f of [base({ page: { state: 'challenge', path: '/home', since: 1 } }), base({ backoff: { until: 200_000, why: 'challenge' } })]) {
      const c = compute(f);
      expect(c.status).toBe('attention');
      expect(c.attention).toMatchObject({ kind: 'captcha', liveView: true });
    }
    expect(compute(base({ backoff: { until: 200_000, why: '429' } })).layers.find((l) => l.name === 'pace')?.state).toBe('waiting');
  });
});

test('an entry built for the fixtures is the shape the map reads (a guard on the fixtures themselves)', () => {
  const e = entry({ id: 'evt-Guard000000001', name: 'x', start: NOW, hosts: [ANN], showGuests: false });
  expect(e.featured_guests).toEqual([]);
  expect(e.guest_count).toBe(0);
});
