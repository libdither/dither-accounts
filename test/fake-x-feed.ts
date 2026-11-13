/**
 * The fake x.com's signed-in client around the chat (test/fake-x.ts uses it): x.com's "responsive-web" as far as the
 * x extractor's feed hooks reach it, and the GraphQL server behind it, with made-up people.
 *
 *   - Scripts: the webpack runtime and main chunk (`/responsive-web/client-web/…`, classic scripts in the page's head),
 *     and the lazy chunks of the Notifications tab and of a post's activity (Likes, Reposts), loaded only by their
 *     routes' loaders (`req.e`): extractors/x/test/fake-page rw-*.js.
 *   - GraphQL (`/i/api/graphql/<queryId>/<operation>`): NotificationsTimeline (newest first, four entries a page, Top and
 *     Bottom cursors: Top gives what is newer, Bottom what is older), UserTweets, UserByRestId and TweetDetail (Cara's
 *     garden thread, three pages: gardenThread), TweetResultByRestId, Favoriters and Retweeters (your first post's
 *     likers, ranked, two pages and an empty last one; nobody for anyone else's post, which only its author may see),
 *     in X's shapes (extractors/x/test/feed-fixtures.ts).
 *   - GraphQL mutations (POSTed as JSON): FavoriteTweet, UnfavoriteTweet, CreateRetweet, DeleteRetweet and CreateTweet,
 *     on the posts it knows (yours, the garden thread's, the ones made here), kept in each post (`legacy.favorited`,
 *     `retweeted`, counts), with X's errors: already liked (139), already reposted (327), no such post (144), a
 *     duplicate post (187).
 *   - `POST /i/api/2/notifications/all/last_seen_cursor.json`: marking notifications seen, recorded so a test can say
 *     it never happened.
 *
 * Every request is recorded in the fake's `calls` (`{ op: 'graphql', name, variables }`, `{ op: 'chunk', name }`,
 * `{ op: 'notifications.seen' }`).
 */
import { join } from 'node:path';
import { CARA, createRetweetResponse, createTweetResponse, cursorEntry, deleteRetweetResponse, DEV, EMI, favoriteResponse, favoritersResponse, FINN, gardenThread, ME, notificationEntry, reactorsTimeline, retweetersResponse, tweetResultResponse, unfavoriteResponse, xErrorResponse, notificationsResponse, notificationsTimeline, type Person, tweet, tweetDetailResponse, tweetEntry, userByRestIdResponse, userNew, userOld, userTweetsResponse, userTweetsTimeline, withVisibility } from '../extractors/x/test/feed-fixtures.ts';

export { CARA, DEV, EMI, FINN };
const PAGE = join(import.meta.dir, '../extractors/x/test/fake-page');
export const RW = '/responsive-web/client-web';
export const RW_SCRIPTS = [`${RW}/runtime.f4ke0000c0ffee00a.js`, `${RW}/main.f4ke0792c0ffee01a.js`];

export interface FeedCall {
  op: string;
  name?: string;
  variables?: Record<string, unknown>;
  /** A mutation (POSTed). */
  method?: string;
}
interface Note {
  ts: number;
  entry: any;
}
export interface FeedFake {
  /** Your posts the notifications are about. */
  posts: { first: any; long: any };
  /** The thread TweetDetail answers for (its focal post and pages). */
  thread: ReturnType<typeof gardenThread>;
  /** The posts made through CreateTweet, by id. */
  made: Map<string, any>;
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

  const thread = gardenThread(now);
  // Every post a write may name, by id: kept up to date by the writes (what you did to it, its counts).
  const known = new Map<string, any>();
  const know = (t: any) => {
    if (!t) return;
    const inner = t.__typename === 'TweetWithVisibilityResults' ? t.tweet : t;
    if (inner?.rest_id) known.set(inner.rest_id, inner);
  };
  for (const t of [first, long, thread.root, thread.answer, thread.focal, thread.self1, thread.self2, thread.emi1, thread.emi2, thread.emi3, thread.emi4, thread.dev1, thread.finn1, thread.dev2]) know(t);
  const made = new Map<string, any>();
  let madeN = 0;
  const personOf = (t: any): Person => {
    const u = t.core.user_results.result;
    return { id: u.rest_id, handle: u.core?.screen_name ?? u.legacy?.screen_name, name: u.core?.name ?? u.legacy?.name };
  };
  // Who liked and reposted your first post: X ranks them; two pages, then a last one with nobody.
  const likers = [[userNew(CARA), userOld(DEV)], [userNew(EMI)], []];
  const reposters = [[userOld(FINN)], []];
  function reactorsPage(pages: any[][], cursor: string | undefined, name: string) {
    const at = cursor ? Number(/^DAAH\w+-(\d+)$/.exec(cursor)?.[1] ?? NaN) - 1 : 0;
    const list = pages[at];
    return list ? reactorsTimeline(list, `DAAH${name}-${at + 2}`) : null;
  }

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
  const chunk = (n: string, file = 'rw-notifications.js') => async () => {
    const all = await Bun.file(join(PAGE, file)).text();
    const part = all.split(/^\/\/@chunk /m).find((p) => p.startsWith(`${n}\n`));
    return part ? part.slice(part.indexOf('\n') + 1) : '';
  };
  files.set(RW_SCRIPTS[0]!, read('rw-runtime.js'));
  files.set(RW_SCRIPTS[1]!, read('rw-main.js'));
  files.set(`${RW}/bundle.Notifications.f4ke9001c0ffee12a.js`, chunk('9001'));
  files.set(`${RW}/shared~bundle.Notifications~bundle.NotificationDetail.f4ke9002c0ffee34a.js`, chunk('9002'));
  files.set(`${RW}/shared~bundle.QuoteTweetActivity~bundle.TweetActivity.f4ke9004c0ffee78a.js`, chunk('9004', 'rw-activity.js'));
  files.set(`${RW}/bundle.TweetActivity.f4ke9005c0ffee9aa.js`, chunk('9005', 'rw-activity.js'));

