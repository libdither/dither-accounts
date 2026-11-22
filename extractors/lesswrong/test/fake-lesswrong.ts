/**
 * A fake of the parts of a ForumMagnum site's GraphQL API (LessWrong's /graphql) the lesswrong extractor calls, with
 * invented data only. It answers by operation name (the extractor names every request) and reads the variables, not
 * the selection set: it sends whole objects, and the extractor reads the fields it asked for.
 *
 * - Login { username, password } → { login: { token } }, or ForumMagnum's errors ("Invalid login.", "Incorrect
 *   password."); a session is the `loginToken` header, and `endSessions()` makes every one stop working (currentUser
 *   null, "must be logged in" errors where the site gives them)
 * - Me, Notifications (userNotifications, newest first, limit/offset), Docs (exactPostIds, commentIds)
 * - Subscribed (PostsBySubscribedAuthors: posts by authors you subscribe to, newest first, a limit), UltraFeed (its
 *   entries a page by offset; `served` counts pages asked without incognito mode, which the real site would record)
 * - Post (the post, @include withPost, and its comments top first by offset), Comment, CommentThread
 * - PostVote/CommentVote, VotePost/VoteComment (smallUpvote, bigUpvote, neutral; the extended vote kept as sent),
 *   NewComment (markdown), DeleteComment (your own, without replies), UserBySlug, Profile
 */

export interface FakeUser {
  _id: string;
  displayName: string;
  slug: string;
  username?: string;
  email?: string;
  password?: string;
  karma?: number;
  createdAt?: string;
  htmlBio?: string;
  /** The user _ids whose new posts they subscribe to. */
  subscribedTo?: string[];
  ultraFeedSettings?: unknown;
}
export interface FakePost {
  _id: string;
  title: string;
  slug: string;
  userId: string;
  postedAt: string;
  html: string;
  baseScore?: number;
  url?: string;
  shortform?: boolean;
  question?: boolean;
}
export interface FakeComment {
  _id: string;
  postId: string;
  userId: string;
  postedAt: string;
  html: string;
  parentCommentId?: string;
  baseScore?: number;
  shortform?: boolean;
  deleted?: boolean;
  retracted?: boolean;
}
export interface FakeNotification {
  _id: string;
  userId: string;
  documentId?: string;
  documentType?: string;
  createdAt: string;
  type: string;
  message: string;
  link?: string;
}
export interface FakeVote {
  voteType: string;
  extendedVote: unknown;
}

export interface FakeLessWrong {
  url: string;
  calls: { operationName: string; query: string; variables: any; token: string | null }[];
  users: Map<string, FakeUser>;
  posts: Map<string, FakePost>;
  comments: Map<string, FakeComment>;
  notifications: FakeNotification[];
  /** `<user>:<document>` → their vote. */
  votes: Map<string, FakeVote>;
  /** What UltraFeed serves, in order: { type: 'feedPost', postId } or { type: 'feedCommentThread', commentIds }. */
  ultra: ({ type: 'feedPost'; postId: string } | { type: 'feedCommentThread'; commentIds: string[] })[];
  /** UltraFeed pages asked without incognito mode (the real site records each item it serves then). */
  served: number;
  /** A session the site gave elsewhere (a login token pasted from a browser). */
  addSession(token: string, userId: string): void;
  endSessions(): void;
  stop(): void;
}

let nextToken = 1;
let nextId = 1;
const newId = () => `zzzzzzzzzzzz${String(nextId++).padStart(5, '0')}`;

