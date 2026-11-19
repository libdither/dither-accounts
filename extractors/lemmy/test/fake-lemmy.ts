/**
 * A fake of the parts of Lemmy's HTTP API v3 (Lemmy 0.19) the lemmy extractor calls, with invented data only:
 *
 * - POST /api/v3/user/login: { username_or_email, password, totp_2fa_token } → { jwt }, or 400 with Lemmy's error
 *   codes (incorrect_login, missing_totp_token, incorrect_totp_token); sessions as `Authorization: Bearer <jwt>`, and
 *   `endSessions()` makes every one stop working (401 not_logged_in)
 * - GET /api/v3/site (my_user for a good session), /api/v3/user/replies, /api/v3/user/mention (sort New, page, limit)
 * - GET /api/v3/post/list (type_ Subscribed|All, sort, limit, page_cursor → next_page), /api/v3/post, /api/v3/comment,
 *   /api/v3/comment/list (post_id or parent_id, max_depth: the limit counts top-level comments, page)
 * - POST /api/v3/post/like, /api/v3/comment/like (score 1 or 0), /api/v3/comment, /api/v3/post, /api/v3/post/delete,
 *   /api/v3/comment/delete; GET /api/v3/community?name, /api/v3/user?username
 */

export interface FakePerson {
  id: number;
  name: string;
  display_name?: string;
  /** Another instance's person: their home. */
  home?: string;
  password?: string;
  totpSecret?: string;
}
export interface FakeCommunity {
  id: number;
  name: string;
  home?: string;
  subscribed?: boolean;
}
export interface FakePost {
  id: number;
  name: string;
  body?: string;
  url?: string;
  creator: number;
  community: number;
  published: string;
  deleted?: boolean;
}
export interface FakeComment {
  id: number;
  post: number;
  creator: number;
  content: string;
  path: string;
  published: string;
  deleted?: boolean;
}

export interface FakeLemmy {
  url: string;
  host: string;
  calls: { method: string; path: string; query: string; auth: string | null; body: any }[];
  persons: Map<number, FakePerson>;
  communities: Map<number, FakeCommunity>;
  posts: Map<number, FakePost>;
  comments: Map<number, FakeComment>;
  /** person id:post or comment key → score. */
  votes: Map<string, number>;
  replies: { id: number; comment: number; recipient: number }[];
  mentions: { id: number; comment: number; recipient: number }[];
  /** Codes the TOTP check takes for a person (else none). */
  validCodes: Set<string>;
  endSessions(): void;
  stop(): void;
}

let nextJwt = 1;

