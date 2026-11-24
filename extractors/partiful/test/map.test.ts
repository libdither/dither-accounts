import { expect, test } from 'bun:test';
import * as M from '../src/map.ts';
import { compute, type Facts } from '../src/status.ts';
import { ANN, BEN, CAL, ME, ME_STREAM, user, world } from './fixtures.ts';

const NOW = Date.parse('2030-05-01T12:00:00Z');
const w = world(NOW);
const fresh = (self: string | null = ME.id) => {
  const ctx = M.newCtx();
  ctx.selfId = self;
  return ctx;
};

test('explore: trending, then each section, then the feed; every event once, with its section as the reason', () => {
  const ctx = fresh(null);
  const items = M.parseExplore(w.explore, ctx);
  expect(items.slice(0, 4).map((i) => [i.post.id, i.reason?.text])).toEqual([
    [w.open.id, 'Trending in Testville'],
    [w.hidden.id, 'Trending in Testville'],
    ['evFeed000001', 'Make some friends'],
    ['evFeed000002', 'Curated by Dee'],
  ]);
  expect(items[0]!.reason).toEqual({ text: 'Trending in Testville', kind: 'topic' });
  // 4 from the carousels (the open party once) and 22 from the feed; the collection card is no event.
  expect(items.length).toBe(26);
  expect(items.at(-1)!.reason).toBeUndefined();
  expect(ctx.drops.summary()).toBe('explore item collection 1');
  // Signed out: no RSVP said, and no conversation; a card shows a count, never names.
  expect(items[0]!.post.event).toMatchObject({ guestsShown: 'count', going: 3, hosts: [ANN.id], tags: ['Food'] });
  expect(items[0]!.post.event!.rsvp).toBeUndefined();
  expect(items[0]!.post.event!.guests).toBeUndefined();
  expect(items[0]!.post.event!.conversation).toBeUndefined();
});

test('explore paging: 20 a page by offset cursors, the last page with no more', () => {
  const items = M.parseExplore(w.explore, fresh());
  const one = M.pageOf(items, undefined);
  expect([one.items.length, one.more]).toEqual([20, 'o20']);
  const two = M.pageOf(items, one.more!);
  expect([two.items.length, two.more]).toEqual([6, null]);
  expect(two.items[0]!.post.id).toBe(items[20]!.post.id);
  expect(() => M.pageOf(items, 'nope')).toThrow('not a Partiful explore cursor');
  expect(M.citySlug(' Testville ')).toBe('testville');
  expect(M.citySlug('../etc')).toBeNull();
});

test('/explore without a city: each region’s trending carousel', () => {
  const items = M.parseExplore({ trendingSections: { TESTVILLE: w.explore.trendingSection } }, fresh());
  expect(items.map((i) => i.post.id)).toEqual([w.open.id, w.hidden.id]);
});

test('an event as a PostFact: when, where, hosts, the count, the cover, the .ics, and your RSVP and conversation', () => {
  const ctx = fresh();
  const ev = M.parseMyEvents(w.myEvents, ctx);
  // Upcoming soonest first, then past.
  expect(ev.map((p) => p.id)).toEqual([w.mine.id, w.open.id, w.hidden.id, w.past.id]);
  const open = ev[1]!;
  expect(open).toMatchObject({
    id: w.open.id,
    url: `https://partiful.com/e/${w.open.id}`,
    title: 'Rooftop Potluck',
    text: 'Rooftop Potluck: bring a friend.',
    author: ANN.id,
    ts: w.open.start - 72 * 3600_000,
    media: [{ kind: 'image', width: 1080, height: 1080 }],
  });
  expect(open.event).toEqual({
    start: w.open.start,
    end: w.open.start + 3 * 3600_000,
    timeZone: 'America/Chicago',
    place: { name: 'ACME Hall', address: '1 Example St, Testville', city: 'Testville', url: 'https://www.google.com/maps/search/?api=1&query=ACME%20Hall' },
    hosts: [ANN.id],
    going: 3,
    guestsShown: 'all',
    rsvp: 'going',
    conversation: `event:${w.open.id}`,
    ics: `https://storage.googleapis.com/download/storage/v1/b/example-bucket.appspot.com/o/public%2Fevents%2F${w.open.id}%2Fevent.ics?alt=media`,
  });
  expect(ev[0]!.event).toMatchObject({ hosting: true, rsvp: null, conversation: `event:${w.mine.id}` });
  // Invited to the hidden-list party: in it, with only a count.
  expect(ev[2]!.event).toMatchObject({ rsvp: 'invited', guestsShown: 'count', going: 12, conversation: `event:${w.hidden.id}` });
  expect(M.eventConversation(ctx.events.get(w.open.id)!)).toEqual({ nativeId: `event:${w.open.id}`, shape: 'group', name: 'Rooftop Potluck', avatarUrl: expect.stringContaining('cover-evOpenParty01') });
});

