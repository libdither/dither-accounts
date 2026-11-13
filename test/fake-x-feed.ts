/**
 * The fake x.com's signed-in client around the chat (test/fake-x.ts uses it): x.com's "responsive-web" as far as the
 * x extractor's feed hooks reach it, and the GraphQL server behind it, with made-up people.
 *
 *   - Scripts: the webpack runtime and main chunk (`/responsive-web/client-web/…`, classic scripts in the page's head),
 *     and the Notifications tab's lazy chunks, loaded only by the route's loader (`req.e`): extractors/x/test/fake-page
 *     rw-*.js.
 *   - GraphQL (`/i/api/graphql/<queryId>/<operation>`): NotificationsTimeline (newest first, four entries a page, Top and
 *     Bottom cursors: Top gives what is newer, Bottom what is older), UserTweets and UserByRestId, in X's shapes
 *     (extractors/x/test/feed-fixtures.ts).
 *   - `POST /i/api/2/notifications/all/last_seen_cursor.json`: marking notifications seen, recorded so a test can say
 *     it never happened.
 *
 * Every request is recorded in the fake's `calls` (`{ op: 'graphql', name, variables }`, `{ op: 'chunk', name }`,
 * `{ op: 'notifications.seen' }`).
 */
import { join } from 'node:path';
import { CARA, cursorEntry, DEV, EMI, FINN, ME, notificationEntry, notificationsResponse, notificationsTimeline, type Person, tweet, tweetEntry, userByRestIdResponse, userNew, userOld, userTweetsResponse, userTweetsTimeline, withVisibility } from '../extractors/x/test/feed-fixtures.ts';

export { CARA, DEV, EMI, FINN };
const PAGE = join(import.meta.dir, '../extractors/x/test/fake-page');
export const RW = '/responsive-web/client-web';
export const RW_SCRIPTS = [`${RW}/runtime.f4ke0000c0ffee00a.js`, `${RW}/main.f4ke0792c0ffee01a.js`];

export interface FeedCall {
  op: string;
  name?: string;
  variables?: Record<string, unknown>;
}
interface Note {
  ts: number;
  entry: any;
}
export interface FeedFake {
  /** Your posts the notifications are about. */
  posts: { first: any; long: any };
  notes: Note[];
  /** A new like of your first post, by `who`, now (as X's servers would add it). */
  like(who: Person): void;
  /** Answers what is the feed's, or null. */
  route(req: Request, url: URL, calls: FeedCall[]): Promise<Response | null>;
}

const MIN = 60_000;
const H = 3600_000;
const DAY = 24 * H;
const PER_PAGE = 4;
const enc = (s: string) => Buffer.from(s).toString('base64');
const dec = (s: string) => {
  try {
    return Buffer.from(s, 'base64').toString();
  } catch {
    return '';
  }
};