  const json = (v: unknown, status = 200) => Response.json(v, { status });
  return {
    posts: { first, long },
    thread,
    made,
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
        // A mutation is POSTed as JSON ({ variables, features, queryId }), a query a GET with its variables in the URL.
        variables = req.method === 'POST' ? ((await req.json()) as any).variables ?? {} : JSON.parse(url.searchParams.get('variables') ?? '{}');
      } catch {}
      calls.push({ op: 'graphql', name: m[2], variables, ...(req.method === 'POST' ? { method: 'POST' } : {}) });
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
        case 'TweetDetail': {
          // Only the garden thread's posts have a page here; any of its cursors gives that page.
          if (variables.focalTweetId !== thread.focal.rest_id) return json({ data: {}, errors: [{ message: '_Missing: No status found with that ID.', code: 144 }] });
          const page = !variables.cursor ? thread.page1 : variables.cursor === thread.cursors.page2 ? thread.page2 : variables.cursor === thread.cursors.page3 ? thread.page3 : null;
          return json(page ? tweetDetailResponse(page) : { errors: [{ message: 'bad cursor' }] }, page ? 200 : 400);
        }
        case 'TweetResultByRestId':
          return json(tweetResultResponse(known.get(String(variables.tweetId)) ?? null));
        case 'FavoriteTweet':
        case 'UnfavoriteTweet':
        case 'CreateRetweet':
        case 'DeleteRetweet': {
          const id = String(variables.tweet_id ?? variables.source_tweet_id);
          const t = known.get(id);
          if (!t) return json(xErrorResponse('NotFound: No status found with that ID.', 144));
          const l = t.legacy;
          if (m[2] === 'FavoriteTweet') {
            if (l.favorited) return json(xErrorResponse('Authorization: You have already favorited this post.', 139));
            l.favorited = true;
            l.favorite_count++;
            return json(favoriteResponse());
          }
          if (m[2] === 'UnfavoriteTweet') {
            if (l.favorited) l.favorite_count--;
            l.favorited = false;
            return json(unfavoriteResponse());
          }
          if (m[2] === 'CreateRetweet') {
            if (l.retweeted) return json(xErrorResponse('Authorization: You have already reposted this post.', 327));
            l.retweeted = true;
            l.retweet_count++;
            return json(createRetweetResponse(id, `18560000000000008${String(++madeN).padStart(2, '0')}`));
          }
          if (l.retweeted) l.retweet_count--;
          l.retweeted = false;
          return json(deleteRetweetResponse(id));
        }
        case 'CreateTweet': {
          const text = String(variables.tweet_text ?? '');
          if ([...made.values()].some((t) => t.legacy.full_text.endsWith(text))) return json(xErrorResponse('Duplicate: Status is a duplicate.', 187));
          const replyTo = variables.reply?.in_reply_to_tweet_id ? known.get(String(variables.reply.in_reply_to_tweet_id)) : undefined;
          if (variables.reply && !replyTo) return json(xErrorResponse('NotFound: No status found with that ID.', 144));
          const quoteId = typeof variables.attachment_url === 'string' ? /\/status\/(\d+)$/.exec(variables.attachment_url)?.[1] : undefined;
          const quote = quoteId ? known.get(quoteId) : undefined;
          const id = `18560000000000009${String(++madeN).padStart(2, '0')}`;
          const t = tweet({ id, by: self, text, ts: Date.now(), ...(replyTo ? { replyTo: { id: replyTo.rest_id, by: personOf(replyTo) }, root: replyTo.legacy.conversation_id_str } : {}), ...(quote ? { quote } : {}) });
          made.set(id, t);
          know(t);
          return json(createTweetResponse(t));
        }
        case 'Favoriters':
        case 'Retweeters': {
          const likes = m[2] === 'Favoriters';
          const name = likes ? 'likes' : 'reposts';
          // Only your own post's likers are shown to you (X since 2024); reposters only of your first post here.
          if (String(variables.tweetId) !== first.rest_id) return json(likes ? favoritersResponse({ instructions: [] }) : retweetersResponse({ instructions: [] }));
          const page = reactorsPage(likes ? likers : reposters, variables.cursor, name);
          if (!page) return json({ errors: [{ message: 'bad cursor' }] }, 400);
          return json(likes ? favoritersResponse(page) : retweetersResponse(page));
        }
        default:
          return json({ errors: [{ message: `no such query ${m[2]}` }] }, 404);
      }
    },
  };
}
