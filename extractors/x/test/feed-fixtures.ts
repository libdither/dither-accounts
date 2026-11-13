/**
 * X's GraphQL as the signed-in client gets it, built for the tests and the fake x.com (test/fake-x-feed.ts): users in
 * 2025's layout and the older one, posts, notification and tweet entries, cursors, and the NotificationsTimeline,
 * UserTweets and UserByRestId answers around them. Everyone in them is made up.
 */

export interface Person {
  id: string;
  handle: string;
  name: string;
  bio?: string;
  location?: string;
  site?: string;
  createdAt?: number;
  followers?: number;
  following?: number;
  posts?: number;
  /** They follow you; you follow them. */
  followsYou?: boolean;
  followedByMe?: boolean;
}

export const ME: Person = { id: '1001', handle: 'pat_x', name: 'Pat X' };
export const CARA: Person = { id: '4004', handle: 'cara_c', name: 'Cara C', bio: 'Gardens, mostly. https://t.co/cAr4bio', site: 'https://cara.example', location: 'Lisbon', createdAt: Date.UTC(2016, 2, 1, 10), followers: 120, following: 80, posts: 900, followsYou: true, followedByMe: true };
export const DEV: Person = { id: '5005', handle: 'dev_d', name: 'Dev D', bio: 'builds things & breaks them', createdAt: Date.UTC(2012, 5, 9, 8), followers: 3400, following: 210, posts: 15000, followsYou: true, followedByMe: false };
export const EMI: Person = { id: '6006', handle: 'emi_e', name: 'Emi E', createdAt: Date.UTC(2020, 0, 2, 3), followers: 12, following: 30, posts: 44, followsYou: false, followedByMe: false };
export const FINN: Person = { id: '7007', handle: 'finn_f', name: 'Finn F', location: 'Oslo', createdAt: Date.UTC(2019, 7, 15, 12), followers: 800, following: 790, posts: 2100, followsYou: false, followedByMe: true };

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n: number) => String(n).padStart(2, '0');
/** X's date format: "Wed Oct 10 20:19:24 +0000 2018". */
export function xDateStr(ms: number): string {
  const d = new Date(ms);
  return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} +0000 ${d.getUTCFullYear()}`;
}
const avatar = (p: Person) => `https://pbs.twimg.com/profile_images/${p.id}/${p.handle}_normal.jpg`;
const b64 = (s: string) => Buffer.from(s).toString('base64').replace(/=+$/, '');
const bioEntities = (p: Person) => ({
  description: { urls: p.bio?.includes('https://t.co/cAr4bio') ? [{ display_url: 'cara.example/garden', expanded_url: 'https://cara.example/garden', url: 'https://t.co/cAr4bio', indices: [17, 40] }] : [] },
  ...(p.site ? { url: { urls: [{ display_url: p.site.replace(/^https?:\/\//, ''), expanded_url: p.site, url: `https://t.co/s${p.id}`, indices: [0, 23] }] } } : {}),
});

/** A user in 2025's layout: names in `core`, the picture in `avatar`, follows in `relationship_perspectives`. */
export function userNew(p: Person) {
  return {
    __typename: 'User',
    id: b64(`User:${p.id}`),
    rest_id: p.id,
    affiliates_highlighted_label: {},
    avatar: { image_url: avatar(p) },
    core: { created_at: xDateStr(p.createdAt ?? Date.UTC(2015, 0, 1)), name: p.name, screen_name: p.handle },
    dm_permissions: { can_dm: true },
    has_graduated_access: true,
    is_blue_verified: false,
    legacy: {
      default_profile: true,
      description: p.bio ?? '',
      entities: bioEntities(p),
      fast_followers_count: 0,
      favourites_count: 321,
      followers_count: p.followers ?? 0,
      friends_count: p.following ?? 0,
      has_custom_timelines: false,
      is_translator: false,
      listed_count: 2,
      media_count: 10,
      normal_followers_count: p.followers ?? 0,
      pinned_tweet_ids_str: [],
      possibly_sensitive: false,
      profile_banner_url: `https://pbs.twimg.com/profile_banners/${p.id}/1600000000`,
      profile_interstitial_type: '',
      statuses_count: p.posts ?? 0,
      translator_type: 'none',
      want_retweets: false,
      withheld_in_countries: [],
    },
    location: { location: p.location ?? '' },
    media_permissions: { can_media_tag: true },
    parody_commentary_fan_label: 'None',
    privacy: { protected: false },
    profile_image_shape: 'Circle',
    relationship_perspectives: { followed_by: !!p.followsYou, following: !!p.followedByMe },
    tipjar_settings: {},
    verification: { verified: false },
  };
}

/** A user in the older layout: everything in `legacy`. */
export function userOld(p: Person) {
  return {
    __typename: 'User',
    id: b64(`User:${p.id}`),
    rest_id: p.id,
    affiliates_highlighted_label: {},
    has_graduated_access: true,
    is_blue_verified: true,
    profile_image_shape: 'Circle',
    legacy: {
      can_dm: false,
      created_at: xDateStr(p.createdAt ?? Date.UTC(2015, 0, 1)),
      default_profile: false,
      description: (p.bio ?? '').replace(/&/g, '&amp;'),
      entities: bioEntities(p),
      followed_by: !!p.followsYou,
      following: !!p.followedByMe,
      followers_count: p.followers ?? 0,
      friends_count: p.following ?? 0,
      location: p.location ?? '',
      name: p.name,
      profile_image_url_https: avatar(p),
      screen_name: p.handle,
      statuses_count: p.posts ?? 0,
      verified: false,
    },
  };
}

/** A user as the page's user lookup gives it: normalized flat, `{ entities: { users: { id: user } }, result: id }`. */
export function userFlat(p: Person) {
  const u = userNew(p);
  return {
    entities: {
      users: {
        [p.id]: {
          ...u.legacy,
          id_str: p.id,
          name: p.name,
          screen_name: p.handle,
          profile_image_url_https: avatar(p),
          location: p.location ?? '',
          created_at: u.core.created_at,
          following: !!p.followedByMe,
          followed_by: !!p.followsYou,
          is_blue_verified: false,
          profile_image_shape: 'Circle',
        },
      },
    },
    result: p.id,
  };
}

export interface PostOpts {
  id: string;
  by: Person;
  /** The user's layout: 'new' (2025) or 'old'. */
  layout?: 'new' | 'old';
  text: string;
  ts: number;
  replyTo?: { id: string; by: Person };
  quote?: any;
  repost?: any;
  /** A long post's whole text (`note_tweet`); `text` is then its first 275 characters. */
  note?: string;
  urls?: { url: string; expanded: string; display: string }[];
  media?: { url: string; type: 'photo' | 'video' | 'animated_gif'; img: string; w: number; h: number; alt?: string }[];
  counts?: { replies?: number; reposts?: number; likes?: number; quotes?: number; views?: number };
}

/** A post (`Tweet`), as the timelines carry it. */
export function tweet(o: PostOpts): any {
  const user = o.layout === 'old' ? userOld(o.by) : userNew(o.by);
  const lead = o.replyTo ? `@${o.replyTo.by.handle} ` : '';
  const mediaTail = o.media?.length ? ` ${o.media[0]!.url}` : '';
  const quoteTail = o.quote ? ` https://t.co/q${o.id.slice(-6)}` : '';
  const full = o.repost ? `RT @${o.repost.core.user_results.result.core?.screen_name ?? o.repost.core.user_results.result.legacy?.screen_name}: ${o.repost.legacy.full_text}` : `${lead}${(o.note ? o.note.slice(0, 275) : o.text).replace(/&/g, '&amp;')}${quoteTail}${mediaTail}`;
  const len = Array.from(full).length;
  const media = (o.media ?? []).map((m, i) => ({
    display_url: 'pic.x.com/abc',
    expanded_url: `https://x.com/${o.by.handle}/status/${o.id}/photo/${i + 1}`,
    id_str: `${o.id}${i}`,
    indices: [len - 23, len],
    media_key: `3_${o.id}${i}`,
    media_url_https: m.img,
    type: m.type,
    url: m.url,
    ...(m.alt ? { ext_alt_text: m.alt } : {}),
    original_info: { height: m.h, width: m.w, focus_rects: [] },
    sizes: { large: { h: m.h, w: m.w, resize: 'fit' } },
  }));
  return {
    __typename: 'Tweet',
    rest_id: o.id,
    core: { user_results: { result: user } },
    unmention_data: {},
    edit_control: { edit_tweet_ids: [o.id], editable_until_msecs: String(o.ts + 3600_000), is_edit_eligible: true, edits_remaining: '5' },
    is_translatable: false,
    views: { count: String(o.counts?.views ?? 100), state: 'EnabledWithCount' },
    source: '<a href="https://mobile.twitter.com" rel="nofollow">X Web App</a>',
    ...(o.note ? { note_tweet: { is_expandable: true, note_tweet_results: { result: { id: b64(`NoteTweetResults:${o.id}`), text: o.note, entity_set: { hashtags: [], symbols: [], urls: [], user_mentions: [] } } } } } : {}),
    ...(o.quote ? { quoted_status_result: { result: o.quote } } : {}),
    legacy: {
      bookmark_count: 0,
      bookmarked: false,
      created_at: xDateStr(o.ts),
      conversation_id_str: o.replyTo?.id ?? o.id,
      display_text_range: [Array.from(lead).length, len - Array.from(mediaTail).length],
      entities: {
        hashtags: [],
        symbols: [],
        timestamps: [],
        urls: (o.urls ?? []).map((u) => ({ display_url: u.display, expanded_url: u.expanded, url: u.url, indices: [0, 23] })),
        user_mentions: o.replyTo ? [{ id_str: o.replyTo.by.id, name: o.replyTo.by.name, screen_name: o.replyTo.by.handle, indices: [0, lead.length - 1] }] : [],
        ...(media.length ? { media } : {}),
      },
      ...(media.length ? { extended_entities: { media } } : {}),
      favorite_count: o.counts?.likes ?? 0,
      favorited: false,
      full_text: full,
      is_quote_status: !!o.quote,
      lang: 'en',
      quote_count: o.counts?.quotes ?? 0,
      reply_count: o.counts?.replies ?? 0,
      retweet_count: o.counts?.reposts ?? 0,
      retweeted: false,
      user_id_str: o.by.id,
      id_str: o.id,
      ...(o.replyTo ? { in_reply_to_screen_name: o.replyTo.by.handle, in_reply_to_status_id_str: o.replyTo.id, in_reply_to_user_id_str: o.replyTo.by.id } : {}),
      ...(o.quote ? { quoted_status_id_str: o.quote.rest_id, quoted_status_permalink: { url: `https://t.co/q${o.id.slice(-6)}`, expanded: `https://x.com/i/status/${o.quote.rest_id}`, display: 'x.com/i/status/…' } } : {}),
      ...(o.repost ? { retweeted_status_result: { result: o.repost } } : {}),
    },
  };
}

/** A post wrapped as X wraps one with visibility limits. */
export function withVisibility(t: any): any {
  const { __typename, ...rest } = t;
  return { __typename: 'TweetWithVisibilityResults', tweet: rest, limitedActionResults: { limited_actions: [{ action: 'Reply', prompt: { __typename: 'CtaLimitedActionPrompt' } }] } };
}

export interface NotificationOpts {
  id: string;
  icon: string;
  ts: number;
  text: string;
  from: any[];
  targets?: any[];
  url?: string;
  element?: string;
}
/** A `TimelineNotification` entry (likes, reposts, follows, X's own). */
export function notificationEntry(o: NotificationOpts) {
  return {
    entryId: `notification-${o.id}`,
    sortIndex: String(o.ts),
    content: {
      entryType: 'TimelineTimelineItem',
      __typename: 'TimelineTimelineItem',
      itemContent: {
        itemType: 'TimelineNotification',
        __typename: 'TimelineNotification',
        id: o.id,
        notification_icon: o.icon,
        rich_message: { rtl: false, text: o.text, entities: o.from.slice(0, 1).map((u) => ({ fromIndex: 0, toIndex: (u.core?.name ?? u.legacy?.name ?? '').length, ref: { type: 'TimelineRichTextUser', user_results: { result: { __typename: 'User', rest_id: u.rest_id } } } })) },
        notification_url: { url: o.url ?? 'https://x.com/i/timeline', urlType: 'ExternalUrl' },
        template: {
          __typename: 'TimelineNotificationAggregateUserActions',
          target_objects: (o.targets ?? []).map((t) => ({ __typename: 'TimelineNotificationTweetRef', tweet_results: { result: t } })),
          from_users: o.from.map((u) => ({ __typename: 'TimelineNotificationUserRef', user_results: { result: u } })),
        },
        timestamp_ms: String(o.ts),
      },
      clientEventInfo: { component: 'urt', element: o.element ?? 'users_liked_your_tweet', details: { notificationDetails: { impressionId: `imp-${o.id}`, metadata: 'AAA' } } },
    },
  };
}
/** A `TimelineTweet` entry (a reply, mention or quote). */
export function tweetEntry(t: any, element: string, ts: number) {
  return {
    entryId: `tweet-${t.rest_id ?? t.tweet?.rest_id}`,
    sortIndex: String(ts),
    content: {
      entryType: 'TimelineTimelineItem',
      __typename: 'TimelineTimelineItem',
      itemContent: { itemType: 'TimelineTweet', __typename: 'TimelineTweet', tweet_results: { result: t }, tweetDisplayType: 'Tweet' },
      clientEventInfo: { component: 'urt', element, details: { notificationDetails: { impressionId: 'imp', metadata: 'AAA' } } },
    },
  };
}
export function cursorEntry(type: 'Top' | 'Bottom', value: string, ts: number) {
  return { entryId: `cursor-${type.toLowerCase()}-${ts}`, sortIndex: String(ts), content: { entryType: 'TimelineTimelineCursor', __typename: 'TimelineTimelineCursor', value, cursorType: type } };
}
/** The timeline NotificationsTimeline's answer holds (what the page's endpoint returns). */
export function notificationsTimeline(entries: any[]) {
  const top = entries.map((e) => Number(e.sortIndex)).filter(Number.isFinite);
  return {
    id: b64('Timeline:notifications'),
    instructions: [{ type: 'TimelineClearCache' }, { type: 'TimelineAddEntries', entries }, ...(top.length ? [{ type: 'TimelineMarkEntriesUnreadGreaterThanSortIndex', sort_index: String(Math.max(...top)) }] : [])],
  };
}
/** The whole GraphQL answer of NotificationsTimeline. */
export function notificationsResponse(timeline: any, self = ME) {
  return { data: { viewer_v2: { user_results: { result: { __typename: 'User', rest_id: self.id, notification_timeline: { id: b64(`NotificationTimeline:${self.id}`), timeline } } } } } };
}
/** UserTweets' timeline: a pinned post (TimelinePinEntry), then posts, with cursors. */
export function userTweetsTimeline(pinned: any | null, posts: any[], ts: number) {
  const entry = (t: any) => ({ entryId: `tweet-${t.rest_id ?? t.tweet?.rest_id}`, sortIndex: String(ts), content: { entryType: 'TimelineTimelineItem', __typename: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineTweet', __typename: 'TimelineTweet', tweet_results: { result: t }, tweetDisplayType: 'Tweet' }, clientEventInfo: { component: 'tweet', element: 'tweet' } } });
  return {
    instructions: [
      { type: 'TimelineClearCache' },
      ...(pinned ? [{ type: 'TimelinePinEntry', entry: { ...entry(pinned), entryId: `tweet-${pinned.rest_id}`, content: { ...entry(pinned).content, socialContext: { type: 'TimelineGeneralContext', contextType: 'Pin', text: 'Pinned' } } } }] : []),
      { type: 'TimelineAddEntries', entries: [...posts.map(entry), cursorEntry('Top', 'DAABCgABGPost-top', ts + 1), cursorEntry('Bottom', 'DAABCgABGPost-bottom', ts - 1)] },
    ],
    metadata: { scribeConfig: { page: 'profileBest' } },
  };
}
export function userTweetsResponse(timeline: any) {
  return { data: { user: { result: { __typename: 'User', timeline: { timeline } } } } };
}
export function userByRestIdResponse(user: any) {
  return { data: { user: { result: user } } };
}
