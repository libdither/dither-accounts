/**
 * The fake x.com's signed-in client around the chat (test/fake-x.ts uses it): x.com's "responsive-web" as far as the
 * x extractor's feed hooks reach it, and the GraphQL server behind it, with made-up people.
 *
 *   - Scripts: the webpack runtime and main chunk (`/responsive-web/client-web/…`, classic scripts in the page's head),
 *     and the lazy chunks of the Notifications tab, of a post's activity (Likes, Reposts), of Home and of the reply
 *     composer (with the media uploader), loaded only by their routes' or components' loaders (`req.e`):
 *     extractors/x/test/fake-page rw-*.js.
 *   - GraphQL (`/i/api/graphql/<queryId>/<operation>`): NotificationsTimeline (newest first, four entries a page, Top and
 *     Bottom cursors: Top gives what is newer, Bottom what is older), UserTweets, UserByRestId and TweetDetail (Cara's
 *     garden thread, three pages: gardenThread), TweetResultByRestId, Favoriters and Retweeters (your first post's
 *     likers, ranked, two pages and an empty last one; nobody for anyone else's post, which only its author may see),
 *     in X's shapes (extractors/x/test/feed-fixtures.ts).
 *   - HomeTimeline (For you) and HomeLatestTimeline (Following): homeWorld's pages, two and an empty last one each, by
 *     their Bottom cursors; a Top cursor gives nothing new. Asked with `seenTweetIds`, they are POSTed (recorded).
 *   - GraphQL mutations (POSTed as JSON): FavoriteTweet, UnfavoriteTweet, CreateRetweet, DeleteRetweet, CreateTweet and
 *     DeleteTweet, on the posts it knows (yours, the garden thread's, the ones made here), kept in each post
 *     (`legacy.favorited`, `retweeted`, counts), with X's errors: already liked (139), already reposted (327), no such
 *     post (144), a duplicate post (187), media ids it did not finish (324), someone else's post to delete (made up).
 *     CreateTweet keeps `conversation_control` and `media.media_entities` (each must be an upload finished here).
 *   - Media uploads (`/i/media/upload.json`, x.com's are on upload.x.com): INIT, APPEND (multipart), FINALIZE and STATUS;
 *     a video is processed over two STATUS calls, and one whose bytes start with `BROKEN` fails in processing.
 *   - `POST /i/api/2/notifications/all/last_seen_cursor.json`: marking notifications seen, recorded so a test can say
 *     it never happened.
 *
 * Every request is recorded in the fake's `calls` (`{ op: 'graphql', name, variables }`, `{ op: 'chunk', name }`,
 * `{ op: 'notifications.seen' }`).
 */
import { join } from 'node:path';
import { ANN, CARA, createRetweetResponse, deleteTweetResponse, homeResponse, homeWorld, likesResponse, likesWorld, createTweetResponse, cursorEntry, deleteRetweetResponse, DEV, EMI, favoriteResponse, favoritersResponse, FINN, gardenThread, ME, notificationEntry, reactorsTimeline, retweetersResponse, tweetResultResponse, unfavoriteResponse, xErrorResponse, notificationsResponse, notificationsTimeline, type Person, tweet, tweetDetailResponse, tweetEntry, userByRestIdResponse, userNew, userOld, userTweetsResponse, userTweetsTimeline, withVisibility } from '../extractors/x/test/feed-fixtures.ts';

export { ANN, CARA, DEV, EMI, FINN };
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
export interface Upload {
  type: string;
  category: string;
  total: number;
  bytes: Uint8Array[];
  finalized: boolean;
  /** STATUS calls left until a video is processed. */
  pending: number;
}
export interface FeedFake {
  /** Your posts the notifications are about. */
  posts: { first: any; long: any };
  /** The thread TweetDetail answers for (its focal post and pages). */
  thread: ReturnType<typeof gardenThread>;
  /** The posts made through CreateTweet, by id. */
  made: Map<string, any>;
  /** Home's pages and posts (feed-fixtures.ts homeWorld). */
  home: ReturnType<typeof homeWorld>;
  /** The Likes tab's pages and posts (feed-fixtures.ts likesWorld). */
  likes: ReturnType<typeof likesWorld>;
  /** The uploads, by media id: what INIT said and the bytes APPENDed, and whether FINALIZE came. */
  uploads: Map<string, Upload>;
  notes: Note[];
  /** A new like of your first post, by `who`, now (as X's servers would add it). */
  like(who: Person): void;
  /** Answers what is the feed's, or null. */
  route(req: Request, url: URL, calls: FeedCall[]): Promise<Response | null>;
}

