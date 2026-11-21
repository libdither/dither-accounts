/**
 * Invented Substack answers, shaped by hand after the reader's JSON (docs/substack.md): users, publications, posts,
 * notes and comments, feed items, comment branches and the Activity list. Nothing here came from a real account.
 */
const H = 3600_000;
export const iso = (ms: number) => new Date(ms).toISOString();

export interface User {
  id: number;
  name: string;
  handle: string;
  photo_url: string | null;
  bio: string | null;
}
export interface Pub {
  id: number;
  name: string;
  subdomain: string;
  custom_domain: string | null;
  author_id: number;
  logo_url: null;
}

export const ME: User = { id: 100001, name: 'Quinn Q', handle: 'quinn', photo_url: 'https://substackcdn.com/image/fetch/quinn.png', bio: 'I write about soil.' };
export const ANN: User = { id: 100002, name: 'Ann Lee', handle: 'annlee', photo_url: 'https://substack-post-media.s3.amazonaws.com/public/images/ann.png', bio: 'Gardens, mostly.' };
export const BEN: User = { id: 100003, name: 'Ben Ode', handle: 'benode', photo_url: 'https://substackcdn.com/image/fetch/ben.png', bio: 'Compost enjoyer.' };
export const CAL: User = { id: 100004, name: 'Cal Moe', handle: 'calmoe', photo_url: null, bio: null };
const PEOPLE = [ME, ANN, BEN, CAL];

export const MY_PUB: Pub = { id: 5001, name: 'ACME Notes', subdomain: 'acmenotes', custom_domain: null, author_id: ME.id, logo_url: null };
export const ANN_PUB: Pub = { id: 5002, name: 'Garden Weekly', subdomain: 'gardenweekly', custom_domain: 'garden.example.com', author_id: ANN.id, logo_url: null };

export function post(o: { id: number; pub: Pub; by: User; title: string; subtitle?: string; preview?: string; at: number; audience?: string; likes?: number; comments?: number; restacks?: number; liked?: boolean; restacked?: boolean; cover?: string }) {
  const slug = o.title.toLowerCase().replace(/[^a-z]+/g, '-');
  return {
    id: o.id,
    publication_id: o.pub.id,
    title: o.title,
    subtitle: o.subtitle ?? null,
    description: o.subtitle ?? null,
    truncated_body_text: o.preview ?? null,
    type: 'newsletter',
    slug,
    post_date: iso(o.at),
    audience: o.audience ?? 'everyone',
    canonical_url: `https://${o.pub.custom_domain ?? `${o.pub.subdomain}.substack.com`}/p/${slug}`,
    cover_image: o.cover ?? null,
    reaction_count: o.likes ?? 0,
    reaction: o.liked ? '❤' : null,
    comment_count: o.comments ?? 0,
    restacks: o.restacks ?? 0,
    restacked: !!o.restacked,
    publishedBylines: [{ id: o.by.id, name: o.by.name, handle: o.by.handle, photo_url: o.by.photo_url, bio: o.by.bio }],
    body_html: '<p>should be dropped by the hook</p>',
    language: 'en',
  };
}
export type Post = ReturnType<typeof post>;

export function comment(o: { id: number; by: User; body: string; at: number; post?: number; pub?: number; ancestors?: number[]; likes?: number; replies?: number; restacks?: number; liked?: boolean; attachments?: unknown[] }) {
  return {
    id: o.id,
    name: o.by.name,
    handle: o.by.handle,
    photo_url: o.by.photo_url,
    user_id: o.by.id,
    body: o.body,
    body_json: { type: 'doc', attrs: { schemaVersion: 'v1' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: o.body }] }] },
    publication_id: o.pub ?? null,
    post_id: o.post ?? null,
    type: o.post ? 'comment' : 'feed',
    date: iso(o.at),
    ancestor_path: (o.ancestors ?? []).join('.'),
    reaction_count: o.likes ?? 0,
    reaction: o.liked ? '❤' : null,
    restacks: o.restacks ?? 0,
    restacked: false,
    children_count: o.replies ?? 0,
    attachments: o.attachments ?? [],
  };
}
export type Comment = ReturnType<typeof comment>;

const userCtx = (u: User) => ({ id: u.id, name: u.name, handle: u.handle, photo_url: u.photo_url, bio: u.bio });
export function noteItem(c: Comment, o: { context?: string; by?: User; parents?: Comment[] } = {}) {
  const author = PEOPLE.find((p) => p.id === c.user_id)!;
  return {
    entity_key: `c-${c.id}`,
    type: 'comment',
    context: { type: o.context ?? 'note', timestamp: c.date, users: [userCtx(o.by ?? author)] },
    publication: null,
    post: null,
    comment: c,
    parentComments: o.parents ?? [],
    canReply: true,
    trackingParameters: { impression_id: 'dropped' },
  };
}
export function postItem(p: Post, pub: Pub, o: { context?: string; by?: User } = {}) {
  return { entity_key: `p-${p.id}`, type: 'post', context: { type: o.context ?? 'post', timestamp: p.post_date, users: [userCtx(o.by ?? ANN)] }, publication: pub, post: p, canReply: true };
}
export const branch = (head: Comment, ...under: Comment[]) => ({ comment: head, descendantComments: under.map((c) => ({ type: 'comment', comment: c })) });

