/**
 * A fake of the parts of old.reddit.com the reddit extractor reaches (docs/reddit.md), on 127.0.0.1, with invented
 * data (extractors/reddit/test/fixtures.ts). Signed out, every page sends the browser to /login/, whose page waits for
 * `signIn()` (someone signing in in the live view) and then goes back. Signed in, a page carries old reddit's
 * `r.config` (`logged`, `modhash`), and the JSON endpoints answer: the front page (New, Best), the inbox, threads,
 * /api/info, profiles; and the writes (/api/vote, /api/comment, /api/del, /api/submit, /api/morechildren), which check
 * the modhash. Every request is recorded, so a test can tell what the page asked for, and that nothing marked the inbox
 * read.
 */
import { commentPage, gardenThread, inbox, listing, ME, moreChildren, overview, post, t1, t3, user } from '../extractors/reddit/test/fixtures.ts';

export const MODHASH = 'mh0123456789abcdef';
export { ME };

export interface FakeRedditCall {
  method: string;
  path: string;
  query: Record<string, string>;
  form?: Record<string, string>;
}
export interface FakeReddit {
  url: string;
  calls: FakeRedditCall[];
  signedIn: boolean;
  signIn(): void;
  stop(): void;
}

const page = (body: string, script = '') => new Response(`<!doctype html><html><head><meta charset="utf-8"><title>reddit</title>${script}</head><body>${body}</body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
const json = (v: unknown, status = 200) => Response.json(v, { status });

export function startFakeReddit(): FakeReddit {
  const calls: FakeRedditCall[] = [];
  const state = { signedIn: false };
  let made = 0;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const query = Object.fromEntries(url.searchParams);
      let form: Record<string, string> | undefined;
      if (req.method === 'POST') form = Object.fromEntries(new URLSearchParams(await req.text()));
      if (path.endsWith('.json') || path.startsWith('/api/')) calls.push({ method: req.method, path, query, ...(form ? { form } : {}) });

      if (path === '/login/status') return json({ signedIn: state.signedIn });
      if (path === '/login/' || path === '/login') {
        // Reddit's sign-in page: it goes back to old reddit once someone has signed in (the live view, in a real one).
        return page('<form><input name="username"><input name="password" type="password"><button>Log In</button></form>', `<script>setInterval(async()=>{const r=await fetch('/login/status');if((await r.json()).signedIn)location.href='/';},300)</script>`);
      }
      if (!state.signedIn) {
        if (path.endsWith('.json') || path.startsWith('/api/')) return json({ message: 'Forbidden', error: 403 }, 403);
        return Response.redirect(`${url.origin}/login/?dest=${encodeURIComponent(url.href)}`, 302);
      }
      if (req.method === 'GET' && !path.endsWith('.json') && !path.startsWith('/api/')) {
        return page('<div id="siteTable">front page</div>', `<script>var r = { config: { logged: ${JSON.stringify(ME)}, modhash: ${JSON.stringify(MODHASH)}, renderstyle: 'html' } };</script>`);
      }
      // ------------------------------------------------------------ reads
      if (req.method === 'GET') {
        if (path === '/new.json') return json(listing([t3({ id: query.after ? 'n3' : 'n1', title: 'Newest' }), t3({ id: 'n2', link: 'https://example.com/b' })], query.after ? null : 't3_n2'));
        if (path === '/best.json') return json(listing([t3({ id: 'b1', title: 'Best one', score: 900, image: `${url.origin}/pic.jpg` })], null));
        if (path === '/message/inbox.json') return json(inbox());
        if (path === '/comments/g1.json') return json(gardenThread());
        if (path === '/comments/g1/_/c2.json') return json(commentPage());
        if (path === '/api/info.json') {
          const id = query.id ?? '';
          if (id === 't1_c2') return json(listing([t1({ id: 'c2', link: 'g1', parent: 't1_c1' })]));
          if (id.startsWith('t3_new')) return json(listing([{ kind: 't3', data: { ...post({ id: id.slice(3), by: ME, title: 'My beans', text: 'Tall ones.', agoS: 5 }) } }]));
          return json(listing([]));
        }
        const u = /^\/user\/([\w-]+)\/(about|overview)\.json$/.exec(path);
        if (u) return u[2] === 'about' ? json(user(u[1])) : json(overview(u[1]));
        return json({ message: 'Not Found', error: 404 }, 404);
      }
      // ------------------------------------------------------------ writes
      if (form?.uh !== MODHASH) return json({ json: { errors: [['USER_REQUIRED', 'Please log in to do that.', null]] } }, 403);
      if (path === '/api/vote') return json({});
      if (path === '/api/del') return json({});
      if (path === '/api/morechildren') return json(moreChildren());
      if (path === '/api/comment') {
        const parent = form.thing_id ?? '';
        return json({ json: { errors: [], data: { things: [t1({ id: `new${++made}`, link: 'g1', parent, by: ME, body: form.text ?? '', agoS: 1 })] } } });
      }
      if (path === '/api/submit') {
        if (!form.title) return json({ json: { errors: [['NO_TEXT', 'we need something here', 'title']] } });
        const id = `new${++made}`;
        return json({ json: { errors: [], data: { url: `https://www.reddit.com/r/${form.sr}/comments/${id}/my_beans/`, id, name: `t3_${id}` } } });
      }
      return json({ message: 'Not Found', error: 404 }, 404);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    get signedIn() {
      return state.signedIn;
    },
    set signedIn(v: boolean) {
      state.signedIn = v;
    },
    signIn() {
      state.signedIn = true;
    },
    stop() {
      server.stop(true);
    },
  };
}