test('guests: the names the site shows, in its order, never a blank row; mutuals added', () => {
  const ctx = fresh();
  const ev = M.parseMyEvents(w.myEvents, ctx);
  const open = w.myEvents.upcomingEvents[0]!;
  const ids = M.guestsOf(open, [w.guests[w.open.id]], ctx);
  // Ben going and Cal maybe; the nameless row and a decline are nobody the list shows.
  expect(ids).toEqual([BEN.id, CAL.id]);
  expect(ctx.users.get(BEN.id)).toMatchObject({ name: 'Ben Ortiz', socials: { tiktok: 'benortiz.example' } });
  const post = M.eventPost(open, ctx, { guests: ids, allGuests: true });
  expect(post!.event).toMatchObject({ guests: [BEN.id, CAL.id], guestsShown: 'all' });
  expect(M.eventPost(open, ctx, { guests: ids, allGuests: false })!.event!.guestsShown).toBe('sample');
  expect(M.mutualsOf(open, { totalCount: 1, guests: [{ user: user(ANN, null) }] }, ctx)).toEqual([ANN.id]);
  void ev;
});

test('the hidden-list rule: no guest rows read, kept or sent, whatever getGuests holds', () => {
  const ctx = fresh();
  const hidden = { ...w.myEvents.upcomingEvents[2]! };
  expect(hidden.showGuestList).toBe(false);
  // A page that throws on any read: guestsOf must not look at it at all.
  const touched: string[] = [];
  const trap = new Proxy(
    {},
    {
      get(_t, k) {
        touched.push(String(k));
        throw new Error('a hidden list was read');
      },
    },
  );
  expect(M.guestsOf(hidden, [trap, w.guests[w.hidden.id]], ctx)).toEqual([]);
  expect(M.mutualsOf(hidden, trap, ctx)).toEqual([]);
  expect(touched).toEqual([]);
  // Even handed guests, a hidden-list event sends none, and says only the count.
  const post = M.eventPost(hidden, ctx, { guests: [BEN.id] })!;
  expect(post.event!.guests).toBeUndefined();
  expect(post.event!.guestsShown).toBe('count');
  expect(JSON.stringify(post)).not.toContain('SECRET');
  // A list whose setting is missing counts as hidden; a count the host hid too is 'hidden'.
  const { showGuestList: _gone, ...unsaid } = hidden;
  expect(M.guestsOf(unsaid, [w.guests[w.open.id]], ctx)).toEqual([]);
  expect(M.eventPost({ ...hidden, showGuestCount: false }, ctx)!.event).toMatchObject({ guestsShown: 'hidden' });
  expect(M.eventPost({ ...hidden, showGuestCount: false }, ctx)!.event!.going).toBeUndefined();
  // Nothing about any guest's RSVP note reached the context either.
  expect(JSON.stringify([...ctx.users.values()])).not.toContain('SECRET');
});