export async function startFeedFake(self: Person = ME): Promise<FeedFake> {
  const now = Date.now();
  const first = tweet({ id: '1856000000000000001', by: self, text: 'tomatoes are finally red', ts: now - 30 * H, counts: { likes: 3, reposts: 1, replies: 1 } });
  const long = tweet({ id: '1856000000000000002', by: self, text: '', note: `A long one about soil. ${'compost '.repeat(60)}that is all`, ts: now - 50 * H });
  const notes: Note[] = [];
  const add = (ts: number, entry: any) => notes.push({ ts, entry });
  add(now - 5 * MIN, notificationEntry({ id: 'AAAAAgF1', icon: 'heart_icon', ts: now - 5 * MIN, text: `${CARA.name} and 2 others liked your post`, from: [userNew(CARA), userOld(DEV), userNew(EMI)], targets: [first], url: `https://x.com/${self.handle}/status/${first.rest_id}` }));
  add(now - 20 * MIN, tweetEntry(withVisibility(tweet({ id: '1856000000000000101', by: CARA, text: 'love this & want some', ts: now - 20 * MIN, replyTo: { id: first.rest_id, by: self } })), 'user_replied_to_your_tweet', now - 20 * MIN));
  add(now - 50 * MIN, tweetEntry(tweet({ id: '1856000000000000102', by: EMI, text: `hey @${self.handle} look https://t.co/gArd3n`, ts: now - 50 * MIN, urls: [{ url: 'https://t.co/gArd3n', expanded: 'https://emi.example/garden', display: 'emi.example/garden' }] }), 'user_mentioned_you', now - 50 * MIN));
  add(now - 2 * H, tweetEntry(tweet({ id: '1856000000000000103', by: FINN, layout: 'old', text: 'this, exactly', ts: now - 2 * H, quote: long }), 'user_quoted_your_tweet', now - 2 * H));
  add(now - 3 * H, notificationEntry({ id: 'AAAAAgF2', icon: 'retweet_icon', ts: now - 3 * H, text: `${FINN.name} reposted your post`, from: [userOld(FINN)], targets: [first], element: 'users_retweeted_your_tweet' }));
  add(now - 4 * H, notificationEntry({ id: 'AAAAAgF3', icon: 'person_icon', ts: now - 4 * H, text: `${DEV.name} followed you`, from: [userOld(DEV)], element: 'follow_from_recommended_user' }));
  add(now - 5 * H, notificationEntry({ id: 'AAAAAgF4', icon: 'milestone_icon', ts: now - 5 * H, text: 'Your post was seen 1,000 times', from: [], targets: [first], element: 'generic_milestone' }));
  add(now - 2 * DAY, notificationEntry({ id: 'AAAAAgF5', icon: 'heart_icon', ts: now - 2 * DAY, text: `${FINN.name} liked your post`, from: [userOld(FINN)], targets: [long] }));
  // A third page: never read (two pages at most on a fresh account).
  add(now - 8 * DAY, notificationEntry({ id: 'AAAAAgF6', icon: 'person_icon', ts: now - 8 * DAY, text: `${EMI.name} followed you`, from: [userNew(EMI)] }));
  add(now - 9 * DAY, notificationEntry({ id: 'AAAAAgF7', icon: 'heart_icon', ts: now - 9 * DAY, text: `${EMI.name} liked your post`, from: [userNew(EMI)], targets: [long] }));

  // Profiles: Cara's has a pinned post, a picture, a repost and a quote; everyone else one post.
  const people = new Map([CARA, DEV, EMI, FINN].map((p) => [p.id, p]));
  const caraPinned = tweet({ id: '1856000000000000500', by: CARA, text: 'Pinned: my garden diary https://t.co/d1ary', ts: now - 100 * DAY, urls: [{ url: 'https://t.co/d1ary', expanded: 'https://cara.example/diary', display: 'cara.example/diary' }] });
  const profilePosts = (p: Person) =>
    p.id === CARA.id
      ? [
          tweet({ id: '1856000000000000503', by: CARA, text: '', ts: now - H, repost: tweet({ id: '1856000000000000499', by: DEV, layout: 'old', text: 'worth it', ts: now - 3 * H }) }),
          withVisibility(tweet({ id: '1856000000000000502', by: CARA, text: 'quoting a friend', ts: now - 2 * H, quote: first })),
          tweet({ id: '1856000000000000501', by: CARA, text: 'first ripe one', ts: now - 6 * H, media: [{ url: 'https://t.co/ph0t0', type: 'photo', img: 'https://pbs.twimg.com/media/Fk7Tomato.jpg', w: 1200, h: 900, alt: 'a red tomato' }], counts: { likes: 12, views: 340 } }),
          caraPinned,
        ]
      : [tweet({ id: `18560000000000006${p.id.slice(-2)}`, by: p, layout: p.id === DEV.id || p.id === FINN.id ? 'old' : 'new', text: `hello from ${p.handle}`, ts: now - 7 * H })];

  const sorted = () => [...notes].sort((a, b) => b.ts - a.ts);
  function timeline(cursor: string | undefined) {
    const all = sorted();
    const c = cursor ? dec(cursor) : '';
    let list: Note[];
    if (c.startsWith('top:')) list = all.filter((n) => n.ts > Number(c.slice(4)));
    else if (c.startsWith('bottom:')) list = all.filter((n) => n.ts < Number(c.slice(7))).slice(0, PER_PAGE);
    else list = all.slice(0, PER_PAGE);
    const newest = c.startsWith('top:') ? Math.max(Number(c.slice(4)), ...list.map((n) => n.ts)) : (list[0]?.ts ?? all[0]?.ts ?? now);
    const oldest = list.at(-1)?.ts ?? Number(c.slice(7)) ?? now;
    return notificationsTimeline([cursorEntry('Top', enc(`top:${newest}`), newest + 1), ...list.map((n) => n.entry), ...(c.startsWith('top:') ? [] : [cursorEntry('Bottom', enc(`bottom:${oldest}`), oldest - 1)])]);
  }

  const files = new Map<string, () => Promise<string>>();
  const read = (f: string) => () => Bun.file(join(PAGE, f)).text();
  const chunk = (n: string) => async () => {
    const all = await Bun.file(join(PAGE, 'rw-notifications.js')).text();
    const part = all.split(/^\/\/@chunk /m).find((p) => p.startsWith(`${n}\n`));
    return part ? part.slice(part.indexOf('\n') + 1) : '';
  };
  files.set(RW_SCRIPTS[0]!, read('rw-runtime.js'));
  files.set(RW_SCRIPTS[1]!, read('rw-main.js'));
  files.set(`${RW}/bundle.Notifications.f4ke9001c0ffee12a.js`, chunk('9001'));
  files.set(`${RW}/shared~bundle.Notifications~bundle.NotificationDetail.f4ke9002c0ffee34a.js`, chunk('9002'));

  const json = (v: unknown, status = 200) => Response.json(v, { status });
  return {
    posts: { first, long },
    notes,
    like(who) {
      const ts = Date.now();
      add(ts, notificationEntry({ id: `AAAAAgG${ts.toString(36)}`, icon: 'heart_icon', ts, text: `${who.name} liked your post`, from: [who.id === DEV.id || who.id === FINN.id ? userOld(who) : userNew(who)], targets: [first] }));
    },
    async route(req, url, calls) {
      const p = decodeURIComponent(url.pathname);
      const file = files.get(p);
      if (file) {
        calls.push({ op: 'chunk', name: p.slice(RW.length + 1).replace(/\.f4ke\w+a\.js$/, '') });
        return new Response(await file(), { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' } });
      }
      if (p === '/i/api/2/notifications/all/last_seen_cursor.json') {
        calls.push({ op: 'notifications.seen' });
        return json({ cursor: 'seen' });
      }
      const m = /^\/i\/api\/graphql\/([\w-]+)\/(\w+)$/.exec(p);
      if (!m) return null;
      if (!/(?:^|;\s*)auth_token=fake-session/.test(req.headers.get('cookie') ?? '')) return json({ errors: [{ message: 'Could not authenticate you', code: 32 }] }, 401);
      let variables: Record<string, any> = {};
      try {
        variables = JSON.parse(url.searchParams.get('variables') ?? '{}');
      } catch {}
      calls.push({ op: 'graphql', name: m[2], variables });
      switch (m[2]) {
        case 'NotificationsTimeline':
          if (variables.timeline_type !== 'All') return json({ errors: [{ message: 'only All here' }] }, 400);
          return json(notificationsResponse(timeline(variables.cursor), self));
        case 'UserByRestId': {
          const who = people.get(String(variables.userId));
          return json(who ? userByRestIdResponse(who.id === DEV.id ? userOld(who) : userNew(who)) : { data: { user: {} } });
        }
        case 'UserTweets': {
          const who = people.get(String(variables.userId));
          if (!who) return json({ data: { user: {} } });
          const posts = profilePosts(who);
          return json(userTweetsResponse(userTweetsTimeline(who.id === CARA.id ? caraPinned : null, posts, now)));
        }
        default:
          return json({ errors: [{ message: `no such query ${m[2]}` }] }, 404);
      }
    },
  };
}