export function startFakeLemmy(): FakeLemmy {
  const persons = new Map<number, FakePerson>();
  const communities = new Map<number, FakeCommunity>();
  const posts = new Map<number, FakePost>();
  const comments = new Map<number, FakeComment>();
  const votes = new Map<string, number>();
  const sessions = new Map<string, number>();
  const replies: FakeLemmy['replies'] = [];
  const mentions: FakeLemmy['mentions'] = [];
  const validCodes = new Set<string>();
  const calls: FakeLemmy['calls'] = [];
  let nextId = 500;

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      const u = new URL(req.url);
      const auth = req.headers.get('authorization');
      const body = req.method === 'POST' ? await req.json().catch(() => null) : null;
      calls.push({ method: req.method, path: u.pathname, query: u.search, auth, body });
      return route(req.method, u, auth, body);
    },
  });
  const host = `127.0.0.1:${server.port}`;
  const base = `http://${host}`;
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  const err = (status: number, error: string) => json({ error }, status);

  const personJson = (id: number) => {
    const p = persons.get(id)!;
    const home = p.home ? `https://${p.home}` : base;
    return { id, name: p.name, ...(p.display_name ? { display_name: p.display_name } : {}), avatar: `https://files.example/u/${id}.png`, banned: false, published: '2024-02-03T04:05:06.000000Z', actor_id: `${home}/u/${p.name}`, local: !p.home, bot_account: false, deleted: false };
  };
  const communityJson = (id: number) => {
    const c = communities.get(id)!;
    const home = c.home ? `https://${c.home}` : base;
    return { id, name: c.name, title: c.name, actor_id: `${home}/c/${c.name}`, local: !c.home };
  };
  const postRaw = (id: number) => {
    const p = posts.get(id)!;
    return { id, name: p.name, ...(p.body ? { body: p.body } : {}), ...(p.url ? { url: p.url } : {}), creator_id: p.creator, community_id: p.community, published: p.published, deleted: !!p.deleted, removed: false, nsfw: false, ap_id: `${base}/post/${id}`, local: true, featured_community: false, featured_local: false };
  };
  const postView = (id: number, viewer: number | null) => {
    const p = posts.get(id)!;
    const ups = [...votes].filter(([k, v]) => k.endsWith(`:p${id}`) && v === 1).length;
    const v = viewer !== null ? votes.get(`${viewer}:p${id}`) : undefined;
    return {
      post: postRaw(id),
      creator: personJson(p.creator),
      community: communityJson(p.community),
      counts: { post_id: id, comments: [...comments.values()].filter((c) => c.post === id).length, score: ups, upvotes: ups, downvotes: 0 },
      ...(viewer !== null ? { my_vote: v ?? 0 } : {}),
    };
  };
  const commentView = (id: number, viewer: number | null) => {
    const c = comments.get(id)!;
    const ups = [...votes].filter(([k, v]) => k.endsWith(`:c${id}`) && v === 1).length;
    const v = viewer !== null ? votes.get(`${viewer}:c${id}`) : undefined;
    return {
      comment: { id, creator_id: c.creator, post_id: c.post, content: c.content, removed: false, published: c.published, deleted: !!c.deleted, ap_id: `${base}/comment/${id}`, local: true, path: c.path },
      creator: personJson(c.creator),
      post: postRaw(c.post),
      community: communityJson(posts.get(c.post)!.community),
      counts: { comment_id: id, score: ups, upvotes: ups, downvotes: 0, child_count: [...comments.values()].filter((x) => x.path.startsWith(`${c.path}.`)).length },
      ...(viewer !== null ? { my_vote: v ?? 0 } : {}),
    };
  };
  const pageOf = <T>(list: T[], u: URL, max = 50) => {
    const limit = Math.min(max, Number(u.searchParams.get('limit')) || 10);
    const page = Math.max(1, Number(u.searchParams.get('page')) || 1);
    return list.slice((page - 1) * limit, page * limit);
  };

  function route(method: string, u: URL, auth: string | null, body: any): Response {
    const p = u.pathname;
    const q = (k: string) => u.searchParams.get(k);
    if (method === 'POST' && p === '/api/v3/user/login') {
      const who = [...persons.values()].find((x) => x.name === body?.username_or_email && !x.home);
      if (!who || who.password !== body?.password) return err(400, 'incorrect_login');
      if (who.totpSecret) {
        if (!body.totp_2fa_token) return err(400, 'missing_totp_token');
        if (!validCodes.has(body.totp_2fa_token)) return err(400, 'incorrect_totp_token');
      }
      const jwt = `jwt-${nextJwt++}`;
      sessions.set(jwt, who.id);
      return json({ jwt, registration_created: false, verify_email_sent: false });
    }
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    if (token && !sessions.has(token)) return err(401, 'not_logged_in');
    const viewer = token ? sessions.get(token)! : null;
    if (p === '/api/v3/site') return json({ site_view: { site: { name: 'Fake Lemmy' } }, ...(viewer !== null ? { my_user: { local_user_view: { person: personJson(viewer) } } } : {}) });
    if (p === '/api/v3/post/list') {
      const subscribed = q('type_') === 'Subscribed';
      if (subscribed && viewer === null) return err(400, 'not_logged_in');
      let list = [...posts.values()].filter((x) => !x.deleted && (!subscribed || communities.get(x.community)!.subscribed));
      list = q('sort') === 'New' ? list.sort((a, b) => b.id - a.id) : list.sort((a, b) => a.id - b.id);
      const limit = Number(q('limit')) || 10;
      const start = q('page_cursor') ? Number(q('page_cursor')!.slice(2)) : 0;
      const items = list.slice(start, start + limit);
      return json({ posts: items.map((x) => postView(x.id, viewer)), ...(start + limit < list.length ? { next_page: `Pa${start + limit}` } : {}) });
    }
    if (method === 'GET' && p === '/api/v3/post') {
      const id = Number(q('id'));
      return posts.has(id) ? json({ post_view: postView(id, viewer), community_view: {}, moderators: [], cross_posts: [] }) : err(404, 'couldnt_find_post');
    }
    if (method === 'GET' && p === '/api/v3/comment') {
      const id = Number(q('id'));
      return comments.has(id) ? json({ comment_view: commentView(id, viewer), recipient_ids: [] }) : err(404, 'couldnt_find_comment');
    }
    if (p === '/api/v3/comment/list') {
      const maxDepth = Number(q('max_depth')) || 99;
      let list: FakeComment[];
      let topDepth: number;
      if (q('parent_id')) {
        const parent = comments.get(Number(q('parent_id')));
        if (!parent) return json({ comments: [] });
        topDepth = parent.path.split('.').length;
        list = [...comments.values()].filter((c) => c.path === parent.path || c.path.startsWith(`${parent.path}.`));
      } else {
        topDepth = 2;
        list = [...comments.values()].filter((c) => c.post === Number(q('post_id')));
      }
      list = list.filter((c) => c.path.split('.').length - topDepth <= maxDepth).sort((a, b) => a.id - b.id);
      // The limit and page count top-level comments; all their children come with them.
      const tops = pageOf(
        list.filter((c) => c.path.split('.').length === topDepth),
        u,
      );
      const keep = list.filter((c) => tops.some((t) => c.path === t.path || c.path.startsWith(`${t.path}.`)) || (q('parent_id') && c.path.split('.').length < topDepth));
      return json({ comments: keep.map((c) => commentView(c.id, viewer)) });
    }
    if (p === '/api/v3/community') {
      const name = q('name') ?? '';
      const [n, h] = name.split('@');
      const c = [...communities.values()].find((x) => x.name === n && (x.home ?? undefined) === h);
      return c ? json({ community_view: { community: communityJson(c.id) } }) : err(404, 'couldnt_find_community');
    }
    if (p === '/api/v3/user' && method === 'GET') {
      const name = q('username') ?? '';
      const [n, h] = name.split('@');
      const person = [...persons.values()].find((x) => x.name === n && (x.home ?? undefined) === h);
      if (!person) return err(404, 'couldnt_find_person');
      return json({
        person_view: { person: personJson(person.id), counts: { person_id: person.id, post_count: [...posts.values()].filter((x) => x.creator === person.id).length, comment_count: [...comments.values()].filter((x) => x.creator === person.id).length } },
        posts: [...posts.values()].filter((x) => x.creator === person.id).map((x) => postView(x.id, viewer)),
        comments: [...comments.values()].filter((x) => x.creator === person.id).map((x) => commentView(x.id, viewer)),
        moderates: person.name === 'ann' ? [{ community: communityJson(1) }] : [],
      });
    }
    if (viewer === null) return err(401, 'not_logged_in');
    if (p === '/api/v3/user/replies' || p === '/api/v3/user/mention') {
      const list = (p === '/api/v3/user/replies' ? replies : mentions).filter((r) => r.recipient === viewer).sort((a, b) => b.id - a.id);
      const views = pageOf(list, u).map((r) => ({
        [p === '/api/v3/user/replies' ? 'comment_reply' : 'person_mention']: { id: r.id, recipient_id: r.recipient, comment_id: r.comment, read: false, published: comments.get(r.comment)!.published },
        ...commentView(r.comment, viewer),
        recipient: personJson(viewer),
      }));
      return json(p === '/api/v3/user/replies' ? { replies: views } : { mentions: views });
    }
    if (method === 'POST' && (p === '/api/v3/post/like' || p === '/api/v3/comment/like')) {
      const key = p.includes('post') ? `p${body.post_id}` : `c${body.comment_id}`;
      if (p.includes('post') ? !posts.has(body.post_id) : !comments.has(body.comment_id)) return err(404, 'couldnt_find_post');
      if (body.score === 0) votes.delete(`${viewer}:${key}`);
      else votes.set(`${viewer}:${key}`, body.score);
      return p.includes('post') ? json({ post_view: postView(body.post_id, viewer) }) : json({ comment_view: commentView(body.comment_id, viewer), recipient_ids: [] });
    }
    if (method === 'POST' && p === '/api/v3/comment') {
      if (!posts.has(body.post_id)) return err(404, 'couldnt_find_post');
      const id = nextId++;
      const parent = body.parent_id ? comments.get(body.parent_id) : null;
      comments.set(id, { id, post: body.post_id, creator: viewer, content: body.content, path: `${parent ? parent.path : '0'}.${id}`, published: new Date().toISOString() });
      return json({ comment_view: commentView(id, viewer), recipient_ids: [] });
    }
    if (method === 'POST' && p === '/api/v3/post') {
      if (!communities.has(body.community_id)) return err(404, 'couldnt_find_community');
      const id = nextId++;
      posts.set(id, { id, name: body.name, ...(body.body ? { body: body.body } : {}), creator: viewer, community: body.community_id, published: new Date().toISOString() });
      return json({ post_view: postView(id, viewer) });
    }
    if (method === 'POST' && p === '/api/v3/post/delete') {
      const x = posts.get(body.post_id);
      if (!x) return err(404, 'couldnt_find_post');
      if (x.creator !== viewer) return err(400, 'no_post_edit_allowed');
      x.deleted = body.deleted;
      return json({ post_view: postView(x.id, viewer) });
    }
    if (method === 'POST' && p === '/api/v3/comment/delete') {
      const x = comments.get(body.comment_id);
      if (!x) return err(404, 'couldnt_find_comment');
      x.deleted = body.deleted;
      return json({ comment_view: commentView(x.id, viewer), recipient_ids: [] });
    }
    return err(404, 'unknown');
  }

  return {
    url: base,
    host,
    calls,
    persons,
    communities,
    posts,
    comments,
    votes,
    replies,
    mentions,
    validCodes,
    endSessions: () => sessions.clear(),
    stop: () => server.stop(true),
  };
}
