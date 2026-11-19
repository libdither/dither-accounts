/**
 * Invented Reddit data in the shapes old.reddit.com's JSON gives (`raw_json=1`), shaped by hand after Reddit's
 * documented listings: posts, comment trees with `more`, the inbox, a user. Used by the unit tests and the fake page.
 */
export const ME = 'pat_reads';
export const ANN = 'ann_lee';
export const BEN = 'ben_okafor';
export const CARA = 'cara_c';
export const SUB = { name: 'gardening', id: 't5_2qh1a' };
export const SUB2 = { name: 'rustlang', id: 't5_2qh1b' };

const NOW_S = () => Math.floor(Date.now() / 1000);
const MIN = 60;
const H = 3600;

export function listing(children: { kind: string; data: Record<string, unknown> }[], after: string | null = null) {
  return { kind: 'Listing', data: { after, before: null, dist: children.length, children } };
}

export interface PostOpts {
  id: string;
  by?: string;
  title?: string;
  text?: string;
  link?: string;
  sub?: { name: string; id: string };
  agoS?: number;
  score?: number;
  comments?: number;
  likes?: boolean | null;
  nsfw?: boolean;
  spoiler?: boolean;
  image?: string;
  gallery?: string[];
  video?: boolean;
  crosspost?: Record<string, unknown>;
}
export function post(o: PostOpts): Record<string, unknown> {
  const sub = o.sub ?? SUB;
  const self = !o.link;
  return {
    id: o.id,
    name: `t3_${o.id}`,
    title: o.title ?? 'A title',
    selftext: o.text ?? '',
    is_self: self,
    url: o.link ?? `https://www.reddit.com/r/${sub.name}/comments/${o.id}/a_title/`,
    ...(o.link ? { url_overridden_by_dest: o.link } : {}),
    permalink: `/r/${sub.name}/comments/${o.id}/a_title/`,
    subreddit: sub.name,
    subreddit_id: sub.id,
    subreddit_name_prefixed: `r/${sub.name}`,
    author: o.by ?? ANN,
    author_fullname: 't2_abc',
    created_utc: NOW_S() - (o.agoS ?? H),
    score: o.score ?? 12,
    ups: o.score ?? 12,
    num_comments: o.comments ?? 0,
    likes: o.likes === undefined ? null : o.likes,
    over_18: !!o.nsfw,
    spoiler: !!o.spoiler,
    stickied: false,
    is_video: !!o.video,
    ...(o.image ? { preview: { images: [{ source: { url: o.image, width: 640, height: 480 }, resolutions: [], variants: {} }] } } : {}),
    ...(o.gallery
      ? {
          is_gallery: true,
          gallery_data: { items: o.gallery.map((_, i) => ({ media_id: `m${i}`, id: i, ...(i === 0 ? { caption: 'the first one' } : {}) })) },
          media_metadata: Object.fromEntries(o.gallery.map((u, i) => [`m${i}`, { status: 'valid', e: 'Image', m: 'image/jpg', s: { u, x: 800, y: 600 } }])),
        }
      : {}),
    ...(o.crosspost ? { crosspost_parent_list: [o.crosspost], crosspost_parent: o.crosspost.name } : {}),
  };
}
export const t3 = (o: PostOpts) => ({ kind: 't3', data: post(o) });

export interface CommentOpts {
  id: string;
  link: string;
  parent?: string;
  by?: string;
  body?: string;
  agoS?: number;
  score?: number;
  likes?: boolean | null;
  replies?: { kind: string; data: Record<string, unknown> }[];
  sub?: { name: string; id: string };
}
export function comment(o: CommentOpts): Record<string, unknown> {
  const sub = o.sub ?? SUB;
  return {
    id: o.id,
    name: `t1_${o.id}`,
    body: o.body ?? 'a comment',
    author: o.by ?? BEN,
    created_utc: NOW_S() - (o.agoS ?? 30 * MIN),
    score: o.score ?? 3,
    likes: o.likes === undefined ? null : o.likes,
    parent_id: o.parent ?? `t3_${o.link}`,
    link_id: `t3_${o.link}`,
    permalink: `/r/${sub.name}/comments/${o.link}/a_title/${o.id}/`,
    subreddit: sub.name,
    subreddit_id: sub.id,
    subreddit_name_prefixed: `r/${sub.name}`,
    replies: o.replies?.length ? listing(o.replies) : '',
    depth: 0,
  };
}
export const t1 = (o: CommentOpts) => ({ kind: 't1', data: comment(o) });
export const more = (o: { id: string; parent: string; children: string[]; count?: number }) => ({ kind: 'more', data: { id: o.id, name: `t1_${o.id}`, parent_id: o.parent, children: o.children, count: o.count ?? o.children.length, depth: 1 } });