/** What Translate post answers, by post id (a test sets them): X's translation, its t.co links, the source language. */
export const TRANSLATIONS: Record<string, { translation: string; from: string; urls?: { url: string; expanded_url: string }[] }> = {};
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
  files.set(`${RW}/shared~bundle.Compose~bundle.HomeTimeline~bundle.LoggedInMain.f4ke9006c0ffeebca.js`, chunk('9006', 'rw-home.js'));
  files.set(`${RW}/bundle.HomeTimeline.f4ke9007c0ffeedea.js`, chunk('9007', 'rw-home.js'));
  files.set(`${RW}/bundle.Compose.f4ke9010c0ffeef0a.js`, chunk('9010', 'rw-compose.js'));

  const home = homeWorld(now);
  for (const t of [home.plain, home.reposted, home.okra1, home.okra2, home.okra3, home.older, home.balcony, home.mulch, home.rain, home.frost]) know(t);
  /** A home timeline's page by cursor: none for the first, a Bottom cursor for the next; a Top one gives nothing new. */
  function homePage(which: 'following' | 'foryou', cursor: string | undefined) {
    const pages = which === 'following' ? home.following : home.foryou;
    const c = home.cursors;
    if (!cursor) return pages[0];
    if (cursor === (which === 'following' ? c.following2 : c.foryou2)) return pages[1];
    if (cursor === (which === 'following' ? c.following3 : c.foryou3) || cursor === (which === 'following' ? c.followingTop : c.foryouTop)) return pages[2];
    return null;
  }
  const likes = likesWorld(now);
  /** A Likes page by cursor: none for the first, a Bottom cursor for the next; a Top one gives nothing new. */
  function likesPage(cursor: string | undefined) {
    const c = likes.cursors;
    if (!cursor) return likes.pages[0];
    if (cursor === c.page2) return likes.pages[1];
    if (cursor === c.page3 || cursor === c.top) return likes.pages[2];
    return null;
  }
  const uploads = new Map<string, Upload>();
  let uploadN = 0;
  const CATEGORY: Record<string, RegExp> = { tweet_image: /^image\/(png|jpeg|webp)$/, tweet_gif: /^image\/gif$/, amplify_video: /^video\// };

  const json = (v: unknown, status = 200) => Response.json(v, { status });
  /** X's chunked media upload: INIT, APPEND, FINALIZE, STATUS (each recorded as `{ op: 'upload.<command>' }`). */
  async function upload(req: Request, url: URL, calls: FeedCall[]): Promise<Response> {
    const q = url.searchParams;
    const command = q.get('command') ?? '';
    const variables: Record<string, unknown> = Object.fromEntries([...q.entries()].filter(([k]) => k !== 'command'));
    calls.push({ op: `upload.${command}`, variables, method: req.method });
    if (!/(?:^|;\s*)auth_token=fake-session/.test(req.headers.get('cookie') ?? '')) return json({ errors: [{ message: 'Could not authenticate you', code: 32 }] }, 401);
    const bad = (message: string) => json({ errors: [{ code: 324, message }] }, 400);
    if (command === 'INIT') {
      const type = q.get('media_type') ?? '';
      const category = q.get('media_category') ?? '';
      if (!CATEGORY[category]?.test(type)) return bad(`media_category ${category} does not take ${type}`);
      const id = `71000000000000000${String(++uploadN).padStart(2, '0')}`;
      uploads.set(id, { type, category, total: Number(q.get('total_bytes')), bytes: [], finalized: false, pending: 0 });
      return json({ media_id: Number(id), media_id_string: id, media_key: `3_${id}`, expires_after_secs: 86_400 });
    }
    const id = q.get('media_id') ?? '';
    const u = uploads.get(id);
    if (!u) return bad('Invalid media id.');
    if (command === 'APPEND') {
      const form = await req.formData();
      const part = form.get('media');
      if (!(part instanceof Blob) || Number(q.get('segment_index')) !== u.bytes.length) return bad('Segment out of order.');
      u.bytes.push(new Uint8Array(await part.arrayBuffer()));
      return new Response(null, { status: 204 });
    }
    const size = u.bytes.reduce((n, b) => n + b.length, 0);
    const broken = new TextDecoder().decode(u.bytes[0]?.slice(0, 6) ?? new Uint8Array()) === 'BROKEN';
    if (command === 'FINALIZE') {
      if (size !== u.total) return bad('File size does not match.');
      u.finalized = true;
      const video = u.category === 'amplify_video';
      if (video) u.pending = 2;
      return json({ media_id: Number(id), media_id_string: id, media_key: `${video ? 7 : 3}_${id}`, size, expires_after_secs: 86_400, ...(video ? { processing_info: { state: 'pending', check_after_secs: 0 } } : {}) });
    }
    if (command === 'STATUS') {
      if (u.pending > 0 && --u.pending > 0) return json({ media_id_string: id, processing_info: { state: 'in_progress', check_after_secs: 0, progress_percent: 50 } });
      if (broken) return json({ media_id_string: id, processing_info: { state: 'failed', error: { code: 1, name: 'InvalidMedia', message: 'Unsupported video format.' } } });
      return json({ media_id_string: id, processing_info: { state: 'succeeded', progress_percent: 100 } });
    }
    return bad(`no such command ${command}`);
  }
  return {
    posts: { first, long },
    thread,
    made,
    home,
    likes,
    uploads,
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
      // Translate post (the post actions' fetchTranslation): X's translation service over REST.
      const tr = /^\/i\/api\/1\.1\/strato\/column\/None\/tweetId=(\d+),destinationLanguage=None,translationSource=Some\((\w+)\),.*\/translation\/service\/translateTweet$/.exec(p);
      if (tr) {
        calls.push({ op: 'translate', name: 'translateTweet', variables: { tweetId: tr[1], source: tr[2] } });
        const t = TRANSLATIONS[tr[1]!];
        if (!t) return json({ errors: [{ message: 'This post cannot be translated.', code: 34 }] }, 404);
        return json({ id_str: tr[1], translation: t.translation, entities: { urls: t.urls ?? [] }, sourceLanguage: t.from, localizedSourceLanguage: t.from, destinationLanguage: 'en', translationSource: 'Grok' });
      }
      if (p === '/i/media/upload.json') return upload(req, url, calls);
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
        case 'Likes': {
          // Only your own likes: X shows nobody else's.
          if (String(variables.userId) !== self.id) return json({ data: { user: { result: { __typename: 'User', timeline: { timeline: { instructions: [] } } } } } });
          const page = likesPage(variables.cursor);
          return json(page ? likesResponse(page) : { errors: [{ message: 'bad cursor' }] }, page ? 200 : 400);
        }
        case 'HomeTimeline':
        case 'HomeLatestTimeline': {
          const page = homePage(m[2] === 'HomeTimeline' ? 'foryou' : 'following', variables.cursor);
          return json(page ? homeResponse(page) : { errors: [{ message: 'bad cursor' }] }, page ? 200 : 400);
        }
        case 'DeleteTweet': {
          const id = String(variables.tweet_id);
          const t = known.get(id);
          // No such post: X's 144, with no data (the page's client rejects).
          if (!t) return json({ errors: [{ message: 'NotFound: No status found with that ID.', code: 144 }] });
          if (personOf(t).id !== self.id) return json({ errors: [{ message: 'Forbidden: You cannot delete a post that is not yours.', code: 9 }] });
          known.delete(id);
          made.delete(id);
          return json(deleteTweetResponse());
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
          if (text && [...made.values()].some((t) => t.legacy.full_text.endsWith(text))) return json(xErrorResponse('Duplicate: Status is a duplicate.', 187));
          const replyTo = variables.reply?.in_reply_to_tweet_id ? known.get(String(variables.reply.in_reply_to_tweet_id)) : undefined;
          if (variables.reply && !replyTo) return json(xErrorResponse('NotFound: No status found with that ID.', 144));
          const quoteId = typeof variables.attachment_url === 'string' ? /\/status\/(\d+)$/.exec(variables.attachment_url)?.[1] : undefined;
          const quote = quoteId ? known.get(quoteId) : undefined;
          // Pictures and video: each an upload finished here (a video processed), as X checks them.
          const mediaIds: string[] = (variables.media?.media_entities ?? []).map((e: any) => String(e.media_id));
          const ups = mediaIds.map((mid) => uploads.get(mid));
          if (ups.some((u) => !u || !u.finalized || u.pending > 0)) return json(xErrorResponse('BadRequest: Your media IDs are invalid.', 324));
          const id = `18560000000000009${String(++madeN).padStart(2, '0')}`;
          const media = ups.map((u, i) => ({ url: `https://t.co/m${id.slice(-4)}${i}`, type: (u!.category === 'amplify_video' ? 'video' : u!.category === 'tweet_gif' ? 'animated_gif' : 'photo') as 'photo' | 'video' | 'animated_gif', img: `https://pbs.twimg.com/media/Fk7Made${mediaIds[i]!.slice(-4)}.jpg`, w: 800, h: 600 }));
          const t = tweet({ id, by: self, text, ts: Date.now(), ...(replyTo ? { replyTo: { id: replyTo.rest_id, by: personOf(replyTo) }, root: replyTo.legacy.conversation_id_str } : {}), ...(quote ? { quote } : {}), ...(media.length ? { media } : {}) });
          if (variables.conversation_control) t.legacy.conversation_control = { policy: variables.conversation_control.mode };
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