export function startFakeLessWrong(): FakeLessWrong {
  const users = new Map<string, FakeUser>();
  const posts = new Map<string, FakePost>();
  const comments = new Map<string, FakeComment>();
  const notifications: FakeNotification[] = [];
  const votes = new Map<string, FakeVote>();
  const sessions = new Map<string, string>();
  const calls: FakeLessWrong['calls'] = [];
  const fake = { served: 0, ultra: [] as FakeLessWrong['ultra'] };

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (req) => {
      const u = new URL(req.url);
      if (req.method !== 'POST' || u.pathname !== '/graphql') return new Response('not here', { status: 404 });
      const token = req.headers.get('logintoken');
      const body: any = await req.json().catch(() => null);
      calls.push({ operationName: String(body?.operationName ?? ''), query: String(body?.query ?? ''), variables: body?.variables ?? {}, token });
      try {
        return json({ data: route(String(body?.operationName ?? ''), body?.variables ?? {}, token ? (sessions.get(token) ?? null) : null) });
      } catch (e) {
        if (e instanceof Fail) return json({ errors: [{ message: e.message, extensions: { code: e.code } }], data: null }, e.code === 'GRAPHQL_VALIDATION_FAILED' ? 400 : 200);
        throw e;
      }
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

  class Fail extends Error {
    constructor(
      message: string,
      readonly code = 'INTERNAL_SERVER_ERROR',
    ) {
      super(message);
    }
  }
  const missing = () => new Fail('app.missing_document');

  const score = (id: string, own = 0) => own + [...votes].filter(([k]) => k.endsWith(`:${id}`)).reduce((s, [, v]) => s + (v.voteType === 'smallUpvote' ? 1 : v.voteType === 'bigUpvote' ? 2 : v.voteType === 'smallDownvote' ? -1 : 0), 0);
  const userJson = (id: string) => {
    const x = users.get(id);
    return x ? { _id: x._id, displayName: x.displayName, slug: x.slug, deleted: false } : null;
  };
  const viewerVote = (viewer: string | null, id: string) => (viewer ? (votes.get(`${viewer}:${id}`) ?? null) : null);
  const postJson = (id: string, viewer: string | null) => {
    const p = posts.get(id);
    if (!p) return null;
    const v = viewerVote(viewer, id);
    return {
      _id: p._id,
      title: p.title,
      slug: p.slug,
      pageUrl: `${base}/posts/${p._id}/${p.slug}`,
      postedAt: p.postedAt,
      baseScore: score(id, p.baseScore ?? 0),
      commentCount: [...comments.values()].filter((c) => c.postId === id && !c.deleted).length,
      question: !!p.question,
      url: p.url ?? null,
      isEvent: false,
      shortform: !!p.shortform,
      draft: null,
      currentUserVote: v?.voteType ?? null,
      currentUserExtendedVote: v?.extendedVote ?? null,
      userId: p.userId,
      user: userJson(p.userId),
      contents: { html: p.html, htmlHighlight: p.html.slice(0, 400) },
    };
  };
  const topOf = (c: FakeComment): string | null => {
    let at = c;
    while (at.parentCommentId) {
      const up = comments.get(at.parentCommentId);
      if (!up) break;
      at = up;
    }
    return at === c ? null : at._id;
  };
  const commentJson = (id: string, viewer: string | null) => {
    const c = comments.get(id);
    if (!c) return null;
    const p = posts.get(c.postId);
    const v = viewerVote(viewer, id);
    const kids = [...comments.values()].filter((x) => x.parentCommentId === id);
    return {
      _id: c._id,
      postId: c.postId,
      parentCommentId: c.parentCommentId ?? null,
      topLevelCommentId: topOf(c),
      postedAt: c.postedAt,
      baseScore: score(id, c.baseScore ?? 0),
      descendentCount: kids.length,
      directChildrenCount: kids.length,
      deleted: !!c.deleted,
      shortform: !!c.shortform,
      answer: false,
      retracted: !!c.retracted,
      pageUrl: `${base}/posts/${c.postId}/${p?.slug ?? 'x'}?commentId=${c._id}`,
      currentUserVote: v?.voteType ?? null,
      currentUserExtendedVote: v?.extendedVote ?? null,
      userId: c.userId,
      user: userJson(c.userId),
      contents: { html: c.deleted ? '' : c.html },
      post: p ? { _id: p._id, title: p.title, slug: p.slug, pageUrl: `${base}/posts/${p._id}/${p.slug}`, shortform: !!p.shortform, userId: p.userId } : null,
    };
  };
  const byNewest = <T extends { postedAt: string }>(a: T, b: T) => b.postedAt.localeCompare(a.postedAt);
  const byScore = (a: FakeComment, b: FakeComment) => score(b._id, b.baseScore ?? 0) - score(a._id, a.baseScore ?? 0);
  const need = (viewer: string | null, words: string) => {
    if (!viewer) throw new Fail(words);
    return viewer;
  };

  function route(op: string, v: any, viewer: string | null): unknown {
    switch (op) {
      case 'Login': {
        const who = [...users.values()].find((x) => x.username === v.username || x.email === v.username);
        if (!who) throw new Fail('Invalid login.');
        if (who.password !== v.password) throw new Fail('Incorrect password.');
        const token = `tok${String(nextToken++).padStart(4, '0')}${'f'.repeat(56)}`;
        sessions.set(token, who._id);
        return { login: { token } };
      }
      case 'Me':
        return { currentUser: viewer ? { ...userJson(viewer), ultraFeedSettings: users.get(viewer)?.ultraFeedSettings ?? null } : null };
      case 'Notifications': {
        const mine = viewer && v.userId === viewer ? notifications.filter((n) => n.userId === viewer).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : [];
        const page = mine.slice(v.offset ?? 0, (v.offset ?? 0) + (v.limit ?? 20));
        return { currentUser: viewer ? { _id: viewer } : null, notifications: { results: page.map((n) => ({ ...n, deleted: false, documentId: n.documentId ?? null, documentType: n.documentType ?? null, link: n.link ?? null })) } };
      }
      case 'Docs':
        return {
          posts: { results: (v.postIds ?? []).map((id: string) => postJson(id, viewer)).filter(Boolean).slice(0, v.postLimit ?? 20) },
          comments: { results: (v.commentIds ?? []).map((id: string) => commentJson(id, viewer)).filter(Boolean).slice(0, v.commentLimit ?? 20) },
        };
      case 'Subscribed': {
        const me = need(viewer, 'You must be logged in to see posts with activity from your subscrptions.');
        const to = new Set(users.get(me)?.subscribedTo ?? []);
        const list = [...posts.values()].filter((p) => to.has(p.userId) && !p.shortform).sort(byNewest);
        return { PostsBySubscribedAuthors: { results: list.slice(0, v.limit ?? 10).map((p) => postJson(p._id, me)) } };
      }
      case 'UltraFeed': {
        const me = need(viewer, 'Must be logged in or have a client ID to use the feed.');
        let incognito = false;
        try {
          incognito = typeof v.settings === 'string' && JSON.parse(v.settings).incognitoMode === true;
        } catch {}
        if (!incognito) fake.served++;
        const offset = v.offset ?? 0;
        const page = fake.ultra.slice(offset, offset + (v.limit ?? 20));
        return {
          UltraFeed: {
            endOffset: offset + page.length,
            results: page.map((e) =>
              e.type === 'feedPost'
                ? { type: 'feedPost', feedPost: { _id: `fp-${e.postId}`, post: postJson(e.postId, me) }, feedCommentThread: null, feedSpotlight: null }
                : { type: 'feedCommentThread', feedPost: null, feedCommentThread: { _id: `ft-${e.commentIds[0]}`, post: postJson(comments.get(e.commentIds[0]!)!.postId, me), comments: e.commentIds.map((id) => commentJson(id, me)) }, feedSpotlight: null },
            ),
          },
        };
      }
      case 'Post': {
        const out: Record<string, unknown> = {};
        if (v.withPost) {
          const p = postJson(v.postId, viewer);
          if (!p) throw missing();
          out.post = { result: p };
        }
        const list = [...comments.values()].filter((c) => c.postId === v.postId).sort(byScore);
        out.comments = { results: list.slice(v.offset ?? 0, (v.offset ?? 0) + (v.limit ?? 20)).map((c) => commentJson(c._id, viewer)) };
        return out;
      }
      case 'Comment': {
        const c = commentJson(v.commentId, viewer);
        if (!c) throw missing();
        return { comment: { result: c } };
      }
      case 'CommentThread': {
        const list = [...comments.values()].filter((c) => c._id === v.topLevelCommentId || topOf(c) === v.topLevelCommentId).sort((a, b) => a.postedAt.localeCompare(b.postedAt));
        return { comments: { results: list.slice(0, v.limit ?? 20).map((c) => commentJson(c._id, viewer)) } };
      }
      case 'PostVote':
      case 'CommentVote': {
        const doc = op === 'PostVote' ? postJson(v.id, viewer) : commentJson(v.id, viewer);
        if (!doc) throw missing();
        const pick = { _id: doc._id, currentUserVote: doc.currentUserVote, currentUserExtendedVote: doc.currentUserExtendedVote };
        return op === 'PostVote' ? { post: { result: pick } } : { comment: { result: pick } };
      }
      case 'VotePost':
      case 'VoteComment': {
        const me = need(viewer, 'Error casting vote: Not logged in.');
        const exists = op === 'VotePost' ? posts.has(v.documentId) : comments.has(v.documentId);
        if (!exists) throw new Fail('No such document ID');
        if (!['smallUpvote', 'bigUpvote', 'smallDownvote', 'bigDownvote', 'neutral'].includes(v.voteType)) throw new Fail(`Invalid vote type in performVoteServer: ${v.voteType}`);
        votes.set(`${me}:${v.documentId}`, { voteType: v.voteType, extendedVote: v.extendedVote ?? null });
        const doc = op === 'VotePost' ? postJson(v.documentId, me)! : commentJson(v.documentId, me)!;
        const result = { document: { _id: doc._id, baseScore: doc.baseScore, currentUserVote: doc.currentUserVote } };
        return op === 'VotePost' ? { performVotePost: result } : { performVoteComment: result };
      }
      case 'NewComment': {
        const me = need(viewer, 'You must be logged in to comment.');
        const d = v.data ?? {};
        if (!posts.has(d.postId)) throw new Fail('Post not found');
        if (d.parentCommentId && comments.get(d.parentCommentId)?.postId !== d.postId) throw new Fail('Parent comment is not on this post');
        if (d.contents?.originalContents?.type !== 'markdown' || typeof d.contents.originalContents.data !== 'string') throw new Fail('Bad contents');
        const id = newId();
        const words = String(d.contents.originalContents.data).replace(/[&<>]/g, (ch: string) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]!);
        comments.set(id, { _id: id, postId: d.postId, userId: me, postedAt: new Date().toISOString(), html: `<p>${words}</p>`, ...(d.parentCommentId ? { parentCommentId: d.parentCommentId } : {}) });
        return { createComment: { data: commentJson(id, me) } };
      }
      case 'DeleteComment': {
        const me = need(viewer, 'You must be logged in to delete comments.');
        const c = comments.get(v.commentId);
        if (!c) throw missing();
        if (c.userId !== me) throw new Fail('Only moderators can delete this comment.');
        if ([...comments.values()].some((x) => x.parentCommentId === c._id)) throw new Fail("You can't delete your comment because it has replies. You can retract it instead.");
        c.deleted = true;
        return { moderateComment: { _id: c._id, deleted: true } };
      }
      case 'UserBySlug': {
        const who = [...users.values()].find((x) => x.slug === v.slug);
        return { GetUserBySlug: who ? { _id: who._id } : null };
      }
      case 'Profile': {
        const who = users.get(v.userId);
        if (!who) throw missing();
        return {
          user: { result: { ...userJson(who._id), createdAt: who.createdAt ?? '2020-01-02T03:04:05.000Z', karma: who.karma ?? 0, postCount: [...posts.values()].filter((p) => p.userId === who._id).length, commentCount: [...comments.values()].filter((c) => c.userId === who._id).length, htmlBio: who.htmlBio ?? '' } },
          posts: { results: [...posts.values()].filter((p) => p.userId === who._id && !p.shortform).sort(byNewest).slice(0, v.limit ?? 10).map((p) => postJson(p._id, viewer)) },
          comments: { results: [...comments.values()].filter((c) => c.userId === who._id).sort(byNewest).slice(0, v.limit ?? 10).map((c) => commentJson(c._id, viewer)) },
        };
      }
      default:
        throw new Fail(`Unknown operation ${op}`, 'GRAPHQL_VALIDATION_FAILED');
    }
  }

  return {
    url: base,
    calls,
    users,
    posts,
    comments,
    notifications,
    votes,
    get ultra() {
      return fake.ultra;
    },
    set ultra(v) {
      fake.ultra = v;
    },
    get served() {
      return fake.served;
    },
    set served(v) {
      fake.served = v;
    },
    addSession: (token: string, userId: string) => void sessions.set(token, userId),
    endSessions: () => sessions.clear(),
    stop: () => server.stop(true),
  };
}