/** A garden post and its comments: two top-level threads, an answer to an answer, more under one, and more at the top. */
export function gardenThread() {
  const p = t3({ id: 'g1', by: ME, title: 'Tomatoes, finally', text: 'They went red **at last**.', comments: 9, score: 40, likes: true });
  const tree = listing([
    t1({
      id: 'c1',
      link: 'g1',
      by: ANN,
      body: 'Which kind are they?',
      score: 8,
      replies: [t1({ id: 'c2', link: 'g1', parent: 't1_c1', by: ME, body: 'San Marzano', replies: [t1({ id: 'c3', link: 'g1', parent: 't1_c2', by: ANN, body: 'Nice' })] }), more({ id: 'c9', parent: 't1_c1', children: ['c9', 'c10'] })],
    }),
    t1({ id: 'c4', link: 'g1', by: CARA, body: 'Lovely' }),
    t1({ id: 'c5', link: 'g1', by: BEN, body: 'Go on…', replies: [more({ id: '_', parent: 't1_c5', children: [], count: 0 })] }),
    more({ id: 'c6', parent: 't3_g1', children: ['c6', 'c7', 'c8'] }),
  ]);
  return [listing([p]), tree];
}

/** A comment's page with context: the post, then the path down to c2 and c2's answers. */
export function commentPage() {
  const p = t3({ id: 'g1', by: ME, title: 'Tomatoes, finally', text: 'They went red.', comments: 9 });
  const tree = listing([
    t1({ id: 'c1', link: 'g1', by: ANN, body: 'Which kind are they?', replies: [t1({ id: 'c2', link: 'g1', parent: 't1_c1', by: ME, body: 'San Marzano', replies: [t1({ id: 'c3', link: 'g1', parent: 't1_c2', by: ANN, body: 'Nice' })] })] }),
  ]);
  return [listing([p]), tree];
}

/** /api/morechildren's answer for c6, c7, c8 (flat, with c8 answering c7). */
export function moreChildren() {
  return {
    json: {
      errors: [],
      data: {
        things: [t1({ id: 'c6', link: 'g1', by: ANN, body: 'Six' }), t1({ id: 'c7', link: 'g1', by: BEN, body: 'Seven' }), t1({ id: 'c8', link: 'g1', parent: 't1_c7', by: CARA, body: 'Eight' })],
      },
    },
  };
}

export function inbox() {
  return listing([
    {
      kind: 't1',
      data: {
        ...comment({ id: 'r1', link: 'g1', parent: 't3_g1', by: ANN, body: 'Which kind are they?', agoS: 5 * MIN }),
        permalink: undefined,
        type: 'post_reply',
        subject: 'post reply',
        was_comment: true,
        context: '/r/gardening/comments/g1/a_title/r1/?context=3',
        link_title: 'Tomatoes, finally',
        new: true,
      },
    },
    {
      kind: 't1',
      data: {
        ...comment({ id: 'r2', link: 'g1', parent: 't1_c2', by: BEN, body: 'agreed', agoS: 20 * MIN }),
        permalink: undefined,
        type: 'comment_reply',
        subject: 'comment reply',
        was_comment: true,
        context: '/r/gardening/comments/g1/a_title/r2/?context=3',
        link_title: 'Tomatoes, finally',
        new: false,
      },
    },
    {
      kind: 't1',
      data: {
        ...comment({ id: 'r3', link: 'h1', by: CARA, body: `u/${ME} knows this one`, agoS: 2 * H, sub: SUB2 }),
        permalink: undefined,
        type: 'username_mention',
        subject: 'username mention',
        was_comment: true,
        context: '/r/rustlang/comments/h1/a_title/r3/?context=3',
        link_title: 'Borrowing question',
        new: true,
      },
    },
    { kind: 't4', data: { id: 'm1', name: 't4_m1', author: CARA, subject: 'seeds?', body: 'Do you have spare seeds?', created_utc: NOW_S() - 3 * H, was_comment: false, dest: ME, new: true } },
    { kind: 't4', data: { id: 'm2', name: 't4_m2', author: null, subreddit: 'gardening', subject: 'Welcome to r/gardening', body: 'Please read the rules.', created_utc: NOW_S() - 4 * H, was_comment: false, dest: ME, new: false } },
  ]);
}

export function user(name = ANN) {
  return {
    kind: 't2',
    data: {
      name,
      id: 'abc',
      created_utc: Date.UTC(2019, 2, 3, 12) / 1000,
      link_karma: 1200,
      comment_karma: 3400,
      total_karma: 4600,
      icon_img: 'https://styles.redditmedia.com/t5_x/styles/profileIcon_a.png?width=256&amp;s=1',
      is_friend: false,
      subreddit: { title: 'Ann Lee', public_description: 'Gardens, mostly.', display_name_prefixed: `u/${name}` },
    },
  };
}

export function overview(name = ANN) {
  return listing([t1({ id: 'o1', link: 'g1', by: name, body: 'Which kind are they?' }), t3({ id: 'o2', by: name, title: 'My beans', text: 'Tall ones.', agoS: 2 * H })]);
}