export function world(now = Date.now()) {
  const myPost = post({ id: 9001, pub: MY_PUB, by: ME, title: 'Why soil matters', subtitle: 'A short one', preview: 'Soil is alive.', at: now - 30 * H, likes: 5, comments: 2, restacks: 1 });
  const annPost = post({ id: 9002, pub: ANN_PUB, by: ANN, title: 'Tomatoes in November', subtitle: 'For paid readers', preview: 'The first part is free.', at: now - 2 * H, audience: 'only_paid', likes: 12, comments: 3, restacks: 2, cover: 'https://substackcdn.com/image/fetch/cover.jpg' });
  const benPost = post({ id: 9003, pub: MY_PUB, by: BEN, title: 'A guest post', at: now - 5 * H, liked: true });
  const myNote = comment({ id: 7001, by: ME, body: 'Mulch is underrated.', at: now - 20 * H, likes: 4, replies: 1, restacks: 1 });
  const annReply = comment({ id: 7002, by: ANN, body: 'So true, and cheap too.', at: now - 10 * 60_000, ancestors: [7001] });
  const benComment = comment({ id: 7003, by: BEN, body: 'Great post!', at: now - 3 * H, post: 9001, pub: 5001 });
  const myReplyToBen = comment({ id: 7004, by: ME, body: 'Thanks Ben', at: now - 2 * H, post: 9001, pub: 5001, ancestors: [7003] });
  const annNote = comment({ id: 7005, by: ANN, body: 'Look at these beans', at: now - 4 * H, likes: 30, replies: 2, attachments: [{ id: 'att-1', type: 'image', imageUrl: 'https://substack-post-media.s3.amazonaws.com/public/images/beans.jpg', imageWidth: 800, imageHeight: 600 }] });
  const calQuote = comment({ id: 7006, by: CAL, body: 'Everyone read this', at: now - 6 * H, attachments: [{ id: 'att-2', type: 'post', post: myPost, publication: MY_PUB }] });
  const benOnAnn = comment({ id: 7007, by: BEN, body: 'Beautiful beans', at: now - 3 * H, ancestors: [7005] });
  const annOnBen = comment({ id: 7008, by: ANN, body: 'Thank you!', at: now - 2 * H, ancestors: [7005, 7007] });
  return { myPost, annPost, benPost, myNote, annReply, benComment, myReplyToBen, annNote, calQuote, benOnAnn, annOnBen };
}
export type World = ReturnType<typeof world>;

/** The Activity list as /api/v1/activity-feed-web answers it: newest first. */
export function activity(w: World, now = Date.now(), o: { more?: boolean } = {}) {
  const item = (type: string, at: number, x: Record<string, unknown>) => ({ type, item_key: `${type}-${at}`, updated_at: iso(at), recent_sender_ids: [] as number[], ...x });
  return {
    activityItems: [
      item('note_reply', now - 10 * 60_000, { comment_id: 7002, target_comment_id: 7001, recent_sender_ids: [ANN.id] }),
      item('post_like', now - 60 * 60_000, { target_post_id: 9001, publication_id: 5001, recent_sender_ids: [ANN.id, BEN.id] }),
      item('note_like', now - 90 * 60_000, { target_comment_id: 7001, recent_sender_ids: [BEN.id] }),
      item('post_reply', now - 3 * H, { comment_id: 7003, target_post_id: 9001, publication_id: 5001, recent_sender_ids: [BEN.id] }),
      item('restack', now - 4 * H, { target_comment_id: 7001, recent_sender_ids: [CAL.id] }),
      item('restack_quote', now - 6 * H, { comment_id: 7006, target_post_id: 9001, recent_sender_ids: [CAL.id] }),
      item('free_subscription', now - 7 * H, { publication_id: 5001, recent_sender_ids: [CAL.id] }),
      item('follow', now - 8 * H, { recent_sender_ids: [ANN.id] }),
      item('viral_post', now - 9 * H, { target_post_id: 9001, publication_id: 5001 }),
      item('live_stream', now - 10 * H, { recent_sender_ids: [ANN.id] }),
    ],
    pubs: [MY_PUB],
    posts: [w.myPost],
    drafts: [],
    users: [ME, ANN, BEN, CAL],
    comments: [w.myNote, w.annReply, w.benComment, w.calQuote],
    mentions: [],
    communityPosts: [],
    communityComments: [],
    feedItemComments: [],
    more: !!o.more,
  };
}

/** The profile answer (/api/v1/user/<handle>/public_profile). */
export function publicProfile(u: User, o: { pub?: Pub; following?: boolean; followsYou?: boolean; followers?: number } = {}) {
  return { ...u, followerCount: o.followers ?? 42, subscriberCountNumber: 7, isFollowing: !!o.following, followsViewer: !!o.followsYou, primaryPublication: o.pub ?? null, subscriptions: [] };
}
