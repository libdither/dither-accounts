/**
 * A fake of the parts of substack.com the substack extractor reaches (docs/substack.md), on 127.0.0.1: a reader page
 * at any path with its preloads (`window._preloads`, `user` when signed in), and the reader's /api/v1 calls answered
 * from extractors/substack/test/fixtures.ts (invented people and publications). Signed out, the page has no user; it
 * looks every half second for a sign-in (`signIn()`, someone signing in in the live view) and reloads, as Substack's
 * sign-in does.
 *
 * Every API call is recorded (method, path, query, JSON body) and needs the session cookie the signed-in page set, so
 * a test can tell the hook made the reader's own calls with the page's session, and that nothing marked anything seen.
 */
import { activity, ANN, ANN_PUB, branch, comment, ME, MY_PUB, noteItem, postItem, publicProfile, world, type Comment, type World } from '../extractors/substack/test/fixtures.ts';

export interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body: any;
}
export interface FakeSubstack {
  url: string;
  calls: Call[];
  world: World;
  signIn(): void;
  stop(): void;
}

export const PIXEL = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
const COOKIE = 'substack.sid=fake-session';

export function startFakeSubstack(o: { signedIn?: boolean } = {}): FakeSubstack {
  let signedIn = o.signedIn ?? true;
  const now = Date.now();
  const w = world(now);
  const calls: Call[] = [];
  const made: Comment[] = [];
  let nextId = 7100;
  const comments = new Map<number, Comment>([w.myNote, w.annReply, w.benComment, w.myReplyToBen, w.annNote, w.calQuote, w.benOnAnn, w.annOnBen].map((c) => [c.id, c]));
  const posts = new Map([w.myPost, w.annPost, w.benPost].map((p) => [p.id, p]));
  const pubOf = (id: number) => (id === MY_PUB.id ? MY_PUB : ANN_PUB);

  const page = () => {
    const preloads = { isEU: false, language: 'en', base_url: 'https://substack.com', ...(signedIn ? { user: { id: ME.id, name: ME.name, handle: ME.handle, photo_url: ME.photo_url, email: 'quinn@example.com' } } : {}) };
    return `<!doctype html><html><head><title>Substack</title></head><body>
<script type="application/json" id="preloads-json">${JSON.stringify(preloads)}</script>
<script>window._preloads = JSON.parse(document.querySelector('script#preloads-json[type="application/json"]').textContent);</script>
<main>${signedIn ? 'Settings' : 'Sign in to Substack'}</main>
<script>
  // As Substack's sign-in does once you are in: the page comes back signed in.
  const was = ${JSON.stringify(signedIn)};
  setInterval(async () => {
    const s = await (await fetch('/__fake/state')).json();
    if (s.signedIn !== was) location.reload();
  }, 500);
</script></body></html>`;
  };
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  const made_ = (o: { body: any; post?: number; pub?: number; parent?: number }) => {
    const text = (o.body?.bodyJson?.content ?? []).map((p: any) => (p.content ?? []).map((t: any) => t.text).join('')).join('\n');
    const parent = o.parent ? comments.get(o.parent) : undefined;
    const ancestors = parent ? [...parent.ancestor_path.split('.').filter(Boolean).map(Number), parent.id] : [];
    const c = comment({ id: nextId++, by: ME, body: text, at: Date.now(), post: o.post, pub: o.pub, ancestors });
    comments.set(c.id, c);
    made.push(c);
    return c;
  };

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      if (p === '/__fake/state') return json({ signedIn });
      if (p === '/__fake/media/pixel.png') return new Response(PIXEL, { headers: { 'content-type': 'image/png' } });
      if (!p.startsWith('/api/')) {
        const res = new Response(page(), { headers: { 'content-type': 'text/html; charset=utf-8' } });
        if (signedIn) res.headers.append('set-cookie', `${COOKIE}; Path=/; HttpOnly; SameSite=Lax`);
        return res;
      }
      const body = req.method === 'GET' || req.method === 'HEAD' ? null : await req.json().catch(() => null);
      calls.push({ method: req.method, path: p, query: Object.fromEntries(url.searchParams), body });
      if (!signedIn || !(req.headers.get('cookie') ?? '').includes(COOKIE)) return json({ error: 'Not authorized' }, 401);
      let m: RegExpExecArray | null;
      const route = `${req.method} ${p}`;
      if (route === 'GET /api/v1/activity-feed-web') return json(activity(w, now, { more: false }));
      if (route === 'GET /api/v1/reader/posts') return json(url.searchParams.get('cursor') ? { posts: [w.benPost], publications: [MY_PUB], inboxItems: [], cursor: null, more: false } : { posts: [w.annPost, w.myPost], publications: [MY_PUB, ANN_PUB], inboxItems: [], cursor: 'inbox-2', more: true });
      if (route === 'GET /api/v1/reader/feed') return json({ items: [noteItem(w.annNote), noteItem(w.myNote, { context: 'comment_restack', by: ANN }), postItem(w.annPost, ANN_PUB, { context: 'post' }), { type: 'user_suggestions' }], nextCursor: 'notes-2' });
      if ((m = /^GET \/api\/v1\/reader\/comment\/(\d+)$/.exec(route))) {
        const c = comments.get(Number(m[1]));
        if (!c) return json({ error: 'Not found' }, 404);
        const parents = c.ancestor_path.split('.').filter(Boolean).map((x) => comments.get(Number(x))!);
        return json({ item: { ...noteItem(c, { parents }), ...(c.post_id ? { post: posts.get(c.post_id), publication: pubOf(c.publication_id!) } : {}) } });
      }
      if ((m = /^GET \/api\/v1\/reader\/comment\/(\d+)\/replies$/.exec(route))) {
        if (Number(m[1]) !== w.annNote.id) return json({ commentBranches: [], nextCursor: null });
        return json(url.searchParams.get('cursor') ? { commentBranches: [branch(made.find((c) => c.ancestor_path === String(w.annNote.id)) ?? w.benOnAnn)], nextCursor: null } : { commentBranches: [branch(w.benOnAnn, w.annOnBen)], nextCursor: 'replies-2', moreBranches: 1 });
      }
      if ((m = /^GET \/api\/v1\/posts\/by-id\/(\d+)$/.exec(route))) {
        const post = posts.get(Number(m[1]));
        return post ? json({ post, publication: pubOf(post.publication_id), publicationSettings: { dropped: true } }) : json({ error: 'Post not found' }, 404);
      }
      if ((m = /^GET \/api\/v1\/reader\/post\/(\d+)\/replies$/.exec(route))) return json(Number(m[1]) === w.myPost.id ? { commentBranches: [branch(w.benComment, w.myReplyToBen)], nextCursor: null } : { commentBranches: [], nextCursor: null });
      if ((m = /^GET \/api\/v1\/user\/([\w.-]+)\/public_profile$/.exec(route))) return m[1] === ANN.handle ? json(publicProfile(ANN, { pub: ANN_PUB, following: true })) : json({ error: 'Not found' }, 404);
      if ((m = /^GET \/api\/v1\/reader\/feed\/profile\/(\d+)$/.exec(route))) return json({ items: Number(m[1]) === ANN.id ? [noteItem(w.annNote), postItem(w.annPost, ANN_PUB)] : [], nextCursor: null });
      if ((m = /^(POST|DELETE) \/api\/v1\/(post|comment)\/(\d+)\/reaction$/.exec(route))) {
        const t = m[2] === 'post' ? posts.get(Number(m[3])) : comments.get(Number(m[3]));
        if (!t) return json({ error: 'Not found' }, 404);
        t.reaction = m[1] === 'POST' ? '❤' : null;
        return json({});
      }
      if (p === '/api/v1/restack/feed' && (req.method === 'POST' || req.method === 'DELETE')) return json(req.method === 'POST' ? (body?.commentId ? { comment: comments.get(body.commentId) } : { post: posts.get(body?.postId) }) : {});
      if (route === 'POST /api/v1/comment/feed') return json(made_({ body, parent: body?.parent_id }));
      if ((m = /^POST \/api\/v1\/post\/(\d+)\/comment$/.exec(route))) return json(made_({ body, post: Number(m[1]), pub: body?.publication_id, parent: body?.parent_id }));
      if ((m = /^DELETE \/api\/v1\/comment\/(\d+)$/.exec(route))) return comments.delete(Number(m[1])) ? json({}) : json({ error: 'Comment not found' }, 404);
      return json({ error: `no fake for ${route}` }, 404);
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    world: w,
    signIn() {
      signedIn = true;
    },
    stop() {
      server.stop(true);
    },
  };
}