test('people: identity by Partiful id, the profile with socials as links the same-person engine reads', () => {
  const ctx = fresh();
  const u = M.userOf(user(ANN, null, { stats: true }), ctx)!;
  expect(M.identityFact(u, ME.id)).toEqual({ nativeId: ANN.id, displayName: 'Ann Lee', avatarUrl: `https://firebasestorage.googleapis.com/v0/b/example-bucket.appspot.com/o/profileImages%2F${ANN.id}?alt=media` });
  expect(M.personAbout(u)).toEqual({
    displayName: 'Ann Lee',
    avatar: expect.stringContaining(ANN.id),
    bio: 'Potlucks and rooftops.',
    links: [
      { label: 'Partiful', value: 'Ann Lee', url: `https://partiful.com/u/${ANN.id}` },
      { label: 'Instagram', value: '@ann.lee.example', url: 'https://instagram.com/ann.lee.example' },
      { label: 'X', value: '@annlee_example', url: 'https://x.com/annlee_example' },
      { label: 'Website', value: 'ann.example.com', url: 'https://ann.example.com' },
    ],
    facts: [
      { label: 'Hosted', value: '4' },
      { label: 'Attended', value: '9' },
    ],
  });
  // A picture from anywhere else is not kept.
  expect(M.userOf({ id: CAL.id, name: 'Cal', photo: { url: 'https://evil.example/x.png' } }, fresh())!.photo).toBeNull();
});

test('the Activity feed: comments with replies, reactions and album photos; host blasts; album posts', () => {
  const ctx = fresh();
  const items = w.album[w.open.id]!.map((x) => M.mediaItemOf(x, ctx)!);
  const cs = w.comments[w.open.id]!.map((c) => M.commentMessage(c, w.open.id, ctx)!);
  expect(cs[0]).toMatchObject({ nativeId: 'c:cmt-0001', conversation: `event:${w.open.id}`, author: BEN.id, kind: 'text', body: 'See you there!', reactions: [{ key: '✨', authors: [ANN.id], at: { [ANN.id]: NOW - 3 * 3600_000 } }], extra: { event: w.open.id } });
  expect(cs[1]).toMatchObject({ nativeId: 'c:cmt-0002', replyTo: 'c:cmt-0001', author: ANN.id });
  expect(cs[2]).toMatchObject({ kind: 'media', body: '', attachments: [{ nativeId: 'phAlbum0001', kind: 'image', width: 800 }] });
  const h = M.hostMessage(w.hostMessages[w.open.id]![0], w.open.id, ctx)!;
  expect(h).toMatchObject({ nativeId: 'h:hm-0001', author: ANN.id, kind: 'text', body: 'Doors at 7, roof access by the stairs.', extra: { event: w.open.id, blast: true } });
  expect(M.albumMessage(items[1]!, w.open.id)).toMatchObject({ nativeId: 'm:phAlbum0002', author: BEN.id, kind: 'media', attachments: [{ kind: 'image' }] });
  // In the event's thread a comment is a reply under the event, or under the comment it answers.
  expect(M.commentPost(cs[0]!, w.open.id)).toMatchObject({ id: 'comment:cmt-0001', replyTo: { id: w.open.id }, root: w.open.id, counts: { likes: 1 } });
  expect(M.commentPost(cs[1]!, w.open.id).replyTo).toEqual({ id: 'comment:cmt-0001' });
});

test('notifications: one read-only feed message each, in Partiful’s words, by whoever it names', () => {
  const ctx = fresh();
  const pg = M.parseNotifications({ notifications: w.notifications, reachedEndOfData: false }, ctx);
  expect(pg.entries.map((e) => [e.nativeId, e.actor, e.body])).toEqual([
    [`other:ntf-0002:${ANN.id}`, ANN.id, 'Rooftop Potluck: Ann Lee replied: Bring snacks'],
    ['other:ntf-0001:-', 'partiful', 'Board Games Night is tomorrow'],
  ]);
  expect(pg.more).toEqual({ startAfterMs: NOW - 26 * 3600_000, startId: 'ntf-0001' });
  expect(M.feedMessage(pg.entries[0]!)).toMatchObject({ conversation: 'feed', kind: 'system', extra: { feed: { type: 'other', url: `https://partiful.com/e/${w.open.id}` } } });
  expect(M.feedConversation()).toEqual({ nativeId: 'feed', shape: 'channel', variant: 'feed', name: 'Notifications' });
});

test('chats (Stream): a direct chat and a group, people by Partiful id where Stream carries it, reactions as emoji', () => {
  const ctx = fresh();
  const dm = M.streamConversation(w.chats[0], ME_STREAM, ctx)!;
  expect(dm.conv).toEqual({ nativeId: 'chat:dmAnnQuinn01', shape: 'direct', participants: [ANN.id, `stream:${ME_STREAM}`], lastMessageAt: NOW - 10 * 60_000 });
  expect(dm.messages.map((m) => [m.nativeId, m.author, m.body])).toEqual([
    ['s:smsg-0001', ANN.id, 'Hi! Coming Saturday?'],
    ['s:smsg-0002', `stream:${ME_STREAM}`, 'Yes!'],
  ]);
  expect(dm.messages[0]!.reactions).toEqual([{ key: '❤️', authors: [`stream:${ME_STREAM}`], at: { [`stream:${ME_STREAM}`]: NOW - 15 * 60_000 } }]);
  expect(dm.lastRead).toBe(NOW - 10 * 60_000);
  const grp = M.streamConversation(w.chats[1], ME_STREAM, ctx)!;
  expect(grp.conv).toMatchObject({ nativeId: 'chat:grpPotluck01', shape: 'group', name: 'Potluck crew', participants: [`stream:strm-${BEN.id}`, `stream:strm-${CAL.id}`, `stream:${ME_STREAM}`] });
  expect(grp.messages[0]).toMatchObject({ kind: 'text', attachments: [{ kind: 'image', width: 300, height: 200 }] });
  expect([M.streamType('❤️'), M.streamType('🎉'), M.streamEmoji('haha')]).toEqual(['love', '🎉', '😂']);
});

test('RSVP statuses both ways', () => {
  expect(['GOING', 'MAYBE', 'INTERESTED', 'WAITLIST', 'PENDING_APPROVAL', 'DECLINED', 'SENT', 'APPROVED', 'nonsense'].map(M.rsvpOf)).toEqual(['going', 'maybe', 'interested', 'waitlist', 'pending', 'declined', 'invited', 'going', null]);
  expect(M.RSVP_STATUS).toEqual({ going: 'GOING', maybe: 'MAYBE', declined: 'DECLINED', interested: 'INTERESTED' });
});

test('status: signed out asks for a sign-in and says Explore works; a check for people is yours to clear', () => {
  const base: Facts = {
    now: NOW,
    sandbox: { started: true, error: null, browserAlive: true, display: 7, liveView: true, startedAt: NOW - 1000 },
    extensionAttached: true,
    tab: 'https://partiful.com/explore',
    page: { state: 'login', path: '/explore', since: NOW },
    self: null,
    hookVersion: 1,
    blocked: null,
    feed: { items: 0, lastFetch: null, lastError: null, nextAt: null, dropped: null },
    lastCommand: null,
  };
  const out = compute(base);
  expect(out.status).toBe('attention');
  expect(out.attention).toEqual({ kind: 'login', message: 'Sign in to Partiful in the live view (Explore works meanwhile)', liveView: true });
  const on = compute({ ...base, page: { state: 'ready', path: '/explore', since: NOW }, self: { id: ME.id } });
  expect([on.status, on.attention]).toEqual(['online', null]);
  expect(on.layers.map((l) => l.name)).toEqual(['display', 'browser', 'extension', 'signed in', 'notifications']);
  const check = compute({ ...base, page: { state: 'ready', path: '/explore', since: NOW }, blocked: { kind: 'check', at: NOW } });
  expect(check.attention).toMatchObject({ kind: 'captcha', liveView: true });
  const slow = compute({ ...base, page: { state: 'ready', path: '/explore', since: NOW }, blocked: { kind: 'slow', at: NOW, until: NOW + 60_000 } });
  expect([slow.status, slow.attention?.kind]).toEqual(['attention', 'rate_limited']);
});
